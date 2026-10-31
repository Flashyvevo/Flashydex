FlashyDex — independent Phase 1 architecture and code review
GPT Sol | 2026-10-31 | Verdict: NOT YET

Scope and provenance

Reviewed BRIEF.md and its binding OWNER UPDATEs, SPEC.md, all 13 docs/*.md files, both Opus director reports and .agent/DIRECTOR-DECISIONS.md, then the core, mobile adapters/hooks/routes, catalog builder and release workflow. This is an independent review, not acceptance of child self-reports.

Base commit: 5c4a1eb0c8e806aa6e55690296fb09986afb5c92. Remote: https://github.com/Flashyvevo/Flashydex.git. Windows x64; Node v24.19.0. Other agents changed tooling/workflow/README files during this review. At final verification HEAD had advanced externally to acb4d4089415b2bd8d0886fc8abca35fe5deb638; that external tooling commit also included my appended ADR text. I did not run any commit/push command. The reviewed core/mobile implementation was unchanged by that commit; I opened its new verification utility and independently checked its local full-pack artifacts (E8). Re-review subsequent fixes.

My only repository edits: this report and appended ADR-040–048 in docs/DECISIONS.md. No implementation fixes, commits or pushes. Diagnostic scripts/logs live outside the repository in C:/Users/AshtonSeabolt/AppData/Local/hermes/cache/scratch/. Browser probes used isolated disposable profiles and test-only data. Existing port 3200 returned HTTP 200; I neither started nor stopped a server.

1. Gates — independently executed

Command                         Exit   Result
npm run typecheck               0      core, schemas, mobile TypeScript pass
npm run lint                    0      0 errors, 21 react-refresh warnings
npm test                        0      core 169/169; mobile 9/9; pytest 1/1
npm run build                   0      Vite production build and PWA generation pass
npm run e2e                     0      12/12, mobile 390x844 and desktop 1280x800

Additional independent checks: catalog-builder tests 14/14; catalog-builder typecheck passes. Root typecheck/test/lint do not include that builder workspace; root lint covers mobile only. Python health ran with Python 3.12.10. Pytest emits one Starlette/AnyIO deprecation warning.

Pasted decisive output (excerpts; repetitive asset listings and warning locations omitted):

  > flashydex@0.0.0 typecheck
  > npm run typecheck --workspace=@flashydex/core && npm run typecheck --workspace=@flashydex/schemas && npm run typecheck --workspace=@flashydex/mobile
  > tsc --noEmit -p tsconfig.json
  > tsc --noEmit -p tsconfig.json
  > tsc --noEmit -p tsconfig.app.json && tsc --noEmit -p tsconfig.node.json
  TYPECHECK_EXIT=0

  > flashydex@0.0.0 lint
  > npm run lint --workspace=@flashydex/mobile
  > eslint .
  21 problems (0 errors, 21 warnings)
  LINT_EXIT=0

  RUN v5.0.5 C:/Projects/flashydex/packages/core
  Test Files 14 passed (14)
  Tests 169 passed (169)
  RUN v5.0.5 C:/Projects/flashydex/apps/mobile
  Test Files 3 passed (3)
  Tests 9 passed (9)
  services\recognition\tests\test_health.py . [100%]
  1 passed, 1 warning in 0.61s
  TEST_EXIT=0

  vite v7.3.7 building client environment for production...
  2561 modules transformed.
  Some chunks are larger than 500 kB after minification.
  built in 11.31s
  PWA v2.0.0
  mode generateSW
  precache 59 entries (2094.28 KiB)
  files generated: dist/sw.js, dist/workbox-9c191d2f.js
  BUILD_EXIT=0

  Running 12 tests using 2 workers
  mobile: EN install, JA install, reinstall, hash mismatch, size mismatch,
          cancel, startup smoke, routes, onboarding/add/group/detail/export
  desktop: startup smoke, routes, onboarding/add/group/detail/export
  12 passed (46.0s)
  E2E_EXIT=0

  @flashydex/catalog-builder test: Test Files 2 passed (2), Tests 14 passed (14)
  @flashydex/catalog-builder typecheck: tsc --noEmit

Unabridged root gate stdout/stderr is retained at:
  C:/Users/AshtonSeabolt/AppData/Local/hermes/cache/scratch/sol-typecheck.log
  C:/Users/AshtonSeabolt/AppData/Local/hermes/cache/scratch/sol-lint.log
  C:/Users/AshtonSeabolt/AppData/Local/hermes/cache/scratch/sol-test.log
  C:/Users/AshtonSeabolt/AppData/Local/hermes/cache/scratch/sol-build.log
  C:/Users/AshtonSeabolt/AppData/Local/hermes/cache/scratch/sol-e2e.log
Scratch logs are not permanent project artifacts; the results needed for this review are pasted here.

2. Targeted evidence beyond the gates

E1 — actual catalog replacement preserves personal rows in the exercised path.
Script: scratch/sol-flashydex-probes.mjs. Chromium at 390x844; actual EN worker download/decode/activation, not just a mocked install port. Created three catalog copies with grade, condition, shared acquisition, per-copy cost, manual EUR override, location, group and notes, plus a Japanese custom copy. Dumped owned_cards, grades, acquisitions, storage_locations, collection_groups, collection_group_members, custom_cards, catalog_identities, price_snapshots, catalog_annotations, scan_sessions, app_settings and app_state in deterministic row order. Invalidated readers and forced the lower-level installer to replace the identical baseline so the service's same-version no-op could not mask the test.

  probe: actual-web-worker-reinstall-with-rich-owned-data
  ownedCount: 4
  personalEqual: true
  beforeSha256: bd43295b65e1228170bbf3e8eea81defea08c53f9fd27ece3361d59a83e1c93e
  afterSha256:  bd43295b65e1228170bbf3e8eea81defea08c53f9fd27ece3361d59a83e1c93e
  snapshotName: Furret
  catalogAvailable: true

The service-level newer-version test also passed: packages/core/test/install-settings.test.ts:94–104 keeps three owned rows and the first pack's snapshot name after the fake port swaps a newer catalog. That existing assertion deliberately excludes price_snapshots; E1 compared them too. E1 does not prove native crash safety, every version transition or all sync modes. Empty history/annotation/session tables were included but not populated. Evidence: sol-invariant.log.

E2 — real two-tab personal-data loss.
Script: scratch/sol-flashydex-multitab.mjs. Opened two pages in the same fresh browser context, bootstrapped both before either wrote, added a distinct owned custom copy in A and then in B, reloaded A. Both writes reported success, but the reopened database contained only B's copy: tabACopyLost=true. This is not a simulated database mock. Evidence: sol-multitab.log.

E3 — failed web durability acknowledgement leaves writes enabled.
Script: scratch/sol-flashydex-flush.mts. Real temporary SQLite/core services with an injected afterCommit flush fault:
  errorCode: PERSISTENCE_FAILED
  afterFailedSave: 2
  writesBlocked: false
  afterRetry: 4
This proves the recovery/fail-closed boundary is absent; it is not a physical browser quota experiment. Evidence: sol-flush.log.

E4 — LAN HTTP mutation failure.
Script: scratch/sol-flashydex-lan.mjs. Chromium loaded the actual LAN origin http://10.0.0.4:3200:
  isSecureContext: false
  randomUUID: undefined
  create.error: globalThis.crypto.randomUUID is not a function
  create.code: null
The identical custom-card call succeeds on http://127.0.0.1:3200, which browsers treat as secure. Thus localhost Playwright does not validate the director's phone-LAN instructions. This is desktop Chromium at the LAN origin, not a claim of a physical-phone test. Evidence: sol-lan.log.

E5 — decompression buffers are not bounded by the relay limit.
Script: scratch/sol-flashydex-static-probes.mjs. Fed one real fzstd Decompress.push the 2,067-byte zstd encoding of 64 MiB of repeated data, using the worker's callback/copy strategy:
  decodedBytes: 67108864
  pendingChunks: 512
  pendingBytes: 67108864
  allowedInFlightBytes: 1048576
The four-message relay limit does not count decoder-side pending[]. This is a decoder test, not an assertion that the synthetic payload is a valid catalog or a measured iPhone RSS peak. Evidence: sol-static.log.

E6 — recovery does not restore the retained old catalog.
Script: scratch/sol-flashydex-core.mts. Real temporary USER database and CatalogInstallService; injected port state models a crash after old->previous but before candidate->active:
  restorePreviousCalls: 0
  previousStillExists: true
  installedAfter.status: absent
  installedAfter.version: null
The native rename sequence creates precisely this possible state. This is service-level fault injection, not a native force-kill. The same script shows a calendar-invalid version/revision000, contradictory unpublished count and unknown syntactically valid signature are accepted by the manifest schema. Evidence: sol-recovery.log.

E7 — production artifact inventory, independently checked after build:
  devPacks: []
  wasm: [assets/sql-wasm.wasm]
  swHasSqlWasm: true
  swHasDevPacks: false
  bundleTotalBytes: 2401300
/dev/pack-test compiles to a small Not found component in production (route source:146–148); its route name remaining in the generated tree is not an exposed install harness. This inventory proves dev-pack exclusion and WASM presence, not an airplane-mode cold-start test. Evidence: sol-static.log.

E8 — independently verified the concurrently produced full local EN/JA artifacts.
Script: scratch/sol-flashydex-full-packs.mjs; read-only source artifacts under .agent/metrics/packs/. Stream-decompressed each pack into a counting SHA-256 sink, checked compressed/raw lengths against its manifest, then opened the existing raw DB read-only for integrity, FK and row-count checks:
  EN: compressed 12343679; raw 138002432; sets220/cards23736/variants36693/prices48805/unpublished4.
  EN SHA-256: bbca47b37ae46b73684ea784abb8c96ac9bba98b5317512cb6841285ec081606
  JA: compressed 3115850; raw 45592576; sets184/cards12781/variants15781/prices10127/unpublished68.
  JA SHA-256: ed7fb6eafa6d0b38c086555081c48db9df0583828cd9ca710cc9952591ec6047
  Both: sha/rawBytes/compressedBytes/counts/integrity/foreignKeys checks all true; exit 0.
This verifies local bytes, not Terra's crawl timings/live-sample claims, a remote published release or native installation. I did not re-run a full provider crawl. Evidence: sol-full-packs.log.

All seven retained probe executions exited 0; E2–E6 intentionally report defects. A successful diagnostic process does not mean its tested invariant passed.

3. Findings, ranked

R01 — P0 — second writable browser tab silently deletes saved ownership.
Files: apps/mobile/src/platform/sqlite.ts:33–62,76–80; apps/mobile/src/data/bootstrap.ts:20–31.
Why: connection/singleton locks exist only within one page. Independent sql.js snapshots overwrite the same IndexedDB key. E2 lost a successfully saved physical-copy row. Calling web limited/development mode does not make silent personal-data loss acceptable.
Fix: acquire an origin-wide exclusive USER-writer lock before opening storage, hold it for the page lifetime, deny a second writable instance with INSTANCE_LOCK, and test tab close/crash/takeover and reload. A message-only advisory lock is insufficient; use a proven lock/generation protocol. Do not use irreplaceable personal data in the current web build.

R02 — P1 — persistence failure reports an error but permits unsafe retry.
Files: packages/core/src/db/sql.ts:152–157; apps/mobile/src/data/collection-hooks.ts:38–50; apps/mobile/src/lib/errors.ts:39–40.
Why: COMMIT has already occurred before afterCommit fails. The code throws PersistenceError but neither blocks writes nor reopens persisted state. The UI claims FlashyDex reloaded data although no such recovery occurs. E3's manual retry doubles ownership from two to four; retry:false prevents automatic retries only.
Fix: latch a fail-closed persistence/maintenance state, retire in-memory handles, recover/reopen and refetch before reenabling mutations. Reconcile import receipts; do not replay ordinary bulk adds without an idempotency/recovery decision. Inject real IndexedDB quota/save faults as well as adapter failures.

R03 — P1 — documented LAN-phone workflow cannot generate UUIDs.
Files: apps/mobile/src/data/bootstrap.ts:5–8; apps/mobile/src/platform/app-platform.ts:63,71,86.
Why: crypto.randomUUID is secure-context-only. E4 reproduces failure on LAN HTTP while localhost tests pass. Install job IDs, custom/owned creation and transfer operations use these sources. Director D11 explicitly excludes mkcert/HTTPS from this phase.
Fix: use one tested cryptographically secure UUIDv4 helper backed by getRandomValues where randomUUID is unavailable; never Math.random. Test the LAN-origin manual/install/export path and then the physical phone.

R04 — P1 — native price refresh opens a read-only connection as its writer.
Files: apps/mobile/src/platform/pack-install/native-store.ts:73–87,164–166; apps/mobile/src/platform/app-database.ts:33–42; node_modules/@capacitor-community/sqlite/dist/esm/definitions.js:200–206,587–600,636–667.
Why: openWritableNative calls openReadOnlyNc. The pinned plugin constructs SQLiteDBConnection(..., true, ...) for createNCConnection and explicitly rejects execute/run in readonly mode. This contradicts the source comment claiming NC is read-write. DatabaseSet.canWriteCatalog nevertheless returns true because a function exists. Native price refresh cannot pass writable initialization/DML through this handle.
Fix: implement a proven conformed writable active-file arrangement/native path adapter while preserving backup exclusion and existence checks; keep NC for candidate/read validation. Until proven, advertise pricesOnly:false on native. Verify actual bridge transactions and reopen on iOS/Android. This defect is source-proven; native execution was unavailable here.

R05 — P1 — worker backpressure does not bound decoded memory.
File: apps/mobile/src/platform/pack-install/pack-install.worker.ts:89–103,128–143.
Why: synchronous decoder.push fills pending[] with copied output before flush can wait for acknowledgements or enforce decoded size. E5 accumulated 64 MiB from a tiny input. maxInFlightObserved=4 measures posted messages only and hides the queue. Header/window checking also does not make total output buffering bounded.
Fix: make decoder output production itself backpressured, or feed bounded compressed slices with a proven worst-case expansion/output bound and enforce the byte limit inside emission. Count pending bytes in metrics and test high-ratio/concatenated/oversized frames, cancellation and native process peaks. Never certify the native never-whole-catalog rule from tiny dev-pack metrics.

R06 — P1 — activation journal is not sufficient for boot rollback.
Files: packages/core/src/services/catalog-install.ts:191,215–218,237–242,351–375; apps/mobile/src/platform/app-database.ts:51,97–99; apps/mobile/src/platform/pack-install/native-store.ts:116–128.
Why: the prepared old-current digest/refs are not durably recorded before the two renames; boot recovery marks jobs interrupted then checks presence, not journal/hash truth. E6 marks a previously installed catalog absent instead of restoring its retained previous file. A crash after candidate rename but before USER commit can also leave old receipt/new active bytes unreconciled. hasPrevious is an in-memory Set lost on restart.
Fix: persist a prepared journal before rename, discover previous state from disk, verify active/previous digest+meta against committed receipts on every boot, restore/reopen old state before releasing readers and clean up only after durable commit. Test every rename/commit/reopen/rollback boundary, including first install and disk-full.

R07 — P1 — required refresh/fill-in modes and exact replay are missing.
Files: packages/core/src/services/sync.ts:9–19,31,114–120,310–326,345–369.
Why: incremental and refresh throw UNSUPPORTED_CAPABILITY, so required single-set fill-in/unpublished recheck paths do not exist. prices_only commits catalog then refetches after interruption; pendingBatch is always null. A changed upstream response can replace the first observation before it is captured in USER history. That is not the documented persisted-payload/hash replay, even if identical refetches are idempotent.
Fix: implement the required modes and durable pending payload/hash/generation replay. Preserve the exact first batch across a kill between CATALOG and USER commits. Honest disabled buttons are correct interim behavior, not an owner-approved scope reduction.

R08 — P1 — .fdx backup and restore are unimplemented owner requirements.
File: packages/core/src/services/stubs.ts:11–18.
Why: capability flags are honestly false and all operations reject UNSUPPORTED_CAPABILITY. Director D25 authorizes that representation while unfinished; it does not override BRIEF's full-backup requirement. JSON v1 does not preserve app settings and is not .fdx.
Fix: implement the documented bounded archive/create/preview/safety-copy/restore/recovery protocol and test restore after reinstall with absent/newer catalogs. Do not mark old raw-backup criteria capability-exempt to hide the .fdx gap.

R09 — P1 — manifest trust and SQLite validation fall short of the contract.
Files: packages/schemas/src/manifest.ts:5–18,61–66; packages/core/src/services/catalog-install.ts:84–95,183–187; apps/mobile/src/platform/app-database.ts:64–76; apps/mobile/src/platform/pack-install/installer.ts:81–85,118–136.
Why: production URL validation is prefix-only, signatures are parsed but never verified, downgrade/same-version-different-hash/calendar/cross-field rules are missing. E6 accepted an unknown signature and invalid version/count combination. Candidate validation checks some meta/counts and best-effort quick_check, but not exact bundled migration/schema fingerprint, object allowlist/triggers/views or mandatory FK/integrity checks; quick_check transport errors are swallowed. Manifest text is fully allocated before its cap is checked. SHA checks do work, but a manifest hash alone does not authenticate the publisher or validate a supplied schema.
Fix: centralize semantic validation/trusted origins+redirects, reject unsupported present signatures or verify shipped keys, reject immutable-version drift/downgrades, bound reads while streaming, and require candidate/active schema+integrity+FK/object checks. Unsigned Phase 1 manifests are allowed; ignored invalid signatures are not. Do not describe this as a demonstrated arbitrary-code exploit.

R10 — P1 — install/refresh exclusion and read generation barriers are incomplete.
Files: packages/core/src/services/catalog-install.ts:193–206; packages/core/src/services/sync.ts:147–149,373–398; packages/core/src/db/database-set.ts:62–92; packages/core/src/services/collection-list.ts:54–90,164–185.
Why: sync start checks install jobs, but installer start does not check active sync. Their different-table lock keys do not conflict. The writable queue does not serialize activation/uninstall, generation values are captured but not checked by sync, and multi-domain reads do not perform the documented revision/generation retry. Readers can reopen during download after the initial invalidate. Native filesystem replacement therefore lacks a complete shared barrier.
Fix: one coordinator/transactional admission rule for both job types, per-language maintenance barrier across readers/writer/install/uninstall, token+generation fencing before write, and consistent-read retry/STALE_READ. Add both orderings of the start race and a read/activation race. This is source-observed concurrency exposure, not a measured native corruption incident.

R11 — P2 — builder resumes are not frozen runs and same-version artifacts are overwritten.
Files: tools/catalog-builder/src/cli.ts:103–128,157–174; tools/catalog-builder/src/http.ts:145–163; tools/catalog-builder/src/crawl.ts:38–70; .github/workflows/catalog-packs.yml:102–106.
Why: run metadata does not bind set selection/schema/toolchain; response cache is language-wide, --resume uses infinite cache age, and a new run may reuse shells for 24 hours rather than recheck. CLI removes existing raw/zstd artifacts before comparison, so changed same-version bytes overwrite local outputs instead of failing. CI verifies uploaded names but not downloaded lengths/hash bytes before publishing. Local SHA/round-trip verification is valuable but different from release read-back. The newly added tools/catalog-builder/src/verify-pack.ts:44–47 prints false check fields without asserting them/nonzero failure, so its exit 0 alone is not a validation gate; E8 used independent assertions.
Fix: namespace/bind frozen run inputs, revalidate appropriate discovery/shell units for new runs, verify cached URL/content/config, compare immutable existing hashes before replacing artifacts, and download/re-hash draft assets before publication. Add changed-selection/new-version/same-version-drift tests. No release was published by this review.

R12 — P2 — performance evidence does not meet the stated acceptance procedure.
Files: packages/core/test/perf.test.ts:47–69; packages/core/src/services/collection-list.ts:171–174.
Why: tests use one warmup/one measurement per query and 5,000 copies, not ten warmups/100 samples/p95 and 10,000 copies. Whole-group IDs use one extra query per displayed group (up to 50), not the documented batched lookup. Node pass is not bridge/device latency. The director correctly labels those numbers Node-only; calling C16 fixed does not close criteria 63–65.
Fix: reproduce the specified sample sizes, giant/many-group cases and p50/p95/max on target devices, batch group-ID lookup, and measure long tasks/input responsiveness during persistence/install. No phone performance numbers are claimed here.

R13 — P2 — platform capability/seam and native submission work remains.
Files: packages/core/src/platform/platform.ts:4–20; apps/mobile/src/platform/app-platform.ts:32–50,67–70,150–162; apps/mobile/src/platform/pack-install/native-store.ts:93–98; apps/mobile/ios/App/App/Info.plist:48–53.
Why: core Platform lacks the required Phase 1 image-cache seam; metadata HTTP always uses fetch rather than the specified explicit native CapacitorHttp path; file pick reads the whole file before maxBytes checking. Native free-space preflight is unknown, not implemented. No app-owned PrivacyInfo.xcprivacy exists under apps/mobile/ios; dependency manifests may supply some declarations, but the final archive/required-reason audit is absent. ITSAppUsesNonExemptEncryption=false is set while SQLCipher is linked and still needs a factual owner review.
Fix: add the specified seam/capabilities, enforce file.size before allocation, prove or honestly disable unsupported storage paths, implement/injection-test native transport, add required app declarations as needed and audit the merged native archive. Do not infer backup exclusion, encryption classification or App Store approval from TypeScript success.

4. PHASE1-ACCEPTANCE matrix

IDs are exactly docs/PHASE1-ACCEPTANCE.md 1–68. pass means the reviewed code and executed automated evidence support the item in the stated scope, not an assertion that every possible UI permutation was tested. fail includes a demonstrated defect or missing required implementation/evidence. untestable-here is reserved for physical native/OS checks unavailable on this Windows session. Mixed criteria retain the stricter result. The table is not an App Store approval certificate.

ID | Status | Evidence / remaining scope
1 | pass | routes/core-flow Playwright, actual route files; disabled Scan sheet, no /scan route.
2 | fail | routes.spec.ts passes 18 routes at both widths; full populated/error/long-Japanese/dialog matrix is not exercised and page.goto does not prove no-reload navigation.
3 | untestable-here | shell safe-area/tap-size code present; actual native keyboard/landscape/home-indicator checks outstanding.
4 | untestable-here | dark/rem/labels/reduced-motion code reviewed; VoiceOver, Dynamic Type and full contrast audit not established.
5 | fail | 63:88 placeholder source present; dedicated failing/slow/null-image browser assertions are missing from the current e2e suite.
6 | fail | E4 reproduces LAN HTTP UUID failure; native config has no server.url.
7 | untestable-here | local-first bootstrap and no-catalog paths exist; native airplane-mode cold launch/full installed workflow and production PWA offline cold launch not executed.
8 | pass | portfolio empty fixture tests and real empty-state branches; null money, no fake cards.
9 | pass | collection-list exact 6/4/2 fixture, grouped core-flow tile test; language/custom/variant separation.
10 | pass | tcgdex-map/portfolio tests: half-up cents, zero/null, exact qualifiers, timestamps, overrides and overflow.
11 | pass | portfolio same-currency coverage/basis/intersection tests and currency/coverage UI branches.
12 | pass | portfolio newest-ten/imported-time tests; copy-linked recent source.
13 | pass | Collection empty/filtered/loading/error branches reviewed, routes smoke passes.
14 | pass | collection-list 125-row paging, giant group, variantDetail subgroups, complete IDs; browser one x2 tile.
15 | pass | collection-list filters/priced/currency/sort/Pocket tests and typed route/hook mapping reviewed; exhaustive UI interaction matrix is not claimed.
16 | pass | whole-collection duplicate eligibility test, including deletion resetting count.
17 | pass | CRUD per-copy/nullable/children rollback tests and editor service mapping; no automatic sibling update.
18 | pass | exact-copy delete/FK child tests plus confirmation/cancel source.
19 | pass | catalog search tests cover literal wildcards, exact 001 vs 1, Japanese, bilingual filters; local search does not fetch.
20 | pass | browser confirm/add flow and variant/condition controls; no auto-add on search.
21 | pass | bulk-add N bounds/100/cert/parent/rollback tests, per-copy cents and shared acquisition.
22 | fail | R02/E3: uncertain flush does not reopen/block writes; manual retry duplicates copies. Post-save haptics are best-effort.
23 | pass | custom CRUD/snapshot tests, /custom-cards/new route and E1 Japanese custom copy.
24 | pass | public strict schemas and raw SQL XOR/money/enums tests; identity not patchable.
25 | pass | details/editor code reviewed, core DTO/history tests, browser set/collector/valuation detail assertions.
26 | pass | catalog-repo >50 copies/page-history test; no-price remains null and zero is displayable.
27 | pass | manual-price/grade stable-ID CRUD and valuation tests; sync never writes overrides.
28 | pass | catalog wipe/snapshot/history tests keep copy editable/readable without catalog.
29 | pass | shared acquisition edits, InUse protection and leading-zero cert tests.
30 | pass | bilingual same-id set tests; set summaries separate advertised/catalog/owned counts.
31 | pass | explicit five-card fixture gives owned4/unique1/missing4/extras2/completion20.00; customs separate.
32 | pass | active-manifest missing and incomplete-null-completion tests; upstream extras not denominator.
33 | pass | missingPreview20/paging tests and bounded Set detail UI.
34 | fail | prices_only queue/navigation/recovery exists; required refresh/incremental selection paths remain unsupported (R07).
35 | fail | fake retry/404/timeout tests pass; explicit native transport/late-response routing and adaptive concurrency contract are not proven/fully implemented (R13).
36 | fail | pendingBatch always null, no exact persisted payload replay/generation fence; native writer invalid (R04/R07/R10).
37 | fail | E1 proves actual reinstall preserves four rich copies; full incremental/refresh/fail-resume/cancel invariant matrix cannot pass while those modes are missing.
38 | pass | raw FK/cascade inspection and catalog-wipe tests; owned snapshots and identity ledger survive; E1 replacement is unchanged.
39 | fail | shared mapper tests pass; device discovery/304/shell recheck/metadata fill-in paths are absent, so full idempotent sync criterion fails.
40 | untestable-here | settings/default/revision tests pass and legal text is reachable; phone relaunch/progress behavior is untested, refresh scope also blocked by R07.
41 | pass | JSON schema/zod/export tests plus real browser JSON download in core-flow.
42 | pass | JSON export-import-export equality test; no catalog dependency for preserved personal snapshots.
43 | pass | 45-column/BOM/RFC4180/Japanese/parent CSV tests and explicit loss warning source.
44 | pass | formula escaping/invalid import tests; independent malformed-timestamp CSV dry-run returned valid:false without commit.
45 | pass | transfer dry-run plan/report/partition/revision logic and tests; no implicit commit.
46 | pass | exact identity/triple/stub/custom plan logic and 001 distinction tests; generated IDs retained in plan.
47 | pass | skip/update/authoritative child tests and transactional import validation; immutable history checks reviewed.
48 | fail | receipt replay/stale/atomic core tests pass, but web flush uncertainty/reopen recovery fails R02; complete expiry/kill matrix not evidenced.
49 | fail | Director D25 supersedes raw wording: .fdx create absent, JSON is interchange fallback (R08).
50 | fail | .fdx preview/restore validation absent (R08), not waived by raw-restore capability exemption.
51 | fail | .fdx safety backup/maintenance/swap/reopen/crash recovery absent (R08).
52 | untestable-here | real web JSON download passes; native Share/files picker/cancel/save behavior requires device evidence.
53 | pass | catalog-repo strict boundary/filter/paging/NotFound tests; app-level bilingual merge.
54 | pass | collection CRUD public methods through same proxy with temp-file SQLite; rollback/validation/revision tests.
55 | pass | acquisition CRUD/shared edits/date/bounds/InUse tests.
56 | pass | location/group normalization/FKs/membership atomicity/no-op revision tests.
57 | pass | custom CRUD/referenced-language/no snapshot rewrite/protected delete tests.
58 | fail | portfolio/settings/health pass; complete SyncService modes/fencing contract does not (R07/R10).
59 | fail | transfer functions exist; BackupService remains a capability stub, full native adapter smoke absent.
60 | fail | normal DomainError mapping works; LAN UUID throws an untyped TypeError (E4), persistence copy falsely claims reload (R02).
61 | fail | USER/catalog migrations and proxy alias/RETURNING tests pass; native writable connection cannot enable FKs/DML (R04); old 17-table count is stale under A3 additions.
62 | fail | real second-tab overwrite (E2) and fail-open flush retry (E3); awaited saveToStore alone is insufficient.
63 | untestable-here | 40k Node smoke passes; required 10 warmups/100 samples/p95 plus device bridge measurements missing (R12).
64 | fail | only 5k copies and single timings; required 10k/giant-many-group/p95/dashboard/device evidence absent (R12).
65 | untestable-here | 200ms debounce/keyed queries/local mutations present; phone long-task/interaction evidence during flush/install missing.
66 | fail | exact disclaimer and permission strings present; native privacy/encryption/branding/archive proof incomplete (R13), trusted download policy incomplete (R09).
67 | fail | web workspaces build, WASM/dev-pack inventory passes E7; native builds/storage/full-catalog memory guarantees are unproven and R04/R05 block the intended path.
68 | fail | independent desktop gates now pass; required native build/phone/fault/benchmark evidence and owner requirements remain open.

5. Contract and regression notes

Core strengths verified: strict zod mutation inputs; composite language identity; immutable personal snapshots and no catalog-to-collection cascade; separate USER/CATALOG migration families; grouped query before paging with only representative DTO hydration; pricedCopies/totalCopies and separate USD/EUR valuation; exact-print mapping; bound SQL values/whitelisted sort structure; JSON/CSV plan+receipt transactions. Ordinary writes use BEGIN IMMEDIATE/COMMIT and rollback on pre-commit errors. There is no cross-file transaction claim.

Proxy review: duplicate projection names are rewritten to unique aliases, preserving joined catalog/set snapshot positions. RETURNING routes through run(..., returnMode='all') and changes.values is normalized into positional rows (sqlite-proxy.ts:194–199); native iOS header rows are accounted for. Core intentionally does not require RETURNING. Current web E1 returns the correct Furret snapshot, not the director round-1 column-shift corruption. Complex SELECT/compound/star fallback remains a maintenance seam; no unsupported alias bug is asserted by this review.

SQL injection: no user-controlled string interpolation into executable SQL was found in reviewed core paths. Search/filter values are bound, dynamic placeholders/table/sort choices come from code. The dev harness's table interpolation is a fixed allowlist and the harness is production-disabled. Do not expose generic SQL/paths through future Platform methods.

Money/time: persisted money uses checked integer cents/currency pairs. Shared provider parser avoids floating-point multiply and tests 1.005-style half-up rounding, null/zero/overflow. Audit times use ISO UTC; date-only purchase fields remain distinct and the UI avoids UTC-midnight display shifting. Independent bad CSV timestamps were rejected. No fabricated provider prices were found; many variants intentionally remain unpriced.

Primary regressions against docs are R01/R02/R04–R10/R13: no durable browser writer/recovery boundary, non-writable native catalog, unbounded decoder queue, incomplete activation journal, missing refresh/replay/.fdx, insufficient manifest/schema trust, missing barriers and Platform seams. Merely adding the missing ADRs does not fix them.

Director claims reconciled: round-1 snapshot/import/lint/e2e defects are not carried forward as still-open without evidence. Current gates are green and current joined snapshots are correct. Round-2's Node-only performance and native caveats remain accurate. .fdx and refresh/incremental remain honestly unsupported. The director's localhost-to-LAN inference is contradicted by E4. Production dev-pack exclusion, previously only unit-checked, is now directly verified by E7.

Builder strengths: encodeIdForPath preserves provider tokens and encodes '+'; all-set details support bundled index/shell status, published-card manifests determine counts; nullable art and symbol rewrite use core mapping, definite symbol404 becomes null; retries are bounded and concurrency reduces on429; failures prevent incomplete publication; migrations/integrity/FKs/counts/hash/zstd round-trip and measured/null-reason metrics exist. Builder 14 tests pass. E8 independently verifies both full local pack outputs produced concurrently by Terra. R11 limits the resumable/immutable/publication claims; I did not re-run the full EN+JA provider crawl or verify a remote release.

6. Security, privacy and native readiness

No account/analytics/recognition upload is introduced by the reviewed Phase 1 path. The exact BRIEF disclaimer wording is preserved in lib/legal.ts:4 and used in Settings/About/onboarding; provider/card names in catalog content are not themselves an app-branding violation. No visual rights clearance of binary icons/splash/store screenshots is claimed.

Info.plist has camera/photo usage strings without a Phase 1 camera implementation, and false for ITSAppUsesNonExemptEncryption. Capacitor points at bundled dist with no production server.url. Native catalogs are intended for iOS LibraryNoCloud, USER remains plugin-default backed-up storage; Android rules exclude flashydex/catalogs and flashydex/packs from cloud/device transfer. These are source findings, not measured backup contents. Directory flags, native raw-file open/rename, filesystem manifests, merged required-reason declarations and SQLCipher export classification still need Mac/device/archive verification.

The local privacy text discloses API/CDN metadata, export sharing and OS backups, including the catalog-download host generically. Before release, name the real publisher/contact/privacy URL and actual GitHub/CDN download operators. Do not claim requests reach only TCGdex. Imported files are capped at the service boundary, but the picker currently allocates bytes before applying the cap (R13). Full .fdx archive/path/zip-bomb protections cannot be credited to a stub.

7. Launch-readiness verdict

NOT YET — not ready for owner phone test on native as a Phase 1 acceptance candidate.

A disposable-data exploratory UI demo is possible; it is not acceptance or safe collection migration. Do not ask the owner to trust real collection data in the current browser build.

Blockers before a meaningful native candidate: fix native writable catalog R04, decoder buffering R05, activation recovery and coordination R06/R10; implement the required refresh/replay and .fdx work R07/R08, or obtain an explicit owner scope amendment rather than implying completion; fix LAN UUID R03 for the documented browser test path and personal-data safety R01/R02 for web. Close manifest/schema validation R09. Configure/verify a real production manifest and full-language release—production has no manifest URL when FLASHYDEX_MANIFEST_URL is unset and dev packs are correctly excluded. Then run native build/install/airplane-mode/migrations/share/backup-exclusion/kill-space tests, privacy archive review and required phone benchmarks. Green desktop gates alone do not close those blockers.

8. [needs owner input]

- Publisher legal name, support/privacy contact and public privacy-policy URL; actual manifest hosting/release-discovery URL. Git remote is verified above, but availability of a published production pack was not verified.
- Mac/iPhone access and model/OS for native build, Instruments memory/kill/storage tests, VoiceOver/Dynamic Type and native share/backup verification; Android build/device evidence separately.
- Confirm iPhone-only vs iPad/orientation support before device/store screenshots; current Info.plist permits landscape while director notes requested portrait-only.
- Confirm export-compliance classification with the linked SQLCipher dependency and final archive; do not guess from the app's no-encryption intent.
- Rights/branding approval for app icon/splash/screenshots/accent and TCGdex artwork use. No claim of legal approval is made.
- If the owner wants to defer .fdx or full refresh/fill-in, explicitly amend the binding Phase 1 scope. Existing disabled capability controls do not constitute that amendment.

Delivered: .agent/reports/sol-review.md and appended ADR-040–048 in docs/DECISIONS.md. No commits/pushes or implementation edits. All identified code changes are requests to their owning agents/director, not fixes silently made by this reviewer.
