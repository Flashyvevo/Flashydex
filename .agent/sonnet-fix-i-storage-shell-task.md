# sonnet-fix-i-storage-shell — close Sol review 5 items in web-storage / pack-install / shell (S5-03, S5-04, S5-07, S5-08) + prove the web-install spec

Unattended run. Never ask questions. Repo `C:/Projects/flashydex` (start every shell with `cd C:/Projects/flashydex`). Working tree has uncommitted Stage F work — do NOT `git commit/push/stash/reset/checkout`.

## Read first
`.agent/reports/sol-review-5.md` (your items: S5-03, S5-04, S5-07, S5-08 — full rows + the narrative that cites them, incl. the "USER receipt COMMIT uncertain" table row), `.agent/stage-f-contract.md`, `docs/WEB-STORAGE.md` §4–§5/§7, `apps/mobile/src/platform/web-storage/contract.ts` (read-only), `.agent/reports/sonnet-fix-h-webinstall-report.md` (state of `e2e/web-install.spec.ts`: fixed but never got its two clean full-file runs; has a leftover console.log and an unused eslint-disable).

A sibling child (`sonnet-fix-i-core-sqlite`) is concurrently fixing core + `web-sqlite/**` (S5-01 COMMIT-unknown latch, S5-02 migration, S5-05, S5-06, boot retry). It will publish a seam file `.agent/stage-f-fix-i-seam.md` within ~20 minutes containing:
- `WebSqliteClient.closePath(path, { drain: true })` — waits for the current owner's transaction and empties the queue before setting `closing`.
- `commitState: 'unknown'` on COMMIT rejections + `isUnknownCommit()` exported from core `db/sql.ts`.
Poll for that file (`until [ -s .agent/stage-f-fix-i-seam.md ]; do sleep 30; done`, max 25 min) before writing code that depends on it; until then work on S5-03/S5-07/S5-08 and the spec runs. If it never appears, implement S5-04 against the documented signature above and say so in the report.

## Your files (exclusive)
`apps/mobile/src/platform/web-storage/**` (NOT contract.ts), `apps/mobile/src/platform/pack-install/**`, `apps/mobile/src/platform/app-database.ts`, `apps/mobile/src/platform/pwa/**`, `apps/mobile/src/lib/handoff.ts`, `apps/mobile/src/lib/storage-bridge.ts`, `apps/mobile/src/components/pwa-ui.tsx`, `apps/mobile/src/components/storage-screens.tsx`, `apps/mobile/src/routes/_tabs/settings/data.tsx` (only if S5-08 needs a link), `apps/mobile/e2e/web-install.spec.ts`, `apps/mobile/e2e/pwa*.spec.ts`. Nothing in `packages/core`, `web-sqlite/**`, other specs, other routes.

## Items
### S5-03 (P1) — `WEB_ATOMIC_ACTIVATION_PROVEN`
Set it to `false` in `pack-install/web-store.ts` NOW (first edit). Then earn `true` back: `e2e/web-install.spec.ts` must pass completely **twice in a row** in one invocation each (`cd apps/mobile && FLASHYDEX_E2E_BASE_URL=https://127.0.0.1:3200 npx playwright test e2e/web-install.spec.ts --project=mobile --reporter=line`), including the v2 update / rollback / discardPrevious / quota / short-write / update-killed-mid-decode / update-killed-mid-import tests with REAL IndexedDB + sahpool, plus a NEW test for the receipt-COMMIT-unknown case: inject the sibling's `commitState:'unknown'` at the receipt COMMIT (use the same postMessage-trap technique as `e2e/helpers.ts` `installWorkerDeath`) and assert: both generations retained, receipt not rolled back, no unlink, after `reopen()`/reload the catalog is installed and searchable. Only when all of that is green may you set the flag back to `true`, and the report must quote both run outputs. If it stays red, the flag stays `false` (production install gate closed) and you say why.
Clean up the spec: remove the `openCore retry` console.log and the unused eslint-disable; keep the bounded open retry only if the sibling's boot retry hasn't landed (check their seam file / `sql.worker.ts` diff) — if it has, reduce the spec's retry to a single attempt and prove the kill tests still pass (`--repeat-each=10` on the kill group).

### S5-04 (P1) — update handoff must drain, not deadlock
`lib/handoff.ts` ~14-28 and `components/pwa-ui.tsx` ~72-100: before closing the client for a SW update, (1) block new service mutations (a real gate the services respect, not only overlay UI — use the existing WorkCoordinator / install-hooks `isCatalogInstallActive` seams), (2) await the drain of core transactions/jobs, (3) `closePath(path, { drain: true })` for every open path, (4) release the writer lock, then reload. If an install/sync is running, the overlay must say so and offer "Restart later" rather than waiting forever; a bounded timeout surfaces an explicit error with a Reload button. Also handle Sol's note: `pwa/update.ts` ~99-108 resolves normally on no-waiting-worker/activation-timeout while the shell only unblocks in `catch` — make both paths leave the app usable. Unit tests for the controller; a Playwright test (`e2e/pwa-update-handoff.spec.ts` or in the existing pwa spec) that starts a write, triggers handoff, and proves the write completes and the reload happens exactly once.

### S5-07 (P2) — image cache clone admission (`pwa/image-cache/handler.ts` ~25-36, 75-82)
Acquire a bounded admission slot BEFORE cloning the response; if no slot, don't clone (serve network-only, no cache write). Engine test for N concurrent images never holding more than K unread clone bodies.

### S5-08 (P2) — blocked-migration recovery
`components/storage-screens.tsx` ~133-150: when migration is blocked, offer a real bounded "Export my old collection" action that reads the legacy jeep IDB bytes (A's `legacy-migration.ts` exposes the reader; if it doesn't export one, read the key via the same IDB store name/key documented there) and downloads them as a file, without opening jeep, without enabling the legacy driver, without touching the new pool. Never offer "start fresh". Playwright: seed a >16 MiB legacy value (the migration spec already seeds legacy keys — reuse the pattern), boot → blocked screen → export → downloaded bytes equal the seeded value.

## Gates before reporting
`npm run typecheck` (0 errors), `npm run lint` (0 errors), `npm test --workspace=@flashydex/mobile` (all pass), `npm test --workspace=@flashydex/core` (all pass; you didn't edit core — just confirm), the two consecutive full `e2e/web-install.spec.ts` runs, your pwa specs, and `e2e/full-install.spec.ts` once (must still pass; it installs the 64 KiB full EN pack through the onboarding UI in ~16 s). Dev server already runs on :3200 — never start/kill it, never `npm run dev`.

## Don't
No screenshots / image viewing (kills the session); `browser_exec` only with `session="fix-i-storage"` + `cdp('Security.setIgnoreCertificateErrors', ignore=True)`. No `npm install`, no deps, no commits, no edits outside your list, no weakening of safety assertions, no `window.__fdxKeepPrevious`-style seam that reaches production code paths without a DEV guard.

## Report
`.agent/reports/sonnet-fix-i-storage-shell-report.md` (draft FIRST): per item — what changed (file:line), red→green test names, the final value of `WEB_ATOMIC_ACTIVATION_PROVEN` and the two verbatim spec-run summary lines that justify it, gate outputs (real counts), contract change requests, open risks.
