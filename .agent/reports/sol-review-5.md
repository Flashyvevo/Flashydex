# sol-review-5 — independent Stage F / ADR-055 review

## Verdict: no

The web/PWA production path is not ship-ready. The file-backed worker, streamed staging, protected generation mappings and 64 KiB pack change are substantial improvements, and all four requested gates pass. However, an independently exercised unknown receipt-COMMIT outcome deletes an already-committed catalog while USER still reports it installed; the driver also allows further writes after an unknown COMMIT. USER resolution ignores the migration marker/conflicting legacy store, update shutdown can strand a transaction, and the advertised atomic-activation proof exceeds the browser evidence. No P0 or demonstrated loss of personal rows is asserted. Fix the P1s and complete the binding browser/device evidence before production sign-off; the supplied successful full-EN install does not close those safety gates.

## Scope, provenance and executed gates

- Reviewed HEAD: `022e6be0d31d4c7a88ab3d26a931299a4488c1cf`, branch `main`, unchanged at final source check.
- `git diff --stat HEAD -- packages/core` produced EMPTY output at both checks. Core is unchanged relative to HEAD. This is not a claim that core lacks pre-existing defects.
- Read BRIEF, WEB-STORAGE, ADR-049–055, W01–W14, both seam contracts, the four builder reports (including B's Run 2), prior-review findings, implementation and relevant test bodies. Builder execution claims are attributed below, not represented as my executions.
- Ignored the concurrent fix children's `web-install`, `persistence-failed`, `pack-install` and `routes/dev/**` changes. Their evolving files are not findings. Product paths under review were not changed by me.
- My only authored repository file is this report. No commit/push/stash, install, server start/kill, screenshots or implementation edits. The required gates used their normal test/tool outputs. Browser probes used the named `sol-review-5` harness session and synthetic browser-storage fixtures, not the owner's collection.
- Browser execution: owner's `https://127.0.0.1:3200/harness.html`, text/JS only, Chrome `145.0.7632.6` on Windows. These probes are not release-build, Netlify, Safari, physical-phone or power-loss evidence.

| Command independently executed | Exit | Real output |
|---|---:|---|
| `npm run typecheck` | 0 | Core `tsc --noEmit -p tsconfig.json`; schemas same; mobile `tsc --noEmit -p tsconfig.app.json && tsc --noEmit -p tsconfig.node.json`; no errors. |
| `npm run lint` | 0 | `eslint .`: 24 warnings, 0 errors. Includes React-refresh warnings and two unused-disable warnings; one warning is in the concurrently edited web-install spec and is not a product finding. |
| `npm test --workspace=@flashydex/core` | 0 | `Test Files 32 passed (32)`; `Tests 367 passed (367)`; duration 88.85 s. |
| `npm test --workspace=@flashydex/mobile` | 0 | `Test Files 19 passed (19)`; `Tests 241 passed (241)`; duration 35.85 s. |
| `npm test --workspace=@flashydex/catalog-builder` | 0 | Additional ADR-055 check: `Test Files 3 passed (3)`; `Tests 27 passed (27)`; duration 1.69 s. |
| `npm run typecheck --workspace=@flashydex/catalog-builder` | 0 | Additional ADR-055 check: `tsc --noEmit`, no errors. |

I did not run a production build or the Playwright suites in this review. Their builder-reported passes do not become independent passes here. The inline Node/Playwright attempt was blocked by unattended command approval before execution; browser probes below were executed through the permitted browser tool instead. One initial page-size probe used an incorrect module URL; a subsequent tool wait timed out. The corrected, retained-result probe completed and its actual results are recorded below. A first hostile-header attempt failed worker startup; its fresh-page retry completed. None of those unsuccessful attempts is counted as a pass.

## Findings

Paths below are repository-relative. Severity reflects product impact, not the number of green unit tests.

| ID | Severity | File:line | What | Why it matters | Concrete fix |
|---|---|---|---|---|---|
| S5-01 | P1 | `apps/mobile/src/platform/web-sqlite/client.ts:338–347,401–420`; `packages/core/src/db/sql.ts:284–296`; `packages/core/src/services/catalog-install.ts:329–332,366–380` | Unknown COMMIT errors are not latched/mapped into core's persistence-failure path. Only WORKER_DIED latches in enqueueExec; an IO/QUOTA COMMIT rejection bypasses afterCommit entirely. | Independently reproduced: actual COMMIT succeeded, injected its response as IO/unknown; subsequent write succeeded. In a real-worker/core first install, the committed catalog was unlinked by undoSwap while the durable USER receipt remained installed. | At the adapter seam, retain unknown COMMIT state, latch the physical connection and queued admissions, block receipt-success reads until explicit reopen, and surface an actual core `PersistenceError` instance so install does not undoSwap. Do not rely on a matching string code or blindly retry COMMIT. If the unchanged-core seam cannot express this safely, request narrow approval rather than weakening it. Add PRE/POST COMMIT-error and lost-ack tests, not only afterCommit-failure tests. |
| S5-02 | P1 | `apps/mobile/src/platform/web-sqlite/legacy-migration.ts:244–269`; `apps/mobile/src/platform/web-storage/role-state.ts:84–94` | Any USER role is accepted without reading `roles.migration()` or checking for a legacy key; migrated origin without marker and marker/role disagreement are not cross-validated. | Violates WEB-STORAGE §5's conflicting-dual-store fail-closed rule. The existing unit test explicitly blesses role/no-marker + legacy-present without reading it. Ignoring marker ownership also makes orphan deletion unsafe on internally inconsistent metadata. | Load/validate USER role and marker together; require matching marker/path/origin for migrated USER, probe legacy presence for an unmarked role, and block conflicting/ambiguous stores before unlinking anything. Keep both recovery sources; add disagreement/missing-role-with-marker tests. |
| S5-03 | P1 | `apps/mobile/src/platform/pack-install/web-store.ts:18–22`; `apps/mobile/src/platform/pack-install/web-port.ts:20–25` | `WEB_ATOMIC_ACTIVATION_PROVEN = true` is based on fake-client/memory-cell crash tests, not the required complete browser pointer/journal fault evidence. | B Run 2 explicitly says v2 update/rollback/update-mid-import were not rerun. More importantly, S5-01 demonstrates a missing real COMMIT-error branch. The capability currently authorizes production install despite that gap. | Set false until the corrected v2/kill specs and pointer/receipt uncertainty matrix pass with real IDB + sahpool. Keep the production gate closed while obtaining evidence; document exact run/build/results before restoring true. Passing only the v2 happy path is insufficient. |
| S5-04 | P1 | `apps/mobile/src/platform/web-sqlite/client.ts:333–350,382–388,467–480`; `apps/mobile/src/components/pwa-ui.tsx:72–100`; `apps/mobile/src/lib/handoff.ts:14–28` | closePath sets `closing` before an open transaction's owner can finish, then queues its close behind that owner. Update handoff closes the client without draining core transactions; its block is only UI state. | Independently reproduced: close pending, owner's COMMIT rejected STALE_SESSION, close still pending. The UI can remain on “Saving everything first” indefinitely. Background work is not gated by the overlay. | Gate new service mutations, await core transaction/job drains, then close paths and release ownership. Permit admitted owners to finish or explicitly coordinate rollback before a closing fence rejects them. Add shutdown-during-BEGIN/DML/COMMIT tests and update-during-write tests; do not force-terminate a shared worker as a substitute. |
| S5-05 | P2 | `apps/mobile/src/platform/web-sqlite/worker-core.ts:379–397,455–483`; `apps/mobile/src/platform/pack-install/opfs-stage.worker.ts:219–225` | SQL-worker importer hashes supplied bytes before sahpool rewrites header bytes 18/19; it does not independently reject non-DELETE headers. B does reject them. | Normal B→A production input is protected. But A's public import seam can report the expected digest for a different resulting file. Independently reproduced with an 8,192-byte synthetic file: input 2/2, pool 1/1, returned digest matches input, actual pool digest does not. | Check first-chunk/header 1/1 in A before import/hash acceptance as well as in B. For the deliberate USER migration normalization exception, explicitly distinguish source hash from normalized-import hash and validate the complete legacy export. Never “fix” catalog bytes to make a publisher hash pass. |
| S5-06 | P2 | `apps/mobile/src/platform/web-sqlite/client.ts:179–199,251–268,275–297` | No post-ready request deadline/liveness monitor; ready timeout does not cover init's reply or later SQL. | A silent worker loss/stall can leave a promise and its queue pending forever. This alone is a hang/unknown outcome, not proven loss or false Saved; unsafe retries would turn it into a durability problem. | Add visibility-aware liveness/recovery handling. On uncertainty freeze writes, retain receipts/generations and offer reload/reopen. Never infer not-committed from timeout, steal the Web Lock, replay a mutation or terminate merely to cancel search. |
| S5-07 | P2 | `apps/mobile/src/platform/pwa/image-cache/handler.ts:25–36,75–82` | Image responses are cloned before queue admission. The serial reader bounds only the clone currently being read, not waiting tee branches. | Concurrent viewed images can accumulate unbounded unread clone bodies while page branches consume the network. The enforced disk ledger does not bound this memory; body size may be unknown. No process-memory magnitude was measured here. | Acquire a bounded admission slot before cloning/teeing, bypass cache when busy, and bound/cancel queued branches. Test concurrent streamed responses with missing/lying Content-Length and a deliberately slow cache writer. |
| S5-08 | P2 | `apps/mobile/src/components/storage-screens.tsx:133–150`; `apps/mobile/src/platform/web-sqlite/legacy-migration.ts:328` | Blocked migration has no usable export/recovery hook, only instructions to reopen the old context. | >16 MiB/conflicting/corrupt-new cases preserve bytes but can strand users behind the same updated app. The contract calls for recovery/export, not silent reset or an unavailable old UI. | Provide an explicit legacy-only bounded recovery/export route without enabling jeep as the product driver. Keep legacy bytes untouched; cap automatic allocation; test the blocked path and external backup handoff. |
| S5-09 | P2 | `packages/core/src/services/candidate-validation.ts:24–50,65–80` | Existing R09 remainder: actual schema SQL is compared, but `schema_migrations` receipt values and `catalog_meta.schema_fingerprint` value are not compared with bundled expectations. | Pack integrity/trust is materially better than the original path, but the full stated validator contract remains incomplete. This is not a new SHA bypass or executable-publisher-SQL claim. | Request separately approved narrow validation work, preserving the core-unchanged storage-swap boundary, or obtain an explicit contract amendment. Add correctly hashed fixtures with altered receipt/fingerprint values. |

## Independent browser evidence for the P1s

### S5-01: actual SQLite commit, uncertain acknowledgement

I wrapped the real module Worker's message transport only: after the real worker returned successful COMMIT, one response was replaced with `{code:'IO', commitState:'unknown', inTransaction:false}`. No product code was edited. `Db` and its actual driver ran the transaction.

Actual returned state:

    first = {ok:false, code:'IO', name:'DomainError'}
    status = {writable:true, reason:'ok', message:null, maintenance:null}
    persisted = 1
    second = {ok:true}
    rows = [[1],[2]]

This is an injected lost-ack model, not a claim that SAH.flush physically failed on this host. The worker had committed; the adapter/core contract must handle that admitted unknown outcome without enabling blind retry.

I then composed the unchanged real `createServices` with the real web storage/port, real stage worker and sahpool client, a test-only memory role cell, and the actual small dev manifest. Exactly the receipt transaction's COMMIT acknowledgement was replaced after success. Actual output:

    injected = 1
    install result = {ok:false, code:'IO'}
    USER receipt = {status:'installed', version:'2026.10.31.001', generation:1,
                    activeRef:'/catalog-en/g-5g333y31366f1061.db'}
    adapter roles = {activeRef:null, previousRef:null, candidates:[]}
    catalogFiles = []
    USER storage status = {writable:true, reason:'ok'}

The receipt's pack SHA was `4a9578c3df7299fa0c4d70f17fcf34c70d5cd6d61cf986aa7243b2142c9c8be2`. This probe establishes a destructive catalog/receipt inconsistency, not loss of personal cards. For updates, the same catch calls restorePrevious and retires the new generation before reopened USER truth determines direction. B's uncertainty tests at `web-store.test.ts:462–505` inject afterCommit, which correctly produces PersistenceError; they do not exercise this COMMIT-rejection branch.

### S5-04: close during transaction

Real client/worker, synthetic USER table: BEGIN → INSERT → closePath → owner's COMMIT. Actual output:

    pendingBeforeCommit = true
    commit = {ok:false, code:'STALE_SESSION'}
    pendingAfterCommit = true
    resolvedAfterExplicitWrapperClose = true

The probe unblocked itself with explicit owner-wrapper close/rollback. Production handoff does not perform that step or a core drain. The 100 ms observations demonstrate pending state; the deadlock follows from queue ownership plus the permanent `closing` rejection, not from a claimed timeout benchmark. Separately, `update.ts:99–108` resolves normally on no-waiting-worker/activation timeout, while the shell only unblocks in catch; that path also needs explicit reload/recovery UI after shutdown.

## WEB-STORAGE §4 crash-row walk

The role-store implementation is structurally appropriate: a single IDB state record, read-modify-write inside one readwrite transaction, strict hint with fallback, resolve only on transaction complete (`role-store.ts:121–162`). The hint is not a universal power-loss/fsync guarantee. Transitions check expected active and candidate membership, atomically consume candidate membership, and never manipulate opaque VFS filenames.

| Crash/fault row | Implementation and evidence | Assessment |
|---|---|---|
| Transfer/decode/chunked import incomplete | `stage:145–204` records intent before staging; failed job only retires unreferenced target. Worker runImport removes its unique partial target. `reconcile.ts:28–79` protects mapped USER/active/previous/candidates. Unit crash cases `web-store.test.ts:386–423`; B reports real first-install decode/import kills and update decode kill. | Sound normal-state direction; browser quota/update-import proof remains incomplete in B's report. |
| PREPARED, pointer not committed | Core `catalog-install.ts:294–306` commits PREPARED before activation; IDB abort leaves the entire mapping unchanged. Core undoSwap discards staged membership only. Unit case `:425–435`. | Structurally correct; real IDB abort/kill matrix still required. |
| Pointer committed, no new USER receipt | Old active becomes previous in the same pointer tx; startup core inspect/undoSwap restores validated previous; first install removes uncommitted catalog. Unit cases `:437–460`. | Correct for known precommit interruption. Do not conflate with uncertain COMMIT. |
| USER receipt COMMIT uncertain | afterCommit rejection is PersistenceError and retains both generations; worker death/IO during COMMIT is not translated into that path. `Db` catches COMMIT separately. | FAIL: S5-01 independently reproduced. Freeze/retain and reread actual reopened USER before deciding. |
| Receipt committed, cleanup interrupted | Core validates active against receipt before discardPrevious on boot; membership-aware cleanup cannot discard a promoted candidate. Unit case `:508–518`. | Correct for successful acknowledged receipt; S5-01 bypasses the intended evidence retention. |
| New active invalid, previous valid; neither valid | Core checks active schema/meta, validates previous before restore; restoration switches pointer then retires displaced generation. If neither validates, existing core marks/isolate failure rather than inventing an empty catalog. Unit `:520–534` plus existing core recovery tests. | Correct under the adopted cheap-active-check contract, not a full rehash on every boot. |

Specific unlink conclusions:

- No normal `activate` path unlinks USER, old active or previous before the pointer transaction completes. Old active becomes previous; an older leftover previous is retired only after awaited activation (`web-store.ts:253–259`). This is not a cross-store commit.
- discardPrevious, restorePrevious and remove mutate role metadata first, await completion, then retire closed catalog paths. remove/uninstall intentionally removes the active catalog after clearing its role; it is not personal-data deletion.
- `discardCandidate` checks current membership before retirement (`:285–289`). A stale promoted active/previous ref returns false. `cleanupFailedJob` checks role references. No normal promoted-generation deletion was found in those helpers.
- `reconcileWebStaging` runs before core recovery, under the lifetime writer lock, with no live installer. Its role snapshot protects every promoted generation; catalog-regex confinement excludes `/user`. Corrupt metadata propagates rather than triggering a sweep. It is safe under that boot-only/no-concurrent-transition premise, not a general concurrent GC.
- `referencedPaths`' comment says “and any import intent,” but the function actually omits intents. Reconcile handles intents separately; failed-job cleanup deliberately must remove its own interrupted target. Do not reuse that helper as an all-reference GC oracle without fixing its contract.
- A migration, unlike catalog reconciliation, can unlink `/user/m-*`: only staged-orphan cleanup and failed-migration cleanup are intended. S5-02 requires marker/role consistency before classifying such files as disposable.
- `WEB_ATOMIC_ACTIVATION_PROVEN` must be false on the evidence inspected. Concurrent test-child work is not presumed either failed or successful; no later verified result was supplied to this review.

## Import integrity, admission and durability

- B's decoder hashes exact decoded chunks and uses checked writes at explicit offsets; error exits prevent completion. After flush it checks SQLite magic and bytes 18/19 == 1, without modifying them (`opfs-stage.worker.ts:172–178,219–226`). Compressed count/hash, raw count/hash, window and cancellation checks remain fail-closed.
- A hashes the exact slices returned to the pinned `importDb` supplier (`worker-core.ts:388–397,455–483`), then compares both byte totals and digest. It does not rehash through a whole-catalog export in production.
- Inspected the actual pinned bundle, not only API descriptions: `node_modules/@sqlite.org/sqlite-wasm/dist/index.mjs:16784–16811` writes supplied chunks, checks their writes, then overwrites bytes 18/19 with 1/1 and calls setAssociatedPath. `:16535–16551` writes association metadata, flushes, and updates the free set. Therefore the verified digest equals pool bytes for B's valid 1/1 input; it is NOT generally true for A's unrestricted input (S5-05, reproduced).
- The admission-barrier concern is addressed for the current seam: runImport claims the path, creates/writes/closes its placeholder synchronously before the next hash/import await, and public import selects the already-associated SAH. USER journal allocation cannot pick that associated slot. Worker/client reject opening/unlinking the importing path. A VFS-wide barrier is not required for this verified pinned algorithm.
- A's interleave browser spec (`web-sqlite.spec.ts:78–105`) actually asserts multiple USER commits, USER integrity/count and candidate hash after import. A reports 41 interleaved commits for its 20 MB run. I inspected those assertions and ran the unit suite, but did not rerun that browser spec myself.
- Ordinary staging short writes retry/fail; pool data-chunk short writes throw in the pinned implementation. Quota/import exceptions remove only the target; hard kill can leave a placeholder/orphan which intent + pool enumeration reconcile. This is recovery, not atomic import or proof against physical-device power loss.
- Writable opens apply/read back DELETE, FULL (2), foreign_keys=ON and mmap_size=0 (`worker-core.ts:231–258`). Pinned xSync/flush and synchronous COMMIT provide durability; durableBarrier is ordered handle health, not another file export or a portable explicit fsync proof.
- Barrier failure latches; observed worker error/messageerror/death rejects pending requests as unknown and latches writable wrappers. Reopen closes/discards handles, opens existing files without create/autosave, reapplies PRAGMAs, and replays no SQL. Core recover verifies FK enablement. These positives do not repair S5-01's separate COMMIT-error branch.
- Silent death without an event can hang indefinitely (S5-06); it does not itself acknowledge an unsaved mutation. Any recovery/watchdog must preserve unknown outcome semantics.

## WEB-STORAGE §5 USER recovery decision walk

| Store/marker situation | Actual behavior | Assessment |
|---|---|---|
| Valid new USER + matching completed marker | Existing role path validates migration history; legacy is not replayed. | Normal result is correct; code does not actually inspect the marker to establish the premise. |
| Unmarked fresh USER, no legacy | Existing role accepted after history check. | Correct. |
| USER role without marker + legacy present/differing | Immediate existing; legacy reader never called. Unit test `legacy-migration.test.ts:87–93` explicitly asserts this. | FAIL CLOSED requirement violated, S5-02. A's assignment-table explanation does not amend WEB-STORAGE/ADR-052. |
| Migrated role missing marker, marker/USER mismatch, marker without role | No cross-field decision: marker is never consulted by ensureUserDatabase. | Must block before orphan cleanup or stale-source migration. Shape-valid metadata is not proof of provenance. |
| No role + no legacy + no USER file | Creates unique fresh u-* file, closes, commits role. | Correct; no jeep fallback. |
| No role + empty u-* orphan / nonempty USER evidence | Adopts a checked-empty u-*; nonempty chosen u-* or m-* without legacy blocks. | Conservative normal crash recovery; multiple conflicting USER files deserve explicit ambiguity tests rather than adopting the first empty one. |
| No role + legacy + staged migration orphan | Deletes m-* staging orphans and retries from retained legacy to a unique path. | Correct only once marker/provenance consistency is established; otherwise m-* may be the newer personal copy. |
| Corrupt/unreadable/future new USER | Missing/history/query failure blocks; no replacement with a fresh DB. | Positive. Healthy-start check is history-based, not a full personal-data integrity scan. |
| Oversized/corrupt/unsupported legacy, quota/import failure | Header/page-size/history/integrity/FK checks and 16 MiB cap; no committed role on failure; original legacy key untouched. | Positive preservation; usable blocked recovery/export remains missing (S5-08). IDB Uint8Array is materialized before its size cap can be applied. |
| Crash before role+marker transaction / after it | Before: retry from retained legacy; after: role path reused without replay. Both committed together by RoleStore. | Positive normal migration. Reopen/value-equality proof is in tests; production migration itself compares personal counts before/after operational reset, not a full canonical readback after marker commit. |

Migration reads only `jeepSqliteStore/databases/flashydex-userSQLite.db`, with no legacy writes/deletes or catalog-key deserialization. It imports USER only, checks integrity/FKs/history, resets bundled operational catalog/install/sync/admission state, preserves personal tables and revision, closes before committing role+marker. The real-row canonical equality and rerun/no-duplication unit assertions were inspected and passed as part of 241 mobile tests. A's real-IDB migration browser test body was inspected; its marker storage harness is a localStorage stand-in, not B's real IDB role store. Retaining the legacy key and avoiding duplicate replay are good; they do not justify choosing conflicting USER stores silently.

## ADR-055 assessment: accept-with-conditions

The page-size decision is technically sound and preferable to a catalog-sized cache. It changes physical layout, not schema identity or core SQL. `build-db.ts:47` sets 65536 before migrations/first table; VACUUM occurs in DELETE mode; `verifyCatalogDb:151–152` checks the closed result, including the builder's decompressed round-trip verification path. All builder tests/typecheck passed in this review.

Reasons and compatibility checks:

1. SQLite's two-byte page-size encoding uses `00 01` for 65,536, not zero and not a literal two-byte 65536. It is independent of write/read format bytes 18/19. B checks 18/19 only; it does not misread 16/17 as a fixed 4 KiB requirement. Legacy header parsing explicitly handles sentinel 1 as 65536.
2. I independently built tiny SQLite fixtures and imported them through A's real staged-file supplier and sahpool, then used DEV-only whole export of these SMALL synthetic files to compare digests. This is test evidence, not production permission to export catalogs:

   | Fixture | Header bytes 16–19 | Raw bytes | Largest import chunk | Reopened page_size | cache_size | integrity | Pool SHA equals input |
   |---|---|---:|---:|---:|---:|---|---|
   | 4 KiB | 16,0,1,1 | 8,192 | 8,192 | 4,096 | -32,768 | ok | yes |
   | 64 KiB | 0,1,1,1 | 131,072 | 131,072 | 65,536 | -32,768 | ok | yes |

3. Pinned sahpool chunk import requires a plausible header and total divisible by 512, not a fixed 4096-byte page or page-aligned supplier chunks. Its VFS header offset is private and irrelevant to the public format. Product code uses no raw opaque-file offsets. The compatibility probes above validate actual import, not merely parsing.
4. B's <=256 KiB decode/import chunks are byte-stream chunks, not SQLite pages; a page may span chunks. No decoder adjustment is needed for 64 KiB. Maximum zstd window remains independent.
5. A uses NEGATIVE `cache_size`: `cacheKiB` remains KiB, not a page count. USER=2048, catalog=4096, validation=32768 currently. The seam comment still says validation=1024 and should be reconciled. Larger pages reduce the number of cached pages and increase per-miss/journal granularity; neither a cache suggestion nor a 64 KiB page guarantees total memory bounds. Validation closes its wrapper, but WASM committed high-water can remain allocated.
6. Existing 4 KiB packs remain valid DEVICE installer inputs, confirmed by the real import above. The builder verifier's strict new page-size check is appropriate for NEW builds, not a requirement to reject historical published packs in the app. No runtime fixed-page-size rejection was found.
7. Standard contemporary native SQLite understands 64 KiB SQLite pages; no Capacitor API/page-size conversion is needed. That is compatibility reasoning, not actual iOS/Android bridge evidence. Confirm the shipped SQLCipher/SQLite builds can open/check/refresh/rollback these packs before enabling the native path; native writes remain explicitly disabled here.
8. For future PAGE-based deltas, 4→64 KiB is a base-geometry change: require full-pack fallback unless the delta format explicitly rebuilds geometry. Bind exact base/target hashes, sizes, versions and page geometry; refreshed active catalogs are not necessarily the original immutable base. Current delta application is deferred, so this is a future condition, not a demonstrated current regression.
9. Repaging changes raw/compressed bytes and SHA: publish under a NEW immutable version (ADR says .003 onward), regenerate manifest lengths/hashes/metrics, retain old artifacts, and never republish an existing version's bytes. Core's same-version/different-hash guard remains enabled.

Performance provenance: the task supplies the director-verified real onboarding install: 16.5 s total, download 0.4 / decode 7.9 / import 3.2 / validate 4.0 s, aggregate JS heap peak 35 MB, origin storage 121.7 MB, search + reload OK. ADR-055 records the comparative 4/16/64 KiB validation results; `.agent/scratch/out-full64.json` also contains a separate director probe (12,303 ms install, 3,475 ms validate, page_size 65536). I inspected that artifact but did NOT rerun those full-pack timings. They are not my measurements and are not interchangeable runs. Accept the improvement; keep native/Safari, memory and fault conditions explicit rather than claiming all platforms need no verification.

## Trust and memory assessment

Trust:

- `catalog-config.ts:4` defaults to ONLY `https://flashydex-catalog-packs.netlify.app`. Explicit build-config override remains intentional; DEV app-origin trust does not enter production. No `.env` or credential files were read.
- Core validates requested/final manifest origins and all pack/delta/index URLs, secure scheme, version/downgrade/immutable-version semantics. ANY present signature, including null/nonverified content, is rejected before schema parsing (`manifest-validation.ts:56–59`). Core manifest tests passed with the full suite. Unsigned Phase 1 trust is HTTPS publisher-origin trust, not cryptographic publisher authentication against a compromised host.
- Manifest fetch is bounded and `cache:'no-store'`; pack fetch is streaming and `no-store`, with final-origin validation. SW `routes.ts:29–45` puts pack host, catalog-manifest, .zst/.db and dev-packs before navigation/precache; `sw-core.ts:32–33` goes directly to network with no cache fallback. Vite precache excludes dev-packs and database/pack files. No stale-manifest Cache Storage path was found.
- SW forwards the Request's cache policy; it does not itself force no-store for arbitrary manually navigated pack URLs. Product fetches supply no-store. Real pack-host HTTP headers, canonical redirects and deployed SW still need readback. Shell-f explicitly reports missing CSP; no deployed policy was verified here.

Memory:

- The supplied aggregate 35 MB JS observation is below ADR-054's 128 MiB threshold, but does not prove separately committed WASM <=96 MiB, combined non-overlapping <160 MiB, absence of missed spikes, sustained two-language use, phone survival or Safari evidence.
- Inspected full-install's CDP sampler: it attaches worker targets and sums observed usedSize. Failed tick samples are omitted from the sum; a worker never attached has no stats entry. Coverage must explicitly establish SQL + decoder targets throughout their lifetime and report sampling failures/gaps. No independent full-pack trace or WASM high-water collection was performed by me.
- Product catalog path: no response.arrayBuffer/blob/text for packs, no main-thread raw-catalog allocation, no SQL catalog deserialize/export, no full-file WebCrypto hash. Main/SQL-worker messages pass staging references and counters. A uses one <=256 KiB supplier buffer; B reads compressed stage in 64 KiB blocks and writes decoded slices synchronously. fzstd window is guarded <=32 MiB. This is fundamentally bounded by chunks/window, not raw catalog size.
- B's initial zstd-header probe copies the first received network chunk rather than just the small required prefix; the default fetch reader's chunk size is not an application hard cap. It is worker-side, not a demonstrated main-thread catalog buffer; hard-cap/copy only the header prefix and document network-chunk assumptions for strict input-budget proof.
- The 32 MiB validation cache is a measured tuning deviation from the original planning cache, not a 32 MiB whole-file load. Close it promptly and measure actual WASM high-water, including EN+JA and refresh. Page-size gains do not waive ADR-054.
- One-time <=16 MiB USER migration is the explicit whole-array exception; IDB cloning may allocate a larger existing value before its length can be checked. Large-backup creation/picking still has prior-review whole-buffer/caller-thread work outside the catalog pipeline; Stage F does not close that unrelated prior finding.
- Image tee queue retention remains S5-07. A valid disk payload ledger does not prove bounded browser/process memory or protect USER from origin-level eviction.

## W01–W14 status

“Partial” means inspected implementation/real unit evidence exists, not that the complete release gate passes. No builder/device claim is promoted to my independent browser execution.

| Gate | Status | Evidence actually inspected / remaining |
|---|---|---|
| W01 | partial | Pin/package, explicit sahpool initialization/preservation/probes, runtime code and A's browser spec/report inspected; my worker probes opened real storage. Complete release-origin failure matrix not independently rerun. |
| W02 | partial | Executor/client test bodies and all mobile tests pass; real COMMIT probes expose S5-01 and close/admission probe exposes S5-04. No false complete parity sign-off. |
| W03 | partial | B's streaming code/counters and supplied director full-EN 35 MB observation; independent small 4/64 KiB import parity. No independent full-pack allocation trace, WASM/combined high-water or physical Safari memory run. |
| W04 | partial | Director reports full install/search/reload; source keeps catalogs separate, absent is null, reopen has no autosave/replay. No independent offline installed-PWA personal/custom/history mutation/export and close-all-browser cold-launch matrix. |
| W05 | partial | Real core + fake A/memory-cell crash-table tests inspected and passing in mobile suite. Real receipt-COMMIT uncertainty FAILS (S5-01). B Run 2 admits unexecuted v2 update/rollback/kill tests; browser + Safari boundary matrix remains open. |
| W06 | partial | Pre-associated slot implementation and pinned algorithm verified; A browser interleave assertions/report inspected; my 4/64 KiB hash parity. Estimator includes compressed + two raw copies + safety, units pass. Real low-space/slot-exhaustion/kill coverage on target devices still needed. |
| W07 | partial | Protection/install controllers/copy and Settings/Diagnostics source, passing unit suite. No actual Safari grant/container/privacy/extended-lifecycle evidence; no universal persistence promise accepted. |
| W08 | open | Core synthetic suite passes; director reports search works. No independently executed real-EN 10 warmups/100 exact/prefix/contains/filter repository samples with p50/p95/max/raw data. Successful search is not this gate. |
| W09 | partial | Bootstrap lock-before-prepare, missing locks fail closed, no steal, A exclusivity browser assertions/report inspected. No independent app-level two-tab crash/takeover or Safari tab/Home Screen shared-container run. |
| W10 | partial | USER migration equality/rerun/failure unit bodies pass; A real-IDB seed browser body/report inspected. Conflicting marker/store branch violates contract (S5-02); real role-store boundary kills and usable blocked export remain incomplete. |
| W11 | partial | Routes/network-only/guarded misses, Vite injectManifest/prompt/exclusions and C's release-SW report inspected; unit suite passes. No independent release build/offline worker+lazy-route run or Netlify canonical/header/WASM-MIME/CSP readback. |
| W12 | partial | Reservation→Cache.put→ledger commit/reconciliation and dedicated lock source inspected; unit engine tests pass; C reports real stores/small-cap smoke. Real SW termination/quota/full-cap evidence missing; S5-07 input/tee memory bound remains. |
| W13 | open | Prompt/update controller exists; unit suite passes. Actual shell does not drain core/release lock before activation; closePath transaction probe fails. Dirty/busy/update-cancel/timeout/multi-tab release-build tests required after fix. |
| W14 | partial | Startup/worker/pool/commit marks and Diagnostics data wiring inspected; no full healthy-start catalog integrity scan found. No mid-range phone offline 10-cold-launch p95/interactive/gate/resume evidence. Full install time is not startup time. |

## [needs owner input]

- Physical Safari iOS/iPadOS 17 and 18, each Safari tab AND Home Screen: exact device/OS/build/origin, full 64 KiB EN install, Inspector memory, kill/recovery/low-space/offline personal data and backup round-trip evidence. Desktop Chromium/API support does not close it.
- Confirm canonical production origin and provide/verify deployed build + immutable .003-or-newer pack manifest with actual hashes/lengths/CORS/no-store headers; verify redirect, SW scope, WASM MIME, complete offline shell and update behavior. No host migration may imply automatic transfer of local collections.
- Record actual persist outcomes and whether tab/Home Screen storage/locks are shared on each iOS version; provide safe external backup/import instructions before a container switch. Extended seven-days-of-Safari-use observation remains explicit, not simulated by changing the clock.
- Mid-range-phone startup, sustained navigation/search/EN+JA memory, and real-EN repository p95 sample set with hardware/build/raw samples.
- Before later native enablement: Mac/iOS and Android bridge open/integrity/refresh/rollback evidence for 64 KiB packs and low-space/backup exclusion checks. This does not block the architectural page-size choice or authorize pretending native writes are implemented.
- If preserving the stricter bundled receipt/fingerprint validator contract, approve separately scoped core validation changes (S5-09). Do not edit core silently to make this storage swap look complete.

No questions were asked and no implementation changes were made. This report is the deliverable; P1s and evidence gaps remain outstanding.
