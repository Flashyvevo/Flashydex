# Milestone 2 contract — scanner MVP (director, 2026-11-07)

Supersedes M2-D3/M2-D4 where they conflict. Binding for terra-recog-proxy, sonnet-recog-service, sonnet-scanner-ui, sol-review-10.

## Topology (owner rule: Origin/CORS is NOT authentication; no secret in the Vite bundle)
```
PWA (flashydex.netlify.app)  --same-origin POST /api/identify-->  Netlify Function `identify` (holds FLASHYDEX_RECOG_TOKEN)
   --Authorization: Bearer <token>, X-FDX-Client-IP: <client ip>-->  https://<tunnel>.trycloudflare.com  (cloudflared quick tunnel on the owner PC)
   --> http://127.0.0.1:8900/v1/identify  (recognition service, loopback-bound, token-gated)
```
- Browser never sees the token or the tunnel URL. DEV: Vite proxies `/api/identify` → `http://127.0.0.1:8900/v1/identify` directly (no token; loopback rule), and `/api/recognizer/health` → `/v1/health`.
- Upstream URL discovery: the function reads `FLASHYDEX_RECOG_UPSTREAM` (Netlify env, functions scope) if set, else fetches `https://flashydex-recognizer.netlify.app/recognizer.json` (existing `scripts/recognition/publish-url.sh` mechanism), cached ≤60 s. Quick-tunnel restarts therefore need no app redeploy.
- The function enforces: method POST, multipart with one `image` part, `Content-Length` ≤ 6 MB (413 `PAYLOAD_TOO_LARGE`), best-effort per-IP token bucket (Netlify functions are stateless: use the upstream's per-IP limits as the real control — forward the client IP in `X-FDX-Client-IP`, which the service trusts ONLY on bearer-authenticated requests), 20 s upstream timeout (504 `RECOGNIZER_TIMEOUT`), and maps upstream 429/503 `BUSY`/5xx/network errors to the client error codes below. Netlify Functions: 10 s default sync timeout — Terra must verify the limit on this plan and set `timeout` in `netlify.toml [functions]` or choose a background/edge function; if the hard cap is 10 s the function must fail fast with `RECOGNIZER_TIMEOUT` and the UI copy must say so.
- Health: `GET /api/recognizer/health` → function proxies `/v1/health` (no token needed upstream for `/health`; use `/v1/health` with token) and returns `{ ok, indexCounts, version, latencyMs }`; the UI uses it only to show "Scanner offline" copy, never to gate manual add.

## Client-facing JSON (unchanged service contract, `packages/schemas/src/recognition.ts`)
Success: `{ status: 'match'|'candidates'|'no_card'|'no_match', confidence, candidates: [{ language, cardId, localId, name, setId, setName, imageUrl, score, signals, variantHints }], timingMs, indexVersion }`.
Error body: `{ error: { code, message, retryable: boolean } }`, HTTP status as listed:
| code | HTTP | meaning / UI copy owner |
|---|---|---|
| `PAYLOAD_TOO_LARGE` | 413 | client resizes before upload; should not happen |
| `UNSUPPORTED_IMAGE` | 415 | includes HEIC that the client could not re-encode |
| `RECOGNIZER_BUSY` | 503 | retryable; "The scanner is busy — try again in a moment" |
| `RATE_LIMITED` | 429 | retryable later |
| `RECOGNIZER_OFFLINE` | 502 | upstream unreachable/tunnel down; retryable; manual add always available |
| `RECOGNIZER_TIMEOUT` | 504 | retryable |
| `UNAUTHORIZED` | 401 | misconfiguration (token), shown as offline |

## Service changes (sonnet-recog-service)
- Fusion calibration: an exact reference image (hash 1.0 + embed 1.0) MUST return `match`. OCR is a boost/penalty only when the OCR actually read a number; "no digits read" must be neutral, not 0.0. Re-tune thresholds with the eval harness; report precision on reference + transformed sets.
- Trust `X-FDX-Client-IP` for per-IP limits only when the request carries a valid bearer token; otherwise existing loopback/proxy-header rules.
- `/v1/health`: `ready` true only when both indexes are loaded and the model warmed (run one dummy embed at startup); include `counts`, `catalogVersion`, `indexVersion`, `uptimeSec`, `warm: true|false`, `lastIdentifyMs`.
- Index ⊆ production catalog: verify every indexed cardId exists in `tools/catalog-builder/dist-prod/catalog-{en,ja}-2026.10.31.003.db` (decompress with the builder's verify path or open the `.db` that is already there); report counts and any orphans.
- Photos are processed in memory only; assert no file writes under `data/` during identify (test).
- HEIC: if `pillow-heif` wheel installs cleanly on this venv (py3.12 win_amd64), accept HEIC server-side; otherwise keep 415 `HEIC_UNSUPPORTED` → mapped to `UNSUPPORTED_IMAGE`. Client re-encodes to JPEG anyway.

## UI (sonnet-scanner-ui)
- Center tab-bar button = **Scan** (enabled, lime accent), route `/scan` (modal layout like `/add`). Sidebar entry likewise. Remove the "Camera scanning is coming" sheet.
- `/scan` shows four actions: **Take Photo** (`<input type="file" accept="image/jpeg,image/png,image/webp" capture="environment">`), **Choose Photo** (same accept, no capture), **Search Manually** (→ `/add`), **Browse by Set** (→ `/sets`). `accept` deliberately excludes `image/*` so iOS transcodes HEIC → JPEG (see `.agent/research/ios-camera.md` §2); the client still sniffs magic bytes and re-encodes everything via `<img>`-decode → canvas → JPEG q0.85, longest edge 1600 px (EXIF-upright because `<img>` applies orientation; do NOT rely on `createImageBitmap(blob)` on Safari).
- States: Preparing photo → Uploading (progress if available) → Analyzing card… → result. Errors show the copy above + Retry / Take Another / Search Manually / Browse by Set. Never block manual add.
- Results: `match` → large art, name, set, collector number, **Confirm** (opens the existing `AddConfirmSheet`); `candidates` → up to 3 large tiles, no auto-select; `no_match`/`no_card` → Take Another Photo / Search Manually / Browse by Set. Catalog-not-installed → the existing install prompt copy.
- After add: "Added to collection" with **Scan Another** (returns straight to capture — re-open the file input; keep the scan route mounted) and **View Card** (`/cards/$language/$cardId`).
- Reuse `.agent/wip-scanner/**` (move into `src/lib/recognition/`, `src/components/scanner/`, `src/data/recognition.ts`) — adapt the client to call `/api/identify` with NO Authorization header and NO runtime URL discovery in the browser.
- Playwright: `e2e/scanner*.spec.ts` at 375/390/430 widths; mocked recognizer responses for every state + a `@real` tagged spec that posts fixture photos through the DEV proxy to the real service on :8900 (skip gracefully if `/api/recognizer/health` is not ok). Fixtures under `apps/mobile/e2e/fixtures/scanner/` (generate transformed variants from TCGdex reference images: rotated 90°/180°, glare overlay, blur, sleeve-like reflection, unsupported file).

## Ownership
- terra-recog-proxy: `netlify/functions/**`, `netlify.toml` (functions/redirects block), `apps/mobile/public/_redirects` (if needed), `scripts/recognition/**`, `docs/RECOGNIZER-HOSTING.md` (new), Netlify env for the app site (functions scope): `FLASHYDEX_RECOG_TOKEN`, `FLASHYDEX_RECOG_UPSTREAM` (optional). Runs the service + tunnel on this PC and publishes `recognizer.json`.
- sonnet-recog-service: `services/recognition/**`, `scripts/test-recognition.sh`, `packages/schemas/src/recognition.ts` (additive only).
- sonnet-scanner-ui: `apps/mobile/src/routes/_modal/scan*.tsx`, `apps/mobile/src/routes/_modal/add.tsx`, `apps/mobile/src/routeTree.gen.ts`, `apps/mobile/src/components/scanner/**`, `apps/mobile/src/components/shell.tsx` (Scan button/sheet only), `apps/mobile/src/components/add-confirm.tsx` (additive: suggested variant prop + onAdded callback), `apps/mobile/src/lib/recognition/**`, `apps/mobile/src/data/recognition.ts`, `apps/mobile/vite.config.ts` (dev proxy block only), `apps/mobile/e2e/scanner*`, `apps/mobile/e2e/fixtures/scanner/**`, `docs/UX.md` (append-only).
- Nobody touches `src/platform/**`, `packages/core/**`, the storage/handoff code, or another owner's files.

## Shared rules
Unattended; never ask questions; no screenshots/image viewing for Anthropic children (Terra/Sol may view images); `browser_exec` with `session="<role>"`; dev server already on :3200 (don't start/kill); recognition service already running on 127.0.0.1:8900 (PID file `services/recognition/data/logs/serve-director.log`; the service child may restart it ONLY via `scripts/recognition/serve.sh` after its changes and must leave it running); no commits; Playwright with `FLASHYDEX_E2E_PORT=3203` for the UI child; report files under `.agent/reports/<role>-report.md`, draft first.
