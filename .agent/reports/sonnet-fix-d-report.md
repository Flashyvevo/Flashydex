# sonnet-fix-d report (Claude Sonnet 5.5)

All six items done. No commits, no dev-server start/stop, dev-packs untouched, no screenshots.

## F1 — failure attributed to the wrong language row: DONE
Cause: `LanguageRow` read the single global `install.error` for every row that was not installed, so JA (not installed) showed
EN's failure, and the EN row (installed) never rendered failure/Retry at all.
- `apps/mobile/src/data/install-hooks.ts`: install state now carries `errorLanguage` (set on failure, cleared on start/success); exposed on `useCatalogInstall()`.
- `apps/mobile/src/routes/_tabs/settings/catalog.tsx`: a row only uses the session error if `errorLanguage === row language`; persisted
  `status.lastError` is only used for the row's own language (installed rows only show session errors); the update button on an
  installed row becomes "Retry" on a retryable failure; the failure Banner is no longer hidden for installed rows.
- Test: new `apps/mobile/e2e/catalog-failure.spec.ts` (EN installed via onboarding; `page.route` serves a manifest with EN newer + bad
  sha256; asserts EN "Update" → click → "Retry" + "Your current catalog is unchanged" in the EN row; JA stays "Download" with no error text). Passes on mobile and desktop.

## F2 — .fdx manifest catalog hints: DONE
- `packages/core/src/backup/archive.ts`: `buildArchive` accepts optional `catalogs`.
- `packages/core/src/backup/backup-service.ts`: new `catalogHints()` reads `installed_catalogs` (status installed) →
  `{language, version, schemaVersion, baselineSha256: receipt sha256, entryPath:null, rawSha256:null, uncompressedBytes:null}`; `includesCatalogs` stays false.
- Test: `test/backup.test.ts` "manifest carries informational catalog version hints…" (EN receipt → exactly one hint; no catalog → `[]`). Restore path unchanged (core-flow e2e restore still matches).

## F3 — jeep-sqlite atomic save: DONE
- `patches/jeep-sqlite+2.8.0.patch` (patch-package): `saveDBToStore` is a single `store.setItem` (no `removeItem` first) in all 5 shipped copies
  (esm, cjs, components, collection/utils-store, minified `p-6e83e397.entry.js`). `removeDBFromStore` untouched.
- `patch-package@^8.0.1` added as root devDependency (was absent); root `postinstall` now `patch-package && …existing…`. `npm install` run once; `npx patch-package` re-applies cleanly.
- Vite: `optimizeDeps.exclude: ['jeep-sqlite']`, and there is no `node_modules/.vite` directory at all, so Vite serves the patched files straight from
  `node_modules/jeep-sqlite/dist/esm/…` — nothing pre-bundled to clear. I could not confirm via curl on :3200 (path form differs); verified on disk instead.
- OWNER ACTION: restart the dev server (and hard-reload open tabs) so the patched module is loaded.
- Mobile child's restore-previous-bytes mitigation kept; `persistence-failed` e2e passes on both projects. (The comment in `platform/sqlite.ts` still describes the old remove-then-set; harmless but stale.)

## F4 — user migrations meta: DONE
- Ran `drizzle-kit generate` into a scratch copy: it produced equivalent SQL (same two tables + index; only quoting of CHECKs differs).
  Kept hand-written `0002_admission_restore.sql` authoritative; added `meta/0002_snapshot.json` (drizzle's) and a third `_journal.json` entry tagged `0002_admission_restore`.
- Verified: `drizzle-kit generate --config drizzle.config.ts` now says "No schema changes, nothing to migrate"; `npm run db:embed` leaves `migrations.generated.ts` byte-identical; `user-db.test.ts` passes. Scratch files removed.

## F5 — catalog-packs.yml: DONE (workflow not run)
- New step "Verify built packs" before upload: `cd tools/catalog-builder && npx tsx src/verify-pack.ts dist/catalog-manifest.json` (script already sets nonzero exit via `failedChecks`; `set -euo pipefail`); report saved to `dist/verify-pack-report.json` and added to the artifact upload (upload is `if: always()`).
- Read-back vs manifest was already present from core-d (download draft assets into a temp dir, compare size+SHA-256 with local files, then compare downloaded packs against the downloaded manifest's `compressedBytes`/`compressedSha256`, all before `gh release edit --draft=false`). I confirmed it reads the downloaded manifest, not the local one; no change needed.

## F6 — native metadata HTTP via CapacitorHttp: DONE
- New `apps/mobile/src/platform/native-http.ts` (`nativeHttpGet`): `CapacitorHttp.get` with `connectTimeout`/`readTimeout` = timeoutMs, headers passed through, response header names lowercased,
  204/304 → body null, string body JSON-parsed (unparseable → null), plugin error → `HTTP_FAILED`, abort/timeout → immediate `HTTP_FAILED` and the late native response is discarded.
- `app-platform.ts` `http()` uses it when `Capacitor.isNativePlatform()` (after the existing https + host-allowlist check); web keeps fetch.
- Test: `src/platform/native-http.test.ts` (6 tests, mocked client: mapping, 304/204, string body, failure, abort-then-late-resolve, timeout). Not exercised on a device (no Mac).

## Gates
- `npm run typecheck`: clean.
- `npm run lint`: 0 errors (21 warnings, pre-existing).
- `npm test`: core 21 files / 275 tests (269 + 6 perf); mobile 6 files / 22 tests (16 + 6 new).
- `npm run e2e`: 20 passed (18 + new spec on both projects).
- catalog-builder: 24 tests passed.

## Files touched
apps/mobile: src/data/install-hooks.ts, src/routes/_tabs/settings/catalog.tsx, src/platform/{app-platform.ts,native-http.ts,native-http.test.ts}, e2e/catalog-failure.spec.ts
packages/core: src/backup/{archive.ts,backup-service.ts}, test/backup.test.ts, migrations/user/meta/{_journal.json,0002_snapshot.json}
root: package.json, package-lock.json, patches/jeep-sqlite+2.8.0.patch; .github/workflows/catalog-packs.yml
