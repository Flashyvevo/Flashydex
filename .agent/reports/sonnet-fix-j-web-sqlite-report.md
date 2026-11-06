# sonnet-fix-j-web-sqlite report (Sol review 6: S6-01, S6-02, S6-03, S6-05)

Files touched are all inside the allowed list: `web-sqlite/{client,protocol,worker-core,executor,sql.worker,pool-boot-retry,legacy-migration,harness}.ts`, `web-sqlite/testing/memory-env.ts`, new `web-sqlite/sql-class.ts`, `web-storage/write-gate.ts` (S6-05 only), `e2e/web-sqlite.spec.ts`, plus tests. No commits, no `packages/core` changes, no deps.

## S6-01 (P1) liveness vs. synchronous SQL: design (a), progress callback

API evidence: `sqlite3_progress_handler` is exported by the pinned wasm (`node_modules/@sqlite.org/sqlite-wasm/dist/index.mjs:2787`), bound in the capi table at `:8727-8741` (FuncPtrAdapter `xProgressHandler`, `bindScope: context`, per-db cleanup at `:9636`), typed in `index.d.mts:3517-3521`.

Measured in node on the pinned build: it fires during `PRAGMA integrity_check` (6 callbacks / 135 ms at 100 k ops on a 60 k-row table, via SQLite's per-page `checkProgress`), during `PRAGMA quick_check`, and during Sol's recursive SELECT (max gap 3.9 ms at 100 k ops). Cleared handler fires 0.

What changed:
- `worker-core.ts` `installHeartbeat` (called from `applyPragmas`, so every open and reopen): progress handler every 20 000 VM steps; posts `{kind:'heartbeat', sessionId}` at most every 250 ms; returns 0 (never interrupts); a throwing post is swallowed. `CoreOptions.progressOps/heartbeatMs` are test seams. Absent API means no heartbeats and the old silence rule applies.
- `protocol.ts`: `HeartbeatMessage` added to `WorkerMessage`.
- `client.ts`: any message (reply, ping reply, progress, heartbeat) is proof of life. Liveness already used `lastHeardAt`; the hard `init/open/reopen` deadlines are now SILENCE-based (every message restarts them) and visibility-aware: a hidden page clears and does not re-arm them, and on becoming visible they restart in full (`armDeadline/restartDeadline/touchDeadlines/bindVisibility`, ~client.ts:351-395). Previously a pending `open` was killed after 30 s of wall time even while the worker was busy on another file's validation, and hidden pages did not suspend it.
- Default init deadline = `max(30 s, 2 x POOL_BOOT_BUDGET_MS)` (S6-02).

Red -> green:
- Real WASM worker, real sahpool, e2e `worker liveness ... (S6-01) > a healthy real worker ...`: RED before the change: `{ok:false, code:'WORKER_DIED', commitState:'unknown', elapsedMs:318, terminatedBeforeShutdown:1}` (timeout 300 ms). GREEN after (timeout 1000 ms, 6 M-row recursive SELECT): `{ok:true, rows:[[18000003000000]], elapsedMs:2510, terminatedBeforeShutdown:0}` (6147 ms in the full-spec run, still 0).
- `... truly dead worker (no replies, no pings, no progress)`: `WORKER_DIED`, `commitState unknown`, `terminatedBeforeShutdown 1`, < 5 s. Passes before and after (guards against over-fixing).
- Unit `client-fix-j.test.ts` (8 tests): worker posts heartbeats during integrity_check and a recursive SELECT; throttling; a worker that cannot answer pings but sends heartbeats survives 5x the window with 0 terminations; silent worker still dies; heartbeats extend a pending `open` deadline but silence still kills it; hidden page: no INIT_FAILED for 6x the deadline, completes if answered while hidden, restarts in full on visible; open/reopen survive hidden. Mutation check (disabling `touchDeadlines`, the heartbeat install): the 3 heartbeat/deadline tests go red.

Not covered / residual: the progress handler only fires between VM steps / btree pages. One native operation that runs long without either (a huge single COMMIT's file I/O, a very large sorter or index build inside one step) can still go silent for the 30 s window. No core call does this today that I found. Release-device timings of a full-pack `integrity_check` are not measured (desktop headless only).

## S6-02 (P1) boot retry that actually reacquires

Pinned source: `installOpfsSAHPoolVfs` caches a rejected init promise per VFS name (`dist/index.mjs:17232-17237`, `:17294-17296`); the option is `forceReinitIfPreviouslyFailed` (declared `:16070`, honoured `:17235`).

- `pool-boot-retry.ts` rewritten: elapsed budget 15 s (`POOL_BOOT_BUDGET_MS`, defined in `protocol.ts` so the client does not import worker code), backoff 250 ms doubling to a 2 s cap with +/-25 % jitter, retries only BUSY/INIT_FAILED-class causes (quota, capacity, SQLite/corruption fail at once). `installPoolWithRetry` passes `forceReinitIfPreviouslyFailed:true` on attempts >= 2 and never on attempt 1; always `clearOnInit:false`, `preserveOnInitFailure:true`, same name/directory; never `removeVfs`/wipe; reserve inside the attempt. Throws `PoolOpenFailure{attempts,lastError,exhausted}`.
- `sql.worker.ts:119-132`: uses it; QUOTA/CAPACITY pass through unchanged; otherwise `INIT_FAILED` with `details.attempts` = `[{attempt, force, code, cause, elapsedMs}]`. `protocol.ts` `WireError.attempts` + `wireError/fromWire` carry it to the client (sanitized message text only).
- Client init deadline is longer than the whole budget (30 s vs 15 s) and is silence-based.

Tests (`pool-boot-retry.test.ts`, 13): a stand-in for the pinned initializer (cached rejection unless forced). After one failure attempt 2 is invoked with force and REALLY re-acquires (acquires = 2) and succeeds once the held handle is released; "red proof" test shows the unforced call keeps replaying the first failure after the handle is freed (acquires stays 1); no force on attempt 1; a never-freed handle exhausts the elapsed budget with every attempt recorded and forced after the first; quota from install and from reserve = 1 call, no sleep; backoff/jitter bounds; attempts survive the wire round trip.

Browser evidence, kill group with the spec's outer retry OFF (`FDX_NO_OUTER_RETRY=1 ... -g "no outer boot retry" --repeat-each=10`; the sibling's spec seam was already present):
`40 passed (2.4m)`: **40/40**. (Baseline per Sol: 33/40.) I did not add instrumentation, so I cannot say how many of those boots needed a forced second attempt; the per-attempt causes only surface on failure and none failed. Safari/real-device not run.

## S6-03 (P1) multiple USER orphans

`legacy-migration.ts`: `classifyOrphan` (empty = zero schema objects, nonempty, unreadable; read-only open, rw only when the ro attempt fails, i.e. hot journal) and `assertAllOrphansEmpty` examine EVERY `/user/u-*` file (sorted); any nonempty/unreadable throws `orphan_user_data` and nothing is unlinked. `createFresh` adopts the sorted-first empty orphan only after all passed; the legacy-present branch uses the same check. The emptiness definition is unchanged (existing test: a table with zero rows is still "nonempty").

Tests (9 new in `legacy-migration.test.ts`, "S6-03"): empty+nonempty and nonempty+empty in both enumeration orders, empty+unreadable (garbage bytes) in both orders, all-empty both orders (one adopted, none unlinked, all opened `ro`), legacy present + nonempty orphan. Red check: restricting the check to the first file fails 5 of them (all-empty-order tests, empty+nonempty asc, empty+unreadable asc, nonempty+empty); restored.

## S6-05 (P2) shared mutation classifier

New `web-sqlite/sql-class.ts` (`classifySql`, `isMutationKind`), used by `client.ts` (latch/read-only refusal, COMMIT detection) and `write-gate.ts`.
- `WITH` = write if INSERT/UPDATE/DELETE/REPLACE appears outside literals/comments/quoted identifiers (`replace(` the function is ignored); read otherwise.
- `SAVEPOINT / RELEASE / ROLLBACK TO` classified as transaction control. Gate tracks a savepoint stack per wrapper (an outermost SAVEPOINT opens an "admitted transaction", the outermost RELEASE or COMMIT/ROLLBACK ends it, ROLLBACK TO keeps it open; BEGIN + SAVEPOINT combine). Client treats `release` as COMMIT-like for unknown-outcome handling, and `worker-core` marks a failed RELEASE as a commit candidate.
- `PRAGMA x = v` / `PRAGMA x(v)` = write, bare `PRAGMA x` = read, a fixed introspection list (`table_info(...)` etc.) = read, bare `optimize/wal_checkpoint/incremental_vacuum` = write. Unknown verbs and `ATTACH/DETACH` = write.
- Deliberate exception: `PRAGMA foreign_keys = ...` is treated as a read (connection-local, never touches the file; core issues it in `Db.initialize()` and `recover()`, and rejecting it while latched/closed would break recovery). Say if you want it as a write instead.
- Ro-handle behaviour change: SAVEPOINT/RELEASE and assignment PRAGMAs now refuse with "read-only"; core only swallows the `foreign_keys` one on ro.

Tests (`sql-class.test.ts`, 9): every form above plus gate behaviour with a recording driver. Red: the HEAD gate against the same gate tests: `WITH ... INSERT`, `SAVEPOINT x` and `PRAGMA user_version = 99` are admitted and the savepoint is not counted as pending (2 of 3 gate tests fail).

## Gates

- `npm run typecheck`: 0 errors.
- `npm run lint`: 0 errors, 23 warnings (all pre-existing react-refresh and similar, outside my files).
- `npm test --workspace=@flashydex/core`: 34 files, **375 passed**.
- `npm test --workspace=@flashydex/mobile`: **336 passed, 1 failed**; the failure is `src/platform/pack-install/web-store.test.ts > capabilities: pointer activation proven ...` (`atomicActivation:false`, "Pointer + journal fault tests have not passed yet."), in the sibling's area (`pack-install/web-store.ts` has uncommitted sibling edits). Not caused by my files. All 133 `web-sqlite` tests pass.
- `e2e/web-sqlite.spec.ts --project=mobile`: **17 passed** (15 existing + 2 new S6-01).
- Kill group, outer retry off, `--repeat-each=10`: **40/40**.

## Contract change requests

1. `web-storage/contract.ts` `WebStorageError.details`: add `attempts?: readonly { attempt: number; force: boolean; code: string; cause: string; elapsedMs: number }[]` (currently set via a cast; read via `(error.details as {attempts?})`). The storage screen can show it for INIT_FAILED.
2. `WorkerMessage` gained `heartbeat` (internal to the web-sqlite worker protocol; no public contract type changed).
3. Sibling: `e2e/pwa-image-cache.spec.ts` and the `pack-install` capability test are theirs; the `web-install.spec.ts` no-outer-retry group can be un-fixme'd (it ran 40/40 here).

## Open risks

- Progress handler cannot cover a single long native operation with no VM/page steps (see S6-01). Fallback if that shows up on devices: raise `livenessTimeoutMs` for `COMMIT`/`import`, not a ping rule.
- A hidden page now has no storage deadlines at all; a worker that truly died while hidden is detected only after the page is visible again (by the restarted deadline/liveness tick).
- 15 s boot budget is a policy, not a browser guarantee; Safari and real devices are untested. On exhaustion the user sees INIT_FAILED with the attempt list and can retry; nothing is wiped.
- Multiple empty `u-*` orphans: only one is adopted; the rest stay until a later explicit, membership-checked cleanup (not implemented).
