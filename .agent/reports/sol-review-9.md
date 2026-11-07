# sol-review-9 — re-verification after fix round l

## Verdict: yes — code-safety re-verification; no P1 remains

No P0 or P1 remains in the product paths inspected and exercised in this round. S8-01's cross-owner role mutation is fixed: my real IndexedDB/uninstall/two-page reproduction now retains ownership until the uninstall receipt finishes, then permits a consistent takeover. S8-02's healthy-executor false death is fixed in an independently exercised real-WASM probe. S8-03 now correctly discards a hung initializer's worker rather than retrying its cached pending promise; its claimed single elapsed boot budget still has a P2 accounting gap. The required gates each have a successful execution in this review, but the mobile gate is flaky: its first two full runs failed, and the third passed. Fix the P2 test reliability issues rather than representing this as an uninterrupted green run. This is not a declaration that all W01–W14 release evidence is complete, or permission to set the atomic-proof flag true. Physical Safari/device and release-origin evidence is listed separately below, not used to invent a remaining P1 or a negative code verdict.

## Scope and provenance

- Reviewed HEAD `b432b562e2ebf9c3eb496bb160129b1d4e5a1645`, branch `main`. Inspected the fix-l commit, round-8 report, round-5 carry-forwards, fix-l builder report, original A/B/C/shell reports including B Run 2, BRIEF, WEB-STORAGE, W01–W14, ADR-054/055, director/type contracts, implementation and test bodies.
- `git diff --stat HEAD -- packages/core` returned **empty**, at the initial and subsequent checks. The task's approved nonempty core exception is historical/committed, not a current working-tree diff. Inspected it with `git diff --ignore-space-at-eol ec4aacf^ ec4aacf -- packages/core/src`: only the structural unknown-COMMIT recognition and latch/throw branch in `db/sql.ts` are semantic source changes. Fix l adds no core change.
- Ignored evolving concurrent `web-install`, `persistence-failed`, `pack-install` and `routes/dev/**` working files. For the atomic browser matrix I read **committed HEAD** using `git show HEAD:apps/mobile/e2e/web-install.spec.ts`.
- Only authored repository file: this report. No implementation/dependency/contract edits, commit/push/stash, server start/kill or screenshots. Required test runners used their normal cache/temp behavior. Browser fixtures were in the isolated named `sol-review-9` profile, not the owner's collection.
- Own browser execution: owner's existing `https://127.0.0.1:3200/harness.html`, HeadlessChrome/145.0.0.0, Windows, text/DOM/JS only. Real IDB, Web Locks, SQL worker and sahpool where stated; scripted worker probes are explicitly labeled. No production SW/deploy, physical Safari, phone, physical power-loss or full-EN memory run.
- Vite's loaded graph contains timestamped module URLs. The handoff probe imported the exact loaded app-database, handoff, gate, job-registry and client modules. Setup initially held the real lock through an unversioned lock module; before the tested schedule, released that setup lock and acquired it through the exact app-loaded lock module, which reported `granted`. This is a controlled handoff test, **not** independent proof of ordinary application startup lock ordering.
- A synchronous browser evaluation exceeded the helper's 5 s reply wait; it is not counted as a measured pass. The retained long-SQL evidence below came from a separately started asynchronous probe and later result readback. An inline Node/Playwright attempt was blocked by unattended approval before execution; no Playwright CLI result is claimed. Background-throttled timer trials were inconclusive for elapsed-budget timing and are excluded; the retained budget probe explicitly ran visible.

## Commands independently executed

Every shell began `cd C:/Projects/flashydex`. Durations below are actual runner output, not benchmarks.

| Command | Exit | Actual output |
|---|---:|---|
| `npm run typecheck` | 0 | Core/schemas `tsc --noEmit -p tsconfig.json`; mobile `tsc --noEmit -p tsconfig.app.json && tsc --noEmit -p tsconfig.node.json`; no errors. |
| `npm run lint` | 0 | `eslint .`: **23 warnings, 0 errors**; React-refresh warnings and unused-disable in `lib/pwa-hooks.ts`. |
| `npm test --workspace=@flashydex/core` | 0 | **34 files, 375 tests passed; 46.26 s**. |
| `npm test --workspace=@flashydex/mobile` — first run | 1 | **31 files passed / 1 failed; 398 tests passed / 1 failed; 40.82 s**. `client-fix-l.test.ts:215`: expected `PoolOpenFailure {hung:true, exhausted:true}`, received `exhausted:false`, in “every attempt is clipped to the remaining total budget…”. |
| Same mobile command — second run | 1 | **32 files / 399 tests passed**, but **1 unhandled rejection**, so the command failed; **40.28 s**. WORKER_DIED from `client.ts:388`, Vitest attributed it to `client-fix-k.test.ts`. |
| Same mobile command — third run | 0 | **32 files / 399 tests passed; 39.79 s**; no unhandled error reported. |
| Mobile `-- --reporter=verbose` plus `client-fix-l.test.ts`, `web-job-fence.test.ts`, `role-store-fence.test.ts`, `app-database.retire.test.ts`, `client-fix-k.test.ts`, `lib/handoff.test.ts` (full source paths) | 1 | **6 files / 72 tests passed**, but **1 unhandled rejection**; **8.61 s**. Same WORKER_DIED family attributed to fix-k tests. |
| Mobile `-- --reporter=verbose src/platform/web-sqlite/client-fix-l.test.ts src/platform/web-sqlite/client-fix-k.test.ts` | 0 | **2 files / 32 tests passed; 4.53 s**; no unhandled error reported. |
| Mobile `-- --reporter=verbose src/platform/pack-install/web-job-fence.test.ts src/platform/web-storage/role-store-fence.test.ts src/platform/app-database.retire.test.ts src/lib/handoff.test.ts` | 0 | **4 files / 40 tests passed; 5.70 s**. |
| `npm test --workspace=@flashydex/catalog-builder` | 0 | Additional ADR check: **3 files / 27 tests passed; 1.15 s**. |
| `npm run typecheck --workspace=@flashydex/catalog-builder` | 0 | `tsc --noEmit`; no errors. |

For the six-file command, abbreviated filenames refer respectively to `src/platform/web-sqlite/`, `src/platform/pack-install/`, `src/platform/web-storage/`, `src/platform/`, `src/platform/web-sqlite/`, and `src/lib/` under mobile. These are the same files in the explicit subsequent commands.

I did **not** run the Playwright CLI suites, production build, deployed-header smoke or full-EN/device matrix. Fix-l's two `68 passed` browser runs, `1 passed (18.9s)` full-install run and 9364.9 ms executor probe are **builder-reported**, not mine.

## 1. Re-verification table

Paths abbreviated below are under `apps/mobile/src/` unless explicitly rooted elsewhere. “Fixed” closes the identified defect, not every requirement of the associated W gate.

| Finding | Status | Evidence actually inspected or run | Qualification |
|---|---|---|---|
| **S8-01 — whole-job/control lifetime across handoff (P1)** | **fixed** | `platform/web-storage/job-registry.ts:159–213` observes actual core admission/release SQL; `packages/core/src/db/coordinator.ts:38–67` confirms current statement shapes and service lease boundary. `platform/app-database.ts:50–72,151–157,265–285`, `lib/handoff.ts:212–259`: fence new jobs, keep SQL available for admitted receipts, await jobs **before** SQL gate/drain/retirement/release. `platform/web-storage/role-store.ts:154–175` adds execution-time IDB fence and still resolves committed effects on COMPLETE. Own real queued-IDB/uninstall/two-page probe below now succeeds. Own 40-test named handoff/fence gate passes. | Registry inference is not typed core lifecycle integration: keep the real-core test when changing admission SQL. `run()` treats an operation while **any** job is alive as admitted continuation; it is a global quiescence mechanism, not per-job authorization. Such operations are still tracked/awaited, so this does not recreate post-release mutation in the inspected composition. |
| **S8-02 — queued open killed behind positively progressing SQL (P2)** | **fixed** | `platform/web-sqlite/worker-core.ts:101–126,262–278` attributes progress to synchronous dispatch; `protocol.ts:85–107` carries heartbeat request ID and `started`; `client.ts:346–360,452–487` protects queued deadlines, starts a full execution window, and does not let another executor renew an already-started request. Own real 24M-row SELECT + queued open: **both succeed, 54 heartbeats, 3 started messages, 0 terminations, 13393.9 ms** with 500 ms request / 1500 ms liveness windows. Six corresponding fix-l unit cases passed. | Untagged legacy heartbeats retain the old cap. A native/SAH call that provides no progress for an entire window remains indistinguishable from a stall; no default-window slow-device incidence measured. |
| **S8-03 — pending cached initializer / overlapping reservations (P2)** | **partly** | Pinned `node_modules/@sqlite.org/sqlite-wasm/dist/index.mjs:17228–17237` still caches pending promises. `pool-boot-retry.ts:112–150,171–181` now exits a hung attempt without same-worker retry, marks abandonment, suppresses late reservation/rejection and clips the attempt to the helper's remaining budget. `client.ts:247–270` tears down then replaces the worker while retaining page ownership. Cache-faithful unit cases passed; my scripted client probe created **2 workers**, terminated **1** before success, **maxLive=1**, budgets **[500,475]**, capacity 16. | The original cache-faithfulness/reservation defect is repaired. Whole boot-budget claim remains incomplete: `bootWorkerOnce` gets a budget before ready/WASM/probe waits; see **S9-02**. One new budget assertion also failed intermittently: **S9-01**. Neither is demonstrated corruption. |
| **S5-03 — atomic proof overclaim (P1 carry-forward)** | **partly** | `platform/pack-install/web-store.ts:18–29` remains **false**. Read committed v2, applied-receipt-unknown, kill/no-outer-retry and boundary specs. Role mutations await IDB COMPLETE/abort (`role-store.ts:173–175`). Own core/mobile gates and real handoff/control-boundary probes support the implementation. | Original **true** overclaim remains corrected; no new P1 alleged merely because proof is incomplete. Boundary matrix still uses the default outer-retrying `openCore`; canonical dump covers six selected personal tables (`web-storage/harness.ts:221–233`), not ALL personal data. Before-pointer hook is outside the IDB transaction. Keep flag false until the complete evidence is supplied. `fullInstall:true` is still independent of this flag: it is **not an enforced runtime install switch**. |
| **S5-04 — transaction and job drain (P1 carry-forward)** | **fixed** | `client.ts:758–825` lets the transaction owner finish before closing; gate tracks COMMIT/barrier (`write-gate.ts:149–170`). Whole-job admission fence now precedes SQL closure. Own real uninstall/receipt finishes `ok`, not MAINTENANCE; old-page prepare/open/init reject RETIRED after takeover. Named tests include “handoff waits for an admitted uninstall…”, refusal after fence, expiry/retry, cancellable install, durable install, and COMMIT→afterCommit gap. | The identified SQL deadlock and S8-01 lifetime hole are fixed. W13 stays partial for complete release-SW/dirty-form/offline/device evidence. A permanently latched job whose release transaction cannot start may leave the registry alive; bounded handoff then retains lock and needs recovery/reload, not unsafe forced release. |
| **S5-09 — receipt/fingerprint values (P2)** | **not fixed** | `packages/core/src/services/candidate-validation.ts:24–50,65–80` still verifies actual schema SQL, meta identity/schema, integrity/FKs/languages/counts, but not migration receipt values or `catalog_meta.schema_fingerprint` value. Own core gate: **375 passed**. | Existing P2 contract remainder, not a new hash bypass or executable-pack-SQL finding. Requires approved narrow validation work or explicit contract amendment. |

### Narrow core exception — retained and safe in the inspected scope

`packages/core/src/db/sql.ts:284–303,314–319` recognizes own/details `commitState:'unknown'`, latches/notifies and throws an actual PersistenceError **without guessed ROLLBACK**. Clean COMMIT failures retain rollback/translation; afterCommit errors retain their latch. Inspected six tests in `test/commit-unknown.test.ts` and two in `test/install-commit-unknown.test.ts`; all passed in my core gate. Applied and not-applied receipt outcomes retain both generations until reopen establishes truth. Core `catalog-install.ts:319–347` still avoids undoSwap for persistence uncertainty. Fix-l's adapter observer does not replace this behavior: its delegated `afterCommit`/`reopen` preserve the underlying driver methods. No regression found in this narrow exception.

### Independent real-browser handoff/control evidence

I held a **real** readwrite IDB transaction on the production `flashydex-web-storage-v1/meta` store with repeated reads only. Actual core uninstall was then waiting on role IO, with registry jobs `uninstall:false` and `operation:false`. Requested the registered production handoff with busyReason null to exercise the non-UI admission boundary. A second real page in the **same browser context** queued the real writer Web Lock, without stealing.

    While real role IO remained held (checked after a 2.5 s wait):
      B: waiting
      A handoff:running; uninstall:running
      A retired:false; SQL gate closed:false; admission fence:true
      A active jobs:[uninstall,operation]
    Release the real IDB blocker:
      A uninstall:ok; handoff:ok; jobs:[]
      A retired:true; writer-lock released:true
      B:granted
    B boot/reconcile (no outer storage retry in this probe):
      receipt:{status:absent,generation:2,activeRef:null}
      EN roles:{activeRef:null,previousRef:null,candidates:[]}
      pool files:one USER only; staging:[]; search.total:0
      B new transaction + barrier + readback:ok, rows:[[91]]
    A remaining open after B takeover:
      prepare:RETIRED; catalog open:RETIRED; init:RETIRED
      worker session:null

The scratch table used for B's acknowledged-write readback was dropped. This is not a canonical ALL-personal-data preservation test. A's real small-catalog install before the test succeeded (577 ms in that particular harness run); that is not a full-pack/phone benchmark. B's absent/search-zero outcome is the **correct acknowledged uninstall**, unlike round 8's installed-receipt/null-active inconsistency.

A separate real-IDB test used the production `createIdbStateCell` with an isolated fixture DB and a fence callback: a mutation queued behind a real readwrite blocker was released only after the fence rose. Returned **RETIRED**; exact readback stayed `{v:'before'}`, not attempted `{v:'after'}`. This supplements, rather than relabels, the fake-IDB unit tests.

### Independent real-WASM executor evidence

Actual worker, 24,000,000-row recursive SELECT, second-path open submitted 50 ms later; request window 500 ms, liveness window 1500 ms, monitor interval 250 ms:

    long:{ok:true,rows:[[288000012000000]]}
    second:{ok:true}
    elapsedMs:13393.9; heartbeats:54; started:3; terminations:0

The client was shut down after capturing the result. Shortened windows reproduce policy interactions; these are **not** production-default phone timings. The result crosses the old cap and supports closing S8-02 rather than merely trusting synthetic heartbeat tests.

## 2. Regressions introduced by fix l

1. **New flaky assertion, S9-01:** fix-l's 60 ms remaining-budget test assumes a real setTimeout reaches a fractional monotonic deadline exactly. My first required mobile run disproved that assertion. It passed on later runs; do not erase the first failure.
2. **Residual S8-03 accounting gap, S9-02:** client-supervised restart is new and correct in direction, but the new “ONE total budget” claim does not cover startup work inside each worker. This is bounded availability/diagnostic accuracy, not demonstrated loss.
3. No new P0/P1, promoted-generation deletion, USER migration conflict bypass, unknown-COMMIT cleanup, importer digest, manifest trust or main-thread catalog-buffer regression found in the inspected fix-l changes. S8-01's old lifetime defect did not reproduce after the fix.
4. The unhandled rejection in old fix-k tests is **not claimed introduced by fix l**: its `void client.listFiles()` chatter already lacked a rejection handler. It remains a real required-gate reliability problem discovered in my runs.

## 3. New findings and remaining carry-forward

| ID | Severity | File:line | What | Why it matters | Concrete fix |
|---|---|---|---|---|---|
| **S9-01** | **P2** | `apps/mobile/src/platform/web-sqlite/pool-boot-retry.ts:138–145`; `client-fix-l.test.ts:211–216`; `client-fix-k.test.ts:61–76` (latter two under the same web-sqlite directory) | Required mobile gate is not reliably green. New test sometimes receives `hung:true, exhausted:false` at a nominal 60 ms budget. Separately, fix-k's interval fires `void client.listFiles()` without handling deadline/death rejection. | Own first full run: 398 passed/1 failed. Second full run and six-file targeted run: tests passed but Vitest recorded an unhandled WORKER_DIED rejection, exit 1. Third full run and smaller targeted runs passed. This is execution evidence, not a hypothetical failure, and makes “all gates green” non-reproducible. No default-window production death inferred from shortened test timers. | Define exhaustion from the chosen timeout budget, not a real timer's fractional arrival, if that distinction is intended; use an injected/fake monotonic clock/timer for exact deadline assertions. Catch all chatter promises and stop/clean up workers/timers in finally. Re-run the ordinary full gate repeatedly; do not just suppress unhandled-error checking or increase arbitrary sleeps. |
| **S9-02** | **P2** | `apps/mobile/src/platform/web-sqlite/client.ts:247–256,274–307`; `sql.worker.ts:106–123` (same directory) | The remaining total boot budget is computed **before** awaiting worker ready; its unchanged value is sent after ready. Worker then loads WASM/probes OPFS before starting a fresh helper timer using that value. Those waits can consume the total budget and still leave a full acquisition allowance. | Own **visible-page scripted-worker** probe: total budget 80 ms, ready delayed 150 ms; init still received `bootBudgetMs:80`, then reported hung after its allowance; INIT_FAILED at **249.8 ms**. It models scheduling/accounting, not actual OPFS lingering or phone latency. Existing ready/init watchdogs bound their own phases, but this is not the promised single elapsed budget, especially across replacements. No corruption demonstrated. | Decide explicitly whether the budget is pool acquisition only or whole boot. For ONE total elapsed boot budget, check remaining time again after ready and before sending init; subtract module/probe elapsed time before entering pool retry, clip ready/init waits too, and avoid launching acquisition after exhaustion. Preserve a separately documented visibility/suspension policy. Test delayed ready, slow module/probe, replacement startup and final diagnostics; never wipe files or steal ownership on timeout. |
| **S5-09 (carry-forward)** | **P2** | `packages/core/src/services/candidate-validation.ts:24–50,65–80` | Migration receipt values and metadata fingerprint value remain unchecked. | Full normative validation claim remains incomplete despite actual schema allowlisting. No new SHA/signature bypass demonstrated. | Approve narrowly scoped validator tests/implementation for correctly hashed altered-receipt/fingerprint fixtures, or amend the contract explicitly. |

## Atomic activation, integrity, USER and durability spot re-walk

| WEB-STORAGE §4 crash row | Inspected implementation/evidence this round | Assessment |
|---|---|---|
| Transfer/decode/import incomplete | Intent before allocation `pack-install/web-store.ts:163–167`; checked stage IO; associated-slot import `worker-core.ts:478–558`; boot GC `reconcile.ts:28–79`; passing mobile fault cases. | Failed unique candidate only; no pre-pointer deletion of USER/active/previous found. GC is boot-only under retained ownership, not a concurrent general collector. |
| PREPARED, pointer not committed | Core PREPARED before activate; candidate/expected-active checks `role-state.ts:123–132`; role store COMPLETE/abort and new execution-time fence. | Pointer abort leaves original mapping unchanged. External before-pointer hook is not proof of actual in-transaction abort. |
| Pointer committed, no USER receipt | Same IDB transition preserves old active as previous; core inspect/undoSwap restores prior validated state, first-install absent. | No ordinary precommit generation unlink found. Whole-job handoff now waits across this interval. |
| USER receipt COMMIT uncertain | Approved core PersistenceError/latch branch; core applied/not-applied tests passed; membership-protected discard. | Retain both generations until reopen truth; no blind replay or guessed cleanup. No new physical flush-failure test this round. |
| Receipt committed, cleanup interrupted | `web-store.ts:301–311`: clear previous mapping before retiring file; stale candidate requires membership; core/boot recovery. | Direction retained. Own handoff probe adds a distinct real control boundary, not the full kill matrix. |
| Active invalid, previous valid / neither valid | Core validates previous before restore, role switch precedes displaced-ref retirement. | No new path replacing/deleting USER found. No own both-invalid browser fixture this round. |

- `reconcile.ts:33–40,78–79` confines unlink to catalog refs and protects USER/marker/active/previous/candidates via `referencedPaths`. `cleanupFailedJob` reloads roles (`web-store.ts:119–128`); `discardCandidate` requires current membership (`:307–311`). No ordinary stale-candidate/promoted-generation unlink found. The old ownership hole that erased mappings before valid GC is repaired in my tested schedule.
- Import exactness remains correct for catalogs: reject non-1/1 bytes 18/19 **before** accepting/hash-feeding the first chunk (`worker-core.ts:522–532,641–656`), hash supplied chunks and verify bytes/geometry/digest (`:544–549`). Pinned import's forced 1/1 rewrite (`index.mjs:16805`) therefore does not change accepted catalog bytes. USER-only normalization precedes stored-byte hashing and separately retains sourceSha256. Checked-write/hash/header tests passed with the mobile gate.
- Public placeholder association happens before async hashing/import (`worker-core.ts:500–509`); pinned chunk import uses an already-associated SAH first (`index.mjs:16784–16796`). Concurrent USER journal allocation cannot select that associated slot. Supplier short reads and pinned chunk short writes fail closed. Kill can leave a unique intent-backed orphan; it must not overwrite active. No own real quota/slot-exhaustion kill matrix this round.
- Writable open/readback still requires FULL/DELETE/FKs/mmap=0 (`worker-core.ts:281–308`); pinned association flush inspected. Barrier is ordered health acknowledgment, not whole-file export or a new fsync API. Client death/ambiguous COMMIT/barrier latch; explicit reopen reads durable files with no replay.
- USER §5 still fails closed for marker/role conflict, migrated role without matching marker, fresh unmarked role plus legacy, marker without role, missing/unreadable/future USER and nonempty/unreadable u-* orphans (`legacy-migration.ts:249–300,320–367`). The old A-reported “unmarked role + legacy -> existing” deviation is **not current code**. Migration validates staged integrity/FKs/history, resets only operational state, checks personal counts, closes/barriers, commits role+marker together, and does not delete the legacy key (`:379–425`). Canonical/no-duplicate unit cases passed; no own real full migration kill matrix.

## Director flags, proof status and ADR-055

### Liveness and killed-page SAH recovery

The director's original ping-only 30 s false-death concern is no longer the implementation: worker-side SQLite progress heartbeats execute **inside** synchronous sqlite3_step/integrity_check. Fix l additionally attributes those heartbeats so queued opens cannot kill a positively progressing executor. My real-WASM result above supports this; merely increasing liveness to an arbitrary large total SQL duration or disabling watchdogs indefinitely would be worse.

Keep separate policies for queued work, executing work with progress and async acquisition with no progress. A single native OPFS call can still block without reaching a SQLite callback; that is an uncertainty/recovery case, not proof of rollback. Visibility throttling must not count as death. A hung promise alone is a hang/unknown outcome, not acknowledged data loss; forced replay/lock stealing would make it unsafe. Long imports also must not be treated as atomically cancellable SQLite statements.

The old `10 × 300 ms` policy is gone. Current pool policy is elapsed 15 s, capped exponential backoff/jitter, forced re-init after **settled rejection**, preservation flags explicit; hung acquisition discards the worker before replacement. `prepareStorage` uses this client path and clears its failed memoized promise for safe retry. No guaranteed Chromium/Safari SAH-linger maximum is established by this repository or these tests. Fifteen seconds is a UX retry policy, not a browser guarantee. On exhaustion preserve files, refuse unsafe access and offer retry/reload under correct ownership; do not wipe/pause a live owner's VFS or steal a Web Lock. S9-02 qualifies the advertised total bound, not the settled-rejection cache repair.

The old image-spec assumption is also stale: inspected `e2e/pwa-image-cache.spec.ts:28–45,48–88`, now separating production skip-when-busy from controlled ledger admission. Product handler obtains a slot **before** clone and starts capped reads immediately (`image-cache/handler.ts:38–61`). I did not run that browser spec. Neither stale director flag is reported as a new current P1.

Keep `WEB_ATOMIC_ACTIVATION_PROVEN=false`. B Run 2 alone never justified true; fix-l's reported suite totals and my repaired handoff boundary do not independently prove ALL-personal/no-outer-boundary/actual-IDB-abort coverage. `web-port.ts:20–25` still advertises fullInstall true independently, so calling this flag a production “gate” is inaccurate. Distinguish release evidence from runtime capability.

### ADR-055: accept-with-conditions

- `tools/catalog-builder/src/build-db.ts:36,47–50,109–113,149–152` sets 65536 before schema creation, remains DELETE, VACUUMs and verifies the closed output. My builder tests/typecheck pass.
- Bytes **16/17** encode page size; **0,1** is the 65536 sentinel. Bytes **18/19** are independent read/write format versions and must be **1,1** for catalogs. Current importer accepts old 4 KiB as well as 64 KiB geometry (`worker-core.ts:646–653`); no runtime fixed-64-KiB requirement was added.
- Pinned chunk import is a byte stream, not page-aligned; B's <=256 KiB decoder/import chunks can span page boundaries. Negative cache_size means **KiB**, independent of page size (`worker-core.ts:288`); validation default is 32768 KiB (`client.ts:80`), not frozen contract comment's 1024. Cache suggestion is not total WASM memory.
- New physical layout changes bytes/hash/length: publish **new immutable versions**, never mutate old published artifacts. Future page deltas must bind exact base/target/geometry; a 4→64 KiB geometry transition needs full-pack fallback unless explicitly rebuilt. API-refreshed active files are not automatically immutable delta bases.
- Standard SQLite format compatibility is not shipped native Capacitor/SQLCipher device evidence. Keep later native enablement contingent on actual open/integrity/refresh/rollback runs; no format reason to reject the web decision.
- Supplied director full-EN numbers (16.5 s total; download/decode/import/validate 0.4/7.9/3.2/4.0 s; aggregate JS 35 MB; storage 121.7 MB; search/reload OK) are **not my measurements**. They support the change, not a slow-device timing ceiling or full ADR-054 closure.

## Trust and memory

- Sole default trusted pack origin remains `https://flashydex-catalog-packs.netlify.app` (`catalog-config.ts:4,16–22`); app-origin trust is DEV-only, explicit build overrides are not additional defaults. No .env/credentials read.
- Pack-host/manifests/.zst/.db/dev-packs route before navigation/precache (`pwa/routes.ts:29–45`); `sw-core.ts:32–33` is network-only without cache fallback. Product manifest/pack fetches supply no-store and validate final origins. JSON-present signatures including null reject (`packages/core/src/services/manifest-validation.ts:56–59`). No deployed headers/CORS/SW readback this round.
- No fix-l catalog-sized main-thread allocation found. Catalog staging/import transfers refs/counters with <=256 KiB slices; decoder output/window remain bounded. USER migration/legacy export are explicit whole-USER exceptions, including IDB clone before size-cap inspection. DEV fixture export is not permission for product catalog export.
- Supplied 35 MB JS is below ADR-054's JS threshold, but does not prove separately committed WASM<=96 MiB/non-overlapping combined<160 MiB, no missed worker peaks or sustained EN+JA. No own full allocation trace. Retaining the first network chunk as zstd-header scratch (`opfs-stage.worker.ts:125–129`) remains a worker-side strict input-budget qualification, not demonstrated main-thread catalog buffering.

## 4. Updated W01–W14

Whole-gate statuses, not just defect closure. No absent owner-device result is reclassified as a product P1.

| Gate | Status | Evidence actually inspected/run; remainder |
|---|---|---|
| W01 | partial | Own real worker/sahpool boot plus takeover boot; core/mobile gates, cache-faithful retry tests and scripted fresh-worker supervision pass. Preservation/pin retained. Whole elapsed-bound qualification S9-02; complete release failure matrix not independently rerun. |
| W02 | partial | Own 375 core/399 mobile successful runs, named deadline/retirement suites and real long-SQL+queued-open survival. Narrow core exception safe. Mobile runs also exposed S9-01; full release parity not rerun. |
| W03 | partial | Streaming/header/hash source and passing mobile/builder units; director full-EN numbers supplied, not rerun. No own all-worker allocation/WASM/combined/sustained-EN+JA or Safari trace. |
| W04 | partial | Own real small install, acknowledged uninstall, B boot/reconcile and transaction/barrier/readback. No complete offline installed-PWA close-all/personal/custom/settings/history/export matrix. |
| W05 | partial | Core applied/not-applied unknown-COMMIT tests pass; source crash-row walk; committed v2/kill/boundary specs inspected. Flag honestly false. ALL-personal/no-outer-boundary/actual-IDB-abort proof remains incomplete; S8-01 control boundary now independently passes. |
| W06 | partial | Associated-slot/pinned importer, exact-byte/header policy and checked IO inspected; mobile import/fault units pass. Original A interleave report inspected. No own full real slot/quota exhaustion or import-kill release/device matrix. |
| W07 | partial | Protection/install source and original C report; mobile controller tests pass. Actual Safari grants/container/privacy/extended-use outcomes unmeasured. |
| W08 | open | Core synthetic gates pass. Small harness installs/searches and director full search do not provide real-EN 10-warmup/100-sample p50/p95/max/raw evidence. |
| W09 | partial | Own real same-context held-IDB handoff: B waits, A finishes receipt before release, B boots/writes, A stays retired. S8-01 fixed in this schedule. Normal bootstrap ordering source retained; no physical tab/Home Screen sharing run. |
| W10 | partial | Role/marker/legacy/all-orphan decision source and migration units pass; retained legacy/raw-export source inspected. No own full real-IDB migration marker-boundary kill matrix; whole-value/OPFS-only rescue qualifications remain. |
| W11 | partial | Trust/network-only routes/source and mobile units; original C release-SW report inspected. No own production build/offline lazy-worker or Netlify canonical/headers/WASM MIME/CSP readback. |
| W12 | partial | Bounded clone admission and corrected image-spec assumptions inspected; mobile cache/ledger tests pass. No own full-cap real-SW termination/quota execution. |
| W13 | partial | Own named handoff/fence units plus real two-page queued-IDB/uninstall/receipt/retirement reproduction pass. Identified S5-04/S8-01 safety defects fixed. Complete release-SW dirty/busy/restore/offline/device matrix still outstanding. |
| W14 | partial | Lazy healthy-boot source, real takeover recovery, deadline/boot tests and progress supervision inspected/run. S9-01/02 qualifications. No own mid-range-phone 10-cold-launch offline p95/resume/EN+JA measurements. |

## 5. [needs owner input] — separate from code verdict

- Physical Safari iOS/iPadOS 17 and 18, tab **and** Home Screen: exact device/OS/build/origin; full 64 KiB EN plus legacy 4 KiB compatibility; Inspector memory; kill/recovery/low-space/offline personal-data and external backup round-trip. Record unavailable metrics honestly.
- Actual persisted()/persist() outcomes, tab/Home Screen storage/lock/container identity and safe external backup before switching origin/container. Real extended Safari-use lifecycle observation, not simulated elapsed-days evidence.
- Canonical release build/immutable manifest identity and production hash/length/CORS/no-store/redirect/SW scope/WASM MIME/CSP readback; offline/update smoke. Nothing deployed by this review.
- Mid-range-phone startup/resume, real-EN raw search sample set, all-worker JS/WASM attribution and sustained EN+JA high-water evidence.
- Native 64 KiB Capacitor/SQLCipher open/integrity/refresh/rollback before later native enablement; not a reason to reject web repaging.
- Director-approved S5-09 validator scope or contract amendment. Reconcile frozen RETIRED/error/diagnostic/drain/retirement seams and validation-cache comment; no unauthorized contract/core edits made here.

**Bottom line:** the round-8 P1 is fixed in independently executed real storage/ownership evidence. **No P1 remains.** Keep the atomic proof flag false, retain honest partial W statuses, and address the remaining P2s without discarding the working lifetime fence, executor-attributed progress or fresh-worker hung-boot supervision.
