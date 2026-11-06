/**
 * SQL worker (module worker): ordinary-OPFS probe -> installOpfsSAHPoolVfs -> reserveMinimumCapacity -> SQLite commit/reopen probe,
 * then serves protocol v1 through `SqlWorkerCore`.
 *
 * Hard rules (WEB-STORAGE §1/§2): never `removeVfs()` / `wipeFiles()` / clear OPFS, never fall back to an in-memory database, never
 * pass the SAH `mode` option. Init failure keeps the storage (preserveOnInitFailure) and surfaces INIT_FAILED / STORAGE_UNAVAILABLE.
 */
import sqlite3InitModule from '@sqlite.org/sqlite-wasm';
import { createSHA256 } from 'hash-wasm';
import { POOL_DIRECTORY, POOL_INITIAL_CAPACITY, POOL_VFS_NAME, PROBE_PATH_RE, STAGING_ROOT, WebStorageError } from '../web-storage/contract';
import type { Oo1Db, Sqlite3Api } from './executor';
import { PROTOCOL, type FaultSpec, type InitResult, type RequestEnvelope, type WorkerMessage } from './protocol';
import { withPoolOpenRetry } from './pool-boot-retry';
import { mapAnyError, SqlWorkerCore, type PoolLike, type Sha256, type StagingFile, type WorkerEnv } from './worker-core';

const scope = self as unknown as {
  postMessage(message: unknown, transfer?: Transferable[]): void;
  onmessage: ((event: MessageEvent) => void) | null;
};

const randomId = () => Array.from(crypto.getRandomValues(new Uint8Array(8)), (b) => (b % 36).toString(36)).join('') + Date.now().toString(36);

/** A tiny ordinary OPFS file: create/write/read/flush/close/reopen. Feature presence alone proves nothing (WEB-STORAGE §2). */
async function probeOrdinaryOpfs(): Promise<void> {
  const storage = (navigator as Navigator & { storage?: StorageManager }).storage;
  if (!storage?.getDirectory) throw new WebStorageError('STORAGE_UNAVAILABLE', 'This browser has no origin private file system');
  const name = `.fdx-probe-${randomId()}`;
  let root: FileSystemDirectoryHandle | undefined;
  try {
    root = await storage.getDirectory();
    const handle = await root.getFileHandle(name, { create: true });
    if (typeof handle.createSyncAccessHandle !== 'function') throw new WebStorageError('STORAGE_UNAVAILABLE', 'Synchronous file access handles are not available');
    const pattern = Uint8Array.from({ length: 64 }, (_, i) => (i * 7 + 3) & 0xff);
    let sah = await handle.createSyncAccessHandle();
    try {
      sah.truncate(0);
      if (sah.write(pattern, { at: 0 }) !== pattern.length) throw new WebStorageError('STORAGE_UNAVAILABLE', 'The probe file could not be written');
      sah.flush();
    } finally {
      sah.close();
    }
    sah = await handle.createSyncAccessHandle();
    try {
      const back = new Uint8Array(pattern.length);
      if (sah.getSize() !== pattern.length || sah.read(back, { at: 0 }) !== pattern.length || back.some((b, i) => b !== pattern[i])) {
        throw new WebStorageError('STORAGE_UNAVAILABLE', 'The probe file did not read back');
      }
    } finally {
      sah.close();
    }
  } catch (error) {
    throw error instanceof WebStorageError ? error : new WebStorageError('STORAGE_UNAVAILABLE', 'Browser storage is not usable (private mode or a blocked profile?)', { cause: error });
  } finally {
    try {
      await root?.removeEntry(name);
    } catch {
      /* the probe file is ours and tiny; a leftover is harmless */
    }
  }
}

function sqliteProbe(sqlite3: Sqlite3Api, pool: PoolLike): void {
  for (const name of pool.getFileNames()) if (PROBE_PATH_RE.test(name)) pool.unlink(name); // leftovers of a crashed earlier probe (ours)
  const path = `/probe/p-${randomId()}.db`;
  const open = (flags: string) => new pool.OpfsSAHPoolDb(path, flags) as unknown as Oo1Db;
  try {
    let db = open('cw');
    try {
      db.exec('PRAGMA journal_mode = DELETE');
      db.exec('PRAGMA synchronous = FULL');
      db.exec('CREATE TABLE probe(v INTEGER); BEGIN; INSERT INTO probe VALUES (42); COMMIT;');
    } finally {
      db.close();
    }
    db = open('w');
    try {
      if (Number(db.selectValue('SELECT v FROM probe')) !== 42) throw new Error('probe row missing after reopen');
    } finally {
      db.close();
    }
  } catch (error) {
    throw new WebStorageError('STORAGE_UNAVAILABLE', 'SQLite could not commit and reopen a database in browser storage', { cause: error });
  } finally {
    try {
      pool.unlink(path);
    } catch {
      /* ignore */
    }
  }
  void sqlite3;
}

async function stagingOpen(job: string, name: string): Promise<StagingFile> {
  const root = await navigator.storage.getDirectory();
  const staging = await root.getDirectoryHandle(STAGING_ROOT);
  const dir = await staging.getDirectoryHandle(job);
  const file = await dir.getFileHandle(name);
  const sah = await file.createSyncAccessHandle();
  return {
    size: sah.getSize(),
    read: (buffer, at) => sah.read(buffer, { at }),
    close: () => sah.close()
  };
}

async function boot(fault: FaultSpec | undefined): Promise<WorkerEnv> {
  const poolStarted = performance.now();
  let sqlite3: Sqlite3Api;
  try {
    sqlite3 = (await sqlite3InitModule()) as unknown as Sqlite3Api;
  } catch (error) {
    throw new WebStorageError('INIT_FAILED', 'The SQLite WebAssembly module failed to load', { cause: error });
  }
  const probeStarted = performance.now();
  await probeOrdinaryOpfs();
  const probeOpfsMs = performance.now() - probeStarted;
  if (fault?.initFail === 'before-vfs') throw new WebStorageError('INIT_FAILED', 'Injected initialization failure');

  let pool: PoolLike;
  try {
    // Transient right after a killed worker (handles still held): bounded retry, only for the "could not be opened" cause (never quota/corruption).
    pool = await withPoolOpenRetry(async () => {
      const util = await (sqlite3 as unknown as { installOpfsSAHPoolVfs(options: object): Promise<PoolLike & { reserveMinimumCapacity(n: number): Promise<number> }> }).installOpfsSAHPoolVfs({
        name: POOL_VFS_NAME,
        directory: POOL_DIRECTORY,
        initialCapacity: POOL_INITIAL_CAPACITY,
        clearOnInit: false, // data MUST survive re-init
        preserveOnInitFailure: true // a failed init releases handles but never deletes the pool
      });
      await util.reserveMinimumCapacity(POOL_INITIAL_CAPACITY); // initialCapacity only applies to an empty pool
      return util;
    });
  } catch (error) {
    const mapped = mapAnyError(error, 'INIT_FAILED');
    throw mapped.code === 'QUOTA' || mapped.code === 'CAPACITY' ? mapped : new WebStorageError('INIT_FAILED', 'The browser storage pool could not be opened', { cause: error });
  }
  if (fault?.initFail === 'after-vfs') throw new WebStorageError('INIT_FAILED', 'Injected initialization failure');
  const poolReadyMs = performance.now() - poolStarted;

  const probeSqliteStarted = performance.now();
  sqliteProbe(sqlite3, pool);
  const probeMs = probeOpfsMs + (performance.now() - probeSqliteStarted);

  const init: InitResult = {
    sqliteVersion: sqlite3.version.libVersion,
    capacity: pool.getCapacity(),
    fileCount: pool.getFileCount(),
    wasmMemoryBytes: sqlite3.wasm.heap8u().buffer.byteLength,
    timings: { poolReadyMs, probeMs }
  };
  return {
    sqlite3,
    pool,
    staging: { open: stagingOpen },
    createSha256: async (): Promise<Sha256> => {
      const hasher = await createSHA256();
      hasher.init();
      return { update: (data) => { hasher.update(data); }, digest: () => hasher.digest('hex') };
    },
    strictPragmas: true,
    init
  };
}

const channel = new MessageChannel();
const yielders: (() => void)[] = [];
channel.port1.onmessage = () => yielders.shift()?.();
const yieldToLoop = (): Promise<void> => new Promise((resolve) => { yielders.push(resolve); channel.port2.postMessage(0); });

const core = new SqlWorkerCore({
  boot,
  post: (message: WorkerMessage, transfer) => scope.postMessage(message, transfer),
  yieldToLoop,
  dev: import.meta.env.DEV,
  heapUsedBytes: () => {
    const memory = (performance as Performance & { memory?: { usedJSHeapSize: number } }).memory;
    return memory ? memory.usedJSHeapSize : null;
  }
});

scope.onmessage = (event: MessageEvent) => {
  void core.handle(event.data as RequestEnvelope);
};
scope.postMessage({ kind: 'ready', protocol: PROTOCOL } satisfies WorkerMessage);
