# Recognition design (Phase 2 plan — document only, no code in Phase 1)

Owner: Opus (recognition architect). Implementer: Sonnet in Phase 2. Status: decision-complete plan; every "TBD" below is an explicit measurement the implementer performs in task P2-0 and records in this file, not an open design question.
Inputs: SPEC "Reference architecture", BRIEF fixed stack, ARCHITECTURE.md "Recognition seam", DATA-MODEL.md enums, the MIT-licensed Pokeum reference at `.agent/reference/pokeum/` (v1.7.1), and live checks run on 2026-10-30 (listed in §12).

## 0. Summary of decisions

| # | Decision |
|---|---|
| D1 | Port Pokeum's retrieval pipeline (detect → rectify 630×880 → hashes + DINOv2 embeddings + OCR + set symbol → weighted fusion → variant checks on the winner) into `services/recognition`, adapted to Python 3.12, composite `(language, cardId)` identities and our API contract. Cite and keep the MIT notice. |
| D2 | **Embedder: Pokeum's fine-tuned `dinov2s-ft-v1.onnx` is NOT downloadable** (GitHub releases list is empty; the README URL returns 404 on 2026-10-30). Default model = `onnx-community/dinov2-small` `onnx/model.onnx` (88,532,934 bytes, Apache-2.0), using the CLS/pooled 384-d output. The fine-tuned model becomes a drop-in upgrade if it is ever published, or we fine-tune with Pokeum's `training/` harness only if the eval gate (§9) fails. |
| D3 | The recognition service **does not sync TCGdex itself.** The web app's catalog is the single source; `npm run recognition:manifest` writes a JSONL manifest that the Python index builder consumes. Python never opens `pokescan.sqlite`. |
| D4 | Index artifacts live in `data/recognition/` at the repo root (gitignored, next to `data/pokescan.sqlite`), configurable by `RECOGNITION_DATA_DIR`. |
| D5 | Index scope = physical cards with a TCGdex image: ≈ 19.7k EN + 3.9k JA ≈ **23.6k images today** (not 40k — JA image coverage is ~30 %). TCG Pocket (`tcgp` series) excluded. Cards without images stay in the metadata table so OCR can still surface them (as capped "OCR-only" candidates). |
| D6 | API: Next `POST /api/recognition` (browser) → server-side `POST /v1/recognize` on FastAPI `127.0.0.1:8100`. Response = ≤ 3 ranked candidates with per-signal scores, confidence, status, OCR read, variant hints. Next enriches ids with catalog metadata. Nothing is ever persisted by recognition. |
| D7 | Decision thresholds are **calibrated on our own held-out real-photo set** to ≥ 99 % precision for `confident`; Pokeum's constants are only starting values. |
| D8 | CPU-only latency target per still image (server time): **p50 ≤ 600 ms, p95 ≤ 1,200 ms** on a 6–8-core desktop CPU from 2019 or newer. |
| D9 | Phase 2 UI = "Identify from photo" on `/add` using `<input type="file" accept="image/*" capture="environment">` — works over plain-HTTP LAN (no secure context needed). The live camera (needs HTTPS) is Phase 3. |
| D10 | Temporal aggregation (multi-frame voting) for Phase 3 is ported to TypeScript in the web client (pure logic); the Python service stays stateless per request. |

## 1. Pipeline (per request)

```
image bytes (JPEG/PNG/WebP ≤ 10 MiB) + languages[] (+ guideMargin?, requireDetection?)
 → decode, EXIF-orient, cap long side 2000 px                     (vision/imaging)
 → detect card quad on a 960 px copy (bilateral, auto-Canny,
   largest plausible convex 4-gon, hull re-approx fallback)        (vision/detect, geometry)
 → rectify to 630×880; else guide-crop (if guideMargin) else
   centre-crop to 63:88                                            (vision/rectify)
 → parallel:
     dense:  perceptual hashes (5 × 256-bit) → Hamming top-50       (signals/hashes)
             DINOv2 full-card + artwork crop, ONE batched ORT run
             → cosine top-50 each                                   (signals/embedding)
     OCR:    bottom strip 630×88 → RapidOCR → number/total/set code (signals/ocr)
 → resolve shortlist ids → metadata (one IN query)                  (index/store)
 → validate OCR set code against catalogue codes
 → symbol signal (ZNCC vs set templates) only if no valid set code   (signals/symbol)
 → OCR-only injection (§4.3) + language factor (§4.4)
 → fuse → status + ranked candidates (top 3)                        (recognize/fusion)
 → variant checks on candidate #1 only                              (variants/*)
 → response (§6)
```

## 2. Service layout (`services/recognition`, Python 3.12)

```
services/recognition/
  pyproject.toml            # requires-python ">=3.12,<3.13"; ruff target py312
  requirements.txt          # pinned (§8)
  app/
    main.py                 # FastAPI app factory; lifespan builds Recognizer once
    api/routes.py           # GET /health, POST /v1/recognize, GET /v1/index/status
    api/schemas.py          # pydantic models = §6 contract
    core/config.py          # env: RECOGNITION_DATA_DIR, RECOGNITION_HOST/PORT, EMBED_MODEL_PATH, ORT threads, LOG_LEVEL
    core/constants.py       # all tuning knobs (adapted from pokeum app/core/constants.py)
    models.py               # dataclasses: CardKey(language, card_id), CardRef, SignalScore, OcrObservation, VariantGuess, Candidate, RecognitionResult
    vision/{imaging,geometry,detect,rectify,regions}.py
    signals/{base,hashes,embedding,ocr,symbol}.py
    recognize/{pipeline,fusion,factory,eval}.py
    variants/{assess,features,reverse_holo,stamps,wotc}.py
    index/{manifest,images,store,build}.py
    cli.py                  # python -m app.cli index build|status, identify <img>, eval <dir>
  tests/                    # pytest, offline, synthetic images, fakes for ORT/OCR
```
Phase 1 already has `app/main.py` + `/health` (ARCHITECTURE); Phase 2 extends it.

## 3. What we adapt from Pokeum, file by file

Legend: **Port** = copy with edits, keep MIT header comment `Adapted from pokeum (MIT) <path>`; **Rewrite** = reimplement from the idea; **Skip**.

| Pokeum file | Action | What changes for us |
|---|---|---|
| `app/vision/imaging.py` | Port | Add EXIF orientation (`PIL.ImageOps.exif_transpose`) before converting — phone photos are often rotated by tag only. Keep RGB uint8 interchange and `cap_long_side`. |
| `app/vision/geometry.py` | Port as-is | Pure NumPy; bring its tests (`tests/test_geometry.py`). |
| `app/vision/detect.py` | Port | Keep auto-Canny + hull epsilons (`0.02, 0.04, 0.08`) and `DETECT_MAX_SIDE=960`. Add: try a second pass on the saturation channel when grayscale finds nothing (yellow-bordered cards on light tables have low gray contrast). Keep debug-dump env (`SCAN_DEBUG_DIR`). |
| `app/vision/rectify.py` | Port | Unchanged geometry (630×880, guide-margin crop, centre-crop fallback). Guided fallback demotes `uncertain`→`no_match` exactly as Pokeum does. |
| `app/vision/regions.py` + region boxes in `constants.py` | Port | Keep boxes (artwork `0.06,0.10,0.94,0.56`; bottom strip `0,0.90,1,1`; symbol zones modern/WOTC; variant boxes). The full-width bottom strip covers both bottom-left and bottom-right number placements; verify JA layouts on the real eval photos in P2-5. |
| `app/signals/base.py` | Port as-is | Protocols for Embedder/OcrEngine. |
| `app/signals/hashes.py` | Port | Same 5 kinds × 256 bits, packed-byte XOR + `np.bitwise_count` (requires NumPy ≥ 2.0 — satisfied). Index keyed by row number, not card id string. |
| `app/signals/embedding.py` | Port with a fix | **`OnnxEmbedder._run` must select the pooled/CLS output**: transformers-style exports such as `onnx-community/dinov2-small` are expected to expose `last_hidden_state (N,257,384)` and `pooler_output (N,384)` (verify names in P2-0); Pokeum's `reshape(N,-1)` on the first output would flatten 98,688 dims. Rule: if an output named `pooler_output` exists use it; else if output rank is 3 take `[:,0,:]` (CLS); else use rank-2 output. Probe at load and assert `dim == 384`. Set `SessionOptions.intra_op_num_threads` from config (default = physical cores − 2, min 1). Keep `HistogramEmbedder` **only for tests**. If the ONNX model is missing or fails to load, the service reports `index.ready=false` and `/v1/recognize` returns 503 `MODEL_MISSING` — never a silent low-accuracy scanner (agrees with `.agent/research/pokeum-notes.md`). |
| `app/signals/ocr.py` | Port | Keep `parse_collector_number`, `parse_set_code`, `interpret_lines` and their tests. Changes: (a) also accept promo forms where the "total" is a promo code, e.g. `001/SV-P` → number=1, total=None, setCode=`SV-P` (regex `(\d{1,3})\s*/\s*([A-Z]{1,4}-?P)`; confirm against real JA promo photos); (b) add stopwords `JP`, `JA`; (c) `RapidOcrEngine` params unchanged (`Det.limit_side_len=320`, no cls, 2 intra-op threads, lock). |
| `app/signals/symbol.py` | Port | Templates keyed by `(language, setId)`. **URL fix:** TCGdex returns `https://assets.tcgdex.net/univ/{serie}/{setId}/symbol`, and appending an extension to that `univ` URL returns 404. Rewrite `univ`→`en` and append `.webp` (verified in `.agent/research/tcgdex-api.md`: `…/en/swsh/swsh3/symbol.webp` 200). Coverage: EN 169/220 sets; JA only `neo1`–`neo4`, so for JA the symbol signal rarely applies. Only consulted when there is no validated set code (as in Pokeum). |
| `app/recognize/fusion.py` | Port + extend | Keep renormalised weighted mean over present signals, OCR multiplicative boost/penalty, `_decide` (threshold + margin). Add: language factor (§4.4), OCR-only injection (§4.3), `top_k=3` cap, and `ocr_only` candidates can never make status `confident`. |
| `app/recognize/pipeline.py` | Port | Same orchestration incl. executor overlap of OCR with dense signals, `_validate_set_code`, debug timing lines. Changes: ids are `CardKey(language, card_id)`; accept `languages` filter; return `detection` info; variant mapping to our enum (§5). |
| `app/recognize/factory.py` | Rewrite | Build from `RECOGNITION_DATA_DIR` artifacts; fail health (not crash) if index missing. |
| `app/recognize/temporal.py` | Port to **TypeScript** in Phase 3 (`apps/web/src/features/scanner/temporal.ts`) | Same window 6 / votes 4 / EMA 0.4 / reset after 8 empty frames; keep Pokeum's tests as TS tests. |
| `app/recognize/eval.py` | Port | Filenames become `{language}__{cardId}__{n}.jpg`; report adds top-3, confident precision/coverage, latency percentiles, per-language and per-era splits. |
| `app/recognize/webcam.py` | Skip | Desktop OpenCV capture loop; our camera is the browser. |
| `app/variants/*.py` | Port | Self-gating rules unchanged (era / catalogue flags). Map kinds to our enum (§5). Confidence still capped at 0.85 for a single still. |
| `app/reference/index.py` | Rewrite as `index/build.py` | Same incremental, atomic `.npy` writes + embedder-identifier invalidation; but **batched** embedding (batch 32; Pokeum embeds one image at a time at build), row ids are `language:cardId`, input from our manifest. |
| `app/reference/store.py` | Rewrite as `index/store.py` | Our own small `index.sqlite` (schema §7.2), composite keys, `number_key` normalisation and `_portable_path` lesson (store **relative** paths only). |
| `app/reference/sync.py`, `tcgdex.py`, `images.py` | Skip sync; port image download idea into `index/images.py` | The web app owns TCGdex sync (ARCHITECTURE). We only download `low.webp` images and symbols listed in the manifest. Pokeum's note that "`low.png` is 600×825" is stale (research re-measured: quality now selects pixel size for every extension). We still use `low.webp` because it is the smallest. |
| `app/api/schemas.py`, `routes.py`, `static.py`, `server.py` | Rewrite | Our contract (§6); no static frontend serving; no `/scans` S3 upload (`app/collect/*` skipped — no telemetry leaves the PC). |
| `training/*`, `scripts/export_embedder.py` | Keep as reference | Used only for the optional M2 fine-tune (§4.1). `scripts/make_synthetic_eval.py` is ported to build the synthetic eval set. |

## 4. Signals, fusion and decision

### 4.1 Embedding model ladder
- **M0 (default, Phase 2):** `onnx-community/dinov2-small` `onnx/model.onnx`, fp32, 224×224 input, ImageNet mean/std, 384-d CLS/pooled output, L2-normalised. Pin the Hugging Face commit SHA and the file SHA-256 in `constants.py`; `cli.py model fetch` downloads to `data/recognition/models/dinov2s.onnx` and verifies the hash. Identifier `onnx:dinov2s:<sha256[:12]>`.
- **M1:** Pokeum `dinov2s-ft-v1.onnx` (Apache-2.0) if TBLgGamin publishes it. Drop-in; identifier change forces full re-embed.
- **M2:** our fine-tune via Pokeum `training/` (rented GPU, ~hours, never a runtime dependency) — only if the §9 gate fails on M0 because of glare/angle robustness. Same export contract (single input, 384-d).
- Quantised `model_int8.onnx` exists on the same repo: evaluate in P2-0 for latency; adopt only if top-1 drops ≤ 1 pt on the eval set.

### 4.2 Weights and constants (starting values = Pokeum's, then calibrated)
`WEIGHT_EMBED_FULL 0.40`, `WEIGHT_EMBED_ART 0.30`, `WEIGHT_HASH 0.20`, `WEIGHT_SYMBOL 0.10`; `OCR_BOOST 0.5`, `OCR_PENALTY 0.4`; `RETRIEVAL_SHORTLIST 50`; `CONFIDENT_THRESHOLD 0.80`, `CONFIDENT_MARGIN 0.10`, `UNCERTAIN_THRESHOLD 0.50`; `TOP_K 3`.
Calibration (P2-5): grid-search weights in steps of 0.05 and thresholds in steps of 0.01 on the **tuning split** of the real-photo set to maximise confident coverage subject to confident precision ≥ 99 %; freeze; report on the **held-out split** only. Record final values + date + eval report path in `constants.py` comments.

### 4.3 OCR-only injection (cards without a reference image)
Problem: ~8.9k JA and ~1.7k EN catalogue cards have no TCGdex image, so dense signals can never surface them.
Rule: after fusion's candidate set is built, if the OCR read has a number **and** (total or validated set code) and the catalogue (all languages in the request) has 1–3 cards matching it that are **not indexed**, add them with raw score `OCR_ONLY_BASE (0.45) × ocr.confidence` and `ocrOnly: true`. They are ranked with everyone else but the status can be at most `uncertain` when an `ocrOnly` candidate is #1. The UI shows them with the "No catalog image" placeholder so the owner judges by name/number.

### 4.4 Language handling
- Request `languages` ∈ `["en"]`, `["ja"]`, `["en","ja"]` (default both; UI "Auto").
- Candidates outside the requested languages are dropped before fusion.
- With both languages: same artwork exists in EN and JA printings; dense signals tie. Tie-breakers in order: OCR set code (validated per language), OCR total (EN and JA totals differ for the same set), symbol, then a soft prior `LANG_PRIOR` = 1.05 for the language the owner added most recently (sent by Next as `languagePrior`). If still tied, both appear as candidates → status `uncertain` (the margin rule guarantees this).

### 4.5 Status semantics (aligns with ARCHITECTURE stub)
`confident` — top ≥ threshold and margin ≥ margin, not OCR-only → UI preselects it but still requires a tap to add.
`uncertain` — top ≥ 0.50 → UI shows up to 3 candidates, **nothing preselected**.
`no_match` — otherwise (candidates may still be returned for "did you mean", max 3).
`no_card_detected` — only when `requireDetection=true` and no quad (Phase 3 live frames).

## 5. Variant hints → our enum

| Pokeum `VariantKind` | Our `variant` (DATA-MODEL) | Gate |
|---|---|---|
| `reverse_holo` | `reverse_holo` | catalogue lists reverse |
| `first_edition` | `first_edition` (variantDetail left empty; UI asks normal/holo when both exist) | WOTC era + catalogue lists firstEdition |
| `shadowless` | `shadowless` | WOTC era (base1 only in practice) |
| `promo_stamp` | `promo_stamped` | ungated in Pokeum → **we gate it on catalogue `wPromo` flag** to stop false positives on busy art |

`candidate.variant` = the hint with `present=true` and `confidence ≥ VARIANT_PRESELECT_MIN (0.6)`, else `null`; the UI then uses the UX.md §7.3 default rule. Hints never auto-commit; the variant chip row is always shown for confirmation. Holo vs non-holo is not detected (catalogue flags + owner).

## 6. API contract

### 6.1 Next ↔ FastAPI (internal, server-to-server)
`POST http://127.0.0.1:8100/v1/recognize` — `multipart/form-data`:

| Part | Type | Notes |
|---|---|---|
| `image` | file | JPEG/PNG/WebP, ≤ 10 MiB (Next enforces first; FastAPI re-checks, 413) |
| `languages` | string | comma list, subset of `en,ja`; default `en,ja` |
| `languagePrior` | string? | `en`/`ja` |
| `guideMargin` | float? | 0–0.5; Phase 3 guided capture |
| `requireDetection` | bool? | default false (stills), true for live frames |
| `requestId` | uuid | generated by Next, echoed back, logged |

Header `X-Recognition-Token: <RECOGNITION_TOKEN>` when configured (service binds 127.0.0.1 by default; token is defence in depth).

Response 200 (pydantic, camelCase aliases):
```jsonc
{
  "requestId": "uuid",
  "status": "confident" | "uncertain" | "no_match" | "no_card_detected",
  "candidates": [                         // 0..3, best first
    {
      "catalogCardId": "swsh3-136",
      "language": "en",
      "confidence": 0.93,                 // 0..1 fused, normalised
      "variant": "reverse_holo" | null,   // preselect hint per §5
      "ocrOnly": false,
      "signals": {                        // raw per-signal scores in [0,1]; null = signal not run
        "embFull": 0.91, "embArt": 0.89, "hash": 0.78, "symbol": null,
        "ocrFactor": 1.42,                // multiplier applied (1 = neutral)
        "langFactor": 1.0
      },
      "variantHints": [ { "variant": "reverse_holo", "present": true, "confidence": 0.71 } ]  // only on candidates[0]
    }
  ],
  "ocr": { "number": "136", "numberTotal": 189, "setCode": null, "confidence": 0.88 } | null,
  "detection": { "quadFound": true, "fallback": "none" | "guide" | "centre" },
  "index": { "version": "2026-10-30T18:00:00Z", "cards": 23569, "embedder": "onnx:dinov2s:ab12cd34ef56" },
  "durationMs": 412
}
```
Errors: 400 `INVALID_IMAGE` (undecodable), 413 `IMAGE_TOO_LARGE`, 503 `INDEX_NOT_READY` (no index built), 503 `MODEL_MISSING` (ONNX model absent or failed to load), 503 `BUSY` (more than `MAX_CONCURRENT=2` in flight; `Retry-After: 1`), 500 `RECOGNITION_FAILED`. Shape `{ "error": { "code", "message" } }` (same envelope as Next API).

`GET /health` → `{status:'ok', service:'recognition', version, index:{ready, cards, embedder, builtAt}, ocr:boolean}`.
`GET /v1/index/status` → build progress when a CLI build is running (reads `data/recognition/index/build-status.json`).

### 6.2 Browser ↔ Next
`POST /api/recognition` (multipart `image`, `languages`, `scanSessionId?`) → Next validates (size/type, same-origin), forwards, then **enriches** each candidate from the catalog (name, setName, localId, officialCount, rarity, imageUrl, availableVariants) and returns the ARCHITECTURE stub shape plus these optional fields: `signals`, `ocrOnly`, `variantHints`, `ocr`, `card` (enriched). **Request to Sol:** extend `packages/schemas/src/recognition.ts` with these optional fields (the stub stays valid). Timeouts: Next aborts at 8 s → 504 `RECOGNITION_TIMEOUT`; FastAPI unreachable → 503 `RECOGNITION_OFFLINE`. Next never persists anything; adding goes through the normal owned-card bulk endpoint after the owner confirms.

## 7. Index build

### 7.1 Manifest (contract between web and Python)
`npm run recognition:manifest` (web workspace script; reads catalog via repositories) writes `data/recognition/manifest.jsonl`, one line per catalog card (all, including imageless), sorted by `language, setId, localIdSort`:
```json
{"language":"en","cardId":"swsh3-136","setId":"swsh3","setName":"Darkness Ablaze","series":"swsh","setCode":"DAA","localId":"136","officialCount":189,"releaseDate":"2020-08-14","rarity":"Uncommon","variants":["normal","reverse_holo"],"imageBase":"https://assets.tcgdex.net/en/swsh/swsh3/136","symbolBase":"https://assets.tcgdex.net/univ/swsh/swsh3/symbol"}
```
`setCode` = TCGdex `abbreviation.official` (null if absent). `variants` = DATA-MODEL `availableVariantsJson`. Header line `{"manifestVersion":1,"generatedAt":"…","catalogSyncId":"…"}`.
**Request to Sol/Terra:** add this script (or approve that the Python side reads `catalog_cards.raw_json` directly — not preferred).

### 7.2 Build (`python -m app.cli index build [--full] [--lang en,ja]`)
1. Read manifest; skip `series == "tcgp"`; split into `indexable` (has `imageBase`) and `metadataOnly`.
2. Download `imageBase + "/low.webp"` (245×337; measured 15.8 KB for `swsh3-136` and 19.8 KB for a JA SV card) to `data/recognition/images/{language}/{setId}/{cardId}.webp`. Concurrency 8, 20 s timeout, 3 retries with backoff. Skip existing files with non-zero size and record failures. Download set symbols from the rewritten URL (`univ`→`en`, + `.webp`, §3) to `symbols/{language}/{setId}.webp`.
3. For each image (worker pool for decode/hash; main thread for ORT batches): centre-crop to card aspect → 5 hashes → full-card + artwork-crop embeddings in **batches of 32**.
4. Write atomically (temp + `os.replace`): `index/index.sqlite` (tables `cards(row INTEGER PK, language, card_id, set_id, set_code, local_id, number_key, number_total, era, release_year, has_normal, has_holo, has_reverse, has_first_edition, has_wpromo, indexed BOOLEAN, image_path TEXT relative)`, `hashes(row, kind, bits BLOB)`, `meta(key, value)`), `index/emb_full.npy`, `index/emb_art.npy` (float32 `N×384`, row-aligned with `cards.row` where `indexed=1`), `index/build-status.json`.
5. Incremental: only new/changed `(language, cardId, imageBase)`; embedder identifier change → full re-embed; `--full` recomputes all.
6. Service reloads the index on `POST /v1/index/reload` (Next calls after a CLI build) or restart; reload is atomic (swap references).

### 7.3 Size and time estimates (measure in P2-0 and replace)

| Item | Today (≈23.6k indexable, 36.5k rows) | If JA images reach full coverage (≈40k indexable) |
|---|---|---|
| Reference images (`low.webp`, ~15–25 KB measured; Pokeum claimed ~60 KB) | ≈ 0.4–0.6 GB (budget 1.5 GB worst case) | ≈ 0.6–1.0 GB (budget 2.6 GB) |
| Embeddings 2 × N × 384 × 4 B | 72 MB | 123 MB |
| Hashes 5 × 32 B × N | 3.8 MB | 6.4 MB |
| `index.sqlite` metadata | ~10 MB | ~15 MB |
| Model | 88.5 MB | 88.5 MB |
| Runtime RAM (matrices + ORT + OCR) | ~450–600 MB | ~550–700 MB |
| First build: download | 25–60 min at concurrency 8 (CDN latency-bound) | 45–100 min |
| First build: embed (2 forward passes/card, batched, ~15–25 ms/img on 8 cores) | 12–20 min | 20–35 min |
| Incremental new set (~200 cards) | < 1 min | < 1 min |

`images/` is only needed to rebuild; it can be deleted after a build to save space (a later model change will re-download).

## 8. Python 3.12 compatibility

- Pokeum declares `requires-python >=3.13` and ruff `target-version py313`, but a grep of `app/` found **no 3.13-only syntax or stdlib APIs** (no PEP 695 `type` statements, `copy.replace`, `warnings.deprecated`, `TypeIs`). Features used — `StrEnum` (3.11), `dataclass(slots=True)` (3.10), `zip(strict=)` (3.10), `X | None` (3.10) — all exist on 3.12. Set our ruff target to `py312`.
- `np.bitwise_count` needs NumPy ≥ 2.0 → pin numpy 2.2.6.
- PyPI wheels checked 2026-10-30 for `cp312 win_amd64`: numpy 2.2.6 ✓, onnxruntime 1.26.0 ✓ (requires ≥ 3.11), Pillow 12.3.0 ✓, opencv 4.12.0.88 ✓ (abi3), rapidocr 3.9.1 ✓ (pure Python), ImageHash 4.3.2 ✓ (pure; pulls scipy + PyWavelets — confirm cp312 wheels at install).
- **OpenCV conflict:** `rapidocr` depends on full `opencv_python`; Pokeum also pins `opencv-python-headless` → two distributions both install `cv2` (last one wins, upgrades break). Decision: pin **only `opencv-python==4.12.0.88`**, no headless. On slim Linux add `libgl1`.
- RapidOCR 3.x may download its PP-OCR ONNX models on first use (confirm in P2-0); `cli.py model fetch` must pre-download them into `data/recognition/models/ocr/` and configure RapidOCR to load from there (offline after setup).
- Requirements file pinned exactly; `pip-audit` in CI (as Pokeum).

## 9. Test strategy and Phase 2 exit gate

Unit (pytest, offline, no models): geometry, rectify on synthetic quads, hashes on synthetic images, OCR parsers (Pokeum's cases + JA forms `001/073`, `001/SV-P`), fusion (renormalisation, OCR boost/penalty, language filter, OCR-only cap, top-3 cap, margin rule), variant mapping/gates, manifest parsing, API contract (fake Recognizer), index incremental logic (fake embedder).
Contract: shared JSON fixtures in `packages/schemas` validated by both zod (vitest) and pydantic (pytest).

Accuracy:
- **Real held-out photo set** (owner shoots with his phone; stored in `data/recognition/eval/real/`, gitignored — card images are copyrighted): ≥ 300 photos of ≥ 250 distinct cards: 180 EN modern (SWSH/SV), 50 EN WOTC/e-card, 50 JA modern, 20 hard cases (top-loader, penny sleeve, strong glare, 30° tilt, held in hand). Filenames `{language}__{cardId}__{n}.jpg` (variant truth optional `__rev`). Split 40 % tuning / 60 % held-out, by card (no card in both).
- **Synthetic set**: Pokeum `scripts/make_synthetic_eval.py` adapted (perspective, glare, blur, JPEG) over 2,000 random indexed cards — regression guard in CI-like local runs.
- Metrics (eval report JSON + markdown in `data/recognition/eval/reports/`): top-1, top-3 recall, confident precision, confident coverage, uncertain rate, no-match rate, mean margin, per-language/per-era splits, reverse-holo hint accuracy on the subset that has truth, latency p50/p95.
- **Gate (held-out real set):** top-3 recall ≥ 95 %; top-1 ≥ 88 %; confident precision ≥ 99 %; confident coverage ≥ 60 %; latency targets D8. JA reported separately (expected lower because of image coverage) with gate top-3 ≥ 80 % on JA cards that have images.

Performance: `cli.py bench` runs 50 eval images ×3 and prints per-stage timings (Pokeum's DEBUG timing line).

## 10. Phase 2 task breakdown (for the implementer)

P2-0 Spike: fetch M0 model + RapidOCR models, verify output names/shape (384), benchmark ORT fp32 vs int8 on this PC, time 500 image downloads → fill §7.3 actuals.
P2-1 Port vision + signals + tests. P2-2 Manifest script (web) + index build + store. P2-3 Pipeline + fusion extensions + variants. P2-4 FastAPI routes + Next `/api/recognition` proxy + schemas. P2-5 Eval harness, collect real photos (owner), calibrate, write report. P2-6 UI: "Identify from photo" on `/add` → result sheet (UX.md §11.2 component) → existing confirm/add.

## 11. Risks and mitigations

| Risk | Impact | Mitigation |
|---|---|---|
| Fine-tuned Pokeum model unavailable (release 404) | Lower robustness to glare/angle with stock DINOv2 | Hash + OCR + art-crop fusion; calibrate thresholds; M2 fine-tune path ready (Pokeum `training/`); uncertain → 3 candidates never auto-picks |
| JA image coverage ~30 % (3,882 of 12,781 card entries), vintage JA prints no collector numbers | Many JA cards unrecognisable by image | OCR-only candidates; language filter; manual search always available; report JA metrics separately; re-run index after catalog syncs (TCGdex fills images over time) |
| Same artwork across reprints/languages | Wrong printing at high visual similarity | OCR number/total + set code + symbol; margin rule forces `uncertain` on ties |
| Reverse-holo detection from one still is weak | Wrong variant | Hint only, capped 0.85, preselect only ≥ 0.6, chip row always shown |
| Sleeves/top-loaders: reflections, extra rectangle edges | Detection picks the toploader outline (aspect ≈ 0.70 still plausible) → slightly loose crop | Hash/embedding tolerate small borders; add inner-quad search if eval shows it; guide-margin capture in Phase 3 |
| OpenCV double install | `cv2` import breaks after upgrades | Single `opencv-python` pin |
| RapidOCR model download on first use | Offline failure | Pre-fetch in `model fetch`, local paths |
| Windows-built paths on Linux (Pokeum v1.7.1 bug) | Symbol templates silently lost | Store only relative POSIX paths in `index.sqlite` |
| TCGdex CDN throttling during first build | Slow / failed downloads | Concurrency 8, retries, resumable (skips existing files) |
| Camera needs HTTPS on LAN | Live scan blocked on phone over `http://ip:3200` | Phase 2 uses file input (works on HTTP); Phase 3 needs local TLS (mkcert/Caddy) — flagged to Terra/Sol |
| CPU contention when sync + recognition run together | Latency spikes | `MAX_CONCURRENT=2`, 503 BUSY with Retry-After; ORT thread caps |
| Licences | Compliance | MIT notice for Pokeum-derived files in `THIRD_PARTY_NOTICES.md`; DINOv2 + onnx-community export Apache-2.0; RapidOCR/PP-OCR Apache-2.0; card images not redistributed (downloaded locally, gitignored) |

## 12. Facts checked live on 2026-10-30 (so the implementer doesn't re-litigate)

- `https://github.com/TBLgGamin/pokeum/releases/latest/download/dinov2s-ft-v1.onnx` → HTTP 404; GitHub API `/repos/TBLgGamin/pokeum/releases` → `[]`.
- `https://huggingface.co/onnx-community/dinov2-small/resolve/main/onnx/model.onnx` → 200, 88,532,934 bytes; repo also offers fp16/int8/q4 variants; base model `facebook/dinov2-small` licence apache-2.0.
- Image coverage from all 404 TCGdex set-detail responses: EN 23,736 card entries / 21,987 with `image`; JA 12,781 entries / 3,882 with `image` (JA set listings sum `cardCount.total` = 18,031, i.e. many JA cards aren't even enumerated). TCG Pocket (`tcgp`): 15 EN sets, 2,480 entries, 2,321 with images.
- EN and JA ids differ in format for the same physical set (`neo1-1` EN vs `neo1-001` JA; `ja/cards/neo1-1` → 404), confirming composite `(language, id)` keys.
- Card image base for Furret: `https://assets.tcgdex.net/en/swsh/swsh3/136`; set symbol `https://assets.tcgdex.net/univ/swsh/swsh3/symbol`; `abbreviation.official` `DAA`.
