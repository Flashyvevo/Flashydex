import Database from 'better-sqlite3';
import { existsSync, mkdirSync, mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { randomUUID } from 'node:crypto';
import type { Language } from '@flashydex/schemas';
import { CATALOG_MIGRATIONS, USER_MIGRATIONS } from '../db/migrations.generated';
import { migrate } from '../db/migrator';
import { DatabaseSet, type CatalogSource } from '../db/database-set';
import { Db, type ProxyCallback, type SqlDriver } from '../db/sql';
import type { Environment } from '../platform/platform';

/**
 * NODE TEST DRIVER. better-sqlite3 behind the same Drizzle sqlite-proxy callback contract the device uses.
 * Test-only: never imported by `src/index.ts`, never shipped to the app bundle.
 */
/**
 * Mimics the @capacitor-community/sqlite (jeep, web) connection surface: `query` returns rows as OBJECTS keyed by column name
 * (duplicate column names collapse, exactly like sql.js getAsObject). Tests wrap it with apps/mobile's `createProxyCallback`
 * to prove every query is safe on the web path (defect C1).
 */
export interface JeepLikeConnection {
  execute(statements: string, transaction?: boolean): Promise<{ changes?: { changes?: number; lastId?: number; values?: unknown[] } }>;
  run(statement: string, values?: unknown[], transaction?: boolean, returnMode?: string): Promise<{ changes?: { changes?: number; lastId?: number; values?: unknown[] } }>;
  query(statement: string, values?: unknown[]): Promise<{ values?: unknown[] }>;
}

export function createJeepLikeConnection(sqlite: Database.Database): JeepLikeConnection {
  const bind = (values: unknown[] = []) => values.map((p) => (typeof p === 'boolean' ? (p ? 1 : 0) : p === undefined ? null : p));
  return {
    async execute(statements) {
      sqlite.exec(statements);
      return { changes: { changes: 0 } };
    },
    async run(statement, values) {
      const info = sqlite.prepare(statement).run(...bind(values));
      return { changes: { changes: info.changes, lastId: Number(info.lastInsertRowid) } };
    },
    async query(statement, values) {
      return { values: sqlite.prepare(statement).all(...bind(values)) as unknown[] };
    }
  };
}

export type ProxyFactory = (connection: JeepLikeConnection) => ProxyCallback;

export function createNodeDriver(path: string, options: { readonly?: boolean; label?: string; proxyFactory?: ProxyFactory } = {}): SqlDriver & { raw: Database.Database } {
  const sqlite = new Database(path, { readonly: options.readonly === true, fileMustExist: options.readonly === true });
  if (options.readonly !== true) sqlite.pragma('synchronous = OFF'); // test speed only: crash durability is not under test here
  const proxy: ProxyCallback = options.proxyFactory ? options.proxyFactory(createJeepLikeConnection(sqlite)) : async (sql, params, method) => {
    const bound = params.map((p) => (typeof p === 'boolean' ? (p ? 1 : 0) : p === undefined ? null : p));
    const statement = sqlite.prepare(sql);
    if (method === 'run') {
      statement.run(...bound);
      return { rows: [] };
    }
    const rows = statement.raw(true).all(...bound);
    return { rows: method === 'get' ? (rows[0] ?? []) : rows } as { rows: unknown[] };
  };
  return {
    label: options.label ?? path,
    proxy,
    raw: sqlite,
    async close() {
      if (sqlite.open) sqlite.close();
    }
  };
}

export class FixedEnvironment implements Environment {
  private tick = 0;
  private counter = 0;
  constructor(private start = Date.parse('2026-10-30T12:00:00.000Z'), private readonly deterministicIds = false) {}
  clock = { now: () => new Date(this.start + this.tick++ * 1000).toISOString() };
  ids = {
    uuid: () => {
      if (!this.deterministicIds) return randomUUID();
      this.counter += 1;
      return `00000000-0000-4000-8000-${String(this.counter).padStart(12, '0')}`;
    }
  };
  /** Advance the fake clock to an absolute instant. */
  setTime(iso: string): void {
    this.tick = 0;
    this.start = Date.parse(iso);
  }
}

class DirectoryCatalogSource implements CatalogSource {
  constructor(private readonly dir: string, private readonly proxyFactory?: ProxyFactory) {}
  path(language: Language): string {
    return join(this.dir, `catalog-${language}.db`);
  }
  async openWritable(language: Language): Promise<SqlDriver | null> {
    const file = this.path(language);
    return existsSync(file) ? createNodeDriver(file, { label: `catalog-${language}-rw`, proxyFactory: this.proxyFactory }) : null;
  }
  async open(language: Language): Promise<SqlDriver | null> {
    const file = this.path(language);
    return existsSync(file) ? createNodeDriver(file, { readonly: true, label: `catalog-${language}`, proxyFactory: this.proxyFactory }) : null;
  }
}

export interface TestDatabases {
  dir: string;
  env: FixedEnvironment;
  databases: DatabaseSet;
  user: Db;
  catalogPath(language: Language): string;
  /** Close, then reopen the same files (simulates an app restart). */
  reopen(): Promise<TestDatabases>;
  cleanup(): Promise<void>;
}

/** Fresh temp-directory user DB (FILE, foreign_keys ON, migrated) + a directory-backed catalog source. */
export async function createTestDatabases(options: { dir?: string; env?: FixedEnvironment; proxyFactory?: ProxyFactory } = {}): Promise<TestDatabases> {
  const dir = options.dir ?? mkdtempSync(join(tmpdir(), 'flashydex-test-'));
  mkdirSync(dir, { recursive: true });
  const env = options.env ?? new FixedEnvironment();
  const source = new DirectoryCatalogSource(dir, options.proxyFactory);
  const user = new Db(createNodeDriver(join(dir, "flashydex-user.db"), { label: "flashydex-user", proxyFactory: options.proxyFactory }));
  await user.initialize();
  await migrate(user, USER_MIGRATIONS, env.clock.now);
  const databases = new DatabaseSet(user, source);
  const self: TestDatabases = {
    dir,
    env,
    databases,
    user,
    catalogPath: (language) => source.path(language),
    async reopen() {
      await databases.close();
      return createTestDatabases({ dir, env, proxyFactory: options.proxyFactory });
    },
    async cleanup() {
      await databases.close().catch(() => undefined);
      try { rmSync(dir, { recursive: true, force: true, maxRetries: 5, retryDelay: 50 }); } catch { /* Windows may hold the handle briefly; the OS temp dir is pruned */ }
    }
  };
  return self;
}

/** Create a catalog file through the SAME bundled catalog migration chain the builder applies. */
export async function createCatalogFile(path: string, language: Language, env: Environment = new FixedEnvironment()): Promise<Db> {
  const db = new Db(createNodeDriver(path, { label: `catalog-${language}-writer` }));
  await db.initialize();
  await migrate(db, CATALOG_MIGRATIONS, env.clock.now);
  return db;
}
