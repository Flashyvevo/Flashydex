# Terra pack verification report

## Produced

- Full EN and JA packs: `.agent/metrics/packs/` (ignored): manifest, zstd DBs, set indexes and per-language metrics JSON.
- Committable evidence: `.agent/metrics/README.md`, `catalog-en-2026.10.31.001.metrics.json`, `catalog-ja-2026.10.31.001.metrics.json`, `pack-validation.json`.
- Verification utility: `tools/catalog-builder/src/verify-pack.ts`.
- Tooling/workflow fixes: capped catalog-builder concurrency at 8, added `--concurrency` range validation, ignored crawl cache/generated packs, added JSON-Schema validator, and hardened CI/release workflow.

## Full-build results

| Lang | Raw / zstd | Ratio | Crawl / compress / decode | Peak RSS | Sets / cards / variants / prices | No image / unpublished |
|---|---|---:|---|---:|---|---|
| EN | 138,002,432 / 12,343,679 B | 11.18x | 97.320 / 110.566 / 0.996 s | 555,180,032 B | 220 / 23,736 / 36,693 / 48,805 | 1,749 / 4 |
| JA | 45,592,576 / 3,115,850 B | 14.6325x | 58.663 / 27.019 / 0.287 s | 479,608,832 B | 184 / 12,781 / 15,781 / 10,127 | 8,899 / 68 |

`downloadMs` is null/NOT_PUBLISHED for both local artifacts. Crawl had zero retries, 429s, and 404s. Builds used concurrency 8.

## Validation

- Manifest passed the generated `packages/schemas/json-schema/catalog-manifest.v1.schema.json` validation; no schema mismatch.
- Independent decompression with the Node zstd decoder reproduced each raw byte count and SHA-256.
- better-sqlite3 opened each decompressed DB; `PRAGMA integrity_check` returned `ok`; all manifest row counts reconciled.
- Live TCGdex checks passed for 20 cards (10 EN, 10 JA): name, localId, rarity, nullable image base URL, and normal/reverse/holo/first-edition/wPromo flags.
- `npm run typecheck --workspace=@flashydex/catalog-builder`: pass.
- `npm run test --workspace=@flashydex/catalog-builder`: 14/14 pass.
- Prettier parsed/formatted both workflows successfully; `git diff --check`: pass.

## Workflow audit/fixes

`ci.yml` uses Node 22, Python 3.12, npm cache, `npm ci`, and now typechecks/tests catalog-builder as well as the app suites.

`catalog-packs.yml` now always builds full EN then JA. A JA failure stops before the release step, so no half-manifest publishes. It uses npm plus a persistent crawl-cache action cache, validates the manifest schema, uploads artifact metrics, creates only immutable `catalog-vYYYY.MM.DD` tags, and uploads both zstd packs, both metrics JSON files, both set indexes, and the manifest before publishing the draft release. It never commits packs.

## Observed upstream anomalies

- EN empty shells: `jumbo`, `rc`, `sp`, `wp`; mismatched advertised totals: `mfb` 48/34 and `tk-sm-l` 30/18.
- JA had 68 empty shells, including `SM1+`, `SM3+`, `SM4+`, `SM5+` and numerous repeated `CS*` records; `web1` advertises 48 but lists 47 cards.
- Asset symbol probes returned 404 for many EN legacy/Pocket paths and JA `neo1`–`neo4`; the builder correctly stored nullable symbols. No catalog API request itself returned 404.

## Must change outside my ownership

- `package.json` root `catalog:build` forwarding is broken: the requested root command interprets passed arguments as npm options. The working invocation used for this verification was `cd tools/catalog-builder && npm run catalog:build -- --lang <en|ja> --out ../../.agent/metrics/packs --concurrency 8 --cache-dir .cache`. Fix the root script so the documented/root command works exactly.
- `docs/CATALOG-PACKS.md` should be updated to reflect the actual release tag rule (`catalog-vYYYY.MM.DD`, one immutable release per UTC day) and the release asset list now includes metrics JSON.
- Device download/decode/installed-footprint metrics remain unmeasured; the local `downloadMs` values are intentionally null.
