# Sonnet — Phase 2 recognition service report

Status: service code, tests and docs are written. **The real EN index is NOT finished and the live-serve/curl check was NOT run** (run budget ran out while the EN feature cache was still filling). Nothing is committed; the server is not running.

## What exists (under `services/recognition/` unless noted)

- `app/vision/` — imaging (EXIF orient), geometry, detect (+ saturation-channel second pass, `looks_blank` → `no_card`), rectify, regions. Pokeum port.
- `app/signals/hashes.py` — rewritten with OpenCV (5 kinds x 256 bit, packed (5,32)). The imagehash version cost ~110 ms/card, a third of build time. Not bit-compatible with imagehash; `HASH_VERSION=cv2dct-v1` is in the feature-cache key.
- `app/signals/embedding.py` — `onnx-community/dinov2-small`. Verified at runtime: the only output is `last_hidden_state (N,257,384)` (no `pooler_output`), so CLS = `[:,0,:]`, L2-normalised, dim asserted 384. Output-selection rule is unit-tested.
- `app/signals/ocr.py` — `rapidocr-onnxruntime` 1.4.4 (models bundled in the wheel, offline). int `number`, `NNN/NNN`, promo `001/SV-P`, digit look-alikes, stopwords JP/JA.
- `app/signals/symbol.py` — **STUB** (TODO in file). API returns `signals.symbol = null`.
- `app/recognize/fusion.py`, `pipeline.py` — all indexed rows scored (no shortlist), floor-rescaled cosine/hash, OCR = multiplicative boost/penalty never a gate, language mask. `match` only if top >= 0.80 and margin >= 0.10; else candidates (top >= 0.50, up to `max_candidates`); else `no_match` with no candidates. Addition: if the found quad covers < 90 % of a card-shaped frame, the whole frame is also tried and the better fit kept (tight crops otherwise lock onto the art frame).
- `app/variants/` — Pokeum port; hints only for candidate #1; promo stamp gated on catalog `w_promo`; shadowless computed but not returned (no slot in the owner contract).
- `app/reference/` — reads the SQLite packs; **excludes the `tcgp` series** (TCG Pocket), skips cards without `image_url`; 8 parallel downloads, 4 retries, backoff, Retry-After.
- `app/index/` — float16 `.npy` + `hashes.npy` + `ids.json` + `cards.json` + `index-manifest.json` (sha256/counts/versions); resumable per-card image+feature cache; `--shard K/N` cache-only workers; `--limit N` writes to `data/index-sample/` only.
- `app/api/` — `POST /v1/identify`, `GET /v1/health`, `GET /v1/index/manifest`, open `GET /health`. CORS allowlist; bearer token (constant-time); no token = direct loopback only, proxy headers (`CF-Connecting-IP`, `X-Forwarded-For`...) fail closed; 8 MB cap (header + streamed); jpeg/png/webp by magic bytes, HEIC → 415 `HEIC_UNSUPPORTED`; 60/min/IP; 2 concurrent (503 `BUSY`); logs hold status/bytes/timing only.
- `app/cli.py` (`index build|status`, `model fetch`, `identify`, `eval`, `serve`), `scripts/recognition/{index-build,serve}.sh`, `README.md`, `.env.example`, `data/.gitignore`, `requirements.txt`, `pyproject.toml`.
- `packages/schemas/src/recognition.ts` — created (file did not exist); `tsc --noEmit` on the schemas package passes. Not exported from `index.ts` (not my file). Differences from the owner contract: extra optional `detection` and `ocr`; `signals` members are nullable rather than omitted.
- `THIRD_PARTY_NOTICES.md` — Pokeum MIT text + adapted-file list, DINOv2 (Apache-2.0), RapidOCR/PP-OCR, card-image note. Adapted files carry `Adapted from pokeum (MIT)` headers.
- `.agent/reports/sonnet-recog-service-requests.md` — requests for Sol / Terra / UI child.

## Versions (py -3.12 venv)
fastapi 0.128.8, uvicorn 0.40.0, starlette 0.52.1, pydantic 2.14.2, python-multipart 0.0.33, httpx 0.28.1, numpy 2.2.6, onnxruntime 1.26.0, opencv-python 4.12.0.88 (not headless), Pillow 13.0.0, rapidocr-onnxruntime 1.4.4 (+ shapely 2.2.0, pyclipper 1.4.0, PyYAML, tqdm, six), pytest 9.0.2, ruff 0.14.14.
Deviations: `imagehash` no longer used (OpenCV hashing; it is still installed in the venv, not in requirements); `rapidocr-onnxruntime` as you specified, not the `rapidocr` 3.x in the design. The pre-existing venv carried an unrelated editable-install entry pointing at `c:\projects\pokescan\...`.
Model: `onnx-community/dinov2-small` `onnx/model.onnx`, 88,532,934 bytes, SHA-256 `f22797eabf810a75e41de68d378541ebea372122b25c4ce3ef25ff618250c20a`, HF sha `8b1f705a3a7f6f062f6bdd21986c1583d3ef105d`; downloaded without auth to `data/models/dinov2-small.onnx`.

## Tests — what actually ran
- Offline suite (`test_units.py`, `test_api.py`, `test_health.py`): 38 passed on the last full run. After that I changed hashing (re-ran `-k hash`: 2 passed), added `exclude_rows`, `--shard` and `eval`; `ruff check app tests` is clean, but **the full suite was not re-run after those edits**. Re-run: `bash scripts/test-recognition.sh`.
- `tests/test_e2e.py` (30 real EN cards downloaded in-test; skips offline), last run: 6 passed, 1 failed. Passed: exact reference images → `match` top-1 (this run was after excluding TCG Pocket and adding the whole-frame hypothesis; an earlier run before those fixes failed 3 of 10 exact images); reference rotated 8° + scaled + glare + JPEG q60 → true card in top-3 for 12/12 (top-1 each time; `match` for about 7/12, the rest `candidates` at 0.68–0.80, so 0.80 is conservative on degraded shots); blank gray → `no_card`; blurred noise → `no_card`. Failed: `lang=ja` with no JA rows raised `ValueError: no signals to fuse`; fixed afterwards (`best_top` starts at -inf) but **not re-run**.
- Timings from that e2e run (ms, p50 of 24 calls) were taken **while the index build and other agents loaded the CPU**, so inflated ~2–3x: decode 57, detect 188, rectify 21, prepare 99 (now ~18 after the hash rewrite), embed 1277 (2 images), ocr 356, total 1583. Raw data: `data/logs/e2e-timings.json`. **No idle-CPU latency was measured.** An early idle probe gave ORT ≈ 80–100 ms/image on this 4-core CPU, so ~0.4–0.7 s per identify is an estimate, not a result.

## EN index — NOT complete
- Scope: 19,666 EN cards (23,736 catalog − 1,749 without image − 2,321 TCG Pocket that have images).
- When I stopped: ≈ 7,191 of 19,666 in the feature cache (`data/cache/feat/en`); two shard workers (`--shard 0/2`, `1/2`, ORT 2 threads each, ≈ 1.37 cards/s each, ETA ≈ 100 min from 15:10) were running detached, logging to `data/logs/build-en-s0.log` / `-s1.log`. They only fill the cache. **`data/index/en/` and its `index-manifest.json` do not exist yet.**
- Measured: 4.4 cards/s on the idle machine (first 300 cards); 1.4–2.2 cards/s per process under the heavy CPU contention present all session. Peak RSS ≈ 705–725 MB per build process. Reference images are ≈ 15–25 KB each (≈ 0.4 GB for EN); index artifacts expected ≈ 60 MB.
- To finish, once the shard processes have exited: `bash scripts/recognition/index-build.sh --lang en` (unsharded; everything is cached, so it only assembles and retries failures, about a minute). It prints counts and writes the manifest. If the shards were killed, re-run them or the plain command; it resumes.
- JA (≈ 3.9k cards with image): **not started.** `bash scripts/recognition/index-build.sh --lang ja`.

## Not done
- Real EN manifest/counts/final build time; JA index.
- Serving on 127.0.0.1:8900 and the curl checks. The API is covered by TestClient tests with a fake recognizer (auth, CORS, 413, 415 incl. HEIC, 429, 503 BUSY / INDEX_NOT_READY, response shape), **not against the real model and index over HTTP**.
- Threshold calibration: `app.cli eval` (synthetic photos, "card removed from catalogue" false-match test, threshold sweep) exists but **was never run on the real index**. Constants are provisional: `EMBED_COS_FLOOR 0.30`, `HASH_SIM_FLOOR 0.60` (picked before the OpenCV hash rewrite), 0.80 / 0.10 / 0.50. On the 30-card index wrong cards scored ≈ 0.1–0.4 vs 0.68–1.0 for the right one, but that says nothing about same-artwork reprints in a 19k index.
- Symbol signal (stub); OCR-only candidates for imageless cards; index hot-reload (restart after a rebuild); JA OCR validation on real photos; int8 model evaluation.

## Open issues
- UI child: see `.agent/reports/sonnet-recog-service-requests.md` (downscale to ≤ 1600 px JPEG, HEIC client-side, never auto-add, handle 429/503, variant hints are weak).
- Terra: set `FLASHYDEX_RECOG_TOKEN` and `FLASHYDEX_RECOG_ALLOWED_ORIGINS` before the tunnel (the tunnel connects from 127.0.0.1); daemonize `serve.sh`; keep `data/` on a persistent disk.
- Owner: send 10–20 real phone photos with known card ids (`{language}__{cardId}__{n}.jpg`): modern EN holo / non-holo / reverse holo / full-art, 3–4 WOTC or e-series (one 1st Edition), 3–5 JA modern, 2 JA promos, top-loader and penny sleeve, strong glare, ~30° tilt, held in hand, dim light, and 2 same-artwork reprints from different sets (the hard case).
- The machine is CPU-contended by other agents; build time depends heavily on that.

## Commands
- Finish index: `bash scripts/recognition/index-build.sh --lang en`, then `--lang ja`.
- Serve: `FLASHYDEX_RECOG_TOKEN=<secret> FLASHYDEX_RECOG_ALLOWED_ORIGINS=<origins> bash scripts/recognition/serve.sh` (127.0.0.1:8900).
- Verify: `curl -H "Authorization: Bearer <secret>" http://127.0.0.1:8900/v1/health`; `curl -H "Authorization: Bearer <secret>" -F image=@card.jpg -F lang=en http://127.0.0.1:8900/v1/identify`.
- Calibrate: `cd services/recognition && ./.venv/Scripts/python.exe -m app.cli eval --lang en --n 200`.
