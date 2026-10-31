# sonnet-core-d report (Stage D, core side)

Gates (real output): core `npm test`: 21 files; the last FULL run had 2 failures in test/user-db.test.ts (table lists lacked the two new tables); fixed, user-db.test.ts re-run alone 8/8 passed; perf.test.ts alone 6/6 (~50 s). I did NOT re-run the whole core suite once more after those last two edits. core + schemas typecheck clean; tools/catalog-builder 24/24 tests + typecheck clean; root `npm run typecheck` printed no TS errors at the time (mobile child may still be mid-work); root lint 0 errors / 21 warnings.

| Item | Status | Files | Proving tests |
|---|---|---|---|
| R02 latch | done | db/sql.ts, services/storage.ts, testing/node-driver.ts | test/persistence-latch.test.ts (7: latch, recover POST + PRE, transfer commit exactly-once in both states, INSTANCE_LOCK, no-reopen driver) |
| R06 journal/recovery | done | services/catalog-install.ts, testing/fake-install-port.ts | test/install-recovery.test.ts (18: every boundary for update + first install, rollback x2, disk-full x3, previous-without-active, meta/sha mismatch, persistence failure pre/post); install-settings.test.ts migrated to port v2 (13) |
| R07 refresh+incremental+replay | done | services/sync.ts | test/sync-modes.test.ts (refresh x5, incremental x3, kill between CATALOG/USER with CHANGED upstream for prices_only+refresh, kill before pending, kill after pending); sync.test.ts old UNSUPPORTED test replaced by a capability test |
| R08 .fdx | done (delegated; .agent/reports/sonnet-core-d-r08.md) | backup/**, schemas/backup.ts | test/backup.test.ts (33). Core stores no user image bytes: includeUserImages returns a warning + empty index |
| R09 | done | services/manifest-validation.ts, candidate-validation.ts, db/catalog-fingerprint.generated.ts, scripts/embed-fingerprint.mjs | test/manifest-validation.test.ts (10), test/candidate-validation.test.ts (10) |
| R10 | done | db/coordinator.ts, db/database-set.ts, migrations/user/0002_admission_restore.sql, sync.ts, collection-list.ts | test/coordinator.test.ts (6) + sync-modes.test.ts R10 block (both start-race orders, uninstall/rollback during sync, epoch fencing x2, read/activation race, MAINTENANCE, consistentRead) |
| R11 | done (delegated; .agent/reports/sonnet-core-d-r11.md) | tools/catalog-builder, workflow | run-guard.test.ts. Not done: card-detail revalidation on new runs; workflow does not call verify-pack; read-back compares to the local build |
| R12-core | done (Node-only numbers) | collection-list.ts, test/perf.test.ts | 10 warm-ups / 100 samples / p50-p95-max, 10,000 copies, one whole-group query per page asserted; FLASHYDEX_SKIP_PERF=1 skips the file (~50 s) |
| R13-core | done (interface only) | platform/platform.ts | typecheck |

Not updated: migrations/user/meta (_journal.json, snapshot) for 0002 (SQL is hand-written, drizzle declarations are in user-schema.ts); regenerate with drizzle-kit if you rely on db:generate.

## Contract deviations
- BackupError code SIZE_LIMIT is used for archive cap breaches (contract section 4); a platform file-too-large stays PAYLOAD_TOO_LARGE.
- `CatalogInstallService.recover()` returns an extra `actions` array; `install()` no longer invalidates readers before download (only inside the activation barrier).
- With `userWriteBlock` set, `createServices` skips boot recovery (it needs writes).
- Native `catalogWrites` is the adapter's call; core only reads `CatalogSource.writable`.
- Backup service lives in backup/backup-service.ts (backup/service.ts re-exports it).
