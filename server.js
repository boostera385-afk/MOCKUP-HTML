'use strict';
// Local testing only. Do not expose this server to the public internet.
require('dotenv').config({ path: '.env.local', quiet: true });
const express = require('express');
const multer = require('multer');
const sharp = require('sharp');
const { randomUUID, randomBytes } = require('node:crypto');
const { generateImage } = require('ai');
const path = require('node:path');

const app = express();
const sessions = new Map();
const upload = multer({ storage: multer.memoryStorage(), limits: { fileSize: 10 * 1024 * 1024, files: 1, fields: 2 } });
const port = 8000;
const model = process.env.IMAGE_MODEL || 'bytedance/seedream-5.0-pro';
// Local testing limit per browser per UTC day. Change for testing as needed.
// Production must enforce this persistently and use a stronger user identity.
const DAILY_LIMIT = 10;
// Every attempt reaches the paid provider, including failed and stopped ones, so cap those too.
const DAILY_ATTEMPTS = DAILY_LIMIT * 2;
const MAX_PIXELS = 40_000_000;
// Larger inputs mostly add upload and inference time; the model's output is around 2K anyway.
const MAX_EDGE = 2048;
const SESSION_TTL = 2 * 60 * 60 * 1000;
const ACTIVE = ['queued', 'generating'];
const token = () => randomBytes(24).toString('hex');
const keyReady = () => !!process.env.AI_GATEWAY_API_KEY && process.env.AI_GATEWAY_API_KEY !== 'replace_with_your_vercel_ai_gateway_key';
const isActive = j => ACTIVE.includes(j.status);

class ClientError extends Error {
  constructor(status, message) { super(message); this.status = status; }
}

const PROMPT = `Edit the ORIGINAL photograph into a realistic nighttime photograph of the SAME building. Preserve its exact architecture, roof geometry, proportions, windows, doors, signs, landscaping, surroundings, framing and camera angle. Do not add, remove, replace, reshape or move any part of the scene.

Add professionally installed Govee Permanent Outdoor Lights Pro-style lighting under every visible eligible eave, sloping gable underside, overhang and canopy, including left, center and right sections. Place small, discreet fixtures at approximately 16-inch intervals in real-world scale, evenly spaced along each eave and adjusted for perspective; do not overcrowd them.

Fixture placement is critical: attach each fixture to the underside of an existing soffit, pointing downward toward the wall. If an underside is hidden or has no adjacent receiving surface, do not invent a fixture or illuminate that section. Follow only genuinely visible soffit runs; never place lighting on shingles, roof seams, gutters, vertical trim or the tops of roof edges. Each run ends naturally where the soffit ends or is occluded.

Each fixture casts one compact downward-facing curved scallop originating at that fixture on the receiving wall directly below. Match beam size to fixture spacing and distance from the wall; use a consistent mounting offset along each run. Keep neighboring scallops distinct with only soft edge overlap, not intersecting hard beams or a merged flood of color. Preserve gaps caused by physical obstructions. At corners, valleys, intersecting gables and roof junctions, terminate each run at its real visible edge; do not double fixtures at shared endpoints or bridge across open space. On gables the scallops follow both sloping eaves; on horizontal eaves they form a level row. Do not reduce an entire eave to a few oversized spotlights.

Light obeys the scene's geometry: roof overhangs, gutters, window recesses, trim, columns, trees and foreground objects block it naturally. A lower roof blocks light from an upper eave; do not paint a rainbow across that roof or continue an upper-wall beam below it. No rays through roofs, windows, foliage or walls. Keep glass mostly dark with restrained reflections rather than making window frames emit light. Do not invent additional lighting to fill an unlit area.

Match real permanent outdoor wall-wash lights: tiny discreet flush-mounted points beneath existing soffits, not prominent round bulbs or large lamps. Soft-edged scallops have restrained highlights and fade progressively down the wall, leaving the lower facade substantially less illuminated. Preserve the original siding, stone, mortar and garage-door texture beneath the light; colored light must not recolor the material as if painted. Reflections on vehicles follow their original surfaces and remain faint. Keep driveway, garden and grass predominantly in ambient night light, without vivid colored pools. Preserve existing lamps without multiplying them.

Never add: box fixtures, spotlights, sconces, invented ledges, duplicate or repeated fixture rows, visible wires, exposed LED strips, luminous lines or neon strips along a roof or canopy, glowing roof outlines, lit roof ridges or vertical window frames, hard shadow bands or clipped highlights.

Use this color sequence: warm white, yellow, pink, magenta, purple, blue, cyan, turquoise and green. Clearly show all of these colors across the visible rooflines, with gradual transitions between adjacent fixtures; do not make all lights warm white. Color only the local illuminated areas beneath each fixture: do not tint the entire facade, windows, roof or driveway. Use moderate brightness and restrained saturation, retaining wall detail and color variation. Avoid clipped white hotspots, colored haze and neon glow. Keep the rest of the building naturally lit and visible.

Use a subdued natural deep-blue night sky and balanced photographic exposure, without an artificial blue filter over the entire scene. Preserve neutral colors outside the local light footprints. Keep shadow details readable without flattening the image or adding dramatic black bands. Natural camera texture, realistic contrast, no HDR crunch, plastic smoothing or computer-rendered sheen. Prioritize the original architecture and physically plausible restrained light over spectacular brightness. Photorealistic architectural photography.`;

app.use((req, res, next) => { res.set('Cache-Control', 'no-store'); next(); });
app.get('/', (req, res) => res.sendFile(path.join(__dirname, 'index.html')));
app.use('/api/govee', (req, res, next) => {
  const match = /(?:^|;\s*)afterglow=([a-f0-9]{48})(?:;|$)/.exec(req.headers.cookie || '');
  let session = match && sessions.get(match[1]);
  if (!session && req.path === '/session' && req.method === 'GET') {
    const id = token(); session = { csrf: token(), jobs: [], keys: new Map() }; sessions.set(id, session);
    res.setHeader('Set-Cookie', `afterglow=${id}; HttpOnly; SameSite=Strict; Path=/`);
  }
  if (!session) return res.status(403).json({ error: { message: 'Session expired. Reconnect and try again.' } });
  session.lastSeen = Date.now();
  req.session = session;
  if (req.method !== 'GET' && (req.get('X-CSRF-Token') !== session.csrf || req.get('Origin') !== `http://127.0.0.1:${port}`)) return res.status(403).json({ error: { message: 'Invalid session or origin. Use http://127.0.0.1:8000.' } });
  next();
});
// Photos live in memory, so drop idle sessions instead of growing until restart.
setInterval(() => {
  const cutoff = Date.now() - SESSION_TTL;
  for (const [id, s] of sessions) if (s.lastSeen < cutoff && !s.jobs.some(isActive)) sessions.delete(id);
}, 10 * 60 * 1000).unref();

function quota(s) {
  const today = new Date().toISOString().slice(0, 10);
  const todays = s.jobs.filter(j => j.createdAt.slice(0, 10) === today);
  const used = todays.filter(j => j.status === 'completed').length;
  const reserved = todays.filter(isActive).length;
  return { limit: DAILY_LIMIT, used: Math.min(used, DAILY_LIMIT - reserved), reserved, attemptsLeft: Math.max(0, DAILY_ATTEMPTS - todays.length) };
}
function canStart(s) {
  const q = quota(s);
  if (s.jobs.some(isActive)) return 'A preview is already being created. Wait for it to finish.';
  if (q.used + q.reserved >= q.limit) return 'Daily preview allowance reached. Try again after midnight UTC.';
  if (!q.attemptsLeft) return 'Too many attempts today. Try again after midnight UTC.';
  return '';
}
function publicJob(j) {
  return { id: j.id, status: j.status, createdAt: j.createdAt, originalUrl: `/api/govee/assets/${j.id}-original`, outputUrl: j.image ? `/api/govee/assets/${j.id}-night` : null, errorMessage: j.errorMessage || '' };
}
const payload = (s, j) => ({ job: publicJob(j), quota: quota(s) });
app.get('/api/govee/session', (req, res) => res.json({ csrfToken: req.session.csrf, quota: quota(req.session), jobs: req.session.jobs.map(publicJob), generationEnabled: keyReady(), serviceMessage: 'Add AI_GATEWAY_API_KEY to .env.local, restart the local server, then reconnect.' }));
app.post('/api/govee/jobs', upload.single('image'), async (req, res) => {
  const s = req.session, idempotency = req.get('Idempotency-Key');
  if (!idempotency || idempotency.length > 128) throw new ClientError(400, 'Missing request ID.');
  if (s.keys.has(idempotency)) return res.status(202).json(payload(s, s.keys.get(idempotency)));
  if (!keyReady()) throw new ClientError(503, 'Configure the gateway key in .env.local and restart.');
  const blocked = canStart(s);
  if (blocked) throw new ClientError(429, blocked);
  if (!req.file) throw new ClientError(400, 'Choose one house photo.');
  const meta = await sharp(req.file.buffer).metadata().catch(() => ({}));
  if (!['jpeg', 'png', 'webp'].includes(meta.format) || !meta.width || !meta.height) throw new ClientError(400, 'Invalid image. Use a JPEG, PNG or WebP photo.');
  if (Math.min(meta.width, meta.height) < 320) throw new ClientError(400, 'This photo is too small. Use at least 320 pixels per side.');
  if (meta.width * meta.height > MAX_PIXELS) throw new ClientError(400, 'Use a photo under 40 megapixels.');
  const { data: original, info } = await sharp(req.file.buffer, { limitInputPixels: MAX_PIXELS }).rotate()
    .resize({ width: MAX_EDGE, height: MAX_EDGE, fit: 'inside', withoutEnlargement: true })
    .jpeg({ quality: 90, mozjpeg: true }).toBuffer({ resolveWithObject: true });
  // Re-check after asynchronous decoding so simultaneous uploads cannot both reserve a slot.
  const late = canStart(s);
  if (late) throw new ClientError(429, late);
  const job = { id: randomUUID(), status: 'queued', createdAt: new Date().toISOString(), original, width: info.width, height: info.height, image: null, controller: new AbortController() };
  s.jobs.push(job); s.keys.set(idempotency, job);
  res.status(202).json(payload(s, job));
  run(job);
});
async function run(job) {
  job.status = 'generating'; job.errorMessage = '';
  const started = Date.now();
  try {
    const result = await generateImage({ model, prompt: { text: PROMPT, images: [job.original] }, n: 1, maxRetries: 0, abortSignal: AbortSignal.any([job.controller.signal, AbortSignal.timeout(180000)]) });
    if (job.status === 'cancelled') return;
    // Match the original's exact size so the comparison slider lines up pixel for pixel.
    job.image = await sharp(Buffer.from(result.image.uint8Array), { limitInputPixels: MAX_PIXELS })
      .resize(job.width, job.height, { fit: 'fill' }).png({ compressionLevel: 6 }).toBuffer();
    if (job.status === 'cancelled') { job.image = null; return; }
    job.status = 'completed';
    console.log(`Night edit finished in ${((Date.now() - started) / 1000).toFixed(1)}s`);
  } catch (err) {
    if (job.status === 'cancelled') return;
    console.error('Local night edit failed:', err.message);
    job.status = 'failed';
    job.errorMessage = 'The image edit failed. Check the local server terminal for the provider error and verify model availability in your region.';
  }
}
app.get('/api/govee/jobs/:id', (req, res) => {
  const job = req.session.jobs.find(j => j.id === req.params.id);
  if (!job) throw new ClientError(404, 'Job not found.');
  res.json(payload(req.session, job));
});
app.post('/api/govee/jobs/:id/cancel', (req, res) => {
  const job = req.session.jobs.find(j => j.id === req.params.id);
  if (!job) throw new ClientError(404, 'Job not found.');
  if (isActive(job)) {
    job.status = 'cancelled';
    job.errorMessage = 'Generation stopped. The provider may still charge for the request.';
    job.controller.abort();
  }
  res.json(payload(req.session, job));
});
app.get('/api/govee/assets/:asset', (req, res) => {
  const match = /^([a-f0-9-]{36})-(original|night)$/.exec(req.params.asset);
  const job = match && req.session.jobs.find(j => j.id === match[1]);
  const data = job && (match[2] === 'original' ? job.original : job.image);
  if (!data) return res.sendStatus(404);
  res.type(match[2] === 'original' ? 'jpeg' : 'png').send(data);
});
app.get('/api/govee/jobs/:id/download', (req, res) => {
  const job = req.session.jobs.find(j => j.id === req.params.id);
  if (!job?.image) return res.sendStatus(404);
  res.type('png').attachment('lighting-preview-night.png').send(job.image);
});
app.use((err, req, res, next) => {
  const status = err instanceof ClientError ? err.status : err.code === 'LIMIT_FILE_SIZE' ? 413 : 400;
  const message = err instanceof ClientError ? err.message : err.code === 'LIMIT_FILE_SIZE' ? 'Your photo is larger than 10 MB.' : 'Invalid upload or request. Check the local server terminal.';
  if (!(err instanceof ClientError)) console.error('Local server error:', err.message);
  if (!res.headersSent) res.status(status).json({ error: { message } });
});
app.listen(port, '127.0.0.1', err => {
  if (err) { console.error(`Could not start on port ${port}: ${err.message}. Stop the other app using it first.`); process.exit(1); }
  console.log(`Local testing only: http://127.0.0.1:${port} (gateway key ${keyReady() ? 'configured' : 'missing'}; model ${model})`);
});
