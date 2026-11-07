# sonnet-fix-k report: Sol review 7 (S7-01 P1, S7-02, S7-03)

All three items are fixed and all gates are green. No commits or pushes. `packages/core` and `contract.ts` are untouched.

## S7-01 (P1): terminal retirement fence

### What changed
- `platform/web-storage/write-gate.ts:3-23` adds `RETIRED_CODE`, `retiredError()`, `isRetiredError()` and the page-wide fence (`retirePage()`, `isPageRetired()`, `__resetPageRetiredForTests()`).
  - `contract.ts` is frozen and its `WebStorageErrorCode` union has no `RETIRED`, so the code is cast once, in this file.
  - The fence is a synchronous module flag. Every consumer sees it the instant it is raised, and a client created after retirement is born retired.
- `platform/web-sqlite/client.ts`
  - `retire()`, `isRetired` and `assertLive()` at ~206-224.
  - `init()` rejects RETIRED even when a session is cached.
  - `startSession` checks after `await ready` and after the init reply. The existing catch tears the worker down, and the worker is never asked to acquire the pool.
  - `driver()` checks before `init`, after `init`, after the `open` reply and after the rw-upgrade reopen. A handle the worker opened for a retired caller is `close`d before RETIRED is thrown.
  - `reopenPhysical` and `reopenInner` check before and after every await, so queued reopens are refused when they run.
  - `importFromStaging`, `importBytes`, `runImport`, `unlink`, `listFiles` and `ensureCapacity` check before and after `init`.
  - Deliberately not fenced: `closePath`, `shutdown`, `stats` and exec on handles that are already open. An admitted transaction must still reach COMMIT, and the close sequence needs those.
- `platform/app-database.ts:19-70`
  - `fenceStorage()`, `isStorageRetired()`, `refuseIfRetired()` and `retireStorage({quiesce, step})`.
  - `retireStorage` runs: fence (sync, before any await), then quiesce jobs, then `closePath({drain:true})` per open path, then `shutdown()` (worker terminate), then `releaseWriterLock()`.
  - The lock is NOT released if a close step fails (a worker may still hold SAHs). The fence stays up in that case.
  - `retireStorage` is registered with the handoff at module load.
  - `runPrepare` checks after every await. `prepareStorage` rejects RETIRED even when the memoized run already succeeded.
  - `createUserDriver`, `catalogSource.open` and `openWritable` (read-only included) check before and after awaits and close a handle opened by a call retired mid-flight.
  - `createInstallPort.ready` checks before and after `prepareStorage`. `stage` and `openForValidation` also check after the call and close the handle.
  - Role-moving operations (`activate`, `restorePrevious`, `discard*`, `remove`) are not rejected after the fact, because their durable effect already happened. Rejecting them would misreport success.
- `lib/handoff.ts`
  - `registerStorageRetirement`, `RetireStorageOptions` and `HandoffDeps.retireStorage`.
  - `prepareUpdateHandoff` at the point of no return calls the retirement (injected dep, else the registered one) with `quiesce` and a `step` timeout wrapper.
  - When none is registered (unit tests, native) it runs `quiesce` and then the old close sequence unchanged.
  - A recoverable pre-drain refusal (busy job, drain timeout) never raises the fence, so the app stays usable.
  - Job quiescence (the S5-04 note): `useReportBackgroundJob`, `registerBackgroundJob` and `quiesceBackgroundJobs(timeoutMs)` use the same busy registry, so handoff refuses or waits for them.
    - At retirement each job's `cancel` is invoked and the retirement waits up to 3 s (`HANDOFF_JOB_QUIESCE_MS`) for them to unregister.
    - A straggler's next storage call rejects RETIRED.
- `data/transfer-sync-hooks.ts:10,25-30` (registration only): `useActiveSync` registers a background job while the sync is queued, running or cancel_requested. Its cancel calls `services.sync.cancel`.
- `platform/instance-lock.ts`: unchanged. Deny re-acquire after release is kept and is also consulted by `isRetired()`.

### Tests (red to green)
- Unit, `web-sqlite/client-fix-k.test.ts`, 7 tests in "S7-01":
  - before init: no Worker constructed
  - cached init, new-path driver and reopen reject RETIRED, while the open handle still runs and closes
  - retired while the worker boots
  - retired while the pool is acquired
  - retired while the open reply is in flight (the handle is closed)
  - a delayed reopen queued behind a running statement
  - the page-wide fence reaches existing and later clients
  - Red: with HEAD `client.ts` swapped back in, 7 of the 7 failed (no `retire`/fence).
- Unit, `platform/app-database.retire.test.ts` (7 tests): every factory rejects RETIRED before boot, after boot (memoized prepare), and for calls already awaiting init, a catalog open or a validation open. Also covers `retireStorage` ordering and lock-kept-on-failure. Red: `fenceStorage`/`retireStorage` do not exist at HEAD.
- Unit, `lib/handoff.test.ts` (+6): fence order, no fence on a recoverable refusal, activation-failure path still retires and releases, job cancel and wait, bounded stuck job, legacy sequence fallback.
- Playwright, `e2e/pwa-update-handoff.spec.ts` (+2, "retired page (successful handoff)" and "(activation failure)"):
  - Same context: A completes (or fails activation after) the handoff.
  - A then tries prepare, user driver, catalog en/ja open, openWritable, `client.init`, rw and ro `driver`, `listFiles` and `importFromStaging`, now and again after 800 ms, through the production modules. All reject RETIRED.
  - The `Worker` constructions counted by an init script on A stay unchanged.
  - B boots, writes, and writes again while A stays open.
  - Red: with `retirePage` neutered the spec failed (`now.init` expected RETIRED, received ok). That is the P1 itself.

## S7-02: conservative tokenizer (`web-sqlite/sql-class.ts`)
- Rewritten as a single-pass lexer.
  - Strings with `''`, `"…"`, `` `…` `` and `[…]` identifiers, and `--` and `/* */` comments are tokens, so comment markers inside quotes no longer hide anything.
  - Leading `;`, whitespace and comments are skipped before the verb.
  - PRAGMA names may be bare, quoted or schema-qualified, e.g. `PRAGMA "user_version" = 99` or `main."user_version"`.
  - An unterminated string or identifier, a non-word first token, a missing savepoint name or an odd PRAGMA shape all classify as write. Empty or comment-only input stays read.
  - The `foreign_keys` read policy is kept and documented in the header, and it holds quoted too.
- Tests, `sql-class.test.ts` "tokenizer (S7-02)", 6 tests:
  - Sol's three strings are write.
  - `WITH x AS (SELECT '--') SELECT …` is still read.
  - Lead variants and quoted PRAGMA forms.
  - Unclassifiable input.
  - Empty input.
  - Closed gate refuses all three Sol strings and admits the read CTE.
  - Red: 6 of 16 failed before the rewrite.
- The latched-client path shares `classifySql`, so it is covered through the same classifier.
- I did not add a separate latched-client test or a real-SQLite e2e for the Sol strings. The existing latch tests exercise the same `classifySql` call.

## S7-03: deadlines
- `client.ts`, `onMessage` and the deadline map.
  - Any message still updates liveness (`lastHeardAt`), so the S6-01 heartbeat repair is intact.
  - A pending init/open/reopen deadline is now extended only by:
    - a progress message tagged with its own request id;
    - worker heartbeats, capped at 6 deadlines since the request started (`DEADLINE_HEARTBEAT_CAP_FACTOR`);
    - its own reply, which settles it.
  - Ping replies, STALE_SESSION errors and other requests' replies no longer extend it. Visibility suspension is unchanged.
- `pool-boot-retry.ts`: `boundedAttempt` limits one install attempt to `POOL_BOOT_ATTEMPT_TIMEOUT_MS` (8 s, `attemptTimeoutMs` option). A hung attempt counts as a transient INIT_FAILED, the next attempt is forced, and the elapsed budget is unchanged.
- Tests (`client-fix-k.test.ts`, 10), including:
  - stuck init with pongs and with STALE_SESSION pings gives INIT_FAILED in under 400 ms at an 80 ms deadline;
  - a stuck open with unrelated `list` traffic;
  - a legitimate long open with its own progress survives 4x the deadline;
  - progress tagged with another id does not extend it;
  - heartbeats extend it but are capped;
  - a hung single attempt is followed by a forced attempt that succeeds.
  - Red: with HEAD `client.ts` and `pool-boot-retry.ts`, 9 of 10 failed (timeouts).
- Existing `client-fix-j` heartbeat tests pass unchanged.

## Spec-run summary lines (verbatim, `--project=mobile`: pwa-update-handoff + web-sqlite + web-install)
- Run 1: `63 passed (2.1m)`
- Run 2: `63 passed (2.1m)`
- `e2e/full-install.spec.ts` (once): `1 passed (18.5s)`

## Gates
- `npm run typecheck`: 0 errors.
- `npm run lint`: `✖ 23 problems (0 errors, 23 warnings)`. These are pre-existing warnings.
- `npm test --workspace=@flashydex/mobile`: `Test Files 29 passed (29)`, `Tests 374 passed (374)`.
- `npm test --workspace=@flashydex/core`: `Tests 375 passed (375)`, untouched.
- `client.test.ts` "USER statements interleave with the chunked import" failed once in a parallel run (`expected 2 to be greater than 2`) and passed in 2 isolated reruns and in the full run. It is timing-sensitive under load and not related to this change.

## Open risks
1. Heartbeats are untagged. `HeartbeatMessage` and `worker-core` are outside my file list, so heartbeats still extend an init/open deadline, capped at 6 deadlines (180 s in production). Tagging them with the request id would let the client drop the cap and match Sol's "only its own progress" wording exactly. That change belongs in `worker-core.ts` and `protocol.ts`.
2. In production, retirement runs through the registered `retireStorage` path. The `listOpenPaths`, `closePath`, `shutdownClient` and `releaseWriterLock` deps that `pwa-ui.tsx` passes are used only as the fallback, and `pwa-ui.tsx` is outside my list. The two sequences do the same steps in the same order, and the e2e covers the real path.
3. Sync registration lives only in `useActiveSync`, which is mounted where the sync UI is. A sync started elsewhere is not registered as busy. The fence still makes its next storage call reject RETIRED. A stale `running` sync row would make the handoff refuse as busy ("restart later") until it clears. No e2e hit this.
4. The e2e proves no new worker and no SAH contention indirectly, via the `Worker` count and B booting and writing. There is no direct SAH counter.
5. `WEB_ATOMIC_ACTIVATION_PROVEN` was not touched. The no-outer-retry boot boundary matrix and the release-SW dirty/busy/offline matrix from Sol's W13 note were not re-run beyond the committed specs.
6. In `sql-class.ts`, a `WITH` statement is read unless a bare INSERT, UPDATE, DELETE or REPLACE word token appears. It does not parse the CTE grammar, so it stays heuristic for exotic forms. Anything the lexer cannot tokenize is write.
