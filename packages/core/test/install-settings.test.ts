import { existsSync, rmSync } from 'node:fs';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { CatalogInstallService, type CatalogInstallPort, type PackEntry, type PackInstallResult } from '../src/services/catalog-install';
import { CancelledError, ValidationError } from '../src/errors';
import { createCatalogFile } from '../src/testing/node-driver';
import { seedCatalog } from '../src/testing/catalog-fixture';
import { copyOf, dumpPersonal, harness, ownedCount, revision, TEST_SET, testCards, type Harness } from './helpers';

const HASH = (n: string) => n.repeat(64).slice(0, 64);
const entryJson = (language: 'en' | 'ja', version = '2026.10.31.001', sha = HASH('a')) => ({
  currentVersion: null, targetVersion: version, fullPackUrl: `https://example.test/catalog-${language}-${version}.db.zst`, setIndexUrl: `https://example.test/set-index-${language}.json`,
  compressedBytes: 1000, uncompressedBytes: 5000, sha256: sha, schemaVersion: 1, builtAt: '2026-10-31T01:00:00.000Z',
  counts: { sets: 1, cards: 5, variants: 0, prices: 0, unpublishedSets: 0 }
});
const manifest = (languages: Array<'en' | 'ja'>, version = '2026.10.31.001', sha = HASH('a')) => ({
  manifestVersion: 1, currentVersion: null, targetVersion: version, builtAt: '2026-10-31T01:00:00.000Z',
  languages: Object.fromEntries(languages.map((l) => [l, entryJson(l, version, sha)]))
});

class FakePort implements CatalogInstallPort {
  allowDevUrls = false;
  manifestJson: unknown = manifest(['en', 'ja']);
  manifestError: Error | null = null;
  installError: (Error & { code?: string }) | null = null;
  hold: Promise<void> | null = null;
  previous = new Set<string>();
  calls: string[] = [];
  constructor(private readonly h: Harness) {}
  capabilities() { return { fullInstall: true, atomicActivation: true, attachReads: false, reason: null }; }
  async fetchManifest() { if (this.manifestError) throw this.manifestError; return this.manifestJson; }
  async install(entry: PackEntry, options: { onProgress: (p: never) => void; signal?: AbortSignal }): Promise<PackInstallResult> {
    this.calls.push(`install:${entry.language}:${entry.targetVersion}`);
    options.onProgress({ phase: 'downloading', compressedBytesDone: 10, compressedBytesTotal: 1000, decompressedBytesDone: 0, decompressedBytesTotal: 5000 } as never);
    if (this.hold) {
      await new Promise<void>((resolve, reject) => {
        options.signal?.addEventListener('abort', () => reject(Object.assign(new Error('Cancelled'), { code: 'CANCELLED' })), { once: true });
        void this.hold!.then(resolve);
      });
    }
    if (this.installError) throw this.installError; // nothing on disk was touched: the previous catalog stays active
    const path = this.h.t.catalogPath(entry.language);
    const hadPrevious = existsSync(path);
    if (hadPrevious) this.previous.add(entry.language);
    rmSync(path, { force: true });
    const writer = await createCatalogFile(path, entry.language, this.h.t.env);
    await seedCatalog(writer, entry.language, { sets: [TEST_SET], cards: testCards().map((c) => ({ ...c, name: `${entry.targetVersion} ${c.name}` })) });
    await writer.close();
    options.onProgress({ phase: 'installed', compressedBytesDone: 1000, compressedBytesTotal: 1000, decompressedBytesDone: 5000, decompressedBytesTotal: 5000 } as never);
    return {
      language: entry.language, version: entry.targetVersion, sha256: entry.sha256, bytes: 5000, ref: `ref-${entry.language}-${entry.targetVersion}`, previousRef: hadPrevious ? 'prev' : null,
      counts: entry.counts, metrics: { metricsVersion: 1, totalMs: 12 }
    };
  }
  async finalize(language: 'en' | 'ja') { this.calls.push(`finalize:${language}`); this.previous.delete(language); }
  async rollback(language: 'en' | 'ja') { this.calls.push(`rollback:${language}`); return this.previous.delete(language); }
  async hasPrevious(language: 'en' | 'ja') { return this.previous.has(language); }
  async remove(language: 'en' | 'ja') { this.calls.push(`remove:${language}`); rmSync(this.h.t.catalogPath(language), { force: true }); }
  async activeRef(language: 'en' | 'ja') { return existsSync(this.h.t.catalogPath(language)) ? `ref-${language}` : null; }
}

let h: Harness;
let port: FakePort;
let install: CatalogInstallService;
const noop = () => undefined;
beforeEach(async () => {
  h = await harness();
  port = new FakePort(h);
  install = new CatalogInstallService(h.ctx, port);
});
afterEach(() => h.cleanup());

describe('CatalogInstallService (53, 31 manifest, 37)', () => {
  it('installs: durable receipt + job + metrics committed together, catalog readable, owned rows untouched', async () => {
    await h.collection.add({ language: 'en', variant: 'normal', customCardId: (await h.collection.createCustom({ name: 'C', language: 'en' })).id });
    const before = await dumpPersonal(h);
    const rev = await revision(h);
    const seen: string[] = [];
    const result = await install.install('en', (p) => seen.push(p.phase), new AbortController().signal);
    expect(result).toMatchObject({ language: 'en', status: 'installed', version: '2026.10.31.001', sha256: HASH('a'), schemaVersion: 1, generation: 1 });
    expect(result).not.toHaveProperty('activeRef'); // opaque refs never leave core
    expect(seen).toContain('downloading');
    expect(seen.at(-1)).toBe('installed');
    expect(await h.t.user.rows("SELECT state, lock_key FROM catalog_install_jobs")).toEqual([['installed', null]]);
    expect(Number(await h.t.user.scalar('SELECT COUNT(*) FROM pack_metrics'))).toBe(1);
    expect(port.calls).toEqual(['install:en:2026.10.31.001', 'finalize:en']);
    expect((await h.catalog.getCard({ language: 'en', cardId: 'tset-001' })).name).toBe('2026.10.31.001 Alpha Mon');
    expect(await dumpPersonal(h)).toEqual(before); // 37: installing never touches personal rows
    expect(await revision(h)).toBe(rev);
    const status = await install.status('en');
    expect(status).toMatchObject({ installed: { status: 'installed', generation: 1 }, job: null, lastError: null, rollbackAvailable: false });
    expect(await install.status('ja')).toMatchObject({ installed: { status: 'absent', version: null, generation: 0 } });
  });

  it('reinstalling a newer version keeps owned_cards count and every personal row (37)', async () => {
    await install.install('en', noop, new AbortController().signal);
    await h.collection.bulkAdd({ quantity: 3, copy: copyOf('tset-001', { grade: { company: 'PSA', grade: '9' } as never }) });
    const before = await dumpPersonal(h);
    port.manifestJson = manifest(['en', 'ja'], '2026.11.01.001', HASH('b'));
    const again = await install.install('en', noop, new AbortController().signal);
    expect(again).toMatchObject({ version: '2026.11.01.001', generation: 2 });
    expect(await ownedCount(h)).toBe(3);
    const after = await dumpPersonal(h);
    expect({ ...after, price_snapshots: [] }).toEqual({ ...before, price_snapshots: [] });
    expect((await h.collection.list({ groupBy: 'copy' })).data[0]).toMatchObject({ catalogAvailable: true, name: '2026.10.31.001 Alpha Mon' }); // snapshot of the FIRST pack, not rewritten by the new one
  });

  it('same installed version and hash is a no-op', async () => {
    await install.install('en', noop, new AbortController().signal);
    port.calls.length = 0;
    const again = await install.install('en', noop, new AbortController().signal);
    expect(again.generation).toBe(1);
    expect(port.calls).toEqual([]);
  });

  it('hash mismatch fails with PACK_HASH_MISMATCH and keeps the previous catalog and receipt', async () => {
    await install.install('en', noop, new AbortController().signal);
    port.manifestJson = manifest(['en'], '2026.11.01.001', HASH('c'));
    port.installError = Object.assign(new Error('Decompressed SHA-256 does not match the manifest'), { code: 'PACK_HASH_MISMATCH' });
    await expect(install.install('en', noop, new AbortController().signal)).rejects.toMatchObject({ code: 'PACK_HASH_MISMATCH' });
    expect(await install.status('en')).toMatchObject({ installed: { version: '2026.10.31.001', generation: 1, status: 'installed' }, lastError: { code: 'PACK_HASH_MISMATCH' } });
    expect((await h.catalog.getCard({ language: 'en', cardId: 'tset-001' })).name).toBe('2026.10.31.001 Alpha Mon'); // still the old catalog
    expect(await h.t.user.rows("SELECT state, lock_key FROM catalog_install_jobs ORDER BY created_at DESC LIMIT 1")).toEqual([['failed', null]]);
    port.installError = null;
    await expect(install.install('en', noop, new AbortController().signal)).resolves.toMatchObject({ version: '2026.11.01.001' }); // lock was released
  });

  it('cancel before activation leaves installed state unchanged and releases the lock', async () => {
    let release!: () => void;
    port.hold = new Promise<void>((r) => { release = r; });
    const controller = new AbortController();
    const running = install.install('en', noop, controller.signal);
    await new Promise((r) => setTimeout(r, 50));
    expect(install.activeProgress?.phase).toBe('downloading');
    await expect(install.install('ja', noop, new AbortController().signal)).rejects.toMatchObject({ code: 'ACTIVE_WORK' }); // one global install
    controller.abort();
    await expect(running).rejects.toBeInstanceOf(CancelledError);
    release();
    expect(await install.status('en')).toMatchObject({ installed: { status: 'absent', generation: 0 }, job: null, lastError: { code: 'CANCELLED' } });
    expect(await h.t.user.rows('SELECT state, lock_key FROM catalog_install_jobs')).toEqual([['cancelled', null]]);
    expect(existsSync(h.t.catalogPath('en'))).toBe(false);
    port.hold = null;
    await expect(install.install('en', noop, new AbortController().signal)).resolves.toMatchObject({ status: 'installed' });
  });

  it('a failed durable commit restores the previous catalog through the port and reports the error', async () => {
    await install.install('en', noop, new AbortController().signal);
    port.manifestJson = manifest(['en'], '2026.11.01.001', HASH('d'));
    const original = port.install.bind(port);
    port.install = async (entry, options) => ({ ...(await original(entry, options)), ref: null as unknown as string }); // violates installed_catalogs CHECK
    await expect(install.install('en', noop, new AbortController().signal)).rejects.toBeInstanceOf(Error);
    expect(port.calls).toContain('rollback:en');
    expect(await install.status('en')).toMatchObject({ installed: { version: '2026.10.31.001', status: 'installed' } });
  });

  it('uninstall removes only that catalog; owned copies, history and settings stay; repeating is a no-op', async () => {
    await install.install('en', noop, new AbortController().signal);
    await install.install('ja', noop, new AbortController().signal);
    await h.collection.add(copyOf('tset-001'));
    const before = await dumpPersonal(h);
    const result = await install.uninstall({ language: 'en', confirm: true });
    expect(result).toMatchObject({ status: 'absent', version: null, generation: 2 });
    expect(await dumpPersonal(h)).toEqual(before);
    expect(await install.status('ja')).toMatchObject({ installed: { status: 'installed' } });
    expect((await h.collection.list({ groupBy: 'copy' })).data[0]).toMatchObject({ name: '2026.10.31.001 Alpha Mon', catalogAvailable: false });
    await expect(h.catalog.getSet({ language: 'en', setId: 'tset' })).rejects.toMatchObject({ code: 'NOT_FOUND' });
    expect((await install.uninstall({ language: 'en', confirm: true })).generation).toBe(2);
    await expect(install.uninstall({ language: 'en', confirm: false as never })).rejects.toBeInstanceOf(ValidationError);
    expect((await h.settings.get()).languages).toEqual(['en', 'ja']); // settings untouched
  });

  it('rollback: NO_ROLLBACK when none; restores the previous receipt when one is retained', async () => {
    await expect(install.rollback('en')).rejects.toMatchObject({ code: 'NO_ROLLBACK' });
    await install.install('en', noop, new AbortController().signal);
    port.previous.add('en'); // a retained previous copy (as after a failed-activation recovery window)
    const restored = await install.rollback('en');
    expect(port.calls).toContain('rollback:en');
    expect(restored.status).toBe('absent'); // the journal says the first install had no predecessor
    expect(restored.generation).toBe(2);
  });

  it('checkManifest: sizes, versions, updateAvailable, incompatible schema, network failure leaves catalogs usable', async () => {
    const check = await install.checkManifest();
    expect(check).toMatchObject({ manifestVersion: 1 });
    expect(check.languages.map((l) => [l.language, l.compatible, l.updateAvailable, l.compressedBytes, l.strategy])).toEqual([['en', true, true, 1000, 'full'], ['ja', true, true, 1000, 'full']]);
    expect(check.languages[0]?.setIndexUrl).toBe('https://example.test/set-index-en.json');
    await install.install('en', noop, new AbortController().signal);
    expect((await install.checkManifest({ languages: ['en'] })).languages[0]).toMatchObject({ currentVersion: '2026.10.31.001', updateAvailable: false });
    const future = manifest(['en']);
    (future.languages as Record<string, { schemaVersion: number }>).en!.schemaVersion = 99;
    port.manifestJson = future;
    expect((await install.checkManifest({ languages: ['en'] })).languages[0]).toMatchObject({ compatible: false, reason: 'APP_UPDATE_REQUIRED', updateAvailable: false });
    await expect(install.install('en', noop, new AbortController().signal)).rejects.toMatchObject({ code: 'APP_UPDATE_REQUIRED' });
    port.manifestError = Object.assign(new Error('offline'), { code: 'HTTP_FAILED' });
    await expect(install.checkManifest()).rejects.toMatchObject({ code: 'HTTP_FAILED' });
    expect((await h.catalog.getCard({ language: 'en', cardId: 'tset-001' })).id).toBe('tset-001'); // installed catalog unaffected
    port.manifestError = null;
    port.manifestJson = { manifestVersion: 2 };
    await expect(install.checkManifest()).rejects.toMatchObject({ code: 'MANIFEST_INVALID' });
    port.manifestJson = { ...manifest(['en']), languages: { en: { ...entryJson('en'), fullPackUrl: 'http://insecure.test/catalog-en-2026.10.31.001.db.zst' } } };
    await expect(install.checkManifest()).rejects.toMatchObject({ code: 'MANIFEST_INVALID' }); // https only outside dev
  });

  it('install requires the language to be selected in settings', async () => {
    await h.settings.update({ languages: ['ja'] });
    await expect(install.install('en', noop, new AbortController().signal)).rejects.toMatchObject({ code: 'CATALOG_NOT_SELECTED' });
    expect(port.calls).toEqual([]);
  });

  it('boot recovery marks interrupted jobs, releases the lock, and reconciles receipts with the files on disk', async () => {
    await install.install('en', noop, new AbortController().signal);
    const now = '2026-10-30T12:00:00.000Z';
    await h.t.user.run(
      `INSERT INTO catalog_install_jobs (id, language, state, lock_key, token, manifest_entry_json, progress_json, journal_json, created_at, updated_at)
       VALUES ('44444444-4444-4444-8444-444444444444','ja','downloading','catalog-install','t','{}','{}','{}',?,?)`, [now, now]
    );
    rmSync(h.t.catalogPath('en')); // crash after file removal but before the receipt commit
    const recovered = await install.recover();
    expect(recovered).toEqual({ interruptedJobs: 1, reconciled: ['en'] });
    expect(await h.t.user.rows("SELECT state, lock_key FROM catalog_install_jobs WHERE language = 'ja'")).toEqual([['interrupted', null]]);
    expect(await install.status('ja')).toMatchObject({ lastError: { code: 'INTERRUPTED' }, installed: { status: 'absent' } });
    expect(await install.status('en')).toMatchObject({ installed: { status: 'absent', generation: 2 } });
    await expect(install.install('ja', noop, new AbortController().signal)).resolves.toMatchObject({ status: 'installed' }); // lock free again
  });
});

describe('SettingsRepo (58, 40)', () => {
  it('has the DATA-MODEL defaults and persists independent of the collection revision', async () => {
    expect(await h.settings.get()).toMatchObject({
      languages: ['en', 'ja'], setsFollowed: [], syncAllSets: false, hideTcgPocket: true, defaultCurrency: 'USD', disclaimerAcknowledged: false,
      disclaimerAcknowledgedAt: null, onboardingCompletedAt: null
    });
    const rev = await revision(h);
    const updated = await h.settings.update({
      languages: ['en'], setsFollowed: [{ language: 'en', setId: 'tset' }], hideTcgPocket: false, defaultCurrency: 'EUR', disclaimerAcknowledged: true, onboardingCompleted: true
    });
    expect(updated).toMatchObject({ languages: ['en'], hideTcgPocket: false, defaultCurrency: 'EUR', disclaimerAcknowledged: true });
    expect(updated.disclaimerAcknowledgedAt).toMatch(/^\d{4}-\d{2}-\d{2}T.*Z$/);
    expect(updated.onboardingCompletedAt).not.toBeNull();
    expect(await revision(h)).toBe(rev);
    const reopened = await h.t.reopen();
    const h2 = (await import('./helpers')).harnessFor(reopened);
    expect(await h2.settings.get()).toEqual(updated); // survives relaunch
    const cleared = await h2.settings.update({ disclaimerAcknowledged: false, onboardingCompleted: false });
    expect(cleared).toMatchObject({ disclaimerAcknowledged: false, disclaimerAcknowledgedAt: null, onboardingCompletedAt: null });
    h = h2;
  });

  it('rejects empty patches, unknown keys, duplicate languages/sets, and removing a language that still has followed sets', async () => {
    const before = await h.settings.get();
    await expect(h.settings.update({})).rejects.toBeInstanceOf(ValidationError);
    await expect(h.settings.update({ bogus: 1 } as never)).rejects.toBeInstanceOf(ValidationError);
    await expect(h.settings.update({ languages: ['en', 'en'] })).rejects.toBeInstanceOf(ValidationError);
    await expect(h.settings.update({ languages: [] as never })).rejects.toBeInstanceOf(ValidationError);
    await expect(h.settings.update({ defaultCurrency: 'GBP' as never })).rejects.toBeInstanceOf(ValidationError);
    await expect(h.settings.update({ setsFollowed: [{ language: 'en', setId: 'a' }, { language: 'en', setId: 'a' }] })).rejects.toBeInstanceOf(ValidationError);
    await h.settings.update({ setsFollowed: [{ language: 'ja', setId: 'j1' }] });
    await expect(h.settings.update({ languages: ['en'] })).rejects.toBeInstanceOf(ValidationError);
    await h.settings.update({ languages: ['en'], setsFollowed: [] }); // explicit removal is fine
    expect((await h.settings.get()).setsFollowed).toEqual([]);
    expect(before.defaultCurrency).toBe('USD');
  });
});
