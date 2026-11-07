# sol-review-7 — re-verification after fix round j

## Verdict: no

Round j fixes the demonstrated synchronous-SQL false-death case, cached-rejection pool retry and multiple-USER-orphan selection. All four requested gates pass independently. One P1 remains in update handoff: releasing the Web Lock does not permanently retire the page's storage client/factories. I independently reopened a catalog through the production `catalogSource.open` after completed handoff, with no writer lock held; a second tab then obtained the writer lock but failed pool initialization. Closing the retired tab restored boot and the catalog. This is a reproduced ownership/availability failure, not demonstrated personal-data loss. The remaining classifier and stalled-request issues are P2. Safari/device evidence is listed separately and is not the reason for this verdict. No P0 found.

## Reviewed state and execution provenance

- HEAD: `223c4f66d731057eb13999772f1e7aa3c379a221`, branch `main`; unchanged at the last source check before writing this report.
- `git diff --stat HEAD -- packages/core` returned **empty**. Round j also has no core delta relative to `ec4aacf`. The approved semantic core exception is already committed in `ec4aacf`: reviewed `git diff --ignore-space-at-eol ec4aacf^ ec4aacf -- packages/core/src`, **13 added lines in `db/sql.ts` only**. `catalog-install.ts` uses its existing PersistenceError handling; no additional core change was needed. Empty working-tree diff does not mean the approved fix is missing.
- Read round 6, round-5 findings, both fix-j reports, the original A/B/C/shell reports including B Run 2, BRIEF, WEB-STORAGE, W01–W14, ADR-054/055, seam contracts, changed product code and relevant tests. Builder executions are attributed, not claimed as mine.
- For concurrently assigned `web-install.spec.ts` I inspected **committed HEAD via `git show`**, not the evolving working file. I did not review concurrent `persistence-failed`, `pack-install` or `routes/dev/**` changes as defects.
- No implementation edits, dependencies installed, commit/push/stash, server start/kill or screenshots. The only authored repository file is this report. Tests used their normal tool/cache behavior. Browser probes used the isolated named `sol-review-7` session, synthetic data and the owner's existing `https://127.0.0.1:3200/harness.html`; not the owner's collection/profile.
- Browser: `HeadlessChrome/145.0.0.0`, Windows, text/DOM/JS only. These are dev-build probes, not production Netlify, Safari, phone, power-loss or complete Playwright-suite evidence.

### Commands I actually executed

Every shell began `cd C:/Projects/flashydex`.

| Command | Exit | Actual output |
|---|---:|---|
| `npm run typecheck` | 0 | Core and schemas `tsc --noEmit -p tsconfig.json`; mobile `tsc --noEmit -p tsconfig.app.json && tsc --noEmit -p tsconfig.node.json`; no errors. |
| `npm run lint` | 0 | `eslint .`: **23 warnings, 0 errors**. React-refresh warnings and an unused-disable warning in `lib/pwa-hooks.ts`. |
| `npm test --workspace=@flashydex/core` | 0 | **34 files passed; 375 tests passed**; **46.18 s**. |
| `npm test --workspace=@flashydex/mobile` | 0 | **27 files passed; 337 tests passed**; **31.75 s**. |
| `npm test --workspace=@flashydex/mobile -- --reporter=verbose src/platform/web-sqlite/client-fix-j.test.ts src/platform/web-sqlite/pool-boot-retry.test.ts src/platform/web-sqlite/sql-class.test.ts src/platform/pwa/image-cache/handler.test.ts` | 0 | **4 files; 34 tests passed**; **3.54 s**. Named heartbeat, hidden-deadline, forced-reacquisition, classifier/savepoint and capped-tee cases all green. |
| `npm test --workspace=@flashydex/catalog-builder` | 0 | Additional ADR-055 check: **3 files; 27 tests passed**; **1.14 s**. |
| `npm run typecheck --workspace=@flashydex/catalog-builder` | 0 | `tsc --noEmit`; no errors. |

I did not run a production build, full-install timing/memory trace or Playwright CLI suite. An inline Node/Playwright launch was blocked by unattended approval before execution; permitted browser-tool probes supplied the independent browser results below instead. No blocked command is counted as a pass.

## 1. Re-verification table

Paths below `web-sqlite/`, `web-storage/`, `pack-install/` and `pwa/` mean `apps/mobile/src/platform/...` unless otherwise stated. “Fixed” closes the particular defect, not every device/release acceptance gate.

| Finding | Status | Evidence inspected or independently run | Qualification |
|---|---|---|---|
| **S6-01 — liveness kills long synchronous SQL (P1)** | **fixed** | `worker-core.ts:238–264` installs the pinned `sqlite3_progress_handler` at every open/reopen, every 20,000 VM steps, throttling heartbeat posts to 250 ms without interrupting. `client.ts:266–278,351–408` accepts progress and suspends init/open/reopen silence deadlines while hidden. My verbose gate passed the real-WASM integrity_check/recursive-SELECT heartbeat and hidden-page tests. My real sahpool worker completed the 6-million-step recursive SELECT in **2755.8 ms** with a **1000 ms** silence limit and **0** terminations; silent transport still produced WORKER_DIED/unknown with **1** termination. | Closes the demonstrated event-loop-ping false death, including the director's integrity_check concern. A single native step/I/O stall longer than the window remains a risk, not a measured device failure here. Generic message-based deadline reset introduces the separate P2 S7-03. |
| **S6-02 — retries reuse cached pool-init rejection (P1)** | **fixed** | `pool-boot-retry.ts:91–138`, `sql.worker.ts:119–131`, `protocol.ts:10–11`: 15 s policy budget, capped exponential backoff/jitter, `forceReinitIfPreviouslyFailed:true` after attempt 1, preservation flags always explicit. Inspected pinned implementation `node_modules/@sqlite.org/sqlite-wasm/dist/index.mjs:17228–17296`. My 13 verbose retry tests passed. Independent real-pool probe: a second client initialized successfully after I released a held owner at **1807.8 ms**; init completed at **2605.6 ms**, preserved row `[[73]]`, capacity 16. | Both children report **40/40** no-outer-retry kill runs, separately; I did not rerun those suites or add their totals together. No Chromium/Safari universal SAH-linger bound is established. See strategy assessment below. |
| **S6-03 — first empty orphan hides a second personal USER (P1)** | **fixed** | `legacy-migration.ts:337–375` classifies sorted u-* orphans before adopting any; any nonempty/unreadable result blocks. Both enumeration orders, reversed empty/nonempty placement, unreadable and all-empty cases at `legacy-migration.test.ts:349–425` passed in my 337-test mobile gate. A table with zero rows still counts as nonempty evidence. | No fresh mapping is committed on ambiguous u-* input; all-empty adoption is deterministic and does not unlink the other empties. Does not prove arbitrary lost-role/marker recovery or add an OPFS rescue exporter. |
| **S6-04 — queued tee bytes / unused revalidation branch (P2)** | **fixed** | `pwa/image-cache/handler.ts:38–61` takes a slot before clone, starts counted capped reading immediately, and queues only the bounded result for writes. `:69–84` directly consumes revalidation, cancels on busy. My verbose gate passed the slow-writer + unknown-length 2 MiB/1 KiB-cap case and zero-clone revalidation case (`handler.test.ts:104–150`). | Bound is small constant-factor memory, not literally exactly slots×cap: readBounded temporarily holds chunks plus its contiguous result, and stream delivery may supply an over-limit chunk. No aggregate process/heap peak was measured here. |
| **S6-05 — WITH/SAVEPOINT/PRAGMA bypass mutation gate (P2)** | **partly** | Shared `sql-class.ts` now feeds client latch/ro refusal (`client.ts:158–174`) and handoff gate (`write-gate.ts:99–142`); ordinary WITH DML, SAVEPOINT/RELEASE, assignment PRAGMA, ATTACH and savepoint ownership tests all pass independently. | The tokenizer is not conservative for several valid SQLite spellings. I executed mutations through the closed gate using a string containing `--`, a quoted PRAGMA and leading semicolon. **S7-02**. No bundled core use of these exact spellings was demonstrated. |
| **S6-06 — production lock-release hook unwired (P2)** | **partly** | `components/pwa-ui.tsx:19–27` now supplies real release; `lib/handoff.ts:137–145` orders close → shutdown → release; `instance-lock.ts:25–46` denies re-acquiring through that module after release. Unit ordering, stuck-close/shutdown and activation-failure cases passed in my mobile gate. Committed same-context two-tab specs inspected; child reports passing them. | The hook itself is fixed, but the promise “old page can never reopen storage” is not enforced at the factories/client. Independent production-factory/two-tab reproduction is **S7-01 (P1)**. Existing two-tab tests check a later write through an invalid old handle, not lazy reopen. |
| **S5-03 — atomic proof overclaim (P1)** | **partly** | `pack-install/web-store.ts:18–29` is now **false**, and my mobile gate passed the false-capability assertion (`web-store.test.ts:284–289`). Committed specs add first/update PREPARED/before-pointer/after-pointer kills and update cleanup, plus no-outer-retry decode/import kills. Storage child reports seven matrix tests passing and two complete 47-pass runs. | Original dishonest true flag is repaired. Do not flip it merely because the small kill group passes. Matrix still uses outer pool-boot retry; its `userCanon` covers six selected tables, not ALL personal data; no real IDB transaction-in-progress abort is shown. Details below. `atomicActivation:false` is descriptive, **not an enforced install gate**: web-port still returns fullInstall:true and core does not consume atomicActivation. |
| **S5-04 — close/handoff deadlocks an admitted transaction (P1)** | **partly** | `client.ts:643–710` drain lets the owner finish and waits for COMMIT's durable barrier before closing. `write-gate.ts:62–84`, `handoff.ts:122–145` gate/drain/close/shutdown/release sequence and unit cases pass. Original close-before-COMMIT deadlock remains repaired. | Not full job quiescence or permanent session retirement: **S7-01**. `useReportBusy` registers transfer operations, but the sync hooks do not register active network refresh jobs (`data/transfer-sync-hooks.ts:12–63`); 40 ms driver quiet is not a job-lifetime fence. No natural UI race was reproduced; my reopen reproduction explicitly invoked the production factory. |
| **S5-07 — unbounded image clones (P2)** | **fixed** | Slots-before-clone plus immediate capped reads now address both clone count and waiting-clone bytes; same independently passing handler tests as S6-04. Committed `pwa-image-cache.spec.ts` splits controlled ledger admission from production-slot busy bypass. | The director's old “every image admitted” failure is stale for committed round j: fixed spec and harness inspected; child reports two standalone 2/2 runs and inclusion in both 47-pass runs. I did not run that browser spec. |
| **S5-09 — receipt/fingerprint values not validated (P2)** | **not fixed** | `packages/core/src/services/candidate-validation.ts:24–50,65–80` still checks actual schema SQL, meta identity, integrity/FKs/language/counts, but neither migration receipt values nor `catalog_meta.schema_fingerprint` value. No round-j core diff. | Carry-forward P2, not a new hash/signature bypass. Requires separately approved validator change or explicit contract amendment, not unauthorized expansion of this read-only review. |

### Previously closed S5 safety fixes retained

- **S5-01:** `packages/core/src/db/sql.ts:284–303,314–319` detects own/details unknown commit state, latches/notifies, throws a real PersistenceError and does not issue guessed ROLLBACK. Clean failures retain prior rollback/error translation. `catalog-install.ts:319–347` therefore retains both generations on uncertain receipt COMMIT. Core `test/commit-unknown.test.ts` (6) and `test/install-commit-unknown.test.ts` (2, applied/not-applied receipt) were inspected and passed in my 375-test gate. Client COMMIT/RELEASE ambiguity remains physically latched (`client.ts:490–532`); recover/reopen reads truth, never replays mutations. No regression found in the approved narrow core change.
- **S5-02:** marked migrated USER requires matching marker; fresh/unmarked role probes legacy and blocks on presence/read failure (`legacy-migration.ts:249–300`). The A report's old “role/no marker + legacy → existing” deviation is gone. Legacy reads stay raw/read-only and never load catalog keys.
- **S5-05:** `worker-core.ts:504–531,623–646` checks magic, page geometry and catalog 1/1 header before hash acceptance. For catalogs the supplier SHA is the exact imported-byte SHA. USER-only normalization precedes stored-byte hashing and has a separate sourceSha256. My mobile gate passed 4/64 KiB parity, 2/2 rejection, malformed header and partial-page tests (`import-header.test.ts`).
- **S5-08:** blocked migration has raw legacy `.sqlite` download, not reset (`legacy-export.ts:19–69`, `components/storage-screens.tsx:134–168`). Still a whole-USER allocation, cap 512 MiB after typed-array IDB clone, not bounded row export or normal `.fdx` restore; no OPFS-only rescue. I did not rerun the download browser test.

## 2. Regressions introduced by this fix round

1. **S7-01:** explicit lock release makes the missing terminal storage-admission fence consequential: the old page can reacquire the pool while a new page legitimately owns the Web Lock. Before explicit release the old page retained the Web Lock until unload, so another page could not become the authorized writer during this interval. The new release ordering is correct; removing release would hide rather than fix the missing retirement fence.
2. **S7-03:** changing hard request deadlines to reset on every worker message allows pings/errors to keep a stuck async init pending indefinitely. The heartbeat repair is necessary; do not revert to killing long synchronous SQL to recover a hard deadline.
3. **S7-02 is a residual, not evidence of newly introduced data loss.** The shared classifier closes the original simple examples but not the whole class of valid SQLite inputs. No new catalog-sized main-thread buffer or core COMMIT regression found.
4. The child report's temporary one-failing-test mobile run is superseded by the final on-disk test change and my **337/337** independent pass. The old image-spec assertion was also updated in committed HEAD; it is not an outstanding independently observed red test in this round.

## 3. New findings

| ID | Severity | File:line | What | Why it matters | Concrete fix |
|---|---|---|---|---|---|
| **S7-01** | **P1** | `apps/mobile/src/lib/handoff.ts:137–145`; `platform/instance-lock.ts:25–46`; `platform/app-database.ts:63–86,128–146,177–189`; `platform/web-sqlite/client.ts:198–204,453–475,772–779` | Handoff permanently closes only the write gate and old wrappers, not storage admission. Cached prepareStorage plus client init's reusable shutdown allow lazy catalog/user factories to spawn a new worker after release. `isWriterLockReleased` is not checked there. | Independently reproduced with real sahpool and production catalogSource: completed handoff, no lock held, then a new catalog worker/connection. A second tab acquired the writer lock but hit INIT_FAILED after pool retry; closing the retired tab allowed fresh boot with all 201 small-pack cards. Violates the lock-before-VFS ownership invariant and can strand takeover/update behind a retired page. Browser SAH exclusivity prevented concurrent pool access; no personal loss asserted. | Add a terminal handoff-retirement/admission state distinct from recoverable shutdown/reopen. Set it before the final drain/close; block **all** subsequent factory opens, init/reopen/import/control work on the old page, including read-only paths and queued opens, before and after relevant awaits. Quiesce/cancel background jobs/reads, then close/terminate/release. Keep recoverable pre-close drain timeout usable. Add same-context test: complete handoff, attempt old-page lazy catalog open and delayed open/reopen, ensure no new worker/SAH, and prove B boots/writes while A remains open, including activation failure. |
| **S7-02** | **P2** | `apps/mobile/src/platform/web-sqlite/sql-class.ts:33–41,50–75`; `platform/web-storage/write-gate.ts:99–103`; `platform/web-sqlite/client.ts:158–164` | Comment removal runs before string tokenization; quoted PRAGMA identifiers do not parse; leading `;` maps to empty/read verb although SQLite accepts it. Valid mutations are classified read. | Real closed-gate probe admitted `WITH x AS (SELECT '--') INSERT INTO t VALUES(1)`, `PRAGMA "user_version" = 99` and `; INSERT INTO t VALUES(2)`. Actual SQLite returned rows `[[1],[2]]` and user_version `[[99]]`. Same classifier feeds the write latch; its protection claim is incomplete. No current core use of these exact forms found/demonstrated. | Use one stateful SQLite-aware lexer, or authoritative prepared-statement readonly classification plus explicit transaction-control parsing. Do not strip comment-like text inside quoted tokens. Normalize/handle leading empty statements and quoted/schema-qualified PRAGMAs; unparseable shapes must fail conservative, not read. Add these exact executable cases to both closed-gate and latched-client tests. Preserve the intentional connection-local foreign_keys recovery policy explicitly. |
| **S7-03** | **P2** | `apps/mobile/src/platform/web-sqlite/client.ts:266–269,351–408,429–449`; `platform/web-sqlite/worker-core.ts:105–109,155`; `platform/web-sqlite/pool-boot-retry.ts:97–108` | Every message refreshes every request deadline. While async init is stuck, worker can reject pings as STALE_SESSION because env is still null; those errors continually renew init's deadline. A stuck open/reopen can similarly be masked by unrelated replies. Retry budget does not bound an individual never-settling open promise. | Independent scripted-transport probe: request deadline 80 ms, observed after 450 ms, **23 ping replies**, init still pending, **0 terminations**. This restores an indefinite hang for a live-event-loop/stuck-operation case. Not false Saved or proven data loss. | Separate worker/process liveness from operation progress/completion. Pongs, unrelated replies and STALE_SESSION errors must not indefinitely extend a stuck init's progress budget. Provide bounded, visibility-aware init acquisition/probe handling and safe Retry UI. For queued open/reopen account for a known busy synchronous executor/heartbeat without killing it on wall time alone. For ambiguous SQL preserve latches/receipts and do not replay. Test responsive-ping/stuck-init, stuck acquisition promise, unrelated-progress/stuck-open and hidden/resume cases. |

### Independent browser outputs and limitations

Synthetic test data below is not a fabricated product measurement. All browser work used the named isolated profile.

**Long synchronous SQL / death detection:** existing `web-sqlite/harness.ts` scenario `long-sql-liveness`, real worker + real sahpool:

    {rows:6000000, timeoutMs:1000, intervalMs:50}
      -> outcome.ok:true, rows:[[18000003000000]],
         elapsedMs:2755.8, terminatedBeforeShutdown:0
    {silent:true, timeoutMs:300, intervalMs:50}
      -> WORKER_DIED, commitState:unknown,
         elapsedMs:316.3, terminatedBeforeShutdown:1

This is a short-window policy reproduction, not a full phone validation benchmark. It actually blocks the worker event loop while SQL runs; async held-response tests alone would not suffice.

**Held pool recovery:** two actual clients, second starts while first owns SAHs, first shutdown scheduled after 1800 ms:

    {initMs:2605.6, releasedAt:1807.8, rows:[[73]],
     vfs:'opfs-sahpool', capacity:16}

An earlier version put the row at `/probe/p-*`; boot correctly cleans probe files, so that version could not read its test row and is not counted as a preservation pass. The corrected `/user/u-bootreview7.db` probe passed and removed its own test file. This measures one controlled hold/release, not how long a killed browser retains handles.

**Closed gate, real SQLite:** normal INSERT returned MAINTENANCE. The three S7-02 spellings each returned `class:{kind:'read'}, outcome:'admitted'`; readback `rows:[[1],[2]], userVersion:[[99]]`. Probe file was closed/unlinked afterward.

**Completed handoff / lazy reopen:** prepareUpdateHandoff used actual gate, app singleton, close/drain, shutdown and release, then I explicitly invoked the production `catalogSource.open('en')` to model a delayed/lazy caller:

    {install:true, committed:true, released:true, stoppedSession:null,
     restarted:true, heldLocks:[],
     openPaths:[{path:'/catalog-en/g-1r6071734b543l1l.db',refs:1,inTransaction:false}],
     count:{rows:[[201]]}}

Ordinary writes through a newly wrapped USER driver still returned MAINTENANCE, so this is specifically a missing **storage-open** fence, not a claim that the tested ordinary personal write succeeded after release. An initial stats check imported a different direct-module singleton and was inconclusive; the corrected result above used `storage-bridge.webSqliteClient()`, the app's actual singleton.

I then left the reopened catalog held and opened another harness tab in the same browser context. It obtained the real writer lock but returned:

    {lock:'granted', boot:'INIT_FAILED',
     message:'The browser storage pool could not be opened', attempts:10}

The first awaited tool call exceeded the browser tool's 5 s evaluation wait. I collected the later result asynchronously; its observation joined an already-running preparation, so **I do not report its elapsed value as total boot duration**. After closing the review's retired/contending tabs, a fresh tab returned `{lock:'granted',boot:'web',rows:{rows:[[201]]}}`. This isolates contention, not destroyed bytes. No spontaneous background UI race or real release SW activation was executed.

**Stalled init with live ping errors:** real client, scripted WorkerLike, init reply deliberately withheld, ping replies STALE_SESSION:

    {deadlineMs:80, waitMs:450, settled:null, terminated:0, pings:23}

The probe subsequently answered init and shut down. It models worker-core's actual env-null ping rejection, but is not a claim that the host's OPFS API hung naturally.

## Atomic activation and USER recovery re-walk

| WEB-STORAGE §4 crash row | Source/evidence inspected | Round-7 assessment |
|---|---|---|
| Transfer/decode/chunked import incomplete | Intent before allocation (`web-store.ts:163–167`); failed-job protection (`:119–128`); import unique-target cleanup (`worker-core.ts:532–542`); boot reconcile role protection (`reconcile.ts:28–79`). Mobile unit crash cases passed; children report no-outer-retry decode/import kills. | No pre-pointer unlink of USER/old active/previous found. Boot-only reconciliation premise remains essential. |
| PREPARED, pointer not committed | Core PREPARED before activate; `role-store.ts:142–162` await complete/abort; `role-state.ts:123–132` expected-active + candidate membership. Unit transitions and committed boundary spec inspected. | Source direction sound. Spec's before-pointer stall is **before** transaction, not a real in-transaction IDB abort. |
| Pointer committed, no new USER receipt | Previous = old active in same IDB state transaction; core inspect/undoSwap (`catalog-install.ts:366–393`) validates/restores old state; first install returns absent. | Both files survive pointer commit; no guessed physical rename. After-pointer boundary spec exercises this direction. |
| USER receipt COMMIT uncertain | Narrow core latch + PersistenceError, client unknown-outcome latch; applied/not-applied core tests independently passed; committed real-worker lost-ack first/update specs inspected. | Reopen actual USER receipt/journal, retain both generations; no replay/guessed rollback. No regression found. |
| Receipt committed, cleanup interrupted | `web-store.ts:301–304` clears previous mapping before unlink; boot orphan GC; core committed-receipt recovery validates active. | Cleanup kill hook is after clearPrevious before unlink, a useful real orphan window. Child reports matrix pass; not my independent matrix execution. |
| New active invalid, previous valid; neither valid | Core fileIsValid/undoSwap/recovery + web restorePrevious pointer transaction before retirement. | Validate previous before restoration; isolate bad catalog when neither valid, not blank USER. Unit coverage passed; no independent browser fault of both-invalid catalogs this round. |

- `discardCandidate` remains membership-checked (`web-store.ts:307–311`): stale promoted refs cannot unlink active/previous. `cleanupFailedJob` reloads role truth. `reconcileWebStaging` confines deletion to catalog paths and protects role USER/marker/active/previous/candidates. It must not become concurrent GC with an install.
- Activation may retire a displaced **older** previous only after `roles.activate` completes (`web-store.ts:275–279`). Restore, uninstall and previous cleanup also mutate roles before retirement. No new `/user` catalog-cleanup path found.
- Import admission remains the public-placeholder strategy: associated unique target created/closed before hash/import awaits (`worker-core.ts:472–491`). Pinned chunk importer selects associated SAH first (`index.mjs:16784–16785`), so interleaved USER journals do not select the same free slot. No extra global SQL barrier is required for this inspected algorithm.
- Staging uses checked explicit-offset writes, exact lengths and compressed/raw hashes; A rehashes imported chunks and rejects partial pages. Pinned import checks main writes for short write (`index.mjs:16795–16796`) and normalizes only bytes 18/19, already 1/1 for accepted catalogs. FULL/DELETE + pinned xSync→SAH.flush remain (`worker-core.ts:263–291,396–401`; `index.mjs:16161–16170`). Barrier is ordered health acknowledgement, not another exported DB/fsync API.
- USER recovery table: valid migrated role+matching marker uses new USER without replay; role/marker disagreement, marker without role, missing/unreadable/future USER, fresh role+present/unreadable legacy all block. No role+no legacy+no USER creates fresh; any m-* with missing legacy blocks; u-* adoption now requires all provably empty. Legacy-present migration imports unique m-*, validates integrity/FKs/history, resets only operational catalog state, closes/barriers and commits role+marker atomically; original legacy key is retained. Canonical migration/rerun/fault unit tests passed; real IDB marker-boundary kill matrix not independently rerun.

### S5-03 proof conditions, precisely

The false flag is appropriate for the evidence currently attached. Keep it false pending a documented production-equivalent matrix or an approved narrowed claim. The new tests are meaningful improvements, not fake proof, but:

1. Only decode/import kill variants disable the outer storage-boot retry; deterministic boundary matrix still calls default openCore with it enabled. Child **40/40** does not establish all seven boundary cases without retry.
2. `web-storage/harness.ts:221–233` canonicalizes owned_cards, grades, custom_cards, collection_groups, collection_group_members and price_snapshots only. It omits acquisitions, storage locations, settings, scan/history and app_state/revision. Seeding only custom+owned rows leaves empty tables weakly tested. W05 requires ALL personal data, not only the chosen six tables.
3. PREPARED trap swallows its COMMIT before the worker executes it; before-pointer is a hook before starting IDB; after-pointer is after transaction completion. These cover sides of boundaries, not an actual IDB request/transaction abort/failed-completion case in the browser. Unit aborted-transition tests remain useful but separate evidence.
4. `web-port.ts:20–25` returns fullInstall:true even with atomicActivation:false; core/UI source search found no runtime atomicActivation check. The comment calling it a production install gate is inaccurate. False is honest reporting, not a mechanism that disables unsafe release automatically.

## ADR-055 assessment: accept-with-conditions

- `tools/catalog-builder/src/build-db.ts:36,47–50,109–113,149–152` sets **65536 before schema creation**, stays DELETE, VACUUMs and independently verifies the page size of the closed result. My builder tests/typecheck passed.
- Header 16/17 sentinel **0,1** means 65536; 18/19 are separate read/write-format bytes, **1,1**, not the page size. A checks both and continues to accept historical 4 KiB packs (`worker-core.ts:623–638`). My mobile gate passed 4/64 KiB import/hash parity tests; no new own physical 64 KiB import/export audit this round.
- Pinned chunked import is a byte stream, not page-aligned API; B's <=256 KiB chunks can cross page boundaries. Negative `PRAGMA cache_size` retains **KiB** meaning (`worker-core.ts:270`); client validation default is 32768 KiB, not contract comment's 1024. Reconcile the comment; cache suggestion is not total WASM cap.
- Native SQLite format compatibility is not shipped Capacitor/SQLCipher device evidence. Keep native write enablement gated until actual bridge open/integrity/refresh/rollback tests. No format reason found to reject ADR-055 for web.
- New page geometry changes the raw file and SHA/length: publish immutable new versions, never replace bytes behind an existing version. Future page-delta format must bind exact base/target identity and geometry; 4→64 KiB requires full fallback unless geometry rebuild is explicitly supported. Active refresh also means installed bytes need not remain the original delta base. Deltas remain deferred.
- Performance evidence supplied by director (16.5 s total, phase 0.4/7.9/3.2/4.0 s, aggregate JS peak 35 MB, storage 121.7 MB, search/reload) was **not rerun by me**. No phone/SAFARI timing upper bound inferred. Heartbeats repair the demonstrated slow-SQL watchdog flaw rather than rejecting valid old packs or skipping integrity checks.

### Director liveness / boot-bound flags

The director's original silence-only behavior is no longer the whole policy: SQLite progress posts from inside synchronous SQL. The independent long-sync result and passing integrity_check heartbeat test support that repair. Keep 30 s silence as a conservative uncertainty signal, not proof of rollback. An operation with no VM/page progress for >30 s can still be falsely classified dead; no supported-device incidence was measured. Prefer operation-aware progress/soft recovery for uninterruptible native I/O rather than a fabricated universal SQL duration bound. A later posted ping cannot interrupt synchronous WASM.

The old 10×300 ms cached-failure loop is gone. The 15 s elapsed backoff with forced reacquisition and preserved pool is a reasonable **policy to test**, not a Chromium/Safari resource-linger guarantee. Failed init unregisters/releases handles without deleting files in the pinned code. Quota/capacity/engine failures are not blindly retried. The client nominal 30 s init silence limit outlasts that policy, but S7-03 means it is not an independent hard bound on a never-settling acquire. On exhaustion preserve all storage and offer safe Retry/reload; never steal Web Locks, wipe the pool or replay SQL. A live retired tab holding reopened SAHs (S7-01) will not be cured by any larger retry budget.

## Trust and memory spot-check

- `platform/catalog-config.ts:4,16–22`: sole default trusted origin remains `https://flashydex-catalog-packs.netlify.app`; page-origin trust is DEV-only. Explicit build override is a configuration capability, not another default.
- `pwa/routes.ts:29–45` classifies pack host/manifests/.zst/.db/dev-packs before precache/navigation; `sw-core.ts:32–33` uses network without cache fallback. Stage fetch uses cache:no-store and validates final origin. Any JSON-present signature, including null, remains rejected (`packages/core/src/services/manifest-validation.ts:56–59`). Deployment response headers/CORS/redirects were not independently fetched this round.
- No new catalog-sized main-thread array/export/deserialize found. Catalog flow crosses workers as references/counters; SQL importer uses <=256 KiB buffer; decode output uses bounded synchronous sink/window. Legacy migration/export are explicit USER-only whole-value exceptions, still memory-qualified.
- Supplied 35 MB aggregate JS is below ADR-054's 128 MiB threshold, but alone does not close committed WASM<=96 MiB, combined non-double-counted<160 MiB, all-worker sampling/missed peaks or sustained EN+JA. I collected no new full-pack trace. Image readBounded has bounded chunk/result duplication; not a claimed exact heap bound.
- Existing `opfs-stage.worker.ts:125–129` copies/retains the first entire network chunk as header scratch rather than only a tiny prefix. This remains an input-budget qualification from round 6, not a new main-thread catalog copy or a measured memory failure.

## 4. Updated W01–W14

Statuses describe the complete normative gate; partial does not mean its reviewed fixes failed. Missing physical/release evidence is separated from the P1 code verdict.

| Gate | Status | Evidence actually inspected/run; remainder |
|---|---|---|
| W01 | partial | Stable/preserved explicit pinned VFS, commit/reopen probes, 13 retry tests + own held-pool successful reacquisition. Children report 40/40 no-outer-retry kills. Missing full independent release-browser fault matrix; stalled-init P2 and retired-page ownership P1. |
| W02 | partial | Own **375 core / 337 mobile** passes, positional/transaction/latch/reopen tests inspected, approved narrow core seam safe. Own synchronous worker survives short watchdog. Shared classifier P2 and stalled-request P2 remain; no full release parity rerun. |
| W03 | partial | Director full-EN aggregate JS/timings and streaming source; builder/mobile gates pass. No own all-worker/WASM/combined allocation trace or physical-phone evidence. |
| W04 | partial | Own small install and retained 201-card catalog after handoff-contention recovery; child reports full install/reload. No own installed-PWA offline close-all/cold launch/personal/custom/settings/history/export matrix. |
| W05 | partial | Source crash-row re-walk; independent unit gates including applied/not-applied unknown COMMIT; committed real-browser boundary/v2/rollback/receipt specs and child results inspected. Matrix no-outer-retry, ALL-personal canon and real IDB abort evidence still incomplete; flag correctly false. |
| W06 | partial | Associated-slot algorithm and pinned import checked, preflight two raw copies/checked writes; own preservation under pool contention. Original A interleaved USER-journal/import report retained. No own slot/quota exhaustion/import-kill matrix or target-device proof. |
| W07 | partial | Protection/install controller/UI source and passing unit suite; no new actual Safari persist/container/privacy/extended-use results. |
| W08 | open | Core synthetic tests pass; own small-pack search/count is not real-EN 10-warmup/100-query p50/p95/max/raw evidence. |
| W09 | partial | Real Web Lock + real pool in own handoff/takeover reproduction; ordinary acquisition is before storage. **S7-01** permits retired page to reopen outside ownership. Child same-context successful/failure-handoff tests do not cover this reopen. |
| W10 | partial | All-u orphan repair, marker/legacy conflict logic and canonical migration/no-duplication unit tests independently green; legacy key retained. No own real marker-boundary kill matrix or OPFS-only rescue; raw legacy export still whole-value/non-.fdx. |
| W11 | partial | Network-only trust/routes source and passing units; C's prior release-SW report inspected. No own current production build/offline lazy-worker smoke or Netlify canonical/header/WASM MIME/CSP readback. |
| W12 | partial | Immediate capped tee reads/direct revalidation and own named unit passes; committed busy-bypass/controlled-admission browser specs repaired, child reports green. Full-cap real SW termination/quota evidence not independently rerun. |
| W13 | partial | Original transaction deadlock fixed, actual close→shutdown→release wired, unit order/error tests pass; child two-tab/fake-SW passes inspected. **S7-01 P1**, classifier P2, async job quiescence and actual release-SW dirty/busy/offline update matrix remain. |
| W14 | partial | Healthy boot remains lightweight/lazy, own boot recovery worked after contested owner closed. No own 10-cold-launch mid-range offline p95/resume/EN+JA memory evidence; startup indefinite-live-ping case remains P2. |

## 5. [needs owner input] — not the reason for “no”

- Physical Safari iOS/iPadOS 17 and 18, tab AND Home Screen: exact OS/device/build/origin, full 64 KiB EN and legacy 4 KiB compatibility, Inspector memory, kill/recovery/low-space/offline personal-data and external backup round-trip. Record unavailable observations honestly.
- Real persisted()/persist() outcomes and tab/Home Screen storage/lock/container sharing; verified external backup before switching containers/origins; genuine extended Safari-use lifecycle observation, not simulated elapsed days.
- Canonical release build/immutable manifest identity and production hash/length/CORS/no-store/redirect/SW scope/WASM MIME/CSP readback; actual offline/update smoke. None deployed or fetched by me here.
- Mid-range-phone startup/resume/search raw samples, all-worker JS/WASM attribution and sustained EN+JA high-water evidence.
- Native bridge 64 KiB open/integrity/refresh/rollback on owner hardware before native enablement; not a reason to reject web's format decision.
- Director approval for separate S5-09 validator work/contract amendment and contract cleanup (attempt diagnostics, drain seam, validation-cache default). No such code edits made here.

One P1 remains: **S7-01**. Fix permanent storage retirement, then re-run no-outer-retry boundary/ownership tests; do not increase retry duration to conceal an old page reopening the pool. Deliverable: this report only.
