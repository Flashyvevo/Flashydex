# sol-review-8 — independent re-verification after fix round k

## Verdict: no

One P1 remains: an already-admitted catalog role mutation can outlive retirement and commit after another page owns the writer lock (S8-01). I reproduced this with the production core uninstall, real IndexedDB role transaction, real handoff, real Web Locks and sahpool in isolated Chromium. The new terminal fence fixes the specific lazy-worker-reopen defect, but does not drain/fence in-flight IDB/control operations or the complete uninstall job. A retired page cleared the active mapping; its subsequent USER receipt transaction failed MAINTENANCE; takeover recovery deleted the now-orphan catalog and reported absent. Personal rows were not demonstrated lost. All four required gates pass. S7-02 is fixed; S7-03 fixes ping-renewed infinite deadlines but adds a reproducible busy-worker false-death edge and overstates hung-acquisition retry recovery. No P0 found. Device/Safari evidence is separate, not the reason for this verdict.

## Scope and provenance

- Reviewed HEAD `96d07d1b7e70855858865ea620d88e9e85fab4f4`, branch `main`; rechecked after the gates/source review. Read round 7, round-5 carry-forwards, fix-k report, original A/B/C/shell reports including B Run 2, BRIEF, WEB-STORAGE, W01–W14, ADR-054/055, seam contracts, relevant implementation/tests and the pinned importer/initializer.
- `git diff --stat HEAD -- packages/core` returned **empty**. The approved core exception is committed, not a working-tree change: `git diff --ignore-space-at-eol ec4aacf^ ec4aacf -- packages/core/src` shows **13 semantic added lines in `db/sql.ts` only**. Raw numstat includes line-ending churn. Fix k makes no further core change. See safety assessment below rather than treating an empty working diff as proof the exception is absent.
- Concurrently assigned `e2e/web-install.spec.ts` was inspected from **committed HEAD using `git show`**; no findings are based on the evolving working file, `persistence-failed.spec.ts`, `pack-install.spec.ts` or `routes/dev/**`.
- Only authored repository file: this report. No implementation changes, dependency installation, commit/push/stash, server start/kill or screenshots. Required tests used their normal runner/cache behavior. Browser fixtures changed only isolated review-profile storage, never the owner's collection/profile.
- Own browser execution: named `sol-review-8` session, owner's existing HTTPS dev server, `HeadlessChrome/145.0.0.0` on Windows; text/DOM/JS only. Not production SW/Netlify, physical Safari, phone or power-loss execution.
- Vite's live module graph included timestamped HMR URLs. Early unversioned handoff probes loaded different singletons and are **inconclusive, excluded**. Retained handoff evidence below imports the exact loaded app/handoff/lock module URLs and confirms the bridge/runtime client identity. A popup attempt was blocked; the successful two-page probes used ordinary tool-created same-context tabs and BroadcastChannel only for test coordination.
- Harness preparation is not a lock-order startup test: one setup acquired the exact app-module lock after synthetic harness boot, before exercising handoff. The takeover page acquired the real writer lock **before** boot. Ordinary app bootstrap lock ordering is assessed from source and existing tests, not claimed proven by that setup.

### Commands I executed

Every shell began `cd C:/Projects/flashydex`.

| Command | Exit | Actual output |
|---|---:|---|
| `npm run typecheck` | 0 | Core/schemas `tsc --noEmit -p tsconfig.json`; mobile `tsc --noEmit -p tsconfig.app.json && tsc --noEmit -p tsconfig.node.json`; no errors. |
| `npm run lint` | 0 | `eslint .`: **23 warnings, 0 errors**; React-refresh warnings and unused-disable in `lib/pwa-hooks.ts`. |
| `npm test --workspace=@flashydex/core` | 0 | **34 files passed; 375 tests passed; 49.73 s**. |
| `npm test --workspace=@flashydex/mobile` | 0 | **29 files passed; 374 tests passed; 37.53 s**. |
| `npm test --workspace=@flashydex/mobile -- --reporter=verbose src/platform/web-sqlite/client-fix-k.test.ts src/platform/app-database.retire.test.ts src/platform/web-sqlite/client-fix-j.test.ts src/platform/web-sqlite/sql-class.test.ts src/platform/web-sqlite/pool-boot-retry.test.ts src/lib/handoff.test.ts` | 0 | **6 files; 84 tests passed; 7.26 s**. Includes retirement/queued reopen, both live-ping stalled-init variants, unrelated replies/progress, heartbeat cap, hidden/resume, real-WASM integrity/SELECT heartbeats, classifier/savepoints, drain/error/order and job-quiescence cases. |
| `npm test --workspace=@flashydex/catalog-builder` | 0 | Additional ADR check: **3 files; 27 tests passed; 1.41 s**. |
| `npm run typecheck --workspace=@flashydex/catalog-builder` | 0 | `tsc --noEmit`; no errors. |

I did **not** run the Playwright CLI suites, production build, full-EN timing/memory trace, physical-device matrix or deployed-header smoke. Fix-k's two `63 passed (2.1m)` browser runs and `1 passed (18.5s)` full-install run are **builder-reported**, not mine. Passing tests do not cover the new schedules below.

## 1. Re-verification table

Abbreviations in references mean `apps/mobile/src/platform/` unless an explicit repository path is shown. “Fixed” closes the identified defect, not the entire W gate.

| Finding | Status | Evidence actually inspected/run | Remaining qualification |
|---|---|---|---|
| **S7-01 — terminal storage retirement (P1)** | **partly** | `web-storage/write-gate.ts:19–23`, `web-sqlite/client.ts:206–230,263–267,495–535,675–697,771–826`, `app-database.ts:26–62,122–147,194–218,253–273`: synchronous fence; cached/new init and new/queued opens/reopens refuse; opened-mid-retirement handles close. My named tests pass, including “a delayed reopen already queued behind a running statement…” and “retireStorage() keeps the lock when a close step fails…”. Correct-module browser probe returned RETIRED for prepare, lazy catalog open, init and list; stopped session null, no held writer lock. | Specific lazy pool-reacquisition reproduction is repaired. Complete retirement is not: admitted role-store/control work is outside SQL drain and can commit after release. **S8-01 independently reproduced**, including a real queued IDB transaction, not only a paused mock. |
| **S7-02 — conservative SQL tokenizer (P2)** | **fixed** | `web-sqlite/sql-class.ts:42–100,109–169`: one lexical pass; quoted tokens retain comment-like content; leading semicolons and quoted/schema-qualified PRAGMAs handled; uncertain forms default write. My 84-test pass includes all six S7 tokenizer tests and gate/savepoint tests. Own real-sahpool closed-gate and **latched-client** probes reject all three exact round-7 spellings; row/version readback confirms no mutation. | WITH remains deliberately conservative/heuristic, not a full SQL parser. No remaining executable bypass demonstrated in this review. The separate worker executor still determines actual prepared-statement readonly/tail semantics. |
| **S7-03 — per-request deadlines / bounded boot attempt (P2)** | **partly** | `client.ts:295–325,381–450` no longer lets ping/STALE_SESSION/unrelated replies renew another request. Independent 80 ms scripted init with live STALE_SESSION pings: INIT_FAILED in **81.5 ms**, **8** pings, **1** termination. Named stuck-open/own-progress/wrong-progress/hidden tests all pass. `pool-boot-retry.ts:96–129` bounds the caller's wait for one attempt. | New heartbeat cap can terminate a **healthy busy executor** because an unrelated open is queued behind it (**S8-02**). Timeout does not cancel a pending pinned initializer; force applies only after actual rejection, so the builder's hung-init recovery test models the wrong cache semantics (**S8-03**). Infinite ping renewal itself is fixed. |
| **S5-03 — atomic proof overclaim (P1 carry-forward)** | **partly** | `pack-install/web-store.ts:18–29` remains **false**; mobile gate passes its false-capability assertion. Read committed v2/receipt-unknown/kill/boundary specs and fix-k's reported runs. Role transactions await COMPLETE/abort (`role-store.ts:142–162`). | False is honest; the original true overclaim is fixed, not a second newly demonstrated P1. Complete normative proof remains open: boundary cases retain outer boot retry, personal canon selects six tables, no own complete release matrix. S8-01 adds a missing handoff/control boundary. `fullInstall:true` still means false atomicActivation is **not an enforced production install switch**. Do not flip true from fix-k's suite total. |
| **S5-04 — transaction/job drain (P1 carry-forward)** | **partly** | `client.ts:700–719,739–767` lets the current transaction owner finish plus barrier; `handoff.ts:188–222` orders gate/drain/retire/shutdown/release. Own unit gates pass original admitted-write/drain/error cases; browser confirms SQL worker is stopped before release. `transfer-sync-hooks.ts:14–31` adds active-sync busy registration. | Original SQL close-before-COMMIT deadlock stays fixed. Job-lifetime quiescence is incomplete: uninstall/rollback hooks do not register busy (`data/install-hooks.ts:94–104`); their role IO and later USER transaction are not one drained admission. **S8-01**. Sync registration is observer-hook based, not universal service-lifetime tracking. |
| **S5-09 — receipt/fingerprint values (P2)** | **not fixed** | `packages/core/src/services/candidate-validation.ts:24–50,65–80` still checks actual schema SQL and metadata identity, integrity/FKs/language/counts, but not migration receipt values or `catalog_meta.schema_fingerprint` value. Core diff inspected; own 375-test core pass. | Carry-forward P2, not a new hash/signature bypass. Needs separately approved narrow validation change or explicit contract amendment. |

### Narrow core exception: safe direction retained

`packages/core/src/db/sql.ts:284–303,314–319` structurally recognizes own/details `commitState:'unknown'`, latches/notifies and throws a real PersistenceError **without guessed ROLLBACK**. Clean failures retain rollback/error translation; afterCommit failure stays latched. Inspected `test/commit-unknown.test.ts` (six tests) and `test/install-commit-unknown.test.ts` (two, applied/not-applied receipt COMMIT); all passed within my core gate. Recover reopens actual durable truth and never replays. `catalog-install.ts:319–347` retains both generations on persistence uncertainty. No regression found in this approved semantic core change. The S8-01 problem is not that COMMIT fix: the role mutation commits before the later USER transaction is even admitted.

## 2. Regressions introduced by fix k

1. **S8-02:** the new six-deadline heartbeat cap reintroduces false worker death for a queued open behind legitimate synchronous work. I reproduced the cap with actual WASM and ongoing heartbeats. This is a new edge, not a claim that the old 30 s silence-only integrity_check bug remains wholly unfixed.
2. **S8-03:** the new Promise.race timeout abandons only a caller, not the underlying initializer/reservation. Hung-acquire recovery is overstated by a non-caching fake; settled-rejection retries from fix j still work. Late completions can leave overlapping reservation callers. No resulting byte corruption was observed.
3. **S8-01 is a residual lifetime/admission flaw**, not evidence that the new lazy-open fence itself regressed. The synchronous fence and explicit release ordering should stay. Increasing retry duration or removing lock release would conceal rather than repair control work crossing ownership.
4. No core COMMIT, catalog hashing, main-thread whole-catalog allocation, USER role/marker or manifest-trust regression found in the inspected fix-k changes. No new failing required gate.

## 3. Findings

| ID | Severity | File:line | What | Why it matters | Concrete fix |
|---|---|---|---|---|---|
| **S8-01** | **P1** | `apps/mobile/src/platform/app-database.ts:49–60,253–273`; `platform/pack-install/web-store.ts:329–332`; `platform/web-storage/role-store.ts:142–162`; `lib/handoff.ts:188–218`; `data/install-hooks.ts:94–104`; `packages/core/src/services/catalog-install.ts:489–510` | Retirement drains SQL paths, not already-admitted role-store operations or complete catalog jobs. An uninstall can wait in role IO, survive the fence/shutdown/release, clear mappings while B owns the lock, then fail its USER receipt transaction on A's closed write gate. | Independently reproduced with actual IDB queued behind a fixture-held transaction. B acquired the real lock; A, retired, then committed clearLanguage. B's boot removed the orphan catalog and returned receipt absent/search total 0. Earlier paused-role variant let B boot/search 201/write before A cleared the mapping, exposing installed receipt + null active simultaneously. This is cross-owner metadata corruption/catalog availability loss, not demonstrated personal-data loss. | Stop admission and track **whole** install/uninstall/rollback/control job lifetimes, including IDB transitions and final USER receipts. Refuse/recoverably defer handoff while any such job is active, or drain it under explicit admitted-job authorization before closing its ability to finish receipts. Keep the lock until all admitted IDB/control requests have settled/been safely aborted. Fence queued role transitions at their transaction execution point; distinguish already-committed effects instead of rejecting after commit and claiming nothing happened. Add real queued-IDB + uninstall/rollback handoff cases with A remaining open and B takeover/recovery. Do not rely only on UI install flag/40 ms SQL quiet. |
| **S8-02** | **P2** | `apps/mobile/src/platform/web-sqlite/client.ts:74–75,401–428,442–450`; `platform/web-sqlite/worker-core.ts:238–260` | Heartbeats from a healthy long SQL statement stop extending all pending open/reopen deadlines after the fixed cap. An unrelated open queued in the worker's single-threaded event loop then kills that worker, including the legitimate statement. | Real-WASM reproduction with request window 500 ms and liveness window 1500 ms: long recursive SELECT + queued second-path open -> both WORKER_DIED/unknown at **3506.5 ms**, despite **15** heartbeats; **1** termination. Production uses a much larger cap, but it is still not executor-aware; hidden wall time also consumes cap age. No default-window phone failure or personal loss measured. | Distinguish queued requests from currently executing operations and async acquisition stalls. Attribute worker progress to the executing request; let positively progressing executor work protect queued opens without a global arbitrary kill cap. Use a bounded/no-progress policy for genuinely stalled async startup/open, plus soft recovery UI. Do not revive ping-based infinite renewal or infer rollback/replay from timeout. Test real sync work + concurrent open/reopen and hidden/resume beyond cap age. |
| **S8-03** | **P2** | `apps/mobile/src/platform/web-sqlite/pool-boot-retry.ts:90–105,118–129,150–158`; `platform/web-sqlite/client-fix-k.test.ts:132–168`; pinned `node_modules/@sqlite.org/sqlite-wasm/dist/index.mjs:17228–17237,16912–16914` | An 8 s caller timeout does not reject/cancel the cached pending install promise. `forceReinitIfPreviouslyFailed` only retries **rejected**, not pending promises. The hung-attempt tests return a new successful promise on call two, unlike the pinned implementation. | Independent cache-faithful pending-promise model with the real production helper: **4 calls, 1 acquisition**, PoolOpenFailure/exhausted after **99.4 ms** at a 100 ms test budget. This now fails bounded rather than hanging, which is useful; it does not recover by forced reacquisition. If a timed-out install later succeeds, abandoned and current callers can both call reserveMinimumCapacity; no corruption measured. A new attempt also is not clipped to remaining total budget. | Retry only settled transient acquisition failures in the same initializer. For a truly hung acquisition, supervise the entire worker boot, terminate/discard that worker under retained ownership and retry a fresh worker with preservation flags/backoff, or fail bounded with safe Retry. Do not race live reservations in one pool. Test pending cached initialization, late resolve/reject and single-reservation invariants against the pinned cache, and enforce/document the actual total-budget policy. |
| **S5-09 (carry-forward)** | **P2** | `packages/core/src/services/candidate-validation.ts:24–50,65–80` | Migration receipt values and metadata fingerprint value remain unchecked. | Normative validator claim remains incomplete despite actual schema allowlisting; no new integrity bypass demonstrated. | Approve narrow core work with altered-receipt/fingerprint correctly hashed fixtures, or amend the contract explicitly. |

### Independent browser evidence and reproduction details

**S8-01, paused-role schedule (first independent variant).** Real core `harness.uninstallCore()` paused at the production RoleStore.clearLanguage call, then real registered handoff completed. This injected schedule models control work already admitted but delayed; it did not replace core, write fake receipts or invent an IDB result. Exact loaded module identities were used.

    A after handoff:
      retired:true, writer locks:[], SQL session:null
      prepare/catalog-open/init/list -> RETIRED
    B after taking the writer lock:
      lock:granted, search.total:201, USER scratch rows:[[73]]
    Resume A's already-admitted uninstall:
      A error:{code:MAINTENANCE}; A retired:true
      A and B roles.en:{activeRef:null,previousRef:null,candidates:[]}
      B receipt:{status:installed,version:2026.10.31.001,activeRef:<old-ref>}
      B pool still contains <old-ref>; another USER write:ok
    B reload/recover:
      scratch rows:[[73],[74]]; no catalog files
      receipt:{status:absent,generation:2}; search:{total:0,names:[]}

The scratch rows were then dropped. They establish retained acknowledged test writes, not canonical equality of ALL personal tables. The old-ref was `/catalog-en/g-5p6u186d6p5m1e72.db` in this isolated run.

**S8-01, real queued-IDB confirmation (stronger second variant).** To avoid relying only on a wrapped RoleStore method, I repeated with an actual production `createIdbStateCell.mutate` transaction queued behind a fixture-held readwrite transaction on the same `meta` store. The fixture kept its transaction alive with read requests only. An IDBDatabase.transaction shim inserted that blocker, then returned the **real production transaction** unchanged. No role method/result/record was substituted. The blocker was released only after B acquired the writer lock.

    A: install:true, actual role mutation queued:true,
       registered handoff completed, retired:true, held locks:[]
    B: lock:granted (sole held flashydex-user-writer)
    Release IDB blocker:
      A uninstall -> MAINTENANCE; A retired:true; roles.activeRef:null
      B boot/reconcile -> files only /user/*, receipt:absent,
                         generation:4, search.total:0

No natural user-click/timing incidence or physical browser stall frequency is claimed. This is a controlled, executable schedule through real IDB and production services that the retirement invariant must cover. A queued IDB transaction can execute after its caller's SQL is quiet; SAH exclusivity does not protect IDB metadata. The normal factory/two-tab tests never hold such control work in flight.

**S7-02, exact round-7 inputs.** Real sahpool driver, table `t`, gate closed:

    WITH x AS (SELECT '--') INSERT INTO t VALUES(1) -> write / MAINTENANCE
    PRAGMA "user_version" = 99                     -> write / MAINTENANCE
    ; INSERT INTO t VALUES(2)                      -> write / MAINTENANCE
    readback: rows:[], user_version:[[0]]

A second actual-worker test replaced a successful COMMIT acknowledgement with IO/unknown, then tried the same three strings. All returned IO from the write latch; explicit reopen showed rows `[[73]]` exactly once and user_version `[[0]]`. Thus the classifier is exercised at **both** protective consumers, beyond the builder's shared-call-site argument. Fixture file closed/unlinked afterward. This models lost acknowledgement, not an actual physical flush failure.

**Liveness/deadlines.** Existing real-worker `long-sql-liveness` harness, six-million-row recursive SELECT, 1000 ms silence window/50 ms interval:

    outcome.ok:true; rows:[[18000003000000]]
    elapsedMs:2751.9; terminatedBeforeShutdown:0

This supports the fix-j heartbeat remedy for the director's ordinary synchronous-SQL concern. The separate S8-02 cap probe ran a longer actual synchronous SELECT, opened another path while it was busy and counted heartbeats/termination through the real Worker transport. Shortened request windows are policy reproducers, **not production phone timing measurements**. A preliminary 200 ms request window was shorter than the 250 ms heartbeat interval and is not the cap proof; the retained 500 ms/15-heartbeat run above is. An initial hidden-page probe paused correctly and exceeded the tool's evaluation wait; visible-page retry supplied the retained 81.5 ms stalled-init result.

## Atomic activation, integrity, migration and durability re-walk

| WEB-STORAGE §4 row | Source/evidence inspected this round | Assessment |
|---|---|---|
| Transfer/decode/import incomplete | Intent before allocation `web-store.ts:163–167`; checked staging writes/hashes; associated-target import `worker-core.ts:472–542`; reconcile `reconcile.ts:28–79`; mobile crash/fault tests passed. | No new pre-pointer unlink of USER/active/previous found. Unique failed target only; boot-only GC premise essential. |
| PREPARED, pointer not committed | Core journal before activate; candidate membership/expected-active checks `role-state.ts:123–132`; IDB COMPLETE/abort `role-store.ts:142–162`; committed boundary specs inspected. | Normal activation direction remains sound. Before-pointer hook is outside transaction, not proof of every real IDB abort. My queued-IDB handoff test exposes a separate ownership window. |
| Pointer committed, no USER receipt | Old active preserved as previous in one IDB transition; core inspect/undoSwap restores validated prior state/first-install absent. | No normal precommit generation unlink found. Whole-job handoff cannot interrupt between role effect and later receipt without recovery semantics: S8-01. |
| USER receipt COMMIT uncertain | Approved core latch/PersistenceError plus physical client latch; applied/not-applied core tests passed; real lost-ack latch probe above. | Both generations retained pending reopen truth; no blind replay or guessed cleanup. |
| Receipt committed, cleanup interrupted | `web-store.ts:301–304` clears previous mapping before unlink; boot orphan GC/core recovery; unit crash tests passed. | Direction preserved. Actual boundary matrix not independently rerun. |
| Active invalid / previous valid / neither valid | Core validates previous before restore, `restorePrevious` switches metadata before retirement, failure isolates catalog rather than replacing USER. | No new normal-path regression found; no own both-invalid browser fixture this round. |

- `discardCandidate` still checks membership (`web-store.ts:307–311`); failed-job cleanup reloads roles (`:119–128`). Reconcile confines deletion to catalog paths and protects role USER/marker/active/previous/candidates. No ordinary stale candidate can unlink a promoted generation. **S8-01 loses the mapping first**, after which otherwise-correct GC considers that catalog orphaned.
- Activation/restore/discard/remove mutate metadata before retirement (`web-store.ts:275–279,292–304,329–332`). No `/user` catalog-cleanup path found. Serialized install/recovery assumptions are valid only while origin ownership covers **all** those operations.
- Import integrity unchanged: catalogs require 1/1 header before hash; SHA hashes exact supplied chunks and count/page geometry is checked (`worker-core.ts:504–531,623–638`). Pinned import's 18/19 rewrite therefore leaves valid catalog bytes unchanged. USER-only normalization occurs before stored-byte hashing and separately records sourceSha256. Header parity/rejection tests inspected and passed in the mobile gate.
- Admission barrier remains satisfied by public placeholder association before async hashing/import (`worker-core.ts:472–491`), with the pinned chunk importer selecting associated SAH first. Interleaved USER journal allocation cannot reuse that associated slot. Checked stage offsets/short writes and pinned chunk-write counts fail closed; hard kill may leave unique intent-backed orphans, not overwrite active. No own quota/slot-exhaustion kill suite this round.
- FULL/DELETE/foreign_keys/mmap PRAGMAs are read back (`worker-core.ts:263–291`); pinned xSync flush remains the durable engine mechanism. Ordered durableBarrier is health acknowledgement, not a whole export/new fsync API. Worker death and ambiguous COMMIT/barrier latch; explicit reopen reads persistent files, no autosave/replay.
- USER §5: migrated role needs matching marker; fresh/unmarked role probes legacy and blocks on presence/read failure (`legacy-migration.ts:249–300`). A's old reported “unmarked role + legacy -> existing” deviation is gone. Marker-without-role/mismatch, missing/unreadable/future USER and nonempty/unreadable u-* orphans fail closed. All-empty u-* selection is sorted; m-* without legacy blocks. Legacy migration imports unique m-*, validates history/integrity/FKs, resets only operational catalog state, closes/barriers and commits role+marker atomically; legacy key untouched. Canonical/no-duplication/fault unit cases passed; no own full marker-boundary browser matrix. Legacy export remains a whole-USER/raw-SQLite exception, not bounded .fdx recovery or OPFS-only rescue.

### Atomic proof flag and old director flags

Keep `WEB_ATOMIC_ACTIVATION_PROVEN=false`. Fix-k did not close the full evidence gaps, and S8-01 is a real missing boundary. Committed `web-install` no-outer-retry kill group covers decode/import, but boundary matrix still calls the default outer-retrying openCore. `web-storage/harness.ts:221–233` dumps six selected tables, not ALL personal tables; seeding only custom/owned is not comprehensive preservation evidence. PREPARED swallowing and before-pointer hooks cover boundary sides, not actual in-transaction abort/failed completion. My real queued-IDB test supplements but does not replace that matrix. `web-port.ts:20–25` still advertises fullInstall true; core has no runtime atomicActivation check, so the false flag is descriptive, not automatic release prevention.

The director's **old** image-spec failure is stale for this HEAD: `pwa-image-cache.spec.ts:28–45,48–88` separates skip-when-busy from controlled ledger admission; no longer expects every concurrent image to cache. I inspected it, did not run that browser spec. The old 10×300 ms boot loop is also gone: actual policy is 15 s elapsed backoff/jitter, forced retry after settled rejection, preservation flags explicit. Fix-k and round-7 report successful no-outer-retry kill runs; I did not independently repeat them. Neither Chromium nor Safari has an established universal SAH-linger upper bound here. Fifteen seconds is a retry policy to test, not a storage guarantee; on exhaustion retain files/lock safety and offer Retry/reload, never wipe/steal/replay. S8-03 qualifies hung-attempt handling, not the established settled-rejection cache repair.

The main 30 s silence watchdog is no longer ping-only: worker-side SQLite progress heartbeats run **inside** sqlite3_step/integrity_check. Own successful long-sync probe and real-WASM unit tests support that fix. A native step/SAH operation with no progress for a whole window can still be misclassified; no device incidence measured. Prefer executor-aware progress and safe uncertainty UI to arbitrary total SQL bounds; a later ping cannot interrupt synchronous WASM. S8-02 shows why queuing must also be represented.

## ADR-055: accept-with-conditions

- `tools/catalog-builder/src/build-db.ts:36,47–50,109–113,149–152` sets 65536 before schema creation, stays DELETE, VACUUMs and verifies closed output page size. My builder tests/typecheck pass.
- Bytes 16/17 sentinel **0,1** encode 65536; bytes 18/19 **1,1** are read/write-format versions. A correctly accepts old 4 KiB geometry and new 64 KiB geometry. Pinned chunked import is a byte stream, not page-aligned; decoder/import <=256 KiB chunks need not align to pages. Inspected 4/64 KiB import/hash-parity unit tests passed; no new physical 64 KiB export audit in this round.
- A's negative `cache_size` means KiB independent of page size (`worker-core.ts:270`); validation default is 32768 KiB (`client.ts:73`), not contract comment's 1024. Reconcile that comment; cache suggestion is not total WASM cap.
- Standard SQLite format support is not shipped Capacitor/SQLCipher device evidence. Keep native enablement separate until actual bridge open/integrity/refresh/rollback tests; no format reason to reject web 64 KiB packs.
- Repaging changes raw/compressed bytes/hash/length: immutable **new versions**, never republish old version bytes. Future page deltas must bind exact base/target/geometry; 4→64 KiB requires full fallback unless rebuild is explicit. Refreshed active files need not equal immutable original delta bases. Deltas remain deferred.
- Supplied director numbers (16.5 s full EN, phases 0.4/7.9/3.2/4.0 s, aggregate JS 35 MB, storage 121.7 MB, search/reload) are **not my measurements**. They support the direction, not slow-device timing ceilings or complete ADR-054 closure.

## Trust and memory spot-check

- Sole default trusted origin remains `https://flashydex-catalog-packs.netlify.app` (`catalog-config.ts:4,16–22`); app-origin trust is DEV-only. Explicit build override is not a second default. No .env/credentials read.
- `pwa/routes.ts:29–45` handles pack host/manifests/.zst/.db/dev-packs before navigation/precache; `sw-core.ts:32–33` goes network-only without fallback. Product stage fetch is no-store and checks final origin. JSON-present signatures including null still reject (`manifest-validation.ts:56–59`). No deployed-header/CORS/SW readback performed.
- No fix-k catalog-sized main-thread allocation found. Catalog flow passes references/counters, SQL supplier <=256 KiB; decoder uses bounded synchronous output sink/window. Legacy migration/export remain USER-only whole-value exceptions, including IDB clone before typed-array size cap.
- Supplied 35 MB JS is below ADR-054's 128 MiB JS threshold but does not prove separately committed WASM<=96 MiB/non-double-counted combined<160 MiB, no missed worker peaks or sustained EN+JA. I collected no new full-pack allocation trace. Retained first network chunk as decoder header scratch (`opfs-stage.worker.ts:125–129`) remains a worker-side input-budget qualification, not a demonstrated main-thread catalog buffer.

## 4. Updated W01–W14

Status describes the **whole normative gate**, not only the closed sub-defect. No missing device result is counted as a newly demonstrated P1.

| Gate | Status | Evidence inspected/run; remainder |
|---|---|---|
| W01 | partial | Own successful real worker/sahpool boot/commit/reopen and 13 retry unit cases within named gate; pin/stable pool/preservation source retained. Complete release fault matrix not independently rerun; S8-03 pending-acquire qualification. |
| W02 | partial | Own 375 core/374 mobile and 84 named tests; approved core seam safe; real gate+latch exact SQL probes; real synchronous heartbeat survival. Queued-open cap false-death S8-02; full release parity not rerun. |
| W03 | partial | Streaming source/header/hash units; builder 27 tests; director's full-EN metric supplied, not rerun. No own all-worker allocation/WASM/combined/sustained EN+JA or physical-Safari trace. |
| W04 | partial | Own small real install/search and takeover/reload; acknowledged scratch writes retained. S8-01 loses catalog mapping/availability across handoff. No complete installed-PWA offline close-all/personal/custom/settings/history/export matrix. |
| W05 | partial | Own unit fault/lost-ack passes; source crash-row walk; committed browser v2/receipt/kill/boundary specs inspected. Flag correctly false; all-personal/no-outer-boundary/actual abort proof incomplete; real queued-IDB handoff defect S8-01. |
| W06 | partial | Associated-slot algorithm/pinned import and exact-byte/header checks inspected; own import-header tests passed via mobile gate; original A interleave report inspected. No own real slot/quota exhaustion/import-kill matrix or target-device proof. |
| W07 | partial | Protection/install UI/controller source and passing mobile units; prior C report inspected. Real Safari grant/container/privacy/extended-use outcomes remain unmeasured. |
| W08 | open | Core synthetic gates pass; own small-pack search total 201 is not real-EN 10-warmup/100-sample p50/p95/max/raw evidence. |
| W09 | partial | Own real same-context handoff/takeover with sole writer lock and B boot/writes; new opens retire correctly. **S8-01** permits old-page IDB role mutation after B owns lock; no Safari tab/Home Screen shared-container run. |
| W10 | partial | Marker/legacy conflict/all-orphan source plus canonical/no-duplication unit cases pass; retained key/raw export source. No own real marker-boundary kill matrix; whole-value export and OPFS-only rescue limitations unchanged. |
| W11 | partial | Network-only routes/trust source and mobile units; original C release-SW report inspected. No own production build/offline lazy-worker/deployment canonical/headers/WASM MIME/CSP readback. |
| W12 | partial | Bounded-image handler/ledger tests pass within mobile gate; committed busy-bypass spec fixed, not independently run. No own full-cap real SW termination/quota evidence. |
| W13 | partial | Named drain/retirement/order/error/quiescence units pass; own real factory fence and real IDB/two-tab probe. **S8-01 P1**; full job lifetime and actual release-SW dirty/busy/offline matrix remain. |
| W14 | partial | Lazy healthy-boot source, real recovery and diagnostics seams inspected. Live-ping init hang fixed; S8-02/03 qualifications. No own mid-range-phone 10-cold-launch offline p95/resume/EN+JA evidence. |

## 5. [needs owner input] — separate from the code verdict

- Physical Safari iOS/iPadOS 17 and 18, tab AND Home Screen: exact device/OS/build/origin, full 64 KiB EN + legacy 4 KiB compatibility, Inspector memory, kill/recovery/low-space/offline personal-data and external backup round-trip. Record unavailable fields honestly.
- Real persisted()/persist() outcomes, tab/Home Screen storage/lock/container sharing, safe external backup before changing origin/container, genuine extended Safari-use lifecycle observation; no simulated elapsed-days pass.
- Canonical release build/immutable manifest identity, production hash/length/CORS/no-store/redirect/SW scope/WASM MIME/CSP readback and real offline/update smoke. Nothing deployed by this review.
- Mid-range-phone startup/resume/real-EN search raw samples, all-worker JS/WASM attribution and sustained EN+JA high-water evidence.
- Native 64 KiB Capacitor/SQLCipher open/integrity/refresh/rollback before later native enablement; not a reason to reject the web format decision.
- Director-approved S5-09 validator scope/contract amendment; contract cleanup for RETIRED type, attempt diagnostics/drain/retirement seams and validation-cache comment. No unauthorized core/contract edits here.

One P1 remains: **S8-01**. Fix whole-job/control-operation ownership at handoff and exercise queued real IDB plus uninstall/rollback before production sign-off. Preserve the working lazy-open fence, conservative lexer and unknown-COMMIT semantics.
