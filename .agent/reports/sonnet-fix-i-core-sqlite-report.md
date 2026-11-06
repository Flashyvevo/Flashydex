# sonnet-fix-i-core-sqlite — report

Seam for the other child: `.agent/stage-f-fix-i-seam.md` (closePath drain + isUnknownCommit/commitState).

## S5-01 (P1) unknown COMMIT latches, never undoSwap
- `packages/core/src/db/sql.ts`: new exported `isUnknownCommit(error)` (own `commitState` or `details.commitState` === 'unknown'); `runTransaction` COMMIT catch now: unknown => NO ROLLBACK, `persistenceFailed = true`, notify, throw `PersistenceError` (same as a failing afterCommit). Known/clean failures keep ROLLBACK + translate.
- `catalog-install.ts`: NO CHANGE needed. Its receipt-commit catch (`if (!(error instanceof PersistenceError)) undoSwap`) already skips undoSwap/restorePrevious for PersistenceError; the COMMIT-unknown path now reaches it. Verified by test (both generations + receipt retained, no ROLLBACK, boot recovery reconciles either outcome).
- `web-sqlite/client.ts`: `isCleanCommitFailure` (only a RemoteError from a live worker with commitState rolled_back/not_started and code not IO/QUOTA/WORKER_DIED is clean). Any other COMMIT/END rejection on an rw wrapper => rethrown as WebStorageError with `details.commitState:'unknown'` AND own `commitState:'unknown'`; new physical-level latch `latchPhysical` (all rw wrappers present AND future refuse writes until `reopen()`, queued non-control admissions rejected `not_started`, owner cleared so readers do not hang). Worker death and barrier failure use the same physical latch (previously per-wrapper).
- Tests (red -> green): `packages/core/test/commit-unknown.test.ts` (6: pre-commit error rollback/no latch; clean COMMIT reject rollback/no latch; COMMIT unknown latch/no rollback/PersistenceError; unknown-never-applied recover => absent; lost-ack-durable recover => exactly once), `packages/core/test/install-commit-unknown.test.ts` (2: receipt COMMIT unknown, applied and not applied: both generations retained, no ROLLBACK, boot recovery ends v2 / v1). Red evidence: with `isUnknownCommit` forced false, 6 of 8 failed (PERSISTENCE_FAILED expected, got DomainError / rollback issued); green after. Client: `web-sqlite/client-fix-i.test.ts` IO + QUOTA COMMIT-reply cases, hung-worker COMMIT, clean deferred-FK COMMIT failure does NOT latch.
  (Honest note: implementation was written before the tests; red was demonstrated afterwards for core by disabling the new branch. Client red not re-demonstrated; the pre-fix behaviour is Sol's reproduction.)

## S5-02 (P1) role / marker / legacy cross-validation
- `web-sqlite/legacy-migration.ts`: `ensureUserDatabase` now loads `roles.user()` AND `roles.migration()` together. New exported reason `conflicting_stores` in `MigrationBlockedReason`. Rules: migrated role needs completed marker with same `userPath` (else block); fresh role must have NO marker (else block); marker without a role => block (no fresh DB, no re-migration, nothing unlinked); unmarked (fresh) role + valid USER probes the legacy key and blocks `conflicting_stores` if present (probe failure => `legacy_unreadable`, fail closed). Stale `m-*` files are unlinked ONLY for a consistent migrated role+marker; for a fresh role they are left alone. user_missing/unreadable/future checks still run before the legacy probe.
- Tests: replaced the test that blessed role/no-marker + legacy-present; added 6 (migrated-no-marker, path mismatch, marker-without-role, fresh-with-marker, fresh m-* never unlinked, probe failure fails closed). The existing "unreadable USER" test needed consistent marker metadata.
- A's reported deviation (assignment-table reading "role => existing, legacy not read") is RESOLVED: legacy is read for unmarked roles. role-state.ts untouched.
- For the other child: UI copy map `REASON_COPY` in `components/storage-screens.tsx` has no entry for `conflicting_stores` (falls back to null); suggest the `orphan_user_data` wording.

## S5-05 (P2) importer header check
- `worker-core.ts`: `checkSqliteImportHeader(chunk, policy)` on the first chunk BEFORE hashing/feeding importDb: magic bytes 0-15, page size 16-17 (pow2 512..32768 or sentinel 1 = 65536), bytes 18/19 == 1/1 for `catalog` policy => `WebStorageError('INTEGRITY')`, target unlinked by the existing catch. Whole-pages check at the end (`total % pageSize`). Catalog bytes are written exactly as supplied, so the returned `sha256` is the digest of the pool bytes.
- USER migration normalization is explicit and separately named: policy `user-migration` + `normalizeUserMigrationHeader` (copy of first chunk with 18/19 = 1/1, accepts 1|2 as legacy-migration already did); `sha256` = digest of the bytes actually written, new optional `ImportResult.sourceSha256` = digest of the caller's original bytes (what `expectedSha256` is compared with).
- Tests `web-sqlite/import-header.test.ts` (Sol's 8 KiB WAL-header repro, bad page size, bad magic, non-whole pages, 4 KiB + 64 KiB valid with pool-bytes digest equality, user-migration 2/2 normalization).

## S5-06 (P2) liveness
- `client.ts`: `requestTimeoutMs` (30 s) deadline on `init`/`open`/`reopen` (expiry: init => INIT_FAILED, others => WORKER_DIED/unknown + worker teardown + latch). New worker op `ping`. While non-ping requests are pending a monitor (`livenessIntervalMs` 5 s) pings; no message at all for `livenessTimeoutMs` (30 s) while the page is visible => treated as worker death (pending rejected unknown, writes latched, `reopen()` recovers). Hidden page: silence ignored. No automatic retries of anything.
- Tests in `client-fix-i.test.ts` with new loopback harness options `intercept` and `hang` (`testing/memory-env.ts`).

## Boot retry
- New `web-sqlite/pool-boot-retry.ts` (`withPoolOpenRetry`, 10 x 300 ms, retries only BUSY/INIT_FAILED-class errors, never quota/capacity/engine errors); `sql.worker.ts` wraps `installOpfsSAHPoolVfs` + `reserveMinimumCapacity`. `clearOnInit:false` / `preserveOnInitFailure:true` unchanged. Unit tests `pool-boot-retry.test.ts` (6).

## Contract (S5-04 client half)
- `closePath(path, { drain?: boolean; timeoutMs?: number })` on `WebSqliteClientInternal`; `ClosePathOptions` exported from `web-sqlite/index.ts`. Drain waits for owner COMMIT/ROLLBACK + its durable barrier + empty queue; new admissions STALE_SESSION, `driver()` BUSY. Tests: 4 in client-fix-i.test.ts.

## Gates
- npm run typecheck: 0 errors (core, schemas, mobile).
- npm run lint: 0 errors in my files; 1 error repo-wide in `apps/mobile/src/lib/handoff.ts:163` (unused `error`, the other child's file, not touched).
- npm test --workspace=@flashydex/core: 34 files, 375 passed (was 367; +8: commit-unknown 6, install-commit-unknown 2).
- npm test --workspace=@flashydex/mobile: 295 passed, 1 failed = `pack-install/web-store.test.ts` "capabilities: pointer activation proven ..." (other child's file `web-store.ts` capability flag flip, Sol S5-03; not mine). My web-sqlite files: all pass (client-fix-i 14, import-header 12, pool-boot-retry 6, legacy-migration 25, existing client/executor tests).
- playwright e2e/web-sqlite.spec.ts --project=mobile: 15 passed (34.2 s) against :3200.

## Open risks / contract change requests
- contract.ts `WebSqliteClient.closePath(path)` lacks `options`; callers must use `WebSqliteClientInternal` (or the contract should add `options?: { drain?: boolean }`). Requested, not edited (read-only).
- Liveness: a single synchronous SQLite statement running longer than `livenessTimeoutMs` (30 s) on a visible page would be declared dead (pending = unknown, writes latched, recover via reopen). Validation was 3.5 s on web, so far below; tune if a heavier statement appears.
- Drain waits for the commit's durable barrier: a caller that COMMITs through a rw wrapper but never calls `afterCommit` would make `drain` wait (use `timeoutMs`). Core `Db` always calls it.
- S5-02: fresh role + stray `/user/m-*` file now stays in the pool (previously unlinked) because provenance is unproven; harmless garbage but it holds a pool slot.
- Legacy probe on an unmarked role materializes the legacy value (<=16 MiB check happens after IDB hands it over, same limit as S5-08 notes); normal fresh users have no legacy key so the probe is a cheap null.
- `storage-screens.tsx` REASON_COPY needs a `conflicting_stores` line (other child).
- Boot retry real-browser evidence (kill spec) is the other child's; here only the policy is unit-tested.
