'use strict';
// Local testing only. Do not expose this server to the public internet.
require('dotenv').config({ path: '.env.local', quiet: true });
const express = require('express');
const multer = require('multer');
const sharp = require('sharp');
const archiver = require('archiver');
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
const token = () => randomBytes(24).toString('hex');
const keyReady = () => !!process.env.AI_GATEWAY_API_KEY && process.env.AI_GATEWAY_API_KEY !== 'replace_with_your_vercel_ai_gateway_key';
const palettes = { rainbow: 'warm white, yellow, pink, magenta, purple, blue, cyan, turquoise and green in a seamless sequence', warm: 'warm white', christmas: 'red, green and warm white', ocean: 'blue, cyan and turquoise' };

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
  req.session = session;
  if (req.method !== 'GET' && (req.get('X-CSRF-Token') !== session.csrf || req.get('Origin') !== `http://127.0.0.1:${port}`)) return res.status(403).json({ error: { message: 'Invalid session or origin. Use http://127.0.0.1:8000.' } });
  next();
});
function quota(s) {
  const today = new Date().toISOString().slice(0, 10);
  const used = s.jobs.filter(j => j.createdAt.slice(0, 10) === today && j.outputs.length > 0).length;
  const active = s.jobs.filter(j => ['queued', 'generating'].includes(j.status));
  const reserved = active.filter(j => !j.outputs.length).length;
  return { requestLimit: DAILY_LIMIT, imageLimit: DAILY_LIMIT, requestsUsed: Math.min(used, DAILY_LIMIT - reserved), requestsReserved: reserved, imagesUsed: Math.min(used, DAILY_LIMIT - reserved), imagesReserved: reserved };
}
function publicJob(j) {
  return { id: j.id, status: j.status, createdAt: j.createdAt, originalUrl: `/api/govee/assets/${j.id}-original`, outputs: j.outputs.map(v => ({ variant: v, url: `/api/govee/assets/${j.id}-${v}` })), canRetry: j.status === 'partial' && j.retries < 1, errorMessage: j.errorMessage || '' };
}
const payload = (s, j) => ({ job: publicJob(j), quota: quota(s) });
app.get('/api/govee/session', (req, res) => res.json({ csrfToken: req.session.csrf, quota: quota(req.session), jobs: req.session.jobs.map(publicJob), generationEnabled: keyReady(), serviceMessage: 'Add AI_GATEWAY_API_KEY to .env.local, restart the local server, then reconnect.' }));
app.post('/api/govee/jobs', upload.single('image'), async (req, res, next) => {
  try {
    const s = req.session, idempotency = req.get('Idempotency-Key');
    if (!idempotency || idempotency.length > 128) return res.status(400).json({ error: { message: 'Missing request ID.' } });
    if (s.keys.has(idempotency)) return res.status(202).json(payload(s, s.keys.get(idempotency)));
    if (!keyReady()) return res.status(503).json({ error: { message: 'Configure the gateway key in .env.local and restart.' } });
    const q = quota(s);
    if (q.requestsUsed + q.requestsReserved >= DAILY_LIMIT || s.jobs.some(j => ['queued', 'generating'].includes(j.status))) return res.status(429).json({ error: { message: 'Daily testing allowance reached or a request is already running.' } });
    if (!req.file || !palettes[req.body.palette]) return res.status(400).json({ error: { message: 'Choose one image and a valid lighting style.' } });
    const meta = await sharp(req.file.buffer, { limitInputPixels: 40000000 }).metadata();
    if (!['jpeg', 'png', 'webp'].includes(meta.format) || Math.min(meta.width, meta.height) < 320) throw new Error('Invalid image. Use a JPEG, PNG or WebP of at least 320 pixels per side.');
    const original = await sharp(req.file.buffer).rotate().jpeg({ quality: 92 }).toBuffer();
    // Re-check after asynchronous decoding so simultaneous uploads cannot both reserve a slot.
    const latest = quota(s);
    if (latest.requestsUsed + latest.requestsReserved >= DAILY_LIMIT || s.jobs.some(j => ['queued', 'generating'].includes(j.status))) return res.status(429).json({ error: { message: 'Daily testing allowance reached or a request is already running.' } });
    const job = { id: randomUUID(), status: 'queued', createdAt: new Date().toISOString(), original, palette: req.body.palette, outputs: [], images: {}, retries: 0, controller: new AbortController() };
    s.jobs.push(job); s.keys.set(idempotency, job);
    res.status(202).json(payload(s, job));
    run(job);
  } catch (err) { next(err); }
});
async function run(job) {
  job.status = 'generating'; job.errorMessage = '';
  for (const variant of ['night']) {
    if (job.outputs.includes(variant)) continue;
    try {
      const prompt = `Edit the ORIGINAL photograph into a realistic nighttime photograph of the SAME building. Preserve its exact architecture, roof geometry, proportions, windows, doors, signs, landscaping, surroundings, framing and camera angle. Do not add, remove, replace, reshape or move any part of the scene.

Add professionally installed Govee Permanent Outdoor Lights Pro-style lighting under every visible eligible eave, sloping gable underside, overhang and canopy, including left, center and right sections. Place small, discreet fixtures at approximately 16-inch intervals in real-world scale, evenly spaced along each eave and adjusted for perspective; do not overcrowd them. Exact physical spacing cannot be inferred from a photo.

Fixture placement is critical: attach each fixture to the underside of an existing soffit, pointing downward toward the wall. If an underside is hidden or has no adjacent receiving surface, do not invent a fixture or illuminate that section. Follow only genuinely visible soffit runs; never place lighting on shingles, roof seams, gutters, vertical trim or the tops of roof edges. Each run ends naturally where the soffit ends or is occluded. Keep fixture size and spacing consistent with perspective. No additional fixture housings, repeated rows, luminous lines or neon strips along a roof or canopy.

Each fixture casts one compact downward-facing curved scallop originating at that fixture on the receiving wall directly below. Match beam size to fixture spacing and distance from the wall; use a consistent mounting offset along each run. Keep neighboring scallops distinct with only soft edge overlap, not intersecting hard beams or a merged flood of color. Preserve gaps caused by physical obstructions. At corners, valleys, intersecting gables and roof junctions, terminate each run at its real visible edge; do not double fixtures at shared endpoints or bridge across open space. On gables the scallops follow both sloping eaves; on horizontal eaves they form a level row. Do not reduce an entire eave to a few oversized spotlights.

Light obeys the scene's geometry: roof overhangs, gutters, window recesses, trim, columns, trees and foreground objects block it naturally. A lower roof blocks light from an upper eave; do not paint a rainbow across that roof or continue an upper-wall beam below it. No rays through roofs, windows, foliage or walls. Keep glass mostly dark with restrained reflections rather than making window frames emit light. Do not invent additional lighting to fill an unlit area.

Match real permanent outdoor wall-wash lights: tiny discreet flush-mounted points beneath existing soffits, not prominent round bulbs or large lamps. Soft-edged scallops have restrained highlights and fade progressively down the wall, leaving the lower facade substantially less illuminated. Preserve the original siding, stone, mortar and garage-door texture beneath the light; colored light must not recolor the material as if painted. Reflections on vehicles follow their original surfaces and remain faint. Keep driveway, garden and grass predominantly in ambient night light, without vivid colored pools. Avoid added box fixtures, spotlights, sconces, invented ledges, duplicate fixture rows, visible wires, exposed strips, hard shadow bands, glowing roof outlines and clipped highlights. Preserve existing lamps without multiplying them. Do not illuminate roof ridges or vertical window frames.

Use this color sequence: ${palettes[job.palette]}. ${job.palette === 'rainbow' ? 'Clearly show warm white, yellow, pink, magenta, purple, blue, cyan, turquoise and green across the visible rooflines, with gradual transitions between adjacent fixtures; do not make all lights warm white.' : 'Apply the selected colors consistently throughout the visible sections.'} Color only the local illuminated areas beneath each fixture: do not tint the entire facade, windows, roof or driveway. Use moderate brightness and restrained saturation, retaining wall detail and color variation. Avoid clipped white hotspots, colored haze and neon glow. Keep the rest of the building naturally lit and visible.

Use a subdued natural deep-blue night sky and balanced photographic exposure, without an artificial blue filter over the entire scene. Preserve neutral colors outside the local light footprints. Keep shadow details readable without flattening the image or adding dramatic black bands. Natural camera texture, realistic contrast, no HDR crunch, plastic smoothing or computer-rendered sheen. Prioritize the original architecture and physically plausible restrained light over spectacular brightness. Photorealistic architectural photography.`;
      const result = await generateImage({ model, prompt: { text: prompt, images: [job.original] }, n: 1, maxRetries: 0, abortSignal: AbortSignal.any([job.controller.signal, AbortSignal.timeout(180000)]) });
      if (job.status === 'cancelled') return;
      const image = await sharp(Buffer.from(result.image.uint8Array), { limitInputPixels: 40000000 }).png().toBuffer();
      if (job.status === 'cancelled') return;
      job.images[variant] = image;
      job.outputs.push(variant);
    } catch (err) {
      if (job.status === 'cancelled') return;
      console.error(`Local ${variant} edit failed:`, err.message);
      job.errorMessage = 'An image edit failed. Check the local server terminal for the provider error and verify model availability in your region.';
    }
  }
  job.status = job.outputs.includes('night') ? 'completed' : 'failed';
}
app.get('/api/govee/jobs/:id', (req, res) => {
  const job = req.session.jobs.find(j => j.id === req.params.id);
  if (!job) return res.status(404).json({ error: { message: 'Job not found.' } });
  res.json(payload(req.session, job));
});
app.post('/api/govee/jobs/:id/cancel', (req, res) => {
  const job = req.session.jobs.find(j => j.id === req.params.id);
  if (!job) return res.status(404).json({ error: { message: 'Job not found.' } });
  if (['queued', 'generating'].includes(job.status)) {
    job.status = 'cancelled';
    job.errorMessage = 'Generation stopped. The provider may still charge for the request.';
    job.controller.abort();
  }
  res.json(payload(req.session, job));
});
app.post('/api/govee/jobs/:id/retry', (req, res) => {
  const job = req.session.jobs.find(j => j.id === req.params.id);
  if (!job || job.status !== 'partial' || job.retries >= 1 || req.session.jobs.some(j => ['queued', 'generating'].includes(j.status))) return res.status(400).json({ error: { message: 'This job cannot be retried.' } });
  job.retries++; job.status = 'queued'; res.status(202).json(payload(req.session, job)); run(job);
});
app.get('/api/govee/assets/:asset', (req, res) => {
  const match = /^([a-f0-9-]{36})-(original|day|night)$/.exec(req.params.asset);
  const job = match && req.session.jobs.find(j => j.id === match[1]);
  const data = job && (match[2] === 'original' ? job.original : job.images[match[2]]);
  if (!data) return res.sendStatus(404);
  res.type(match[2] === 'original' ? 'jpeg' : 'png').send(data);
});
app.get('/api/govee/jobs/:id/download', (req, res) => {
  const job = req.session.jobs.find(j => j.id === req.params.id), variant = req.query.variant;
  if (!job || !['day', 'night', 'both'].includes(variant)) return res.sendStatus(404);
  if (variant !== 'both') {
    if (!job.images[variant]) return res.sendStatus(404);
    return res.type('png').attachment(`afterglow-${variant}.png`).send(job.images[variant]);
  }
  if (!job.images.day || !job.images.night) return res.sendStatus(404);
  res.type('zip').attachment('afterglow-day-night.zip');
  const archive = archiver('zip'); archive.on('error', () => res.destroy()); archive.pipe(res);
  archive.append(job.images.day, { name: 'day.png' }); archive.append(job.images.night, { name: 'night.png' }); archive.finalize();
});
app.use((err, req, res, next) => { console.error('Local server error:', err.message); if (!res.headersSent) res.status(400).json({ error: { message: 'Invalid upload or request. Check the local server terminal.' } }); });
app.listen(port, '127.0.0.1', () => console.log(`Local testing only: http://127.0.0.1:${port} (gateway key ${keyReady() ? 'configured' : 'missing'}; model ${model})`));
