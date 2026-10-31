# Pokeum notes (reference only)

Source: `.agent/reference/pokeum/` (TBLgGamin/pokeum). Local `pyproject.toml` says version 1.7.1, MIT, `requires-python >= 3.13`. README and `LICENSE` agree on MIT, copyright 2026 TBLgGamin. This is a recognizer with a thin catalog, not a collection manager. Read it for the TCGdex sync and, later, the recognition pipeline. Do not copy it into Phase 1 as the app.

Public GitHub, checked 2026-10-30: `GET /repos/TBLgGamin/pokeum/releases` returned `[]`, `/releases/latest` returned 404, tags returned only `v1.5.2`. The README's model URL `https://github.com/TBLgGamin/pokeum/releases/latest/download/dinov2s-ft-v1.onnx` returned **404**. The local tree is ahead of the only public tag. See the ONNX section.

## Layout

```
app/core/        config (env), constants (tuning), logging
app/models.py    CardRef, signal/fusion result types, VariantKind
app/reference/   tcgdex client, sync, sqlite store, image cache, index
app/vision/      detect, rectify, geometry, regions, imaging
app/signals/     hashes, embedding, ocr, symbol
app/variants/    reverse holo, 1st edition, shadowless, promo stamp
app/recognize/   pipeline, fusion, temporal, webcam, factory, eval
app/api/         FastAPI routes, pydantic schemas, SPA static
app/collect/     optional S3 upload of accepted scans
app/cli.py       sync, index, identify, scan, serve, eval
frontend/        Vue + Vite PWA, collection in localStorage
training/        standalone GPU fine-tune, does not import app/
openwiki/        agent-oriented docs
tests/           offline pytest, no network
```

Import direction (from `openwiki/quickstart.md`): `core ← models ← (reference, vision, signals, variants) ← recognize ← (cli, api)`.

## reference / sync

`app/reference/tcgdex.py`

- `card_image_url(image_base) -> str | None` — `{base}/{quality}.{ext}` from constants (`low` + `webp`).
- `symbol_image_url(symbol_base) -> str | None` — `{base}.{ext}`. This 404s on current univ symbol URLs. See `tcgdex-api.md`.
- `parse_set(raw) -> ParsedSet` — id, name, serie name, releaseDate, card counts, set code from `abbreviation.official` or `tcgOnline` / `ptcgoCode`, symbol URL.
- `parse_card(raw, *, set_id, number_total, release_year) -> ParsedCard` — id, localId, name, rarity, image URL, four booleans from `variants` (`reverse`, `firstEdition`, `holo`, `normal`). Ignores `wPromo`, `variants_detailed`, pricing, illustrator, category.
- `TCGdexClient(base_url, language, client=None)` — `list_sets()`, `get_set(set_id)`, `get_card(card_id)`, `get_bytes(url)`. Retries `SYNC_MAX_RETRIES` (3) with linear backoff. One language per client. No ETag, no resume cursor.

`app/reference/sync.py`

- `sync(store, client, data_dir, *, only_set=None, fetch_details=True, force=False) -> SyncSummary`
- Skip rule `_set_is_current`: stored `sets.card_count_total` equals the list brief's `cardCount.total`. That is the advertised total, not a count of card rows. Empty shells and the three sets whose total disagrees with `len(cards)` will be marked current incorrectly. Do not copy this predicate.
- Per set: `get_set`, `parse_set`, upsert, then if `fetch_details` a thread pool calls `get_card` for every brief. Workers only do HTTP; writes stay on the main thread. Failed card fetches are logged and skipped (gap, not fatal).
- Then `_download_missing_images` and `_download_symbols`. Images already on disk are not re-fetched.
- `SyncSummary(sets_processed, cards_upserted, images_downloaded, symbols_downloaded)`.
- Concurrency 12, timeout 30s (`app/core/constants.py`). Their comment says TCGdex is ~1.4 s/request and that 32 was fine during a training fetch. Our measurement on 2026-10-30 was ~0.26 s/request at concurrency 6. Don't inherit the 1.4 s figure.

`app/reference/store.py`

- `ReferenceStore(db_path)` — stdlib sqlite3, `check_same_thread=False`, schema version `"1"`.
- Tables: `sets`, `cards`, `hashes`, `meta`. No collection tables. No foreign keys. No language column.
- `normalize_number(number)` — strip, upper, drop leading zeros on purely numeric ids so OCR `025` matches catalog `25`. Needed in Phase 2, not for display. JA `"001"` and EN `"1"` must not be normalized into the same stored collector number or the collision gets worse.
- `era_for_year(year)` — `wotc` if year <= 2003 else `modern`.
- Writes: `upsert_set(...)`, `upsert_card(...)` (preserves `image_path` / `symbol_path`), `set_image_path`, `set_symbol_path`, `set_hashes`, `set_meta`.
- Reads used by recognition: `get_card`, `get_cards` (chunked IN, 500), `find_card_ids_by_number(number, number_total=None)`, `known_set_codes()`, `symbol_templates()`, `cards_missing_image()`, `iter_hashes()`.
- `_portable_path` rewrites backslashes on read so a Windows-built db works on Linux. Relevant if we ever ship a prebuilt catalog file. Not relevant to a Drizzle db that stores CDN URLs.

`app/reference/images.py` — path layout `images/{set}/{card}.webp`, `symbols/{set}.webp`, `thumbs/{card}.jpg`, `save_bytes`, `exists_nonempty`, `ensure_thumbnail`.

`app/reference/index.py` — `build_index(...)` writes perceptual hashes into sqlite and embedding matrices to `index/emb_full.npy`, `emb_art.npy`, `row_ids.json`. Incremental. Changing `Embedder.identifier` (the onnx filename) forces a full rebuild.

## recognize

`app/recognize/pipeline.py`

- `Recognizer(store, *, hash_index, embedder=None, emb_full_index=None, emb_art_index=None, ocr_engine=None, symbol_matcher=None, executor=None)`
- `identify(image_rgb, *, top_k=5, require_detection=False, guide_margin=None) -> RecognitionResult`
- Flow: detect quad → rectify to 630×880 → hashes + full embedding + artwork embedding + OCR (bottom 10%) + symbol zone → `fuse` → if confident, `assess_variants`.

`app/recognize/fusion.py` — `fuse(...)` and `_decide`. Weights in constants: embed full 0.40, embed art 0.30, hash 0.20, symbol 0.10, renormalized over signals that exist. OCR boosts 0.5 / penalizes 0.4, never a hard gate. Confident if top score >= 0.80 and margin >= 0.10. Uncertain down to 0.50. Default top-k 5 (SPEC wants up to 3 candidates; don't copy the 5).

`app/recognize/temporal.py` — `TemporalAggregator.add(result)` for webcam. Window 6, stable after 4 agreeing frames. Phase 3, not Phase 1.

`app/recognize/factory.py` — `build_recognizer(data_dir=None) -> Recognizer`, `open_store`. Loads ONNX if the file exists, else `HistogramEmbedder`.

`app/recognize/eval.py` — `evaluate_folder(...)`. Filename stem is the truth card id. Offline harness, useful later.

`app/recognize/webcam.py` — `run_webcam(...)`. OpenCV capture. Not the phone path.

## signals

- `signals/base.py` — `Embedder` and `OcrEngine` protocols.
- `signals/hashes.py` — `compute_hashes(image) -> dict` (phash, dhash, phash_r/g/b, 16×16). `HashIndex`.
- `signals/embedding.py` — `HistogramEmbedder` (fallback, no model), `OnnxEmbedder(model_path)` (CPU ONNX Runtime, ImageNet norm, 224 input, L2-normalized), `load_embedder(path)`, `EmbeddingIndex`. Identifier is `onnx:{filename}`.
- `signals/ocr.py` — `parse_collector_number(text) -> (number|None, total|None)`, `parse_set_code(text)`, `interpret_lines(...)`, `RapidOcrEngine`, `read_card(engine, card)`. RapidOCR, not Tesseract. `rapidocr` pulls in full OpenCV and, on Linux, `libgl1` (their requirements comment).
- `signals/symbol.py` — `SymbolMatcher`. Compares the era-specific crop to cached set-symbol templates. Depends on symbol files that our univ-URL probe says Pokeum's downloader will not actually get.

## variants (photo heuristics, not catalog variants)

These guess foil from a photo. They are not the TCGdex variant model.

- `assess_variants(card, card_ref) -> tuple[VariantGuess, ...]`
- `detect_reverse_holo(card, card_ref)` — high-frequency energy in the body crop. Gated on `card_ref.has_reverse`.
- `detect_first_edition` / `detect_shadowless` in `wotc.py` — dark stamp blob, art-frame shadow. Gated on era and `has_first_edition`.
- `detect_promo_stamp` — blob in the lower-left art. Not tied to a catalog stamp id (`grey-star`, `pokeball`, etc.).
- `VariantKind`: `reverse_holo`, `first_edition`, `shadowless`, `promo_stamp`. No unlimited, no masterball, no 1st-edition-holofoil.

Single-still confidence is capped at 0.85. Thresholds are marked empirical in constants. Useful in Phase 2 as a hint after the catalog says which prints exist. Not a source of truth for price or for the owned-card variant.

## vision

- `detect_card_quad(image_rgb) -> ndarray | None` — contour, min area 0.05, aspect 0.55–0.85, detection runs at long side 960.
- `rectify(image_rgb, quad) -> ndarray` — warp to 630×880 (63:88, same ratio the brief wants for layout).
- `order_corners`, `is_plausible_card` in `geometry.py` (pure, easy to test).
- `crop_fraction` / `artwork` / `bottom_strip` / `symbol_zone(card, era)` / stamp crops in `regions.py`.
- `load_image`, `decode_bytes`, `cap_long_side`, `encode_webp` in `imaging.py`.

Phase 2 can adapt this. Phase 1 must not import it.

## api

`create_app(...)` in `server.py`. Routes in `routes.py`:

- `GET /health` → `HealthResponse`
- `POST /identify` (upload) → `IdentifyResponse`
- `POST /scans` → background S3 upload when configured
- `GET /cards/{card_id}` → card detail including image URL
- `GET /cards/{card_id}/image` → local file, or redirect to the CDN URL if no local file

Schemas (`schemas.py`): `SetOut`, `CardBase`, `CardOut`, `VariantOut`, `MatchOut`, `IdentifyResponse`, `ScanAnnotation`, `ScanAccepted`. Collection is not a server resource.

`app/collect/s3.py` — boto3 upload of the scan image plus a JSON annotation, gated by `SCANS_S3_BUCKET`, capped at 100 GB, silent best-effort. Do not copy. We are not shipping user photos to S3.

## frontend

Vue 3 + Vite + Tailwind, not Next. `frontend/src/lib/collection.ts` persists `ScanEntry[]` in `localStorage` under `pokeum.collection`, version 1. An entry is `{card, quantity, scannedAt}`. No condition, grade, price paid, source, location, notes, or language. `exporters.ts` `toTcgplayerCsv` hardcodes `Language` to `"English"` and Printing to `"Reverse Holofoil"` or `"Normal"` from the photo heuristic. `toPlainList` is a one-line text dump. PWA icons exist. Camera needs HTTPS (their README). None of this is our Phase 1 UI. The only idea worth keeping: don't invent a condition in an export the scanner didn't observe. Our forms collect condition from the user, so that warning doesn't apply the same way.

## training

Standalone package. `training/README.md`: fine-tune DINOv2-S for photography invariance, not card identity. Does not import `app/` and `app/` does not import it. Runbook assumes an A100 box (`tnr-0`), `training/deploy.sh`, smoke test, then fetch/cache/train/export. Artifact name must change (`dinov2s-ft-v1.onnx`, `-v2`, …) because the app keys the index on the filename. Parity gate: torch vs onnxruntime cosine > 0.999. `training/config.py` duplicates `ARTWORK_BOX` and ImageNet mean/std; they can drift.

Not a Phase 1 dependency. Not something to vendor into `services/recognition` until Phase 2, and not by `pip install -r training/requirements.txt` (that file is the GPU box's list).

## tests

Offline pytest. `tests/test_sync.py` uses `httpx.MockTransport` (their openwiki says so). Other tests cover fusion, hashes, embedding fallback, geometry, imaging, API with a fake recognizer. No network, no model download. The pattern (pure parsers, injected transport, temp sqlite) is worth copying. The tests themselves are for their schema, not ours.

## Dependencies and Python 3.12

`requirements.txt` (runtime pins): numpy 2.2.6, Pillow 12.3.0, ImageHash 4.3.2, opencv-python-headless 4.12.0.88, onnxruntime 1.26.0, rapidocr 3.9.1, httpx 0.28.1, fastapi 0.139.1, starlette 1.3.1, uvicorn 0.51.0, python-multipart 0.0.32, python-dotenv 1.2.2, boto3 1.43.49.

`pyproject.toml`: `requires-python = ">=3.13"`, ruff `target-version = "py313"`, mypy `python_version = "3.13"`. README badge says Python 3.13.

We are on Python 3.12 (`py -3.12`, venv at `services/recognition/.venv`). A scan of `app/` and `training/` found no 3.13-only syntax (`type` aliases, `except*`, `TypeIs`, `@deprecated`). What they use (StrEnum, `X | Y`, `slots=True`) is valid on 3.12. The blocker is the project metadata, not a syntax error: `pip install` of the project itself will refuse 3.12. Installing the requirements file on 3.12 was not attempted.

Checked one pin against PyPI: onnxruntime 1.26.0 `requires_python >= 3.11` and the file list includes `onnxruntime-1.26.0-cp312-cp312-win_amd64.whl`. I did not check the other pins for cp312 wheels. Phase 2 should write its own `requirements.txt` for 3.12 rather than reuse theirs. rapidocr's note about needing system `libgl1` on slim Linux still applies if we adopt it.

No Phase 1 Python dependency on any of this. Phase 1 recognition service is a health route only.

## Data model vs our entities

Pokeum server tables: `sets`, `cards`, `hashes`, `meta`.

`CardRef` fields: card_id, name, set_id, set_name, set_code, number, number_total, rarity, era, release_year, image_url, image_path, has_reverse, has_first_edition, has_holo, has_normal.

Our minimum entities (BRIEF): CatalogSet, CatalogCard, OwnedCard, Acquisition, Grade, StorageLocation, PriceSnapshot, CollectionGroup, ScanSession, CustomCard, SyncState.

What they have that maps:

- CatalogSet ≈ `sets`, minus language, minus logo URL as a first-class stored field (they store symbol URL/path only), minus legal/standard, minus boosters.
- CatalogCard ≈ `cards`, minus language, category, illustrator, variants_detailed, pricing, regulation mark, dexId, and the raw TCGdex payload. Variant coverage is four booleans. `wPromo` is dropped. Pricing is not stored at all.
- ScanSession ≈ `POST /scans` plus an S3 object, and only if the bucket is configured. Not a local session row.
- Their client `ScanEntry` is a toy OwnedCard: quantity and a timestamp. No Acquisition, Grade, StorageLocation, PriceSnapshot, CollectionGroup, CustomCard, SyncState.

What we must not lose by "adapting" their schema:

- Language on every catalog row. Card id `neo4-100` is both an EN card and a JA card.
- Collection tables that do not cascade from catalog. They don't have this problem because the collection isn't in the database. We do.
- Money as integer cents plus currency. They have no money columns.
- Denormalized name/set/local_id/language on the owned card, which the brief requires so a catalog wipe doesn't orphan anything. Their upsert overwrites catalog rows in place and nothing references them from a collection table.

## What to reuse

Phase 1 (sync), as ideas, not as pasted Python:

- Endpoint split: list sets, set detail for briefs, card detail for variants and rarity. Confirmed against the live API.
- Pure parse functions with an injected HTTP client, so tests don't hit the network.
- Upsert, and "workers fetch, main thread writes."
- Card image URL `{base}/low.webp` and `{base}/high.webp`. Their quality comment about `low.png` is wrong as of 2026-10-30; the URL pattern is still right.
- `normalize_number` later, for OCR matching only, stored separately from the printed localId.
- `era_for_year` later, for symbol-zone and WOTC variant checks. Not a catalog column we need in Phase 1.

Phase 2 (recognition), MIT code we can adapt if it still helps, with their copyright notice in `THIRD_PARTY_NOTICES.md`:

- `vision/geometry.py`, `detect.py`, `rectify.py`, `regions.py` — the 630×880 warp matches our 63:88 layout constant.
- `signals/hashes.py`, `signals/ocr.py` (`parse_collector_number`), `signals/embedding.py` (`OnnxEmbedder` contract: 224, ImageNet norm, L2, filename identifier).
- `recognize/fusion.py` weights and the "OCR is a boost, not a gate" rule. Change top-k default to 3 to match SPEC.
- `variants/assess.py` as a post-pass hint, gated on catalog flags, never as the saved variant.
- The offline test style.

## What not to copy, and why

- The Vue PWA and localStorage collection. Wrong stack, and the data model doesn't meet SPEC (no grade, price paid, location, language, duplicates as first-class rows).
- `toTcgplayerCsv` hardcoding English and a two-value printing. Our export schema is ours (`packages/schemas`, `docs/IMPORT-EXPORT.md`).
- S3 scan upload and boto3. Out of scope, and it ships user photos off the machine.
- Their sqlite schema and `check_same_thread=False` shared connection. We are on Drizzle + better-sqlite3, Postgres-portable, explicit FKs, no cascade from catalog to collection.
- `_set_is_current`. It treats an advertised total as proof the set is synced. Empty JA shells and price updates both slip through.
- `symbol_image_url` as written. Live univ symbol URLs 404 when you append `.png`/`.webp`.
- Single-language client. A `TCGdexClient` bound to one language will silently skip JA, and neo4 ids will collide if both dumps land in one `cards.id` primary key.
- Dropping `variants_detailed`, pricing, and `wPromo`. Phase 1 search can live without attacks text; it cannot live without rarity, image base, and the print list the variant screen will confirm.
- `HistogramEmbedder` as the production encoder. It is a deterministic fallback so their tests run. It will not identify cards from phone photos.
- `fetch_details=False` as a fast path. That mode stores no rarity and no variant flags.
- Training-box scripts, the A100 runbook, and `headroom-ai` in requirements-dev. Not our runtime.
- Their default top-k of 5 and confident threshold of 0.80. SPEC says up to three candidates and never auto-save a low-confidence hit. Thresholds are theirs, unvalidated on our photos.
- The assumption that a Windows path in `image_path` is the thing to store. Store the CDN base URL. Phase 1 doesn't need a local image cache.

## ONNX model and license

Code license: MIT. `LICENSE` is the standard MIT text, copyright 2026 TBLgGamin. If any of their code is copied into this repo, the notice goes in `THIRD_PARTY_NOTICES.md` (brief already says this). Adapting ideas without copying text does not require that, but a close port of `fusion.py` or `rectify.py` does.

Weights: README says the fine-tuned encoder `dinov2s-ft-v1.onnx` (~85 MB, DINOv2-small derivative) is on GitHub Releases under Apache 2.0, and that DINOv2 itself is Apache 2.0 (Meta). I did not fetch the upstream DINOv2 LICENSE file, so the Apache claim for the backbone is their statement, not something I re-verified.

The file is not actually published where the README says. On 2026-10-30:

- `GET https://api.github.com/repos/TBLgGamin/pokeum/releases` → `[]`
- `GET .../releases/latest` → 404 `{"message":"Not Found"}`
- `HEAD https://github.com/TBLgGamin/pokeum/releases/latest/download/dinov2s-ft-v1.onnx` → 404
- only public tag: `v1.5.2`
- local tree version: 1.7.1

There is no ONNX file in the reference checkout (it is gitignored under `data/models/`). I could not inspect the weights, the embedded license, or the opset. Phase 1 does not need the file. Phase 2 should not depend on that URL. Options, in order: export our own ONNX from DINOv2 (Apache, if we confirm the upstream license at that time), or ask the pokeum author for the v1 artifact and its license text. Until one of those happens, the embedding signal has no model and must not be faked with the histogram fallback in a user-facing scanner.
