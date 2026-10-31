I did not finish this task. The report file `.agent/reports/sonnet-tooling-report.md` was not written, because the tool budget ran out first. This summary is the report as it stands.

## Not done
- **CI workflow:** `.github/workflows/catalog-packs.yml` does not exist and `ci.yml` is unchanged. No YAML validation was run.
- **Mac notes:** `scripts/ios-notes.md` is not updated. It still has the old text, with no backup-exclusion or native-verification checklist.
- **Verify step:** I never ran the full `npm run typecheck`, `npm run lint`, `npm test`, `npm run build`.
- **Build blocker:** My only `npm run build` attempt, early on before most of my changes, failed in `tsc -b` with a `SharedArrayBuffer`/`ArrayBuffer` type error. I don't know whether the rewritten worker still triggers it.
- **A server may still be running on port 3200.** I started a Vite server (background process `proc_7e84bb9f86b2`, pid 21628) and did not kill it. Another process, pid 22752, was also listening on 3200. Kill whatever is still on 3200 with `netstat -ano | grep ":3200 "` and `taskkill //PID <pid> //F`.
- **Not fully proven:** the EN dev-pack e2e, and everything under "Cannot be proven without the Mac" below.

## What is done and verified

**Scaffold blockers**
- Web SQLite now works.
  - Root cause: `jeep-sqlite` 2.8.0 bundles sql.js 1.11/1.12-era glue, but the hoisted root `sql.js` was 1.15.2, whose wasm has a different import table. That gave `LinkError: Import #34 "a" "I"` and `componentOnReady()` never resolved.
  - Fix: `apps/mobile` pins `sql.js` 1.12.0 and `scripts/copy-sql-wasm.mjs` copies the wasm from that copy.
  - `/assets/sql-wasm.wasm` returned 200 `application/wasm`.
  - `sqlite.smoke.spec.ts` passed.
- `apps/mobile/src/platform/sqlite.ts` is rewritten, and a new `sqlite-proxy.ts` (with 5 vitest tests, passing) does verb-based routing and maps `changes.values` to `rows`.
- `cap add ios`, `cap add android` and a manual `cap sync` ran.
  - CocoaPods and xcodebuild are missing on Windows. The command printed "Skipping pod install because CocoaPods is not installed" and "Unable to find xcodebuild", then reported success.
  - `Info.plist` now has the camera and photo strings and `ITSAppUsesNonExemptEncryption=false`.
  - I added Android backup-exclusion XML for `flashydex/catalogs` and `flashydex/packs`.
- The iOS podspec for `@capacitor-community/sqlite` depends on **SQLCipher** and ZIPFoundation, so SQLCipher is linked.
- I removed `iosDatabaseLocation` from `capacitor.config.ts`. That setting flags the whole database folder as backup-excluded, which would drop the user DB from backups.
- Catalogs on native go to `Directory.LibraryNoCloud` on iOS. I only read the source that sets `isExcludedFromBackup` there; nothing was executed.

**Compression libraries** (`.agent/research/compression-libs.md`, plus `scripts/bench-compression-libs.mjs`)
- Choices: `zstd-napi` 0.0.13 for the builder, `fzstd` 0.1.1 streaming decoder in a worker, `hash-wasm` 4.12.0 for SHA-256, and `appendFile` with base64 chunks for native writes.
- On the real swsh3 pack, zstd-napi level 19 gives 130,901 bytes, ratio 14.02, 500 ms.
- fzstd streaming decodes it byte-exact in 99 ms with 0.6 MB heap growth.
- Base64 expansion is exactly 1.333x.
- The fzstd 32 MiB window test came out inconclusive; I noted it as such.

**Catalog schema and mapper**
- `catalog-schema.ts`, `drizzle.catalog.config.ts` and a drizzle-generated `migrations/catalog/0000_initial.sql`.
- A pure mapper in `packages/core/src/catalog/tcgdex/` with its own pure SHA-256.
- Fixtures and tests in `packages/core/test/`.
- `npx vitest run` in core: 48/48 passed. A test applies the SQL chain and checks it against the Drizzle declarations.

**Catalog builder** (`tools/catalog-builder`)
- Builder tests: 14/14 passed.
- `--lang en --sets swsh3` ran end to end: 1,835,008 B raw, 130,901 B compressed, ratio 14.02. Counts were 1 set, 201 cards, 364 variants, 694 prices. The round-trip verified, and the rerun was served from cache (cacheHits 422).
- `--lang ja --sets SV2a` built 210 cards, 516 variants, 516 prices; 120,318 B, ratio 13.79.
- The first run's metrics: crawlMs 3874, compressMs 512, decompressMs 29, peak RSS 362,610,688 B.
- `downloadMs` is null with reason `NOT_PUBLISHED`.
- The builder also emits `set-index-<lang>.json` and `catalog-manifest.json`. The manifest has a new optional `setIndexUrl` per language entry, as the Director note specified.

**Dev packs**
- `npm run catalog:dev-pack` populated `apps/mobile/public/dev-packs/` with EN and JA packs, manifest and set indexes. Each pack is under 135 KB.
- The JA pack comes from the one JA set I built (SV2a).
- I did not copy the set indexes into `src/data/bootstrap/` (Director D20); that was not in my ownership list.

**Device side**
- Written, type-checks, and mostly exercised in the browser: worker, installer, web and native stores, and `/dev/pack-test`.
- API: `installCatalogPack(entry: CatalogManifestEntry & {language}, {onProgress, signal}) → {language, version, sha256, bytes, ref, previousRef, counts, metrics}`.
- Also exported: `finalizeCatalogInstall(language)`, `rollbackCatalogInstall(language)`, `openCatalogDb(language)` (read-only `SQLiteDBConnection`), `fetchManifest`, `manifestEntries`.
- Platform adapter types were added additively to `packages/core/src/platform/types.ts`.

## E2E result: 6 of 7 passed
The runs were with the Vite server on 3200 already up.

| Test | Result |
|---|---|
| sqlite smoke | pass |
| JA install | pass |
| reinstall keeps previous copy | pass |
| hash mismatch (`PACK_HASH_MISMATCH`) | pass |
| size mismatch (`PACK_SIZE_MISMATCH`) | pass |
| cancel | pass |
| **EN install** | **fail** |

- The EN test timed out at 30 s. The status went from `downloading` back to `ready`, so the page was probably reloaded mid-install.
- The test ran first, in parallel with the other workers and with the Vite dev server hitting dependency re-optimisation. I did not confirm the cause, and it is unfixed.
- The same EN install passed inside the reinstall test, so the code path works.

## Cannot be proven without the Mac
- Native file writes, `createNCConnection` on an externally written file, `Library/NoCloud` backup exclusion, same-volume rename, and Android backup rules.
- Free-space checking: `@capacitor/filesystem` has no API for it, so `availableBytes()` returns null on native and the check is skipped.
- Device memory, worker and WASM behaviour on an iPhone.

## Open questions for the data and UI builders
- Wrap `installCatalogPack` and `finalizeCatalogInstall` in `CatalogInstallService`. Commit `installed_catalogs` first, then call `finalizeCatalogInstall`; on failure call `rollbackCatalogInstall`.
- Native free-space preflight needs a small native plugin.
- A production build must strip `public/dev-packs` (Director D27). I did not add that to `vite.config.ts`.

session_id: 20261030_210605_113f9a
