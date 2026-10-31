# sonnet-core-e report — Stage E, core side (Claude Sonnet)

Verified (actual output, all exit 0): `npm run typecheck --workspace=@flashydex/core`, `... schemas`, `... catalog-builder`, root `npm run typecheck` (core + schemas + mobile), `npm run test --workspace=@flashydex/core` (26 files / 328 tests, was 275), `npm test --workspace=@flashydex/catalog-builder` (3 files / 27 tests, was 24).
No git commit/push, no screenshots, no dev server. Edit outside my tree: exactly one line, `apps/mobile/src/data/context.ts:27` (`maintenance: null` in NOT_READY).

Method: for every item the test was written first and run red against the unfixed code; the failing assertion is quoted. (N03: Db plumbing was added before the restore wiring, so the restore tests were red at the time they were run.)

## Per item

N01 (P1) — test/install-activation.test.ts (17 tests: every case runs on the rename store AND the new web key-write store; plus web-window, torn write, first install, refreshed catalog, rollback)
- red: `:73 AssertionError: promise resolved "{ language: 'en', …(6) }" instead of rejecting` (active-not-revalidated: install returned installed); `:106 expected [ 'en:discarded-previous', …(1) ] to not include 'en:discarded-previous'` (recovery-destroys-valid-previous); `:122 expected { status: 'failed', …(2) } to match object { status: 'installed', … }` (corrupt-active-with-good-previous); `:139 expected false to be true` (previous deleted when both invalid); web window `:177 expected [ 'en:restored-previous', …(2) ] to not include 'en:discarded-previous'`. 13 of 17 failed.
- fix: services/catalog-install.ts — `fileIsValid()` (cheap check, never throws); activated file validated before receipt commit (:312–316) else `undoSwap` + `PACK_INVALID`; `undoSwap` rewritten to decide by content identity (keep an active that is still the old catalog, else restore a VALIDATED previous, else touch nothing; first install removes an active that is the uncommitted target even when a candidate key remains); `recoverLanguage` step 2 validates active before `discardPrevious`, otherwise restores a validated previous with ITS receipt from the committed journal (`restored-previous-invalid-active`), else leaves the previous and lets step 4 mark `failed`; `rollback()` refuses a damaged previous (`NO_ROLLBACK`). testing/fake-install-port.ts: `style:'web'` + `activate:put` hook (copy-style previous/active, candidate removed last).
- green: 17/17; install-recovery 18/18 and install-settings 13/13 unchanged and green.

N02 (P1) — test/sync-stage-e.test.ts (3 tests; real CatalogInstallService install, kill via `faultAfterCatalogCommit`, `h.t.reopen()` = new services on the same files)
- red: `:69 expected true to be false` (BATCH_DISCARDED after cold reopen: oldEpoch>0, new epoch 0) and `:85 expected false to be true` (replacement between attempts NOT discarded because the new process reuses the same small epoch value).
- fix: services/sync.ts — `PendingBatch.identity` + `Checkpoint.catalogIdentities` = persisted `installed_catalogs` `generation|status|version|sha256`; replay iff identity matches (epoch re-adopted for the write fence); `persist()` re-checks the identity inside the transaction for fenced commits, including the pending-batch commit. Legacy batches without identity are discarded.
- green: first observation (27) wins after cold reopen with 0 refetches; replacement and uninstall+reinstall discard the batch (refetched 999).
- test change (disclosed): test/sync-modes.test.ts:328 "fencing inside the catalog write" only bumped the in-process epoch; a real replacement also moves the persisted receipt generation, so the fault hook now also does `UPDATE installed_catalogs SET generation = generation + 1`. Assertions unchanged.

N03 (P1, core half) — test/maintenance-gate.test.ts (14 tests): update/add/bulkAdd/settings/import-commit raced at each of 5 stages (afterGate, duringSafety, afterSafety, afterDelete, afterInsert) all → MAINTENANCE and final rows = archive values; Sol's exact probe; stale/failed restore reopens the gate; throwing hook; token re-check under the gate; Db-level "already queued behind in-flight work" case; second gate refused; status/subscribe for restore and for catalog_activation (personal write during the barrier is accepted); stable status object.
- red: `AssertionError: expected [ [ 'update', 'ACCEPTED' ], …(4) ] to deeply equal [ [ 'update', 'MAINTENANCE' ], …(4) ]` (afterDelete/afterInsert), Sol probe `expected 'ACCEPTED' to be 'MAINTENANCE'`, `expected undefined to match object { writable: false, … }` (no maintenance status).
- fix: db/sql.ts — `StorageStatus.maintenance`, `MaintenanceInfo`, `MaintenanceGate`, `enterRestoreGate()` (drains, privileged `transaction`, `exit()` drains again then reopens), `beginCatalogActivation()`, privilege-aware `writeBlockError`/`runTransaction`, cached status object, `persistenceBlock()`. backup/backup-service.ts — gate entered before the token re-check and safety snapshot, new `RestoreStage`s, privileged transaction, exit in `finally`. db/database-set.ts + coordinator.ts — `withBarrier(..., {announce})`, announced only for install/rollback/uninstall leases.
- green: 14/14, repeated 3× for timing stability.

N04 (P1) — test/backup-hardening.test.ts (4 tests)
- red: `AssertionError: expected 67108864 to be less than 1310720` (Sol's exact number; 64 MiB zeros, 1 MiB cap) and `expected 8388608 to be less than 67584` (64 KiB cap).
- fix: backup/archive.ts `inflateAll` — slice = clamp(floor(remainingBudget / 1032), 1, 1024), budget 0 (1-byte slices) between entries, budget = min(entry cap, expandedBytes − expanded) while inflating.
- green: largest inflate callback chunk < 1.25 MiB for the 1 MiB-cap probe and with the default 128 MiB cap, < cap + 2 KiB for a 64 KiB cap; legitimate archives (incl. 60 rich copies) parse unchanged. Not done: moving ZIP/JSON to a worker (mobile's call) and yielding between slices (a cheap `setTimeout` yield would slow every parse; skipped).

N05 (P1) — test/persistence-latch.test.ts:91 and :120 (the two tests that endorsed success-before-recovery were changed as the task asked: POST and PRE now reject `PERSISTENCE_FAILED` before recovery; POST returns the receipt / PRE applies exactly once afterwards).
- red: `AssertionError: promise resolved "{ …(8) }" instead of rejecting` (replay returned createdCopies while latched).
- fix: transfer/service.ts `commit` step 0 `user.persistenceBlock()` before the receipt lookup.
- green: 7/7; transfer 17/17 unchanged.

N06 (P2) — test/sync-stage-e.test.ts (3 tests: all-set failure, mixed-set failure, incremental discovered set 404; each asserts status, lastError, resume)
- red: `expected { …(20) } to match object { status: 'failed', … }` (`status: 'completed'`, `lastError: null`), `expected 'completed' to be 'failed'` ×2.
- fix: services/sync.ts run end: failed sets (`failed|pending|running`) and failed cards → `failed`, `lastError {code:'PARTIAL_FAILURE', message}` (e.g. "1 set could not be fetched. Try again to resume."). Code kept as PARTIAL_FAILURE (no new code).
- green: resume completes once upstream serves the set.

N07 (P2, core half) — test/reader-protection.test.ts (8 tests): search paused after COUNT (Sol's probe), search activation before first statement, card detail, set cards, set list + set detail, dashboard, copy hydration + collection list, double activation → typed STALE_READ.
- red: `expected 'null:The database connection is not o…' to be 'ok'` ×5, plus `expected false to be true` ×3 (raw driver error, code null).
- fix: db/database-set.ts `protectedRead(languages, fn)` (retry once when a handle generation moved, then STALE_READ) and `consistentRead` extended the same way; applied in services/catalog.ts (5 public reads), portfolio.ts (dashboard), owned-read.ts (hydrateOwned).
- green: 8/8; all results are correct answers from the NEW catalog (retry), none needed the typed fallback except the deliberate double activation (STALE_READ).

N08 (P2) — test/backup-hardening.test.ts (4 tests incl. crc32 check value 0xCBF43926)
- red: `expected 'NO_ERROR' to be 'BACKUP_INVALID'` ×3 (Sol's all-six-CRC-fields 0x12345678, local-only, central-only).
- fix: archive.ts — `crc32`, central entries keep crc/compressedSize/localOffset, `verifyLocalHeaders` (signature, name, method, CRC + compressed size unless a data descriptor follows) before inflating, CRC of every inflated entry afterwards. Code is `BACKUP_INVALID` (no new code).
- green: 4/4; backup.test.ts 34/34 unchanged.

## Residue
- R06 → N01, R07 → N02, R10 → N07: covered above.
- R11 (done, tools/catalog-builder, run-guard.test.ts:101–): `RunBinding.builderGit` = `git rev-parse HEAD` + `+dirty-<hash of builder-relevant diff>` (paths: tools/catalog-builder, packages/core/src/{catalog,db}, packages/schemas/src; `gitContentIdentity` injectable, `nogit` fallback), used for resume binding and `catalog_meta` builder version; `Fetcher({runId})` reuses a cache entry only if the same run wrote it (resume), so card details first seen in a new run never come from the 24 h cache. Red: `gitContentIdentity is not a function`, `expected 1 to be 2` (new run reused the cache). Green 27/27. `--max-cache-age-hours` now only bounds same-run reuse. Not run: the real CLI/crawl or the CI workflow.

## Test counts (actual output, core)
backup 34, backup-hardening 8 (new), candidate-validation 10, catalog-repo 18, catalog-schema 11, collection-crud 20, collection-list 13, coordinator 7, import-invalid-rows 5, install-activation 17 (new), install-recovery 18, install-settings 13, maintenance-gate 14 (new), manifest-validation 10, perf 6, persistence-latch 7, portfolio 10, reader-protection 8 (new), snapshot-validation 1, sqlite-proxy 1, sync 10, sync-modes 20, sync-stage-e 6 (new), tcgdex-map 36, transfer 17, user-db 8 → verbose listing sums to 328 across 26 files per the summary line (the listing showed 25 file names; one file did not print in my grep). catalog-builder: builder, http, run-guard (10 + 3 new) = 27.

## Contract deviations / notes for sonnet-mobile-e
- E1: restore reports `writable:false, reason:'maintenance', maintenance:{kind:'restore',…}`; `catalog_activation` keeps `writable:true, reason:'ok'` — so mobile's `useStorageStatus` cache (apps/mobile/src/data/context.ts ~:34, compares writable/reason/message only) will NOT update for a catalog_activation-only change. Mobile must compare `maintenance` (kind/language/since) too; I did not touch that file beyond NOT_READY.
- New restore hook stages exist only as test seams (`afterGate`, `duringSafety`, `afterSafety`); nothing in apps/mobile uses `duringRestore`.
- E1 limitation (documented in API.md): multi-step operations (read, then write) are refused only at their transaction step; a write requested after the gate reopened is an ordinary post-restore write.
- `PersistenceError` message wording for replay differs slightly from the write-block message; code is the same.
- docs/API.md section was appended with LF endings in a CRLF file (git may show mixed endings).
- Not verified: mobile web-store/native-store against the new `undoSwap` (they were not changed; web-store's previous-copy-first order matches the new fake `style:'web'`), no e2e/browser run.
