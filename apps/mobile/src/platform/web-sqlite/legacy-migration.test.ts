// @vitest-environment node
import { createHash } from 'node:crypto';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { SqlDriver } from '@flashydex/core';
import { WebStorageError, type MigrationMarker, type RoleStore, type UserPrepareProgress, type UserRole } from '../web-storage/contract';
import { createWebSqliteClient, type WebSqliteClientInternal } from './client';
import { runStatement, type Oo1Db } from './executor';
import { createEnsureUserDatabase, MigrationBlockedError } from './legacy-migration';
import { dumpPersonal, operationalSnapshot, seedLegacyUser, STALE_JEEP_REF } from './testing/legacy-seed';
import { createMemoryHarness, type MemoryHarness } from './testing/memory-env';

/** In-memory RoleStore: only the methods ensureUserDatabase may use are real; anything else fails the test. */
class FakeRoles {
  userRole: UserRole | null = null;
  marker: MigrationMarker | null = null;
  commits: { role: UserRole; marker: MigrationMarker | null }[] = [];
  failCommit: Error | null = null;
  async user() { return this.userRole; }
  async migration() { return this.marker; }
  async commitUser(role: UserRole, marker: MigrationMarker | null) {
    if (this.failCommit) throw this.failCommit;
    if (this.userRole && this.userRole.path !== role.path) throw new WebStorageError('BUSY', 'user role exists');
    this.userRole = role;
    this.marker = marker;
    this.commits.push({ role, marker });
  }
  asStore(): RoleStore {
    return new Proxy(this, { get: (target, key) => {
      if (key === 'user' || key === 'migration' || key === 'commitUser') return ((target as unknown as Record<string, (...a: unknown[]) => unknown>)[key] as (...a: unknown[]) => unknown).bind(target);
      return () => { throw new Error(`RoleStore.${String(key)} must not be used by ensureUserDatabase`); };
    } }) as unknown as RoleStore;
  }
}

vi.setConfig({ testTimeout: 30_000 });

let h: MemoryHarness;
let client: WebSqliteClientInternal;
let roles: FakeRoles;
let legacy: Uint8Array | null;
let legacyReads: number;
let ids: number;

const ensure = () => createEnsureUserDatabase({
  readLegacy: async () => { legacyReads += 1; return legacy ? new Uint8Array(legacy) : null; },
  now: () => new Date('2026-10-31T10:00:00.000Z'),
  newId: () => `id${String(++ids).padStart(6, '0')}`
});

beforeEach(async () => {
  h = await createMemoryHarness();
  client = createWebSqliteClient({ workerFactory: h.workerFactory });
  roles = new FakeRoles();
  legacy = null;
  legacyReads = 0;
  ids = 0;
});

async function buildLegacy(options: { extraOwned?: number } = {}) {
  const db = new h.sqlite3.oo1.DB(':memory:') as unknown as Oo1Db;
  const driver: SqlDriver = { label: 'seed', proxy: async (sql, params, method) => ({ rows: runStatement(h.sqlite3, db, sql, params, method) }), close: async () => undefined };
  await seedLegacyUser(driver, options);
  const dump = await dumpPersonal(driver);
  const ops = await operationalSnapshot(driver);
  const bytes = h.sqlite3.capi.sqlite3_js_db_export(db as never);
  db.close();
  return { bytes, dump, ops };
}

const run = (progress?: (p: UserPrepareProgress) => void) => ensure()({ client, roles: roles.asStore(), onProgress: progress });
const sha = (b: Uint8Array) => createHash('sha256').update(b).digest('hex');

async function openUser(path: string): Promise<SqlDriver> {
  return client.driver(path, 'verify', { mode: 'rw', create: false, role: 'user' });
}

describe('decision table', () => {
  it('no role + no legacy -> creates /user/u-<id>.db and commits origin fresh with a null marker', async () => {
    const outcome = await run();
    expect(outcome).toEqual({ kind: 'fresh', path: '/user/u-id000001.db' });
    expect(roles.commits).toEqual([{ role: { path: '/user/u-id000001.db', origin: 'fresh', createdAt: '2026-10-31T10:00:00.000Z' }, marker: null }]);
    expect(await client.listFiles()).toEqual(['/user/u-id000001.db']);
    expect(await run()).toEqual({ kind: 'existing', path: '/user/u-id000001.db' }); // fresh role without marker + valid USER -> existing
    expect(roles.commits).toHaveLength(1);
  });

  it('role without marker + a legacy key present -> existing; legacy is not even read', async () => {
    await run();
    legacy = (await buildLegacy()).bytes;
    legacyReads = 0;
    expect(await run()).toMatchObject({ kind: 'existing' });
    expect(legacyReads).toBe(0);
  });

  it('marker + valid new USER (migrated) -> existing, legacy never replayed', async () => {
    const seeded = await buildLegacy();
    legacy = seeded.bytes;
    const first = await run();
    expect(first.kind).toBe('migrated');
    legacyReads = 0;
    const second = await run();
    expect(second).toEqual({ kind: 'existing', path: (first as { path: string }).path });
    expect(legacyReads).toBe(0);
    expect(roles.commits).toHaveLength(1);
  });

  it('role refers to a missing file -> MIGRATION_BLOCKED user_missing, never a fresh database', async () => {
    roles.userRole = { path: '/user/u-gone0001.db', origin: 'fresh', createdAt: 'x' };
    await expect(run()).rejects.toMatchObject({ code: 'MIGRATION_BLOCKED', reason: 'user_missing' });
    expect(await client.listFiles()).toEqual([]);
    expect(roles.commits).toHaveLength(0);
  });

  it('unreadable (garbage) new USER -> user_unreadable even when a legacy key exists; nothing is replaced', async () => {
    h.pool.files.set('/user/u-bad00001.db', new Uint8Array(4096).fill(7));
    roles.userRole = { path: '/user/u-bad00001.db', origin: 'migrated', createdAt: 'x' };
    legacy = (await buildLegacy()).bytes;
    await expect(run()).rejects.toMatchObject({ code: 'MIGRATION_BLOCKED', reason: 'user_unreadable' });
    expect(h.pool.files.get('/user/u-bad00001.db')?.[0]).toBe(7);
    expect(roles.commits).toHaveLength(0);
  });

  it('future-schema new USER -> future_schema (never touched)', async () => {
    const seeded = await buildLegacy();
    const db = new h.sqlite3.oo1.DB(':memory:') as unknown as Oo1Db;
    h.sqlite3.capi.sqlite3_deserialize(db.pointer, 'main', h.sqlite3.wasm.allocFromTypedArray(seeded.bytes), seeded.bytes.length, seeded.bytes.length, h.sqlite3.capi.SQLITE_DESERIALIZE_FREEONCLOSE | h.sqlite3.capi.SQLITE_DESERIALIZE_RESIZEABLE);
    db.exec("INSERT INTO schema_migrations (version, checksum, applied_at) VALUES ('9999_future', 'x', 'now')");
    h.pool.files.set('/user/u-future01.db', h.sqlite3.capi.sqlite3_js_db_export(db as never));
    db.close();
    roles.userRole = { path: '/user/u-future01.db', origin: 'fresh', createdAt: 'x' };
    await expect(run()).rejects.toMatchObject({ code: 'MIGRATION_BLOCKED', reason: 'future_schema' });
  });

  it('legacy > 16 MiB -> legacy_too_large, nothing created, no role', async () => {
    legacy = new Uint8Array(16 * 1024 * 1024 + 4096);
    await expect(run()).rejects.toMatchObject({ code: 'MIGRATION_BLOCKED', reason: 'legacy_too_large' });
    expect(await client.listFiles()).toEqual([]);
    expect(roles.commits).toHaveLength(0);
  });

  it('corrupt legacy (not SQLite / truncated) -> legacy_corrupt, nothing created', async () => {
    legacy = new Uint8Array(8192).fill(1);
    await expect(run()).rejects.toMatchObject({ reason: 'legacy_corrupt' });
    const good = (await buildLegacy()).bytes;
    legacy = good.slice(0, good.length - 100);
    await expect(run()).rejects.toMatchObject({ reason: 'legacy_corrupt' });
    expect(await client.listFiles()).toEqual([]);
  });

  it('legacy with a damaged page -> blocked, the staged copy is unlinked, legacy untouched, no role', async () => {
    const good = (await buildLegacy({ extraOwned: 300 })).bytes;
    const damaged = new Uint8Array(good);
    damaged.fill(0xff, 4096 * 3, 4096 * 5);
    legacy = damaged;
    const error = await run().catch((e: unknown) => e);
    expect(error).toBeInstanceOf(WebStorageError);
    expect((error as WebStorageError).code).toBe('MIGRATION_BLOCKED');
    expect((await client.listFiles()).filter((p) => p.startsWith('/user/'))).toEqual([]);
    expect(roles.commits).toHaveLength(0);
  });

  it('legacy that is a valid SQLite file without the core migration history -> legacy_unsupported_schema', async () => {
    const db = new h.sqlite3.oo1.DB(':memory:') as unknown as Oo1Db;
    db.exec('create table unrelated(a); insert into unrelated values (1)');
    legacy = h.sqlite3.capi.sqlite3_js_db_export(db as never);
    db.close();
    await expect(run()).rejects.toMatchObject({ reason: 'legacy_unsupported_schema' });
    expect((await client.listFiles()).filter((p) => p.startsWith('/user/'))).toEqual([]);
  });

  it('no role, no legacy, but an orphan USER file with data -> orphan_user_data (never a new empty DB); an EMPTY orphan is adopted', async () => {
    const d = await client.driver('/user/u-orphan01.db', 'x', { mode: 'rw', create: true, role: 'user' });
    await d.proxy('create table t(a)', [], 'run');
    await d.close();
    await expect(run()).rejects.toMatchObject({ reason: 'orphan_user_data' });
    await client.unlink('/user/u-orphan01.db');
    const e = await client.driver('/user/u-empty001.db', 'x', { mode: 'rw', create: true, role: 'user' });
    await e.close();
    expect(await run()).toEqual({ kind: 'fresh', path: '/user/u-empty001.db' });
  });

  it('a client that cannot import bytes -> client_cannot_import', async () => {
    legacy = (await buildLegacy()).bytes;
    await expect(ensure()({ client: Object.assign(Object.create(client), { importBytes: undefined }), roles: roles.asStore() })).rejects.toMatchObject({ reason: 'client_cannot_import' });
  });
});

describe('migration', () => {
  it('imports, validates, resets only operational receipts, commits ONE role+marker; personal data is byte-equal', async () => {
    const seeded = await buildLegacy({ extraOwned: 40 });
    legacy = seeded.bytes;
    const phases: string[] = [];
    const outcome = await run((p) => phases.push(p.phase));
    expect(outcome.kind).toBe('migrated');
    if (outcome.kind !== 'migrated') return;
    expect(outcome.path).toBe('/user/m-id000001.db');
    expect(outcome.legacyBytes).toBe(seeded.bytes.length);
    expect(phases).toEqual(['checking', 'reading-legacy', 'importing', 'importing', 'validating', 'finalizing']);
    expect(roles.commits).toHaveLength(1); // exactly one atomic commit
    const marker = roles.commits[0]?.marker as MigrationMarker;
    expect(marker).toMatchObject({ version: 1, state: 'completed', source: 'jeep-indexeddb', userPath: outcome.path, legacyBytes: seeded.bytes.length, legacyRetained: true, legacySha256: sha(seeded.bytes) });
    expect(marker.counts).toEqual(outcome.counts);
    expect(roles.commits[0]?.role).toMatchObject({ path: outcome.path, origin: 'migrated' });
    // counts: every personal table, including owned/custom/grades/acquisitions/groups/locations/settings
    for (const table of ['owned_cards', 'custom_cards', 'grades', 'acquisitions', 'collection_groups', 'storage_locations', 'collection_group_members', 'scan_sessions', 'price_snapshots', 'catalog_annotations', 'catalog_identities', 'app_settings', 'app_state']) {
      expect(outcome.counts).toHaveProperty(table);
    }
    expect(outcome.counts.owned_cards).toBe(43);
    expect(Object.keys(outcome.counts)).not.toContain('installed_catalogs');
    expect(await client.listFiles()).toEqual([outcome.path]);

    const driver = await openUser(outcome.path);
    expect(await dumpPersonal(driver)).toEqual(seeded.dump); // every personal row/value identical (null, 0, '', leading zeros, multilingual)
    const ops = await operationalSnapshot(driver);
    expect(seeded.ops.installed).toContainEqual(['en', 'installed', '2026.10.1', 'a'.repeat(64), '2026-10-01T12:00:00.000Z', 1, STALE_JEEP_REF]);
    expect(ops.installed.every((r) => r[1] === 'absent' && r.slice(2).every((v) => v === null))).toBe(true);
    expect(ops.jobs).toEqual([['job-1', 'interrupted', null]]);
    expect(ops.sync).toEqual([['sync-1', 'interrupted', null]]);
    expect(ops.admission).toEqual([]);
    expect(await driver.proxy("SELECT collection_revision FROM app_state WHERE id = 'collection'", [], 'get')).toEqual({ rows: [7] }); // revision untouched
    expect(await driver.proxy('PRAGMA integrity_check', [], 'get')).toEqual({ rows: ['ok'] });
    expect(await driver.proxy('PRAGMA foreign_key_check', [], 'values')).toEqual({ rows: [] });
    await driver.close();
  });

  it('rerun -> existing; counts and rows are not duplicated and legacy is not replayed', async () => {
    const seeded = await buildLegacy();
    legacy = seeded.bytes;
    const first = await run();
    legacyReads = 0;
    const second = await run();
    expect(second.kind).toBe('existing');
    expect(legacyReads).toBe(0);
    const driver = await openUser((first as { path: string }).path);
    expect(await dumpPersonal(driver)).toEqual(seeded.dump);
  });

  it('crash BEFORE commitUser: nothing authoritative; next boot unlinks the orphan m-* and redoes from legacy with a NEW path', async () => {
    const seeded = await buildLegacy();
    legacy = seeded.bytes;
    roles.failCommit = new Error('tab killed');
    await expect(run()).rejects.toThrow('tab killed');
    expect(roles.userRole).toBeNull();
    expect(await client.listFiles()).toEqual(['/user/m-id000001.db']); // staged orphan, validated but unreferenced
    roles.failCommit = null;
    const outcome = await run();
    expect(outcome).toMatchObject({ kind: 'migrated', path: '/user/m-id000002.db' });
    expect(await client.listFiles()).toEqual(['/user/m-id000002.db']); // the old orphan is gone
    const driver = await openUser('/user/m-id000002.db');
    expect(await dumpPersonal(driver)).toEqual(seeded.dump);
  });

  it('crash AFTER commitUser: uses the new USER, never replays legacy even if the legacy key changed', async () => {
    const seeded = await buildLegacy();
    legacy = seeded.bytes;
    const first = await run();
    const changed = await buildLegacy({ extraOwned: 99 }); // a stale tab rewrote the legacy key
    legacy = changed.bytes;
    legacyReads = 0;
    expect(await run()).toEqual({ kind: 'existing', path: (first as { path: string }).path });
    expect(legacyReads).toBe(0);
    const driver = await openUser((first as { path: string }).path);
    expect(await dumpPersonal(driver)).toEqual(seeded.dump);
  });

  it('a stale m-* orphan is unlinked even when the role exists (not referenced), but never the role path or u-* files', async () => {
    const seeded = await buildLegacy();
    legacy = seeded.bytes;
    const first = (await run()) as { path: string };
    h.pool.files.set('/user/m-stale0001.db', new Uint8Array(1024));
    h.pool.files.set('/user/u-keepme01.db', new Uint8Array(1024));
    await run();
    expect(await client.listFiles()).toEqual(expect.arrayContaining([first.path, '/user/u-keepme01.db']));
    expect(await client.listFiles()).not.toContain('/user/m-stale0001.db');
  });

  it('quota during the staged import surfaces as QUOTA, leaves no file and no role (legacy stays authoritative)', async () => {
    legacy = (await buildLegacy()).bytes;
    h.pool.capacity = 0;
    h.pool.failReserve = true;
    const error = await run().catch((e: unknown) => e);
    expect(error).toBeInstanceOf(WebStorageError);
    expect(['QUOTA', 'CAPACITY']).toContain((error as WebStorageError).code);
    expect(await client.listFiles()).toEqual([]);
    expect(roles.commits).toHaveLength(0);
  });

  it('MigrationBlockedError carries a stable, data-free reason', () => {
    const e = new MigrationBlockedError('legacy_too_large');
    expect(e.code).toBe('MIGRATION_BLOCKED');
    expect(e.reason).toBe('legacy_too_large');
    expect(e.message).not.toMatch(/[0-9a-f]{32}/);
  });
});
