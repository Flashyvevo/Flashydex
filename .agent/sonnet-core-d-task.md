Project root: C:/Projects/flashydex (cd there first). Product name FlashyDex / package `flashydex`.

# Role: sonnet-core-d — Claude Sonnet builder, Stage D (close GPT Sol's review findings, core side)

You are one of two builders running IN PARALLEL. The other (`sonnet-mobile-d`) owns `apps/mobile/**`. You never edit
apps/mobile; it never edits your files. The binding interface between you is `.agent/stage-d-contract.md` — read it FIRST
and implement its core side exactly.

## Read (in order)
1. `.agent/stage-d-contract.md` (binding; director decisions D40–D46).
2. `.agent/reports/sol-review.md` — sections 2 (evidence E1–E8) and 3 (findings). Your items are quoted below.
3. `docs/API.md` (SyncService, CatalogInstallService, Platform adapter, TransferService/BackupService, Director notes),
   `docs/IMPORT-EXPORT.md` (".fdx backup v1" section + "Required fixtures"), `docs/CATALOG-PACKS.md` (Manifest semantics,
   Device installer state machine, Languages/refresh consistency, Director notes), `docs/DATA-MODEL.md` (sync checkpoint v3,
   user tables), `docs/ARCHITECTURE.md` (retry/fencing/two-commit replay rules), `.agent/research/device-storage.md`.
4. Current code: `packages/core/src/**`, `packages/schemas/src/**`, `packages/core/test/**`, `tools/catalog-builder/**`,
   `.github/workflows/catalog-packs.yml`.

## Your files (ownership)
`packages/core/**`, `packages/schemas/**`, `tools/catalog-builder/**`, `.github/workflows/catalog-packs.yml`,
`docs/API.md` (ONLY by appending a `## Director notes — Stage D (2026-10-31)` section for contract deviations/additions).
Nothing else. Do not touch apps/mobile even if its typecheck breaks because of your changes — that is expected and the
mobile child is coding against the contract.

## FIRST MILESTONE (within your first ~25 minutes) — unblock the mobile child
Land the PUBLIC TYPE SURFACE of the contract as compiling code (stubs that throw are fine at this point):
CatalogInstallPort v2 + PackStageResult + PackDiskState + CatalogSource.writable, `Services.storage`
(StorageStatus/status/subscribe/recover), `createServices` options `catalog` and `userWriteBlock`, SqlDriver.reopen?,
error codes INSTANCE_LOCK / PAYLOAD_TOO_LARGE / MANIFEST_SIGNATURE_INVALID / BACKUP_* , SyncCapabilities with
`incremental`, `packages/schemas/src/backup.ts` (all .fdx schemas/DTOs exported from the package index), and a
`BackupService` class with the API.md signatures. Run `npm run typecheck --workspace=@flashydex/core && npm run typecheck --workspace=@flashydex/schemas`
until clean, then create the marker file `.agent/stage-d-core-types-ready` containing a one-paragraph list of the exported
names. The mobile child waits for that marker before typechecking. After the marker, only ADD to the surface; if you
must change a name, update the marker file and docs/API.md Director notes.

## Owner rulings (binding, do not re-debate)
- R07 and R08 are IN SCOPE: implement `refresh` + `incremental` sync modes per API.md and `.fdx` create/preview/restore per
  IMPORT-EXPORT.md + API.md as a ZIP container (D41 fflate). Restore must work after reinstall + fresh catalog (and with NO
  catalog, and with a newer catalog): exact `(language,tcgdex_id)` identity, snapshot fallback, no re-ID, no custom conversion.
  Activation per D40 (in-place single transaction) — write that decision into the API.md Director notes section.
- R06: durable prepared-journal in the USER DB BEFORE any rename (write job journal {phase:'prepared', language, oldReceipt,
  candidateRef, targetSha256, targetVersion} and COMMIT it, then port.activate, then commit receipt phase). Boot recovery
  reconciles from disk (`port.inspect`) + journal: prepared-but-not-committed with active==candidate → restorePrevious (or
  remove when first install) and keep the old receipt; previous on disk with installed receipt and no active → restorePrevious;
  committed journal with previous still present → discardPrevious; stray candidates → discardCandidate; validate active via
  `openForValidation` + catalog_meta version/sha-consistency against the receipt (NOT a full-file rehash every boot). `hasPrevious`
  comes from disk, not memory. Tests for EVERY boundary: crash before journal, after journal before activate, after activate
  before receipt commit, after receipt commit before discardPrevious, during rollback, first install vs update, disk-full
  (activate throws STORAGE_FULL). Use a fake port with injected fault hooks that simulates a "kill" by throwing and then
  constructing a NEW service over the same SQLite file + same fake disk state and running recover().
- R09: central semantic validator (contract §2), streaming-bounded manifest read is the adapter's job but core must reject
  text over 256 KiB too, candidate DB schema fingerprint + `PRAGMA integrity_check` + `foreign_key_check` + object allowlist
  (contract §1). Also the same checks when validating ACTIVE in recovery (cheap subset allowed: meta + fingerprint).
- R10: ONE admission coordinator (D45) for install/uninstall/rollback/sync start+resume/restore with a durable admission
  row (single row lock key, e.g. a `work_admission` table or one shared `lock_key` value across both job tables — a
  migration is fine), per-language maintenance barrier (readers get MAINTENANCE or wait; `DatabaseSet.catalog()` must not
  reopen a language while its barrier is held), generation fencing (sync captures generation per language at batch start
  and checks it inside the write transaction → abort batch on mismatch), multi-domain reads capture userRevision+generation
  and retry once then STALE_READ. Tests: install-then-sync and sync-then-install start races (both orders, via
  concurrently started promises), read/activation race.
- R02: fail-closed latch (D43). After afterCommit failure: latch, retire handles, reject every write with PERSISTENCE_FAILED
  until `storage.recover()` → `driver.reopen()` → refetch-safe. No silent double-apply on retry: transfer commit is
  receipt-first already — prove with a test that commit → flush fault → recover (reopen returns the PRE-commit state in one
  test and the POST-commit state in another) → retry yields exactly one application. Bulk add after recover: the UI refetches
  so the user sees truth; core must not replay automatically.
- R11: builder frozen runs + immutable artifacts + workflow read-back (see Sol's R11 text). Do the cheap parts fully:
  bind run metadata to selection/schema/toolchain (resume refuses a mismatched run), compare existing artifact hash before
  replacing (same version + different bytes → nonzero exit), make verify-pack exit nonzero on any false check, workflow
  downloads draft assets and re-hashes before publish. Revalidation of cached shells: do it if cheap, else list it.
- R12 (core part, cheap): batch the whole-group ID lookup (collection-list.ts:171–174) into one chunked query; perf test
  to 10 warmups / 100 samples / p50/p95/max with 10,000 copies (keep runtime of the whole core suite reasonable; mark the
  heavy perf file so `npm test` still finishes < ~3 min).
- R13 (core part, cheap): add the optional image-cache seam to core `Platform` (`imageCache?: {get,put,clear}` per API.md
  Phase-1 seam) — interface only.

## Tests
vitest, real SQLite (packages/core/src/testing/node-driver.ts), kill-between-commits simulations via injected fault
hooks. Required new test files (names may vary): install-recovery (R06 every boundary), manifest-validation (R09 incl.
signature present → rejected, downgrade, same-version-different-hash, calendar-invalid version, cross-field counts,
untrusted redirect origin, 256 KiB cap) + candidate-validation (trigger present, view present, extra table, FK violation,
integrity failure, schema drift → PACK_INVALID), coordinator (both race orders + read/activation race + uninstall during
sync), persistence-latch (R02), sync-refresh + sync-incremental + exact pending-batch replay across a kill between the
CATALOG and USER commits with a CHANGED upstream response on the refetch (first observation must win), backup
(.fdx create → wipe → fresh migrate → restore → canonical owned-row dump identical; with no catalog; with a newer catalog;
zip-bomb/oversize/duplicate entry/`..` path/unknown version/hash mismatch/count mismatch rejected; ALREADY_RESTORED on
repeat; failure mid-restore leaves old state; safety backup verifies). Builder tests for R11.

## Don't
- No screenshots, no image viewing (capture_screenshot / vision crash Anthropic sessions with HTTP 400 and kill the run).
  You should not need a browser at all; if you do, use browser session `session="core-d"` and DOM/JS checks only.
- No `git commit`/`push`. Do not start/kill the dev server on :3200 (owner-owned). No `next build`/`vite build` needed.
- Do not edit BRIEF.md, SPEC.md or docs/* except the API.md Director-notes append.
- Do not change existing public method signatures except as the contract says.
- Do not fake data, do not weaken existing tests to pass.

## Verify before reporting
`npm run typecheck --workspace=@flashydex/core && npm run typecheck --workspace=@flashydex/schemas`,
`npm test --workspace=@flashydex/core`, catalog-builder `npm test` + typecheck in tools/catalog-builder, and root
`npm run lint` if it covers your files. Root `npm run typecheck` may fail ONLY inside apps/mobile while the mobile child is
mid-work — say so in the report with the exact errors; your own packages must be clean.

## Report
Write `.agent/reports/sonnet-core-d-report.md`: per R-item (R02, R06, R07, R08, R09, R10, R11, R12-core, R13-core) →
done/partly/not, files changed, test names proving it, and "Contract deviations" (or "none"). Paste gate output excerpts.
Keep it under ~250 lines.

## Sol's findings you own (verbatim from .agent/reports/sol-review.md)

R02 — P1 — persistence failure reports an error but permits unsafe retry.
Files: packages/core/src/db/sql.ts:152–157; apps/mobile/src/data/collection-hooks.ts:38–50; apps/mobile/src/lib/errors.ts:39–40.
Why: COMMIT has already occurred before afterCommit fails. The code throws PersistenceError but neither blocks writes nor reopens persisted state. The UI claims FlashyDex reloaded data although no such recovery occurs. E3's manual retry doubles ownership from two to four; retry:false prevents automatic retries only.
Fix: latch a fail-closed persistence/maintenance state, retire in-memory handles, recover/reopen and refetch before reenabling mutations. Reconcile import receipts; do not replay ordinary bulk adds without an idempotency/recovery decision. Inject real IndexedDB quota/save faults as well as adapter failures.

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


(R03 is closed by the owner: apps/mobile/src/lib/uuid.ts.)
