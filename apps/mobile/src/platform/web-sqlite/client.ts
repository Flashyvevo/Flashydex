/**
 * Main-thread client for the SQL worker: spawns/supervises the worker, speaks protocol v1, and owns ONE physical connection per path
 * with refcounted logical SqlDriver wrappers, one admission queue per physical connection and per-connection transaction ownership.
 */
import type { SqlDriver } from '@flashydex/core';
import {
  CATALOG_PATH_RE, POOL_DIRECTORY, POOL_VFS_NAME, PROBE_PATH_RE, SQLITE_WASM_PACKAGE_VERSION, USER_PATH_RE, WebStorageError,
  type ImportFromStagingInput, type ImportFromStagingResult, type OpenDriverOptions, type PoolPath, type WebSqliteClient, type WebSqliteInitInfo,
  type WebSqliteStats, type WebStorageErrorCode
} from '../web-storage/contract';
import { sqlVerb } from './executor';
import {
  fromWire, PROTOCOL, type BatchPayload, type BatchResult, type FaultSpec, type ImportResult, type InitResult, type OpenResult, type ProxyMethod,
  type RequestEnvelope, type StatsResult, type WireError, type WorkerMessage
} from './protocol';

/** The slice of `Worker` the client needs (real Worker in the browser, an in-process loopback in Node tests). */
export interface WorkerLike {
  postMessage(message: unknown, transfer?: Transferable[]): void;
  terminate(): void;
  addEventListener(type: 'message', listener: (event: { data: unknown }) => void): void;
  addEventListener(type: 'error' | 'messageerror', listener: (event: unknown) => void): void;
}

export interface WebSqliteClientOptions {
  workerFactory?: () => WorkerLike;
  /** DEV only: applied to the first init of every worker this client spawns (e.g. `initFail`). */
  fault?: FaultSpec;
  readyTimeoutMs?: number;
}

export interface MessageStats {
  messages: number;
  maxBufferBytes: number;
}

export interface WebSqliteClientInternal extends WebSqliteClient {
  /** One-time USER migration only (<= 16 MiB, chunked into the pool inside the worker). Never for catalogs. */
  importBytes(target: PoolPath, bytes: Uint8Array, expectedSha256: string): Promise<ImportResult>;
  /** DEV/test seams. They throw outside DEV builds. */
  __terminateWorker(): void;
  __setFault(fault: FaultSpec): Promise<void>;
  __exportFile(path: PoolPath): Promise<Uint8Array>;
  __messageStats(reset?: boolean): MessageStats;
}

export function defaultWorkerFactory(): WorkerLike {
  return new Worker(new URL('./sql.worker.ts', import.meta.url), { type: 'module', name: 'flashydex-sql' }) as unknown as WorkerLike;
}

const DEFAULT_CACHE_KIB = { user: 2048, catalog: 4096, validation: 32768 } as const;
const WRITE_VERBS = new Set(['INSERT', 'UPDATE', 'DELETE', 'REPLACE', 'CREATE', 'DROP', 'ALTER', 'BEGIN', 'COMMIT', 'END', 'VACUUM', 'REINDEX', 'ANALYZE']);

class RemoteError extends WebStorageError {
  constructor(wire: WireError) {
    const e = fromWire(wire);
    super(e.code, e.message, e.details);
    this.inTransaction = wire.inTransaction;
  }
  inTransaction: boolean | undefined;
}

interface Pending {
  op: string;
  resolve(value: unknown): void;
  reject(error: unknown): void;
  onProgress?: (bytes: number) => void;
}

interface Item {
  wrapper: LogicalDriver | null;
  /** Control work that must run even while another wrapper owns a transaction (reopen after worker death, barriers). */
  bypassOwner: boolean;
  run(): Promise<unknown>;
  resolve(value: unknown): void;
  reject(error: unknown): void;
}

interface Physical {
  path: PoolPath;
  mode: 'rw' | 'ro';
  role: OpenDriverOptions['role'];
  cacheKiB: number;
  dbId: number | null;
  stale: boolean;
  closing: boolean;
  owner: LogicalDriver | null;
  queue: Item[];
  pumping: boolean;
  wrappers: Set<LogicalDriver>;
}

function maxBufferBytes(value: unknown, depth = 0): number {
  if (value === null || typeof value !== 'object' || depth > 5) return 0;
  if (value instanceof ArrayBuffer) return value.byteLength;
  if (ArrayBuffer.isView(value)) return value.buffer.byteLength;
  let max = 0;
  for (const child of Array.isArray(value) ? value : Object.values(value)) max = Math.max(max, maxBufferBytes(child, depth + 1));
  return max;
}

const mark = (name: string): void => {
  try {
    performance.mark(name);
  } catch {
    /* performance marks are best-effort */
  }
};

class LogicalDriver implements SqlDriver {
  invalid = false;
  closed = false;
  latched: { code: WebStorageErrorCode } | null = null;
  commitStartedAt: number | null = null;
  readonly afterCommit?: () => Promise<void>;
  readonly reopen?: () => Promise<void>;

  constructor(readonly label: string, readonly physical: Physical, private readonly client: WebSqliteClientImpl, readonly mode: 'rw' | 'ro') {
    if (mode === 'rw') {
      this.afterCommit = () => client.barrier(this);
      this.reopen = () => client.reopenPhysical(this.physical, this);
    }
  }

  readonly proxy = async (sql: string, params: unknown[], method: ProxyMethod): Promise<{ rows: unknown[] }> => {
    if (this.invalid || this.closed) throw new WebStorageError('STALE_SESSION', 'This storage handle was closed', { commitState: 'not_started' });
    const verb = sqlVerb(sql);
    const write = WRITE_VERBS.has(verb);
    if (write && this.mode === 'ro') throw new WebStorageError('SQLITE', 'This handle is read-only', { commitState: 'not_started' });
    if (write && this.latched) {
      throw new WebStorageError(this.latched.code, 'Writes are latched after a storage failure; reopen the database', { commitState: 'not_started' });
    }
    if (verb === 'COMMIT' || verb === 'END') this.commitStartedAt = performance.now();
    return this.client.enqueueExec(this.physical, this, { sql, params, method });
  };

  close(): Promise<void> {
    return this.client.closeWrapper(this);
  }
}

export class WebSqliteClientImpl implements WebSqliteClientInternal {
  private worker: WorkerLike | null = null;
  private sessionId: string | null = null;
  private initPromise: Promise<WebSqliteInitInfo> | null = null;
  private nextRequestId = 1;
  private readonly pending = new Map<number, Pending>();
  private readonly physicals = new Map<PoolPath, Physical>();
  private readonly importing = new Set<PoolPath>();
  private lastError: { code: WebStorageErrorCode; at: string } | null = null;
  private workerStartedAt = 0;
  private readyResolve: (() => void) | null = null;
  private readyReject: ((error: unknown) => void) | null = null;
  private msgStats: MessageStats = { messages: 0, maxBufferBytes: 0 };

  constructor(private readonly options: WebSqliteClientOptions = {}) {}

  // ───────────────────────── session ─────────────────────────
  init(): Promise<WebSqliteInitInfo> {
    this.initPromise ??= this.startSession().catch((error) => {
      this.initPromise = null;
      this.teardownWorker();
      throw error;
    });
    return this.initPromise;
  }

  private async startSession(): Promise<WebSqliteInitInfo> {
    const factory = this.options.workerFactory ?? defaultWorkerFactory;
    let worker: WorkerLike;
    try {
      worker = factory();
    } catch (error) {
      throw new WebStorageError('STORAGE_UNAVAILABLE', 'Web Workers are not available in this browser', { cause: error });
    }
    this.worker = worker;
    this.sessionId = (globalThis.crypto?.randomUUID?.() ?? `s-${Date.now().toString(36)}-${Math.random().toString(36).slice(2)}`);
    this.workerStartedAt = performance.now();
    let timer: ReturnType<typeof setTimeout> | undefined;
    const ready = new Promise<void>((resolve, reject) => {
      this.readyResolve = resolve;
      this.readyReject = reject;
      timer = setTimeout(() => reject(new WebStorageError('INIT_FAILED', 'The storage worker did not start')), this.options.readyTimeoutMs ?? 30_000);
    });
    worker.addEventListener('message', (event) => this.onMessage(worker, event.data as WorkerMessage));
    worker.addEventListener('error', () => {
      this.handleDeath(worker, 'The storage worker crashed');
    });
    worker.addEventListener('messageerror', () => {
      this.handleDeath(worker, 'The storage worker sent an unreadable message');
    });
    try {
      await ready;
    } finally {
      clearTimeout(timer);
    }
    const workerReadyMs = performance.now() - this.workerStartedAt;
    mark('fdx:web-worker-ready');
    const result = (await this.send('init', { protocol: PROTOCOL, ...(import.meta.env.DEV && this.options.fault ? { fault: this.options.fault } : {}) }).promise) as InitResult;
    mark('fdx:web-pool-ready');
    return {
      packageVersion: SQLITE_WASM_PACKAGE_VERSION,
      sqliteVersion: result.sqliteVersion,
      vfs: POOL_VFS_NAME,
      poolDirectory: POOL_DIRECTORY,
      capacity: result.capacity,
      fileCount: result.fileCount,
      sessionId: this.sessionId as string,
      timings: { workerReadyMs, poolReadyMs: result.timings.poolReadyMs, probeMs: result.timings.probeMs }
    };
  }

  private teardownWorker(): void {
    const worker = this.worker;
    this.worker = null;
    this.sessionId = null;
    this.readyResolve = null;
    this.readyReject = null;
    try {
      worker?.terminate();
    } catch {
      /* already gone */
    }
  }

  private onMessage(source: WorkerLike, message: WorkerMessage): void {
    if (source !== this.worker) return; // a message from a worker we already discarded
    this.msgStats.messages += 1;
    this.msgStats.maxBufferBytes = Math.max(this.msgStats.maxBufferBytes, maxBufferBytes(message));
    if (message.kind === 'ready') {
      this.readyResolve?.();
      this.readyResolve = null;
      return;
    }
    if (message.sessionId !== this.sessionId) return;
    const pending = this.pending.get(message.requestId);
    if (!pending) return;
    if (message.kind === 'progress') {
      pending.onProgress?.(message.bytes);
      return;
    }
    this.pending.delete(message.requestId);
    if (message.ok) {
      pending.resolve(message.payload);
    } else {
      this.lastError = { code: message.error.code, at: new Date().toISOString() };
      pending.reject(new RemoteError(message.error));
    }
  }

  /** Worker crash/termination: every in-flight request is `unknown`, queued ones never started; writes latch; nothing is replayed. */
  private handleDeath(source: WorkerLike, why: string): void {
    if (source !== this.worker) return;
    this.readyReject?.(new WebStorageError('INIT_FAILED', why));
    this.teardownWorker();
    this.initPromise = null;
    this.lastError = { code: 'WORKER_DIED', at: new Date().toISOString() };
    const inFlight = [...this.pending.values()];
    this.pending.clear();
    for (const p of inFlight) p.reject(new WebStorageError('WORKER_DIED', why, { commitState: 'unknown', retryable: true }));
    for (const physical of this.physicals.values()) {
      physical.stale = true;
      physical.dbId = null;
      physical.owner = null;
      for (const wrapper of physical.wrappers) if (wrapper.mode === 'rw') wrapper.latched = { code: 'WORKER_DIED' };
      this.failQueue(physical, new WebStorageError('WORKER_DIED', why, { commitState: 'not_started', retryable: true }));
    }
  }

  private failQueue(physical: Physical, error: WebStorageError): void {
    const items = physical.queue.splice(0);
    for (const item of items) item.reject(error);
  }

  private send(op: RequestEnvelope['op'], payload: unknown, options: { dbId?: number; transfer?: Transferable[]; onProgress?: (bytes: number) => void } = {}): { id: number; promise: Promise<unknown> } {
    const worker = this.worker;
    if (!worker || this.sessionId === null) {
      return { id: 0, promise: Promise.reject(new WebStorageError('STALE_SESSION', 'The storage worker is not running', { commitState: 'not_started' })) };
    }
    const id = this.nextRequestId++;
    const envelope: RequestEnvelope = { protocol: PROTOCOL, sessionId: this.sessionId, requestId: id, op, ...(options.dbId !== undefined ? { dbId: options.dbId } : {}), payload };
    this.msgStats.messages += 1;
    this.msgStats.maxBufferBytes = Math.max(this.msgStats.maxBufferBytes, maxBufferBytes(envelope));
    const promise = new Promise<unknown>((resolve, reject) => {
      this.pending.set(id, { op, resolve, reject, onProgress: options.onProgress });
    });
    try {
      worker.postMessage(envelope, options.transfer);
    } catch (error) {
      this.pending.delete(id);
      return { id, promise: Promise.reject(new WebStorageError('IO', 'The storage worker rejected a message', { cause: error, commitState: 'not_started' })) };
    }
    return { id, promise };
  }

  private request<T>(op: RequestEnvelope['op'], payload: unknown, dbId?: number): Promise<T> {
    return this.send(op, payload, { dbId }).promise as Promise<T>;
  }

  // ───────────────────────── drivers ─────────────────────────
  async driver(path: PoolPath, label: string, options: OpenDriverOptions): Promise<SqlDriver> {
    assertPoolPath(path);
    if (this.importing.has(path)) throw new WebStorageError('BUSY', 'That path is being imported', { retryable: true });
    await this.init();
    let physical = this.physicals.get(path);
    if (physical?.closing) throw new WebStorageError('BUSY', 'That path is closing', { retryable: true });
    if (!physical) {
      physical = {
        path, mode: options.mode, role: options.role, cacheKiB: options.cacheKiB ?? DEFAULT_CACHE_KIB[options.role], dbId: null, stale: false, closing: false,
        owner: null, queue: [], pumping: false, wrappers: new Set()
      };
      const result = await this.request<OpenResult>('open', { path, mode: options.mode, create: options.create, role: options.role, cacheKiB: physical.cacheKiB });
      physical.dbId = result.dbId;
      const raced = this.physicals.get(path);
      if (raced) {
        // another caller opened the same path while we awaited: the worker refuses a second open (BUSY above), so this is unreachable
        throw new WebStorageError('BUSY', 'That path is already open', { retryable: true });
      }
      this.physicals.set(path, physical);
    } else if (options.mode === 'rw' && physical.mode === 'ro') {
      const upgrade = physical;
      await this.enqueueControl(upgrade, null, false, async () => {
        const result = await this.request<OpenResult>('reopen', { mode: 'rw' }, upgrade.dbId as number);
        upgrade.dbId = result.dbId;
        upgrade.mode = 'rw';
      });
    }
    const wrapper = new LogicalDriver(label, physical, this, options.mode);
    physical.wrappers.add(wrapper);
    return wrapper;
  }

  enqueueExec(physical: Physical, wrapper: LogicalDriver, statement: { sql: string; params: unknown[]; method: ProxyMethod }): Promise<{ rows: unknown[] }> {
    if (physical.closing) return Promise.reject(new WebStorageError('STALE_SESSION', 'That path is closing', { commitState: 'not_started' }));
    return this.enqueue(physical, {
      wrapper,
      bypassOwner: false,
      run: async () => {
        await this.ensureUsable(physical, wrapper);
        try {
          const result = await this.request<{ rows: unknown[]; inTransaction: boolean }>('exec', statement, physical.dbId as number);
          this.noteTransaction(physical, wrapper, result.inTransaction);
          return { rows: result.rows };
        } catch (error) {
          if (error instanceof RemoteError && error.inTransaction !== undefined) this.noteTransaction(physical, wrapper, error.inTransaction);
          if (error instanceof WebStorageError && error.code === 'WORKER_DIED' && wrapper.mode === 'rw') wrapper.latched = { code: 'WORKER_DIED' };
          throw error;
        }
      }
    }) as Promise<{ rows: unknown[] }>;
  }

  private noteTransaction(physical: Physical, wrapper: LogicalDriver, inTransaction: boolean): void {
    if (!inTransaction) physical.owner = null;
    else if (physical.owner === null) physical.owner = wrapper; // the BEGIN that just ran belongs to this wrapper
  }

  private async ensureUsable(physical: Physical, wrapper: LogicalDriver): Promise<void> {
    if (wrapper.invalid) throw new WebStorageError('STALE_SESSION', 'This storage handle was closed', { commitState: 'not_started' });
    if (!physical.stale && physical.dbId !== null) return;
    // read-only paths recover on their own (nothing was written through them); a writable path needs an explicit reopen()
    const writable = [...physical.wrappers].some((w) => w.mode === 'rw');
    if (!writable && physical.stale) {
      await this.reopenInner(physical);
      return;
    }
    throw new WebStorageError(wrapper.latched?.code ?? 'STALE_SESSION', 'The storage session ended; reopen the database', { commitState: 'not_started', retryable: true });
  }

  private enqueue(physical: Physical, item: Omit<Item, 'resolve' | 'reject'>): Promise<unknown> {
    return new Promise((resolve, reject) => {
      physical.queue.push({ ...item, resolve, reject });
      void this.pump(physical);
    });
  }

  private enqueueControl(physical: Physical, wrapper: LogicalDriver | null, bypassOwner: boolean, run: () => Promise<unknown>): Promise<unknown> {
    return this.enqueue(physical, { wrapper, bypassOwner, run });
  }

  /** One admission queue per physical connection; while a wrapper owns a transaction only its statements (and control items) run. */
  private async pump(physical: Physical): Promise<void> {
    if (physical.pumping) return;
    physical.pumping = true;
    try {
      for (;;) {
        const index = physical.owner ? physical.queue.findIndex((i) => i.wrapper === physical.owner || i.bypassOwner) : physical.queue.length > 0 ? 0 : -1;
        if (index < 0) break;
        const [item] = physical.queue.splice(index, 1) as [Item];
        try {
          item.resolve(await item.run());
        } catch (error) {
          item.reject(error);
        }
      }
    } finally {
      physical.pumping = false;
    }
  }

  async barrier(wrapper: LogicalDriver): Promise<void> {
    const physical = wrapper.physical;
    const started = wrapper.commitStartedAt;
    try {
      await this.enqueue(physical, {
        wrapper,
        bypassOwner: true,
        run: async () => {
          if (wrapper.invalid) throw new WebStorageError('STALE_SESSION', 'This storage handle was closed', { commitState: 'unknown' });
          if (physical.stale || physical.dbId === null) throw new WebStorageError('WORKER_DIED', 'The storage session ended before the commit was confirmed', { commitState: 'unknown' });
          try {
            return await this.request('durableBarrier', {}, physical.dbId);
          } catch (error) {
            throw error instanceof WebStorageError ? new WebStorageError(error.code, error.message, { ...error.details, commitState: 'unknown' }) : error;
          }
        }
      });
    } catch (error) {
      wrapper.latched = { code: error instanceof WebStorageError ? error.code : 'IO' };
      throw error;
    }
    if (started !== null) {
      try {
        performance.measure('fdx:web-commit', { start: started, end: performance.now() });
      } catch {
        /* best effort */
      }
      wrapper.commitStartedAt = null;
    }
  }

  async reopenPhysical(physical: Physical, wrapper: LogicalDriver): Promise<void> {
    if (wrapper.invalid) throw new WebStorageError('STALE_SESSION', 'This storage handle was closed');
    await this.enqueueControl(physical, wrapper, true, () => this.reopenInner(physical));
    for (const w of physical.wrappers) w.latched = null;
  }

  private async reopenInner(physical: Physical): Promise<void> {
    await this.init(); // a new worker/session after a crash; storage is re-probed, never wiped
    if (physical.dbId !== null && !physical.stale) {
      const result = await this.request<OpenResult>('reopen', {}, physical.dbId);
      physical.dbId = result.dbId;
    } else {
      const result = await this.request<OpenResult>('open', { path: physical.path, mode: physical.mode, create: false, role: physical.role, cacheKiB: physical.cacheKiB });
      physical.dbId = result.dbId;
    }
    physical.stale = false;
    physical.owner = null;
  }

  async closeWrapper(wrapper: LogicalDriver): Promise<void> {
    if (wrapper.closed || wrapper.invalid) return;
    wrapper.closed = true;
    const physical = wrapper.physical;
    physical.wrappers.delete(wrapper);
    if (physical.owner === wrapper && physical.dbId !== null && !physical.stale) {
      // never leave an open transaction owned by a handle that is gone
      await this.enqueue(physical, {
        wrapper,
        bypassOwner: false,
        run: () => this.request('exec', { sql: 'ROLLBACK', params: [], method: 'run' }, physical.dbId as number).then(() => { physical.owner = null; })
      }).catch(() => { physical.owner = null; });
    }
    if (physical.wrappers.size === 0) await this.closePath(physical.path);
  }

  async closePath(path: PoolPath): Promise<void> {
    const physical = this.physicals.get(path);
    if (!physical) return;
    physical.closing = true;
    try {
      await this.enqueueControl(physical, null, false, async () => {
        if (physical.dbId !== null && !physical.stale && this.worker) {
          try {
            await this.request('close', {}, physical.dbId);
          } catch (error) {
            if (!(error instanceof WebStorageError && (error.code === 'WORKER_DIED' || error.code === 'STALE_SESSION' || error.code === 'NOT_FOUND'))) throw error;
          }
        }
      });
    } finally {
      for (const w of physical.wrappers) w.invalid = true;
      physical.wrappers.clear();
      this.physicals.delete(path);
    }
  }

  // ───────────────────────── import ─────────────────────────
  async importFromStaging(input: ImportFromStagingInput): Promise<ImportFromStagingResult> {
    if (!CATALOG_PATH_RE.test(input.target)) throw new WebStorageError('INVALID_PATH', 'Imports target a catalog path');
    if (!input.source?.job || !input.source?.name) throw new WebStorageError('INVALID_PATH', 'Missing staging reference');
    if (!Number.isInteger(input.expectedBytes) || input.expectedBytes <= 0) throw new WebStorageError('INTEGRITY', 'Invalid expected size');
    if (!/^[0-9a-f]{64}$/.test(input.expectedSha256)) throw new WebStorageError('INTEGRITY', 'Invalid expected hash');
    if (input.signal?.aborted) throw new WebStorageError('CANCELLED', 'The import was cancelled');
    return this.runImport(input.target, 'stageImport', { job: input.source.job, name: input.source.name, target: input.target, expectedBytes: input.expectedBytes, expectedSha256: input.expectedSha256 }, input.signal, input.onProgress);
  }

  async importBytes(target: PoolPath, bytes: Uint8Array, expectedSha256: string): Promise<ImportResult> {
    if (!USER_PATH_RE.test(target)) throw new WebStorageError('INVALID_PATH', 'Byte imports are only for the one-time USER migration');
    // Transferred, not copied: the caller's array is detached afterwards, so the legacy bytes are released on this side.
    const own = bytes.byteOffset === 0 && bytes.byteLength === bytes.buffer.byteLength ? bytes : bytes.slice();
    return this.runImport(target, 'importBytes', { target, bytes: own, expectedSha256 }, undefined, undefined, [own.buffer as ArrayBuffer]);
  }

  private async runImport(target: PoolPath, op: 'stageImport' | 'importBytes', payload: unknown, signal?: AbortSignal, onProgress?: (n: number) => void, transfer?: Transferable[]): Promise<ImportResult> {
    await this.init();
    if (this.physicals.has(target) || this.importing.has(target)) throw new WebStorageError('BUSY', 'That path is open or already being imported', { retryable: true });
    this.importing.add(target);
    const sent = this.send(op, payload, { onProgress, transfer });
    const onAbort = () => { void this.send('cancel', { targetRequestId: sent.id }).promise.catch(() => undefined); };
    signal?.addEventListener('abort', onAbort, { once: true });
    try {
      return (await sent.promise) as ImportResult;
    } finally {
      signal?.removeEventListener('abort', onAbort);
      this.importing.delete(target);
    }
  }

  // ───────────────────────── housekeeping ─────────────────────────
  async unlink(path: PoolPath): Promise<boolean> {
    assertPoolPath(path);
    if (this.physicals.has(path) || this.importing.has(path)) throw new WebStorageError('BUSY', 'The file is open or being imported', { retryable: true });
    await this.init();
    return ((await this.request<{ removed: boolean }>('unlink', { path })).removed);
  }

  async listFiles(): Promise<PoolPath[]> {
    await this.init();
    return (await this.request<{ files: string[] }>('list', {})).files;
  }

  async ensureCapacity(minFreeSlots: number): Promise<{ capacity: number; fileCount: number }> {
    await this.init();
    return this.request('ensureCapacity', { minFreeSlots });
  }

  async stats(): Promise<WebSqliteStats> {
    const openPaths = [...this.physicals.values()].map((p) => ({ path: p.path, refs: p.wrappers.size, inTransaction: p.owner !== null }));
    if (!this.worker || this.sessionId === null) {
      return { sessionId: null, capacity: null, fileCount: null, files: [], openPaths, wasmMemoryBytes: null, workerHeapUsedBytes: null, lastError: this.lastError, unavailable: { worker: 'The storage worker is not running' } };
    }
    const r = await this.request<StatsResult>('storageStats', {});
    return { sessionId: this.sessionId, capacity: r.capacity, fileCount: r.fileCount, files: r.files, openPaths, wasmMemoryBytes: r.wasmMemoryBytes, workerHeapUsedBytes: r.workerHeapUsedBytes, lastError: this.lastError, unavailable: r.unavailable };
  }

  async shutdown(): Promise<void> {
    for (const path of [...this.physicals.keys()]) await this.closePath(path).catch(() => undefined);
    if (this.worker && this.sessionId !== null) await this.request('shutdown', {}).catch(() => undefined);
    for (const p of this.pending.values()) p.reject(new WebStorageError('CANCELLED', 'Storage shut down'));
    this.pending.clear();
    this.teardownWorker();
    this.initPromise = null;
  }

  // ───────────────────────── DEV/test seams ─────────────────────────
  private requireDev(): void {
    if (!import.meta.env.DEV) throw new WebStorageError('INVALID_PATH', 'Test seams are disabled in production builds');
  }

  __terminateWorker(): void {
    this.requireDev();
    const worker = this.worker;
    if (worker) {
      try {
        worker.terminate();
      } catch {
        /* ignore */
      }
      this.handleDeath(worker, 'The storage worker was terminated');
    }
  }

  async __setFault(fault: FaultSpec): Promise<void> {
    this.requireDev();
    await this.init();
    await this.request('fault', fault);
  }

  async __exportFile(path: PoolPath): Promise<Uint8Array> {
    this.requireDev();
    await this.init();
    return (await this.request<{ bytes: Uint8Array }>('exportFile', { path })).bytes;
  }

  __messageStats(reset = false): MessageStats {
    const snapshot = { ...this.msgStats };
    if (reset) this.msgStats = { messages: 0, maxBufferBytes: 0 };
    return snapshot;
  }
}

function assertPoolPath(path: string): void {
  if (!(USER_PATH_RE.test(path) || CATALOG_PATH_RE.test(path) || PROBE_PATH_RE.test(path))) throw new WebStorageError('INVALID_PATH', 'Not a valid FlashyDex pool path');
}

export function createWebSqliteClient(options: WebSqliteClientOptions = {}): WebSqliteClientInternal {
  return new WebSqliteClientImpl(options);
}

let singleton: WebSqliteClientInternal | undefined;
export function getWebSqliteClient(): WebSqliteClientInternal {
  singleton ??= createWebSqliteClient();
  return singleton;
}

export type { BatchPayload, BatchResult };
