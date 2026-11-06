# sonnet-fix-h-specs — migrate the two jeep-era Playwright specs to the Stage F storage path

Unattended run. Never ask questions. Repo: `C:/Projects/flashydex` (start every shell with `cd C:/Projects/flashydex`). Branch main, working tree has the uncommitted Stage F work — do NOT `git commit/push/stash/reset/checkout`.

## Context
Stage F replaced the jeep-sqlite/sql.js in-memory web driver with `@sqlite.org/sqlite-wasm` opfs-sahpool in a worker (`apps/mobile/src/platform/web-sqlite/**`, builder A) plus OPFS pack staging / IDB role store / atomic activation (`apps/mobile/src/platform/web-storage/**`, `pack-install/web-store.ts`, `app-database.ts`, builder B). Read `.agent/stage-f-contract.md`, `docs/WEB-STORAGE.md` §2/§4/§5, `.agent/reports/sonnet-shell-f-report.md` ("NOT done / broken") and `.agent/reports/sonnet-web-sqlite-report.md`.

Two specs still encode the OLD jeep path and fail for that reason only:

1. `apps/mobile/e2e/persistence-failed.spec.ts` — injects an `IDBObjectStore.put` QuotaExceededError ("jeep's saveToStore"). On the new path USER writes go through the SQL worker (synchronous=FULL, journal DELETE); the equivalent fault is **worker death / COMMIT failure**: A's client exposes `getWebSqliteClient().__terminateWorker()` (see `src/platform/web-sqlite/client.ts` and `client.test.ts:201/220/366`) and the driver then rejects with commitState `unknown`, latches writes (`WORKER_DIED`), and `reopen()` clears the latch (contract §4). The app surfaces this as the persistence-failed latch (`data-testid="persistence-failed"`, D43: honest Reload, writes blocked, no doubled copies). Rewrite the spec so it proves R02 on the new path: onboard with the small dev pack → add a card → terminate the worker just before/at a write → expect the latch UI, writes refused, honest reload offered → reload → the card count is exactly what was durably committed (never doubled, never a half-written row), catalog still installed. If the worker death cannot be timed precisely from the page, add a tiny DEV-only fault seam on `window.__flashydexTest` (pattern already used by B in `web-store.ts`/`harness.ts`) in the client (`client.ts` is A's file — the seam must be ≤10 lines, DEV-guarded, and reported as a contract change request).

2. `apps/mobile/e2e/pack-install.spec.ts` + `apps/mobile/src/routes/dev/pack-test.tsx` — the dev harness route calls `openCatalogDb(language)`, which now throws `UNSUPPORTED_CAPABILITY` on web, and the spec asserts `jeepKeys(page)` (IndexedDB key names) for "which catalog files exist". Port both: the route should open the installed catalog through the real path (`createServices`/`catalogSource` or `getWebCatalogStorage()` + `getWebSqliteClient().driver(ref, …, {mode:'ro'})` — see B's `web-storage/harness.ts` `poolState()`/`searchCore()` for the proven calls), and the spec should assert pool state (`poolState()`-style: role-store active/previous refs, pool files, no staging dirs) instead of jeep keys. Keep the spec's intent: EN dev pack installs and row counts match the builder metrics; JA too; reinstalling over an installed catalog keeps the previous copy until finalize then leaves only the active one; removal leaves no catalog file. 

## Your files (exclusive)
`apps/mobile/e2e/persistence-failed.spec.ts`, `apps/mobile/e2e/pack-install.spec.ts`, `apps/mobile/src/routes/dev/**`, `apps/mobile/e2e/helpers.ts` (additive only). Read-only everything else. If you truly need the ≤10-line DEV fault seam in `src/platform/web-sqlite/client.ts`, that one edit is allowed; nothing else outside your list. Another child is concurrently editing `e2e/web-install.spec.ts` and `web-storage/harness.ts` — do not touch those; import from `web-storage/harness.ts` only via dynamic import in the page as the existing specs do.

## Environment
The dev server is ALREADY running at `https://127.0.0.1:3200` (owner's; never start/kill a server on :3200/:3201, never run `npm run dev`). Run only your spec files:
`cd apps/mobile && FLASHYDEX_E2E_BASE_URL=https://127.0.0.1:3200 npx playwright test e2e/persistence-failed.spec.ts e2e/pack-install.spec.ts --project=mobile --reporter=line`
Small dev packs: `/dev-packs/catalog-manifest.json` (EN swsh3 + JA). The app's default manifest in DEV is that small one.

## Do
1. Run both specs once to see the real failures.
2. Port them as described; make all tests in both files pass in one invocation, then run again to prove not flaky.
3. Never weaken a data-safety assertion (no doubled copies, USER untouched, previous kept until finalize).
4. Gates before reporting: `npm run typecheck` (0 errors), `cd apps/mobile && npx eslint e2e src/routes/dev` (0 errors), `npm test --workspace=@flashydex/mobile` (all pass).

## Don't
- No `capture_screenshot`, no viewing images (kills the session). If you use `browser_exec`, use `session="fix-h-specs"` and `cdp('Security.setIgnoreCertificateErrors', ignore=True)`.
- No `npm install`, no commits, no new deps, no edits to `packages/core/**`, `contract.ts`, `web-store.ts`, `harness.ts`, other specs.

## Report
Write `.agent/reports/sonnet-fix-h-specs-report.md` (draft FIRST, refine at the end): what changed and why, the two consecutive spec runs (counts), gate results, contract change requests (the fault seam if added), any real defect found with file:line, open risks.
