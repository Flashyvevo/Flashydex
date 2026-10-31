import { ConflictError, DomainError, MaintenanceError, PersistenceError, StorageError, UnsupportedCapabilityError, toDomainError } from '../errors';

export type StorageReason = 'ok' | 'persistence_failed' | 'instance_lock' | 'maintenance';
/** Stage E / E1: what is currently being maintained. `restore` blocks personal writes; `catalog_activation` is informational (reads wait/retry per E2). */
export type MaintenanceInfo = { kind: 'restore' | 'catalog_activation'; language: 'en' | 'ja' | null; since: string };
export type StorageStatus = { writable: boolean; reason: StorageReason; message: string | null; maintenance: MaintenanceInfo | null };

/** Held by the restore while the personal-write maintenance gate is closed; the ONLY way to write through it. */
export interface MaintenanceGate {
  /** The privileged transaction: allowed through the gate (still subject to the instance lock and the persistence latch). */
  transaction<T>(fn: (tx: Exec) => Promise<T>): Promise<T>;
  /** Wait for everything already queued on this connection (queued ordinary writes reject MAINTENANCE when they reach the head), then reopen the gate. */
  exit(): Promise<void>;
}

/**
 * SqlDriver = one SQLite connection behind the Drizzle `sqlite-proxy` callback contract.
 *
 *  - Node tests: better-sqlite3 behind this callback (src/testing/node-driver.ts), temp FILE databases.
 *  - Device:     @capacitor-community/sqlite via apps/mobile/src/platform/sqlite-proxy.ts (`createProxyCallback`).
 *
 * `method` follows Drizzle's proxy: 'run' (no rows needed), 'all'/'values' (positional row arrays), 'get' (single positional row).
 * Core only ever asks for positional rows, so explicit ordered projections are the rule (DATA-MODEL "SQLite driver compatibility").
 */
export type ProxyMethod = 'run' | 'all' | 'values' | 'get';
export type ProxyCallback = (sql: string, params: unknown[], method: ProxyMethod) => Promise<{ rows: unknown[] }>;

export interface SqlDriver {
  readonly label: string;
  readonly proxy: ProxyCallback;
  /** Web only: flush the in-memory database to its persistent store. Awaited after every committed transaction. */
  afterCommit?(): Promise<void>;
  /** Discard in-memory state and re-read the persisted DB (D43). Absent = recovery from a persistence failure is impossible without a reload. */
  reopen?(): Promise<void>;
  close(): Promise<void>;
}

export type Row = unknown[];

/** Statement executor shared by `Db`, transactions and read sessions. */
export interface Exec {
  /** Positional rows. */
  rows(sql: string, params?: readonly unknown[]): Promise<Row[]>;
  /** Run a statement that returns no rows (DML / DDL). */
  run(sql: string, params?: readonly unknown[]): Promise<void>;
  /** `SELECT <expr AS alias,...> <rest>` returning objects keyed by alias. */
  select<T extends Record<string, unknown>>(cols: { [K in keyof T & string]: string }, rest: string, params?: readonly unknown[]): Promise<T[]>;
  /** First column of the first row, or null. */
  scalar<T = unknown>(sql: string, params?: readonly unknown[]): Promise<T | null>;
}

class Executor implements Exec {
  constructor(private readonly proxy: ProxyCallback) {}

  async rows(sql: string, params: readonly unknown[] = []): Promise<Row[]> {
    const { rows } = await this.proxy(sql, [...params], 'values');
    return (rows ?? []) as Row[];
  }

  async run(sql: string, params: readonly unknown[] = []): Promise<void> {
    await this.proxy(sql, [...params], 'run');
  }

  async select<T extends Record<string, unknown>>(cols: { [K in keyof T & string]: string }, rest: string, params: readonly unknown[] = []): Promise<T[]> {
    const keys = Object.keys(cols) as Array<keyof T & string>;
    const list = keys.map((key) => `${cols[key]} AS ${key}`).join(', ');
    const rows = await this.rows(`SELECT ${list} ${rest}`, params);
    return rows.map((row) => {
      const out: Record<string, unknown> = {};
      keys.forEach((key, index) => {
        const value = row[index];
        out[key] = value === undefined ? null : value;
      });
      return out as T;
    });
  }

  async scalar<T = unknown>(sql: string, params: readonly unknown[] = []): Promise<T | null> {
    const rows = await this.rows(sql, params);
    const value = rows[0]?.[0];
    return value === undefined ? null : (value as T);
  }
}

/** Serializes every statement and transaction on one connection (a SQLite connection is not re-entrant across async tasks). */
export class Db {
  private tail: Promise<unknown> = Promise.resolve();
  private readonly direct: Executor;
  /** Test/ops kill switch (legacy `setMaintenance`): blocks writes with reason 'maintenance' but is not a reported gate. */
  private killSwitch = false;
  private restoreGate: { info: MaintenanceInfo; token: symbol } | null = null;
  private readonly activations = new Map<symbol, MaintenanceInfo>();
  private cachedStatus: StorageStatus | null = null;
  private persistenceFailed = false;
  private instanceLock: { message: string } | null = null;
  private readonly listeners = new Set<(s: StorageStatus) => void>();

  constructor(readonly driver: SqlDriver, readonly readOnly = false) {
    this.direct = new Executor(driver.proxy);
  }

  get label(): string {
    return this.driver.label;
  }

  private lock<T>(fn: () => Promise<T>): Promise<T> {
    const next = this.tail.then(fn, fn);
    this.tail = next.catch(() => undefined);
    return next;
  }

  /** Enable and verify foreign keys. Must run outside a transaction, once per connection. */
  async initialize(): Promise<void> {
    await this.lock(async () => {
      if (this.readOnly) {
        // Read-only catalog handles: FK enforcement is irrelevant to reads and some drivers refuse PRAGMA writes there.
        await this.direct.run('PRAGMA foreign_keys = ON').catch(() => undefined);
        return;
      }
      await this.direct.run('PRAGMA foreign_keys = ON');
      const on = await this.direct.scalar<number>('PRAGMA foreign_keys');
      if (Number(on) !== 1) throw new StorageError('DB_UNAVAILABLE', `Foreign keys could not be enabled on ${this.label}`);
    });
  }

  async foreignKeysEnabled(): Promise<boolean> {
    return this.lock(async () => Number(await this.direct.scalar<number>('PRAGMA foreign_keys')) === 1);
  }

  setMaintenance(on: boolean): void {
    this.killSwitch = on;
    this.notify();
  }

  /**
   * E1: close the personal-write gate for a restore. Every ordinary write (including ones already queued) rejects MAINTENANCE until `exit()`.
   * Resolves once work that was already running has drained; the returned gate runs the restore's own privileged transaction.
   */
  async enterRestoreGate(): Promise<MaintenanceGate> {
    if (this.readOnly) throw new StorageError('DB_UNAVAILABLE', `${this.label} is read-only`);
    if (this.restoreGate) throw new MaintenanceError();
    const token = Symbol('restore-gate');
    this.restoreGate = { token, info: { kind: 'restore', language: null, since: new Date().toISOString() } };
    this.notify();
    await this.lock(async () => undefined); // drain: the in-flight transaction finishes; anything queued behind it now sees the gate
    return {
      transaction: (fn) => this.runTransaction(fn, token),
      exit: async () => {
        await this.lock(async () => undefined);
        if (this.restoreGate?.token === token) { this.restoreGate = null; this.notify(); }
      }
    };
  }

  /** E1: announce a catalog activation barrier (informational; personal writes continue). Returns the end function. */
  beginCatalogActivation(language: 'en' | 'ja'): () => void {
    const key = Symbol('activation');
    this.activations.set(key, { kind: 'catalog_activation', language, since: new Date().toISOString() });
    this.notify();
    return () => { if (this.activations.delete(key)) this.notify(); };
  }

  /** D42: the page does not own the writer lock; every personal write is refused with INSTANCE_LOCK. */
  setInstanceLock(block: { message: string } | null): void {
    this.instanceLock = block;
    this.notify();
  }

  status(): StorageStatus {
    const maintenance: MaintenanceInfo | null = this.restoreGate?.info ?? this.activations.values().next().value ?? null;
    let next: StorageStatus;
    if (this.instanceLock) next = { writable: false, reason: 'instance_lock', message: this.instanceLock.message, maintenance };
    else if (this.persistenceFailed) next = { writable: false, reason: 'persistence_failed', message: 'The last change may not have been saved. FlashyDex must reload your data before more changes.', maintenance };
    else if (this.restoreGate) next = { writable: false, reason: 'maintenance', message: 'Restoring your backup.', maintenance };
    else if (this.killSwitch) next = { writable: false, reason: 'maintenance', message: 'Storage is being maintained.', maintenance };
    else next = { writable: true, reason: 'ok', message: null, maintenance };
    const last = this.cachedStatus;
    if (
      last && last.writable === next.writable && last.reason === next.reason && last.message === next.message &&
      last.maintenance?.kind === next.maintenance?.kind && last.maintenance?.language === next.maintenance?.language && last.maintenance?.since === next.maintenance?.since
    ) return last;
    this.cachedStatus = next; // referentially stable while nothing changed (useSyncExternalStore friendly)
    return next;
  }

  subscribe(listener: (s: StorageStatus) => void): () => void {
    this.listeners.add(listener);
    return () => { this.listeners.delete(listener); };
  }

  private notify(): void {
    const s = this.status();
    for (const l of [...this.listeners]) { try { l(s); } catch { /* observer errors are isolated */ } }
  }

  /** The PERSISTENCE_FAILED error while the persistence latch is set, else null. Receipt replays check this FIRST (Stage E / N05). */
  persistenceBlock(): DomainError | null {
    return this.persistenceFailed ? new PersistenceError('The last change may not have been saved. Recover storage before continuing.') : null;
  }

  /**
   * E01: a read whose result may be reported as "already committed" (receipt replay). The persistence latch is checked after queue
   * admission (so a flush that failed while this call waited is seen) and again after the read, inside the same serialized hold;
   * a latched Db throws PERSISTENCE_FAILED instead of returning a possibly-undurable row.
   */
  durableRead<T>(fn: (q: Exec) => Promise<T>): Promise<T> {
    return this.lock(async () => {
      const before = this.persistenceBlock();
      if (before) throw before;
      const out = await fn(this.direct);
      const after = this.persistenceBlock();
      if (after) throw after;
      return out;
    });
  }

  /** The error every write gets while the Db is blocked, or null. */
  writeBlockError(privilege?: symbol): DomainError | null {
    if (this.instanceLock) return new StorageError('INSTANCE_LOCK', this.instanceLock.message);
    if (this.persistenceFailed) return new PersistenceError('The last change may not have been saved. Recover storage before making more changes.');
    if (this.restoreGate && privilege !== this.restoreGate.token) return new MaintenanceError();
    if (this.killSwitch) return new MaintenanceError();
    return null;
  }

  /**
   * D43 recovery: reopen the driver (discard in-memory state, re-read persisted state), re-verify foreign keys, then clear the
   * persistence latch. Throws UNSUPPORTED_CAPABILITY when the driver cannot reopen (the UI must then reload the page).
   */
  async recover(): Promise<StorageStatus> {
    const reopen = this.driver.reopen;
    if (!reopen) throw new UnsupportedCapabilityError('This storage driver cannot reopen; reload the app to recover.');
    await this.lock(async () => {
      await reopen.call(this.driver);
      await this.direct.run('PRAGMA foreign_keys = ON');
      if (Number(await this.direct.scalar<number>('PRAGMA foreign_keys')) !== 1) throw new StorageError('DB_UNAVAILABLE', `Foreign keys could not be enabled on ${this.label}`);
      this.persistenceFailed = false;
    });
    this.notify();
    return this.status();
  }

  rows(sql: string, params: readonly unknown[] = []): Promise<Row[]> {
    return this.lock(() => this.direct.rows(sql, params));
  }
  run(sql: string, params: readonly unknown[] = []): Promise<void> {
    return this.lock(() => this.direct.run(sql, params));
  }
  select<T extends Record<string, unknown>>(cols: { [K in keyof T & string]: string }, rest: string, params: readonly unknown[] = []): Promise<T[]> {
    return this.lock(() => this.direct.select<T>(cols, rest, params));
  }
  scalar<T = unknown>(sql: string, params: readonly unknown[] = []): Promise<T | null> {
    return this.lock(() => this.direct.scalar<T>(sql, params));
  }

  /** Several reads under one lock hold: a consistent view relative to this connection's writers. */
  read<T>(fn: (q: Exec) => Promise<T>): Promise<T> {
    return this.lock(() => fn(this.direct));
  }

  /**
   * One atomic write. `BEGIN IMMEDIATE` ... `COMMIT`; any throw rolls back. After COMMIT the driver flushes (web) and a flush
   * failure surfaces as PersistenceError, never as a silent success.
   */
  transaction<T>(fn: (tx: Exec) => Promise<T>): Promise<T> {
    return this.runTransaction(fn, undefined);
  }

  private runTransaction<T>(fn: (tx: Exec) => Promise<T>, privilege: symbol | undefined): Promise<T> {
    if (this.readOnly) throw new StorageError('DB_UNAVAILABLE', `${this.label} is read-only`);
    const blocked = this.writeBlockError(privilege);
    if (blocked) return Promise.reject(blocked);
    return this.lock(async () => {
      const again = this.writeBlockError(privilege); // a latch / gate set while this call was queued must still stop it
      if (again) throw again;
      await this.direct.run('BEGIN IMMEDIATE');
      let result: T;
      try {
        result = await fn(this.direct);
      } catch (error) {
        await this.direct.run('ROLLBACK').catch(() => undefined);
        throw translateSqliteError(error);
      }
      try {
        await this.direct.run('COMMIT');
      } catch (error) {
        await this.direct.run('ROLLBACK').catch(() => undefined);
        throw translateSqliteError(error);
      }
      if (this.driver.afterCommit) {
        try {
          await this.driver.afterCommit();
        } catch {
          this.persistenceFailed = true; // fail closed: COMMIT happened, durability is unknown
          this.notify();
          throw new PersistenceError();
        }
      }
      return result;
    });
  }

  async close(): Promise<void> {
    await this.lock(() => this.driver.close());
  }
}

/** Constraint failures that escaped service validation become typed, sanitized errors (never SQL text). */
export function translateSqliteError(error: unknown): DomainError {
  if (error instanceof DomainError) return error;
  const message = error instanceof Error ? error.message : String(error);
  if (/FOREIGN KEY constraint failed/i.test(message)) return new ConflictError('A referenced record is missing or still in use');
  if (/UNIQUE constraint failed|PRIMARY KEY/i.test(message)) return new ConflictError('A record with the same identity already exists');
  if (/CHECK constraint failed|NOT NULL constraint failed|constraint failed/i.test(message)) return new ConflictError('The data violates a storage constraint');
  return toDomainError(error);
}

export const chunk = <T>(items: readonly T[], size: number): T[][] => {
  const out: T[][] = [];
  for (let i = 0; i < items.length; i += size) out.push(items.slice(i, i + size));
  return out;
};

export const placeholders = (count: number): string => Array.from({ length: count }, () => '?').join(',');
