/**
 * Worker-side request handler (protocol v1). Environment-agnostic: the real worker (sql.worker.ts) injects the sahpool + OPFS staging,
 * Node tests inject an in-memory pool. Every admitted request gets exactly ONE terminal response.
 */
import { CATALOG_PATH_RE, PROBE_PATH_RE, USER_PATH_RE, WebStorageError, type WebStorageErrorCode } from '../web-storage/contract';
import { inTransaction, mapSqliteError, runStatement, sqlVerb, type Oo1Db, type Sqlite3Api } from './executor';
import {
  BATCH_MAX_BYTES, BATCH_MAX_STATEMENTS, IMPORT_CHUNK_BYTES, PROTOCOL, wireError,
  type BatchPayload, type BatchResult, type ExecResult, type FaultSpec, type ImportBytesPayload, type ImportResult, type InitPayload,
  type InitResult, type OpenPayload, type OpenResult, type RequestEnvelope, type StageImportPayload, type StatsResult, type Statement, type WorkerMessage, type WireError
} from './protocol';

export interface PoolDbCtor {
  new (path: string, flags?: string): unknown;
}

/** The slice of `SAHPoolUtil` this worker uses. */
export interface PoolLike {
  OpfsSAHPoolDb: PoolDbCtor;
  getCapacity(): number;
  getFileCount(): number;
  getFileNames(): string[];
  reserveMinimumCapacity(n: number): Promise<number>;
  unlink(name: string): boolean;
  importDb(name: string, supplier: () => Promise<Uint8Array | ArrayBuffer | undefined>): Promise<number>;
  exportFile(name: string): Uint8Array;
}

export interface StagingFile {
  size: number;
  /** Synchronous positional read; returns bytes read. */
  read(buffer: Uint8Array, at: number): number;
  close(): void;
}

export interface Sha256 {
  update(data: Uint8Array): void;
  digest(): string;
}

export interface WorkerEnv {
  sqlite3: Sqlite3Api;
  pool: PoolLike;
  staging: { open(job: string, name: string): Promise<StagingFile> };
  createSha256(): Promise<Sha256>;
  /** Real worker: verify journal_mode=delete etc. Node (in-memory) tests: false. */
  strictPragmas: boolean;
  init: InitResult;
}

export interface CoreOptions {
  boot(fault: FaultSpec | undefined): Promise<WorkerEnv>;
  post(message: WorkerMessage, transfer?: Transferable[]): void;
  yieldToLoop(): Promise<void>;
  /** Only true in DEV builds / tests: enables the `fault` and `exportFile` ops. */
  dev: boolean;
  heapUsedBytes?: () => number | null;
  now?: () => number;
  /** SQLite progress-handler granularity in VM steps (default 20 000 ≈ a few ms of stepping). */
  progressOps?: number;
  /** Minimum gap between `heartbeat` messages while a statement runs (default 250 ms). */
  heartbeatMs?: number;
}

interface DbEntry {
  dbId: number;
  path: string;
  db: Oo1Db;
  mode: 'rw' | 'ro';
  role: OpenPayload['role'];
  cacheKiB: number;
}

const SQLITE_JOURNAL = /-(journal|wal|shm)$/;
const PROGRESS_OPS = 20_000;
const HEARTBEAT_MS = 250;
const STAGING_NAME_RE = /^[A-Za-z0-9][A-Za-z0-9._-]{0,127}$/;

function assertPath(path: unknown): asserts path is string {
  if (typeof path !== 'string' || !(USER_PATH_RE.test(path) || CATALOG_PATH_RE.test(path) || PROBE_PATH_RE.test(path))) {
    throw new WebStorageError('INVALID_PATH', 'Not a valid FlashyDex pool path');
  }
}

export class SqlWorkerCore {
  private sessionId: string | null = null;
  private env: WorkerEnv | null = null;
  private readonly dbs = new Map<number, DbEntry>();
  private readonly byPath = new Map<string, number>();
  private readonly imports = new Set<string>();
  private readonly aborts = new Map<number, AbortController>();
  private nextDbId = 1;
  private faults: FaultSpec = {};
  private initPromise: Promise<void> | null = null;
  private readonly now: () => number;

  constructor(private readonly options: CoreOptions) {
    this.now = options.now ?? (() => performance.now());
  }

  /** Entry point for every incoming request message. Never throws. */
  async handle(request: RequestEnvelope): Promise<void> {
    const started = this.now();
    try {
      if (request.protocol !== PROTOCOL) throw new WebStorageError('PROTOCOL_MISMATCH', `Worker speaks protocol ${PROTOCOL}, request used ${String(request.protocol)}`);
      if (request.op !== 'init') {
        if (this.sessionId === null || this.env === null || request.sessionId !== this.sessionId) {
          throw new WebStorageError('STALE_SESSION', 'The storage session changed; reopen storage', { retryable: false });
        }
      }
      const payload = await this.dispatch(request);
      this.options.post({ kind: 'response', protocol: PROTOCOL, sessionId: request.sessionId, requestId: request.requestId, ok: true, payload, timings: { execMs: this.now() - started } });
    } catch (error) {
      const e = this.toWire(error, request);
      this.options.post({ kind: 'response', protocol: PROTOCOL, sessionId: request.sessionId, requestId: request.requestId, ok: false, error: e, timings: { execMs: this.now() - started } });
    } finally {
      this.aborts.delete(request.requestId);
    }
  }

  private toWire(error: unknown, request: RequestEnvelope): WireError {
    const mapped = error instanceof WebStorageError ? error : mapAnyError(error);
    const wire = wireError(mapped);
    const entry = request.dbId !== undefined ? this.dbs.get(request.dbId) : undefined;
    if (entry?.db.isOpen()) wire.inTransaction = inTransaction(this.sqlite3, entry.db);
    return wire;
  }

  private get sqlite3(): Sqlite3Api {
    return (this.env as WorkerEnv).sqlite3;
  }

  private get pool(): PoolLike {
    return (this.env as WorkerEnv).pool;
  }

  private entry(request: RequestEnvelope): DbEntry {
    const entry = request.dbId === undefined ? undefined : this.dbs.get(request.dbId);
    if (!entry) throw new WebStorageError('NOT_FOUND', 'Unknown database handle');
    return entry;
  }

  private async dispatch(request: RequestEnvelope): Promise<unknown> {
    switch (request.op) {
      case 'init': return this.init(request);
      case 'open': return this.open(request.payload as OpenPayload);
      case 'exec': return this.exec(this.entry(request), request.payload as Statement);
      case 'batch': return this.batch(this.entry(request), request.payload as BatchPayload);
      case 'durableBarrier': return this.barrier(this.entry(request));
      case 'reopen': return this.reopen(this.entry(request), request.payload as { mode?: 'rw' | 'ro' } | undefined);
      case 'close': return this.close(this.entry(request));
      case 'cancel': return this.cancel(request.payload as { targetRequestId: number });
      case 'stageImport': return this.stageImport(request, request.payload as StageImportPayload);
      case 'importBytes': return this.importBytes(request, request.payload as ImportBytesPayload);
      case 'ping': return { pong: true };
      case 'storageStats': return this.stats();
      case 'shutdown': return this.shutdown();
      case 'unlink': return this.unlink((request.payload as { path: string }).path);
      case 'list': return { files: this.listFiles() };
      case 'ensureCapacity': return this.ensureCapacity((request.payload as { minFreeSlots: number }).minFreeSlots);
      case 'fault':
        if (!this.options.dev) throw new WebStorageError('INVALID_PATH', 'Unknown operation');
        this.faults = { ...(request.payload as FaultSpec) };
        return { ok: true };
      case 'exportFile':
        if (!this.options.dev) throw new WebStorageError('INVALID_PATH', 'Unknown operation');
        return this.exportFile((request.payload as { path: string }).path);
      default:
        throw new WebStorageError('INVALID_PATH', 'Unknown operation');
    }
  }

  // ───────────────────────── lifecycle ─────────────────────────
  private async init(request: RequestEnvelope): Promise<InitResult> {
    const payload = request.payload as InitPayload;
    if (payload.protocol !== PROTOCOL) throw new WebStorageError('PROTOCOL_MISMATCH', `Worker speaks protocol ${PROTOCOL}`);
    if (this.sessionId !== null && this.env !== null) {
      if (this.sessionId !== request.sessionId) throw new WebStorageError('STALE_SESSION', 'Worker already belongs to another session');
      return { ...this.env.init, ...this.counts() };
    }
    this.initPromise ??= (async () => {
      if (this.options.dev && payload.fault) this.faults = { ...payload.fault };
      this.sessionId = request.sessionId;
      try {
        this.env = await this.options.boot(this.options.dev ? this.faults : undefined);
      } catch (error) {
        this.sessionId = null;
        this.initPromise = null;
        throw error;
      }
    })();
    await this.initPromise;
    return { ...(this.env as WorkerEnv).init, ...this.counts() };
  }

  private counts(): { capacity: number; fileCount: number; wasmMemoryBytes: number | null } {
    return { capacity: this.pool.getCapacity(), fileCount: this.pool.getFileCount(), wasmMemoryBytes: this.wasmBytes() };
  }

  private wasmBytes(): number | null {
    try {
      return this.sqlite3.wasm.heap8u().buffer.byteLength;
    } catch {
      return null;
    }
  }

  private listFiles(): string[] {
    return this.pool.getFileNames().filter((name) => !SQLITE_JOURNAL.test(name));
  }

  // ───────────────────────── open / close ─────────────────────────
  private open(payload: OpenPayload): OpenResult {
    assertPath(payload.path);
    if (this.byPath.has(payload.path) || this.imports.has(payload.path)) throw new WebStorageError('BUSY', 'That database is already open or being imported', { retryable: true });
    const exists = this.pool.getFileNames().includes(payload.path);
    if (!exists && !payload.create) throw new WebStorageError('NOT_FOUND', 'That database file does not exist');
    if (payload.create && payload.mode === 'ro') throw new WebStorageError('INVALID_PATH', 'A read-only handle cannot create a file');
    const flags = payload.mode === 'ro' ? 'r' : payload.create ? 'cw' : 'w';
    let db: Oo1Db | undefined;
    try {
      db = new this.pool.OpfsSAHPoolDb(payload.path, flags) as unknown as Oo1Db;
      const pragmas = this.applyPragmas(db, payload);
      const dbId = this.nextDbId++;
      this.dbs.set(dbId, { dbId, path: payload.path, db, mode: payload.mode, role: payload.role, cacheKiB: payload.cacheKiB });
      this.byPath.set(payload.path, dbId);
      return { dbId, pragmas };
    } catch (error) {
      try {
        db?.close();
      } catch {
        /* closing a half-open handle must not mask the original error */
      }
      throw error instanceof WebStorageError ? error : mapSqliteError(error);
    }
  }

  private lastHeartbeatAt = Number.NEGATIVE_INFINITY;

  /**
   * S6-01: SQLite calls this every `progressOps` VM steps (and per page during integrity_check) from INSIDE sqlite3_step, i.e. while the
   * worker cannot service its event loop. A throttled `heartbeat` message tells the client the worker is working, not dead.
   */
  private installHeartbeat(db: Oo1Db): void {
    const progress = this.sqlite3.capi.sqlite3_progress_handler;
    if (typeof progress !== 'function' || this.sessionId === null) return;
    const sessionId = this.sessionId;
    const everyMs = this.options.heartbeatMs ?? HEARTBEAT_MS;
    progress.call(this.sqlite3.capi, db.pointer, this.options.progressOps ?? PROGRESS_OPS, () => {
      const at = this.now();
      if (at - this.lastHeartbeatAt >= everyMs) {
        this.lastHeartbeatAt = at;
        try {
          this.options.post({ kind: 'heartbeat', sessionId });
        } catch {
          /* a failed liveness hint must never abort the statement */
        }
      }
      return 0; // never interrupt
    }, 0);
  }

  private applyPragmas(db: Oo1Db, payload: OpenPayload): Record<string, string | number | null> {
    this.installHeartbeat(db);
    const strict = (this.env as WorkerEnv).strictPragmas;
    const set = (sql: string) => { db.exec(sql); };
    const read = (name: string) => db.selectValue(`PRAGMA ${name}`) as string | number | null;
    set('PRAGMA foreign_keys = ON');
    set('PRAGMA mmap_size = 0');
    set(`PRAGMA cache_size = -${Math.max(256, Math.floor(payload.cacheKiB))}`);
    if (payload.mode === 'rw') {
      set('PRAGMA journal_mode = DELETE');
      set('PRAGMA synchronous = FULL');
    } else {
      set('PRAGMA query_only = ON');
    }
    const pragmas = {
      journal_mode: String(read('journal_mode')).toLowerCase(),
      synchronous: read('synchronous') === null ? null : Number(read('synchronous')),
      foreign_keys: Number(read('foreign_keys')),
      mmap_size: Number(read('mmap_size')),
      cache_size: Number(read('cache_size'))
    };
    if (strict) {
      const problems: string[] = [];
      if (pragmas.journal_mode !== 'delete') problems.push('journal_mode');
      if (payload.mode === 'rw' && pragmas.synchronous !== 2) problems.push('synchronous');
      if (pragmas.foreign_keys !== 1) problems.push('foreign_keys');
      if (pragmas.mmap_size !== 0) problems.push('mmap_size');
      if (problems.length > 0) throw new WebStorageError('SQLITE', `Required PRAGMAs were not applied: ${problems.join(', ')}`);
    }
    return pragmas;
  }

  private close(entry: DbEntry): { closed: true } {
    this.dbs.delete(entry.dbId);
    this.byPath.delete(entry.path);
    try {
      if (entry.db.isOpen()) entry.db.close(); // finalizes any statement a failed call left behind; rolls back an open transaction
    } catch (error) {
      throw mapSqliteError(error);
    }
    return { closed: true };
  }

  private reopen(original: DbEntry, options?: { mode?: 'rw' | 'ro' }): OpenResult {
    const entry: DbEntry = options?.mode ? { ...original, mode: options.mode } : original;
    // discards the handle WITHOUT saving anything (the persistent file is the only truth), then opens the same file again
    try {
      if (entry.db.isOpen()) entry.db.close();
    } catch {
      /* a broken handle is exactly why we reopen */
    }
    this.dbs.delete(entry.dbId);
    this.byPath.delete(entry.path);
    const flags = entry.mode === 'ro' ? 'r' : 'w';
    let db: Oo1Db | undefined;
    try {
      db = new this.pool.OpfsSAHPoolDb(entry.path, flags) as unknown as Oo1Db;
      const pragmas = this.applyPragmas(db, { path: entry.path, mode: entry.mode, create: false, role: entry.role, cacheKiB: entry.cacheKiB });
      this.dbs.set(entry.dbId, { ...entry, db });
      this.byPath.set(entry.path, entry.dbId);
      return { dbId: entry.dbId, pragmas };
    } catch (error) {
      try {
        db?.close();
      } catch {
        /* ignore */
      }
      throw error instanceof WebStorageError ? error : mapSqliteError(error);
    }
  }

  // ───────────────────────── statements ─────────────────────────
  private exec(entry: DbEntry, statement: Statement): ExecResult {
    if (typeof statement?.sql !== 'string' || !Array.isArray(statement.params)) throw new WebStorageError('SQLITE', 'Malformed statement');
    const verb = sqlVerb(statement.sql);
    let rows: unknown[];
    try {
      rows = runStatement(this.sqlite3, entry.db, statement.sql, statement.params, statement.method);
    } catch (error) {
      const wasCommit = verb === 'COMMIT' || verb === 'END' || verb === 'RELEASE';
      if (wasCommit && error instanceof WebStorageError) {
        // A failed COMMIT: SQLite either auto-rolled-back (autocommit again) or the transaction is still open (e.g. SQLITE_BUSY).
        const state: 'unknown' | 'rolled_back' | 'not_started' = error.code === 'IO' || error.code === 'QUOTA' ? 'unknown' : inTransaction(this.sqlite3, entry.db) ? 'not_started' : 'rolled_back';
        throw new WebStorageError(error.code, error.message, { ...error.details, commitState: state });
      }
      throw error;
    }
    return { rows, inTransaction: inTransaction(this.sqlite3, entry.db) };
  }

  private batch(entry: DbEntry, payload: BatchPayload): BatchResult {
    const statements = payload.statements;
    if (!Array.isArray(statements) || statements.length === 0 || statements.length > BATCH_MAX_STATEMENTS) {
      throw new WebStorageError('SQLITE', `A batch holds 1..${BATCH_MAX_STATEMENTS} statements`);
    }
    let bytes = 0;
    for (const s of statements) {
      bytes += s.sql.length + s.params.reduce<number>((n, p) => n + (typeof p === 'string' ? p.length : p instanceof Uint8Array ? p.byteLength : 8), 0);
    }
    if (bytes > BATCH_MAX_BYTES) throw new WebStorageError('SQLITE', 'The batch is too large');
    const wrap = payload.atomic === true && !inTransaction(this.sqlite3, entry.db);
    const results: { rows: unknown[] }[] = [];
    let failedAt: number | null = null;
    let error: WireError | null = null;
    if (wrap) runStatement(this.sqlite3, entry.db, 'BEGIN IMMEDIATE', [], 'run');
    try {
      for (const [index, statement] of statements.entries()) {
        try {
          results.push({ rows: runStatement(this.sqlite3, entry.db, statement.sql, statement.params, statement.method) });
        } catch (e) {
          failedAt = index;
          error = wireError(e instanceof WebStorageError ? e : mapSqliteError(e));
          break;
        }
      }
      if (wrap) {
        if (error === null) runStatement(this.sqlite3, entry.db, 'COMMIT', [], 'run');
      }
    } catch (commitError) {
      error = wireError(commitError);
      failedAt = statements.length;
    }
    if (wrap && error !== null && inTransaction(this.sqlite3, entry.db)) {
      try {
        runStatement(this.sqlite3, entry.db, 'ROLLBACK', [], 'run');
        error.commitState = 'rolled_back';
      } catch {
        error.commitState = 'unknown';
      }
    }
    return { results: wrap && error !== null ? [] : results, failedAt, error, inTransaction: inTransaction(this.sqlite3, entry.db) };
  }

  private barrier(entry: DbEntry): { durable: true; inTransaction: boolean } {
    // SQLite already ran xSync (SAH.flush) before COMMIT returned (synchronous=FULL, journal_mode=DELETE). The barrier proves the
    // handle is alive and quiescent so afterCommit can only resolve after the COMMIT completed on this connection.
    if (!entry.db.isOpen()) throw new WebStorageError('IO', 'The database handle is closed', { commitState: 'unknown' });
    const open = inTransaction(this.sqlite3, entry.db);
    return { durable: true, inTransaction: open };
  }

  private cancel(payload: { targetRequestId: number }): { cancelled: boolean } {
    const controller = this.aborts.get(payload.targetRequestId);
    if (!controller) return { cancelled: false }; // a statement already running in WASM cannot be interrupted by a later message
    controller.abort();
    return { cancelled: true };
  }

  // ───────────────────────── import (§4 step 3) ─────────────────────────
  private async stageImport(request: RequestEnvelope, payload: StageImportPayload): Promise<ImportResult> {
    assertPath(payload.target);
    if (!CATALOG_PATH_RE.test(payload.target)) throw new WebStorageError('INVALID_PATH', 'Imports target a catalog path');
    if (!STAGING_NAME_RE.test(payload.job) || !STAGING_NAME_RE.test(payload.name)) throw new WebStorageError('INVALID_PATH', 'Invalid staging reference');
    this.assertImportable(payload.target);
    const staged = await (this.env as WorkerEnv).staging.open(payload.job, payload.name);
    try {
      if (staged.size !== payload.expectedBytes) throw new WebStorageError('INTEGRITY', 'The staged file size does not match the manifest');
      let offset = 0;
      const buffer = new Uint8Array(IMPORT_CHUNK_BYTES);
      return await this.runImport(request, payload.target, payload.expectedBytes, payload.expectedSha256, 'catalog', async () => {
        const n = Math.min(IMPORT_CHUNK_BYTES, staged.size - offset);
        if (n <= 0) return undefined;
        const view = buffer.subarray(0, n);
        const got = staged.read(view, offset);
        if (got !== n) throw new WebStorageError('IO', 'Short read from the staged file');
        offset += n;
        return view;
      });
    } finally {
      staged.close();
    }
  }

  private async importBytes(request: RequestEnvelope, payload: ImportBytesPayload): Promise<ImportResult> {
    assertPath(payload.target);
    if (!USER_PATH_RE.test(payload.target)) throw new WebStorageError('INVALID_PATH', 'Byte imports are only for the one-time USER migration');
    this.assertImportable(payload.target);
    const bytes = payload.bytes;
    let offset = 0;
    return this.runImport(request, payload.target, bytes.byteLength, payload.expectedSha256, 'user-migration', async () => {
      const n = Math.min(IMPORT_CHUNK_BYTES, bytes.byteLength - offset);
      if (n <= 0) return undefined;
      const view = bytes.subarray(offset, offset + n);
      offset += n;
      return view;
    });
  }

  private assertImportable(target: string): void {
    if (this.byPath.has(target) || this.imports.has(target)) throw new WebStorageError('BUSY', 'That path is open or already being imported', { retryable: true });
    if (this.pool.getFileNames().includes(target)) throw new WebStorageError('BUSY', 'The import target already exists');
  }

  /**
   * §4 step 3: pre-associate the target slot with a throwaway placeholder DB (so `importDb` reuses THAT slot and a concurrent USER
   * journal can never be handed the same free SAH), then stream chunks through `pool.importDb(target, asyncSupplier)`.
   */
  private async runImport(
    request: RequestEnvelope, target: string, expectedBytes: number, expectedSha256: string, policy: ImportPolicy, nextChunk: () => Promise<Uint8Array | undefined> | Uint8Array | undefined | Promise<undefined>
  ): Promise<ImportResult> {
    const started = this.now();
    const env = this.env as WorkerEnv;
    const abort = new AbortController();
    this.aborts.set(request.requestId, abort);
    this.imports.add(target);
    let total = 0;
    let maxChunk = 0;
    let pageSize = 0;
    let lastProgress = 0;
    try {
      // capacity: the placeholder needs a main slot plus a journal slot while it is created
      const free = this.pool.getCapacity() - this.pool.getFileCount();
      if (free < 2) {
        try {
          await this.pool.reserveMinimumCapacity(this.pool.getFileCount() + 2);
        } catch (error) {
          throw new WebStorageError('CAPACITY', 'No free storage slots for the import', { cause: error });
        }
      }
      let placeholder: Oo1Db | undefined;
      try {
        placeholder = new this.pool.OpfsSAHPoolDb(target, 'cw') as unknown as Oo1Db;
        placeholder.exec('CREATE TABLE fdx_import_placeholder (x)');
      } finally {
        placeholder?.close();
      }
      const hasher = await env.createSha256(); // digest of the bytes handed to importDb (= the bytes in the pool, no normalization for catalogs)
      const sourceHasher = policy === 'user-migration' ? await env.createSha256() : hasher; // digest of the caller's ORIGINAL bytes
      const bytesWritten = await this.pool.importDb(target, async () => {
        if (abort.signal.aborted) throw new WebStorageError('CANCELLED', 'The import was cancelled');
        const fault = this.options.dev ? this.faults.supplier : undefined;
        if (fault && total >= fault.afterBytes) {
          if (fault.kind === 'short') return undefined;
          if (fault.kind === 'quota') throw new DOMException('Injected quota error', 'QuotaExceededError');
          if (fault.kind === 'io') throw new WebStorageError('IO', 'Injected I/O error', { commitState: 'unknown' });
          if (fault.kind === 'stall') {
            await new Promise<never>(() => undefined);
          }
        }
        let chunk = await nextChunk();
        if (chunk === undefined) return undefined;
        if (total === 0) {
          const header = checkSqliteImportHeader(chunk, policy);
          pageSize = header.pageSize;
          if (policy === 'user-migration') {
            sourceHasher.update(chunk);
            if (header.needsNormalization) chunk = normalizeUserMigrationHeader(chunk);
          }
        } else if (policy === 'user-migration') {
          sourceHasher.update(chunk);
        }
        hasher.update(chunk);
        total += chunk.byteLength;
        maxChunk = Math.max(maxChunk, chunk.byteLength);
        if (total - lastProgress >= 1024 * 1024) {
          lastProgress = total;
          this.options.post({ kind: 'progress', sessionId: request.sessionId, requestId: request.requestId, bytes: total });
        }
        const delay = this.options.dev ? this.faults.chunkDelayMs : undefined;
        if (delay) await new Promise((resolve) => setTimeout(resolve, delay));
        else await this.options.yieldToLoop(); // let queued USER statements run between chunks
        return chunk;
      });
      const digest = hasher.digest();
      const sourceDigest = policy === 'user-migration' ? sourceHasher.digest() : digest;
      if (bytesWritten !== expectedBytes || total !== expectedBytes) throw new WebStorageError('INTEGRITY', 'The imported byte count does not match the expected size');
      if (pageSize !== 0 && total % pageSize !== 0) throw new WebStorageError('INTEGRITY', 'The imported size is not a whole number of database pages');
      if (sourceDigest !== expectedSha256.toLowerCase()) throw new WebStorageError('INTEGRITY', 'The imported content hash does not match the expected hash');
      return { bytes: total, sha256: digest, ms: this.now() - started, maxChunkBytes: maxChunk, ...(policy === 'user-migration' ? { sourceSha256: sourceDigest } : {}) };
    } catch (error) {
      try {
        this.pool.unlink(target); // never leave a partial/unverified candidate behind (the placeholder is ours)
      } catch {
        /* unlink of an already-released slot is a no-op */
      }
      throw error instanceof WebStorageError ? error : mapAnyError(error);
    } finally {
      this.imports.delete(target);
      this.aborts.delete(request.requestId);
    }
  }

  // ───────────────────────── housekeeping ─────────────────────────
  private unlink(path: string): { removed: boolean } {
    assertPath(path);
    if (this.byPath.has(path) || this.imports.has(path)) throw new WebStorageError('BUSY', 'The file is open or being imported', { retryable: true });
    const removed = this.pool.unlink(path);
    this.pool.unlink(`${path}-journal`); // a hot journal of a file we delete is meaningless
    return { removed };
  }

  private async ensureCapacity(minFreeSlots: number): Promise<{ capacity: number; fileCount: number }> {
    if (!Number.isInteger(minFreeSlots) || minFreeSlots < 0 || minFreeSlots > 64) throw new WebStorageError('CAPACITY', 'Invalid slot request');
    const need = this.pool.getFileCount() + minFreeSlots;
    if (this.pool.getCapacity() < need) {
      try {
        await this.pool.reserveMinimumCapacity(need);
      } catch (error) {
        throw mapAnyError(error, 'CAPACITY');
      }
    }
    return { capacity: this.pool.getCapacity(), fileCount: this.pool.getFileCount() };
  }

  private stats(): StatsResult {
    const unavailable: Record<string, string> = {};
    const heap = this.options.heapUsedBytes?.() ?? null;
    if (heap === null) unavailable.workerHeapUsedBytes = 'performance.memory is not exposed in this worker';
    return {
      capacity: this.pool.getCapacity(),
      fileCount: this.pool.getFileCount(),
      files: this.listFiles(),
      openDbs: [...this.dbs.values()].map((d) => ({ dbId: d.dbId, path: d.path, mode: d.mode, inTransaction: d.db.isOpen() && inTransaction(this.sqlite3, d.db) })),
      wasmMemoryBytes: this.wasmBytes(),
      workerHeapUsedBytes: heap,
      unavailable
    };
  }

  private exportFile(path: string): { bytes: Uint8Array } {
    assertPath(path);
    return { bytes: this.pool.exportFile(path) };
  }

  private shutdown(): { closed: number } {
    let closed = 0;
    for (const entry of [...this.dbs.values()]) {
      try {
        this.close(entry);
        closed += 1;
      } catch {
        /* keep closing the rest */
      }
    }
    for (const controller of this.aborts.values()) controller.abort();
    return { closed };
  }
}

/** Anything thrown by OPFS / the engine / the platform -> a sanitized WebStorageError. */
export function mapAnyError(error: unknown, fallback: WebStorageErrorCode = 'IO'): WebStorageError {
  if (error instanceof WebStorageError) return error;
  const name = (error as { name?: string } | null)?.name ?? '';
  if (name === 'QuotaExceededError') return new WebStorageError('QUOTA', 'Storage quota exceeded', { commitState: 'unknown' });
  if (name === 'NotFoundError') return new WebStorageError('NOT_FOUND', 'The storage file was not found');
  if (name === 'NoModificationAllowedError' || name === 'InvalidStateError') return new WebStorageError('BUSY', 'The storage file is locked by another handle', { retryable: true });
  if (name === 'SQLite3Error' || name === 'WasmAllocError' || typeof (error as { resultCode?: unknown } | null)?.resultCode === 'number') return mapSqliteError(error);
  return new WebStorageError(fallback, 'Storage operation failed', { commitState: 'unknown' });
}

// ───────────────────────── import header policy (S5-05) ─────────────────────────
/**
 * `catalog`: bytes are written to the pool EXACTLY as supplied. The pinned sahpool `importDb` overwrites header bytes 18/19 with 1/1, so a
 * catalog header must already carry 1/1 (rollback-journal format, not WAL): then the verified digest is the digest of the pool bytes.
 * `user-migration`: legacy (sql.js/jeep) exports may carry 2/2; that normalization is done explicitly HERE (`normalizeUserMigrationHeader`),
 * before hashing, so `sha256` is still the digest of what was written, and `sourceSha256` is the digest the caller's original bytes had.
 */
export type ImportPolicy = 'catalog' | 'user-migration';
const SQLITE_HEADER_MAGIC = 'SQLite format 3\u0000';

export function checkSqliteImportHeader(chunk: Uint8Array, policy: ImportPolicy): { pageSize: number; needsNormalization: boolean } {
  if (chunk.byteLength < 100) throw new WebStorageError('INTEGRITY', 'The import is too small to hold a SQLite header');
  for (let i = 0; i < 16; i += 1) {
    if (chunk[i] !== SQLITE_HEADER_MAGIC.charCodeAt(i)) throw new WebStorageError('INTEGRITY', 'The import is not a SQLite database');
  }
  const raw = ((chunk[16] as number) << 8) | (chunk[17] as number);
  const pageSize = raw === 1 ? 65536 : raw;
  if (pageSize < 512 || pageSize > 65536 || (pageSize & (pageSize - 1)) !== 0) throw new WebStorageError('INTEGRITY', 'The import has an invalid database page size');
  const write = chunk[18];
  const read = chunk[19];
  if (policy === 'catalog') {
    if (write !== 1 || read !== 1) throw new WebStorageError('INTEGRITY', 'The import is not a rollback-journal (DELETE) database');
    return { pageSize, needsNormalization: false };
  }
  if (!((write === 1 || write === 2) && (read === 1 || read === 2))) throw new WebStorageError('INTEGRITY', 'The import has an unsupported file format');
  return { pageSize, needsNormalization: write !== 1 || read !== 1 };
}

/** USER migration only: a copy of the first chunk with bytes 18/19 = 1/1 (exactly what the pool will store). */
export function normalizeUserMigrationHeader(chunk: Uint8Array): Uint8Array {
  const copy = chunk.slice();
  copy[18] = 1;
  copy[19] = 1;
  return copy;
}
