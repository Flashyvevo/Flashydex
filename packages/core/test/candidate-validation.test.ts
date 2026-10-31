import { createHash } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import Database from 'better-sqlite3';
import { afterEach, describe, expect, it } from 'vitest';
import { CATALOG_SCHEMA_OBJECTS, CATALOG_SCHEMA_FINGERPRINT } from '../src/db/catalog-fingerprint.generated';
import type { SqlDriver } from '../src/db/sql';
import { CatalogInstallService } from '../src/services/catalog-install';
import { validateCatalogCandidate } from '../src/services/candidate-validation';
import { FakeDiskPort, FAKE_PACK_COUNTS } from '../src/testing/fake-install-port';
import { harness, type Harness } from './helpers';

const HA = 'a'.repeat(64);
let h: Harness;
const all: Harness[] = [];
afterEach(async () => { while (all.length) await all.pop()!.cleanup(); });

async function attempt(corrupt: ((db: Database.Database) => void) | null, meta: FakeDiskPort['metaOverride'] = {}) {
  h = await harness();
  all.push(h);
  const port = new FakeDiskPort(h.t.dir, h.t.env);
  port.manifestJson = FakeDiskPort.manifest(['en'], '2026.10.31.001', HA);
  port.corrupt = corrupt;
  port.metaOverride = meta;
  const svc = new CatalogInstallService(h.ctx, port, { trustedOrigins: ['https://example.test'] });
  const result = await svc.install('en', () => undefined, new AbortController().signal).then((r) => ({ ok: r }), (e: { code: string; message: string }) => ({ err: e }));
  return { port, svc, result, disk: await port.inspect('en'), receipt: await svc.installed('en') };
}
const rejected = (r: Awaited<ReturnType<typeof attempt>>, pattern: RegExp) => {
  expect(r.result).toMatchObject({ err: { code: 'PACK_INVALID' } });
  expect((r.result as { err: { message: string } }).err.message).toMatch(pattern);
  expect(r.disk).toEqual({ activeRef: null, previousRef: null, candidateRefs: [] }); // nothing activated, candidate cleaned up
  expect(r.receipt.status).toBe('absent');
};

describe('R09 candidate validation (core owns all SQL checks)', () => {
  it('a faithful candidate installs', async () => {
    const r = await attempt(null);
    expect(r.result).toHaveProperty('ok');
    expect(r.receipt.status).toBe('installed');
  });

  it('trigger present -> PACK_INVALID', async () => {
    rejected(await attempt((db) => db.exec('CREATE TRIGGER evil AFTER INSERT ON catalog_sets BEGIN SELECT 1; END')), /trigger/);
  });

  it('view present -> PACK_INVALID', async () => {
    rejected(await attempt((db) => db.exec('CREATE VIEW v AS SELECT * FROM catalog_sets')), /view/);
  });

  it('extra table / extra index -> PACK_INVALID', async () => {
    rejected(await attempt((db) => db.exec('CREATE TABLE smuggled (x TEXT)')), /unexpected table/);
    rejected(await attempt((db) => db.exec('CREATE INDEX smuggled_idx ON catalog_cards(name)')), /unexpected index/);
  });

  it('schema drift (altered table, dropped index) -> PACK_INVALID', async () => {
    rejected(await attempt((db) => db.exec('ALTER TABLE catalog_sets ADD COLUMN extra TEXT')), /does not match this app/);
    const dropped = CATALOG_SCHEMA_OBJECTS.find((o) => o.type === 'index' && o.name.startsWith('cards'))?.name ?? (CATALOG_SCHEMA_OBJECTS.find((o) => o.type === 'index') as { name: string }).name;
    rejected(await attempt((db) => db.exec(`DROP INDEX ${dropped}`)), /incomplete/);
  });

  it('foreign key violation -> PACK_INVALID', async () => {
    rejected(await attempt((db) => {
      db.pragma('foreign_keys = OFF');
      db.exec("CREATE TEMP TABLE t AS SELECT * FROM catalog_cards WHERE id = 'tset-001'; UPDATE t SET id = 'fk-1', set_id = 'nosuch'; INSERT INTO catalog_cards SELECT * FROM t;");
    }), /foreign key/);
  });

  it('count mismatch vs manifest, wrong meta version/language/schema -> PACK_INVALID / APP_UPDATE_REQUIRED', async () => {
    rejected(await attempt((db) => db.exec("DELETE FROM catalog_cards WHERE id = 'tset-005'")), /cards count/);
    rejected(await attempt(null, { version: '2026.10.30.009' }), /catalog_meta/);
    rejected(await attempt(null, { language: 'ja' }), /catalog_meta/);
    const newer = await attempt(null, { schemaVersion: 2 });
    expect(newer.result).toMatchObject({ err: { code: 'APP_UPDATE_REQUIRED' } });
    expect(newer.disk.activeRef).toBeNull();
  });

  it('a candidate without catalog_meta -> PACK_INVALID', async () => {
    rejected(await attempt((db) => db.exec('DELETE FROM catalog_meta')), /catalog_meta/);
  });

  it('PRAGMA integrity_check failure and transport errors are FAILURES (never swallowed)', async () => {
    h = await harness();
    all.push(h);
    const port = new FakeDiskPort(h.t.dir, h.t.env);
    port.manifestJson = FakeDiskPort.manifest(['en']);
    const entry = { language: 'en', targetVersion: '2026.10.31.001', counts: { ...FAKE_PACK_COUNTS } };
    const staged = await port.stage({ ...(FakeDiskPort.manifest(['en']).languages as Record<string, never>).en as object, language: 'en' } as never, { trustedOrigins: [], onProgress: () => undefined });
    const real = await port.openForValidation(staged.candidateRef);
    await expect(validateCatalogCandidate(real, entry)).resolves.toMatchObject({ cards: 5 });
    const wrap = (override: (sql: string) => { rows: unknown[] } | 'throw' | null): SqlDriver => ({
      ...real,
      label: 'wrapped',
      proxy: async (sql, params, method) => {
        const o = override(sql);
        if (o === 'throw') throw new Error('bridge went away');
        return o ?? real.proxy(sql, params, method);
      },
      close: () => real.close()
    });
    await expect(validateCatalogCandidate(wrap((s) => (s.includes('integrity_check') ? { rows: [['*** in database main ***\nPage 7: btreeInitPage() returns error code 11']] } : null)), entry)).rejects.toMatchObject({ code: 'PACK_INVALID', message: expect.stringMatching(/integrity/) });
    await expect(validateCatalogCandidate(wrap((s) => (s.includes('integrity_check') ? 'throw' : null)), entry)).rejects.toMatchObject({ code: 'PACK_INVALID' });
    await expect(validateCatalogCandidate(wrap((s) => (s.includes('foreign_key_check') ? { rows: [['catalog_cards', 1, 'catalog_sets', 0]] } : null)), entry)).rejects.toMatchObject({ code: 'PACK_INVALID', message: expect.stringMatching(/foreign key/) });
    await real.close();
  });

  it('the bundled fingerprint module matches migrations/catalog/*.sql (regenerate with `npm run db:embed` when a migration changes)', () => {
    const here = dirname(fileURLToPath(import.meta.url));
    const sql = readFileSync(join(here, '..', 'migrations', 'catalog', '0000_initial.sql'), 'utf8').replace(/\r\n/g, '\n');
    const db = new Database(':memory:');
    for (const stmt of sql.split('--> statement-breakpoint').map((s) => s.trim()).filter(Boolean)) db.exec(stmt);
    const objects = (db.prepare("SELECT type, name, tbl_name AS tbl, sql FROM sqlite_master WHERE name NOT LIKE 'sqlite\\_%' ESCAPE '\\' ORDER BY type, name").all() as Array<{ type: string; name: string; tbl: string; sql: string | null }>)
      .map((r) => ({ type: r.type, name: r.name, table: r.tbl, sql: r.sql === null ? null : r.sql.replace(/\s+/g, ' ').trim() }));
    expect(objects).toEqual(CATALOG_SCHEMA_OBJECTS.map((o) => ({ ...o })));
    expect(createHash('sha256').update(JSON.stringify(objects)).digest('hex')).toBe(CATALOG_SCHEMA_FINGERPRINT);
  });
});
