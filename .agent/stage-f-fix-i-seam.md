# Stage F fix-i seam (written by sonnet-fix-i-core-sqlite; both compile, typecheck 0 errors)

## 1. Client: closePath drain  (apps/mobile/src/platform/web-sqlite/client.ts, re-exported from web-sqlite/index.ts)

    export interface ClosePathOptions {
      drain?: boolean;      // wait for the current owner's open transaction (COMMIT/ROLLBACK + its durable barrier) and an empty queue BEFORE `closing`
      timeoutMs?: number;   // optional extra: give up draining -> drain cancelled, throws WebStorageError('BUSY', retryable)
    }
    interface WebSqliteClientInternal { closePath(path: PoolPath, options?: ClosePathOptions): Promise<void>; }
    import { type ClosePathOptions } from '../web-sqlite';   // or '../web-sqlite/client'

- Use it through `WebSqliteClientInternal` (the contract.ts `WebSqliteClient` interface still declares `closePath(path)` only; contract.ts is read-only, so
  cast / use `getWebSqliteClient()` which returns the Internal type).
- While draining: only the current owner wrapper's statements are admitted; every other new statement is rejected `STALE_SESSION` (commitState 'not_started');
  `driver(path)` for that path throws BUSY. Without `drain` behaviour is unchanged.

## 2. COMMIT-unknown  (core: packages/core/src/db/sql.ts, exported from @flashydex/core)

    export function isUnknownCommit(error: unknown): boolean;   // error.commitState === 'unknown' || error.details?.commitState === 'unknown'

- `Db.runTransaction`: a COMMIT rejection satisfying `isUnknownCommit` => NO ROLLBACK, `persistenceFailed` latched, `PersistenceError` thrown (same as a failing afterCommit).
- Web driver (client.ts): any COMMIT/END rejection on an rw wrapper that is not a clean reply from a live worker (`rolled_back`/`not_started` with a non-IO/QUOTA/WORKER_DIED code)
  is re-thrown as `WebStorageError` with `details.commitState === 'unknown'` AND an own enumerable `commitState: 'unknown'` property, the physical connection latches
  (all rw wrappers present + future refuse writes until `reopen()`), queued non-control admissions are rejected.
- `catalog-install.ts` is unchanged: a PersistenceError from the receipt transaction already skips undoSwap/restorePrevious.

## 3. New migration block reason
`MigrationBlockedReason` gained `conflicting_stores` (role/marker/legacy disagree). `components/storage-screens.tsx` REASON_COPY should map it (same wording as orphan_user_data is fine).

## 4. New client options (optional)
`requestTimeoutMs`, `livenessIntervalMs`, `livenessTimeoutMs` on `createWebSqliteClient`; new worker op `ping`.
