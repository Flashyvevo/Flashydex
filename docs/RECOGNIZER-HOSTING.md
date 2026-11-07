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

`/api/identify` accepts POST multipart requests, rejects a declared body above 6 MB before reading it, counts the streamed bytes (aborting beyond 6 MiB total, boundary overhead included, with or without `Content-Length`), requires exactly one `image` part (otherwise 400 `INVALID_IMAGE`), applies a small best-effort per-instance IP bucket, and has a 20-second upstream timeout. The body is buffered in function memory (≤ 6 MiB) before it is forwarded. A validated upstream `Retry-After` (whole seconds) is preserved on 429/503 and the local bucket emits its own. Upstream 503 envelopes are mapped by code: `RECOGNIZER_BUSY` (concurrency only), `INDEX_NOT_READY` and `MODEL_MISSING` keep their code with HTTP 503; any other 503/5xx becomes `RECOGNIZER_OFFLINE` (502). The real rate/concurrency controls are enforced by the service. Responses use `Cache-Control: no-store`. Function tests: `node --test netlify/tests/identify.test.ts`.

The service authorizes `/v1/*` only by bearer token (or a direct loopback call with no proxy headers, for dev/CLI). An allowed `Origin` is CORS browser policy and never authorizes a tunneled request.

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

**Current state (verify before relying on it):** the quick tunnel presently runs from a `tunnel.ps1` started by hand, not from the scheduled task. The `FlashyDex-Tunnel` task's hidden supervisor (`supervise.ps1`) exits immediately when started; the root cause is not yet known, so **automatic tunnel start at logon and automatic restart/republish have not been delivered**. A `Ready` task status says the task is registered, not that a tunnel is up. After a reboot or logout, start `scripts/recognition/tunnel.ps1` manually (or fix the task) and check that `cloudflared` is running and `recognizer.json` has a fresh `updatedAt`. `FlashyDex-Recognizer` does hold port 8900 today; confirm with `netstat -ano | grep :8900`.

Two per-user scheduled tasks are installed by `scripts/recognition/install-service.ps1` and are intended to start hidden at logon:

- `FlashyDex-Recognizer` runs `scripts/recognition/serve.sh`, loopback-only on port 8900.
- `FlashyDex-Tunnel` is meant to run `scripts/recognition/tunnel.ps1` through the hidden supervisor (see the state above: not working yet).

Both tasks are configured to restart failures up to three times with a one-minute interval. When `tunnel.ps1` is running, its watchdog checks `https://<quick-tunnel>/health` every 60 seconds; on failure it restarts cloudflared, captures the new `trycloudflare.com` URL in `services/recognition/data/logs/tunnel-url.txt`, and republishes `recognizer.json`. That watchdog only exists while `tunnel.ps1` itself is alive.

To restart either process, use Task Scheduler to end and run the corresponding task, or log out and back in. Inspect `services/recognition/data/logs/serve.log`, `tunnel.log`, and `cloudflared.log`. Keep port 8900 bound only to `127.0.0.1`; confirm with `netstat -ano | grep :8900`.

## Costs, uptime, and upgrade path

This initial host is the owner PC. Recognition is unavailable while the PC, its network, the service process, or the quick tunnel is unavailable. Cloudflare quick tunnels have no SLA, may be rate-limited, and their random hostname changes whenever they restart. Netlify Functions are also metered, and the quota depends on your plan: older (legacy) plans counted 125,000 invocations and 100 runtime hours per month, while newer credit-based plans meter differently. Those legacy numbers are not a guarantee for this site; check the current plan and billing page in the Netlify dashboard before relying on any figure.

A small VPS (typically $5–10/month) would give a stable host and move the recognizer off the owner PC, but whether it has the CPU, RAM and latency this recognizer needs (DINOv2 embedding + OCR, ~0.5 s per request on this PC) has not been measured; benchmark before assuming it fits. It would still need monitoring, patching, and a persistent disk for indexes/models. A named Cloudflare Tunnel on a domain gives a stable hostname and managed tunnel identity while keeping the recognizer at home.

Named-tunnel owner setup (requires a Cloudflare account with a zone):

1. Add or select the DNS zone in Cloudflare and install/authenticate cloudflared with `cloudflared tunnel login` in an owner-controlled session.
2. Create a named tunnel: `cloudflared tunnel create flashydex-recognizer`.
3. Create a Cloudflare config mapping a stable hostname such as `recognizer.example.com` to `http://127.0.0.1:8900`.
4. Route DNS with `cloudflared tunnel route dns flashydex-recognizer recognizer.example.com`.
5. Install cloudflared as a durable service/task using the named tunnel credentials, preserving loopback-only origin binding.
6. Set `FLASHYDEX_RECOG_UPSTREAM=https://recognizer.example.com` in Netlify Functions scope for production and deploy-preview, deploy, and verify the two API routes.
7. Retire the quick-tunnel watchdog only after the stable endpoint passes health and identify checks.
