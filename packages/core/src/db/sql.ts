import { ConflictError, DomainError, MaintenanceError, PersistenceError, StorageError, toDomainError } from '../errors';

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
  private maintenance = false;

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
    this.maintenance = on;
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
    if (this.readOnly) throw new StorageError('DB_UNAVAILABLE', `${this.label} is read-only`);
    if (this.maintenance) throw new MaintenanceError();
    return this.lock(async () => {
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
