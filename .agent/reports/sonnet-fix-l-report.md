# sonnet-fix-l report: Sol review 8 (S8-01 P1, S8-02, S8-03)

Status: complete, all gates green (see Gates).

No commits/pushes. `packages/core` and `contract.ts` untouched. `WEB_ATOMIC_ACTIVATION_PROVEN` still false. No screenshots, no deps.

## S8-01 (P1): whole-job lifetime fence

### Design
Core is frozen, so the job boundary is derived at the adapter from the one place every coordinator-admitted job passes: the USER driver.
core's `WorkCoordinator.admit` inserts the `work_admission` row, `lease.release()` deletes it in the job's last USER transaction.
A job is therefore "alive" from the INSERT (registered at once; dropped if that transaction rolls back) until the release DELETE has settled.
That window contains the role-store IDB transitions and the final receipt (uninstall: `remove` -> receipt tx -> release; install: stage..activate..receipt..release; rollback, sync, restore the same).

Handoff order is now: busy check -> `setBlocked` -> **job fence** (admission fence up, cancel what is still cancellable, await the rest, bounded 20 s) -> close write gate -> drain -> retire storage (page fence, close, terminate worker) -> release the lock.
The SQL write gate is deliberately still OPEN while the job wait runs: the admitted job must finish its receipt transaction, which a closed gate refuses (that refusal is Sol's MAINTENANCE-on-receipt failure).
A per-job gate token was not possible: core's drivers are shared and carry no job identity, so "open for that job only" is realised as "open until every admitted job settled, new jobs refused (RETIRED), UI blocked".
Other writers during that window are the blocked UI (overlay) and the ordinary gate drain that follows.

### Changes
- `platform/web-storage/job-registry.ts` (new): `createJobRegistry` / `jobRegistry` (handle `{id, kind, startedAt, signal, settled, durable}`), `begin`, `run`, `noteDurable`, `registerCanceller`, `fence/lift`, `retire(timeoutMs)`; `observeJobAdmission(driver)` derives the lease boundary from the user driver's SQL (INSERT INTO work_admission rejects `RETIRED` after the fence, before any row is written).
- `platform/app-database.ts`: user driver = `writeGate.wrap(observeJobAdmission(withDevDelay(driver)))`; every install-port operation runs through `jobRegistry.run` (role-moving ones `durable`); `retireStorage` calls `jobRegistry.retire` first and throws `BUSY` WITHOUT fencing/closing/releasing when the wait expires; page fence stays synchronous when no job is alive (S7-01 contract kept); registers the job fence with the handoff.
- `lib/handoff.ts`: `JobFence`, `registerJobFence`, `HANDOFF_JOB_SETTLE_MS = 20_000`, step before `gate.close()`; expiry lifts the admission fence, unblocks, throws a recoverable `HandoffError` with the explicit message "An update is still finishing. Reload when it's done, or choose Restart later and try again." (Reload + Restart later buttons already rendered by the existing card; `pwa-ui.tsx` unchanged, no copy edit was needed).
- `platform/web-storage/role-store.ts`: `createIdbStateCell(name, { isFenced, factory })`; the fence is checked INSIDE the readwrite transaction callback before the put (abort, nothing written); the default store passes `isPageRetired`. A transition that executed reports committed (resolves on `complete`).
- `data/install-hooks.ts`, `data/transfer-sync-hooks.ts`: register an `install` / `sync` canceller while running so the fence can abort a job still before its first durable effect.

### Tests (red -> green)
- Unit `pack-install/web-job-fence.test.ts` (6, real core `CatalogInstallService` + `WorkCoordinator` over a real SQLite USER file, gate + observer as in production):
  - uninstall admitted, role IO held, handoff waits, uninstall completes its receipt (not MAINTENANCE), THEN worker terminated and lock released (events order asserted);
  - job admitted after the fence -> RETIRED, zero `work_admission` rows;
  - bounded wait expiry keeps the lock, gate open, fence lifted, held job finishes, retry then succeeds;
  - cancellable pre-durable install aborted (CANCELLED) then lock released; durable install awaited, never aborted;
  - stand-alone port op refused after fence, op of an admitted job allowed.
  Red evidence: same test 1 with the job fence removed -> `expected [ 'worker-terminated', 'lock-released' ] to deeply equal []` (lock released while the uninstall was still alive).
- Unit `web-storage/role-store-fence.test.ts` (2, fake IDB): queued transition executing after the fence -> RETIRED, 0 puts; committed transition reports committed. Red: with the check disabled both fail (`expected 'committed' to be 'RETIRED'`).
- Unit `app-database.retire.test.ts` (+2): retireStorage waits for an admitted job then closes/releases; expiry -> BUSY, nothing closed, lock kept, page not retired.
- Playwright `e2e/pwa-update-handoff.spec.ts` (+4, same context, tab B blocked on the real writer lock, real IDB, real worker):
  1. Sol's reproduction: uninstall of the small EN catalog, role IO held by a REAL readwrite IDB transaction opened in the page, handoff requested: B stays blocked and A holds the lock for 2.5 s, release the hold, uninstall resolves `ok`, handoff completes, B boots `absent`, active null, no orphan file, B writes, A is refused;
  2. install in progress (JA download stalled, no canceller): handoff waits for the whole install, B boots with EN + JA installed and searchable;
  3. install with a canceller: aborted `CANCELLED`, EN intact, JA absent, lock released;
  4. sync in progress (TCGdex stalled): handoff waits for the sync lease, B boots consistent.
  `bootedConsistent` asserts: installed => active mapping non-null + file present + search total > 0; absent => active null + no orphan generation.

## S8-02: executor-aware deadlines
- `protocol.ts`: `HeartbeatMessage.requestId?`, new `StartedMessage`.
- `worker-core.ts`: tracks the request whose synchronous segment is running (`executing`, set around `dispatch`'s sync prefix), tags SQLite progress heartbeats with it, posts `started {id}` when it begins init/open/reopen.
- `client.ts`: a tagged heartbeat extends the executing request's own deadline and every deadline that has NOT started (queued behind it); a started request is not kept alive by another request's progress; `started` restarts the request's window in full; hidden time still excluded (timers paused while hidden). Untagged heartbeats keep the old 6x cap (legacy path only; the real worker always tags).
- Tests: `client-fix-l.test.ts` S8-02 (6): queued open behind a progressing executor survives 900 ms at an 80 ms window; untagged keeps cap (dies); started + other-id heartbeats -> WORKER_DIED/unknown bounded; `started` grants a fresh window; silent worker dies; stalled init -> INIT_FAILED bounded.
- Real WASM (`e2e/web-sqlite.spec.ts` "executor-aware deadlines"): 24M-row recursive SELECT + queued second-path open, 500 ms window / 1500 ms liveness: both `ok`, 0 terminations (see numbers below). Red: with the worker's tag removed the same spec fails (`err:WORKER_DIED`).

## S8-03: hung acquisition
- `pool-boot-retry.ts`: a hung attempt (no settle in the bound) is never retried in the same worker (the pinned initializer caches the pending promise): it throws `PoolOpenFailure{hung:true}`; the late settle of the abandoned attempt is ignored (`ctx.abandoned()` guard before `reserveMinimumCapacity`, late rejection swallowed); each attempt bound is clipped to the remaining total budget. Settled rejections still retry in-worker with forced re-init.
- `sql.worker.ts`/`worker-core.ts`/`protocol.ts`: init carries `bootBudgetMs`/`bootAttemptTimeoutMs`; `hung` travels on the wire.
- `client.ts` `startSession`: supervises the boot; on a hung init it terminates that worker, backs off, boots a FRESH worker (writer lock is page-held so ownership is kept; preservation flags unchanged: `clearOnInit:false`, `preserveOnInitFailure:true`), clips the next worker's budget to what is left of ONE total budget, merges the attempts list; exhausted -> `INIT_FAILED` with attempts; at most one worker alive; retirement stops it.
- Tests: `client-fix-l.test.ts` S8-03 (9) with a cache-faithful initializer (pending stays pending; only a settled rejection is replaced under force): single acquisition + late resolve ignored; late reject swallowed; settled rejection retried same worker; budget clipping; client: hung first attempt -> fresh worker succeeds with clipped budget and the abandoned worker's late reply ignored; exhausted -> INIT_FAILED + attempts, never two live workers; non-hung not restarted; retirement during backoff.
- `client-fix-k.test.ts`: the three tests that modelled a non-caching initializer (a hung attempt followed by a successful forced second call) were replaced by cache-faithful ones; `pool-boot-retry.test.ts` context assertion adjusted for the new `abandoned` field only.

## Gates (final, after the last code change)
- `npm run typecheck`: 0 errors.
- `npm run lint`: `✖ 23 problems (0 errors, 23 warnings)` (the same pre-existing warnings; my two interim errors were fixed).
- `npm test --workspace=@flashydex/mobile`: `Test Files  32 passed (32)`, `Tests  399 passed (399)` (the known `client.test.ts` interleave flake did not trip).
- `npm test --workspace=@flashydex/core`: `Test Files  34 passed (34)`, `Tests  375 passed (375)`.
- Playwright `pwa-update-handoff + web-sqlite + web-install --project=mobile` against https://127.0.0.1:3200, verbatim:
  - Run 1: `68 passed (2.4m)`
  - Run 2: `68 passed (2.3m)`
- `e2e/full-install.spec.ts` (once): `1 passed (18.9s)`.
- S8-02 real-WASM probe (500 ms window / 1500 ms liveness): `{"long":"ok","second":"ok","elapsedMs":9364.9,"terminations":0,"heartbeats":38,"started":3}`; with the worker tag disabled the same spec fails with `err:WORKER_DIED`.

## Open risks
1. Job boundary is inferred from the `work_admission` SQL on the user driver (core is frozen). If core changed that table/statement shape the registry would see no jobs and the fence would silently degrade to the old behaviour; `web-job-fence.test.ts` runs the real core and would fail, so it is guarded by a test, not by types.
2. A job whose lease release can never run (persistence latched, user DB unusable) stays "alive": handoff then waits 20 s and shows the "still finishing" card instead of ever releasing the lock. Safe (lock kept) but the user must reload.
3. The SQL write gate is open (not per-job) during the job wait; non-job writers are only held back by the blocking overlay and the later drain. A background write path that ignores the overlay could still write during up to 20 s; it is drained afterwards like before.
4. Cancel is best-effort and only wired where a canceller is registered (`useCatalogInstall`, `useActiveSync`); jobs started elsewhere are awaited, not aborted. Uninstall/rollback/restore are never aborted.
5. Sync "durable" is not marked (no port hook): a sync with a canceller is cancelled even if it already wrote rows; it still has to reach its lease release before the lock goes, and core owns sync's own cancel semantics.
6. The 20 s wait is a policy bound, not a storage guarantee; a very large uninstall/install on a slow device can exceed it and then needs Retry/Reload.
7. S8-02: an untagged heartbeat (only a pre-fix worker could send one) still uses the old 6x cap. A native step with no progress for a whole window is still indistinguishable from a stall (unchanged from S7).
8. S8-03: a hung acquisition costs up to the 8 s attempt bound before the fresh worker starts; the total budget is the same 15 s, so on a genuinely stuck device the second worker gets the remainder (clipped) rather than a fresh 15 s. No device/Safari evidence gathered.
9. The existing early `busyReason()` check still refuses the handoff outright while the install UI flag is set; the job fence therefore matters for jobs the UI does not report (uninstall, rollback, sync/restore started elsewhere, programmatic installs), which is exactly what the e2e variants exercise.
