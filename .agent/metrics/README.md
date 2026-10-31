# Catalog pack build metrics

Build version: `2026.10.31.001`  
Host/toolchain: Windows x64, Node `v24.19.0`, SQLite `3.53.4`, zstd-napi `0.0.13` level 19.  
`downloadMs` is null for both packs because these local artifacts were not published. Peak memory is builder-process RSS, not a device measurement.

| Language | Raw bytes | zstd bytes | Ratio | Crawl | Compress | Decompress | Peak RSS | Sets | Cards | Variants | Prices | No image | Unpublished |
|---|---:|---:|---:|---:|---:|---:|---:|---:|---:|---:|---:|---:|---:|
| EN | 138,002,432 | 12,343,679 | 11.18x | 97.320 s | 110.566 s | 0.996 s | 555,180,032 | 220 | 23,736 | 36,693 | 48,805 | 1,749 | 4 |
| JA | 45,592,576 | 3,115,850 | 14.6325x | 58.663 s | 27.019 s | 0.287 s | 479,608,832 | 184 | 12,781 | 15,781 | 10,127 | 8,899 | 68 |

Evidence:

- Source metrics JSON: `catalog-en-2026.10.31.001.metrics.json` and `catalog-ja-2026.10.31.001.metrics.json`.
- Full packs and manifest are intentionally ignored at `.agent/metrics/packs/`.
- `pack-validation.json` records independent zstd decompression, raw SHA-256/byte checks, SQLite `integrity_check`, manifest count reconciliation, and twenty live API comparisons (ten per language) for name, localId, rarity, image URL and all stored variant flags.
- All SHA, byte, integrity, count and live-card checks passed.
