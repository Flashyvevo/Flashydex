import Database from 'better-sqlite3';
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterAll, describe, expect, it } from 'vitest';
import { applyCatalogMigrations, loadCatalogMigrations, normalizeSqlText, schemaFingerprint } from '../src/migrations';
import { mergeManifest, validateManifest, type CatalogManifest, type ManifestEntry } from '../src/manifest';
import { compressFile, decompressFile, sha256File, zstdWindowBytes } from '../src/zstd';

const dir = mkdtempSync(join(tmpdir(), 'fdx-builder-'));
afterAll(() => rmSync(dir, { recursive: true, force: true }));

describe('catalog migrations', () => {
  it('loads the bundled chain, applies it with receipts and is idempotent', () => {
    const migrations = loadCatalogMigrations();
    expect(migrations.map((m) => m.version)).toEqual(['0000_initial']);
    const db = new Database(':memory:');
    db.pragma('foreign_keys = ON');
    applyCatalogMigrations(db, migrations, '2026-10-31T00:00:00.000Z');
    applyCatalogMigrations(db, migrations, '2026-10-31T00:00:01.000Z');
    expect(db.prepare('SELECT version, checksum, applied_at FROM schema_migrations').all()).toEqual([
      { version: '0000_initial', checksum: migrations[0]!.checksum, applied_at: '2026-10-31T00:00:00.000Z' }
    ]);
    expect(schemaFingerprint(migrations)).toMatch(/^[a-f0-9]{64}$/);
  });

  it('rejects checksum drift and hashes CRLF and LF identically', () => {
    const migrations = loadCatalogMigrations();
    const db = new Database(':memory:');
    applyCatalogMigrations(db, migrations, 'now');
    expect(() => applyCatalogMigrations(db, [{ ...migrations[0]!, checksum: 'bad' }], 'now')).toThrow(/drift/);
    expect(normalizeSqlText('a' + String.fromCharCode(13, 10) + 'b')).toBe('a' + String.fromCharCode(10) + 'b');
  });
});

describe('manifest validation', () => {
  const entry: ManifestEntry = {
    currentVersion: null, targetVersion: '2026.10.31.001',
    fullPackUrl: 'https://github.com/Flashyvevo/Flashydex/releases/download/catalog-v2026.10.31.001/catalog-en-2026.10.31.001.db.zst',
    setIndexUrl: 'https://github.com/Flashyvevo/Flashydex/releases/download/catalog-v2026.10.31.001/set-index-en.json',
    compressedBytes: 10, uncompressedBytes: 100, sha256: 'a'.repeat(64), compressedSha256: 'b'.repeat(64), schemaVersion: 1,
    builtAt: '2026-10-31T00:00:00.000Z', counts: { sets: 1, cards: 2, variants: 3, prices: 4, unpublishedSets: 0 }
  };
  const manifest = mergeManifest(null, 'en', entry);

  it('accepts a valid manifest with setIndexUrl', () => {
    expect(validateManifest(manifest)).toEqual([]);
  });
  it('merges languages built by separate runs and advances the root target', () => {
    const ja = {
      ...entry, targetVersion: '2026.11.02.001',
      fullPackUrl: entry.fullPackUrl.replace('en-2026.10.31.001', 'ja-2026.11.02.001'),
      setIndexUrl: entry.setIndexUrl!.replace('index-en', 'index-ja')
    };
    const merged = mergeManifest(manifest, 'ja', ja);
    expect(Object.keys(merged.languages)).toEqual(['en', 'ja']);
    expect(merged.targetVersion).toBe('2026.11.02.001');
    expect(validateManifest(merged)).toEqual([]);
  });
  it('rejects http URLs (unless dev), wrong suffix, bad hash, impossible date and unknown keys', () => {
    const bad: CatalogManifest = structuredClone(manifest);
    const en = bad.languages.en!;
    en.fullPackUrl = 'http://localhost/catalog-en-2026.10.31.001.db.zst';
    en.sha256 = 'XYZ';
    en.targetVersion = '2026.13.40.001';
    (en as unknown as Record<string, unknown>).extra = 1;
    const errors = validateManifest(bad).join('\n');
    expect(errors).toMatch(/fullPackUrl must be https/);
    expect(errors).toMatch(/sha256 invalid/);
    expect(errors).toMatch(/targetVersion invalid/);
    expect(errors).toMatch(/unknown property extra/);
    const dev = structuredClone(manifest);
    dev.languages.en!.fullPackUrl = '/dev-packs/catalog-en-2026.10.31.001.db.zst';
    expect(validateManifest(dev)).not.toEqual([]);
    expect(validateManifest(dev, { allowDevUrls: true })).toEqual([]);
  });
});

describe('zstd', () => {
  it('round-trips a file by streaming and reports a fzstd-compatible window', async () => {
    const source = join(dir, 'sample.bin');
    const text = Array.from({ length: 20000 }, (_, i) => `row ${i} ${'lorem ipsum '.repeat(i % 5)}\n`).join('');
    writeFileSync(source, text);
    await compressFile(source, `${source}.zst`, 19);
    const result = await decompressFile(`${source}.zst`, `${source}.out`);
    expect(result.bytes).toBe(text.length);
    expect(result.sha256).toBe((await sha256File(source)).sha256);
    expect(readFileSync(`${source}.out`, 'utf8')).toBe(text);
    expect(result.windowBytes).toBeLessThanOrEqual(2 ** 25);
    expect(result.windowBytes).toBeGreaterThan(0);
  });
  it('parses the window descriptor (level-19 default is 8 MiB) and rejects non-zstd data', () => {
    const header = Uint8Array.from([0x28, 0xb5, 0x2f, 0xfd, 0x04, 0x68]); // window descriptor 0x68: exponent 13 -> 2^23
    expect(zstdWindowBytes(header)).toBe(2 ** 23);
    expect(() => zstdWindowBytes(Uint8Array.from([1, 2, 3, 4, 5, 6]))).toThrow(/Not a zstd frame/);
  });
});
