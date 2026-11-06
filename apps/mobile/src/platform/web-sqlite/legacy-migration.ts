/**
 * USER database resolution + the one-time jeep -> OPFS migration (WEB-STORAGE §5).
 *
 * The ONLY code that touches the legacy `jeepSqliteStore`/`databases` IndexedDB, and only the single key
 * `flashydex-userSQLite.db`, read-only through raw IndexedDB (no jeep, no localforage, never a catalog key, never a write/delete).
 *
 * Crash safety: nothing becomes authoritative until ONE `roles.commitUser(...)` call. Before it, the legacy key stays the source;
 * a staged `/user/m-*` file is an orphan the next boot unlinks. After it, the new USER is used and the legacy bytes are never replayed.
 */
import { USER_MIGRATIONS, migrationChecksum } from '@flashydex/core';
import {
  LEGACY_JEEP, LEGACY_MIGRATION_MAX_BYTES, USER_PATH_RE, WebStorageError,
  type EnsureUserDatabase, type MigrationMarker, type PoolPath, type RoleStore, type UserPrepareProgress, type UserRole, type WebSqliteClient
} from '../web-storage/contract';
import type { WebSqliteClientInternal } from './client';

/** Thrown for every "never silently reset" case. `reason` is a stable, sanitized token (no ids, no data). */
export type MigrationBlockedReason =
  | 'legacy_too_large'
  | 'legacy_unreadable'
  | 'legacy_corrupt'
  | 'legacy_unsupported_schema'
  | 'legacy_integrity_failed'
  | 'user_unreadable'
  | 'user_missing'
  | 'future_schema'
  | 'orphan_user_data'
  | 'conflicting_stores' // role / marker / legacy key disagree (WEB-STORAGE §5 fail-closed): nothing is chosen, nothing is unlinked
  | 'validation_failed'
  | 'client_cannot_import';

export class MigrationBlockedError extends WebStorageError {
  constructor(readonly reason: MigrationBlockedReason, detail?: string) {
    super('MIGRATION_BLOCKED', `Migration blocked: ${reason}${detail ? ` (${detail})` : ''}`);
    this.name = 'MigrationBlockedError';
  }
}

export interface EnsureUserOptions {
  /** Test seam. Default: raw IndexedDB read of the legacy USER key. */
  readLegacy?: () => Promise<Uint8Array | null>;
  now?: () => Date;
  newId?: () => string;
}

/** Tables that are operational (catalog receipts, jobs, locks, receipts); everything else counts as personal data. */
const OPERATIONAL_TABLES = new Set([
  'installed_catalogs', 'catalog_install_jobs', 'pack_metrics', 'schema_migrations', 'work_admission', 'restore_receipts', 'sync_state', 'data_operation_receipts'
]);
const SQLITE_MAGIC = 'SQLite format 3\u0000';

const defaultId = (): string => {
  const bytes = crypto.getRandomValues(new Uint8Array(10));
  return Array.from(bytes, (b) => (b % 36).toString(36)).join('') + Date.now().toString(36);
};

// ───────────────────────── legacy reader (raw IndexedDB, read-only) ─────────────────────────
export function readLegacyUserBytes(): Promise<Uint8Array | null> {
  if (typeof indexedDB === 'undefined') return Promise.resolve(null);
  return new Promise<Uint8Array | null>((resolve, reject) => {
    const blocked = (why: string) => new MigrationBlockedError('legacy_unreadable', why);
    let request: IDBOpenDBRequest;
    try {
      request = indexedDB.open(LEGACY_JEEP.dbName); // NO version: never upgrades, never creates a store
    } catch {
      reject(blocked('open'));
      return;
    }
    let existed = true;
    request.onupgradeneeded = (event) => {
      if (event.oldVersion === 0) {
        existed = false;
        request.transaction?.abort(); // the database did not exist: do not leave an empty one behind
      }
    };
    request.onerror = () => {
      if (!existed) resolve(null);
      else reject(blocked('open'));
    };
    request.onblocked = () => undefined;
    request.onsuccess = () => {
      const db = request.result;
      if (!db.objectStoreNames.contains(LEGACY_JEEP.storeName)) {
        db.close();
        resolve(null);
        return;
      }
      let tx: IDBTransaction;
      try {
        tx = db.transaction(LEGACY_JEEP.storeName, 'readonly');
      } catch {
        db.close();
        reject(blocked('transaction'));
        return;
      }
      const get = tx.objectStore(LEGACY_JEEP.storeName).get(LEGACY_JEEP.userKey);
      get.onerror = () => {
        db.close();
        reject(blocked('read'));
      };
      get.onsuccess = () => {
        db.close();
        const value: unknown = get.result;
        if (value === undefined || value === null) resolve(null);
        else if (value instanceof Uint8Array) resolve(value);
        else if (value instanceof ArrayBuffer) resolve(new Uint8Array(value));
        else if (ArrayBuffer.isView(value)) resolve(new Uint8Array(value.buffer, value.byteOffset, value.byteLength));
        else if (typeof Blob !== 'undefined' && value instanceof Blob) {
          if (value.size > LEGACY_MIGRATION_MAX_BYTES) reject(new MigrationBlockedError('legacy_too_large'));
          else void value.arrayBuffer().then((buffer) => resolve(new Uint8Array(buffer)), () => reject(blocked('blob')));
        } else reject(new MigrationBlockedError('legacy_corrupt', 'unexpected value type'));
      };
    };
  });
}

// ───────────────────────── helpers ─────────────────────────
type Proxy = (sql: string, params: unknown[], method: 'run' | 'all' | 'values' | 'get') => Promise<{ rows: unknown[] }>;

async function sha256Hex(bytes: Uint8Array): Promise<string> {
  const digest = await crypto.subtle.digest('SHA-256', bytes as unknown as BufferSource);
  return Array.from(new Uint8Array(digest), (b) => b.toString(16).padStart(2, '0')).join('');
}

const quoteIdent = (name: string): string => `"${name.replace(/"/g, '""')}"`;

function asInternal(client: WebSqliteClient): WebSqliteClientInternal {
  if (typeof (client as Partial<WebSqliteClientInternal>).importBytes !== 'function') throw new MigrationBlockedError('client_cannot_import');
  return client as WebSqliteClientInternal;
}

/** Header sanity of the legacy bytes (type, magic, page size, whole pages, rollback-journal format bytes). */
function checkLegacyHeader(bytes: Uint8Array): void {
  if (bytes.byteLength < 512) throw new MigrationBlockedError('legacy_corrupt', 'too small');
  const magic = new TextDecoder('latin1').decode(bytes.subarray(0, 16));
  if (magic !== SQLITE_MAGIC) throw new MigrationBlockedError('legacy_corrupt', 'not a SQLite file');
  const raw = ((bytes[16] as number) << 8) | (bytes[17] as number);
  const pageSize = raw === 1 ? 65536 : raw;
  if (pageSize < 512 || pageSize > 65536 || (pageSize & (pageSize - 1)) !== 0) throw new MigrationBlockedError('legacy_corrupt', 'page size');
  if (bytes.byteLength % pageSize !== 0) throw new MigrationBlockedError('legacy_corrupt', 'truncated');
  const writeVersion = bytes[18];
  const readVersion = bytes[19];
  if (!((writeVersion === 1 || writeVersion === 2) && (readVersion === 1 || readVersion === 2))) throw new MigrationBlockedError('legacy_unsupported_schema', 'file format');
}

/** Core's own rule (migrator.ts): the applied history must be an exact prefix of the bundled chain; longer = a newer app wrote it. */
async function checkCoreSchema(proxy: Proxy, forNewUser: boolean): Promise<void> {
  const tables = (await proxy("SELECT name FROM sqlite_master WHERE type = 'table' AND name NOT LIKE 'sqlite_%'", [], 'values')).rows as unknown[][];
  const names = new Set(tables.map((r) => String(r[0])));
  if (!names.has('schema_migrations')) {
    if (names.size === 0 && forNewUser) return; // a freshly created, never-migrated USER file
    throw new MigrationBlockedError(forNewUser ? 'user_unreadable' : 'legacy_unsupported_schema', 'no migration history');
  }
  const applied = (await proxy('SELECT version, checksum FROM schema_migrations ORDER BY version ASC', [], 'values')).rows as unknown[][];
  const chain = [...USER_MIGRATIONS].sort((a, b) => a.version.localeCompare(b.version));
  if (applied.length > chain.length) throw new MigrationBlockedError('future_schema');
  for (const [index, row] of applied.entries()) {
    const file = chain[index];
    if (!file || file.version !== String(row[0]) || migrationChecksum(file) !== String(row[1])) {
      throw new MigrationBlockedError(forNewUser ? 'future_schema' : 'legacy_unsupported_schema', 'history mismatch');
    }
  }
}

async function personalCounts(proxy: Proxy): Promise<Record<string, number>> {
  const tables = ((await proxy("SELECT name FROM sqlite_master WHERE type = 'table' AND name NOT LIKE 'sqlite_%' ORDER BY name", [], 'values')).rows as unknown[][]).map((r) => String(r[0]));
  const counts: Record<string, number> = {};
  for (const name of tables) {
    if (OPERATIONAL_TABLES.has(name)) continue;
    counts[name] = Number(((await proxy(`SELECT COUNT(*) FROM ${quoteIdent(name)}`, [], 'get')).rows as unknown[])[0]);
  }
  return counts;
}

async function columnsOf(proxy: Proxy, table: string): Promise<Set<string>> {
  return new Set(((await proxy(`PRAGMA table_info(${quoteIdent(table)})`, [], 'values')).rows as unknown[][]).map((r) => String(r[1])));
}

/**
 * Reset ONLY operational catalog state so receipts that point at jeep IndexedDB catalogs are never treated as OPFS files. The same
 * statements core's own recovery uses (ABSENT_SQL in catalog-install.ts, interrupt rules in catalog-install/sync recover), run through a
 * platform transaction before core ever opens the file. Personal tables and `app_state.collection_revision` are never touched.
 */
async function resetOperationalCatalogState(proxy: Proxy, nowIso: string): Promise<void> {
  const tables = new Set(((await proxy("SELECT name FROM sqlite_master WHERE type = 'table'", [], 'values')).rows as unknown[][]).map((r) => String(r[0])));
  await proxy('BEGIN IMMEDIATE', [], 'run');
  try {
    if (tables.has('installed_catalogs')) {
      const cols = await columnsOf(proxy, 'installed_catalogs');
      if (cols.has('status')) {
        const set = ["status = 'absent'"];
        for (const c of ['version', 'sha256', 'installed_at', 'schema_version', 'active_ref']) if (cols.has(c)) set.push(`${c} = NULL`);
        if (cols.has('generation')) set.push('generation = generation + 1');
        const where = cols.has('active_ref') ? "status <> 'absent' OR active_ref IS NOT NULL" : "status <> 'absent'";
        await proxy(`UPDATE installed_catalogs SET ${set.join(', ')} WHERE ${where}`, [], 'run');
      }
    }
    if (tables.has('catalog_install_jobs')) {
      const cols = await columnsOf(proxy, 'catalog_install_jobs');
      if (['state', 'lock_key', 'last_error_json', 'updated_at'].every((c) => cols.has(c))) {
        await proxy(
          `UPDATE catalog_install_jobs SET state = 'interrupted', lock_key = NULL, last_error_json = COALESCE(last_error_json, ?), updated_at = ?
           WHERE state NOT IN ('installed','cancelled','failed','interrupted','committed') OR lock_key IS NOT NULL`,
          [JSON.stringify({ code: 'INTERRUPTED', message: 'The download was interrupted. Start it again.' }), nowIso],
          'run'
        );
      }
    }
    if (tables.has('sync_state')) {
      const cols = await columnsOf(proxy, 'sync_state');
      if (['status', 'lock_key', 'worker_token', 'updated_at'].every((c) => cols.has(c))) {
        await proxy(
          `UPDATE sync_state SET status = CASE WHEN status IN ('queued','running','cancel_requested') THEN 'interrupted' ELSE status END, lock_key = NULL, worker_token = NULL, updated_at = ?
           WHERE status IN ('queued','running','cancel_requested') OR lock_key IS NOT NULL`,
          [nowIso],
          'run'
        );
      }
    }
    if (tables.has('work_admission')) await proxy('DELETE FROM work_admission', [], 'run');
    await proxy('COMMIT', [], 'run');
  } catch (error) {
    await proxy('ROLLBACK', [], 'run').catch(() => undefined);
    throw error;
  }
}

function mark(name: string, start: number): void {
  try {
    performance.measure(name, { start, end: performance.now() });
  } catch {
    /* best effort */
  }
}

// ───────────────────────── USER resolution ─────────────────────────
export function createEnsureUserDatabase(options: EnsureUserOptions = {}): EnsureUserDatabase {
  const readLegacy = options.readLegacy ?? readLegacyUserBytes;
  const now = options.now ?? (() => new Date());
  const newId = options.newId ?? defaultId;

  return async ({ client, roles, onProgress }) => {
    const progress = (p: UserPrepareProgress) => onProgress?.(p);
    progress({ phase: 'checking' });
    const role = await roles.user();
    const marker = await roles.migration(); // role + marker are judged TOGETHER (WEB-STORAGE §5 step 1): neither is trusted alone
    const files = await client.listFiles();

    if (role) {
      checkRoleMarkerConsistency(role, marker);
      await validateExistingUser(client, role.path, files);
      if (role.origin === 'migrated') {
        // marker + valid migrated USER: authoritative; legacy is NOT read and NEVER replayed. Stale staged m-* files are provably ours.
        await unlinkOrphans(client, files, (p) => /^\/user\/m-/.test(p) && p !== role.path);
        return { kind: 'existing', path: role.path };
      }
      // An UNMARKED (fresh) role must not coexist with a legacy USER key: that is two stores that may hold different personal data
      // (lost marker, stale tab, partial restore). Fail closed instead of picking one; nothing is unlinked in this state.
      let legacyPresent: boolean;
      try {
        legacyPresent = (await readLegacy()) !== null; // existence probe only: the bytes are dropped immediately
      } catch (error) {
        throw error instanceof MigrationBlockedError ? error : new MigrationBlockedError('legacy_unreadable', 'probe');
      }
      if (legacyPresent) throw new MigrationBlockedError('conflicting_stores', 'unmarked user + legacy key');
      return { kind: 'existing', path: role.path };
    }

    // No role. A completed-migration marker without any USER role says the new store's mapping was lost: never re-migrate over it,
    // never create a fresh database, never unlink anything.
    if (marker) throw new MigrationBlockedError('conflicting_stores', 'marker without user role');

    let legacy: Uint8Array | null;
    try {
      legacy = await readLegacy();
    } catch (error) {
      throw error instanceof WebStorageError ? error : new MigrationBlockedError('legacy_unreadable');
    }
    const userFiles = files.filter((p) => USER_PATH_RE.test(p));

    if (legacy === null) return createFresh(client, roles, userFiles, newId, now, progress);

    // A previous attempt that crashed before commitUser left a staged m-* file: redo from the legacy key with a NEW path.
    await unlinkOrphans(client, files, (p) => /^\/user\/m-/.test(p));
    for (const path of userFiles.filter((p) => /^\/user\/u-/.test(p))) {
      if (!(await isEmptyDatabase(client, path))) throw new MigrationBlockedError('orphan_user_data');
    }
    return migrateLegacy(client, roles, legacy, newId, now, progress);
  };
}

/**
 * WEB-STORAGE §5 step 1, role side: a MIGRATED role needs a completed marker for the SAME path; a fresh role must have no marker.
 * Anything else is a provenance conflict (shape-valid metadata is not proof) and blocks before any file is touched.
 */
function checkRoleMarkerConsistency(role: UserRole, marker: MigrationMarker | null): void {
  if (role.origin === 'migrated') {
    if (!marker) throw new MigrationBlockedError('conflicting_stores', 'migrated role without marker');
    if (marker.state !== 'completed' || marker.userPath !== role.path) throw new MigrationBlockedError('conflicting_stores', 'marker does not match the user role');
    return;
  }
  if (marker) throw new MigrationBlockedError('conflicting_stores', 'fresh role with a migration marker');
}

async function unlinkOrphans(client: WebSqliteClient, files: PoolPath[], match: (p: PoolPath) => boolean): Promise<void> {
  for (const path of files.filter(match)) await client.unlink(path).catch(() => false);
}

/**
 * `mode: 'rw'` is for the USER check only: a page killed mid-write leaves a HOT rollback journal that a read-only connection cannot
 * recover ("attempt to write a readonly database"); the rw open rolls it back before the first read. Nothing is written otherwise.
 */
async function withReadDriver<T>(client: WebSqliteClient, path: PoolPath, label: string, fn: (proxy: Proxy) => Promise<T>, mode: 'ro' | 'rw' = 'ro'): Promise<T> {
  const driver = await client.driver(path, label, { mode, create: false, role: 'validation' });
  try {
    return await fn(driver.proxy as Proxy);
  } finally {
    await driver.close().catch(() => undefined);
  }
}

async function validateExistingUser(client: WebSqliteClient, path: PoolPath, files: PoolPath[]): Promise<void> {
  if (!files.includes(path)) throw new MigrationBlockedError('user_missing');
  try {
    await withReadDriver(client, path, 'user-check', (proxy) => checkCoreSchema(proxy, true), 'rw');
  } catch (error) {
    if (error instanceof MigrationBlockedError) throw error;
    throw new MigrationBlockedError('user_unreadable');
  }
}

async function isEmptyDatabase(client: WebSqliteClient, path: PoolPath): Promise<boolean> {
  try {
    return await withReadDriver(client, path, 'orphan-check', async (proxy) => Number(((await proxy('SELECT COUNT(*) FROM sqlite_master', [], 'get')).rows as unknown[])[0]) === 0);
  } catch {
    throw new MigrationBlockedError('orphan_user_data');
  }
}

async function createFresh(
  client: WebSqliteClient, roles: RoleStore, userFiles: PoolPath[], newId: () => string, now: () => Date, progress: (p: UserPrepareProgress) => void
): Promise<{ kind: 'fresh'; path: PoolPath }> {
  if (userFiles.some((p) => /^\/user\/m-/.test(p))) throw new MigrationBlockedError('orphan_user_data'); // data of unknown origin, legacy gone
  let path = userFiles.find((p) => /^\/user\/u-/.test(p));
  if (path !== undefined) {
    // crash between creating the file and commitUser: adopt it only if it is provably empty
    if (!(await isEmptyDatabase(client, path))) throw new MigrationBlockedError('orphan_user_data');
  } else {
    path = `/user/u-${newId()}.db`;
    progress({ phase: 'finalizing' });
    const created = await client.driver(path, 'user-create', { mode: 'rw', create: true, role: 'user' });
    await created.close();
  }
  await roles.commitUser({ path, origin: 'fresh', createdAt: now().toISOString() }, null);
  return { kind: 'fresh', path };
}

async function migrateLegacy(
  client: WebSqliteClient, roles: RoleStore, legacy: Uint8Array, newId: () => string, now: () => Date, progress: (p: UserPrepareProgress) => void
): Promise<{ kind: 'migrated'; path: PoolPath; legacyBytes: number; counts: Record<string, number>; ms: number }> {
  const started = performance.now();
  const internal = asInternal(client);
  progress({ phase: 'reading-legacy', bytesTotal: legacy.byteLength });
  if (legacy.byteLength > LEGACY_MIGRATION_MAX_BYTES) throw new MigrationBlockedError('legacy_too_large');
  checkLegacyHeader(legacy);
  const legacyBytes = legacy.byteLength;
  const legacySha256 = await sha256Hex(legacy);
  const path = `/user/m-${newId()}.db`;

  progress({ phase: 'importing', bytesDone: 0, bytesTotal: legacyBytes });
  await internal.ensureCapacity(4);
  await internal.importBytes(path, legacy, legacySha256); // transfers (and so releases) the legacy array
  progress({ phase: 'importing', bytesDone: legacyBytes, bytesTotal: legacyBytes });

  let counts: Record<string, number>;
  try {
    progress({ phase: 'validating' });
    const driver = await client.driver(path, 'user-migrate', { mode: 'rw', create: false, role: 'user' });
    try {
      const proxy = driver.proxy as Proxy;
      const integrity = (await proxy('PRAGMA integrity_check', [], 'values')).rows as unknown[][];
      if (integrity.length !== 1 || integrity[0]?.[0] !== 'ok') throw new MigrationBlockedError('legacy_integrity_failed');
      const fk = (await proxy('PRAGMA foreign_key_check', [], 'values')).rows as unknown[][];
      if (fk.length > 0) throw new MigrationBlockedError('legacy_integrity_failed', 'foreign keys');
      await checkCoreSchema(proxy, false);
      const before = await personalCounts(proxy);
      progress({ phase: 'finalizing' });
      await resetOperationalCatalogState(proxy, now().toISOString());
      await driver.afterCommit?.();
      counts = await personalCounts(proxy);
      if (JSON.stringify(before) !== JSON.stringify(counts)) throw new MigrationBlockedError('validation_failed', 'personal rows changed');
    } finally {
      await driver.close().catch(() => undefined);
    }
    await client.closePath(path);
  } catch (error) {
    await client.closePath(path).catch(() => undefined);
    await client.unlink(path).catch(() => false); // the legacy key stays authoritative; the staged copy is ours
    throw error instanceof WebStorageError ? error : new MigrationBlockedError('validation_failed');
  }

  const at = now().toISOString();
  const marker: MigrationMarker = { version: 1, state: 'completed', source: 'jeep-indexeddb', userPath: path, at, legacyBytes, legacySha256, counts, legacyRetained: true };
  await roles.commitUser({ path, origin: 'migrated', createdAt: at }, marker); // the ONE authoritative step
  mark('fdx:web-migrate-legacy', started);
  return { kind: 'migrated', path, legacyBytes, counts, ms: performance.now() - started };
}

export const ensureUserDatabase: EnsureUserDatabase = (deps) => createEnsureUserDatabase()(deps);
