import { getTableConfig, type SQLiteTable } from 'drizzle-orm/sqlite-core';
import { mkdtempSync, readdirSync, readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { CATALOG_MIGRATIONS, USER_MIGRATIONS } from '../src/db/migrations.generated';
import { migrate, migrationChecksum, splitStatements, type MigrationFile } from '../src/db/migrator';
import { Db } from '../src/db/sql';
import * as userSchema from '../src/db/user-schema';
import { StorageError } from '../src/errors';
import { createNodeDriver, createTestDatabases } from '../src/testing/node-driver';

const now = () => '2026-10-30T12:00:00.000Z';

describe('embedded migrations (61)', () => {
  it('generated module equals the .sql files on disk (run `npm run db:embed` after drizzle-kit generate)', () => {
    for (const chain of ['user', 'catalog'] as const) {
      const dir = new URL(`../migrations/${chain}/`, import.meta.url);
      const files = readdirSync(dir).filter((f) => f.endsWith('.sql')).sort();
      const embedded = chain === 'user' ? USER_MIGRATIONS : CATALOG_MIGRATIONS;
      expect(embedded.map((m) => m.version)).toEqual(files.map((f) => f.replace('.sql', '')));
      files.forEach((f, i) => expect(embedded[i]?.sql).toBe(readFileSync(new URL(f, dir), 'utf8').replace(/\r\n/g, '\n')));
    }
  });

  it('splits only on drizzle statement breakpoints, never on semicolons', () => {
    expect(splitStatements("INSERT INTO t VALUES ('a;b');\n--> statement-breakpoint\nSELECT 1;")).toEqual(["INSERT INTO t VALUES ('a;b');", 'SELECT 1;']);
  });
});

describe('user database bootstrap (61)', () => {
  it('migrates an empty DB with foreign_keys ON, seeds singleton rows, and re-running is a no-op', async () => {
    const t = await createTestDatabases();
    try {
      expect(await t.user.foreignKeysEnabled()).toBe(true);
      const names = (await t.user.rows("SELECT name FROM sqlite_master WHERE type='table' AND name NOT LIKE 'sqlite_%' ORDER BY name")).map((r) => String(r[0]));
      expect(names).toEqual([
        'acquisitions', 'app_settings', 'app_state', 'catalog_annotations', 'catalog_identities', 'catalog_install_jobs', 'collection_group_members',
        'collection_groups', 'custom_cards', 'data_operation_receipts', 'grades', 'installed_catalogs', 'owned_cards', 'pack_metrics', 'price_snapshots', 'restore_receipts',
        'scan_sessions', 'schema_migrations', 'storage_locations', 'sync_state', 'work_admission'
      ]);
      expect(await t.user.rows('SELECT id, collection_revision FROM app_state')).toEqual([['collection', 0]]);
      expect(await t.user.rows('SELECT id, languages_json, hide_tcg_pocket, default_currency FROM app_settings')).toEqual([['app', '["en","ja"]', 1, 'USD']]);
      expect(await t.user.rows('SELECT language, status, generation FROM installed_catalogs ORDER BY language')).toEqual([['en', 'absent', 0], ['ja', 'absent', 0]]);

      const again = await migrate(t.user, USER_MIGRATIONS, now);
      expect(again.applied).toEqual([]);
      expect(again.alreadyApplied).toEqual(USER_MIGRATIONS.map((m) => m.version));
      expect(Number(await t.user.scalar('SELECT COUNT(*) FROM app_settings'))).toBe(1);

      const reopened = await t.reopen();
      expect(await reopened.user.foreignKeysEnabled()).toBe(true); // verified on every connection
      await reopened.cleanup();
    } finally {
      await t.cleanup();
    }
  });

  it('applied SQL matches the Drizzle declarations (columns, nullability, primary keys)', async () => {
    const t = await createTestDatabases();
    try {
      const tables = Object.values(userSchema).filter((v) => v && typeof v === 'object' && Symbol.for('drizzle:IsDrizzleTable') in (v as object)) as SQLiteTable[];
      expect(tables.length).toBe(21);
      for (const table of tables) {
        const config = getTableConfig(table);
        const info = (await t.user.rows(`PRAGMA table_info(${config.name})`)).map((r) => ({ name: String(r[1]), notnull: Number(r[3]), pk: Number(r[5]) }));
        expect(info.map((c) => c.name), config.name).toEqual(config.columns.map((c) => c.name));
        for (const column of config.columns) {
          const actual = info.find((c) => c.name === column.name)!;
          expect(actual.notnull === 1 || actual.pk > 0, `${config.name}.${column.name}`).toBe(column.notNull);
        }
      }
    } finally {
      await t.cleanup();
    }
  });

  it('detects a modified applied migration and a database from a newer app; data stays untouched', async () => {
    const t = await createTestDatabases();
    try {
      await t.user.run("INSERT INTO storage_locations (id, name, name_key, description, created_at, updated_at) VALUES ('11111111-1111-4111-8111-111111111111','Box','box',NULL,?,?)", [now(), now()]);
      const tampered: MigrationFile[] = USER_MIGRATIONS.map((m, i) => (i === 0 ? { ...m, sql: `${m.sql}\n-- edited` } : m));
      await expect(migrate(t.user, tampered, now)).rejects.toMatchObject({ code: 'MIGRATION_FAILED' });
      await expect(migrate(t.user, USER_MIGRATIONS.slice(0, 1), now)).rejects.toMatchObject({ code: 'MIGRATION_FAILED' });
      expect(Number(await t.user.scalar('SELECT COUNT(*) FROM storage_locations'))).toBe(1);
    } finally {
      await t.cleanup();
    }
  });

  it('a failing migration file rolls back atomically (statements + tracking row) and keeps FKs on', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'flashydex-mig-'));
    const db = new Db(createNodeDriver(join(dir, 'x.db')));
    await db.initialize();
    const chain: MigrationFile[] = [
      { version: '0000_a', sql: 'CREATE TABLE schema_migrations (version text primary key not null, checksum text not null, applied_at text not null);\n--> statement-breakpoint\nCREATE TABLE a (id integer);' },
      { version: '0001_bad', sql: 'CREATE TABLE b (id integer);\n--> statement-breakpoint\nTHIS IS NOT SQL;' }
    ];
    await expect(migrate(db, chain, now)).rejects.toBeInstanceOf(StorageError);
    expect(await db.rows("SELECT name FROM sqlite_master WHERE name = 'b'")).toEqual([]);
    expect(await db.rows('SELECT version FROM schema_migrations')).toEqual([['0000_a']]);
    expect(await db.foreignKeysEnabled()).toBe(true);
    await db.close();
  });

  it('SQL CHECKs reject partial money pairs, two sources, bad enums, and flags outside 0/1 (24)', async () => {
    const t = await createTestDatabases();
    try {
      const base = "INSERT INTO owned_cards (id, catalog_card_id, custom_card_id, name, name_search, set_id, local_id, language, variant, created_at, updated_at, purchase_price_cents, purchase_currency, condition) VALUES ('22222222-2222-4222-8222-222222222222', ?, ?, 'N','n','s','1','en',?, 'x','x', ?, ?, ?)";
      await expect(t.user.run(base, [null, null, 'normal', null, null, null])).rejects.toThrow(/CHECK/); // neither source
      await t.user.run("INSERT INTO catalog_identities (language, id, created_at) VALUES ('en','c1','x')");
      await expect(t.user.run(base, ['c1', null, 'normal', 100, null, null])).rejects.toThrow(/CHECK/); // cents without currency
      await expect(t.user.run(base, ['c1', null, 'normal', null, 'USD', null])).rejects.toThrow(/CHECK/); // currency without cents
      await expect(t.user.run(base, ['c1', null, 'bogus', null, null, null])).rejects.toThrow(/CHECK/);
      await expect(t.user.run(base, ['c1', null, 'normal', null, null, 'XX'])).rejects.toThrow(/CHECK/);
      await expect(t.user.run(base, ['c1', null, 'other', null, null, null])).rejects.toThrow(/CHECK/); // other needs detail
      await expect(t.user.run(base, ['missing', null, 'normal', null, null, null])).rejects.toThrow(/FOREIGN KEY/); // ledger FK enforced
      await t.user.run(base, ['c1', null, 'normal', 0, 'USD', 'NM']); // known zero is valid
      await expect(t.user.run('UPDATE app_settings SET sync_all_sets = 2')).rejects.toThrow(/CHECK/);
    } finally {
      await t.cleanup();
    }
  });

  it('has no ON DELETE CASCADE from the identity ledger into personal rows (38)', async () => {
    const t = await createTestDatabases();
    try {
      for (const table of ['owned_cards', 'price_snapshots', 'catalog_annotations']) {
        const fks = await t.user.rows(`PRAGMA foreign_key_list(${table})`);
        for (const fk of fks.filter((r) => String(r[2]) === 'catalog_identities')) expect(String(fk[6]).toUpperCase(), `${table} on_delete`).toBe('RESTRICT');
      }
      const cascades = (await t.user.rows("SELECT m.name, f.\"table\" FROM sqlite_master m, pragma_foreign_key_list(m.name) f WHERE m.type = 'table' AND f.\"on_delete\" = 'CASCADE'")).map((r) => `${r[0]}->${r[1]}`).sort();
      expect(cascades).toEqual(['collection_group_members->collection_groups', 'collection_group_members->owned_cards', 'grades->owned_cards']);
      expect(migrationChecksum(USER_MIGRATIONS[0]!)).toMatch(/^[a-f0-9]{64}$/);
    } finally {
      await t.cleanup();
    }
  });
});
