Project root: C:/Projects/flashydex (cd there first). Product FlashyDex / package `flashydex`.

# Role: sonnet-fix-d — Claude Sonnet fixer, Stage D (after sonnet-core-d + sonnet-mobile-d)

Both builders are finished; you may touch any file listed below. Read first: `.agent/stage-d-contract.md`,
`.agent/reports/sonnet-core-d-report.md`, `.agent/reports/sonnet-mobile-d-report.md`,
`.agent/review/director/STAGE-D-VERIFICATION.md` (the director's findings).

Current state: all gates green (typecheck, lint 0 errors, core 268 + 6 perf, mobile 16, e2e 18/18, build, catalog-builder 24).
Keep them green.

## Fix these (in this order; each is small)

F1 (UI defect, director-observed at 390×844). `/settings/catalog`: after an EN update FAILS (corrupt pack → "The download was
damaged and wasn't installed. Your current catalog is unchanged."), the JAPANESE row's button changes to "Retry"
(`data-testid=catalog-download-ja`) and the error sits under the Japanese row, while the English row still shows
"Update · 11.8 MB". The failure must be attributed to the language that failed (EN row shows Retry + the message; JA row
unchanged "Download"). Find the cause in `apps/mobile/src/routes/_tabs/settings/catalog.tsx` / `data/install-hooks.ts`
(probably the last failed job/progress is not filtered by language). Add a Playwright assertion (pack-install or a new spec)
that serves a bad-hash manifest entry for one language via `page.route` and checks the other language's row is untouched.

F2 (.fdx manifest). A backup created with the EN catalog installed has `"catalogs":[]`. IMPORT-EXPORT says the manifest
carries informational catalog version hints (`{language, version, schemaVersion, baselineSha256, entryPath:null,
rawSha256:null, uncompressedBytes:null}`) for installed catalogs. Fill them from installed_catalogs receipts; test it.

F3 (web durability, R02 residual found by sonnet-mobile-d). jeep-sqlite `saveToStore` does `removeItem` THEN `setItem`
(node_modules/jeep-sqlite utils-store.js ~35–44), so a tab kill between them loses the stored user DB. Remove that window:
preferred = `patch-package` patch of jeep-sqlite making the save a single `setItem` (localforage setItem on an existing key
is one IndexedDB put = atomic replace); wire `postinstall: patch-package` in the root or apps/mobile package.json (check
whether patch-package is already a dependency; add it as a devDependency if not, `npm install` once). Verify the patched
code is what Vite serves (pre-bundled deps: clear `apps/mobile/node_modules/.vite` is NOT allowed while the owner's dev
server runs — instead verify by reading the optimized dep file under node_modules/.vite/deps if present, and note in the
report that the owner must restart the dev server for the patch to take effect). Keep the mobile child's
restore-previous-bytes mitigation. Unit/e2e: the existing persistence-failed spec must still pass.

F4 (migrations meta). `packages/core/migrations/user/meta` (_journal.json + snapshot) was not updated for hand-written
migration 0002 (work_admission, restore_receipts). Regenerate/update it so `db:generate` is consistent (use the repo's
drizzle-kit script; if generation would produce a different SQL file than 0002, keep 0002's SQL authoritative and make
the snapshot match the declarations in user-schema.ts). `test/user-db.test.ts` "applied SQL matches the Drizzle declarations"
must pass.

F5 (R11 leftovers, cheap). `.github/workflows/catalog-packs.yml`: run `verify-pack` on the built artifacts with nonzero exit
on failure before upload; after uploading draft release assets, download them back (gh release download) and compare
size + SHA-256 with the manifest (not just with the local build files) before publishing. Do not run the workflow.

F6 (R13, only if ≤ ~40 min). Native metadata HTTP via CapacitorHttp: `apps/mobile/src/platform/app-platform.ts` `http()`
uses fetch everywhere; on native (`Capacitor.isNativePlatform()`) use `CapacitorHttp.get` (from @capacitor/core) with the
same timeout/headers mapping, lowercase headers, 304 no body, and best-effort cancellation (discard late responses after
abort). Unit test the mapping with a mocked CapacitorHttp. If not done, list it.

## Rules
- NEVER call capture_screenshot or view any image (crashes Anthropic sessions, HTTP 400). DOM/js() checks only, browser
  session `session="fix-d"`.
- No git commit/push. Do not start/stop/restart the dev server on :3200 (owner-owned).
- Do not modify `apps/mobile/public/dev-packs/**` (tracked dev pack used by e2e).
- No docs/* edits except appending to the existing `## Director notes — Stage D (2026-10-31)` section of docs/API.md if a
  contract changes.

## Verify
`npm run typecheck && npm run lint && npm test && npm run e2e` (root), catalog-builder tests if F5 touched it.

## Report
`.agent/reports/sonnet-fix-d-report.md`: F1–F6 → done/partly/not, files, tests, gate excerpts. Under 120 lines.
