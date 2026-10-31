import Database from 'better-sqlite3';
import { drizzle } from 'drizzle-orm/better-sqlite3';
import { getTableConfig, type SQLiteTable } from 'drizzle-orm/sqlite-core';
import { readdirSync, readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import { mapCard, mapSet, type RawCard, type RawSetDetail } from '../src/catalog/tcgdex';
import {
  CATALOG_SCHEMA_VERSION, catalogCards, catalogLatestPrices, catalogMeta, catalogSets, catalogVariants, schemaMigrations
} from '../src/db/catalog-schema';

const migrationsDir = new URL('../migrations/catalog/', import.meta.url);
const files = readdirSync(migrationsDir).filter((f) => f.endsWith('.sql')).sort();

function applyChain(db: Database.Database): void {
  for (const file of files) {
    const sql = readFileSync(new URL(file, migrationsDir), 'utf8');
    for (const statement of sql.split('--> statement-breakpoint').map((s) => s.trim()).filter(Boolean)) db.exec(statement);
  }
}

const tables: Record<string, SQLiteTable> = {
  catalog_sets: catalogSets, catalog_cards: catalogCards, catalog_variants: catalogVariants,
  catalog_latest_prices: catalogLatestPrices, catalog_meta: catalogMeta, schema_migrations: schemaMigrations
};

describe('catalog migration chain vs Drizzle declarations', () => {
  const db = new Database(':memory:');
  applyChain(db);

  it('has exactly one initial migration file named in order', () => {
    expect(files).toEqual(['0000_initial.sql']);
    expect(CATALOG_SCHEMA_VERSION).toBe(1);
  });

  it('creates exactly the declared tables', () => {
    const names = (db.prepare("SELECT name FROM sqlite_master WHERE type='table' AND name NOT LIKE 'sqlite_%' ORDER BY name").all() as Array<{ name: string }>).map((r) => r.name);
    expect(names).toEqual(Object.keys(tables).sort());
    const objects = db.prepare("SELECT type FROM sqlite_master WHERE type IN ('trigger','view')").all();
    expect(objects).toEqual([]);
  });

  for (const [tableName, table] of Object.entries(tables)) {
    it(`${tableName}: columns, primary key, indexes, foreign keys and CHECKs match`, () => {
      const config = getTableConfig(table);
      expect(config.name).toBe(tableName);

      const info = db.prepare(`PRAGMA table_info(${tableName})`).all() as Array<{ name: string; notnull: number; pk: number; type: string }>;
      expect(info.map((c) => c.name)).toEqual(config.columns.map((c) => c.name));
      for (const column of config.columns) {
        const actual = info.find((c) => c.name === column.name)!;
        expect(actual.notnull === 1 || actual.pk > 0, `${tableName}.${column.name} NOT NULL`).toBe(column.notNull);
        expect(actual.type.toLowerCase(), `${tableName}.${column.name} type`).toBe(column.getSQLType());
      }
      const pkColumns = info.filter((c) => c.pk > 0).sort((a, b) => a.pk - b.pk).map((c) => c.name);
      const declaredPk = config.primaryKeys.length > 0
        ? config.primaryKeys[0]!.columns.map((c) => c.name)
        : config.columns.filter((c) => c.primary).map((c) => c.name);
      expect(pkColumns).toEqual(declaredPk);

      const indexList = (db.prepare(`PRAGMA index_list(${tableName})`).all() as Array<{ name: string; unique: number; origin: string }>)
        .filter((i) => i.origin === 'c');
      const actualIndexes = indexList.map((i) => ({
        name: i.name, unique: i.unique === 1,
        columns: (db.prepare(`PRAGMA index_info(${i.name})`).all() as Array<{ name: string; seqno: number }>).sort((a, b) => a.seqno - b.seqno).map((c) => c.name)
      })).sort((a, b) => a.name.localeCompare(b.name));
      const declaredIndexes = config.indexes.map((i) => ({
        name: i.config.name, unique: i.config.unique, columns: i.config.columns.map((c) => (c as { name: string }).name)
      })).sort((a, b) => a.name.localeCompare(b.name));
      expect(actualIndexes).toEqual(declaredIndexes);

      const fks = db.prepare(`PRAGMA foreign_key_list(${tableName})`).all() as Array<{ id: number; table: string; from: string; to: string; on_update: string; on_delete: string }>;
      const groups = new Map<number, typeof fks>();
      for (const fk of fks) groups.set(fk.id, [...(groups.get(fk.id) ?? []), fk]);
      expect(groups.size).toBe(config.foreignKeys.length);
      for (const declared of config.foreignKeys) {
        const ref = declared.reference();
        const match = [...groups.values()].find((g) => g[0]!.table === getTableConfig(ref.foreignTable).name);
        expect(match, `${tableName} FK to ${getTableConfig(ref.foreignTable).name}`).toBeDefined();
        expect(match!.map((g) => g.from)).toEqual(ref.columns.map((c) => c.name));
        expect(match!.map((g) => g.to)).toEqual(ref.foreignColumns.map((c) => c.name));
        expect(match!.every((g) => g.on_update === 'RESTRICT' && g.on_delete === 'RESTRICT')).toBe(true);
      }

      const ddl = (db.prepare('SELECT sql FROM sqlite_master WHERE type=\'table\' AND name=?').get(tableName) as { sql: string }).sql;
      for (const check of config.checks) expect(ddl).toContain(`CONSTRAINT "${check.name}" CHECK`);
    });
  }
});

describe('catalog constraints are enforced and real mapper output loads', () => {
  const fixture = <T>(name: string): T => JSON.parse(readFileSync(new URL(`./fixtures/tcgdex/${name}`, import.meta.url), 'utf8')) as T;
  const ctx = { language: 'en' as const, syncedAt: '2026-10-31T00:00:00.000Z' };

  function freshDb() {
    const sqlite = new Database(':memory:');
    sqlite.pragma('foreign_keys = ON');
    applyChain(sqlite);
    return { sqlite, db: drizzle(sqlite) };
  }

  it('inserts mapped sets, cards, variants and prices with foreign keys ON and a clean integrity/FK check', () => {
    const { sqlite, db } = freshDb();
    db.insert(catalogSets).values(mapSet(fixture<RawSetDetail>('en-set-swsh3.json'), ctx)).run();
    for (const name of ['en-card-swsh3-136.json', 'en-card-swsh3-201.json']) {
      const mapped = mapCard(fixture<RawCard>(name), ctx);
      db.insert(catalogCards).values(mapped.card).run();
      db.insert(catalogVariants).values(mapped.variants).run();
      if (mapped.prices.length) db.insert(catalogLatestPrices).values(mapped.prices).run();
    }
    expect(sqlite.pragma('integrity_check')).toEqual([{ integrity_check: 'ok' }]);
    expect(sqlite.pragma('foreign_key_check')).toEqual([]);
    expect(sqlite.prepare('SELECT COUNT(*) AS n FROM catalog_latest_prices').get()).toEqual({ n: 6 });
  });

  it('rejects a card with an unknown set, an unknown variant, a bad price tuple and a second meta row', () => {
    const { sqlite, db } = freshDb();
    const mapped = mapCard(fixture<RawCard>('en-card-swsh3-136.json'), ctx);
    expect(() => db.insert(catalogCards).values(mapped.card).run()).toThrow(/FOREIGN KEY/);
    db.insert(catalogSets).values(mapSet(fixture<RawSetDetail>('en-set-swsh3.json'), ctx)).run();
    db.insert(catalogCards).values(mapped.card).run();
    expect(() => db.insert(catalogVariants).values({ ...mapped.variants[0]!, variant: 'bogus' as never }).run()).toThrow(/CHECK/);
    db.insert(catalogVariants).values(mapped.variants).run();
    const price = mapped.prices[0]!;
    db.insert(catalogLatestPrices).values(price).run();
    expect(() => db.insert(catalogLatestPrices).values({ ...price, id: 'other', observationKey: 'other2' }).run()).toThrow(/UNIQUE/);
    expect(() => db.insert(catalogLatestPrices).values({ ...mapped.prices[1]!, midCents: -1 }).run()).toThrow(/CHECK/);
    const usd = mapped.prices.find((p) => p.source === 'tcgplayer')!;
    expect(() => db.insert(catalogLatestPrices).values({ ...usd, id: 'u1', observationKey: 'u1', currency: 'EUR' }).run()).toThrow(/CHECK/);
    const meta = {
      id: 'catalog', language: 'en', version: '2026.10.31.001', schemaVersion: 1, builtAt: ctx.syncedAt, builderVersion: 't', sourceCutoffAt: ctx.syncedAt,
      sourceSetCount: 1, sourceCardCount: 1, sourceVariantCount: 2, sourcePriceCount: 4, unpublishedSetCount: 0, schemaFingerprint: 'f'
    } as const;
    db.insert(catalogMeta).values(meta).run();
    expect(() => db.insert(catalogMeta).values({ ...meta, id: 'second' }).run()).toThrow(/CHECK/);
    expect(() => sqlite.prepare("DELETE FROM catalog_sets WHERE id='swsh3'").run()).toThrow(/FOREIGN KEY/);
  });

  it('keeps EN and JA identities separate (same id, different language) in different files', () => {
    const { db } = freshDb();
    const enSet = mapSet({ id: 'neo4', name: 'Neo Destiny', cards: [{ id: 'neo4-100', localId: '100', name: 'x' }] }, ctx);
    db.insert(catalogSets).values(enSet).run();
    expect(() => db.insert(catalogSets).values(enSet).run()).toThrow(/UNIQUE|PRIMARY/);
    expect(() => db.insert(catalogSets).values({ ...enSet, language: 'ja' }).run()).not.toThrow();
  });
});
