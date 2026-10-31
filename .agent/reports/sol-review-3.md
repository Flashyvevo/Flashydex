FlashyDex — GPT Sol re-verification after Stage E
Verdict: not yet

Scope and provenance

Reviewed BRIEF OWNER UPDATEs, the docs contracts, both prior Sol reviews, the requested Stage D/E contracts and director/Sonnet reports. API.md Director notes — Stage D and Stage E are binding corrections, not implementation evidence. D40's in-place transactional restore and D44's deliberately disabled native catalog writer are recognized. Plain-HTTP LAN read-only mode is the documented development limitation; the parent's UUID/HTTPS work is not reported as an accidental regression.

Reviewed HEAD: 72db7d2be4f8662d97fb0215c1d0f4eda5ea8cd9, unchanged at final code verification. The initial and pre-report git status were clean. No implementation/config/docs edits or commits by this reviewer. Repository deliverable: .agent/reports/sol-review-3.md only. Requested gates generated their normal ignored build/test outputs; additional probes/logs are my scratch files.

Host measured by Node: Windows 10.0.26300, x64, Intel Xeon Platinum 8370C @ 2.80GHz, Node v24.19.0. Pytest used Python 3.12.10. Parent HTTPS listener remained 0.0.0.0:3200 / PID 23636 before and after testing. Playwright used its own :3201 server; no :3201 listener remained afterwards. No physical phone, native bridge, Xcode build, force-kill or App Store approval is claimed.

1. Gates — independently run, with actual output

All five unmodified requested commands exited 0. Output below is excerpted verbatim, omitting repetitive asset listings and individual lint locations. Full logs use the scratch prefix listed at the end.

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

All 21 warnings are react-refresh/only-export-components. Root lint covers mobile, not the complete monorepo.

npm test — exit 0, performance tests NOT skipped

  > npm run test --workspace=@flashydex/core && npm run test --workspace=@flashydex/mobile && bash scripts/test-recognition.sh
  RUN  v5.0.5 C:/Projects/flashydex/packages/core
  Test Files  26 passed (26)
       Tests  328 passed (328)
    Duration  44.49s
  RUN  v5.0.5 C:/Projects/flashydex/apps/mobile
  Test Files  8 passed (8)
       Tests  30 passed (30)
    Duration  9.87s
  platform win32 -- Python 3.12.10, pytest-9.0.2
  collected 1 item
  services\recognition\tests\test_health.py . [100%]
  1 passed, 1 warning in 0.76s

Python's warning is Starlette's deprecated AnyIO BlockingPortal alias.

npm run build — exit 0

  > @flashydex/mobile@0.0.0 build
  > tsc -b && vite build
  vite v7.3.7 building client environment for production...
  2580 modules transformed.
  (!) Some chunks are larger than 500 kB after minification.
  built in 10.33s
  PWA v2.0.0
  mode      generateSW
  precache  60 entries (2190.95 KiB)
  files generated
    dist/sw.js
    dist/workbox-9c191d2f.js

Rollup also printed two Zod annotation warnings. Independent dist inventory: 2,500,344 bytes, assets/sql-wasm.wasm present, no dev-packs or .db/.zst payloads. The shipped jeep save implementation is a single setItem:

  static async saveDBToStore(t,e,r){try{return await r.setItem(t,e),Promise.resolve()}...

npm run e2e — exit 0

  > @flashydex/mobile@0.0.0 e2e
  > playwright test
  Running 22 tests using 2 workers
  [mobile] restore: blocking overlay, concurrent write refused with MAINTENANCE, final data equals the archive
  [desktop] restore: ... [skipped]
  1 skipped
  21 passed (1.5m)

The 21 passes cover both viewports (390x844 and 1280x800): onboarding/add/group/detail/export, .fdx fresh-context restore, second-tab lock/takeover, real IndexedDB quota failure, language-specific install failure, routes and startup; the mobile-only pack harness covers EN/JA install, reinstall, bad hash/size and cancellation. The restore-maintenance browser test runs once on mobile by explicit test.skip, not as a hidden failure. Self-signed phone TLS trust is not established by these localhost tests.

Additional executions, all exit 0:

  npm test --workspace=@flashydex/core -- --reporter=verbose
    328/328, 26 files (second complete run)
  npm test --workspace=@flashydex/mobile -- --reporter=verbose
    30/30, 8 files
  npm test --workspace=@flashydex/catalog-builder -- --reporter=verbose
    27/27, 3 files
  npm run typecheck --workspace=@flashydex/catalog-builder
    tsc --noEmit

Per-file counts parsed programmatically from that verbose output, not copied from reports:

  install-activation.test.ts       17
  install-recovery.test.ts         18
  install-settings.test.ts         13
  sync-stage-e.test.ts              6
  sync-modes.test.ts               20
  sync.test.ts                     10
  maintenance-gate.test.ts         14
  reader-protection.test.ts         8
  backup-hardening.test.ts          8
  backup.test.ts                   34
  persistence-latch.test.ts         7
  coordinator.test.ts               7
  candidate-validation.test.ts     10
  manifest-validation.test.ts      10
  perf.test.ts                      6

All listed cases passed. Successful suite execution does not invalidate the additional reproduced failures below.

2. N01–N09 re-verification

N01 — fixed for the reported activation/recovery defects under the adopted cheap-check contract.

Read packages/core/src/services/catalog-install.ts:301–340,366–408,585–625 and candidate-validation.ts:83–87. Activated schema/meta are checked BEFORE receipt commit and previous cleanup. undoSwap distinguishes old active content from the target, including web active+previous+candidate coexistence. Boot validates active before discarding previous and restores a validated previous with its own receipt. rollback validates its source first.

Read and ran install-activation.test.ts, 17/17, including “active-not-revalidated,” “recovery-destroys-valid-previous,” “corrupt-active-with-good-previous,” “web-active-put-window,” torn active put, first-install put, both-invalid preservation and damaged rollback refusal. install-recovery.test.ts, 18/18, still passes the rename/receipt PRE/POST faults. These are real SQLite files with rename/web-style FAKE ports; they do not prove actual iOS rename/kill behavior. I did not reintroduce a full baseline-hash comparison of mutable refreshed catalogs. The explicit Stage E cheap schema/meta check is not a full post-activation rehash/integrity scan.

N02 — fixed for volatile-epoch loss of exact pending batches.

Read sync.ts:170–179,400–418,481–523,532–539. Replay now compares the persisted generation|status|version|sha256 identity; matching batches adopt the new process's handle epoch, and fenced USER commits recheck persisted identity inside the transaction.

Read and ran sync-stage-e.test.ts, 6/6. Its three N02 tests perform a real CatalogInstallService install, interrupt after CATALOG commit, cold-reopen, change upstream, and assert FIRST observation 27 with zero refetches; replacement at the same small process epoch and uninstall/reinstall of the same version/hash correctly discard. Note: the first test's title says “between the pending commit and the catalog commit,” but its scenario hook is faultAfterCatalogCommit at lines 46–49. The actual tested boundary is after CATALOG commit/before USER completion. sync-modes.test.ts 20/20 separately includes pre-catalog pending replay and changed-upstream prices_only/refresh replay.

N03 — fixed for the reproduced ordinary-write/restore race.

Read db/sql.ts:139–152,202–207,253–281 and backup/backup-service.ts:198–249. Restore closes the gate before token recheck/safety snapshot, drains in-flight work, uses a privileged transaction, and exits in finally. Ordinary transactions check the gate both at submission and after queue admission.

Read and ran maintenance-gate.test.ts, 14/14: update/add/bulkAdd/settings/import raced at five stages, Sol's after-DELETE update probe, already-queued refusal, rollback/stale-token cleanup, status/subscription and informational catalog activation. Read e2e/restore-maintenance.spec.ts:44–74; its mobile case passed, proving inert root + alertdialog, MAINTENANCE on a second write path, no racing location, and exact owned-copy equality. Desktop is explicitly skipped. API.md:540 explicitly limits multi-step request refusal to the transaction step; I do not misreport a transaction requested after gate reopening as a forbidden during-gate write.

N04 — partly fixed: bomb output chunking is fixed; worker/streaming workload requirement is not.

Read backup/archive.ts:161–223 and backup-service.ts:94–117,132–142. Input slices shrink with remaining output budget and are capped at 1 KiB. Ran backup-hardening.test.ts, 8/8, including the 64 MiB / ~66 KB bomb with 1 MiB cap and largest callback <1.25 MiB, default-cap chunking, 64 KiB-cap shrink and aggregate cap. The original huge single-callback allocation is no longer reproduced by those tests.

However buildArchive still JSON.stringify/encodes whole entities and calls zipSync (archive.ts:46–65); parseArchive retains full entry bytes then JSON-parses them (198–201,268–305). Platform picker/read and BackupService still materialize full files. This is capped, not bounded-memory streaming of the entire backup, and still runs on the calling/UI thread. No cancellable ZIP/JSON worker exists. The director correctly discloses this residue; it is not a Mac-only verification item.

N05 — partly fixed, still a P1 durability blocker (new ordering reproduced as E01 below).

Read transfer/service.ts:259–279 and db/sql.ts:196–199,274–281. An already-set latch now rejects before receipt lookup. Read and ran persistence-latch.test.ts, 7/7; sequential PRE/POST retries correctly reject while latched and apply/return exactly once after recovery. But the single pre-await check races an in-flight failing flush: a concurrent replay can pass the check, wait in the DB queue, then return the undurable receipt AFTER the latch is set. My PRE-state probe returns success for one created copy and subsequently reopens to zero. This is not closed by the seven sequential cases.

N06 — fixed for failed-set false completion.

Read sync.ts:426–437 and 645–652. Failed/pending/running sets contribute to terminal failure and PARTIAL_FAILURE. Ran the three N06 cases in sync-stage-e.test.ts (within 6/6): all-set 404 plus successful resume, mixed success/failure plus resume, and incremental detail 404. sync.test.ts 10/10 still covers card failures/retries/cancel/recovery. A failed discovery request throws and ends failed through run's catch, rather than completed.

N07 — fixed for catalog-handle retirement; broader personal-revision consistency remains partial (E04).

Read db/database-set.ts:137–178, services/catalog.ts:144,199,235,250,305, portfolio.ts:15–18 and owned-read.ts:40. Retirement detection now retries the whole public operation once even when the retired handle throws. Collection list retains consistentRead. Read and ran reader-protection.test.ts, 8/8, including pause-after-COUNT search, pre-first-statement retirement, detail, set cards/list/detail, dashboard and copy/list hydration. query-retry.test.ts 4/4 confirms one transient UI retry and generic raw-error handling. The exact old raw “connection is not open” finding is closed in these exercised orderings. protectedRead does not track USER revision; E04 is a distinct remaining mixed-snapshot issue, not proof the old retired-handle error still occurs.

N08 — fixed for CRC corruption; general ZIP header consistency is not complete (E03).

Read archive.ts:69–85,143–159,270–271. Ran the four CRC cases within backup-hardening.test.ts 8/8: standard CRC vector, all-six-field 0x12345678 corruption, local-only CRC mismatch and central-only CRC mismatch. Payload CRC is now checked alongside entry SHA. Local encryption/flag mismatch remains accepted in my additional probe; this is not a CRC/SHA bypass.

N09 — fixed.

Read apps/mobile/playwright.config.ts:3–12,37–45. Root npm run e2e now starts strict :3201 with reuseExistingServer:false, strips the dev HTTPS switch and supports an explicit external origin. Unmodified root command passed 21 with 1 deliberate skip, while parent PID 23636 on :3200 remained untouched. No scratch configuration override was needed.

3. R01–R13 disposition, including every previously partial item

R01 — fixed for the original multi-tab overwrite. Bootstrap acquires Web Locks before opening USER storage (mobile data/bootstrap.ts:38–53); instance-lock e2e passes twice, at both viewports, with denial/reload/close/takeover and retained copies. Process-kill/BFCache permutations are not certified.

R02 — partly. Ordinary writes fail closed (db/sql.ts:253–281); production jeep save is one atomic IDB setItem; persistence-failed e2e passes 2/2 on real IDB put failure. Sequential PRE/POST recovery passes 7/7 latch tests. E01 still permits undurable import replay success. Web deliberately requires real page reload when recover cannot reopen without saving (app-database.ts:14–18), which is an allowed honest fallback.

R03 — fixed by parent. Read uuid.ts:2–10 and bootstrap.ts:8–10/app-platform.ts:67,74,89. Shared helper uses randomUUID or getRandomValues with v4/variant bits, no Math.random. uuid.test.ts 1/1 and both core-flow browser cases pass. Actual phone trust in self-signed HTTPS remains untested, not a UUID code failure.

R04 — partly / deliberately disabled, NOT implemented. native-store.ts:22–36 documents the design; :196–198 still throws UNSUPPORTED_CAPABILITY. app-database.ts:40–65 refuses native writes honestly. sync-modes capability test passes within 20/20. D44 allows this restriction for an engineering build; it does not supply native prices_only/refresh/incremental. Implement the conformed writable-copy/writeback path, including Android, and prove it on device before enabling it. This is implementation plus device work, not merely a missing Mac test or Boolean flip.

R05 — fixed for unbounded decoder-side pending queue. Read bounded-decoder.ts:46–67,81–111. Mobile bounded-decoder.test.ts 6/6 passes high-ratio bounds, hard-cap abort, expected-size rejection, cancel and invalid input. Pack browser cases pass. This fail-fast bound can reject high-ratio otherwise valid streams; it is not measured native process RSS or proof full EN/JA pack memory acceptance.

R06 — fixed for the reported core recovery defects under current Director notes; native proof outstanding separately. N01's 17 activation and 18 recovery cases pass; install-settings 13/13 includes rollback/uninstall/hash failure. Core now checks before cleanup and preserves valid rollback sources. Do not promote fake-port recovery tests into native crash-durability evidence.

R07 — partly overall; core modes/exact restart replay fixed for the reported defects. sync-modes 20/20, sync 10/10 and sync-stage-e 6/6 pass refresh/fill-in, empty-shell recheck, frozen discovery, exact observation replay and failed-set resumability. Read sync.ts:12–34 and API.md:531,545; adopted incremental changed-header semantics are honored. Native remains disabled by R04. The original broader retry/adaptive-discovery contract is also not fully implemented: sync.ts:719 uses fixed concurrency; :737–765 has no 429 concurrency reduction or conditional ETag discovery. No all-device/all-contract completion claim.

R08 — partly. .fdx is real, not a stub: backup.test.ts 34/34 passes exact rich personal/settings/history round-trips with same/absent/newer catalogs, safety reversal, rollback, stale/expired guards and hostile archives. Browser fresh-context restore passes 2/2. N03 gate is fixed, but N04 worker/whole-buffer residue and E02/E03 validation gaps remain. Optional user-image bytes are warned unsupported, not restored; no image round-trip credit. D40 transactional activation is accepted, so missing user-DB file rename is NOT an additional defect.

R09 — partly against the complete original contract. Manifest-validation 10/10 and candidate-validation 10/10 pass trusted-origin/redirect, signature refusal, immutable version/downgrade/date/count rules, exact normalized SQL/object allowlist, FK/integrity failure and counts. N01 fixes activated-file checking. Read candidate-validation.ts:24–87: actual object SQL protects schema, but catalog_meta.schema_fingerprint value and schema_migrations receipt values are still not compared to bundled migration receipts. Cheap active checks are explicitly adopted and must not be described as full integrity/hash checks. Unsigned manifests are intentional Phase 1 behavior, not publisher authentication.

R10 — partly overall. Read coordinator.ts:38–78 and database-set.ts:65–102,137–205. Coordinator 7/7 and the seven R10 cases inside sync-modes 20/20 pass competing start orders, exclusion, barriers and generation fencing. N03 restore exclusion and N07 retired-reader retries now pass. E04 demonstrates a remaining USER-revision mixed-read gap outside collection list. No native corruption incident is asserted.

R11 — partly, despite real improvements. Read builder run-guard.ts:19–35,49–85, cli.ts:118–155 and http.ts:154–172; builder tests 27/27, run-guard subset 13/13 and typecheck pass. HEAD+dirty identity and same-run cache ownership replace the prior package-version/24h-cross-run reuse; immutable artifacts and verification failures are gated. However the response store is still language/path-wide, not an immutable run-specific response set: run-guard.test.ts:123–130 explicitly asserts A -> B -> A refetches because B overwrote A. Dirty identity also hashes git diff/status, not contents of untracked source files. These limit the fully frozen-run claim. No new crawl, release workflow or external publish/read-back was executed by me.

R12 — partly. Read perf.test.ts:11–15,41–52,75–107 and collection-list's batched lookup. Six perf cases pass with actual 40,000 catalog rows, 10,000 copies, ten warmups/100 samples and one whole-group lookup per page. Measured second-run Node p50/p95/max ms:

  char prefix              37.8 / 55.7 / 83.7
  pikachu prefix           12.8 / 26.8 / 46.3
  char contains            56.2 / 70.6 / 85.3
  collector 19             21.1 / 36.7 / 205.0
  charizard + localId20     6.5 / 10.6 / 35.0
  collection created       28.9 / 58.4 / 88.7
  collection name          28.7 / 34.8 / 38.8
  collection count         34.5 / 44.2 / 100.4
  collection q=char        11.4 / 14.9 / 19.5

These do not establish native bridge/phone budgets, dashboard p95 or UI long tasks. The “giant” fixture remains forty groups of 100, not one 10,000-copy group. PERF-PROCEDURE.md is instructions, not measured phone evidence.

R13 — partly. Picker checks File.size before reading (app-platform.ts:49–54); native metadata uses CapacitorHttp (:153–156); native-http.test.ts 6/6 passes mocked mapping/timeout/abort/late results. Optional Platform.imageCache remains an allowed interface-only seam. PrivacyInfo now really has file reference/group/build resource membership (project.pbxproj:11,23,85,169), closing the prior source-project omission; Xcode/archive audit is still unrun. native-store.ts:120–122 still returns null for free space: native preflight is missing code, not completed by web navigator.storage.estimate. SQLCipher/export classification and actual backup exclusion remain owner/device work.

4. Regression and data-safety sweep

Catalog reinstall invariant — positive evidence

Read and ran install-settings.test.ts:47–57, “reinstalling a newer version keeps owned_cards count and every personal row (37).” It passes, but blanks price_snapshots in the comparison, and dumpPersonal (helpers.ts:63–67) omits settings/annotations.

Therefore I also ran my own richer probe through real CatalogInstallService + temporary SQLite files and a fake download/file port: three catalog copies with grade, condition, shared acquisition, zero cost, manual EUR override, location/group/notes, plus one JA custom copy and a populated annotation. Compared canonical owned/grade/acquisition/location/group/membership/custom/ledger/history/annotation/session/settings/app_state tables before/after a genuinely newer activation, with no history exclusion:

  rich-reinstall-invariant:
    personalEqual=true
    owned=4
    beforeSha=6fa587ee2b3e3be07c374bc13d40d92872731fb5888ccceace7ab1ea81d76fe9
    afterSha= 6fa587ee2b3e3be07c374bc13d40d92872731fb5888ccceace7ab1ea81d76fe9

This supports “reinstalling a catalog never changes owned rows” in the exercised path. Not every optional table was populated. It is not a native force-kill/full-web-worker rich-data run. Refresh invariant tests likewise keep ownership/revision while permitting observational history additions.

.fdx security

Read parser plus hostile tests, not just the director's claim. Traversal/absolute/drive/backslash/NUL/duplicate/unknown/symlink tests pass without application DB writes; paths are allowlisted identifiers, not filesystem extraction destinations. Compressed/expanded/entry/row caps and actual-output bomb rejection pass. Entry SHA checks, whole-archive preview hash and new CRC tests pass. This does not make a user archive authenticated, prove full bounded retained-memory behavior, or validate all domain semantics. E02/E03 remain below. SQL is app-bundled, not executed from archive content.

Coordinator/persistence

New restore maintenance and retired-reader tests close their specific previous races. Ordinary user transactions recheck blocking state after queue admission. The import receipt success path does not, which my E01 reproduces. Browser quota failure tests remain valuable but do not test concurrent receipt replay. Node fault/reopen tests use synchronous=OFF in the test driver; no power-loss durability claim.

5. New / residual actionable findings

E01 — P1 — concurrent import replay can still return undurable success (N05 / R02 remains partial).

Files: packages/core/src/transfer/service.ts:264–272; packages/core/src/db/sql.ts:274–281.

Measured ordering on real core/SQLite with a controlled PRE-persisted-state adapter:
  1. Import A commits SQL, then pauses inside afterCommit before its quota failure.
  2. Replay B starts; persistenceBlock() is still clear, so B queues the receipt SELECT.
  3. A's flush fails and sets the latch; B's queued SELECT then reads the live undurable receipt.

Output:
  first.code=PERSISTENCE_FAILED
  replay.ok=true; replay.createdCopies=1
  storage.writable=false; storage.reason=persistence_failed
  afterRecoverOwned=0

Fix: perform the persistence check and receipt/result read in one serialized USER read session, checking the latch after queue admission and before returning success; cover in-memory preview-result returns too. Add both PRE and POST concurrent replay-during-flush cases. Keep receipt-first semantics after recovery, not before established durability. This is a reproduced core race, not a claim the UI automatically double-submits.

E02 — P2 — .fdx preview/restore accepts domain-invalid personal state with correct hashes.

Files: packages/schemas/src/backup.ts:21–24,32–66; packages/core/src/backup/archive.ts:346–398; backup-service.ts:265–295.

Four independently rebuilt, correctly hashed synthetic archives each passed preview and returned restored:true:
  - owned.language='ja' references an EN CustomCard;
  - settings.languages=['en'] with duplicate JA followed-set keys;
  - annotation overrides contain unknown nested fields and name:42;
  - owned.updatedAt in 2025 precedes createdAt in 2026.

The custom-language mismatch and invalid settings were read back from the restored DB; reversed audit times were read back exactly. Current validation checks referenced ID existence, but not these cross-row/refinement rules. displayOverrides is z.record(unknown), not the strict allowed overlay shape. SQL FKs do not enforce these service-level semantics.

Fix: reuse the normative settings/annotation/audit refinements and check custom/copy language equality, followed-set uniqueness/selected languages and time ordering during zero-write preview. Add these cases to hostile-archive tests and assert preview rejection plus unchanged target, not merely restore rollback. This is invalid-data acceptance after explicit restore, not arbitrary code execution or a SHA bypass.

E03 — P2 — inconsistent local ZIP flags, including local-only encryption, are accepted.

Files: packages/core/src/backup/archive.ts:103–118,143–157.

Probe: set bit 0 (encrypted) on the first LOCAL header of an otherwise valid .fdx, leaving central flags/payloads unchanged. parseArchive accepted it. Encryption is checked only centrally; verifyLocalHeaders reads localFlags but uses it only to decide whether to skip CRC/size comparisons. CRC-only tests pass but do not cover this metadata contradiction.

Fix: require coherent supported local/central flags, reject encryption in either header, and validate descriptor/header consistency. Add local-only and central-only flag corruption tests. Actual ciphertext decryption or payload-integrity compromise was not demonstrated; this violates the explicit malformed/encrypted-archive rejection contract.

E04 — P2 — dashboard can mix pre-edit totals with post-edit personal rows.

Files: packages/core/src/services/portfolio.ts:18,27–49,94–98; db/database-set.ts:165–178.

Probe: delete the sole owned copy after dashboard's aggregate read releases its USER lock, before recent hydration; no catalog generation changes. Result:
  actualOwned=0
  dashboard.totalCopies=1
  dashboard.recent.length=0

No single personal snapshot has that answer. protectedRead only checks catalog handle generations; it does not catch the USER revision movement. Collection list's consistentRead already has the stronger revision guard.

Fix: run dashboard and other multi-domain personal-dependent reads under revision+catalog-generation consistentRead (or equivalent snapshot/lease), retry once and then return typed STALE_READ. Add update/add/delete/restore-between-aggregate-and-hydration tests. This is a stale/inconsistent read, not persisted ownership loss.

No new P0 is asserted. E01 is the remaining reproduced P1 blocker. N04's unfinished worker work, R04's disabled native writer and R13's missing native preflight remain disclosed implementation gaps rather than fabricated device failures.

6. Readiness decision

NOT YET — not ready for owner native (Mac) build + phone test as a data-safe Phase 1 acceptance candidate.

Exact code work still open:
  1. E01 / N05 / R02: serialize the latch check with receipt replay so no undurable mutation success can escape.
  2. E02 / R08: reject the demonstrated invalid .fdx domain state in preview.
  3. E03 / R08: reject contradictory/encrypted local ZIP headers.
  4. E04 / R10: protect dashboard personal revision consistency, not catalog generations alone.
  5. N04 / R08: move ZIP/JSON processing off the UI thread with cancellation/backpressure and retained-memory/resource tests; small decoder chunks are not the completed worker requirement.

Additional full-Phase-1 implementation residue (do not relabel as merely “needs device verification”):
  - R04: native writable copy/writeback implementation is absent, Android path unresolved. D44 permits an explicitly restricted exploratory build, not acceptance of native price refresh/fill-in.
  - R13: native free-space preflight still returns null and needs implementation.
  - R09: compare migration receipt/meta fingerprint values if claiming the complete original validator contract.
  - R07: reconcile remaining adaptive retry/ETag requirements or document a binding scope amendment; current core uses fixed concurrency.
  - R11: fully frozen run-specific response storage/code-content binding remains partial, although new-run reuse and immutable artifact guards improved.

Needs Mac/device execution after those corrections, not another source-only “pass”:
  - Capacitor/Xcode sync, build, install and archive; Android build/device separately.
  - Native existing-file open, validation/handle close, same-volume activation/rollback, force-kill boundaries and low-space failures.
  - Actual USER backup inclusion and catalog/staging exclusion.
  - Native document picker/.fdx/Share/Save-to-Files, verified safety recovery and airplane-mode cold launch.
  - Native HTTP timeout/cancel/late-result behavior.
  - Full EN/JA process peak RSS, staging/installed footprint, UI long tasks and the acceptance 63–65 search/collection/dashboard/interaction measurements; include a true giant group.
  - PrivacyInfo target build and merged privacy report; SQLCipher/export-compliance owner classification.
  - VoiceOver, Dynamic Type, safe areas/keyboard/landscape and actual LAN-phone HTTPS trust.

Owner/release decisions remain separate: real production manifest/release availability and configuration, publisher/support/privacy URL, download-host disclosure, rights/branding and encryption classification. No release was published or verified remotely in this review.

A disposable-data Mac engineering spike can proceed with D44 restrictions. That is not the requested ready verdict and is not a recommendation to migrate the owner's real collection. The desktop gates are green; the reproduced durability race still matters.

Evidence and deliverable

Scratch prefix: C:/Users/AshtonSeabolt/AppData/Local/hermes/cache/scratch/
  sol-e3-typecheck.log, sol-e3-lint.log, sol-e3-test.log, sol-e3-build.log, sol-e3-e2e.log
  sol-e3-core-verbose.log, sol-e3-mobile-verbose.log
  sol-e3-builder.log, sol-e3-builder-typecheck.log
  sol-e-probes.mts / sol-e3-probes.log (E01, rich reinstall, E03, E04)
  sol-e3-semantics.mts / sol-e3-semantics.log (four E02 acceptance probes)
  sol-e3-evidence.mjs (counts/build inventory/host)

Repository report: C:/Projects/flashydex/.agent/reports/sol-review-3.md. No commits, implementation fixes, owner-server restart or modification of another agent's files.
