# sonnet-shell-f report — Stage F integration (INCOMPLETE: run budget exhausted)

Status: Phase 1 UI/config done and compiling. Phase 2 only partly done. Gates NOT run. Do not treat as shippable.

## Files changed (mine)
- vite.config.ts: VitePWA injectManifest (srcDir src/platform/pwa, sw.ts, registerType prompt, injectRegister false, manifest kept, globs per brief, 3 MB max).
- public/_headers: kept no-cache for /sw.js, /index.html, /manifest.webmanifest; added immutable for /assets/sqlite3-*.wasm; no COOP/COEP; no CSP added (not done, gap).
- index.html: removed <jeep-sqlite>. src/main.tsx: installController.start(), updateController.register().
- src/data/bootstrap.ts (lock -> unsupported fails closed -> prepareStorage(progress) -> createUserDriver -> services; classifyStartupError; fdxMeasures; install port wrapped to keep last pack metrics), provider.tsx, context.ts, startup-progress.ts, index.ts, keys.ts + install-hooks.ts (protection prompt triggers, isCatalogInstallActive).
- src/lib: pwa-bridge.ts, storage-bridge.ts, pwa-hooks.ts, protection-prompt.ts, handoff.ts, diagnostics.ts, pwa-types.d.ts.
- src/components: storage-screens.tsx (unavailable / migration progress / migration blocked, no "start fresh"), storage-protection.tsx (protection sheet, Offline card art, one-time prompt), pwa-ui.tsx (install banner, update toast + handoff overlay), overlay.tsx (reports dirty forms).
- src/routes: __root.tsx (gate screens, prompt, toast), _tabs.tsx (install banner), settings/data.tsx (Storage on this device + Diagnostics link + busy flags), settings/about.tsx, settings/diagnostics.tsx (new), dev/storage-screens.tsx (dev-only preview).
- e2e/helpers.ts (skipProtectionPrompt). docs/UX.md and apps/mobile/PERF-PROCEDURE.md: Stage F sections appended.
- Not touched: package.json/lockfile (C hand-rolled precache; no workbox imports, so no new pins needed; @sqlite.org/sqlite-wasm 3.54.1-build1 verified in lockfile).

## Proven
- `tsc --noEmit -p tsconfig.app.json`: 0 errors outside builders' files at last run (one B test-file error web-store.test.ts:297 was open).
- `vite build` (direct): succeeds; dist has sw.js, sql.worker, sqlite3-<hash>.wasm (879 KB), opfs-stage.worker, precache 85 entries; harness.html not in dist.
- Playwright on :3200: sqlite.smoke passes on the new path (gate-total ~1.2-1.6 s, storage-prepare ~1 s).

## NOT done / broken (honest)
- FULL EN INSTALL THROUGH THE UI DOES NOT COMPLETE. :3200 serves the full pack by default. Download reaches 100%, then the row stays at "Installing" for >2 min and ends with no catalog installed (observed twice; e2e/full-install.spec.ts times out at 360 s). No error code was captured. Needs B/A investigation (decode/import/validate phase) before any W03 claim. No install time, heap or storage numbers exist.
- e2e/full-install.spec.ts written (page CDP + browser-level sendMessageToTarget worker heap sampling) but never passed.
- Not written: storage-migration, two-tab, opfs-rollback, pwa-release specs. Existing specs (persistence-failed, pack-install harness jeepKeys, catalog-failure, instance-lock, core-flow, restore-maintenance, routes) NOT updated or run green: routes.spec failed only because install never finishes; persistence-failed and pack-install.spec still assume jeep (IndexedDB put fault, jeepKeys) and will fail. Plan: persistence-failed -> getWebSqliteClient().__terminateWorker() then write; pack-install -> OPFS/role-store assertions.
- Gates not run: root typecheck/lint, mobile + core unit tests, npm run build (tsc -b), full npm run e2e, :3200 full-pack spec.
- W-ids: W07 UI built (protection/install/diagnostics) but no e2e evidence; W13 handoff built, untested; W09/W10/W11/W14 no evidence from me. A reports W09/W10 storage-side evidence in its own report.
- C's report "Integration requests for shell-f" was not yet present when I stopped; not applied. Metrics seam: DeviceInstallMetrics are only reachable via the wrapped install port (Diagnostics "packMetrics") and core's pack_metrics table.
- Mobile gate at 390 (overflow/44px) not verified in a browser; dev preview route /dev/storage-screens?kind=unavailable|migrating|blocked exists for that.
- CSP not added. Legacy-export hook for MIGRATION_BLOCKED not exposed by A/B; screen tells the user what to do instead (gap).
