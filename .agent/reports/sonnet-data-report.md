# sonnet-data report (Stage B data layer)

## Built
- packages/schemas: zod contracts (primitives, entities, api, manifest incl. optional setIndexUrl + allowDevUrls factory, transfer), Draft 2020-12 JSON Schema generator (`@flashydex/schemas/json-schema`; files written to packages/schemas/json-schema/ by test/transfer.test.ts, `UPDATE_SCHEMAS=1` or `npm run schemas:generate`).
- packages/core: errors, user schema + migration chain (0000_initial, 0001_seed), embedded migrations, migrator (SHA-256 per file, atomic), DatabaseSet over SqlDriver (node test driver, no ATTACH), SettingsRepo, CatalogRepo, CollectionRepo, PortfolioService, CatalogInstallService, TransferService (JSON/CSV export, dryRun/getImport/commit with receipt, skip/update), memory Platform for tests.
- apps/mobile/src/data + src/platform: AppServicesProvider, hooks, query keys, install progress store, adapter (sqlite-proxy, Platform).

## Hooks
Implemented: settings, dashboard, collection, catalog, install, transfer (export/share/dryRun/getImport/commit).
Throwing UNSUPPORTED_CAPABILITY ("Not implemented yet"): SyncService (useUpdateOwnedPrices, useRefreshSet), BackupService (.fdx; capabilities() reports fdxCreate/fdxRestore false).

## Tests (real temp SQLite files, FK ON)
- core: 10 files, 147 passed. schemas: no tests of its own. mobile: 5 passed.
- user-db (migrations/idempotence/FK), collection-crud, collection-list, portfolio, catalog-repo, install-settings, transfer (export formats, JSON Schema validation via ajv, round trip, replay, stale preview, update policy, invalid files, CSV import, formula escape).
- Not written: perf test (63/64), sync tests (35/36), several named acceptance ids (e.g. 38/37 only if covered in catalog-repo/install-settings; not audited), fdx 49-51.

## Verify
- `npm run typecheck`: exit 0 (core, schemas, mobile).
- `npm test`: core 147 passed, mobile 5 passed.
- `npm run lint`: FAILS in apps/mobile (9 errors, 23 warnings). The one warning set I saw is in sonnet-ui files (routes/*). I did not identify which files hold the 9 errors; check with `npx eslint . -f unix` in apps/mobile. Not confirmed to be in my files.
- Browser boot check (session "data") NOT run: time budget ran out.

## Known gaps / open
- Sync, Backup stubbed. Perf test missing. Core eslint run did not complete (config migration message), so core lint is unverified.
- ajv/ajv-formats added as devDependencies in core and schemas.
- CSV import and the import planner have only the cases above tested; manifest URL/dev pack not rebuilt (catalog .sql unchanged).
