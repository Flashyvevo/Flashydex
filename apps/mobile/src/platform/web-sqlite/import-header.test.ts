// @vitest-environment node
import { createHash } from 'node:crypto';
import { beforeEach, describe, expect, it } from 'vitest';
import { createWebSqliteClient, type WebSqliteClientInternal } from './client';
import { checkSqliteImportHeader, normalizeUserMigrationHeader } from './worker-core';
import { createMemoryHarness, type MemoryHarness } from './testing/memory-env';

/** S5-05: the importer inspects the header BEFORE hashing/accepting; the returned digest is the digest of the bytes written to the pool. */
const CAT = '/catalog-en/g-cccccc01.db';
const USER = '/user/m-cccccc01.db';
const sha = (bytes: Uint8Array) => createHash('sha256').update(bytes).digest('hex');
let h: MemoryHarness;
let client: WebSqliteClientInternal;

beforeEach(async () => {
  h = await createMemoryHarness();
  client = createWebSqliteClient({ workerFactory: h.workerFactory });
});

/** A synthetic 8 KiB "database": only the header is meaningful (Sol's repro shape). */
function synthetic(options: { write?: number; read?: number; pageSize?: number; magic?: string; size?: number } = {}): Uint8Array {
  const bytes = new Uint8Array(options.size ?? 8192);
  const magic = options.magic ?? 'SQLite format 3\u0000';
  for (let i = 0; i < 16; i += 1) bytes[i] = magic.charCodeAt(i);
  const pageSize = options.pageSize ?? 4096;
  const raw = pageSize === 65536 ? 1 : pageSize;
  bytes[16] = raw >> 8;
  bytes[17] = raw & 0xff;
  bytes[18] = options.write ?? 1;
  bytes[19] = options.read ?? 1;
  return bytes;
}
const stage = (bytes: Uint8Array) => h.staging.files.set('job12345/catalog.db.part', bytes);
const importCatalog = (bytes: Uint8Array, expected = sha(bytes)) => {
  stage(bytes);
  return client.importFromStaging({ source: { job: 'job12345', name: 'catalog.db.part' }, target: CAT, expectedBytes: bytes.length, expectedSha256: expected });
};

describe('catalog import (bytes are written exactly as supplied)', () => {
  it('Sol repro: an 8 KiB file whose header bytes 18/19 are 2/2 (WAL) is rejected INTEGRITY and nothing is left behind', async () => {
    const wal = synthetic({ write: 2, read: 2 });
    await expect(importCatalog(wal)).rejects.toMatchObject({ code: 'INTEGRITY' });
    expect(await client.listFiles()).not.toContain(CAT);
  });

  it.each([
    ['bytes 18/19 = 0/0', { write: 0, read: 0 }],
    ['only byte 18 is 1', { write: 1, read: 2 }],
    ['page size 1000 (not a power of two)', { pageSize: 1000 }],
    ['page size 256 (< 512)', { pageSize: 256 }],
    ['wrong magic', { magic: 'SQLite format 4\u0000' }]
  ])('rejects %s with INTEGRITY (target unlinked)', async (_name, options) => {
    await expect(importCatalog(synthetic(options))).rejects.toMatchObject({ code: 'INTEGRITY' });
    expect(await client.listFiles()).not.toContain(CAT);
  });

  it('rejects a size that is not a whole number of pages even when the pool would accept it', async () => {
    const odd = synthetic({ size: 8192 + 512, pageSize: 4096 });
    await expect(importCatalog(odd)).rejects.toMatchObject({ code: 'INTEGRITY' });
    expect(await client.listFiles()).not.toContain(CAT);
  });

  it('a valid 1/1 file imports and the returned digest IS the digest of the pool bytes (4 KiB and 64 KiB page sizes)', async () => {
    for (const [name, pageSize, size] of [['g-cccccc01', 4096, 8192], ['g-cccccc02', 65536, 131072]] as const) {
      const file = synthetic({ pageSize, size });
      stage(file);
      const target = `/catalog-en/${name}.db` as const;
      const result = await client.importFromStaging({ source: { job: 'job12345', name: 'catalog.db.part' }, target, expectedBytes: file.length, expectedSha256: sha(file) });
      expect(result.sha256).toBe(sha(file));
      expect(sha(h.pool.exportFile(target))).toBe(result.sha256);
    }
  });

  it('the pool rewriting 18/19 can no longer make the verified digest differ from the stored file', async () => {
    const file = synthetic();
    const result = await importCatalog(file);
    expect(sha(h.pool.exportFile(CAT))).toBe(result.sha256);
  });
});

describe('USER migration import (explicit, separately named normalization)', () => {
  it('2/2 legacy bytes are normalized to 1/1 BEFORE hashing: sha256 = digest of the stored bytes, sourceSha256 = digest of the original', async () => {
    const legacy = synthetic({ write: 2, read: 2 });
    const original = sha(legacy);
    await client.init();
    const result = await client.importBytes(USER, legacy.slice(), original);
    const stored = h.pool.exportFile(USER);
    expect(stored[18]).toBe(1);
    expect(stored[19]).toBe(1);
    expect(result.sha256).toBe(sha(stored));
    expect(result.sourceSha256).toBe(original);
    expect(result.sha256).not.toBe(original);
  });

  it('1/1 bytes pass through untouched (digest unchanged)', async () => {
    const legacy = synthetic();
    await client.init();
    const result = await client.importBytes(USER, legacy.slice(), sha(legacy));
    expect(result.sha256).toBe(sha(legacy));
    expect(sha(h.pool.exportFile(USER))).toBe(result.sha256);
  });

  it('still rejects non-SQLite bytes, a bad page size and a wrong original hash', async () => {
    await client.init();
    await expect(client.importBytes(USER, synthetic({ magic: 'not a database!\u0000' }), 'a'.repeat(64))).rejects.toMatchObject({ code: 'INTEGRITY' });
    await expect(client.importBytes(USER, synthetic({ pageSize: 1000 }), 'a'.repeat(64))).rejects.toMatchObject({ code: 'INTEGRITY' });
    const ok = synthetic({ write: 2, read: 2 });
    await expect(client.importBytes(USER, ok.slice(), 'b'.repeat(64))).rejects.toMatchObject({ code: 'INTEGRITY' });
    expect(await client.listFiles()).not.toContain(USER);
  });
});

describe('header helpers', () => {
  it('checkSqliteImportHeader: sentinel 1 = 65536; user policy tolerates 2/2 and flags normalization', () => {
    expect(checkSqliteImportHeader(synthetic({ pageSize: 65536 }), 'catalog')).toEqual({ pageSize: 65536, needsNormalization: false });
    expect(checkSqliteImportHeader(synthetic({ write: 2, read: 2 }), 'user-migration')).toEqual({ pageSize: 4096, needsNormalization: true });
    expect(() => checkSqliteImportHeader(synthetic({ write: 3, read: 1 }), 'user-migration')).toThrow(/unsupported file format/);
    expect(() => checkSqliteImportHeader(new Uint8Array(50), 'catalog')).toThrow(/too small/);
  });

  it('normalizeUserMigrationHeader copies, never mutates the input', () => {
    const input = synthetic({ write: 2, read: 2 });
    const out = normalizeUserMigrationHeader(input);
    expect([out[18], out[19]]).toEqual([1, 1]);
    expect([input[18], input[19]]).toEqual([2, 2]);
  });
});
