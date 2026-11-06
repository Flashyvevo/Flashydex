# sonnet-fix-i-core-sqlite — close Sol review 5 P1s in core + web-sqlite (S5-01, S5-02, S5-05, S5-06, boot retry)

Unattended run. Never ask questions. Repo `C:/Projects/flashydex` (start every shell with `cd C:/Projects/flashydex`). Working tree has uncommitted Stage F work — do NOT `git commit/push/stash/reset/checkout`.

## Read first
`.agent/reports/sol-review-5.md` (your items: S5-01, S5-02, S5-05, S5-06 — read the full row AND the narrative sections that cite them), `.agent/stage-f-contract.md` §3–§4, `docs/WEB-STORAGE.md` §4–§5, `apps/mobile/src/platform/web-storage/contract.ts` (read-only), `.agent/reports/sonnet-fix-h-webinstall-report.md` (its legacy-migration.ts P1 fix + the "storage pool could not be opened" open risk), `.agent/reports/sonnet-fix-h-specs-report.md` ("Real defect" = same as S5-01).

## Your files (exclusive)
- `packages/core/src/db/sql.ts`, `packages/core/src/services/catalog-install.ts` (NARROW change only — director-approved for S5-01; nothing else in core), core tests under `packages/core/test/**` or `packages/core/src/**/*.test.ts`.
- `apps/mobile/src/platform/web-sqlite/**` (client.ts, worker-core.ts, sql.worker.ts, legacy-migration.ts, protocol.ts, tests, harness.ts), `apps/mobile/e2e/web-sqlite*.spec.ts`.
Nothing else. Another child concurrently owns `web-storage/**`, `pack-install/**`, `lib/handoff.ts`, `components/**`, `e2e/web-install.spec.ts`. The seam you must provide them is in "Contract" below — implement it exactly so they can code against it.

## Items
### S5-01 (P1) — unknown COMMIT outcome must latch, never undoSwap
Today: `Db.runTransaction` (sql.ts ~276-296) treats a rejected COMMIT as a plain failure (ROLLBACK attempt + translate). Only a failing `afterCommit()` sets `persistenceFailed`. On web, worker death / IO / QUOTA during COMMIT rejects with `commitState: 'unknown'`; core doesn't latch, `catalog-install.ts` (~329-332, 366-380) catches the non-PersistenceError and runs `undoSwap`/`restorePrevious` — Sol reproduced it unlinking an already-committed catalog while the durable USER receipt says installed.
Fix:
1. In core `runTransaction`: if the COMMIT rejection carries `commitState === 'unknown'` (define/export a tiny structural check in sql.ts, e.g. `isUnknownCommit(error)`; the driver sets this property), do NOT ROLLBACK, set `persistenceFailed` exactly as the afterCommit path does, and throw the same `PersistenceError` class. Recovery semantics unchanged: `recover()` → `driver.reopen()` then re-read truth.
2. In `catalog-install.ts`: confirm a `PersistenceError` from the receipt transaction already skips undoSwap/restorePrevious and retains both generations (Sol says the afterCommit path does); make the COMMIT-unknown path reach the same branch. No other install-flow changes.
3. In A's `client.ts`: every COMMIT rejection on a rw wrapper where the worker reply was not received, or was IO/QUOTA/WORKER_DIED (anything except a clean SQLite constraint/logic error returned by a live worker that executed ROLLBACK), must (a) carry `commitState: 'unknown'`, (b) latch the physical connection (all wrappers on that path refuse writes until `reopen()`), (c) reject queued admissions for that path. Currently only WORKER_DIED latches (client.ts ~338-347, 401-420).
4. Tests, red first: core unit tests for PRE-COMMIT error (rollback, no latch), COMMIT-unknown (latch, no rollback, PersistenceError), lost-ack-but-durable (recover → row exists → not duplicated); client tests for IO/QUOTA COMMIT rejection latching; a catalog-install test that the receipt-COMMIT-unknown path keeps both generations and the receipt (use the existing fake port pattern in core tests).

### S5-02 (P1) — USER role/marker/legacy cross-validation (legacy-migration.ts ~244-269, interacts with B's role-state.ts which you may NOT edit)
Implement WEB-STORAGE §5 fail-closed: when resolving USER, load the role AND `roles.migration()` marker together; for a `migrated` origin require marker present and matching path/origin; for an unmarked role probe the legacy IDB key — if present AND the role's USER exists, block with `MigrationBlockedError('orphan_user_data'|'conflicting_stores')` (choose the stable reason, add it to the exported reason list) instead of returning `existing`; never unlink anything in an ambiguous state. Replace the unit test that blesses role/no-marker + legacy-present. Keep A's reported deviation documented in your report as resolved.

### S5-05 (P2) — importer header check in A
`worker-core.ts` ~379-397, 455-483: before accepting/hashing an import, read the first chunk's header: bytes 0-15 == "SQLite format 3\0", bytes 18 and 19 == 1 (DELETE journal, not WAL), page size at 16-17 valid (power of two 512..32768 or the `1` sentinel for 65536). Reject otherwise with `WebStorageError('INTEGRITY', …)`. The returned digest must be the digest of the bytes actually written to the pool: verify by hashing what you feed `importDb` after any normalization, or assert no normalization happens for catalog imports. Keep the USER-migration normalization path explicit and separately named. Unit test with an 8 KiB synthetic file (Sol's repro).

### S5-06 (P2) — request liveness
`client.ts` ~179-199, 251-297: add a bounded per-request deadline for `init`/`open` and a visibility-aware liveness check for in-flight SQL (e.g. a ping op the worker answers; if no reply in N s while the page is visible → treat as worker death: reject pending as `unknown`, latch, surface for `reopen()`). No automatic retries of writes. Unit test with the fake worker.

### Boot retry (from fix-h-webinstall) — `sql.worker.ts` `boot`
sahpool `installOpfsSAHPoolVfs` can fail transiently right after a previous page's worker was killed (handles still held). Add a bounded retry (e.g. up to 10 × 300 ms, only on the "pool could not be opened"/`INIT_FAILED` cause, never on quota/corruption) before surfacing INIT_FAILED. Keep `preserveOnInitFailure: true` / `clearOnInit: false`. Unit-test the retry policy; e2e evidence via the existing kill spec is the other child's.

## Contract (provide exactly; the other child codes against it)
- `WebSqliteClient.closePath(path, options?: { drain?: boolean })`: with `drain: true`, do NOT set `closing` until the current owner's open transaction has finished (COMMIT or ROLLBACK) and the per-path queue is empty; new admissions after the drain call are rejected with `STALE_SESSION`. Without `drain`, current behaviour. Export the option type from `web-sqlite/index.ts`. (This is Sol S5-04's client half; the shell/handoff half is theirs.)
- `commitState: 'unknown'` property on COMMIT rejections as above; `isUnknownCommit` exported from core `db/sql.ts`.
Write these two signatures into `.agent/stage-f-fix-i-seam.md` as soon as they compile (first 20 minutes), so the other child can import them.

## Gates before reporting
`npm run typecheck` (0 errors), `npm run lint` (0 errors), `npm test --workspace=@flashydex/core` (≥367, all pass), `npm test --workspace=@flashydex/mobile` (all pass), `cd apps/mobile && FLASHYDEX_E2E_BASE_URL=https://127.0.0.1:3200 npx playwright test e2e/web-sqlite.spec.ts --project=mobile` (all pass). Dev server already runs on :3200 — never start/kill it, never `npm run dev`.

## Don't
No screenshots / image viewing (kills the session); `browser_exec` only with `session="fix-i-core"` + `cdp('Security.setIgnoreCertificateErrors', ignore=True)`. No `npm install`, no deps, no commits, no edits outside your list, no weakening of safety assertions.

## Report
`.agent/reports/sonnet-fix-i-core-sqlite-report.md` (draft FIRST): per item — what changed (file:line), red→green test names, gate outputs (real counts), the seam file path, contract change requests, open risks.
