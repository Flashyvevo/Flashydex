/**
 * Node test fixtures: an in-memory stand-in for the sahpool + OPFS staging, and an in-process loopback "Worker" that runs the REAL
 * `SqlWorkerCore` with structured-clone message passing. Shared pool state survives "worker restarts" like OPFS does.
 */
import { createHash } from 'node:crypto';
import { sqlVerb, type Oo1Db, type Sqlite3Api } from '../executor';
import type { FaultSpec, RequestEnvelope, WorkerMessage } from '../protocol';
import { SqlWorkerCore, type PoolLike, type Sha256, type StagingFile, type WorkerEnv } from '../worker-core';
import type { WorkerLike } from '../client';
import { loadSqlite3 } from './sqlite-node';

export class MemoryPool implements PoolLike {
  readonly files = new Map<string, Uint8Array>();
  capacity = 16;
  failReserve = false;
  readonly OpfsSAHPoolDb: PoolLike['OpfsSAHPoolDb'];

  constructor(sqlite3: Sqlite3Api) {
    // eslint-disable-next-line @typescript-eslint/no-this-alias -- the constructor function below needs a stable reference
    const pool = this;
    this.OpfsSAHPoolDb = function (path: string, flags = 'c') {
      const exists = pool.files.has(path);
      if (!exists && !flags.includes('c')) throw Object.assign(new Error('unable to open database file'), { name: 'SQLite3Error', resultCode: 14 });
      if (!exists) {
        if (pool.files.size >= pool.capacity) throw Object.assign(new Error('SQLITE_CANTOPEN: no free slot'), { name: 'SQLite3Error', resultCode: 14 });
        pool.files.set(path, new Uint8Array(0));
      }
      const db = new sqlite3.oo1.DB(':memory:') as unknown as Oo1Db;
      const bytes = pool.files.get(path) as Uint8Array;
      if (bytes.length > 0) {
        const p = sqlite3.wasm.allocFromTypedArray(bytes);
        const rc = sqlite3.capi.sqlite3_deserialize(db.pointer, 'main', p, bytes.length, bytes.length, sqlite3.capi.SQLITE_DESERIALIZE_FREEONCLOSE | sqlite3.capi.SQLITE_DESERIALIZE_RESIZEABLE);
        if (rc !== 0) throw Object.assign(new Error('file is not a database'), { name: 'SQLite3Error', resultCode: 26 });
      }
      const persist = () => {
        if (db.isOpen() && sqlite3.capi.sqlite3_get_autocommit(db) === 1) pool.files.set(path, sqlite3.capi.sqlite3_js_db_export(db));
      };
      const prepare = db.prepare.bind(db);
      db.prepare = (sql: string) => {
        const stmt = prepare(sql);
        const readonly = sqlite3.capi.sqlite3_stmt_readonly(stmt.pointer) !== 0;
        const verb = sqlVerb(sql);
        const finalize = stmt.finalize.bind(stmt);
        (stmt as { finalize: () => unknown }).finalize = () => {
          const r = finalize();
          if (!readonly || verb === 'COMMIT' || verb === 'END') persist();
          return r;
        };
        return stmt;
      };
      const exec = db.exec.bind(db);
      db.exec = (arg: string | Record<string, unknown>) => {
        const r = exec(arg);
        persist();
        return r;
      };
      const close = db.close.bind(db);
      db.close = () => {
        if (db.isOpen() && sqlite3.capi.sqlite3_get_autocommit(db) === 0) exec('ROLLBACK');
        close();
      };
      return db;
    } as unknown as PoolLike['OpfsSAHPoolDb'];
  }

  getCapacity(): number { return this.capacity; }
  getFileCount(): number { return this.files.size; }
  getFileNames(): string[] { return [...this.files.keys()]; }
  async reserveMinimumCapacity(n: number): Promise<number> {
    if (this.failReserve) throw new DOMException('no space', 'QuotaExceededError');
    this.capacity = Math.max(this.capacity, n);
    return this.capacity;
  }
  unlink(name: string): boolean { return this.files.delete(name); }
  exportFile(name: string): Uint8Array {
    const bytes = this.files.get(name);
    if (!bytes) throw new Error('File not found');
    return new Uint8Array(bytes);
  }
  async importDb(name: string, supplier: () => Promise<Uint8Array | ArrayBuffer | undefined>): Promise<number> {
    const chunks: Uint8Array[] = [];
    let total = 0;
    try {
      for (let chunk = await supplier(); chunk !== undefined; chunk = await supplier()) {
        const view = chunk instanceof ArrayBuffer ? new Uint8Array(chunk) : chunk;
        if (total === 0 && view.length >= 15 && new TextDecoder().decode(view.subarray(0, 15)) !== 'SQLite format 3') throw new Error('Input does not contain an SQLite database header.');
        chunks.push(new Uint8Array(view)); // copy: the supplier reuses its buffer
        total += view.length;
      }
      if (total < 512 || total % 512 !== 0) throw new Error(`Input size ${total} is not correct for an SQLite database.`);
    } catch (error) {
      this.files.delete(name);
      throw error;
    }
    const all = new Uint8Array(total);
    let at = 0;
    for (const c of chunks) { all.set(c, at); at += c.length; }
    all[18] = 1;
    all[19] = 1;
    this.files.set(name, all);
    return total;
  }
}

export class MemoryStaging {
  readonly files = new Map<string, Uint8Array>();
  shortReadAt: number | null = null;
  async open(job: string, name: string): Promise<StagingFile> {
    const bytes = this.files.get(`${job}/${name}`);
    if (!bytes) throw Object.assign(new DOMException('missing', 'NotFoundError'));
    return {
      size: bytes.length,
      read: (buffer, at) => {
        const n = Math.min(buffer.length, bytes.length - at);
        buffer.set(bytes.subarray(at, at + n));
        return this.shortReadAt !== null && at >= this.shortReadAt ? Math.max(0, n - 1) : n;
      },
      close: () => undefined
    };
  }
}

export interface MemoryHarness {
  sqlite3: Sqlite3Api;
  pool: MemoryPool;
  staging: MemoryStaging;
  workerFactory: () => WorkerLike;
  cores: SqlWorkerCore[];
  /** Messages every spawned loopback worker received (op names), for assertions. */
  log: { op: string; dbId?: number; requestId: number }[];
  /** Hold every response for `op` until the returned function is called. */
  hold(op: string): () => void;
  failBoot: { code: string } | null;
  /** Rewrite (or drop) a worker response before the client sees it: lost-ack / IO-on-COMMIT injection. */
  intercept: ((response: WorkerMessage, request: RequestEnvelope) => WorkerMessage | 'drop' | undefined) | null;
  /** A hung worker: requests are swallowed and nothing is ever answered. */
  hang: boolean;
}

export async function createMemoryHarness(): Promise<MemoryHarness> {
  const sqlite3 = await loadSqlite3();
  const pool = new MemoryPool(sqlite3);
  const staging = new MemoryStaging();
  const log: MemoryHarness['log'] = [];
  const holds = new Map<string, { release: () => void; gate: Promise<void> }>();
  const harness: MemoryHarness = {
    sqlite3, pool, staging, cores: [], log, failBoot: null, intercept: null, hang: false,
    hold(op) {
      let release!: () => void;
      const gate = new Promise<void>((resolve) => { release = resolve; });
      holds.set(op, { release, gate });
      return () => { holds.delete(op); release(); };
    },
    workerFactory: () => {
      let dead = false;
      const listeners: { message: ((e: { data: unknown }) => void)[]; error: ((e: unknown) => void)[] } = { message: [], error: [] };
      const requests = new Map<number, RequestEnvelope>();
      const deliver = (original: WorkerMessage) => {
        let message = original;
        if (original.kind === 'response' && harness.intercept) {
          const out = harness.intercept(original, requests.get(original.requestId) as RequestEnvelope);
          if (out === 'drop') return;
          if (out) message = out;
        }
        const copy = structuredClone(message);
        setTimeout(() => { if (!dead) for (const l of listeners.message) l({ data: copy }); }, 0);
      };
      const core = new SqlWorkerCore({
        dev: true,
        post: (message) => deliver(message),
        yieldToLoop: () => new Promise((resolve) => setTimeout(resolve, 0)),
        boot: async (fault?: FaultSpec) => {
          if (fault?.initFail) throw Object.assign(new Error('injected'), { name: 'InjectedInitFailure' });
          const env: WorkerEnv = {
            sqlite3, pool, staging, strictPragmas: false,
            createSha256: async (): Promise<Sha256> => { const h = createHash('sha256'); return { update: (d) => { h.update(d); }, digest: () => h.digest('hex') }; },
            init: { sqliteVersion: sqlite3.version.libVersion, capacity: pool.capacity, fileCount: pool.files.size, wasmMemoryBytes: null, timings: { poolReadyMs: 1, probeMs: 1 } }
          };
          return env;
        }
      });
      harness.cores.push(core);
      queueMicrotask(() => { if (!dead) for (const l of listeners.message) l({ data: { kind: 'ready', protocol: 1 } }); });
      return {
        postMessage: (message) => {
          const request = structuredClone(message) as RequestEnvelope;
          log.push({ op: request.op, dbId: request.dbId, requestId: request.requestId });
          requests.set(request.requestId, request);
          if (harness.hang) return;
          setTimeout(() => {
            if (dead) return;
            const held = holds.get(request.op);
            void (held ? held.gate : Promise.resolve()).then(() => { if (!dead) void core.handle(request); });
          }, 0);
        },
        terminate: () => { dead = true; },
        addEventListener: ((type: string, listener: (e: never) => void) => {
          if (type === 'message') listeners.message.push(listener as never);
          else listeners.error.push(listener as never);
        }) as WorkerLike['addEventListener']
      };
    }
  };
  return harness;
}
