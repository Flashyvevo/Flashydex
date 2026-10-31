FlashyDex — GPT Sol re-verification after fix-F
Verdict: not yet

Scope and provenance

Reviewed BRIEF.md and its binding OWNER UPDATEs, docs contracts (including API.md Director notes — Stage D/E), the requested Stage D/E contracts and director/Sonnet reports, sol-review.md R01–R13 and sol-review-3.md. Reports were treated as claims; findings below use implementation, test bodies, independently executed gates and additional probes. D40's in-place transactional restore and D44's explicitly disabled native catalog writer are recognized. Plain-HTTP LAN read-only mode is the documented development limitation, not a product regression. The parent's UUID helper is present.

Reviewed HEAD: ad3f4fb6a9b7f22ae6d7e519b875758849ade0a1, unchanged at final verification. Initial git status had only the untracked .agent/sol-review-4-task.md. My only repository edit is this report. No commits, implementation/configuration edits, or modifications of another agent's files. Requested gates generated their usual ignored outputs. Additional scripts/logs are my scratch files.

Measured host: Windows_NT 10.0.26300, x64, Intel Xeon Platinum 8370C @ 2.80GHz, Node v24.19.0. Recognition tests used Python 3.12.10. Parent HTTPS server :3200 / PID 23636 remained listening before and after. Playwright used its own :3201 server; no :3201 listener remained. No Mac, actual native bridge, phone, OS force-kill, power-loss or App Store approval is claimed.

1. Independently executed gates

Command                       Exit   Actual result
npm run typecheck             0      core + schemas + mobile pass
npm run lint                  0      0 errors, 21 react-refresh warnings
npm test                      0      core 353/353 in 31 files; mobile 40/40 in 9; pytest 1/1
npm run build                 0      production Vite build + PWA generation pass
npm run e2e                   0      21 passed, 1 explicitly skipped, 22 scheduled

No performance skip variable or temporary Playwright configuration was used. Root lint covers mobile, not every workspace.

Actual stdout excerpts, verbatim apart from ANSI removal and omitted repetitive warning locations/asset listings:

  > flashydex@0.0.0 typecheck
  > npm run typecheck --workspace=@flashydex/core && npm run typecheck --workspace=@flashydex/schemas && npm run typecheck --workspace=@flashydex/mobile
  > @flashydex/core@0.0.0 typecheck
  > tsc --noEmit -p tsconfig.json
  > @flashydex/schemas@0.0.0 typecheck
  > tsc --noEmit -p tsconfig.json
  > @flashydex/mobile@0.0.0 typecheck
  > tsc --noEmit -p tsconfig.app.json && tsc --noEmit -p tsconfig.node.json

  > flashydex@0.0.0 lint
  > npm run lint --workspace=@flashydex/mobile
  > @flashydex/mobile@0.0.0 lint
  > eslint .
  ✖ 21 problems (0 errors, 21 warnings)

  > flashydex@0.0.0 test
  > npm run test --workspace=@flashydex/core && npm run test --workspace=@flashydex/mobile && bash scripts/test-recognition.sh
  RUN  v5.0.5 C:/Projects/flashydex/packages/core
  Test Files  31 passed (31)
       Tests  353 passed (353)
    Duration  45.77s
  RUN  v5.0.5 C:/Projects/flashydex/apps/mobile
  Test Files  9 passed (9)
       Tests  40 passed (40)
    Duration  9.27s
  platform win32 -- Python 3.12.10, pytest-9.0.2, pluggy-1.7.0
  collected 1 item
  services\recognition\tests\test_health.py .                              [100%]
  ======================== 1 passed, 1 warning in 0.49s =========================

  > flashydex@0.0.0 build
  > npm run build --workspace=@flashydex/mobile
  > @flashydex/mobile@0.0.0 build
  > tsc -b && vite build
  vite v7.3.7 building client environment for production...
  ✓ 2582 modules transformed.
  dist/assets/archive.worker-tOIRE0as.js                     192.56 kB
  (!) Some chunks are larger than 500 kB after minification. Consider:
  ✓ built in 11.48s
  PWA v2.0.0
  mode      generateSW
  precache  61 entries (2382.04 KiB)
  files generated
    dist/sw.js
    dist/workbox-9c191d2f.js

  > flashydex@0.0.0 e2e
  > npm run e2e --workspace=@flashydex/mobile
  > @flashydex/mobile@0.0.0 e2e
  > playwright test
  Running 22 tests using 2 workers
  1 skipped
  21 passed (1.5m)

Python's warning is the Starlette/AnyIO BlockingPortal deprecation. Build also emits Zod PURE-annotation warnings and the chunk-size warning; these are not build failures.

E2E passes include both viewports (390x844 and 1280x800): onboarding/install/add/group/detail/export, .fdx fresh-context restore with an archive-worker assertion, second-tab refusal/takeover, actual IDB put/quota failure, language-specific install failure, startup and routes. Mobile-only pack tests cover EN, JA, reinstall, hash mismatch, compressed-size mismatch and cancellation. Restore-maintenance passes on mobile; desktop is explicitly skipped in the spec, not silently counted as passed.

Additional independently executed commands, all exit 0:
  npm test --workspace=@flashydex/core -- --reporter=verbose       353/353 (second full run)
  npm test --workspace=@flashydex/mobile -- --reporter=verbose      40/40
  npm test --workspace=@flashydex/catalog-builder -- --reporter=verbose  27/27
  npm run typecheck --workspace=@flashydex/catalog-builder         pass

Per-file executed counts below were parsed from verbose output by sol-f4-summary.mjs:
  persistence-replay 2; persistence-latch 7; backup-semantics 8;
  backup-zip-headers 8; dashboard-consistency 5; backup-parser-seam 2;
  backup-hardening 8; backup 34; maintenance-gate 14;
  install-activation 17; install-recovery 18; install-settings 13;
  sync-modes 20; sync-stage-e 6; sync 10; coordinator 7;
  reader-protection 8; candidate-validation 10; manifest-validation 10; perf 6.
  Mobile archive-parser 10; bounded-decoder 6; native-http 6; uuid 1.
  Builder run-guard 13, http 7, builder 7.

Correction to fix-F's report: backup-zip-headers.test.ts executes EIGHT tests, not nine. Several cases loop through multiple mutations; they remain eight test cases. The full core total really is 353.

2. E01–E04 re-verification

E01 — fixed for the reported concurrent undurable import-replay success.

Read packages/core/src/db/sql.ts:201–215,269–299 and transfer/service.ts:264–282. Receipt lookup now uses durableRead: latch checked AFTER queue admission and after the SELECT while one USER queue hold is retained. An in-memory committed-preview result also checks the latch. Receipt-first behavior remains after recovery.

Read and ran persistence-replay.test.ts:13–71, 2/2: “PRE-persisted: the replay is refused (no success), recover() shows nothing persisted, retry applies exactly once” and “POST-persisted: the replay is refused during the flush; after recover() it returns the stored receipt without re-applying.” They deliberately pause A after SQL COMMIT inside afterCommit, start B while the latch is still clear, then release A to fail. Both A/B must return PERSISTENCE_FAILED. PRE reopens to zero then applies once; POST replays the durable receipt with one copy. This is the old failing ordering, not merely another sequential retry test. persistence-latch 7/7 and IDB-failure E2E 2/2 also pass. No residual E01 reproduction was found.

E02 — fixed for all four demonstrated invalid-domain-state acceptance probes.

Read packages/schemas/src/backup.ts:21–30 and core/src/backup/archive.ts:350–416. Annotation overlays are strict allowed fields; custom/copy language equality, selected-language/followed-set uniqueness, audit ordering, scan ordering and disclaimer time/pair are checked before preview staging succeeds.

Read and ran backup-semantics.test.ts:12–80, 8/8: custom-language, duplicate/unselected followed-settings, followed-unselected, unknown annotation shape, numeric annotation name, reversed-audit, scan-order, and a valid rebuilt archive. Hostile fixtures are rebuilt with correct hashes, so rejection is semantic rather than incidental CRC/hash damage. Each rejection asserts BACKUP_INVALID/readable reason, zero target owned rows and unchanged collection_revision. These eight cases do not themselves compare every target table; backup.test.ts's existing hostile-archive helper DOES compare all target tables. Do not infer complete domain validation merely from these examples.

E03 — fixed for the exact local-only encryption/flag-disagreement defect; broader ZIP consistency remains partly open as F02.

Read archive.ts:69–70,104–120,144–162. Encryption masks 0x1/0x40/0x2000 are rejected in either header, local/central flags must be identical, and non-descriptor local method/CRC/compressed AND uncompressed sizes must agree centrally.

Read and ran backup-zip-headers.test.ts, 8/8: untouched ZIP, Sol local-only bit 0, central-only bit 0, strong/masked encryption in either header, local-only descriptor flag, UTF-8 disagreement, local uncompressed-size mismatch, method mismatch. backup-hardening 8/8 retains the four CRC cases. A genuinely streamed ZIP with BOTH descriptor flags set is a different path: its corrupted descriptor CRC is still accepted (F02). This does not resurrect the fixed local-only flag case or imply a payload SHA bypass.

E04 — fixed for dashboard personal-revision consistency.

Read portfolio.ts:15–19 and database-set.ts:132–156. Dashboard now uses consistentRead, checking collection revision and catalog epochs/handle generations, retrying once then STALE_READ.

Read and ran dashboard-consistency.test.ts:31–73, 5/5: delete/add/update in the aggregate-to-hydration gap, repeated movement -> STALE_READ, and baseline. I additionally exercised an ACTUAL BackupService.restore between aggregate read and hydration in real temporary SQLite: fired=true, dashboard.totalCopies=0, recent=0. This closes the previously untested restore interleaving for this exercised boundary. Other public personal-dependent reads still have the narrower wrapper (F01); dashboard's specific fix is not regressed.

3. Every previously partial item and R01–R13

N04 / R08 processing residue — partly, not complete.

The restore parser genuinely moved to a worker in the normal mobile/browser path: app-platform.ts:66–70, archive-parser.ts:19–74, archive-worker-core.ts:13–20; core backup-service.ts:70–74,143–149 delegates. Buffer ownership transfers after handshake; cancellation terminates the worker; post-transfer crash rejects rather than silently reparsing. Read and ran mobile archive-parser.test.ts 10/10, core backup-parser-seam 2/2, and both fresh-context restore E2Es (worker URL assertion at core-flow.spec.ts:74–84). The production archive worker exists in dist.

But archive.ts:42–65 STILL JSON.stringify/encodes whole entities and calls zipSync on the calling thread; backup-service.ts:100–123 calls this for normal AND restore safety backups. app-platform.ts:50–55,82–88 still materializes whole picked/stored files. archive.ts:185–205,298–305 retains inflated entry bytes then creates full parsed objects; worker results are structured-cloned, not a backpressured entity stream. Startup failure/no Worker/handshake timeout deliberately falls back to in-thread parsing (archive-parser.ts:34–52). That fallback is tested, not evidence of off-thread guarantees.

Additional synthetic Node-only measurement through the actual buildArchive: 10,000 copy objects with repetitive notes -> buildMs=460.34, largest timer gap=462.07 ms, archive=355824 bytes. This is caller-thread/event-loop work, NOT a phone/WebView measurement or native peak RSS. It demonstrates why a parse worker alone does not finish the large-work requirement. No retained-memory/resource acceptance test exists in the new cases. Finish cancellable worker creation, streaming/backpressured I/O and resource budgets; reject unsupported large work honestly instead of falling back to a UI-thread freeze. fix-F's “FIXED, with limits” is only a partial closure of N04.

N05 — fixed for the old sequential and concurrent replay defects; E01 evidence above.
N07 — partly overall: retired-handle handling still passes 8/8; dashboard revision gap fixed, but F01 demonstrates the same class on CatalogRepo.getCard.
N08 — fixed for payload CRC/local-only flag defects; general descriptor/size validation still partial (F02).

R01 — fixed for the original second-tab overwrite. Bootstrap takes the Web Lock before USER open; both instance-lock E2Es passed denial, reload, close/takeover and retained data. This is browser execution, not every crash/BFCache permutation.

R02 — fixed for the reported fail-open persistence/replay defects. db/sql.ts:269–299 latches afterCommit failure and checks blocking state again after transaction admission; E01 now serializes replay reads. Seven latch plus two concurrent-replay core cases and both actual IDB-failure E2Es pass. app-database.ts:14–18 honestly requires actual page reload on web when reopen-without-save is unsupported. No automatic ordinary-write replay is claimed. This does not certify hardware/power-loss durability.

R03 — fixed by parent. Read uuid.ts:2–10 and uuid.test.ts:5–18 (1/1): crypto.randomUUID or crypto.getRandomValues with v4/variant bits, never Math.random. app-platform.ts:68,76,91 uses the helper. HTTPS phone trust still needs device verification; plain-HTTP read-only is intentional D42, not a new UUID blocker.

R04 — partly / disabled by design; native writable implementation still NOT present. native-store.ts:22–36,192–198 documents a design then throws UNSUPPORTED_CAPABILITY; app-database.ts:40–65 keeps native writes false. sync-modes.test.ts:95–103 passes honest capability refusal. D44 permits this restricted engineering build. It does not implement native prices_only/refresh/incremental or resolve Android writable-directory/copy/writeback/cleanup. This needs CODE plus device proof, not a Boolean flip after compiling.

R05 — fixed for the original unbounded pending queue. Read bounded-decoder.ts:46–67,81–110 and its tests:34–73 (6/6). Emission counts queued+unacked bytes and throws before retaining beyond the hard cap; the 64 MiB high-ratio test either stays bounded with small slices or aborts at the default hard cap. Pack E2Es pass. Fail-fast rejection is not proof every legitimate high-ratio stream installs or that full EN/JA native RSS meets budget.

R06 — fixed for the reported core activation/recovery defects under adopted cheap active checks; native evidence remains separate. Read catalog-install.ts:294–340,366–408,585–625. Prepared journal precedes activate, activated schema/meta is checked before receipt/previous cleanup, validated previous is restored with its receipt. install-activation 17/17, install-recovery 18/18, install-settings 13/13 passed. Read actual fault-test bodies: real SQLite files plus FAKE rename/web-key ports, not iOS bridge kills. Do not call cheap schema/meta checks full active rehash/integrity validation; refreshed catalogs must not be compared to immutable baseline SHA.

R07 — partly overall. Core modes and exact persisted replay work in the exercised paths: sync-modes 20/20, sync-stage-e 6/6, sync 10/10. Read sync.ts:170–179,400–418,481–590 and tests for changed upstream, pre/post pending/catalog commits, persisted identity replacement and terminal set failures. Persisted generation|status|version|sha256 fences survive restart; first observation 27 is replayed with zero refetches. Native modes remain disabled by R04. sync.ts:719,737–765 still uses fixed concurrency, not 429-halving/recovery; headers at :744 are only accept, no conditional ETag discovery. These are remaining code/contract gaps, unchanged in fix-F, not Mac-only tests. Incremental changed-header semantics already adopted in API notes are not reported as a new defect.

R08 — partly. .fdx is implemented and rich personal/settings/history round-trips pass backup 34/34 with same/absent/newer catalogs; safety reversal, stale tokens, rollback and hostile archives pass. E02 is fixed, restore-maintenance 14/14 and mobile overlay E2E pass, fresh-context worker restore passes both widths. N04 and F02 remain. includeUserImages is warned unsupported, not image-byte round-trip support. D40 intentionally supersedes USER file-rename restore; missing file swap is NOT a finding.

R09 — partly against the full original validator contract. Read candidate-validation.ts:24–87 and candidate/manifest tests (10/10 each): actual sqlite_master SQL/object allowlist, meta language/version, integrity/FK/count/language failures and manifest origin/redirect/signature/downgrade/date/immutable-version checks pass. But checkMeta selects only language,version,schema_version (:43); schema_migrations receipt VALUES and catalog_meta.schema_fingerprint VALUE are still not compared to bundled receipts/fingerprint. Matching actual object SQL is meaningful protection, but does not satisfy the separate migration-receipt contract. Unsigned Phase 1 manifests are intentional and unauthenticated against a compromised publisher, not a newly discovered signature exploit.

R10 — partly overall. coordinator.ts:38–78 and database-set.ts:64–102,137–205 now provide admission/barriers/fencing; coordinator 7/7 and sync-modes' competing-start-order/barrier/epoch tests pass. Maintenance-gate 14/14 and reader-protection 8/8 pass. E04 fixes dashboard, but F01 proves a remaining public personal+catalog mixed snapshot. No native corruption is asserted from these core races.

R11 — partly, unchanged by fix-F. Read builder run-guard.ts:19–35,49–85, http.ts:154–172 and run-guard.test.ts. Builder 27/27, including guard 13/13, and builder typecheck pass. Immutable artifact drift is refused; new-run cross-cache reuse is refused. However response files remain language/path-wide, not immutable per-run: test :123–130 explicitly expects run A -> B -> A to refetch because B overwrote A. Dirty identity hashes git diff/status, not untracked-source contents. Fully frozen resumed inputs therefore remain incomplete. No crawl/publication/workflow or remote asset read-back was executed by me.

R12 — partly; improved Node evidence, not phone acceptance. Read perf.test.ts:11–15,41–52,75–107 and collection-list.ts:175–180 (batched whole-group IDs). Six performance cases pass, 40,000 catalog rows, 10,000 copies, ten warmups/100 samples. Current fixture's largest group is 100, not one 10,000-copy group; no dashboard p95 test. Second full-run p50/p95/max ms:
  char prefix            37.6 / 60.4 / 85.0
  pikachu prefix         13.0 / 24.9 / 43.3
  char contains          56.7 / 72.3 / 267.0
  collector 19           22.4 / 35.3 / 58.2
  charizard + number20    7.6 / 15.4 / 40.6
  collection created     55.3 / 76.1 / 90.2
  collection name        33.0 / 53.6 / 80.1
  collection count       34.5 / 43.9 / 67.7
  collection q=char      12.2 / 19.5 / 21.4
These are Node/sqlite-proxy timings, not Capacitor/WebView/phone budgets. Needs a genuine giant-group fixture, dashboard samples, bridge/device p95 and typing/navigation/long-task measurements.

R13 — partly. Read app-platform.ts:50–55,155–174 and native-http.test.ts (6/6): picker checks File.size before allocation, explicit native CapacitorHttp mapping/timeout/abort/late-result handling exists. Platform.imageCache? is the adopted optional interface-only seam. PrivacyInfo has file reference/group/Resources membership (project.pbxproj:11,23,85,169), but is unbuilt here. native-store.ts:120–122 still returns null for native availableBytes; native free-space preflight needs implementation, not just a device run. SQLCipher classification, merged privacy report, actual backup exclusion and native share/files behavior remain unverified.

4. Regression / personal-data-safety sweep

Reinstall invariant: read and ran “reinstalling a newer version keeps owned_cards count and every personal row (37)” in install-settings.test.ts:47–57. It passes with three owned copies, first-pack snapshots retained. Its comparison deliberately blanks price_snapshots, and helpers.ts:63–67 excludes settings/annotations; that test alone is not an ALL-personal-tables proof.

I additionally ran real CatalogInstallService + temporary SQLite with FakeDiskPort for a genuinely newer version: three catalog copies with grade, condition, shared acquisition, zero cost, EUR manual override, location/group/notes; one JA custom copy; populated annotation. Compared canonical owned, grade, acquisition, location, group, membership, custom, ledger, history, annotation, session, settings and app_state tables with no history exclusion:
  personalEqual=true; owned=4
  beforeSha=8237d07446d4d4dda7b6c10bd8b88d76393348e3b4b2935e3f38f0463a55ce41
  afterSha= 8237d07446d4d4dda7b6c10bd8b88d76393348e3b4b2935e3f38f0463a55ce41
The session table was included but not populated in this probe. This supports the stated reinstall invariant for the exercised transition; no full native/kill matrix or new rich-data real-web-worker reinstall is claimed. Sync refresh tests retain owned rows/revision while allowing observational price history additions, per contract.

.fdx: archive.ts uses entry-name allowlists, not extraction paths, and rejects traversal, absolute/drive/backslash/NUL, symlinks, duplicate/unknown names. Read hostile test bodies plus executed backup 34/34 and hardening 8/8: actual inflated-output caps/bombs, entry SHA, whole-archive preview hash, CRC, row/count/ref/schema/version guards pass. E02 now rejects correctly hashed invalid domain rows. F02 is remaining malformed-container acceptance, NOT demonstrated traversal, ciphertext decryption, SHA bypass or arbitrary code execution. Caps do not prove bounded retained memory, and user backups are not publisher-authenticated.

Coordinator: competing install/sync orders, uninstall/rollback during active sync, restore admission, per-language barrier and exact replay fences still pass. Restore closes personal gate before safety snapshot and drains/refuses queued writes (sql.ts:139–152,269–299; backup-service.ts:205–256). API.md:540 intentionally guarantees refusal at the transaction step for multistep methods; a new transaction requested after gate exit is not misreported as a gate violation. New durableRead does not replace ordinary read behavior or deadlock the tested maintenance/import races.

Production inventory from my build: 2696084 bytes; assets/sql-wasm.wasm and archive.worker-tOIRE0as.js present; no dev-packs, .db or .zst payloads. This is web dist inventory, not IPA size, offline phone launch or native memory proof.

5. New/residual second-pass actionable findings

F01 — P2 — CatalogRepo.getCard still mixes personal snapshots after E04's dashboard-only repair.

Files: packages/core/src/services/catalog.ts:304–320,330–332; db/database-set.ts:165–178. getCard uses protectedRead (catalog generations only), then separately reads owned COUNT, copy IDs and hydration. A personal revision movement with no catalog swap is invisible.

Independent real-SQLite probe deleted the sole copy AFTER count returned but BEFORE copy ID selection:
  fired=true
  actualOwned=0
  card.ownedCount=1
  ownedCopies.page={offset:0,limit:30,total:1,hasMore:true}
  returnedCopies=0
This response has no coherent personal snapshot; hasMore can also invite empty-page fetching. It is not persisted data loss. E04 dashboard tests pass and do not cover this method.

Fix: use revision+catalog-generation consistentRead (or one appropriate snapshot/lease) for getCard and audit getSet/listSets/listSetCards/other personal-dependent public reads. Retry once then STALE_READ. Add count->IDs->hydration add/delete/update/restore interleavings. Existing retired-handle protection must remain.

F02 — P2 — ZIP descriptor contents and coherent-but-wrong expanded-size declarations are still not validated.

Files: packages/core/src/backup/archive.ts:89–123,144–162,272–275,289–295. When bit 3 is set in BOTH headers, local validation skips CRC/sizes and no code verifies the data descriptor. Actual CRC is compared against central metadata, but descriptor bytes are ignored. Even in a non-descriptor ZIP, matching local/central uncompressedSize is never compared to actual inflated size (manifest bytes are a separate check).

Independent probes, with unchanged valid payloads/manifest hashes:
  coherently-wrong-zip-expanded-size: actual=777, declared=778, accepted=true
  streamed-zip-corrupt-descriptor-crc: descriptor CRC=0x12345678, accepted=true
The second fixture was produced with fflate's actual streaming Zip/ZipDeflate, parsed successfully before mutation, then its first descriptor CRC was corrupted. This is not the old local-only descriptor-flag mismatch; fix-F correctly rejects that old probe.

Fix: either reject descriptor-bearing ZIPs as unsupported consistently, or validate descriptor presence/layout/CRC/compressed and uncompressed sizes against central and actual output. Compare actual entry length to directory declarations without using them as trusted allocation caps. Add these two cases plus truncated/contradictory descriptors and directory-bound checks to hostile preview tests; assert zero target writes. Existing SHA/actual-output bomb checks remain required. Severity is malformed-archive validation P2, not an integrity exploit.

No new P0 or reproduced P1 ownership/durability defect is asserted. The prior E01 P1 race is closed. N04's remaining caller-thread creation/whole-buffer resource work remains the existing P1 processing gap; relabelling it “worker done” would be inaccurate. R04/R13 remain explicit implementation gaps, not fabricated native failures.

6. Readiness decision and exact remaining work

NOT YET — not ready for owner native (Mac) build + phone test as a complete, data-safe Phase 1 acceptance candidate.

Immediate code corrections:
  1. N04/R08: complete cancellable off-thread archive creation (including restore safety copy), backpressured/streaming I/O and retained-memory/resource handling; normal parsing worker alone is insufficient.
  2. F01/R10: guard personal revision consistency for catalog card detail and audit equivalent multi-step public reads.
  3. F02/R08: reject/validate malformed data descriptors and actual-vs-declared entry sizes.

Still-open full-contract implementation, not merely “needs a Mac test”:
  4. R04/R07: implement native writable copy/writeback/recovery/cleanup and Android path before native refresh/fill-in can be enabled. D44 explicitly allows a restricted exploratory build meanwhile, not full native feature acceptance.
  5. R13: implement native free-space preflight (availableBytes currently returns null).
  6. R09: validate migration receipt/meta-fingerprint values if retaining the full catalog validation contract.
  7. R07: implement adaptive 429 concurrency and conditional ETag discovery, or obtain/document a binding scope amendment.
  8. R11: freeze run-specific response bytes and bind relevant source contents, including untracked inputs, rather than overwritable shared response files.

Needs Mac/device execution, distinct from missing code:
  - Xcode/Capacitor sync, native build/install/archive; Android build/device separately.
  - Existing-file open/validation/close, actual native activation/rollback, force-kill boundaries, low-space/mid-write failures and preserved USER data.
  - USER backup inclusion versus catalog/staging/previous exclusion.
  - Actual .fdx document picker, Share/Save-to-Files, safety restore and airplane-mode cold launches.
  - CapacitorHttp timeout/cancel/late results on the actual bridge.
  - Full EN/JA process peak RSS/staging footprint and responsive interaction; acceptance 63–65 search/collection/dashboard p95, including a true giant group (not only groups of 100).
  - PrivacyInfo target build/merged archive report, SQLCipher/export-compliance owner classification.
  - VoiceOver, Dynamic Type, safe areas/keyboard/orientation, and actual phone trust in the self-signed LAN HTTPS certificate.

Owner/release items: production manifest/full-language release availability and build configuration, legal publisher/support/privacy URL, actual download-host disclosure, rights/branding, encryption classification. I did not publish or remotely verify a production release.

A disposable-data Mac engineering spike is allowed under D44 and can proceed to discover native defects. That is not a claim these remaining code requirements are implemented, not Phase 1 sign-off, and not a recommendation to migrate the owner's real collection. Green desktop gates are necessary but not the complete acceptance gate.

Evidence paths

C:/Users/AshtonSeabolt/AppData/Local/hermes/cache/scratch/
  sol-f4-typecheck.log, sol-f4-lint.log, sol-f4-test.log, sol-f4-build.log, sol-f4-e2e.log
  sol-f4-core-verbose.log, sol-f4-mobile-verbose.log
  sol-f4-builder.log, sol-f4-builder-typecheck.log
  sol-f4-probes.mts / sol-f4-probes.log
  sol-f4-summary.mjs (programmatic suite counts, perf output, host/dist inventory)

The probe process exited 0: positive invariant/dashboard assertions passed; the two defect probes deliberately record accepted invalid states. Its first attempt failed on Windows ESM import URL formatting before exercising product code; corrected file:// imports were rerun successfully. Gate logs were moved to the explicit scratch path after discovering this shell's TMPDIR was /tmp; no remaining gate logs were left there by this review.

Repository deliverable: C:/Projects/flashydex/.agent/reports/sol-review-4.md. No commits or server restart.
