# Sonnet A (sonnet-web-sqlite) — Stage F report

Ready marker `.agent/stage-f-A-ready` was touched after the real-browser smoke passed (before the fault tests).

## What changed (my files only)
`apps/mobile/src/platform/web-sqlite/`: `protocol.ts`, `executor.ts`, `worker-core.ts`, `sql.worker.ts`, `client.ts`, `index.ts`, `legacy-migration.ts`, `harness.ts`, `testing/{sqlite-node,memory-env,legacy-seed}.ts`, tests `executor.test.ts`, `client.test.ts`, `legacy-migration.test.ts`.
`apps/mobile/e2e/web-sqlite.spec.ts`. This report. No core, contract.ts, vite config or other builders' files touched.

## Proven (commands and results)
- `npx vitest run src/platform/web-sqlite`: 3 files, 69 tests passed (22 executor + 28 client/protocol + 19 migration). Run twice in the session; the last combined gate run timed out under machine load, so I did NOT get a final re-run alongside the full mobile and core suites.
- `npx eslint src/platform/web-sqlite e2e/web-sqlite.spec.ts`: 0 problems.
- `tsc -p tsconfig.app.json`: 0 errors in web-sqlite files. The root typecheck still fails on files that are not mine: `components/storage-protection.tsx` (PROTECT_RESULT_COPY) and `pack-install/web-store.test.ts:297`.
- Playwright (`FLASHYDEX_E2E_BASE_URL=https://127.0.0.1:3200 --project=mobile`): 15 tests passed in two runs (3 W01, 7 streamed import/init-failure, 5 migration). Run 1 passed 3, run 2 passed 7 of the 7 selected (import and init-failure groups), run 3 passed 5 (jeep group). I did not run all 15 in one invocation.
- NOT run: root `npm run typecheck` clean, full `npm test --workspace=@flashydex/mobile`, `npm test --workspace=@flashydex/core` (>=367). These gates are still open.

## Measured numbers (Chromium, dev server)
| metric | value |
|---|---|
| worker ready | 420 ms |
| pool ready (VFS + reserve) | 229 ms |
| probes (OPFS + SQLite commit/reopen) | 133 ms |
| SQLite lib version | 3.54.1 (package 3.54.1-build1) |
| pool capacity at first init | 16 |
| SQLite WASM memory | 8,388,608 B (8 MiB) |
| worker JS heap | null: performance.memory not exposed in this worker (reason reported in stats.unavailable) |
| 20 MB import, throttled 2 ms/chunk, 41 interleaved USER commits | 11.9 MB/s |
| 20 MB import, unthrottled | 33.6 MB/s (605 ms) |
| max chunk | <= 262144 B |
| max ArrayBuffer crossing postMessage during catalog import | 0 (instrumentation sanity-checked at the migration: >= legacy size) |
| migration of a 598 KB seeded USER | 174 ms |

## Acceptance evidence
| id | evidence |
|---|---|
| W01 | init info e2e (version, vfs, dir, capacity >= 16, crossOriginIsolated=false, no SAB requirement); commit -> reload -> reopen keeps data (clearOnInit:false); probe files unlinked; injected init failure (`before-vfs` and `after-vfs`) with existing USER -> INIT_FAILED, then clean re-init sees the USER and its row; no removeVfs/wipeFiles/memory fallback in code. |
| W02 | executor parity with every sqlite-proxy.test.ts case over real SQLite; duplicate names/aliases, null/0/''/BLOB, RETURNING all/get/run (get drains DML), trailing-statement rejection via prepare tail, constraint mapping with no bound values in messages; two wrappers on one connection (reader waits for COMMIT, ROLLBACK, owner close mid-tx, refcount, close of one wrapper keeps the writer); stale session, protocol mismatch, WORKER_DIED/unknown + latch + reopen without replay. |
| W06 (my part) | per-path pre-associated placeholder + `importDb(asyncSupplier)`; USER writes interleaved during a 20 MB import: USER integrity ok and row count exact, candidate integrity ok and exported sha equals staged sha; short write -> INTEGRITY, quota -> QUOTA, io -> IO, nothing else touched; kill mid-import -> target absent after next init, USER intact; ensureCapacity grows persistently. |
| W09 (storage side) | a second page in the same profile cannot init the pool while the first holds it (INIT_FAILED), and succeeds after the first shuts down. The lock-before-VFS ordering itself is B/shell's. |
| W10 | seeded jeepSqliteStore key with multilingual/null/0/leading-zero rows -> migrated: counts equal, every personal table byte-equal, installed_catalogs reset to absent, open jobs/sync -> interrupted, work_admission cleared, collection_revision untouched, integrity_check ok, foreign_key_check empty; legacy and catalog keys unchanged (sha snapshot); rerun after reload -> existing; crash before commitUser -> orphan m-* unlinked and redone with a new path; oversized and corrupt legacy -> MIGRATION_BLOCKED; no jeep DB created by the probe. |

## Contract change requests
1. `WebSqliteClient` has no way to feed the one-time USER bytes into the pool. I added `importBytes(target, bytes, sha256)` on `WebSqliteClientInternal` (extends WebSqliteClient, returned by `getWebSqliteClient()`); `ensureUserDatabase` fails with `client_cannot_import` on a client without it. Please add it to contract.ts or confirm it stays adapter-internal.
2. `MigrationBlockedError` (subclass of WebStorageError) carries a stable `reason`: legacy_too_large, legacy_unreadable, legacy_corrupt, legacy_unsupported_schema, legacy_integrity_failed, user_unreadable, user_missing, future_schema, orphan_user_data, validation_failed, client_cannot_import. Worth listing in the contract for the shell's recovery screen.
3. The decision table row "role without marker + legacy key present" returns `existing` (as specified) without reading legacy; WEB-STORAGE §5 says "both differ -> block". I followed the director's table.

## Open risks
- Worker death detection relies on the `error` event and on explicit termination; a silent OOM kill may not fire an event, so pending promises would hang. A heartbeat is not implemented.
- `durableBarrier` is an ordering/liveness check: durability itself comes from synchronous=FULL + journal_mode=DELETE (xSync = SAH.flush) completing before COMMIT returns. I cannot observe the flush from JS.
- Reading the legacy IDB value materialises it before the 16 MiB check (structured clone); a much larger legacy value is held briefly in memory.
- A killed import can leave the pre-associated placeholder: in the real browser run it was absent after next init, but B's reconcile must still unlink a surviving target by intent.
- Safari/Firefox and physical-device runs were not done; Chromium only.
- Core `Db` latches on afterCommit failure; my driver also latches rw wrappers (WORKER_DIED/IO) and clears on `reopen()`. Read-only wrappers auto-reopen after a worker restart (no data written through them).
- Messages mark `fdx:web-commit` uses performance.measure per durable commit; no dev logging added.
