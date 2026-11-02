# sonnet-recognition report (append-only)

## 1. Baseline
- `bash scripts/test-recognition.sh` -> 46 passed in 57.7 s (incl. e2e, lang=ja-with-no-JA-rows case). `ruff check app tests` clean.

## 2. EN index
- Command: `bash scripts/recognition/index-build.sh --lang en` (log data/logs/build-en-assemble.log). Cache key worked: 19,651 of 19,666 reused, only 15 (previously failed downloads) re-tried; 7 still fail.
- Catalog EN: 23,736 cards; excluded: 1,749 without image, 2,321 TCG Pocket (from previous report). With image: 19,666. Indexed 19,659. Skipped 7 download/decode failures.
- Assembly time 106 s; shard workers 5005 s wall (2 processes, ORT 2 threads each, 17,394 cards): combined 3.47 cards/s (each ~1.74/s). Peak RSS 709 MB (shard), 479 MB (assembly).
- Index on disk: 38.9 MB (emb_full 15.1 MB, emb_art 15.1 MB, hashes 3.1 MB, cards.json 6.3 MB, ids 0.23 MB). Model 88,532,934 B. indexVersion 2026.10.31.001+f22797eabf81+058d266d.
