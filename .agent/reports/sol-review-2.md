FlashyDex — GPT Sol re-verification after Stage D
Verdict: not yet

Scope

Independent review of R01–R13 in sol-review.md against BRIEF OWNER UPDATEs, docs contracts, the Stage D contract and API.md Director notes at lines 521–533. Director/child reports were treated as claims, not evidence. D40's in-place transactional restore, D42's insecure-origin read-only mode, D44's deliberately disabled native catalog writes, and the parent UUID/HTTPS changes are recognized; I am not reporting those documented decisions as accidental regressions.

Reviewed implementation/test state: 74d6ec1b34468a00f0664f368178ee03150ac46f. HEAD advanced externally to 0940152af56d1ec554d7d9f00304006bf8c491ed during the review; git diff shows only the unrelated Grok copy-review report changed. No implementation changed between those commits. I did not commit, push or edit implementation/docs/configuration. My only repository file is .agent/reports/sol-review-2.md. Diagnostic scripts/config/logs are in C:/Users/AshtonSeabolt/AppData/Local/hermes/cache/scratch/.

Execution host: Windows kernel 10.0.26300, Intel Xeon Platinum 8370C @ 2.80 GHz, Node v24.19.0; pytest used Python 3.12.10. No native execution or physical-phone result is claimed.

1. Gates — actual commands and pasted output

npm run typecheck — exit 0

  > flashydex@0.0.0 typecheck
  > npm run typecheck --workspace=@flashydex/core && npm run typecheck --workspace=@flashydex/schemas && npm run typecheck --workspace=@flashydex/mobile
  > @flashydex/core@0.0.0 typecheck
  > tsc --noEmit -p tsconfig.json
  > @flashydex/schemas@0.0.0 typecheck
  > tsc --noEmit -p tsconfig.json
  > @flashydex/mobile@0.0.0 typecheck
  > tsc --noEmit -p tsconfig.app.json && tsc --noEmit -p tsconfig.node.json

npm run lint — exit 0

  > flashydex@0.0.0 lint
  > npm run lint --workspace=@flashydex/mobile
  > @flashydex/mobile@0.0.0 lint
  > eslint .
  21 problems (0 errors, 21 warnings)

All warnings are react-refresh/only-export-components. Root lint covers mobile, not the entire monorepo.

npm test — exit 0, no performance skip

  > npm run test --workspace=@flashydex/core && npm run test --workspace=@flashydex/mobile && bash scripts/test-recognition.sh
  RUN v5.0.5 C:/Projects/flashydex/packages/core
  Test Files 21 passed (21)
  Tests 275 passed (275)
  Duration 49.54s
  RUN v5.0.5 C:/Projects/flashydex/apps/mobile
  Test Files 6 passed (6)
  Tests 22 passed (22)
  Duration 7.80s
  platform win32 -- Python 3.12.10, pytest-9.0.2
  collected 1 item
  services\recognition\tests\test_health.py . [100%]
  1 passed, 1 warning in 0.63s

The Python warning is the Starlette/AnyIO BlockingPortal deprecation.

npm run build — exit 0

  > @flashydex/mobile@0.0.0 build
  > tsc -b && vite build
  vite v7.3.7 building client environment for production...
  2578 modules transformed.
  Some chunks are larger than 500 kB after minification.
  built in 9.89s
  PWA v2.0.0
  mode generateSW
  precache 60 entries (2180.92 KiB)
  files generated
    dist/sw.js
    dist/workbox-9c191d2f.js

Rollup also emitted two Zod pure-annotation warnings. Independent inventory: total dist bytes 2,490,076; no dev-packs files or .db/.zst payloads; assets/sql-wasm.wasm present. The production jeep chunk contains:

  static async saveDBToStore(t,e,r){try{return await r.setItem(t,e),Promise.resolve()}...

Thus the shipped save is one setItem, not remove-then-set.

npm run e2e — exit 1, infrastructure/configuration failure before tests

  > flashydex@0.0.0 e2e
  > npm run e2e --workspace=@flashydex/mobile
  > @flashydex/mobile@0.0.0 e2e
  > playwright test
  Error: Timed out waiting 60000ms from config.webServer.

The checked-in config does NOT provide a separate private server: apps/mobile/playwright.config.ts:10,25–29 targets HTTP :3200 with reuseExistingServer:true. The parent's server is HTTPS on that port. I did not stop/restart it or manually start another server.

To distinguish broken configuration from product failures, I ran the same suite with a scratch-only configuration inheriting the projects/tests, using https://127.0.0.1:3200, ignoreHTTPSErrors:true and webServer:undefined:

  npm run e2e --workspace=@flashydex/mobile -- --config C:/Users/AshtonSeabolt/AppData/Local/hermes/cache/scratch/sol-d-playwright.config.ts
  Running 20 tests using 2 workers
  20 passed (1.5m)

This covers mobile 390×844 and desktop 1280×800, including instance lock, actual IDB quota failure, .fdx backup/fresh-context restore, language-specific install failure, routes, startup and pack harness cases. It does NOT turn the unmodified root e2e command green. Self-signed-certificate bypass in automation is not proof of trusted TLS on an iPhone.

Additional execution:

  npm test --workspace=@flashydex/catalog-builder
  Test Files 3 passed (3)
  Tests 24 passed (24)
  exit 0

  npm run typecheck --workspace=@flashydex/catalog-builder
  tsc --noEmit
  exit 0

Re-ran the nine relevant core files with --reporter=verbose: 125/125 passed. Counts parsed from actual test output, not copied from the director:

  backup.test.ts                 34
  sync-modes.test.ts             20
  install-recovery.test.ts       18
  install-settings.test.ts       13
  manifest-validation.test.ts    10
  candidate-validation.test.ts   10
  coordinator.test.ts             7
  persistence-latch.test.ts       7
  perf.test.ts                    6

The reports' sync-modes 22, candidate-validation 11, coordinator 16 and persistence-latch 12 are not the current per-file counts. There are seven additional R10 cases within the twenty sync-modes cases; do not double-count them.

2. R01–R13 disposition

R01 — fixed for the demonstrated web multi-tab overwrite.

Read apps/mobile/src/platform/instance-lock.ts:21–40,49–58 and data/bootstrap.ts:38–53. Web Locks are acquired before opening USER storage and held until page disposal. A denied tab never opens storage; unsupported Web Locks produces the documented write block. Core's instance lock is checked before and after transaction queue admission (packages/core/src/db/sql.ts:145–149,191–197).

Ran instance-lock.spec.ts's “a second tab is refused ... closing the first ... without losing data; reload keeps working” at both viewports: 2/2 passed. It checks denied reload, close/takeover, retained one copy, adding a second, and reload persistence. persistence-latch.test.ts's INSTANCE_LOCK case also passed within 7/7. Actual process-crash/BFCache/multiple-waiter takeover permutations are not established by a tab-close test, but the original silent second-writer path is closed by an origin-wide browser lock.

R02 — partly fixed; ordinary add retry is fail-closed, but import can still return undurable success.

Read db/sql.ts:156–166,191–219; services/storage.ts:19–22; apps/mobile/src/platform/sqlite.ts:88–98; components/storage-status.tsx:30–58; patches/jeep-sqlite+2.8.0.patch:5–47. Ordinary queued transactions now latch on flush failure. Web intentionally requires a real reload instead of a save-on-close “reopen.” The patch removes the crash-prone removeItem and the built production chunk confirms it.

Ran persistence-latch.test.ts 7/7, including PRE/POST recovery and transfer replay, and persistence-failed.spec.ts 2/2 on actual browser IndexedDB put fault injection. However, transfer/service.ts:264–268 returns an in-memory receipt before checking the persistence latch. Its own test at persistence-latch.test.ts:89–98 explicitly allows success before recovery. My additional PRE-persisted-state probe returned createdCopies:1 while storage remained persistence_failed, then reopened to zero copies. N05 below remains P1; receipt-first must not mean unverified-durability-first.

R03 — fixed by the parent, verified independently.

Read apps/mobile/src/lib/uuid.ts:2–10, data/bootstrap.ts:8–10 and platform/app-platform.ts:67,74,89. All those ID paths use the shared helper; fallback uses getRandomValues and sets v4/version and variant bits, never Math.random. My no-randomUUID probe generated 1,000 UUIDs: 1,000 unique, all valid v4. HTTPS core-flow passed at both viewports. Plain-HTTP read-only is the documented D42 limitation, not a product failure. Physical LAN phone TLS trust/secure-context behavior still needs a phone.

R04 — partly fixed, deliberately capability-disabled; native writer is not implemented.

Read apps/mobile/src/platform/pack-install/native-store.ts:22–36,192–198; platform/app-database.ts:32–58; packages/core/src/db/database-set.ts:125–127. No read-only NC writer fallback remains. NATIVE_CATALOG_WRITES=false and openWritableNative throws. This closes the false capability claim but does not deliver native prices_only/refresh/incremental. The copy/writeback design is comments, not working code; Android path remains unresolved.

Ran sync-modes.test.ts “all three modes ... honest false + reason otherwise” and sync.test.ts capability coverage through the 275-test root suite. They prove core capability refusal, not the native bridge. D44 permits this interim switch; enabling it needs implementation plus Mac/device proof, not just flipping a Boolean.

R05 — fixed for the original unbounded decoded pending queue; native memory acceptance remains open.

Read bounded-decoder.ts:46–67,81–111 and pack-install.worker.ts:97–117,128–167. The emission callback enforces expected output and a 32 MiB queued+unacknowledged hard cap before copying; input is sliced and drained. This is a bounded fail-fast implementation, not a claim that all high-ratio valid streams can be installed: default slicing intentionally rejects the 64 MiB bomb near the cap.

Ran bounded-decoder.test.ts 6/6 as part of mobile's 22/22: high-ratio 64 MiB with 16-byte input slices, default-slice hard-cap rejection, expected-size rejection, cancellation, garbage, fixture size. HTTPS pack-install tests also passed with pendingBytesMax assertions. Native process RSS/window/library overhead and full real-pack behavior remain unmeasured; four posted messages alone are no longer presented as total memory evidence.

R06 — partly fixed; recovery still loses a retained valid catalog in uncovered states.

Read catalog-install.ts:249–299,302–335,360–375,527–600 and mobile web-store.ts:97–110/native-store.ts:137–150. Prepared journal persistence and disk-based inspect are real improvements. Ran install-recovery.test.ts 18/18, covering native-style rename gaps, first install, rollback, disk-full, and receipt-flush PRE/POST outcomes.

Those tests do not cover web's distinct active-put-before-candidate-delete gap, nor validation before discarding a retained previous file. My probes reproduce both defects. Normal installation also commits the receipt and deletes previous without validating the activated file. See N01: this is not closed by eighteen happy/fault cases on a rename-style fake.

R07 — partly fixed; refresh/fill-in exists, exact replay fails after a real nonzero installation epoch crosses restart.

Read sync.ts:163–245,272–320,380–391,448–490,527–604,608–668. Refresh and incremental are implemented. I recognize API.md:531's adopted header semantics: incremental checks new/unpublished/changed sets and skips unchanged ones. This review does not relitigate that documented semantic choice.

Ran sync-modes.test.ts 20/20. Named evidence includes “fills in the whole set ... keeps owned rows and revision,” shell publication/recheck, frozen discovery, and prices_only/refresh “FIRST observation wins ... upstream response CHANGED.” These replay tests seed catalogs through installCatalog(), which invalidates handles without bumping content epoch (test/helpers.ts:31–35). My real installer-service probe starts at epoch 1, kills between commits, restarts at epoch 0, and refetches changed prices rather than replaying: N02. A set-fetch 404 also produces completed with a failed set and null lastError: N06.

R08 — partly fixed; useful .fdx round-trip exists, but resource safety and restore exclusion are incomplete.

Read backup/archive.ts:42–65,72–168,189–269,288–341; backup-service.ts:94–121,131–163,184–242,250–287; schemas/backup.ts:8–18,32–66. This is no longer a stub. D40's in-place transaction is honored as the binding activation design. Safety archive is written, re-read, hashed and parsed before destructive SQL; operational device rows stay on-device; snapshots/settings/history restore with absent or newer catalogs.

Ran backup.test.ts 34/34, including exact rich canonical dump at lines 163–226, safety-backup reversal at 332–343, zero-write preview, rollback after delete/insert, expiry/staleness, and hostile archives. Browser core-flow .fdx round-trip passed 2/2. Remaining defects are actual inflation allocation before cap enforcement (N04), missing core maintenance fencing against personal edits during restore (N03), and absent CRC checks (N08). Optional images are warned as unsupported; no image-byte restoration is credited. zipSync/JSON work runs synchronously on the calling thread, not the specified backup worker.

R09 — partly fixed; manifest/candidate validation is substantially stronger, activated-file safety remains incomplete.

Read manifest-validation.ts:56–115, candidate-validation.ts:24–86, mobile pack-install/index.ts:31–75 and pack-install.worker.ts:82–84. Ran manifest-validation 10/10 and candidate-validation 10/10. Named cases reject any present signature, downgrade/same-version hash drift, bad calendar revisions/counts, untrusted URLs, triggers/views/extra objects, schema drift, FK violations, and integrity transport failure. Bounded manifest reading and real pack hash/size rejection are exercised in browser tests.

Unsigned Phase 1 is intentional; no signature authenticity is claimed. Candidate exact normalized sqlite_master definitions are compared with bundled objects. However, initial candidate validation is not activated-file validation; see catalog-install.ts:311–334 and N01. Boot's cheap schema/meta policy is accepted per API Director notes, but deleting the only good previous copy before even that cheap check is not. Candidate validation also does not inspect schema_migrations receipt values or the catalog_meta schema_fingerprint value; actual object SQL comparison provides substantial schema protection but is not every older contract check.

R10 — partly fixed; admission races closed, operation-wide reader/personal-restore barriers incomplete.

Read db/coordinator.ts:38–78 and database-set.ts:65–100,133–170,174–182. Ran coordinator.test.ts 7/7 plus the seven R10 sync-modes cases: both install/sync start orderings, uninstall/rollback refusal, epoch fencing, barrier waiting and consistentRead retry all pass. Restore also refuses an already-admitted install (backup.test.ts:282–289).

But only collection-list.ts:50–52 wraps a public repository read in consistentRead. Catalog search/detail/set reads, copy hydration and dashboard are not operation-wide pinned/retried. An already-obtained handle can be closed between search's count and select: my probe gets an untyped “The database connection is not open,” N07. WorkCoordinator admission does not block ordinary personal transactions; a queued edit during restore is accepted and changes the restored row, N03. Durable epoch fencing itself also fails across restart, N02.

R11 — partly fixed, not fully frozen-run complete.

Read run-guard.ts:5–38,44–62; cli.ts:114–163,171–193; crawl.ts:40–50,88–95; http.ts:148–166; verify-pack.ts:44–52; .github/workflows/catalog-packs.yml:74–80,114–142. Builder 24/24 and typecheck pass; run-guard.test.ts contributes 10 tests, including changed selection/schema/toolchain refusal, immutable drift, false verification fields, URL/config cache binding and discovery revalidation.

verify-pack now fails nonzero, immutable .db/.zst publication is guarded, new discovery bypasses cache, and draft assets are downloaded and compared before publication. I did not run/publish the workflow. Remaining: responses still live in a language-wide cache rather than frozen run-specific payload storage; resume uses Infinity, new card details may reuse 24-hour cache, and the binding records a hard-coded builder package version rather than git content identity. This is not a fully frozen response set or proof every new run refreshed all details. Reports correctly leave card-detail revalidation open; do not mark R11 wholly fixed.

R12 — partly fixed; Node methodology/batching improved, acceptance evidence still incomplete.

Read perf.test.ts:11–15,41–52,65–107; collection-list.ts:174–187; apps/mobile/PERF-PROCEDURE.md is the device procedure, not measurements. Ran 6/6 perf cases twice through root and targeted execution: 40,000 catalog rows, 10 warmups/100 samples, 10,000 copies and one batched whole-group ID lookup per page. Targeted Node p50/p95/max in ms:

  search char prefix        40.9 / 64.4 / 97.3
  search pikachu prefix     13.4 / 23.3 / 46.5
  search char contains      29.2 / 46.1 / 112.2
  collector 19              10.6 / 17.9 / 18.3
  charizard + localId20      4.1 /  6.1 /  7.3
  collection created       28.2 / 43.6 / 77.3
  collection name          28.7 / 36.1 / 83.7
  collection count         34.2 / 38.9 / 91.6
  collection q=char        11.3 / 13.2 / 16.2

All tested p95 values are below 300 ms on this host. This does not measure device bridge latency, dashboard's 500 ms budget, main-thread backup/restore long tasks, or phone interaction under persistence/install. The perf fixture's “giant” groups are forty groups of 100 plus 1,200 groups of five, not a single 10,000-copy group. Do not claim full criteria 63–65 acceptance from these results.

R13 — partly fixed; adapter improvements are real, native submission work remains.

Read platform/platform.ts:20–25; mobile app-platform.ts:34–59,153–171; native-http.ts:13–46; native-store.ts:120–122; PrivacyInfo.xcprivacy:12–23; App.xcodeproj/project.pbxproj resources section:155–169. The picker checks File.size before arrayBuffer. Native TCGdex metadata uses CapacitorHttp. Ran native-http.test.ts 6/6 within mobile's 22/22: mapping, 204/304, string parsing, plugin failure, abort/late response and timeout. No actual device HTTP result is claimed.

An optional imageCache interface now exists (Director notes explicitly allow interface-only), but it is not a functioning bounded cache. PrivacyInfo exists on disk but is not in the Xcode resource target. Free-space preflight returns null. SQLCipher/export-compliance and merged archive audit remain owner/Mac work. Native writer R04 remains missing, not magically proved by these six mocked transport tests.

3. Regression and safety sweep — independently measured

Catalog reinstall invariant

I ran and read install-settings.test.ts:47–57, “reinstalling a newer version keeps owned_cards count and every personal row (37).” It passes, but its fixture is only three graded copies and its comparison deliberately blanks price_snapshots; helper dumpPersonal omits settings/annotations.

I therefore ran an additional richer replacement probe through CatalogInstallService and real temporary SQLite files: three catalog copies with grade/acquisition/location/group/zero cost/manual EUR value/notes, plus a JA custom copy. Compared canonical personal dump, settings, annotations and collection revision before/after a newer-version activation. Result:

  rich-reinstall-invariant: personalEqual=true, owned=4

This is positive evidence for the fundamental owned-row invariant. It is a service-level real-file/fake-download test, not a repeat of the prior review's full web-worker rich-data experiment or native install proof. The stock backup rich fixture and refresh invariant tests also pass. No Stage D catalog path was observed mutating owned rows.

.fdx security

Traversal/absolute/drive/backslash/NUL/unknown entry/duplicate/symlink/encryption/version/hash/count/FK tests pass with zero application DB mutation. No archive-selected filesystem extraction path is used, so a path-traversal write was not found. Entry SHA-256 checks detect modified entities/settings; whole-archive hash binds preview. Neither SHA nor the fact a parser eventually throws proves bounded decoder allocation. N04 demonstrates that distinction. ZIP CRC is not checked, N08. Included images are neither magic-validated nor restored; this build warns, and must not advertise image round-trip support.

Coordinator and durability

The single durable admission row resolves competing job starts, but it is not a personal-write maintenance gate. The original fail-open ordinary-add latch is fixed. The remaining receipt replay success and restore/read races below are measured against real core services, not inferred solely from self-reports. Crash probes are controlled faults/reopens, not physical process-kill/native durability tests; the Node test driver uses synchronous=OFF for test speed.

4. Second-pass findings — new/unclosed actionable defects

N01 — P1 — activation/recovery can discard the only valid previous catalog.

Files: packages/core/src/services/catalog-install.ts:311–334,360–375,550–577; apps/mobile/src/platform/pack-install/web-store.ts:108–109.

Three probes:

  active-not-revalidated:
    mutated active schema after candidate validation; install returned installed;
    previousRetained=false.

  recovery-destroys-valid-previous:
    actions=[en:discarded-previous,en:receipt-marked-failed];
    receipt=failed; previousRetained=false.

  web-active-put-window:
    simulated crash after active IDB replacement but before candidate deletion;
    recovery claimed restored-previous, then discarded previous;
    actual active version=2026.11.01.001, receipt version=2026.10.31.001/status=failed;
    previousRetained=false.

The web adapter legitimately leaves active+previous+candidate in that window. undoSwap equates candidate-present with activation-not-completed; when active exists it never restores previous. Recovery then deletes previous before checking active. The eighteen recovery tests use rename-style candidate consumption and miss this storage state.

Fix: reconcile explicit content/phase truth for each adapter; validate activated bytes before receipt/cleanup; validate active before discarding previous at boot and restore validated previous plus its receipt on mismatch. Preserve rollback sources on failed validation. Add the exact web key-write boundary and corrupt-active-with-good-previous cases. Respect mutable refreshed catalogs; do not compare refreshed bytes to baseline SHA as a substitute for a current digest.

N02 — P1 — volatile epoch discards an exact pending batch after ordinary restart.

Files: packages/core/src/db/database-set.ts:36–37,52–57; services/sync.ts:380–391,451–458.

Measured with a catalog installed through CatalogInstallService, not seeded at epoch zero:

  oldEpoch=1; newEpoch=0; refetched=1;
  history market cents=[[999]] instead of the persisted first observation 27;
  warning=BATCH_DISCARDED; status=completed.

Fixed epoch-zero fixtures conceal the failure. The reverse problem is also possible: a different catalog in a new process can reuse the same small epoch value.

Fix: fence persisted batches against a persisted installed content generation/identity initialized at startup. Keep in-process handle counters separate. Test actual install → pending commit/catalog commit → cold reopen → changed upstream, and install replacement between attempts.

N03 — P1 — restore does not refuse personal writes during replacement.

Files: packages/core/src/backup/backup-service.ts:197–227; db/coordinator.ts:38–67; db/sql.ts:191–221.

Injected an ordinary CollectionRepo.update while restore's transaction was after DELETE. It queued successfully, then ran against the newly restored row:

  restored=true; racingEdit.accepted=true;
  finalNotes="stale edit during restore", not the archive value.

No MAINTENANCE was returned. A modal overlay is not core concurrency control, and admission protects only participating jobs.

Fix: acquire a personal-write maintenance/generation guard before safety snapshot/activation, drain preexisting work, reject newly submitted stale mutations including ones waiting in the queue, and allow only the restore's privileged transaction. Recheck state token under that guard. Test concurrent update/add/import/settings at safety-snapshot and activation boundaries.

N04 — P1 — ZIP “streaming cap” is checked after large synchronous inflation allocation.

Files: packages/core/src/backup/archive.ts:122–168, particularly 139–144 and the 1 MiB input slices at 158–160; backup-service.ts:136–140; archive.ts:46–65 for synchronous creation.

Instrumented the real UnzipInflate callback in parseArchive:

  compressed archive=66,467 bytes;
  configured entity cap=1,048,576 bytes;
  largest already-inflated callback=67,108,864 bytes;
  eventual error=SIZE_LIMIT.

The cap eventually rejects data, but not before fflate allocates the entire callback. The default 128 MiB entity cap likewise does not bound a single hostile decoder push to that amount. Parsing/compression is on the caller/UI thread, not a worker. The existing 8 MiB bomb test proves rejection, not bounded allocation or responsiveness.

Fix: use an output-budget-aware inflater or feed compressed input with a proven worst-case expansion bound, stop production at the limit, and move ZIP/JSON work to a cancellable worker with backpressure and retained-byte accounting. Add maximum-allocation/worker responsiveness assertions, not just rejection-code tests. This is a measured JS allocation exposure, not a claimed observed iPhone crash.

N05 — P1 — latched import replay returns success from a receipt that may never have persisted.

Files: packages/core/src/transfer/service.ts:264–268; test/persistence-latch.test.ts:89–98; db/sql.ts:145–149,212–218.

Measured PRE-persisted-state fault:

  storage.reason=persistence_failed; storage.writable=false;
  retry returned replayCreated=1;
  after recovery/reopen owned count=0.

Exactly-once application is not the same as truthful durable success. A caller can now display imported/saved based on lost in-memory receipt data. The test currently endorses this behavior.

Fix: while persistence is uncertain, reject commit/replay with PERSISTENCE_FAILED before returning any mutation success. After storage recovery, retain receipt-first semantics against persisted truth. Update PRE and POST tests to reject before recovery and return/apply exactly once afterwards.

N06 — P2 — failed set discovery/detail can report a completed run with no error.

Files: packages/core/src/services/sync.ts:414–416,400–401,610–615; test/sync-modes.test.ts:150–154.

Measured refresh of a set returning 404:

  status=completed; set.status=failed; cardsFailed=0; lastError=null.

The terminal calculation counts failed cards only; the existing set-404 test does not assert top-level status. A completed run cannot be resumed (sync.ts:276), making the false success more than cosmetic.

Fix: derive terminal failure from failed/pending sets and discovery units as well as card counters, preserve an actionable error, and assert status plus resumability for all-set and mixed-set failures.

N07 — P2 — an existing catalog reader is not protected through activation.

Files: packages/core/src/services/catalog.ts:243–267; db/database-set.ts:174–182; services/portfolio.ts:21–43,88–92.

Paused search after its COUNT, completed a catalog activation, then let its SELECT continue. Result:

  error="The database connection is not open"; code=null.

The barrier protects new catalog() calls, not the full lifetime of a multi-statement operation using an already-returned handle. Only collection list has a consistentRead wrapper; even that wrapper does not retry exceptions from a retired handle.

Fix: pin/drain reader leases for the entire operation or explicitly detect retirement and retry the entire operation once. Apply revision/content guards to catalog/detail/sets/dashboard/copy hydration, with typed STALE_READ/MAINTENANCE instead of raw driver errors. Add the existing-reader ordering, not only reader-arrives-during-barrier tests.

N08 — P2 — .fdx ZIP CRC corruption is accepted.

Files: packages/core/src/backup/archive.ts:72–104,122–168,224–233.

Changed all six local/central CRC fields of a valid three-entry .fdx to 0x12345678 without changing payloads. parseArchive accepted it. Central parsing does not retain/check CRC and fflate's streaming unzip does not provide the missing validation here. Entry SHA still protects entities/settings, so this is not a SHA bypass or traversal exploit; it violates the explicit CRC rejection contract and leaves manifest bytes without an entry self-hash by design.

Fix: compute/verify per-entry CRC32 against consistent local/central metadata, alongside SHA/actual-size checks; reject mismatched local/central headers and add CRC-only corruption tests.

N09 — P2 — checked-in e2e server configuration broke with HTTPS development.

File: apps/mobile/playwright.config.ts:10,25–29.

Unmodified npm run e2e timed out before running tests. Scratch HTTPS override ran all 20 successfully against the untouched parent server.

Fix: make the test origin/protocol configurable, explicitly handle trusted/self-signed dev TLS, and ensure Playwright cannot fall through to an unintended port when :3200 is occupied. Keep the root command reproducibly green without stopping the parent's server. This is a tooling blocker, not evidence of a failing product flow.

No new P0 is asserted. N01–N05 are code/data-safety blockers; N06–N09 are additional P2 corrections, not invented native corruption incidents.

5. Readiness decision and exact remaining work

NOT YET — not ready for owner native (Mac) build + phone test as a data-safe Stage D acceptance candidate.

Code blockers before that candidate:

  1. N01 / R06: preserve/validate rollback sources and handle the web activation write window correctly.
  2. N02 / R07: make exact pending-batch fencing survive restart and real installation generations.
  3. N03 / R08/R10: enforce personal-write maintenance at the core restore boundary.
  4. N04 / R08: actually bound ZIP inflation allocation and move heavy backup processing off the UI thread.
  5. N05 / R02: refuse undurable receipt success until persisted-state recovery.

Also correct N06–N09; the root e2e command remains red even though the identical suite passed with the scratch HTTPS configuration. R11's frozen-response work is still partial. PrivacyInfo target membership is a real native-project edit still needed, not completed merely by creating the file.

Separate native implementation gap:

  R04 is intentionally disabled under D44. A disposable native smoke build may keep that restriction and test install/read/manual/backup behavior; it cannot accept Phase 1 native price refresh/fill-in. Implement and prove the conformed writable-copy/writeback path before claiming that functionality, including the unresolved Android path. I do not classify “flip the flag” as a fix.

Needs Mac/device evidence, not another TypeScript assertion:

  - Xcode/Capacitor sync/build/install; Android build/device separately.
  - Native raw candidate open, same-volume activation, active reopen, rollback and force-kill/space fault boundaries after code fixes.
  - USER backed up and catalog/staging excluded; inspect actual OS backup behavior.
  - Native free-space preflight implementation and mid-write low-space behavior.
  - Full EN/JA pack process peak RSS, decoder/library/window overhead, installed/staging footprint, UI long tasks.
  - Native .fdx document picker, Share/Save-to-Files, safety-backup recovery and airplane-mode cold relaunch.
  - Real CapacitorHttp timeout/cancel/late-result behavior.
  - PrivacyInfo resource membership and final merged archive/required-reason report.
  - SQLCipher/ITSAppUsesNonExemptEncryption owner classification; publisher/support/privacy URL/rights decisions before distribution.
  - PHASE1-ACCEPTANCE 63–65 device search/collection/dashboard/interaction measurements, VoiceOver/Dynamic Type/safe-area/keyboard tests.
  - Trusted HTTPS secure-context behavior on the actual LAN phone. The new dev:https command and successful ignoreHTTPSErrors automation do not establish iOS trust.

A Mac engineering spike with disposable data can start now; that is not the “ready” verdict, nor a recommendation to migrate the owner's real collection. Green desktop unit/build gates do not supersede the reproduced data-safety failures.

Evidence files

Scratch prefix: C:/Users/AshtonSeabolt/AppData/Local/hermes/cache/scratch/

  sol-d-typecheck.log, sol-d-lint.log, sol-d-test.log, sol-d-build.log
  sol-d-e2e.log (unmodified failure), sol-d-e2e-https.log (20 passes)
  sol-d-targeted.log (125 named core cases), sol-d-builder.log
  sol-d-probes.mts / sol-d-probes.log (nine measured probes)
  sol-d-races.mts / sol-d-races.log (three measured races/durability probes)
  sol-d-evidence.mjs (counts, build inventory, production save inspection)
  sol-d-playwright.config.ts (review-only HTTPS override)

These are reproducibility aids, not published releases or permanent test-suite additions. Repository deliverable: C:/Projects/flashydex/.agent/reports/sol-review-2.md. No implementation fixes or commits were made by this reviewer.
