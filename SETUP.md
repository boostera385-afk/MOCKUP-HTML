# Local Govee mockup test

This is a **local-only test backend**, not a production deployment. It connects the existing HTML to Vercel AI Gateway, defaulting to `bytedance/seedream-5.0-pro`. Each request attempts one paid nighttime edit using the original image. Compare it with the original without another generation call. Another attempt makes an additional paid call. Check current Vercel pricing and set a gateway spending limit before testing.

## Start on Windows

1. Install Node.js 20.3 or later (Node 24 is recommended).
2. Open PowerShell in this project folder.
3. Run `npm install`.
4. Copy the example: `Copy-Item .env.example .env.local`
5. Open `.env.local` in Notepad and replace the placeholder with your **Vercel AI Gateway API key**. Do not put quotes around it or share the file. Never paste the key into HTML, chat, screenshots, or a public repository.
6. Run `npm start`.
7. Visit **http://127.0.0.1:8000/** in your browser. Do not open `index.html` directly, or use `localhost` instead of `127.0.0.1`.
8. Upload one house photo, then click **Generate night view**. The multicolor lighting style is used automatically. Compare the result with the original or download it. Most of the wait is the model itself; the terminal prints how long each edit took.
9. Stop the server with Ctrl+C. Restart it after changing `.env.local`.

## Important limitations

- The provider receives the uploaded photograph. Obtain permission before uploading customer photos.
- Seedream 5.0 Pro supports image editing, but gateway availability, image-input compatibility and output quality must be confirmed with a real test. A provider rejection is shown in the server terminal. An AI edit can change architecture, text or framing; inspect both images.
- Jobs, photos, and the 10-image-per-browser daily test allowance are stored **only in process memory**. Failed or stopped attempts don't use the allowance, but each browser is capped at 20 attempts per day because every attempt can be charged. Idle sessions are deleted after two hours. The daily count resets at midnight UTC or when the server restarts. A new browser or cleared cookie creates a new session. There is no persistence, cleanup policy, reliable recovery after restart, or production-grade per-user enforcement. The allowance is not a billing or spending limit. Provider calls can incur charges even when an edit fails or times out.
- Another generation attempt may cost money. The app does not implement roofline detection or verify scallop coverage.
- Use **Stop generation** after the upload is accepted to request cancellation. The server aborts its provider request where possible, but the provider may still process or charge for it. The original remains available in the current session. No provider retry is automatic.
- The server listens only on `127.0.0.1:8000`. Do not expose it with a tunnel, deploy it as-is, or use real customer photos without the necessary privacy controls.
- To compare compatible **image-only** gateway models, add `IMAGE_MODEL=bfl/flux-3-image-klein` to `.env.local`, replace the model ID as needed, and restart the server. A chat-based image model such as Gemini requires a different API integration and cannot be selected this way. Model changes and retries incur provider charges.

## Speed

- Photos are scaled to at most 2048 px on the long side before upload. This cuts upload and model time; the model's output is about that size anyway.
- The page checks for the result every 1.5 seconds and shows it as soon as it is ready.
- The model's inference time is the main wait and is set by the provider. To try a faster model, set `IMAGE_MODEL` in `.env.local` (see below) and compare quality and time in the terminal.
- The night image is resized to exactly match the original so the comparison slider lines up.

## Putting it on the website

The page is styled to match the main site (colors, Barlow fonts, pill buttons). The local server only accepts requests from `http://127.0.0.1:8000`, so the website **cannot** use it for real visitors. Embed the page with an iframe only after it is served together with a production backend on HTTPS (see "Before deployment").

## Troubleshooting

- **Key missing:** Ensure `.env.local` is in this folder, contains `AI_GATEWAY_API_KEY=...`, and restart `npm start`.
- **Edit fails:** Read the local terminal. Check gateway access, credits, model availability, image input support, and network access. Do not share raw logs if they contain sensitive information.
- **Page cannot connect:** Visit the exact URL above and confirm the terminal says the server is running. If port 8000 is occupied, stop the other application first.
- **Allowance used:** After midnight UTC, refresh the page to fetch the new allowance. Alternatively, restarting resets the local-only allowance but removes existing results; download them first.

## Before deployment

Replace this test server with a production backend. Keep secrets server-side in deployment environment variables, use HTTPS, authenticated/private asset storage, validated uploads, persistent jobs and idempotency, access controls, abuse and spending limits, documented data retention/deletion, and monitoring. Test image editing, day/night quality, retries and embedding cookies. Remove or replace the local test server rather than exposing it publicly. The production server must also allow the website's HTTPS origin in place of `http://127.0.0.1:8000`.

References: https://vercel.com/ai-gateway/models/flux-3-image-klein and https://vercel.com/docs/ai-gateway/modalities/image-generation/ai-sdk
