# sonnet-mobile-e report — Stage E, app side (Claude Sonnet)

Gates, all run at the end with the owner's HTTPS server on :3200 (PID 23636) listening before and after (`netstat`); it was never touched:
- `npm run typecheck`: clean (core, schemas, mobile)
- `npm run lint`: 0 errors, 21 warnings (react-refresh only)
- `npm test`: core 26 files / 328 tests passed; mobile 8 files / 30 tests passed; recognition pytest 1 passed
- `npm run build`: ok (PWA precache 60 entries)
- `npm run e2e` (unmodified root script): `21 passed, 1 skipped (1.5m)`. The skip is my new restore spec on the desktop project, on purpose (mobile project only). After the run :3201 has no listener, only TIME_WAIT sockets.

## N09 — e2e server
- `apps/mobile/playwright.config.ts`: own plain-http server `npx vite --host 127.0.0.1 --port 3201 --strictPort`, `FLASHYDEX_DEV_HTTPS` stripped from its env, `baseURL`/`webServer.url` `http://127.0.0.1:3201`, `reuseExistingServer: false`. `FLASHYDEX_E2E_BASE_URL` override: no webServer, `ignoreHTTPSErrors: true`.
- Docs: root `README.md` dev section, one paragraph under the verify commands, plus the e2e line.
- Observed: the very first run on a cold Vite (fresh dep optimization) once failed with console errors/an interrupted install; reruns were stable, and the final full run was green.

## N03 UI — restore maintenance
- `src/data/context.ts:27-40`: `NOT_READY.maintenance = null`. The snapshot cache now also compares `maintenance` (kind/language/since), as core-e warned. Without it a catalog_activation-only change would not re-render.
- `src/components/storage-status.tsx`: `RestoreMaintenance` is a portal with `data-testid="maintenance-overlay"`, `role="alertdialog"`, `aria-live="assertive"`, "Restoring your backup…" / "Don’t close FlashyDex. This takes a moment.". It sets `#root` `inert` while mounted, so nothing underneath is reachable. `catalog_activation` (only when `reason==='ok'`) shows a small non-blocking `catalog-activation-notice` pill ("Updating the English catalog…").
- Mutations that still receive `MAINTENANCE` show the existing errors.ts copy. Mutations are `retry:false`, so they are never auto-retried.
- DEV-only seams (guarded by `import.meta.env.DEV`, compiled out of production): `window.__flashydexTest.services` (`src/data/bootstrap.ts`) and `window.__flashydexTest.sqlDelayMs`, a per-statement delay on the user driver proxy (`src/platform/app-database.ts`). Core's `hooks.duringRestore` is not plumbed through `createServices`, so I slowed the driver instead of touching packages/**.
- e2e `e2e/restore-maintenance.spec.ts`: onboard, add 2 copies, create `.fdx`, write a divergent location, start restore with `sqlDelayMs=400`. It asserts the overlay (role, copy, `#root` inert), that a `createLocation` from `page.evaluate` during the restore is refused with code `MAINTENANCE`, and that after the restore neither "During restore" nor "After backup" exists and the owned copies (ids and notes) equal the archive. Passes.

## N07 UI — reads
- `src/lib/query-retry.ts` + `src/main.tsx`: the QueryClient default is `retry: retryTransientRead` (one retry, only for `STALE_READ` / `MAINTENANCE`, 350 ms delay), so it applies to catalog, detail, sets and dashboard queries. A second failure shows the normal error copy.
- `src/lib/errors.ts`: added `STALE_READ` copy ("The catalog just changed"). Verified the raw-text leak: the old `detail` put the raw message of any untyped error (e.g. "The database connection is not open") under Details. It is now `null` unless the error has a code. `ErrorState` itself only ever rendered the code.
- Tests: `src/lib/query-retry.test.ts` (retry once only for those two codes, no raw driver text in title/body/detail, STALE_READ copy).

## Sync failed + Resume (E4)
- `src/components/sync.tsx`: a `failed` run now renders "Download failed · Resume" as a button that calls resume. It was a "Details" link, and no code path shows "done" for a failed run (the done pill only fires on a transition to `completed`).
- `src/routes/_tabs/settings/catalog.tsx`: the failed prices card keeps its Resume button and now appends the `lastError` title to "Stopped at N cards".
- Not UI-covered: a failed non-prices run (incremental/refresh) has no progress card on the catalog page, only the pill. I did not add a second card.

## Price gap
- `src/lib/price-gap.ts` (`priceGap`, `hasCurrencyPrice`) + `src/components/card-details.tsx` `PricesTable`: a USD tab with only EUR shows "No USD price" plus the euro amount, source (Cardmarket) and "as of" date. EUR with only USD shows "No EUR price" plus the TCGplayer dollar amount. No conversion, and zero amounts are never shown. USD uses market, then mid/low/high; EUR uses trend, then mid/low/high. The footer "TCGplayer · as of …" line is hidden when the selected tab has no price of its own.
- Tests: `src/lib/price-gap.test.ts` (4 cases).

## R13
- `ios/App/App.xcodeproj/project.pbxproj`: PBXFileReference `A1B2C3D4E5F60718293A4B5D`, PBXBuildFile `…5C`, App group child, and Resources phase entry, mirroring `config.xml`. Nothing else touched; not built (no Xcode here).
- Web free-space preflight: already present — `createWebCatalogStorage.availableBytes` (`src/platform/pack-install/web-store.ts:81-84`) returns `quota - usage` from `navigator.storage.estimate`, and `platformFiles.availableBytes` delegates to it. No change needed. Native stays null (Mac item).

## Small extra
- `src/data/catalog-hooks.ts:48` comment is now "Infinite list of one set's cards."

## From core-e that the UI could not use
- Nothing dropped. `catalog_activation` is shown only as the small notice. The notice may flicker for sub-second barriers; I added no delay. `hooks.duringRestore` stages are unreachable from the app (not plumbed), hence the driver delay seam.
- Line endings: several mobile files in the tree are already mixed LF/CRLF from earlier passes (`catalog.tsx` shows as fully changed in `git diff`).
