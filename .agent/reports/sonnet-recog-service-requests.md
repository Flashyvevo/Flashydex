# Requests from sonnet-recog-service (outside my ownership)

## Sol (packages/schemas)
1. `packages/schemas/src/index.ts`: add `export * from './recognition';` (I created `src/recognition.ts` only; I did not touch `index.ts` / `json-schema.ts`).
2. `packages/schemas/src/json-schema.ts`: optionally register `'recognition-response.v1.schema.json': recognitionResponseJsonSchema` in `JSON_SCHEMA_FILES` (the generator function already lives in `recognition.ts`).
3. Contract fixtures: a shared JSON sample of an `/v1/identify` response validated by both zod and pydantic (`services/recognition/app/api/schemas.py`) — not done; I only mirrored the fields by hand.

## Terra (deploy)
1. Daemonize `scripts/recognition/serve.sh` (127.0.0.1:8900). **Set `FLASHYDEX_RECOG_TOKEN`** before exposing through Cloudflare Tunnel: the tunnel connects from 127.0.0.1, so with no token the service rejects any request that carries `CF-Connecting-IP`/`X-Forwarded-For` (fails closed).
2. Set `FLASHYDEX_RECOG_ALLOWED_ORIGINS` to the production origin(s) of the app (comma list); default is the three dev origins only.
3. Health probe: `GET /health` (open, no token) for liveness; `GET /v1/health` (token) for index status.
4. Keep `services/recognition/data/` (index ≈ 80 MB + cache of reference images) on a persistent disk; `data/cache/` can be deleted after a build to reclaim disk but forces a re-download on the next rebuild.
5. Cloudflare may add its own body limit (100 MB on free) and timeouts (100 s) — both far above what this service needs (8 MB, ~1–2 s).

## UI child (apps/*, calls the service directly)
1. `POST {base}/v1/identify` multipart `image` (+ `lang=en|ja|any`, `max_candidates=3`), header `Authorization: Bearer <token>`.
2. Downscale on the client to ≤ 1600 px long side and re-encode JPEG q≈0.85 before upload: keeps it under the 8 MB cap, makes uploads fast on cellular, and converts HEIC (the service returns 415 `HEIC_UNSUPPORTED`; iOS Safari file inputs usually hand JPEG already, but `<input accept="image/*">` can deliver HEIC on some paths).
3. Status handling: `match` → preselect candidate 0 but still require a tap; `candidates` → show up to 3, preselect nothing; `no_match` / `no_card` → "couldn't identify, try again / search manually". Never auto-add.
4. `variantHints` (on candidates[0] only) are weak single-photo guesses: use only as a default for the variant chip (≥ ~0.6), always let the owner confirm.
5. `imageUrl` is TCGdex `low.webp` (245×337): fine for thumbnails.
6. Handle 429 (`Retry-After`), 503 `BUSY` (retry after 1 s) and 503 `INDEX_NOT_READY`.
