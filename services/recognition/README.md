# FlashyDex recognition service

Python 3.12, FastAPI, CPU-only ONNX Runtime. Identifies a Pokémon card from a photo by retrieval:
detect + rectify → perceptual hashes + DINOv2-small embeddings (full card and artwork crop) + OCR of the
collector number → weighted fusion with OCR as a boost-only nudge → `match` / `candidates` / `no_match` / `no_card`.
Design: `docs/RECOGNITION-DESIGN.md`. Pokeum-derived files carry an MIT header (`THIRD_PARTY_NOTICES.md`).

The browser calls this service directly over HTTPS (Cloudflare Tunnel, wired by Terra). Nothing is persisted.

## Setup

```bash
py -3.12 -m venv services/recognition/.venv
services/recognition/.venv/Scripts/python.exe -m pip install -r services/recognition/requirements.txt
```

`requirements.txt` holds the direct pins (python 3.12, win_amd64 wheels); transitive deps resolve from them.

## Build the index (once, resumable)

```bash
scripts/recognition/index-build.sh --lang en          # ~20k images, 1-2 h on a 4-core CPU
scripts/recognition/index-build.sh --lang ja
scripts/recognition/index-build.sh --lang en --limit 40   # smoke test -> data/index-sample/, never data/index/
```

* Reads `catalog_cards` / `catalog_sets` from the decompressed packs in `.agent/metrics/packs/`
  (`FLASHYDEX_RECOG_CATALOG_DIR`); TCG Pocket (`tcgp`) is excluded; cards with no `image_url` are skipped.
* Downloads `{image_url}/low.webp` (8 parallel, retries with backoff) and the model
  `onnx-community/dinov2-small` (SHA-256 verified; stops with an error if HF needs auth — nothing is substituted).
* Per-card cache in `data/cache/{images,feat}/<lang>/`: re-running only does missing work.
* Output `data/index/<lang>/`: `emb_full.npy`, `emb_art.npy` (float16 N×384), `hashes.npy` (uint8 N×5×32),
  `ids.json`, `cards.json`, `index-manifest.json` (versions, counts, sha256). All of `data/` is git-ignored.

## Serve

```bash
FLASHYDEX_RECOG_TOKEN=<secret> scripts/recognition/serve.sh     # http://127.0.0.1:8900
```

| Env var | Default | Meaning |
|---|---|---|
| `FLASHYDEX_RECOG_HOST` | `127.0.0.1` | bind address; non-loopback refuses to start without a token |
| `FLASHYDEX_RECOG_PORT` | `8900` | |
| `FLASHYDEX_RECOG_TOKEN` | unset | shared bearer token. **Set it when exposing via a tunnel** (see below) |
| `FLASHYDEX_RECOG_ALLOWED_ORIGINS` | `https://localhost:3200,https://127.0.0.1:3200,https://10.0.0.4:3200` | CORS allowlist |
| `FLASHYDEX_RECOG_DATA_DIR` | `services/recognition/data` | `models/`, `index/<lang>/`, `cache/` |
| `FLASHYDEX_RECOG_CATALOG_DIR` | `.agent/metrics/packs` | index build only |
| `FLASHYDEX_RECOG_ORT_THREADS` | `0` (all cores) | ONNX Runtime intra-op threads |
| `FLASHYDEX_RECOG_LOG_LEVEL` | `INFO` | logs carry status/timings only, no IP, filenames or image data |

Auth rule: a valid `Authorization: Bearer <token>` is accepted anywhere (401 `UNAUTHORIZED` when wrong). Without a
bearer, only allowlisted web origins or direct loopback callers get in; a request carrying proxy headers
(`CF-Connecting-IP`, `X-Forwarded-For`, `X-FDX-Client-IP`, …) and no allowed Origin is rejected (403), because a tunnel
also connects from 127.0.0.1. `GET /health` (liveness) is always open.
Per-IP limit key: `X-FDX-Client-IP` (set by the Netlify function) is honoured **only on bearer-authenticated
requests** (invalid IP text is ignored); otherwise `CF-Connecting-IP` from a loopback peer, else the TCP peer.
Limits: 8 MB body (413 `PAYLOAD_TOO_LARGE`), jpeg/png/webp/**heic** (HEIC via `pillow-heif`, magic `ftyp` + brand
heic/heix/mif1/msf1; anything else → 415 `UNSUPPORTED_IMAGE`), 30 requests/min and 300/day per IP + 600/hour global
(429 `RATE_LIMITED`), 2 concurrent identifications (503 `RECOGNIZER_BUSY`). Photos are decoded in memory and never
written to disk; logs carry status/size/timing only.

## API

* `POST /v1/identify` — multipart `image`, optional `lang` (`en|ja|any`, default `any`), `max_candidates` (1–5, default 3).

```jsonc
{ "status": "match|candidates|no_card|no_match", "confidence": 0.0-1.0,
  "candidates": [{ "language": "en", "cardId": "swsh3-136", "localId": "136", "name": "Furret",
                   "setId": "swsh3", "setName": "Darkness Ablaze", "imageUrl": ".../136/low.webp", "score": 0.93,
                   "signals": { "hash": 0.8, "embed": 0.9, "ocr": 1.0, "symbol": null },
                   "variantHints": { "reverseHolo": 0.4 } }],   // hints only on candidates[0]; gated by catalog flags
  "timingMs": { "decode": 20, "detect": 90, "embed": 220, "ocr": 150, "total": 480 },
  "indexVersion": "en:2026.10.31.001+f22797eabf81+…",
  "detection": { "quadFound": true, "fallback": "none" }, "ocr": { "number": 136, "total": 189, "setCode": null, "confidence": 0.9 } }
```

`match` only when the top score ≥ 0.80 **and** leads the runner-up by ≥ 0.10; otherwise up to `max_candidates`
`candidates` (never preselect them); below 0.50 → `no_match` with no candidates (thresholds: see `/v1/health`
`thresholds`; calibration in `.agent/reports/sonnet-recog-service-report-m2.md`). OCR only ever *boosts* a candidate whose
collector number/total match what was read; "no digits read" and "misread digits" are neutral.

Errors, always `{ "error": { "code", "message", "retryable" } }` (HTTP status unchanged):

| code | HTTP | retryable |
|---|---|---|
| `PAYLOAD_TOO_LARGE` | 413 | no |
| `UNSUPPORTED_IMAGE` | 415 | no |
| `RECOGNIZER_BUSY` | 503 | yes (`Retry-After: 1`) |
| `RATE_LIMITED` | 429 | yes (`Retry-After`) |
| `UNAUTHORIZED` | 401 | no |
| `INDEX_NOT_READY`, `MODEL_MISSING` | 503 | yes |
| `INVALID_IMAGE`, `INVALID_LANG`, `INVALID_MAX_CANDIDATES` | 400 | no |
| `INVALID_REQUEST` (missing/bad multipart field) | 422 | no |
| `ORIGIN_NOT_ALLOWED` | 403 | no |

(`RECOGNIZER_OFFLINE` / `RECOGNIZER_TIMEOUT` are produced by the Netlify proxy, never by this service.)
* `GET /v1/health` — `{ ready, warm, counts: {en, ja}, catalogVersion, indexVersion, uptimeSec, lastIdentifyMs, … }`.
  `ready` is true only when every configured language index is loaded **and** the startup warm-up embed ran;
  `status` is `ok` iff `ready`. Also thresholds, limits, model/embedder, `ocr`, `heic`. `GET /v1/index/manifest` —
  per-language manifests.
* Zod mirror: `packages/schemas/src/recognition.ts`.

## CLI

`python -m app.cli` (from `services/recognition`): `index build --lang en,ja [--limit N]`, `index status`,
`model fetch`, `identify <file> [--lang en|ja|any]`, `eval --lang en --n 200` (synthetic-photo eval incl. a
"card removed from catalogue" false-match test), `serve`,
`index verify --catalog-db <catalog-en-….db> --catalog-db <catalog-ja-….db>` (every indexed id must exist in the
production catalog; prints counts, orphans, scannable cards not indexed; exit 1 on orphans),
`eval-m2 [--en 300 --ja 100 --seed 11 --transforms a,b --out data/logs/eval-m2.json]` (reference / rot90/180/270 /
±7° skew+perspective / blur σ1.5 / glare / JPEG q40 / 1600-px photo composite; resumable via `<out>.runs.jsonl`;
every run stores its top-5 candidates + raw signals so thresholds can be re-fitted offline with
`app.eval.simulate` / `summarise_m2`).

## Tests

`bash scripts/test-recognition.sh` (all) or `pytest tests/test_units.py tests/test_api.py` (offline, fast).
`tests/test_e2e.py` builds a 30-card index from real TCGdex images and identifies exact / degraded / blank
inputs; it skips itself when the model, catalog pack or network is missing. Run with `-s` to see per-stage timings.
