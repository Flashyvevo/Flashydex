/**
 * Stage F web-storage CONTRACT (director-owned, READ-ONLY for every builder). Source: .agent/stage-f-contract.md,
 * docs/WEB-STORAGE.md. Types + constants only. A change here needs the director; builders write any proposal into their report.
 *
 *   Sonnet A  implements WebSqliteClient + ensureUserDatabase   -> apps/mobile/src/platform/web-sqlite/index.ts
 *   Sonnet B  implements RoleStore, OPFS staging, prepareStorage -> apps/mobile/src/platform/web-storage/{role-store,opfs-staging}.ts,
 *                                                                  pack-install/web-store.ts, app-database.ts (web branch)
 *   Sonnet C  implements the PWA controllers + SW               -> apps/mobile/src/platform/pwa/index.ts, pwa/sw.ts
 */
import type { SqlDriver } from '@flashydex/core';

// ───────────────────────── constants (WEB-STORAGE §2, §4, §5, §7) ─────────────────────────
export const WEB_STORAGE_PROTOCOL = 1 as const;
export const SQLITE_WASM_PACKAGE_VERSION = '3.54.1-build1' as const;
export const POOL_DIRECTORY = '/flashydex-sqlite-v1' as const;
export const POOL_VFS_NAME = 'opfs-sahpool' as const;
export const POOL_INITIAL_CAPACITY = 16 as const;
/** Ordinary OPFS staging root (OUTSIDE the pool directory). Jobs live in `/flashydex-staging/<job>/`. */
export const STAGING_ROOT = 'flashydex-staging' as const;
export const STAGED_PACK_FILE = 'pack.zst.part' as const;
export const STAGED_DB_FILE = 'catalog.db.part' as const;
/** Adapter-only IndexedDB with role mappings / intents / migration marker. Never catalog bytes, never personal rows. */
export const ROLE_DB_NAME = 'flashydex-web-storage-v1' as const;
export const LEGACY_JEEP = { dbName: 'jeepSqliteStore', storeName: 'databases', userKey: 'flashydex-userSQLite.db' } as const;
export const LEGACY_MIGRATION_MAX_BYTES = 16 * 1024 * 1024;
export const INSTANCE_LOCK = 'flashydex-user-writer' as const;
export const IMAGE_CACHE_LOCK = 'flashydex-image-cache' as const;
export const IO_CHUNK_BYTES = 256 * 1024;
export const MAX_UNACKED_CHUNKS = 4;

// ───────────────────────── pool paths (WEB-STORAGE §4 "Layout") ─────────────────────────
/**
 * Virtual sahpool path. ONLY these shapes are valid (A and B both validate; anything else -> WebStorageError('INVALID_PATH')):
 *   USER       /user/u-<id>.db        (fresh)   or /user/m-<id>.db (migrated from jeep)
 *   catalog    /catalog-<en|ja>/g-<id>.db       (catalog generation; ALSO the core-visible ref string)
 *   probe      /probe/p-<id>.db                 (A's commit/reopen probe; unlinked after use)
 * <id> = [a-z0-9-]{6,64}. Catalog refs handed to core ARE these paths (core treats refs as opaque strings).
 */
export type PoolPath = string;
export const USER_PATH_RE = /^\/user\/[um]-[a-z0-9-]{6,64}\.db$/;
export const CATALOG_PATH_RE = /^\/catalog-(en|ja)\/g-[a-z0-9-]{6,64}\.db$/;
export const PROBE_PATH_RE = /^\/probe\/p-[a-z0-9-]{6,64}\.db$/;
export type WebLanguage = 'en' | 'ja';

// ───────────────────────── errors (WEB-STORAGE §3 Messages) ─────────────────────────
export type WebStorageErrorCode =
  | 'STORAGE_UNAVAILABLE' // probe failed / API missing / insecure origin -> storage-unavailable screen, never a fallback
  | 'PROTOCOL_MISMATCH'
  | 'INIT_FAILED' // pool init failed (storage preserved: preserveOnInitFailure)
  | 'QUOTA'
  | 'CAPACITY' // sahpool slots exhausted and reserveMinimumCapacity failed
  | 'IO' // short write / flush / read failure
  | 'SQLITE'
  | 'WORKER_DIED'
  | 'STALE_SESSION'
  | 'BUSY' // path open / import in progress
  | 'NOT_FOUND'
  | 'INVALID_PATH'
  | 'INTEGRITY' // size/hash/header mismatch
  | 'CANCELLED'
  | 'MIGRATION_BLOCKED' // legacy + new USER both present w/o marker, oversized legacy, future schema, corrupt new USER
  | 'METADATA_CORRUPT'; // role-store IDB unreadable/invalid -> never reset automatically

export type CommitState = 'not_started' | 'rolled_back' | 'committed' | 'unknown';

/** Thrown by A, B and C. `message` is sanitized: no SQL text, bind values, personal rows or ids. */
export class WebStorageError extends Error {
  constructor(
    readonly code: WebStorageErrorCode,
    message: string,
    readonly details: { commitState?: CommitState; retryable?: boolean; sqliteCode?: number; cause?: unknown } = {}
  ) {
    super(message, details.cause !== undefined ? { cause: details.cause } : undefined);
    this.name = 'WebStorageError';
  }
}

// ───────────────────────── Sonnet A: worker client (WEB-STORAGE §2, §3) ─────────────────────────
export interface WebSqliteInitInfo {
  packageVersion: string; // SQLITE_WASM_PACKAGE_VERSION
  sqliteVersion: string; // sqlite3.version.libVersion, read at runtime
  vfs: typeof POOL_VFS_NAME;
  poolDirectory: typeof POOL_DIRECTORY;
  capacity: number;
  fileCount: number;
  sessionId: string;
  timings: { workerReadyMs: number; poolReadyMs: number; probeMs: number };
}

export interface WebSqliteStats {
  sessionId: string | null;
  capacity: number | null;
  fileCount: number | null;
  files: PoolPath[]; // pool virtual names (no personal data in names)
  openPaths: { path: PoolPath; refs: number; inTransaction: boolean }[];
  wasmMemoryBytes: number | null; // SQL worker WebAssembly memory.buffer.byteLength
  workerHeapUsedBytes: number | null; // null + reason where the engine does not expose it
  lastError: { code: WebStorageErrorCode; at: string } | null;
  unavailable: Record<string, string>;
}

export interface OpenDriverOptions {
  mode: 'rw' | 'ro';
  /** true only for a brand-new USER path; catalogs/candidates are never created by open. */
  create: boolean;
  role: 'user' | 'catalog' | 'validation';
  /** PRAGMA cache_size in KiB (negative pragma form). Defaults: user 2048, catalog 4096, validation 1024. */
  cacheKiB?: number;
}

/** Ordinary OPFS file under STAGING_ROOT: e.g. { job: 'k3x9…', name: 'catalog.db.part' } -> /flashydex-staging/k3x9…/catalog.db.part */
export interface StagingFileRef {
  job: string;
  name: typeof STAGED_PACK_FILE | typeof STAGED_DB_FILE | string;
}

export interface ImportFromStagingInput {
  source: StagingFileRef;
  /** Unique, not yet existing CATALOG_PATH_RE path. A pre-associates it (placeholder DB) before the chunked import. */
  target: PoolPath;
  expectedBytes: number;
  expectedSha256: string; // lowercase hex of the raw (decoded) SQLite file
  signal?: AbortSignal;
  onProgress?: (bytesImported: number) => void;
}

export interface ImportFromStagingResult {
  bytes: number;
  sha256: string;
  ms: number;
  maxChunkBytes: number; // must be <= IO_CHUNK_BYTES (tests assert it)
}

export interface WebSqliteClient {
  /**
   * Idempotent. MUST only be called after the INSTANCE_LOCK is granted (caller's job). Spawns the module worker, probes worker OPFS
   * (create/write/read/flush/close/reopen of an ordinary tiny file), installs opfs-sahpool with clearOnInit:false,
   * preserveOnInitFailure:true, reserveMinimumCapacity(16), then a SQLite commit/reopen probe. Throws STORAGE_UNAVAILABLE /
   * INIT_FAILED; never wipes, never falls back to memory.
   */
  init(): Promise<WebSqliteInitInfo>;
  /**
   * Logical SqlDriver over one physical connection per path (refcounted; one admission queue per path; transaction ownership per
   * physical connection, see WEB-STORAGE §3). rw drivers implement afterCommit as the durable barrier and reopen(); close() releases
   * this wrapper only (physical close at refcount 0). Same ProxyCallback contract as the native sqlite-proxy (positional rows).
   */
  driver(path: PoolPath, label: string, options: OpenDriverOptions): Promise<SqlDriver>;
  /** Drain the path's queue, finalize, close the physical connection, invalidate every wrapper (later calls -> STALE_SESSION). */
  closePath(path: PoolPath): Promise<void>;
  /** Streamed staged-file -> pool import (pre-associated placeholder, chunk supplier <= IO_CHUNK_BYTES, hash + byte count verified). */
  importFromStaging(input: ImportFromStagingInput): Promise<ImportFromStagingResult>;
  /** Unlink a CLOSED pool file. Throws BUSY if open. Returns false when absent. Never touches files outside the pool. */
  unlink(path: PoolPath): Promise<boolean>;
  listFiles(): Promise<PoolPath[]>;
  /** Grow slots before an import/migration. Throws CAPACITY on failure (never deletes anything to make room). */
  ensureCapacity(minFreeSlots: number): Promise<{ capacity: number; fileCount: number }>;
  stats(): Promise<WebSqliteStats>;
  /** Drain all queues, close every DB, terminate the worker. Used by update handoff / takeover. */
  shutdown(): Promise<void>;
}

// ───────────────────────── Sonnet A: USER resolution + legacy migration (WEB-STORAGE §5) ─────────────────────────
export interface UserPrepareProgress {
  phase: 'checking' | 'reading-legacy' | 'importing' | 'validating' | 'finalizing';
  bytesDone?: number;
  bytesTotal?: number;
}

export type UserDbOutcome =
  | { kind: 'existing'; path: PoolPath }
  | { kind: 'fresh'; path: PoolPath }
  | {
      kind: 'migrated';
      path: PoolPath;
      legacyBytes: number;
      counts: Record<string, number>; // per personal table, for the UI summary + tests
      ms: number;
    };

/**
 * Exported by A from web-sqlite/index.ts:
 *   ensureUserDatabase(deps: { client: WebSqliteClient; roles: RoleStore; onProgress?: (p: UserPrepareProgress) => void }): Promise<UserDbOutcome>
 * Under the already-held writer lock, after client.init(). Decision table = WEB-STORAGE §5 step 1. Throws MIGRATION_BLOCKED with a
 * sanitized reason for every "never silently reset" case. Commits UserRole + MigrationMarker through roles.commitUser in ONE call.
 */
export type EnsureUserDatabase = (deps: {
  client: WebSqliteClient;
  roles: RoleStore;
  onProgress?: (p: UserPrepareProgress) => void;
}) => Promise<UserDbOutcome>;

// ───────────────────────── Sonnet B: role store (WEB-STORAGE §4 "Layout and source of truth") ─────────────────────────
export interface CatalogCandidate {
  ref: PoolPath; // CATALOG_PATH_RE
  job: string;
  version: string;
  sha256: string;
  bytes: number;
  createdAt: string; // ISO
}

export interface LanguageRoles {
  activeRef: PoolPath | null;
  previousRef: PoolPath | null;
  candidates: CatalogCandidate[];
}

export interface UserRole {
  path: PoolPath; // USER_PATH_RE
  origin: 'fresh' | 'migrated';
  createdAt: string;
}

export interface MigrationMarker {
  version: 1;
  state: 'completed';
  source: 'jeep-indexeddb';
  userPath: PoolPath;
  at: string;
  legacyBytes: number;
  legacySha256: string;
  counts: Record<string, number>;
  /** Legacy key is retained until an explicit user cleanup after a verified external backup. */
  legacyRetained: boolean;
}

export interface ImportIntent {
  job: string;
  target: 'en' | 'ja' | 'user';
  targetRef: PoolPath;
  stagingJob: string | null;
  startedAt: string;
}

export interface RoleStateV1 {
  schema: 1;
  user: UserRole | null;
  migration: MigrationMarker | null;
  languages: Record<WebLanguage, LanguageRoles>;
  intents: ImportIntent[];
}

/**
 * Exported by B from web-storage/role-store.ts as `getRoleStore(): RoleStore` (singleton) and `createRoleStore(dbName?)` (tests).
 * Every mutation = ONE IndexedDB readwrite transaction (durability:'strict' hint where supported), resolved only on `complete`.
 * Reads always hit IndexedDB (no cached JS truth). Invalid/unknown-schema metadata -> METADATA_CORRUPT (never reset).
 */
export interface RoleStore {
  load(): Promise<RoleStateV1>;
  language(lang: WebLanguage): Promise<LanguageRoles>;
  addCandidate(lang: WebLanguage, candidate: CatalogCandidate): Promise<void>;
  /** Membership-checked + idempotent. Returns false (and changes nothing) for a ref that is not a current candidate — incl. a promoted active/previous. */
  removeCandidate(lang: WebLanguage, ref: PoolPath): Promise<boolean>;
  /** Verifies expectedActiveRef + candidate membership; previous=old active, active=candidate, candidate removed. Throws BUSY on mismatch. */
  activate(lang: WebLanguage, candidateRef: PoolPath, expectedActiveRef: PoolPath | null): Promise<{ activeRef: PoolPath; previousRef: PoolPath | null }>;
  /** active=previous, previous=null; returns the displaced former active ref (caller decides cleanup) or null when no previous. */
  restorePrevious(lang: WebLanguage, expectedActiveRef: PoolPath | null): Promise<{ activeRef: PoolPath; displacedRef: PoolPath | null } | null>;
  clearPrevious(lang: WebLanguage): Promise<PoolPath | null>;
  /** Uninstall: clears active/previous/candidates, returns every ref that was referenced (caller unlinks closed files). */
  clearLanguage(lang: WebLanguage): Promise<PoolPath[]>;
  user(): Promise<UserRole | null>;
  migration(): Promise<MigrationMarker | null>;
  /** One transaction. Refuses (BUSY) to replace an existing user role with a different path unless `replace:true`. */
  commitUser(role: UserRole, marker: MigrationMarker | null, options?: { replace?: boolean }): Promise<void>;
  putIntent(intent: ImportIntent): Promise<void>;
  clearIntent(job: string): Promise<void>;
  listIntents(): Promise<ImportIntent[]>;
}

// ───────────────────────── Sonnet B: bootstrap facade in platform/app-database.ts ─────────────────────────
export type StoragePrepareProgress = UserPrepareProgress | { phase: 'starting-worker' | 'opening-pool' };

export type StoragePrepareResult =
  | { kind: 'native' }
  | { kind: 'legacy-dev' } // DEV-only localStorage['fdx:dev-legacy-jeep']==='1': old jeep USER path for seeding migration tests; catalogs off
  | { kind: 'web'; user: UserDbOutcome; info: WebSqliteInitInfo };

/**
 * `prepareStorage(onProgress?)` exported by B from platform/app-database.ts. Called by bootstrap AFTER the writer lock is granted and
 * BEFORE createUserDriver(). Web: client.init() -> ensureUserDatabase() -> boot reconciliation of import intents/staging orphans.
 * Native: returns {kind:'native'} immediately. MEMOIZED (one run per page). createUserDriver() on web awaits this memoized
 * promise itself if bootstrap did not call it first, so the app keeps booting before shell-f wires the progress UI.
 */
export type PrepareStorage = (onProgress?: (p: StoragePrepareProgress) => void) => Promise<StoragePrepareResult>;

// ───────────────────────── Sonnet C: PWA controllers (WEB-STORAGE §2 "Quota…", §7) — exported from platform/pwa/index.ts ─────────
export type PersistState = 'granted' | 'best-effort' | 'unavailable' | 'check-failed';

export interface ProtectionSnapshot {
  persist: PersistState;
  checkedAt: string | null;
  usageBytes: number | null;
  quotaBytes: number | null;
  standalone: boolean;
  /** true once the user tapped "Protect" at least once (we never claim a prompt was shown). */
  requested: boolean;
}

export interface StorageProtectionController {
  check(): Promise<ProtectionSnapshot>; // persisted() + estimate(); never calls persist()
  request(): Promise<ProtectionSnapshot>; // user gesture only: persisted() then persist() if needed, then re-check
  getSnapshot(): ProtectionSnapshot;
  subscribe(listener: (s: ProtectionSnapshot) => void): () => void;
}

export interface InstallState {
  standalone: boolean;
  platform: 'ios' | 'android' | 'desktop' | 'other';
  /** beforeinstallprompt captured (Android/desktop Chromium). Never true on iOS. */
  canPrompt: boolean;
  dismissedAt: string | null;
  /** Derived: not standalone, not dismissed within 14 days, and (ios || canPrompt || android-menu-instructions). */
  showBanner: boolean;
}

export interface InstallController {
  /** Attach beforeinstallprompt/appinstalled listeners. Call once, as early as possible (main.tsx). */
  start(): void;
  getState(): InstallState;
  subscribe(listener: (s: InstallState) => void): () => void;
  prompt(): Promise<'accepted' | 'dismissed' | 'unavailable'>;
  dismiss(): void;
}

export interface UpdateState {
  registered: boolean;
  needRefresh: boolean;
  offlineReady: boolean;
  applying: boolean;
  error: string | null;
}

export interface UpdateController {
  /** Registers /sw.js (scope '/') via vite-plugin-pwa's `virtual:pwa-register` with registerType 'prompt'. Web production + preview only. */
  register(): void;
  getState(): UpdateState;
  subscribe(listener: (s: UpdateState) => void): () => void;
  /**
   * `prepare` is supplied by the shell: block new writes, drain jobs, confirm unsaved edits, client.shutdown(), release lock.
   * Then posts SW_MESSAGES.skipWaiting and reloads EXACTLY ONCE on controllerchange. If prepare rejects, nothing activates.
   */
  applyUpdate(prepare: () => Promise<void>): Promise<void>;
  later(): void;
}

export interface ImageCacheStats {
  enforced: boolean; // true ONLY when the SW byte ledger + reconciliation is active and answered
  limitBytes: number;
  committedBytes: number;
  reservedBytes: number;
  entries: number;
  lastError: string | null;
  reason: string | null; // why enforced=false (no SW controller, unsupported, …)
}

export interface ImageCacheController {
  stats(): Promise<ImageCacheStats>;
  clear(): Promise<ImageCacheStats>;
  /** Clamped to IMAGE_CACHE_LIMITS. Evicts immediately under the lock before ACK. */
  setLimit(bytes: number): Promise<ImageCacheStats>;
}

export const IMAGE_CACHE_LIMITS = { min: 150_000_000, default: 200_000_000, max: 250_000_000, perEntryMax: 2_000_000 } as const;
export const IMAGE_CACHE_NAME = 'flashydex-images-v1' as const;
export const IMAGE_ALLOWED_ORIGIN = 'https://assets.tcgdex.net' as const;

/** SW <-> page messages. Requests carry {type, v:1, id}; the SW replies on the supplied MessagePort with {type: SW_MESSAGES.ack, v:1, id, ok, stats?, error?}. */
export const SW_MESSAGES = {
  skipWaiting: 'SKIP_WAITING', // the vite-plugin-pwa / workbox-window convention, also accepted as 'fdx:sw:skip-waiting'
  imageStats: 'fdx:image-cache:stats',
  imageClear: 'fdx:image-cache:clear',
  imageSetLimit: 'fdx:image-cache:set-limit',
  ack: 'fdx:ack'
} as const;
