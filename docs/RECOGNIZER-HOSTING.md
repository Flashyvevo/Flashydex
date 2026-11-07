# Recognition hosting

## Architecture

The browser calls the same-origin Netlify endpoints only:

```
FlashyDex PWA
  POST /api/identify
  GET  /api/recognizer/health
        │
        ▼
Netlify Function (holds the bearer token)
        │ HTTPS + Authorization + X-FDX-Client-IP
        ▼
Cloudflare quick tunnel (`*.trycloudflare.com`)
        │
        ▼
http://127.0.0.1:8900/v1/* on the owner PC
```

The browser never receives the tunnel URL or recognition bearer token. The function first uses `FLASHYDEX_RECOG_UPSTREAM` if set. Otherwise it reads `https://flashydex-recognizer.netlify.app/recognizer.json`; that lookup is cached in function memory for at most 60 seconds. `scripts/recognition/publish-url.sh` republishes the current quick-tunnel URL so a tunnel restart does not require an app deploy.

`/api/identify` accepts POST multipart requests, rejects a declared body above 6 MB before proxying, forwards the request stream, applies a small best-effort per-instance IP bucket, and has a 20-second upstream timeout. The real rate/concurrency controls are enforced by the service. Responses use `Cache-Control: no-store`.

## Environment variables

Netlify Functions scope:

- `FLASHYDEX_RECOG_TOKEN` — required; production and deploy-preview.
- `FLASHYDEX_RECOG_UPSTREAM` — optional fixed HTTPS base URL. Leave unset to use discovery.

Recognition service environment:

- `FLASHYDEX_RECOG_HOST`
- `FLASHYDEX_RECOG_PORT`
- `FLASHYDEX_RECOG_TOKEN`
- `FLASHYDEX_RECOG_ALLOWED_ORIGINS`
- `FLASHYDEX_RECOG_DATA_DIR`
- `FLASHYDEX_RECOG_CATALOG_DIR`
- `FLASHYDEX_RECOG_ORT_THREADS`
- `FLASHYDEX_RECOG_LOG_LEVEL`

The local `services/recognition/.env` is ignored by Git and contains only the generated token as a raw hex line. `serve.sh` reads that format without logging it. The production browser origin is set for the service; the function is the normal caller.

## Rotate the token

1. Stop the `FlashyDex-Recognizer` scheduled task after draining active scans.
2. Generate a new 32-byte token and replace the ignored `services/recognition/.env` value. Do not put it in source control, a terminal transcript, or a Vite variable.
3. Update `FLASHYDEX_RECOG_TOKEN` in Netlify, scope `functions`, for both `production` and `deploy-preview`.
4. Redeploy the app so the function receives the new environment value.
5. Restart `FlashyDex-Recognizer`, then verify authenticated `/v1/health` locally and `https://flashydex.netlify.app/api/recognizer/health` externally.

## Operations

Two per-user scheduled tasks are installed by `scripts/recognition/install-service.ps1` and start hidden at logon:

- `FlashyDex-Recognizer` runs `scripts/recognition/serve.sh`, loopback-only on port 8900.
- `FlashyDex-Tunnel` runs `scripts/recognition/tunnel.ps1` through the hidden supervisor.

Both tasks restart failures up to three times with a one-minute interval. The tunnel watchdog checks `https://<quick-tunnel>/health` every 60 seconds. On failure it restarts cloudflared, captures the new `trycloudflare.com` URL in `services/recognition/data/logs/tunnel-url.txt`, and republishes `recognizer.json`.

To restart either process, use Task Scheduler to end and run the corresponding task, or log out and back in. Inspect `services/recognition/data/logs/serve.log`, `tunnel.log`, and `cloudflared.log`. Keep port 8900 bound only to `127.0.0.1`; confirm with `netstat -ano | grep :8900`.

## Costs, uptime, and upgrade path

This initial host is the owner PC. Recognition is unavailable while the PC, its network, the service process, or the quick tunnel is unavailable. Cloudflare quick tunnels have no SLA, may be rate-limited, and their random hostname changes whenever they restart. Netlify Functions are also metered; the current free-tier reference allowance is 125,000 invocations and 100 runtime hours per month (confirm current plan limits before relying on it).

A small $5–10/month VPS moves the recognizer off the owner PC and gives a stable host, but still needs monitoring, patching, and a persistent disk for indexes/models. A named Cloudflare Tunnel on a domain gives a stable hostname and managed tunnel identity while keeping the recognizer at home.

Named-tunnel owner setup (requires a Cloudflare account with a zone):

1. Add or select the DNS zone in Cloudflare and install/authenticate cloudflared with `cloudflared tunnel login` in an owner-controlled session.
2. Create a named tunnel: `cloudflared tunnel create flashydex-recognizer`.
3. Create a Cloudflare config mapping a stable hostname such as `recognizer.example.com` to `http://127.0.0.1:8900`.
4. Route DNS with `cloudflared tunnel route dns flashydex-recognizer recognizer.example.com`.
5. Install cloudflared as a durable service/task using the named tunnel credentials, preserving loopback-only origin binding.
6. Set `FLASHYDEX_RECOG_UPSTREAM=https://recognizer.example.com` in Netlify Functions scope for production and deploy-preview, deploy, and verify the two API routes.
7. Retire the quick-tunnel watchdog only after the stable endpoint passes health and identify checks.
