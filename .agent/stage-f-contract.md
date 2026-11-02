# Stage F contract — production web storage (Opus director, 2026-10-31)

Binding between sonnet-web-sqlite (A), sonnet-web-install (B), sonnet-pwa (C) and sonnet-shell-f (integration).
Design authority: `docs/WEB-STORAGE.md` (Sol). This file only fixes the seams Sol left to the director.

**The TypeScript source of truth is `apps/mobile/src/platform/web-storage/contract.ts`** (types + constants, director-owned,
READ-ONLY for all builders). Import types/constants from there; do not redeclare them. If a signature is unworkable, implement the
closest compatible thing, write the exact proposed change in your report under "Contract change requests", and tell the director —
never edit contract.ts yourself.

## 0. Prerequisites already done by the director
- `@sqlite.org/sqlite-wasm` **3.54.1-build1** installed, exact pin, in `apps/mobile/package.json` + lockfile. `node_modules/@sqlite.org/sqlite-wasm/dist/` has `index.mjs` (browser), `node.mjs` (Node: usable for in-memory parity tests in vitest), `index.d.mts`.
- `vite.config.ts` `optimizeDeps.exclude` includes `@sqlite.org/sqlite-wasm`. `worker.format` is already `es`.
- `apps/mobile/harness.html`: a DEV-only blank page that does NOT boot the app (no lock, no storage). Playwright specs:
  `await page.goto('/harness.html'); await page.evaluate(() => import('/src/platform/<area>/harness.ts').then(m => m.run(...)))`.
- **E2E server for builders**: run your own specs against the owner's running HTTPS dev server:
  `cd apps/mobile && FLASHYDEX_E2E_BASE_URL=https://127.0.0.1:3200 npx playwright test e2e/<your-spec> --project=mobile`.
  Never start/kill a server on :3200 or :3201. Each Playwright context is a fresh profile (isolated OPFS/IDB), so parallel builders do not collide. The full EN pack is served at `/dev-packs/full/catalog-manifest.json` (EN 12,343,679 B zstd → 138,002,432 B raw, sha256 `bbca47b3…1606`, 23,736 cards); the small dev pack at `/dev-packs/catalog-manifest.json`.

## 1. Ownership (exclusive; touching anything else = defect)
| Owner | Files |
|---|---|
| A sonnet-web-sqlite | `apps/mobile/src/platform/web-sqlite/**` (worker, protocol, client, driver, pool, probe, legacy migration, harness.ts, tests), `apps/mobile/e2e/web-sqlite*.spec.ts`, report |
| B sonnet-web-install | `apps/mobile/src/platform/web-storage/**` EXCEPT `contract.ts`; `apps/mobile/src/platform/pack-install/**` (web-store.ts rewrite, new OPFS decode worker; native-store/native paths must keep working); `apps/mobile/src/platform/app-database.ts`; `apps/mobile/src/platform/sqlite.ts` (legacy-dev only changes); `apps/mobile/e2e/web-install*.spec.ts`, report |
| C sonnet-pwa | `apps/mobile/src/platform/pwa/**` (sw.ts, controllers, image-cache ledger, harness.ts, tests), the `imageCache` section of `apps/mobile/src/platform/files.ts`, `apps/mobile/e2e/pwa*.spec.ts`, report |
| shell-f | `apps/mobile/package.json`/root lockfile, `vite.config.ts`, `index.html`, `src/main.tsx`, `src/data/**`, `src/routes/**`, `src/components/**`, `src/lib/**`, `src/styles/**`, `public/_headers`, `netlify.toml`, all other `e2e/**`, `apps/mobile/PERF-PROCEDURE.md`, `docs/UX.md` (append-only), report |
Nobody edits `packages/core/**`, `BRIEF.md`, `docs/*` written by Sol (append-only `## Director notes`/builder notes forbidden too — put notes in reports), `contract.ts`, `harness.html`.

## 2. Runtime composition (who calls whom)
```
main.tsx ── installController.start(); updateController.register()                 (C API, wired by shell)
bootstrap.openAppServices():
  acquireInstanceLock()                       (existing; 'denied' -> blocked screen, NO worker/OPFS/IDB legacy access)
  prepareStorage(onProgress)                  (B, app-database.ts)
     web: getWebSqliteClient().init()         (A)  -> marks fdx:web-worker-ready, fdx:web-pool-ready
          ensureUserDatabase({client, roles: getRoleStore(), onProgress})  (A; uses B's RoleStore) -> fdx:web-migrate-legacy
          reconcileWebStaging()               (B: intents vs pool files vs staging dirs; never unlink USER/active/previous)
  createUserDriver()                          (B: awaits the memoized prepareStorage itself if bootstrap did not; web -> client.driver(user.path, 'flashydex-user', {mode:'rw', create, role:'user'}))
  createServices({ userDriver, catalogSource, installPort: createInstallPort(), ... })   (unchanged core)
```
- `lock === 'unsupported'` on web now FAILS CLOSED for opening (WEB-STORAGE §2): prepareStorage must not run; shell shows the storage-unavailable screen. Native unchanged.
- No runtime fallback to jeep/sql.js. The only legacy path is DEV-only `localStorage['fdx:dev-legacy-jeep']==='1'` → `prepareStorage` returns `{kind:'legacy-dev'}`, `createUserDriver` uses the old jeep USER code, catalogs disabled (`catalogSource.open` → null, `capabilities().fullInstall=false`). It exists to seed the migration e2e and must be compiled out of production (`import.meta.env.DEV` guard).

## 3. A ↔ B seam
- B never touches sahpool internals; it calls only `WebSqliteClient` methods. A never touches role-store IDB directly except through the `RoleStore` object passed into `ensureUserDatabase` (A tests with an in-memory fake RoleStore; B's real one is wired by B in prepareStorage).
- `getWebSqliteClient(): WebSqliteClient` (singleton) and `ensureUserDatabase` are exported from `apps/mobile/src/platform/web-sqlite/index.ts`. Until A's ready marker exists, B codes against the contract types with a fake client in unit tests.
- Catalog refs given to core = pool paths `/catalog-<lang>/g-<job>.db`. `openForValidation(ref)`: if ref is the active one, borrow the active physical connection (wrapper close must NOT close the physical connection); else `client.driver(ref, 'validate-…', {mode:'ro', create:false, role:'validation'})`.
- Activation: B's `activate` → `client.closePath(oldActive)` (after core's barrier) → `roles.activate(...)` (one IDB tx). Files are never renamed/copied. `discardPrevious/discardCandidate/remove` → `roles.*` first, then `client.unlink` only for refs that are closed and no longer referenced by any role or intent.
- Import: B's OPFS decode worker writes `/flashydex-staging/<job>/catalog.db.part` (sync access handle, explicit offsets, short-write retry/fail, ≤256 KiB chunks, ≤4 unacked); B checks size + SHA-256 + header bytes 18/19 == 1, closes the file, `roles.putIntent`, then `client.importFromStaging({source:{job, name:'catalog.db.part'}, target, expectedBytes, expectedSha256})`; A reads the staged file from the SQL worker with its own sync handle in ≤256 KiB slices and hashes as it feeds `importDb(path, asyncSupplier)`. Then B `roles.addCandidate`, `roles.clearIntent`, removes the staging dir.
- Disk preflight (B): free ≥ compressedBytes + 2×uncompressedBytes + max(32 MiB, 10% raw) (WEB-STORAGE §4); `client.ensureCapacity(4)` before import.

## 4. Error/commit semantics
- All three builders throw `WebStorageError` (contract.ts). B maps to core's adapter codes where core expects them (`PackInstallError` codes: QUOTA→STORAGE_FULL, INTEGRITY→PACK_HASH_MISMATCH/PACK_SIZE_MISMATCH, CANCELLED→CANCELLED, everything else→ACTIVATION_FAILED/PACK_INVALID as today).
- A's rw driver: COMMIT/barrier error or worker death → reject with commitState `unknown`, latch writes on that driver, `reopen()` re-opens the persistent file (no autosave). Never replay writes.

## 5. C ↔ shell seam
- Everything in contract.ts "Sonnet C" section, exported from `apps/mobile/src/platform/pwa/index.ts`: `storageProtection`, `installController`, `updateController`, `imageCache` (+ `IMAGE_CACHE_*`, `SW_MESSAGES` from contract.ts).
- SW source: `apps/mobile/src/platform/pwa/sw.ts`, written for vite-plugin-pwa `strategies:'injectManifest'`, `srcDir:'src/platform/pwa'`, `filename:'sw.ts'`, output `/sw.js` at scope `/`, `registerType:'prompt'`, `injectRegister:false`. It must contain the literal `self.__WB_MANIFEST`. No new npm deps: either hand-roll precache from `self.__WB_MANIFEST` or use `workbox-precaching`/`workbox-routing` which are ALREADY in node_modules via vite-plugin-pwa — if you import them, list them in the report so shell-f adds them to package.json as explicit pinned deps.
- Route order inside the SW = WEB-STORAGE §7 (manifest/.zst/.db/pack hosts NETWORK ONLY & never cached; TCGdex API network only; navigations → cached shell, offline page fallback; worker/WASM/JS never get HTML; `assets.tcgdex.net` images → byte-bounded LRU).
- `platform/files.ts` `imageCache` (core PlatformFiles) maps to `imageCache` SW stats/clear (get/put stay null/no-op on web: the SW does admission).
- shell-f wires: vite config, registration, UI (Settings → Data "Storage protection", "Offline card art" limit/clear, install banner, update toast, Settings → Diagnostics), Netlify headers.

## 6. Ready markers (so shell-f can integrate while builders finish)
When your exported API (contract surface) compiles, unit tests pass, and one real-browser smoke passes, `touch .agent/stage-f-<A|B|C>-ready` and keep going (fault tests, report). If you later change behavior the shell depends on, say so in the report.

## 7. Performance marks (WEB-STORAGE §6)
A: `fdx:web-worker-ready`, `fdx:web-pool-ready`, `fdx:web-migrate-legacy`, `fdx:web-commit` (sampled, not per statement spam: a `performance.measure` per durable commit is fine; dev logs only).
B: `fdx:pack-download`, `fdx:pack-decode`, `fdx:pack-import`, `fdx:pack-validate`, `fdx:pack-activate` (use `timeOrigin+now` when crossing worker boundaries).
Existing `fdx:gate-total`, `fdx:db-open`, `fdx:services`, core marks stay.

## 8. Shared rules for every Stage F child
- NEVER call capture_screenshot or view/open any image — it kills the session (HTTP 400). DOM/JS/CDP text checks only. Browser via `browser_exec` with `session="<your role>"`, `cdp('Security.setIgnoreCertificateErrors', ignore=True)` before visiting https://127.0.0.1:3200, `cdp('Page.bringToFront')` before timing anything.
- Never `git commit`/`push`/stash/reset; never kill the :3200 server; no `npm install` (shell-f excepted); no core edits.
- Red test first for every parity/fault property. Gates before reporting: `npm run typecheck` (root), `npm run lint` (0 errors), `npm test --workspace=@flashydex/mobile`, `npm test --workspace=@flashydex/core` must stay at ≥367, plus your Playwright specs.
- Report: what changed (files), what is proven (command + result), WEB-STORAGE acceptance ids (W01–W14) you closed/partially closed, contract change requests, open risks.
