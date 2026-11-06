# sonnet-fix-k — close Sol review 7: S7-01 (P1 handoff retirement fence), S7-02, S7-03

Unattended run. Never ask questions. Repo `C:/Projects/flashydex` (start every shell with `cd C:/Projects/flashydex`). Do NOT `git commit/push/stash/reset/checkout`. You are the only builder this round.

## Read first
`.agent/reports/sol-review-7.md` — rows S7-01, S7-02, S7-03 in section 3, section 2 items 1–2, and the S5-04 row (job quiescence note about `data/transfer-sync-hooks.ts`). Then `.agent/reports/sonnet-fix-j-web-sqlite-report.md`, `.agent/reports/sonnet-fix-j-storage-shell-report.md`, `.agent/stage-f-contract.md`, `docs/WEB-STORAGE.md` §2/§7 (W13).

## Your files
`apps/mobile/src/lib/handoff.ts`, `apps/mobile/src/platform/instance-lock.ts`, `apps/mobile/src/platform/app-database.ts`, `apps/mobile/src/platform/web-sqlite/client.ts`, `apps/mobile/src/platform/web-sqlite/sql-class.ts`, `apps/mobile/src/platform/web-sqlite/pool-boot-retry.ts`, `apps/mobile/src/platform/web-storage/write-gate.ts`, `apps/mobile/src/data/transfer-sync-hooks.ts` (registration only), their tests, `apps/mobile/e2e/pwa-update-handoff.spec.ts`, `apps/mobile/e2e/web-sqlite.spec.ts`. `packages/core` and `contract.ts` frozen. Nothing else.

## Items
### S7-01 (P1) — terminal retirement fence
Add a terminal `retired` state (distinct from recoverable `shutdown`/`reopen`) on the web storage runtime: `app-database.ts` exposes `retireStorage()` which (1) sets the fence before the final drain/close, (2) makes `prepareStorage`, `createUserDriver`, `catalogSource.open`, `createInstallPort` stage/import, `getWebSqliteClient().init/open/reopen/importFromStaging` and any queued open on this page reject permanently with `WebStorageError('RETIRED', …)` — checked both before and after every relevant `await`, read-only paths included, (3) cancels/quiesces background jobs: register active network refresh/sync jobs in `data/transfer-sync-hooks.ts` with the existing busy registry so handoff's drain waits for them (bounded) or cancels via their AbortSignal, (4) then close → terminate worker → `releaseWriterLock()`. `handoff.ts` calls `retireStorage()` instead of (or before) its current close sequence; `instance-lock.ts` denies re-acquire after release (keep). Tests: unit — after retire, each factory/client entry point rejects RETIRED, including a call that was already awaiting; Playwright same-context two-tab (extend `pwa-update-handoff.spec.ts`): tab A completes handoff, A then attempts a lazy catalog open + delayed `open`/`reopen` → no new worker (count `Worker` constructions via init script) and no SAH acquisition; tab B boots and writes while A stays open; activation-failure path still retires and releases.

### S7-02 (P2) — conservative tokenizer in `sql-class.ts`
Tokenize strings/identifiers/comments in one pass (single-quoted strings with `''` escapes, `"…"`/`` `…` ``/`[…]` identifiers, `--` and `/* */` comments only outside tokens); strip leading `;`/whitespace before the verb; quoted PRAGMA names (`PRAGMA "user_version" = 99`) classify as assignment; anything the tokenizer can't classify confidently → treat as a WRITE (conservative) and let the gate refuse it while closed/latched. Red-first tests with Sol's three strings: `WITH x AS (SELECT '--') INSERT INTO t VALUES(1)`, `PRAGMA "user_version" = 99`, `; INSERT INTO t VALUES(1)`, plus a read CTE with `--` inside a string that must still classify as read.

### S7-03 (P2) — deadlines
`client.ts` ~266-269, 351-408: progress/heartbeat/ping messages extend liveness, but a pending `init`/`open`/`reopen` must have its OWN bounded deadline that only ITS reply (or a progress message tagged with its request id) extends — not unrelated pings, STALE_SESSION errors, or other requests' replies. Keep visibility suspension. In `pool-boot-retry.ts` ~97-108, bound each individual install attempt (e.g. 8 s) so one hung attempt can't eat the whole budget. Tests: stuck init with pings flowing → INIT_FAILED at the deadline; a legitimate long open with its own progress → survives; hung single attempt → next attempt still happens within budget.

## Gates before reporting
`npm run typecheck` (0 errors), `npm run lint` (0 errors), `npm test --workspace=@flashydex/mobile` (all pass), `npm test --workspace=@flashydex/core` (375, untouched), `cd apps/mobile && FLASHYDEX_E2E_BASE_URL=https://127.0.0.1:3200 npx playwright test e2e/pwa-update-handoff.spec.ts e2e/web-sqlite.spec.ts e2e/web-install.spec.ts --project=mobile` twice (all pass), `e2e/full-install.spec.ts` once. Dev server already on :3200 — never start/kill it, never `npm run dev`.

## Don't
No screenshots / image viewing; `browser_exec` only with `session="fix-k"` + `cdp('Security.setIgnoreCertificateErrors', ignore=True)`. No `npm install`, no deps, no commits, no edits outside the list, never weaken a safety assertion, never revert the heartbeat liveness, never flip `WEB_ATOMIC_ACTIVATION_PROVEN`.

## Report
`.agent/reports/sonnet-fix-k-report.md` (draft FIRST): per item — what changed (file:line), red→green test names with red evidence, the two verbatim spec-run summary lines, gate outputs, open risks.
