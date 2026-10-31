import { afterEach, describe, expect, it } from 'vitest';
import { Zip, ZipDeflate, unzipSync } from 'fflate';
import { parseArchive } from '../src/backup/archive';
import { BackupService } from '../src/backup/backup-service';
import { DomainError } from '../src/errors';
import { createMemoryPlatform } from '../src/testing/memory-platform';
import { copyOf, harness, installStandardCatalog, type Harness } from './helpers';

/** E03 (Sol review 3): contradictory / encrypted local vs central ZIP headers are rejected. */
const open: Harness[] = [];
afterEach(async () => { while (open.length) await open.pop()!.cleanup(); });

async function validArchive() {
  const h = await harness();
  open.push(h);
  await installStandardCatalog(h);
  await h.collection.add(copyOf('tset-001', { notes: 'zip header fixture' }));
  const platform = createMemoryPlatform(h.t.env);
  const created = await new BackupService(h.ctx, platform).create({});
  return { bytes: new Uint8Array(platform.files.get(created.file.id)!.bytes), hash: (b: Uint8Array) => platform.hash.sha256(b) };
}
const codeOf = async (p: Promise<unknown>): Promise<{ code: string; message: string }> => {
  try { await p; } catch (e) { if (e instanceof DomainError) return { code: e.code, message: e.message }; throw e; }
  return { code: 'NO_ERROR', message: '' };
};

/** Header positions per entry. */
function headers(bytes: Uint8Array): Array<{ local: number; central: number }> {
  const v = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  let eocd = bytes.byteLength - 22;
  while (v.getUint32(eocd, true) !== 0x06054b50) eocd -= 1;
  const total = v.getUint16(eocd + 10, true);
  let at = v.getUint32(eocd + 16, true);
  const out: Array<{ local: number; central: number }> = [];
  for (let i = 0; i < total; i += 1) {
    out.push({ central: at, local: v.getUint32(at + 42, true) });
    at += 46 + v.getUint16(at + 28, true) + v.getUint16(at + 30, true) + v.getUint16(at + 32, true);
  }
  return out;
}
function patch(bytes: Uint8Array, fn: (v: DataView, h: Array<{ local: number; central: number }>) => void): Uint8Array {
  const copy = new Uint8Array(bytes);
  fn(new DataView(copy.buffer), headers(copy));
  return copy;
}
const or16 = (v: DataView, at: number, bits: number) => v.setUint16(at, v.getUint16(at, true) | bits, true);

describe('E03 ZIP local/central header consistency', () => {
  it('the untouched archive parses', async () => {
    const f = await validArchive();
    expect((await parseArchive(f.bytes, f.hash)).entities.ownedCards).toHaveLength(1);
  });

  it("Sol's probe: encryption bit set on the first LOCAL header only -> BACKUP_INVALID", async () => {
    const f = await validArchive();
    const evil = patch(f.bytes, (v, h) => or16(v, h[0]!.local + 6, 0x1));
    expect((await codeOf(parseArchive(evil, f.hash))).code).toBe('BACKUP_INVALID');
  });

  it('encryption bit set on a CENTRAL header only -> BACKUP_INVALID (encrypted)', async () => {
    const f = await validArchive();
    const evil = patch(f.bytes, (v, h) => or16(v, h[0]!.central + 8, 0x1));
    const r = await codeOf(parseArchive(evil, f.hash));
    expect(r.code).toBe('BACKUP_INVALID');
    expect(r.message).toMatch(/Encrypted/);
  });

  it('strong-encryption (0x40) and masked-header (0x2000) bits in either header -> BACKUP_INVALID', async () => {
    const f = await validArchive();
    for (const bits of [0x40, 0x2000]) {
      expect((await codeOf(parseArchive(patch(f.bytes, (v, h) => or16(v, h[1]!.local + 6, bits)), f.hash))).code).toBe('BACKUP_INVALID');
      expect((await codeOf(parseArchive(patch(f.bytes, (v, h) => or16(v, h[1]!.central + 8, bits)), f.hash))).code).toBe('BACKUP_INVALID');
    }
  });

  it('a data-descriptor flag present locally but not centrally (would skip the CRC/size comparison) -> BACKUP_INVALID', async () => {
    const f = await validArchive();
    const evil = patch(f.bytes, (v, h) => or16(v, h[0]!.local + 6, 0x8));
    expect((await codeOf(parseArchive(evil, f.hash))).code).toBe('BACKUP_INVALID');
  });

  it('any other local/central flag disagreement (UTF-8 bit) -> BACKUP_INVALID', async () => {
    const f = await validArchive();
    expect((await codeOf(parseArchive(patch(f.bytes, (v, h) => or16(v, h[2]!.local + 6, 0x800)), f.hash))).code).toBe('BACKUP_INVALID');
    expect((await codeOf(parseArchive(patch(f.bytes, (v, h) => or16(v, h[2]!.central + 8, 0x800)), f.hash))).code).toBe('BACKUP_INVALID');
  });

  it('local uncompressed size differs from the central directory -> BACKUP_INVALID', async () => {
    const f = await validArchive();
    const evil = patch(f.bytes, (v, h) => v.setUint32(h[0]!.local + 22, v.getUint32(h[0]!.local + 22, true) + 1, true));
    expect((await codeOf(parseArchive(evil, f.hash))).code).toBe('BACKUP_INVALID');
  });

  it('local compression method differs from the central directory -> BACKUP_INVALID', async () => {
    const f = await validArchive();
    const evil = patch(f.bytes, (v, h) => v.setUint16(h[0]!.local + 8, v.getUint16(h[0]!.local + 8, true) === 8 ? 0 : 8, true));
    expect((await codeOf(parseArchive(evil, f.hash))).code).toBe('BACKUP_INVALID');
  });
});

/** F02 (Sol review 4): data-descriptor contents and coherent-but-wrong expanded-size declarations. */
function streamed(bytes: Uint8Array): Uint8Array {
  const parts: Uint8Array[] = [];
  let failure: Error | null = null;
  const zip = new Zip((err, chunk) => { if (err) failure = err; else parts.push(chunk); });
  for (const [name, data] of Object.entries(unzipSync(bytes))) {
    const file = new ZipDeflate(name, { level: 6 });
    zip.add(file);
    file.push(data, true);
  }
  zip.end();
  if (failure) throw failure;
  const out = new Uint8Array(parts.reduce((n, p) => n + p.byteLength, 0));
  let at = 0;
  for (const p of parts) { out.set(p, at); at += p.byteLength; }
  return out;
}
/** Descriptor position of entry i (signature-bearing, as fflate writes it). */
const descriptorAt = (v: DataView, h: Array<{ local: number; central: number }>, i: number): number =>
  h[i]!.local + 30 + v.getUint16(h[i]!.local + 26, true) + v.getUint16(h[i]!.local + 28, true) + v.getUint32(h[i]!.central + 20, true);
const bump = (v: DataView, at: number, by = 1) => v.setUint32(at, (v.getUint32(at, true) + by) >>> 0, true);

describe('F02 data descriptors and declared expanded sizes', () => {
  it('a genuinely streamed (descriptor-bearing) archive with intact descriptors parses', async () => {
    const f = await validArchive();
    const s = streamed(f.bytes);
    const v = new DataView(s.buffer);
    expect(v.getUint16(headers(s)[0]!.local + 6, true) & 8).toBe(8);
    expect((await parseArchive(s, f.hash)).entities.ownedCards).toHaveLength(1);
  });

  it("Sol's probe: streamed archive with a corrupted descriptor CRC -> BACKUP_INVALID", async () => {
    const f = await validArchive();
    const evil = patch(streamed(f.bytes), (v, h) => v.setUint32(descriptorAt(v, h, 0) + 4, 0x12345678, true));
    expect((await codeOf(parseArchive(evil, f.hash))).code).toBe('BACKUP_INVALID');
  });

  it('streamed archive with wrong descriptor compressed size / uncompressed size -> BACKUP_INVALID', async () => {
    const f = await validArchive();
    const s = streamed(f.bytes);
    expect((await codeOf(parseArchive(patch(s, (v, h) => bump(v, descriptorAt(v, h, 1) + 8)), f.hash))).code).toBe('BACKUP_INVALID');
    expect((await codeOf(parseArchive(patch(s, (v, h) => bump(v, descriptorAt(v, h, 1) + 12)), f.hash))).code).toBe('BACKUP_INVALID');
  });

  it('streamed archive whose CENTRAL sizes contradict the descriptor (or point past the file) -> BACKUP_INVALID', async () => {
    const f = await validArchive();
    const s = streamed(f.bytes);
    expect((await codeOf(parseArchive(patch(s, (v, h) => bump(v, h[0]!.central + 24)), f.hash))).code).toBe('BACKUP_INVALID');
    expect((await codeOf(parseArchive(patch(s, (v, h) => bump(v, h[2]!.central + 20)), f.hash))).code).toBe('BACKUP_INVALID');
    expect((await codeOf(parseArchive(patch(s, (v, h) => v.setUint32(h[2]!.central + 20, 0x7fffffff, true)), f.hash))).code).toBe('BACKUP_INVALID');
  });

  it('streamed archive with the descriptor overwritten by zeros (truncated/missing descriptor) -> BACKUP_INVALID', async () => {
    const f = await validArchive();
    const evil = patch(streamed(f.bytes), (v, h) => { const d = descriptorAt(v, h, 0); for (let i = 0; i < 16; i += 4) v.setUint32(d + i, 0, true); });
    expect((await codeOf(parseArchive(evil, f.hash))).code).toBe('BACKUP_INVALID');
  });

  it("Sol's probe: coherently-wrong expanded size (local AND central say size+1, actual inflated size is smaller) -> BACKUP_INVALID", async () => {
    const f = await validArchive();
    const evil = patch(f.bytes, (v, h) => { bump(v, h[0]!.local + 22); bump(v, h[0]!.central + 24); });
    const r = await codeOf(parseArchive(evil, f.hash));
    expect(r.code).toBe('BACKUP_INVALID');
    expect(r.message).toMatch(/declared size/);
  });

  it('coherently-wrong expanded size that UNDERSTATES the real size -> BACKUP_INVALID', async () => {
    const f = await validArchive();
    const evil = patch(f.bytes, (v, h) => { bump(v, h[1]!.local + 22, -1); bump(v, h[1]!.central + 24, -1); });
    expect((await codeOf(parseArchive(evil, f.hash))).code).toBe('BACKUP_INVALID');
  });
});
