import { UnzipInflate, unzipSync, zipSync } from 'fflate';
import { afterEach, describe, expect, it } from 'vitest';
import { crc32, parseArchive } from '../src/backup/archive';
import { DomainError } from '../src/errors';
import { createMemoryPlatform, type MemoryPlatform } from '../src/testing/memory-platform';
import { copyOf, harness, installStandardCatalog, type Harness } from './helpers';

/** Stage E: N04 (bounded inflate allocation) and N08 (ZIP CRC32 + local/central consistency) for parseArchive. */
const open: Harness[] = [];
afterEach(async () => { while (open.length) await open.pop()!.cleanup(); });

async function validArchive() {
  const h = await harness();
  open.push(h);
  await installStandardCatalog(h);
  await h.collection.add(copyOf('tset-001', { notes: 'crc fixture' }));
  const platform: MemoryPlatform = createMemoryPlatform(h.t.env);
  const { BackupService } = await import('../src/backup/backup-service');
  const created = await new BackupService(h.ctx, platform).create({});
  const bytes = new Uint8Array(platform.files.get(created.file.id)!.bytes);
  return { platform, bytes, hash: (b: Uint8Array) => platform.hash.sha256(b) };
}
const codeOf = async (p: Promise<unknown>): Promise<string> => {
  try { await p; } catch (e) { if (e instanceof DomainError) return e.code; throw e; }
  return 'NO_ERROR';
};

/** Central-directory walk: where the CRC fields live (local header offset + 14, central entry offset + 16). */
function crcFields(bytes: Uint8Array): { local: number[]; central: number[] } {
  const v = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  let eocd = bytes.byteLength - 22;
  while (v.getUint32(eocd, true) !== 0x06054b50) eocd -= 1;
  const total = v.getUint16(eocd + 10, true);
  let at = v.getUint32(eocd + 16, true);
  const local: number[] = [];
  const central: number[] = [];
  for (let i = 0; i < total; i += 1) {
    central.push(at + 16);
    local.push(v.getUint32(at + 42, true) + 14);
    at += 46 + v.getUint16(at + 28, true) + v.getUint16(at + 30, true) + v.getUint16(at + 32, true);
  }
  return { local, central };
}
const setCrc = (bytes: Uint8Array, offsets: number[], value: number): Uint8Array => {
  const copy = new Uint8Array(bytes);
  const v = new DataView(copy.buffer);
  for (const o of offsets) v.setUint32(o, value, true);
  return copy;
};

describe('N08 per-entry CRC32 is verified', () => {
  it('crc32 matches the standard check value', () => {
    expect(crc32(new TextEncoder().encode('123456789'))).toBe(0xcbf43926);
  });

  it("Sol's probe: all six local+central CRC fields set to 0x12345678 (payloads untouched) -> BACKUP_INVALID (was: accepted)", async () => {
    const f = await validArchive();
    const fields = crcFields(f.bytes);
    expect(fields.local.length + fields.central.length).toBe(6);
    const evil = setCrc(f.bytes, [...fields.local, ...fields.central], 0x12345678);
    expect(await codeOf(parseArchive(evil, f.hash))).toBe('BACKUP_INVALID');
    expect((await parseArchive(f.bytes, f.hash)).entities.ownedCards).toHaveLength(1); // the untouched archive still parses
  });

  it('local header CRC != central directory CRC (only the local copy changed) -> BACKUP_INVALID', async () => {
    const f = await validArchive();
    expect(await codeOf(parseArchive(setCrc(f.bytes, crcFields(f.bytes).local, 0xdeadbeef), f.hash))).toBe('BACKUP_INVALID');
  });

  it('central CRC != local CRC != data (only the central copy changed) -> BACKUP_INVALID', async () => {
    const f = await validArchive();
    expect(await codeOf(parseArchive(setCrc(f.bytes, crcFields(f.bytes).central, 0xdeadbeef), f.hash))).toBe('BACKUP_INVALID');
  });

});

describe('N04 inflate allocation is bounded by the compressed slice size, not by the hostile stream', () => {
  async function bombWith(zeros: number) {
    const f = await validArchive();
    const valid = unzipSync(f.bytes);
    const bomb = zipSync({ ...valid, 'entities.json': [new Uint8Array(zeros), { level: 9 }] });
    return { f, bomb };
  }
  async function measure<T>(run: () => Promise<T>): Promise<{ maxChunk: number; pushes: number; error: string }> {
    let maxChunk = 0;
    let pushes = 0;
    const original = UnzipInflate.prototype.push;
    UnzipInflate.prototype.push = function (this: UnzipInflate, ...args: Parameters<typeof original>) {
      pushes += 1;
      const ondata = this.ondata;
      this.ondata = (err, data, final) => { maxChunk = Math.max(maxChunk, data?.length ?? 0); ondata(err, data, final); };
      return original.apply(this, args);
    };
    let error = 'NO_ERROR';
    try { await run(); } catch (e) { error = e instanceof DomainError ? e.code : String(e); } finally { UnzipInflate.prototype.push = original; }
    return { maxChunk, pushes, error };
  }

  it("Sol's probe: 64 MiB of zeros in a ~66 KB archive with a 1 MiB cap -> SIZE_LIMIT and the largest inflate callback chunk stays below 1.25 MiB (was 67,108,864)", async () => {
    const { f, bomb } = await bombWith(64 * 1024 * 1024);
    expect(bomb.byteLength).toBeLessThan(80 * 1024);
    const r = await measure(() => parseArchive(bomb, f.hash, { entityBytes: 1024 * 1024 }));
    expect(r.error).toBe('SIZE_LIMIT');
    expect(r.maxChunk).toBeLessThan(1.25 * 1024 * 1024);
    expect(r.pushes).toBeGreaterThan(0);
  });

  it('with the default 128 MiB cap a hostile 64 MiB stream is inflated in bounded pieces too (largest chunk < 1.25 MiB), then rejected as content', async () => {
    const { f, bomb } = await bombWith(64 * 1024 * 1024);
    const r = await measure(() => parseArchive(bomb, f.hash));
    expect(r.error).toBe('BACKUP_HASH_MISMATCH');
    expect(r.maxChunk).toBeLessThan(1.25 * 1024 * 1024);
  });

  it('the slice shrinks with the remaining budget: a 64 KiB cap never produces a chunk beyond cap + one 1032:1 worst case of the smallest slice', async () => {
    const { f, bomb } = await bombWith(8 * 1024 * 1024);
    const cap = 64 * 1024;
    const r = await measure(() => parseArchive(bomb, f.hash, { entityBytes: cap }));
    expect(r.error).toBe('SIZE_LIMIT');
    expect(r.maxChunk).toBeLessThan(cap + 2 * 1024);
  });

  it('a legitimate archive still parses (chunked feeding is transparent) and aggregate expandedBytes still bounds the whole archive', async () => {
    const f = await validArchive();
    expect((await parseArchive(f.bytes, f.hash)).entities.ownedCards).toHaveLength(1);
    expect(await codeOf(parseArchive(f.bytes, f.hash, { expandedBytes: 100 }))).toBe('SIZE_LIMIT');
    // a bigger legitimate document survives slicing byte-for-byte
    const h = await harness();
    open.push(h);
    await installStandardCatalog(h);
    for (let i = 0; i < 60; i += 1) await h.collection.add(copyOf('tset-001', { notes: `note ${i} ${'x'.repeat(200)}` }));
    const platform = createMemoryPlatform(h.t.env);
    const { BackupService } = await import('../src/backup/backup-service');
    const created = await new BackupService(h.ctx, platform).create({});
    const big = platform.files.get(created.file.id)!.bytes;
    expect((await parseArchive(new Uint8Array(big), (b) => platform.hash.sha256(b))).entities.ownedCards).toHaveLength(60);
  });
});
