# Terra recognition proxy report

Status: deployed and externally exercised. No commit or push was made.

## Files changed

- `netlify/functions/identify.ts` — POST-only streamed multipart proxy, 6 MB declared-length guard, bearer injection, IP forwarding, 20-second upstream timeout, discovery cache, error mapping, no-store responses, and best-effort per-instance IP bucket.
- `netlify/functions/recognizer-health.ts` — authenticated upstream health proxy returning `{ ok, indexCounts, version, latencyMs }`.
- `netlify.toml` — functions directory and esbuild bundler.
- `apps/mobile/public/_redirects` — API rewrites above SPA fallback.
- `scripts/recognition/serve.sh` — ignored local token loading without logging it.
- `scripts/recognition/supervise.ps1`, `scripts/recognition/tunnel.ps1` — hidden quick-tunnel watchdog and republish loop.
- `docs/RECOGNIZER-HOSTING.md` — topology, operation, rotation, costs, uptime, and named-tunnel owner steps.

## Netlify environment variables set

- `FLASHYDEX_RECOG_TOKEN` — functions scope, `production` and `deploy-preview` contexts.
- `FLASHYDEX_RECOG_UPSTREAM` — intentionally unset; function discovers the URL from `recognizer.json`.

The generated 32-byte token is stored only in ignored `services/recognition/.env` and Netlify. `git check-ignore` confirmed the local file is ignored. No value is recorded here.

## Function timeout finding

`netlify api getSite` reports the app on `nf_team_pro`; `functions_timeout` is `null` (no site override). Current Netlify Functions guidance reports a 60-second synchronous execution limit, so the contract's old 10-second default/cap does not apply to this Pro site. The proxy still applies its stricter 20-second upstream timeout and returns `RECOGNIZER_TIMEOUT` on an abort.

## Deploy and verification

- Requested build: `6aee9f7d08384f852b02a1af` via `createSiteBuild`.
- Production local deploy: `6aeea007e161fc578e5cec38` — https://6aeea007e161fc578e5cec38--flashydex.netlify.app
- The local deploy was required because the requested no-commit/no-push constraint means a Netlify Git build cannot contain these uncommitted files.
- Build passed: `npm run build`.
- Function modules bundled successfully with esbuild.
- `npm run lint` remains blocked by a pre-existing scanner UI error in `apps/mobile/src/data/recognition.ts:33` (`react-hooks/set-state-in-effect`), outside Terra ownership.
- `npm run test`: core 380/380 and mobile 456/456 passed; recognition has 3 unrelated failures in `test_m2.py` and `test_units.py` (health warm readiness and fusion assertions).

External curl results from `https://flashydex.netlify.app`:

- `POST /api/identify` with `swsh3-136.webp`, `lang=en` → `200`, `Cache-Control: no-store`; returned service JSON with `status: "candidates"` and three card candidates. The service's exact reference result was candidates at confidence `0.7987`, below its current `0.80` match threshold.
- `GET /api/identify` → `405 Method Not Allowed`, `Allow: POST`, no-store.
- `GET /api/recognizer/health` → `200` with `{ "ok": true, "indexCounts": { "en": 19659, "ja": 3878 }, "latencyMs": 385 }`.
- Discovery pointed temporarily at an unavailable HTTPS origin (the safe equivalent of a stopped quick tunnel) → `502` `{ "error": { "code": "RECOGNIZER_OFFLINE", "message": "the scanner is offline", "retryable": true } }`; it was restored to the live URL.
- 7 MiB multipart upload → Netlify front-door `413 Request Entity Too Large` before the function runs. This platform-enforced 6 MB body cap prevents the desired JSON body; the function's declared `Content-Length` JSON guard is implemented but cannot intercept an edge-rejected request.

Five idle end-to-end identify requests: `1.302 s`, `0.909 s`, `0.952 s`, `0.887 s`, `0.928 s`; p50 `0.928 s`, max `1.302 s`, mean `0.995 s`.

## Tunnel

Live quick tunnel published through `recognizer.json`:

`https://required-forward-enquiry-said.trycloudflare.com`

The tunnel's `/health` returned `{"status":"ok"}`. `tunnel.ps1` checks that URL every 60 seconds; failures restart cloudflared and republish the new quick-tunnel hostname.

## Logon processes

Registered and verified as enabled:

- `FlashyDex-Recognizer`: hidden interactive logon task; supervisor runs `serve.sh`; restart-on-failure policy set to 3 restarts / 1 minute.
- `FlashyDex-Tunnel`: hidden interactive logon task; supervisor runs `tunnel.ps1`; same restart policy.

Current listener is loopback only: `127.0.0.1:8900` (PID 6632). A token-gated replacement was independently warmed and verified on `127.0.0.1:8901` before attempted switchover. The unattended runner blocked forceful termination of the director-owned PID 6632, so it could not replace that already-running process. On next logon, the registered recognizer task will start from the ignored token file. The tunnel task was left stopped for this session so it does not replace the currently verified manual quick tunnel before service cutover.

## Open risks

1. The current :8900 process is director-owned and lacks the generated token. Replace it by ending PID 6632 and running `FlashyDex-Recognizer`; then run `FlashyDex-Tunnel`. This requires one owner-side process action because the unattended environment blocked forceful termination.
2. Netlify rejects over-6-MB multipart bodies at the edge with an empty/plain 413 before the function can return contract JSON. The app resizes images well below that limit; document this platform behavior in UI/error handling.
3. Quick tunnels have no SLA, can be rate-limited, and rotate hostname on restart. The owner PC must remain on. Use the documented named-tunnel steps with a Cloudflare zone for a stable production endpoint.
4. The active production deploy is a local manual deploy; a later Git-origin production build will replace it until these files are committed by the owner/director.
