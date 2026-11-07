# sonnet-recog-service — finish the recognition service for the scanner MVP

You are Claude Sonnet. Unattended run: never ask questions; write the report draft FIRST; no screenshots or image viewing (kills the session — analyse images with PIL/numpy in code, never display them). Repo `C:/Projects/flashydex` (start every shell with `cd C:/Projects/flashydex`). No `git commit/push`. Python: `services/recognition/.venv/Scripts/python.exe` (3.12); tests: `bash scripts/test-recognition.sh`; lint: `.venv/Scripts/ruff check app tests`.

## Binding
`.agent/m2-contract.md` ("Service changes" + error table + ownership). Also read `docs/RECOGNITION-DESIGN.md`, `services/recognition/README.md`, `app/recognize/fusion.py`, `app/recognize/pipeline.py`, `app/api/**`, `app/eval.py`, `.agent/reports/sonnet-recog-service-report.md`, `.agent/reports/sonnet-recognition-report.md`, `data/logs/e2e-timings.json`.

## Known defect (director-verified)
`POST /v1/identify` with the exact reference image `data/cache/images/en/swsh3-136.webp` returns `status: candidates, confidence 0.7987` with signals `hash 1.0, embed 1.0, ocr 0.0`. A perfect hash+embed hit must be `match`. Root cause to confirm: OCR that read nothing is scored 0.0 and fused as a penalty instead of being neutral.

## Do
1. **Calibration** (`fusion.py`): OCR contributes only when digits were actually read (neutral otherwise); re-derive the fused score so reference images are `match` with margin. Build the eval set with `app/eval.py` (extend it): for 300 random EN + 100 JA indexed cards, run identify on (a) the reference `low.webp`, (b) rotated 90°/180°/270°, (c) ±7° skew + perspective warp, (d) Gaussian blur σ=1.5, (e) synthetic glare (white ellipse α=0.5), (f) JPEG q=40 re-encode, (g) a 1600-px photo-like composite (card on a textured background with slight tilt — that is what the client uploads). Report top-1 accuracy and `match`/`candidates`/`no_match` rates per transform, and false-`match` rate (wrong card returned as `match`) which must be < 1 %. Re-tune `match`/`margin`/`candidates` thresholds from that data; keep "never return a wrong card as match" over recall. Record idle-CPU latency p50/p95 per phase for the 1600-px composites (the realistic input).
2. **Health** per contract: `ready` only after both indexes loaded + warm-up embed; `counts`, `catalogVersion`, `indexVersion`, `uptimeSec`, `warm`, `lastIdentifyMs`.
3. **Per-IP limits via `X-FDX-Client-IP`** trusted only on bearer-authenticated requests (tests: unauthenticated request with that header → ignored/rejected per existing proxy-header rule; authenticated → limit keyed by it).
4. **Index ⊆ catalog**: write `app/cli.py index verify --catalog-db <path>`: open `tools/catalog-builder/dist-prod/catalog-en-2026.10.31.003.db` and `...ja...db` (plain SQLite files already on disk) and check every indexed id exists; print counts, orphans, and cards-with-image not indexed. Report the numbers.
5. **Ephemeral processing test**: a test that snapshots `data/` mtimes/listing, runs identify, asserts nothing new was written (logs excluded) and that log lines contain no filenames/bytes.
6. **HEIC**: try `pip install pillow-heif` into the venv; if it imports and decodes a sample (generate one with `pillow_heif` itself), accept HEIC in `app/vision/imaging.py` (magic `ftyp` + brand heic/heix/mif1/msf1) and pin it in `requirements.txt`; otherwise leave 415 and report why.
7. **Error bodies**: all service errors use `{ error: { code, message, retryable } }` with the contract codes (`RECOGNIZER_BUSY`, `RATE_LIMITED`, `PAYLOAD_TOO_LARGE`, `UNSUPPORTED_IMAGE`, `UNAUTHORIZED`), keeping existing HTTP statuses. Update `packages/schemas/src/recognition.ts` additively (error type) and the README.
8. **Restart the live service** after your changes via `bash scripts/recognition/serve.sh` (it currently runs from a director shell on PID in `data/logs/serve-director.log`; stop that one with `taskkill /PID <pid> /F` only after your tests pass, then start yours on 8900 and confirm `/v1/health` `ready:true`). Leave it running. Terra is concurrently installing a scheduled task for it — if `/v1/health` shows a newer `uptimeSec`/version than yours after you restart, don't fight it; report.

## Gates
`bash scripts/test-recognition.sh` all pass; ruff clean; `curl -F image=@data/cache/images/en/swsh3-136.webp -F lang=en http://127.0.0.1:8900/v1/identify` → `status: match`; eval report file `services/recognition/data/logs/eval-m2.json` + a markdown summary table in your report.

## Report
`.agent/reports/sonnet-recog-service-report-m2.md` (draft FIRST): what changed (file:line), eval table, thresholds before/after, latency table, index-verify numbers, HEIC outcome, health sample, open risks (e.g. real iPhone photos unverified). Touch `.agent/m2-ready-service` when the live service on 8900 is restarted with your changes and `ready:true`.
