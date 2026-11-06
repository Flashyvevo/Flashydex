/**
 * DEV-only browser harness for the Playwright specs (served on /harness.html; never part of the production build graph).
 *   await page.goto('/harness.html'); await page.evaluate(() => import('/src/platform/web-sqlite/harness.ts').then((m) => m.run('init', {})));
 * Module state (the current client) lives for the page; reload the page to simulate a tab kill.
 */
import sqlite3InitModule from '@sqlite.org/sqlite-wasm';
import { Db, USER_MIGRATIONS, migrate, type SqlDriver } from '@flashydex/core';
import { LEGACY_JEEP, STAGING_ROOT, type MigrationMarker, type RoleStore, type UserPrepareProgress, type UserRole } from '../web-storage/contract';
import { createWebSqliteClient, defaultWorkerFactory, type WebSqliteClientInternal, type WorkerLike } from './client';
import { createEnsureUserDatabase } from './legacy-migration';
import type { FaultSpec } from './protocol';
import { dumpPersonal, operationalSnapshot, seedLegacyUser } from './testing/legacy-seed';

const USER_PATH = '/user/u-harness01.db';
let client: WebSqliteClientInternal = createWebSqliteClient();
const drivers = new Map<string, SqlDriver>();

const hex = (bytes: Uint8Array) => Array.from(bytes, (b) => b.toString(16).padStart(2, '0')).join('');
const sha256 = async (bytes: Uint8Array) => hex(new Uint8Array(await crypto.subtle.digest('SHA-256', bytes as unknown as BufferSource)));
const errorInfo = (e: unknown) => {
  const x = e as { code?: string; reason?: string; message?: string; details?: { commitState?: string } } | null;
  return { code: x?.code ?? 'UNKNOWN', reason: x?.reason ?? null, commitState: x?.details?.commitState ?? null, message: String(x?.message ?? e).slice(0, 200) };
};

async function open(path: string, mode: 'rw' | 'ro' = 'rw', create = false): Promise<SqlDriver> {
  const key = `${path}:${mode}`;
  let driver = drivers.get(key);
  if (!driver) {
    driver = await client.driver(path, `harness-${mode}`, { mode, create, role: 'user' });
    drivers.set(key, driver);
  }
  return driver;
}

async function closeAll(): Promise<void> {
  for (const driver of drivers.values()) await driver.close().catch(() => undefined);
  drivers.clear();
}

// ───────────────────────── fixtures ─────────────────────────
async function generateDbFile(megabytes: number): Promise<Uint8Array> {
  const sqlite3 = await sqlite3InitModule();
  const db = new sqlite3.oo1.DB(':memory:');
  db.exec('PRAGMA page_size = 4096; CREATE TABLE big (id INTEGER PRIMARY KEY, payload TEXT NOT NULL)');
  const rows = Math.ceil((megabytes * 1024 * 1024) / 1010);
  db.exec(`WITH RECURSIVE c(x) AS (SELECT 1 UNION ALL SELECT x + 1 FROM c WHERE x < ${rows}) INSERT INTO big(payload) SELECT hex(randomblob(500)) FROM c`);
  const bytes = sqlite3.capi.sqlite3_js_db_export(db);
  db.close();
  bytes[18] = 1;
  bytes[19] = 1;
  return bytes;
}

async function writeStaging(job: string, name: string, bytes: Uint8Array): Promise<void> {
  const root = await navigator.storage.getDirectory();
  const staging = await root.getDirectoryHandle(STAGING_ROOT, { create: true });
  const dir = await staging.getDirectoryHandle(job, { create: true });
  const file = await dir.getFileHandle(name, { create: true });
  const writable = await file.createWritable();
  for (let at = 0; at < bytes.length; at += 1024 * 1024) await writable.write(bytes.slice(at, Math.min(bytes.length, at + 1024 * 1024)));
  await writable.close();
}

async function rawIdbPut(key: string, value: Uint8Array): Promise<void> {
  const db = await new Promise<IDBDatabase>((resolve, reject) => {
    const request = indexedDB.open(LEGACY_JEEP.dbName, 1);
    request.onupgradeneeded = () => {
      if (!request.result.objectStoreNames.contains(LEGACY_JEEP.storeName)) request.result.createObjectStore(LEGACY_JEEP.storeName);
    };
    request.onsuccess = () => resolve(request.result);
    request.onerror = () => reject(request.error);
  });
  await new Promise<void>((resolve, reject) => {
    const tx = db.transaction(LEGACY_JEEP.storeName, 'readwrite');
    tx.objectStore(LEGACY_JEEP.storeName).put(value, key);
    tx.oncomplete = () => resolve();
    tx.onerror = () => reject(tx.error);
  });
  db.close();
}

async function rawIdbSnapshot(): Promise<Record<string, { bytes: number; sha256: string }>> {
  const db = await new Promise<IDBDatabase | null>((resolve) => {
    const request = indexedDB.open(LEGACY_JEEP.dbName);
    request.onsuccess = () => resolve(request.result);
    request.onerror = () => resolve(null);
  });
  if (!db || !db.objectStoreNames.contains(LEGACY_JEEP.storeName)) return {};
  const entries = await new Promise<[IDBValidKey, unknown][]>((resolve) => {
    const out: [IDBValidKey, unknown][] = [];
    const cursor = db.transaction(LEGACY_JEEP.storeName, 'readonly').objectStore(LEGACY_JEEP.storeName).openCursor();
    cursor.onsuccess = () => {
      const c = cursor.result;
      if (c) { out.push([c.key, c.value]); c.continue(); } else resolve(out);
    };
  });
  db.close();
  const result: Record<string, { bytes: number; sha256: string }> = {};
  for (const [key, value] of entries) if (value instanceof Uint8Array) result[String(key)] = { bytes: value.length, sha256: await sha256(value) };
  return result;
}

// A RoleStore stand-in persisted in localStorage so reloads behave like a durable store. Builder B owns the real one.
class StorageRoles {
  private readonly key = 'fdx-harness-roles';
  private read(): { user: UserRole | null; marker: MigrationMarker | null } {
    return JSON.parse(localStorage.getItem(this.key) ?? '{"user":null,"marker":null}') as { user: UserRole | null; marker: MigrationMarker | null };
  }
  failCommit = false;
  async user() { return this.read().user; }
  async migration() { return this.read().marker; }
  async commitUser(role: UserRole, marker: MigrationMarker | null) {
    if (this.failCommit) throw new Error('harness: simulated crash before commitUser');
    localStorage.setItem(this.key, JSON.stringify({ user: role, marker }));
  }
  asStore(): RoleStore { return this as unknown as RoleStore; }
}
const roles = new StorageRoles();

async function sqlOn(path: string, sql: string, params: unknown[] = [], method: 'run' | 'all' | 'values' | 'get' = 'values') {
  return (await (await open(path)).proxy(sql, params, method)).rows;
}

// ───────────────────────── scenarios ─────────────────────────
type Args = Record<string, unknown>;

export async function run(scenario: string, args: Args = {}): Promise<unknown> {
  switch (scenario) {
    case 'init': {
      const started = performance.now();
      const info = await client.init();
      return { info, wallMs: performance.now() - started, stats: await client.stats(), crossOriginIsolated: self.crossOriginIsolated, sharedArrayBuffer: typeof SharedArrayBuffer };
    }
    case 'new-client': {
      await closeAll();
      client = createWebSqliteClient(args.fault ? { fault: args.fault as FaultSpec } : {});
      return true;
    }
    case 'try-init': {
      try {
        return { ok: true, info: await client.init() };
      } catch (e) {
        return { ok: false, error: errorInfo(e) };
      }
    }
    case 'shutdown': { await closeAll(); await client.shutdown(); return true; }
    case 'stats': return client.stats();
    case 'list': return client.listFiles();
    case 'fault': { await client.__setFault(args.fault as FaultSpec); return true; }
    case 'kill-worker': { client.__terminateWorker(); return true; }
    case 'message-stats': return client.__messageStats(args.reset === true);

    case 'write-row': {
      const path = String(args.path ?? USER_PATH);
      const d = await open(path, 'rw', true);
      await d.proxy('CREATE TABLE IF NOT EXISTS t (id INTEGER PRIMARY KEY, v TEXT)', [], 'run');
      await d.proxy('BEGIN IMMEDIATE', [], 'run');
      await d.proxy('INSERT INTO t (v) VALUES (?)', [String(args.value)], 'run');
      await d.proxy('COMMIT', [], 'run');
      await d.afterCommit?.();
      return sqlOn(path, 'SELECT id, v FROM t ORDER BY id');
    }
    case 'read-rows': return sqlOn(String(args.path ?? USER_PATH), 'SELECT id, v FROM t ORDER BY id');
    case 'close-driver': { await closeAll(); return true; }

    case 'returning-tx': {
      const path = String(args.path ?? '/user/u-returning1.db');
      const d = await open(path, 'rw', true);
      await d.proxy('CREATE TABLE r (id INTEGER PRIMARY KEY, name TEXT NOT NULL UNIQUE, blob_col BLOB)', [], 'run');
      const all = (await d.proxy('INSERT INTO r (name, blob_col) VALUES (?, ?), (?, NULL) RETURNING id, name, blob_col', ['アルファ', new Uint8Array([0, 255, 1]), 'beta'], 'all')).rows;
      const get = (await d.proxy('INSERT INTO r (name) VALUES (?), (?) RETURNING id, name', ['g1', 'g2'], 'get')).rows;
      const run = (await d.proxy('INSERT INTO r (name) VALUES (?) RETURNING id', ['run1'], 'run')).rows;
      const counted = (await d.proxy('SELECT COUNT(*) FROM r', [], 'get')).rows;
      let trailing = 'accepted';
      try { await d.proxy('SELECT 1; SELECT 2', [], 'all'); } catch (e) { trailing = errorInfo(e).code; }
      let constraint = 'accepted';
      try { await d.proxy('INSERT INTO r (name) VALUES (?)', ['beta'], 'run'); } catch (e) { constraint = errorInfo(e).message; }
      await d.proxy('BEGIN IMMEDIATE', [], 'run');
      await d.proxy("INSERT INTO r (name) VALUES ('rolled')", [], 'run');
      await d.proxy('ROLLBACK', [], 'run');
      const afterRollback = (await d.proxy("SELECT COUNT(*) FROM r WHERE name = 'rolled'", [], 'get')).rows;
      const blob = (await d.proxy('SELECT blob_col FROM r WHERE name = ?', ['アルファ'], 'get')).rows as unknown[];
      return { all, get, run, counted, trailing, constraint, afterRollback, blobIsU8: blob[0] instanceof Uint8Array, blob: Array.from(blob[0] as Uint8Array) };
    }

    case 'make-staged-db': {
      const job = String(args.job ?? 'jobstage01');
      const bytes = await generateDbFile(Number(args.megabytes ?? 20));
      await writeStaging(job, 'catalog.db.part', bytes);
      return { job, name: 'catalog.db.part', bytes: bytes.length, sha256: await sha256(bytes) };
    }
    case 'import': {
      const target = String(args.target);
      const input = { source: { job: String(args.job), name: 'catalog.db.part' }, target, expectedBytes: Number(args.bytes), expectedSha256: String(args.sha256) };
      let userWrites = 0;
      let stop = false;
      let writer: Promise<void> | null = null;
      if (args.interleaveUser) {
        const user = await open(USER_PATH, 'rw', true);
        await user.proxy('CREATE TABLE IF NOT EXISTS log (n INTEGER)', [], 'run');
        writer = (async () => {
          while (!stop) {
            await user.proxy('BEGIN IMMEDIATE', [], 'run');
            await user.proxy('INSERT INTO log VALUES (?)', [userWrites], 'run');
            await user.proxy('COMMIT', [], 'run');
            await user.afterCommit?.();
            userWrites += 1;
          }
        })();
      }
      client.__messageStats(true);
      const started = performance.now();
      try {
        const result = await client.importFromStaging(input);
        stop = true;
        await writer;
        return { ok: true, result, wallMs: performance.now() - started, userWrites, messages: client.__messageStats() };
      } catch (e) {
        stop = true;
        await writer?.catch(() => undefined);
        return { ok: false, error: errorInfo(e), userWrites, messages: client.__messageStats() };
      }
    }
    case 'import-then-kill': {
      const input = { source: { job: String(args.job), name: 'catalog.db.part' }, target: String(args.target), expectedBytes: Number(args.bytes), expectedSha256: String(args.sha256) };
      await client.__setFault({ supplier: { kind: 'stall', afterBytes: Number(args.afterBytes ?? 4 * 1024 * 1024) } });
      const pending = client.importFromStaging(input).then(() => ({ ok: true }), (e: unknown) => ({ ok: false, error: errorInfo(e) }));
      await new Promise((resolve) => setTimeout(resolve, Number(args.killAfterMs ?? 800)));
      client.__terminateWorker();
      const outcome = await pending;
      drivers.clear();
      const info = await client.init();
      return { outcome, files: await client.listFiles(), sessionId: info.sessionId };
    }
    case 'verify-candidate': {
      const path = String(args.path);
      const d = await client.driver(path, 'verify', { mode: 'ro', create: false, role: 'validation' });
      const integrity = (await d.proxy('PRAGMA integrity_check', [], 'values')).rows;
      const count = (await d.proxy('SELECT COUNT(*) FROM big', [], 'get')).rows;
      await d.close();
      const exported = await client.__exportFile(path);
      return { integrity, count, bytes: exported.length, sha256: await sha256(exported) };
    }
    case 'user-integrity': {
      const path = String(args.path ?? USER_PATH);
      return { integrity: await sqlOn(path, 'PRAGMA integrity_check'), logRows: await sqlOn(path, 'SELECT COUNT(*) FROM log'), maxLog: await sqlOn(path, 'SELECT MAX(n) FROM log') };
    }
    case 'long-sql-liveness': {
      // S6-01: a REAL worker running ONE synchronous statement far longer than livenessTimeoutMs (it cannot answer pings while stepping).
      // `silent: true` instead makes the worker truly dead (nothing in or out) and expects the watchdog to declare it.
      await closeAll();
      await client.shutdown();
      let terminated = 0;
      let shuttingDown = false;
      let silent = false;
      const factory = (): WorkerLike => {
        const w = defaultWorkerFactory();
        return {
          postMessage: (m, t) => { if (!silent) w.postMessage(m, t); },
          terminate: () => { if (!shuttingDown) terminated += 1; w.terminate(); },
          addEventListener: ((type: string, l: (e: unknown) => void) => {
            (w.addEventListener as (t: string, l: (e: unknown) => void) => void)(type, type === 'message' ? (e) => { if (!silent) l(e); } : l);
          }) as WorkerLike['addEventListener']
        };
      };
      client = createWebSqliteClient({ workerFactory: factory, livenessIntervalMs: Number(args.intervalMs ?? 50), livenessTimeoutMs: Number(args.timeoutMs ?? 300) });
      const path = '/user/u-liveness01.db';
      const d = await open(path, 'rw', true);
      const rows = Number(args.rows ?? 4_000_000);
      const started = performance.now();
      let outcome: unknown;
      try {
        if (args.silent === true) silent = true;
        const r = await d.proxy(`WITH RECURSIVE c(x) AS (SELECT 1 UNION ALL SELECT x+1 FROM c WHERE x<${rows}) SELECT SUM(x) FROM c`, [], 'values');
        outcome = { ok: true, rows: r.rows };
      } catch (e) {
        outcome = { ok: false, error: errorInfo(e) };
      }
      const elapsedMs = performance.now() - started;
      const terminatedBeforeShutdown = terminated;
      shuttingDown = true;
      silent = false;
      drivers.clear();
      await client.shutdown().catch(() => undefined);
      return { outcome, elapsedMs, terminatedBeforeShutdown };
    }
    case 'unlink': return client.unlink(String(args.path) as never);
    case 'ensure-capacity': return client.ensureCapacity(Number(args.slots ?? 4));

    // ───────── legacy migration ─────────
    case 'seed-legacy': {
      // Build a legacy-shaped USER file through the REAL worker + core migrations on a temp pool path, then publish its bytes in jeep's IDB format.
      const temp = '/user/u-seedtemp01.db';
      const d = await client.driver(temp, 'seed', { mode: 'rw', create: true, role: 'user' });
      await seedLegacyUser(d, { extraOwned: Number(args.extraOwned ?? 0) });
      const dump = await dumpPersonal(d);
      const ops = await operationalSnapshot(d);
      await d.close();
      await client.closePath(temp);
      const bytes = await client.__exportFile(temp);
      await client.unlink(temp);
      await rawIdbPut(LEGACY_JEEP.userKey, bytes);
      await rawIdbPut('flashydex-catalog-enSQLite.db', new Uint8Array([9, 9, 9, 9])); // a replaceable catalog key that must stay untouched
      return { dump, ops, bytes: bytes.length, sha256: await sha256(bytes), legacy: await rawIdbSnapshot() };
    }
    case 'idb-snapshot': return rawIdbSnapshot();
    case 'idb-databases': return (await indexedDB.databases()).map((d) => d.name);
    case 'put-legacy-raw': {
      const size = Number(args.size);
      const bytes = new Uint8Array(size);
      for (let at = 0; at < size; at += 65536) crypto.getRandomValues(bytes.subarray(at, Math.min(size, at + 65536)));
      if (args.sqliteHeader === true) bytes.set(new TextEncoder().encode('SQLite format 3\u0000'), 0);
      await rawIdbPut(LEGACY_JEEP.userKey, bytes);
      return { bytes: size };
    }
    case 'ensure-user': {
      roles.failCommit = args.failCommit === true;
      const phases: UserPrepareProgress['phase'][] = [];
      try {
        const outcome = await createEnsureUserDatabase()({ client, roles: roles.asStore(), onProgress: (p) => phases.push(p.phase) });
        return { ok: true, outcome, phases, role: await roles.user(), marker: await roles.migration(), files: await client.listFiles() };
      } catch (e) {
        return { ok: false, error: errorInfo(e), phases, files: await client.listFiles() };
      } finally {
        roles.failCommit = false;
      }
    }
    case 'user-dump': {
      const role = await roles.user();
      if (!role) return null;
      const d = await open(role.path, 'rw');
      return { path: role.path, dump: await dumpPersonal(d), ops: await operationalSnapshot(d), integrity: (await d.proxy('PRAGMA integrity_check', [], 'values')).rows, fk: (await d.proxy('PRAGMA foreign_key_check', [], 'values')).rows };
    }
    case 'roles': return { role: await roles.user(), marker: await roles.migration() };
    case 'migrate-core': {
      const d = await client.driver(String(args.path), 'core', { mode: 'rw', create: true, role: 'user' });
      const db = new Db(d);
      await db.initialize();
      return migrate(db, USER_MIGRATIONS, () => new Date().toISOString());
    }
    default:
      throw new Error(`unknown harness scenario: ${scenario}`);
  }
}
