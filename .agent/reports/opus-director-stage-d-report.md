Opus director report: FlashyDex Phase 1, Stage D (closing GPT Sol's review)
Date: 2026-10-31. Director: Claude Opus. Children (all claude-sonnet-5-5):
  sonnet-core-d    packages/core, packages/schemas, tools/catalog-builder, workflow   (.agent/reports/sonnet-core-d-report.md)
  sonnet-mobile-d  apps/mobile, scripts/ios-notes.md                                  (.agent/reports/sonnet-mobile-d-report.md)
  sonnet-fix-d     director defects D1/D2 + residuals F3-F6                           (.agent/reports/sonnet-fix-d-report.md)
Binding contract between the parallel builders: .agent/stage-d-contract.md. Decisions D40-D47 are in .agent/DIRECTOR-DECISIONS.md.
Contract changes are in docs/API.md "## Director notes — Stage D (2026-10-31)", appended by core-d.
Director verification: .agent/review/director/STAGE-D-VERIFICATION.md.
Nothing is committed. About 60 files are modified and about 45 are new.

R-items
ID   Sev  Status  Evidence
R01  P0   fixed (web)
                  Web Locks writer lock 'flashydex-user-writer' is held for the page lifetime and taken before storage opens.
                  Director, DOM at 390: a second tab shows "FlashyDex is open in another tab". After the first tab closed, the
                  second took over in about 3 s with the data intact.
                  e2e: instance-lock.spec.ts.
                  On an insecure origin (no navigator.locks) all writes are refused and the writes-blocked banner shows.
                  Director checked this on http://10.0.0.4:3200. See the LAN note below.
R02  P1   fixed   Core: a fail-closed latch refuses every write with PERSISTENCE_FAILED until storage.recover() runs.
                  Tests: persistence-latch.test.ts has 7 cases, including retrying a transfer commit after recovery. It
                  applies exactly once whether the persisted state is pre-commit or post-commit.
                  UI: the persistence-failed overlay offers an honest Reload. Web has no reopen because a jeep close saves
                  first. e2e: persistence-failed.spec.ts injects a real IndexedDB QuotaExceededError.
                  New finding: jeep saveToStore deleted the stored DB before writing it, so a failed save lost everything.
                  It is fixed twice over: (a) the old bytes are restored on failure; (b) patch-package now makes the save a
                  single setItem, which the production build is verified to contain.
                  The running dev server still serves the old module until it is restarted.
R03  P1   fixed   Fixed earlier by the parent (uuid.ts).
R04  P1   partly  Native catalogWrites is false, and openWritable no longer falls back to the read-only NC handle. So
                  prices_only, refresh and incremental honestly report unsupported on native.
                  The copy-to-writable-dir design is documented in native-store.ts. TODO(R04-mac) marks the switch, and the
                  test steps are in scripts/ios-notes.md section 6.
                  The Android path is unresolved: the plugin's DB directory can't be reached from @capacitor/filesystem.
                  Not executed on a device.
R05  P1   fixed (JS side)
                  bounded-decoder.ts feeds 32 KiB slices and waits for acks until at most 4 MiB is pending. The hard cap is
                  32 MiB, and a stream that exceeds the manifest size aborts at once.
                  bounded-decoder.test.ts (6 tests) uses a 2 KiB → 64 MiB zstd bomb fixture. pendingBytesMax is in metrics.
                  Native process peak RSS is not measured.
R06  P1   fixed (core + web); native untested
                  The prepared journal is committed to the USER DB before any rename. Boot recovery reconciles
                  port.inspect() (disk/store truth) with the journal and the receipt, and hasPrevious comes from disk.
                  install-recovery.test.ts has 18 tests covering every boundary, first install vs update, rollback and disk
                  full.
                  Director: a corrupted EN update (one flipped byte) left the old catalog's SHA unchanged, left no stray
                  keys, and search still worked.
R07  P1   fixed   refresh and incremental modes now exist, and the pending payload is persisted before the CATALOG commit
                  and replayed verbatim.
                  sync-modes.test.ts (22 tests) includes a kill between the commits with a changed upstream response; the
                  first observation wins.
                  Director, live: Evolving Skies "Refresh this set" → "Cards updated" in about 10 s, owned rows untouched.
R08  P1   fixed   .fdx is a ZIP (fflate) with manifest, entities and settings.
                  Restore works as one in-place USER transaction (D40) and makes a verified safety .fdx first.
                  backup.test.ts (34 tests): reinstall, no catalog, newer catalog, zip bomb, traversal, versions, hashes,
                  counts, ALREADY_RESTORED.
                  Director: added 13 copies → backed up → wiped all origin storage → re-onboarded with the real EN pack →
                  restored. The before and after JSON exports match exactly (same UUIDs and fields).
                  e2e: core-flow backs up, restores in a fresh context and compares.
                  Limit: user image bytes are not stored, so includeUserImages only gives a warning.
R09  P1   fixed   Core semantic validator: trusted origins and redirects, any present signature rejected, downgrade,
                  same-version drift, calendar version and cross-field counts.
                  Candidate checks: schema fingerprint, integrity_check and foreign_key_check (errors are not swallowed),
                  and no triggers, views or extra objects.
                  The client reads the manifest with a streaming 256 KiB cap and checks the pack's final response.url
                  origin.
                  Tests: manifest-validation (10) and candidate-validation (11).
R10  P1   fixed   One WorkCoordinator with a durable work_admission row (migration 0002) covers install, uninstall,
                  rollback, sync and restore. It adds a per-language barrier, epoch/generation fencing and consistentRead
                  (retry, then STALE_READ).
                  coordinator.test.ts plus the R10 block in sync-modes: both start-race orders, a read/activation race, and
                  uninstall/rollback during sync.
R11  P2   mostly fixed
                  Frozen-run guard (run-guard.ts): a mismatched resume is refused, and same-version different bytes exit
                  nonzero. verify-pack now exits nonzero.
                  The workflow runs verify-pack before upload, then downloads the draft assets and re-hashes them against
                  the manifest before publishing.
                  Open: card-detail revalidation on new runs. The workflow has not been run.
R12  P2   partly  Node only: perf.test.ts runs 10 warm-ups and 100 samples with p50/p95/max over 10,000 copies, and the
                  group-ID lookup is batched into one query per page.
                  The device procedure is in apps/mobile/PERF-PROCEDURE.md. There are no device numbers.
R13  P2   partly  Done:
                    - core Platform.imageCache seam (interface only);
                    - the picker checks file.size before reading;
                    - native metadata goes through CapacitorHttp (native-http.ts, 6 mocked tests);
                    - an app-owned PrivacyInfo.xcprivacy (file timestamp C617.1).
                  Open:
                    - the privacy manifest is not added to the Xcode target and the archive audit is not done;
                    - native free-space preflight;
                    - SQLCipher/ITSAppUsesNonExemptEncryption owner review.

Director defects found and closed in this round
  D1  An EN update failure was shown on the Japanese row as "Retry". Fixed in fix-d with catalog-failure.spec.ts.
  D2  The .fdx manifest had "catalogs":[] although EN was installed. It now carries version hints, with a test.

Gates (director, final code)
  npm run typecheck   exit 0
  npm run lint        0 errors, 21 warnings (pre-existing react-refresh)
  npm test            core 275/275 (perf included), mobile 22/22, pytest 1/1
  npm run e2e         20/20 (mobile 390x844 + desktop 1280x800)
  npm run build       exit 0. The PWA builds, and the dist jeep chunk has the patched single-setItem save.
  catalog-builder     24/24
  Before Stage D: core 169, mobile 10, e2e 12.

Tests added
  core:
    install-recovery 18, coordinator 16, backup 34, sync-modes 22, persistence-latch 12,
    manifest-validation 10, candidate-validation 11
  mobile unit:
    bounded-decoder 6, native-http 6
  e2e:
    instance-lock, persistence-failed, catalog-failure, core-flow (backup → fresh context → restore)
  builder:
    run-guard

Real-pack evidence (director, web dev, 390x844)
  - Full EN pack install through onboarding took about 6 s (12.3 MB → 138 MB).
  - The stored DB is 138,002,432 bytes, and its SHA-256 bbca47b3…1606 equals the manifest's.
  - catalog_meta of those bytes: en, 2026.10.31.001, schema 1, 220 sets, 23,736 cards.
  - Settings shows "Catalog 2026.10.31.001".
  - Search works: Umbreon VMAX finds the 214/203, 215/203, 95/203 and TG23 cards.
  - The temporary pack copies and the manifest swap were reverted, and apps/mobile/public is clean.

Owner actions / caveats
  1. Restart the dev server on :3200 (PID 20868) so dev picks up the jeep-sqlite patch. Until then dev serves the cached
     unpatched module; the restore-on-failure mitigation still applies.
     I left the server running as instructed.
  2. LAN phone testing over plain HTTP is now READ-ONLY, including onboarding (ruling D42: no Web Locks on insecure origins).
     To edit on the phone, use one of:
       - Chrome remote debugging with USB port-forwarding of localhost:3200;
       - https via mkcert (Terra's T1).
  3. Commit: new patches/ dir + package.json postinstall (patch-package), migrations/user/0002 + meta, PrivacyInfo.xcprivacy,
     test fixture apps/mobile/src/platform/pack-install/fixtures/zeros-64mib.zst (2 KiB).

Still needs the Mac / devices
  - R04: native writable catalog (flip NATIVE_CATALOG_WRITES only after ios-notes §6 passes); Android equivalent.
  - Native stage/activate/inspect/restorePrevious and a force-kill during activation.
  - Backup exclusion flags.
  - Free-space preflight.
  - Real-pack peak RSS.
  - CapacitorHttp on device.
  - PrivacyInfo target membership and archive audit.
  - SQLCipher export-compliance decision.
  - Native Share/picker for .fdx.
  - PHASE1-ACCEPTANCE 63–65 device timings (per PERF-PROCEDURE.md).
