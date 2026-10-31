Opus director report: FlashyDex Phase 1, Stage E (Sol N01–N09 and the Grok copy pass)
Date: 2026-10-31. Director: Claude Opus. Children (all claude-sonnet-5-5):
  sonnet-core-e    packages/core, packages/schemas, tools/catalog-builder   .agent/reports/sonnet-core-e-report.md
  sonnet-copy-e    strings in apps/mobile/src + docs/UX.md                   .agent/reports/sonnet-copy-e-report.md
  sonnet-mobile-e  apps/mobile (N03/N07 UI, N09, price gap, R13)           .agent/reports/sonnet-mobile-e-report.md
  sonnet-fix-e     director-walk copy leftovers F1–F4                       .agent/reports/sonnet-fix-e-report.md
Binding contract between core and mobile: .agent/stage-e-contract.md (E1–E4).
The contract is recorded in docs/API.md under "## Director notes — Stage E (2026-10-31)", appended by core-e.
Nothing is committed: 57 files changed, plus new test files.
The owner's HTTPS dev server on :3200 (PID 23636) was never touched and is still listening.

Director deviation: after the single fix round, two literal "JA" labels were still on screen. I changed them to "JP"
myself. These were string-only edits and did not touch logic:
  - settings/index.tsx:38   the "EN ✓ · JA ✓" row
  - settings/about.tsx:44   "Catalog versions: … JA …"

N-items (Sol review 2)
ID   Sev  Status  Evidence
N01  P1   fixed   The activated file is now validated (fingerprint plus catalog_meta) before the receipt commit and before
                  discardPrevious. If it fails, undoSwap runs and the install fails with PACK_INVALID.
                  undoSwap now decides by content identity. Boot recovery validates the active file before it discards the
                  previous one; if the active file is bad, it restores the validated previous file with its receipt.
                  rollback refuses a damaged previous file.
                  The fake port gained a web key-write style. All of Sol's probes are tests:
                    - active-not-revalidated
                    - recovery-destroys-valid-previous
                    - web-active-put-window
                    - corrupt-active-with-good-previous
                  install-activation.test.ts: 17 tests. 13 were red before the fix; all are green now.
N02  P1   fixed   Pending batches are fenced on the persisted installed_catalogs identity (generation|status|version|sha256)
                  instead of the in-process epoch.
                  sync-stage-e.test.ts: a real install, then a kill after the catalog commit, then a cold reopen. The first
                  observation (27) wins with 0 refetches. Replacement or uninstall+reinstall between attempts discards the
                  batch.
                  One disclosed test change: the fault hook in sync-modes:328 now also bumps the persisted generation.
N03  P1   fixed   Core: Db maintenance gate, StorageStatus.maintenance {kind, language, since}. Restore enters the gate
                  before the token re-check and the safety snapshot, runs as the privileged transaction, and exits in a
                  finally block.
                  maintenance-gate.test.ts: 14 tests. Each of update, add, bulkAdd, settings and import-commit is raced at
                  5 stages and gets MAINTENANCE, and the final rows equal the archive. Sol's exact probe is included.
                  UI: a blocking overlay (role=alertdialog, #root inert); e2e restore-maintenance.spec.ts.
                  Director, live on https://127.0.0.1:3200 at 390 using the DEV hook and a 300 ms SQL delay:
                    - the overlay showed "Restoring your backup… / Don’t close FlashyDex. This takes a moment." with
                      inert=true;
                    - a racing createLocation returned MAINTENANCE;
                    - status was {writable:false, reason:'maintenance', maintenance:{kind:'restore'}};
                    - the restore finished "done 3", the overlay cleared, and neither the racing location nor the
                      post-backup location survived.
N04  P1   fixed (allocation); worker move open
                  inflateAll feeds slices of at most remainingBudget/1032 bytes (≤1 KiB).
                  backup-hardening.test.ts: with a 1 MiB cap, the largest inflate chunk was 67,108,864 B before the fix
                  and is now under 1.25 MiB.
                  Still open: ZIP/JSON work runs on the calling thread and has not moved to a worker.
N05  P1   fixed   transfer commit checks persistenceBlock() before the receipt lookup. The PRE and POST latch tests now
                  reject while latched and apply/return exactly once after recover().
N06  P2   fixed   A run with failed, pending or running sets now ends status=failed with lastError PARTIAL_FAILURE, and is
                  resumable. Tests cover all-set, mixed-set and incremental 404.
                  UI: the sync pill shows "Download failed · Resume" (a button), and the prices card appends the lastError
                  title.
N07  P2   fixed   Core: protectedRead/consistentRead retry once when a handle generation moves, then STALE_READ. This now
                  covers search, detail, set list, set detail, set cards, dashboard and copy hydration.
                  reader-protection.test.ts: 8 tests including Sol's pause-after-COUNT probe. The raw "connection is not
                  open" error no longer appears.
                  UI: the QueryClient retries once on STALE_READ/MAINTENANCE only. The raw driver message is no longer
                  shown under Details.
N08  P2   fixed   CRC32 is checked per entry (central and local headers must agree, and the inflated bytes are verified).
                  Sol's all-six-fields 0x12345678 archive, plus local-only and central-only corruption, are rejected with
                  BACKUP_INVALID.
N09  P2   fixed   playwright.config.ts starts its own http vite on 127.0.0.1:3201 with --strictPort and
                  reuseExistingServer:false, with FLASHYDEX_DEV_HTTPS stripped.
                  FLASHYDEX_E2E_BASE_URL overrides this (no webServer, ignoreHTTPSErrors). The README has a paragraph on it.
                  The unmodified root `npm run e2e` is green while :3200 HTTPS stays up.
Residue
  R11  done: the builder run binding is git HEAD plus a dirty hash; a new run never reuses another run's 24 h detail
       cache. Builder tests 27/27. The CLI and workflow were not run.
  R13  done:
         - PrivacyInfo.xcprivacy is added to the App target Resources phase in project.pbxproj (not built; no Xcode
           here);
         - web free-space preflight already used navigator.storage.estimate.
  Price gap (Grok Naming): done. Live check: the JP card on the USD tab shows "No USD price" and
       "€1.43 · Cardmarket · as of Oct 30, 2026", with no conversion and no $0.

Copy pass (Grok rows → result)
Change these
  welcome bullet "Search every…"                   applied (live: "Search English and Japanese cards once they’re downloaded")
  welcome bullet "Everything stays…"               applied (live: "…No account. Search works offline after the download.")
  Skip on step 1                                   applied per ruling. Live: /welcome has no Skip. Notice (step 2) and
                                                   later steps keep Skip.
  dashboard "about 14 MB"                          applied (number removed)
  add empty-catalog "search every card"            applied
  add empty query "card id like swsh3-136"         applied. The search placeholder "…number or id" was also fixed
                                                   (fix-e F4).
  add set filter "In"                              applied (live: "Set")
  value block "Update"                             applied (live: "Update prices")
  catalog "My cards: N cards · about N s"          applied (live: "Prices for the cards you own.")
  SERVER_ERROR / RATE_LIMITED                      applied (lib/errors.ts). HTTP_FAILED copy is unchanged.
  INSTANCE_LOCK, IMPORT_INVALID, ACTIVE_SYNC, VALIDATION_ERROR bodies   applied
  variant labels First edition / Stamped promo     applied → 1st edition / Stamp
  chip Shdwl                                       applied → SL
  language badge JA → JP                           applied per ruling, everywhere on screen. copy-e did it; fix-e F1
                                                   and the director cleared the leftovers. Data stays `ja`.
                                                   Live: chips, set header "· JP", settings "EN ✓ · JP ✓", about.
  condition chips as words                         SKIPPED (owner ruling: NM/LP/MP/HP/DMG stay)
  "Not recorded" → "Not set"                       applied (add sheet, editor, filter; fix-e: the card-details copy row
                                                   and the active-filter chip). Live: "Holo · Condition not set".
  Variant detail / Describe the print              applied ("What print is this? (required)", placeholder
                                                   "Stamp, cosmos holo, misprint")
  "…check it"                                      applied
  Paid per card / Discard this card?               applied → per copy / Discard this copy? (live: "Paid per copy")
  Total cards / known cost on N cards              applied (live: "Total copies"). Collection header is now
                                                   "1 copy · 1 unique" (fix-e F3).
  CSV row, JSON row, Import N copies, match copies applied
  Dupes                                            applied (live tab: "Duplicates")
  N extra                                          applied (live: "1 extra copy")
  single-set banner, missing-tab "every card"      applied
  TCG Pocket phrasing                              applied: settings and welcome say "Include TCG Pocket (digital)
                                                   cards"; the collection filter (a hide toggle) says "Hide TCG Pocket
                                                   (digital) cards" with logic unchanged.
  JP pictures line                                 applied ("…no pictures in the catalog yet.")
  "Catalog {version}"                              applied (live: "Downloaded · v2026.10.31.001 · about 1.8 MB on this
                                                   device")
Errors and empty states
  BAD_PAYLOAD                                      applied
  "Couldn’t save that choice. Try again."          applied (4 places)
  collection/sets load errors                      applied
  import row labels                                applied: "Can’t import" / "Check this"
  set-detail all-tab empty                         applied: "No cards in this download"
  collection no-match body                         applied
  dashboard load error, "Not available yet", Loading…   kept, as Grok advised
Naming
  catalog vs card list/database                    applied
  copies vs cards                                  applied ("Unique cards" and the tile count "Show N cards" kept)
  "Check for updates" → "Check for a newer catalog"   applied (live)
  Update prices / Refresh this set                 applied
  No USD price + euro amount                       applied by mobile-e (logic item)
  condition words on forms                         SKIPPED (owner ruling)
Legal, disclaimer and privacy strings              untouched (lib/legal.ts and the DISCLAIMER constants are not in the
                                                   diff)
Not changed, for the owner to note: the languages step still shows "Total: 128 KB · about 1 s on Wi-Fi". That figure is
a pre-existing estimate from size and an assumed speed. It was not in Grok's table and no new number was added.

Gates (director, final tree)
  npm run typecheck       exit 0
  npm run lint            0 errors, 21 warnings (pre-existing react-refresh)
  npm test                core 328/328 (26 files; was 275), mobile 30/30 (8 files; was 22), pytest 1/1
  catalog-builder         27/27, typecheck 0
  npm run build           exit 0 (PWA precache 60)
  npm run e2e             21 passed, 1 skipped (restore spec runs on mobile only). It used its own :3201 server; :3200
                          was untouched. fix-e saw one load flake (an install timeout under parallel load) on a first
                          run; my two later runs were green.
  DOM walk at 390 over https://127.0.0.1:3200:
    - no horizontal overflow on the routes walked: welcome, notice, languages, dashboard, add, collection, filters,
      sets, set detail, settings, catalog, about, card;
    - every copy change listed above is present in place;
    - the restore race was refused (N03 above).

Tooling note
  The Browser Use harness tab starts hidden (document.visibilityState='hidden'), so requestAnimationFrame never fires.
  The jeep-sqlite Stencil component then never hydrates and the app sits on "Opening your collection…". This is why Grok
  saw only that screen. It is not an app or server bug.
  Fix: cdp('Page.bringToFront') + Emulation.setFocusEmulationEnabled after navigating.
  For that diagnosis I briefly ran a second vite on :3202 and stopped it.

What remains (Mac / devices, and owner items)
  - N04: move .fdx ZIP/JSON work to a cancellable worker. Allocation is now bounded, but the work is still synchronous
    on the UI thread.
  - R04: native writable catalog path (NATIVE_CATALOG_WRITES stays false) and the Android path. Prove it per
    scripts/ios-notes.md §6 before flipping.
  - Native install boundaries: stage/activate/inspect/restorePrevious, a force-kill during activation, and a mid-write
    low-space test. The new N01 logic is proven only on the rename and web-style fakes.
  - PrivacyInfo: target membership is edited but unbuilt. Still needed: Xcode build, archive privacy report,
    SQLCipher/export-compliance classification.
  - Backup exclusion on a real device; native free-space preflight; .fdx document picker and Share; CapacitorHttp
    timeout and cancel on a device.
  - Full EN/JA pack peak RSS; PHASE1-ACCEPTANCE 63–65 device timings; VoiceOver, Dynamic Type and safe-area checks.
  - Trusted HTTPS on the LAN phone. dev:https is self-signed, so iOS trust must be accepted or use mkcert (T1).
  - Owner copy items from Grok: publisher name and contact on the privacy policy, the catalog download host, whether the
    store description may carry the affiliation sentence, and the backup sentence pending the iOS backup check.
  - Commit (parent): new tests in packages/core/test (install-activation, sync-stage-e, maintenance-gate,
    reader-protection, backup-hardening), e2e/restore-maintenance.spec.ts, lib/query-retry.ts, lib/price-gap.ts, and the
    pbxproj edit.
    docs/API.md's new section has LF endings in a CRLF file; several mobile files have mixed endings.
