import { afterEach, describe, expect, it } from 'vitest';
import { parseArchive } from '../src/backup/archive';
import { BackupService } from '../src/backup/backup-service';
import { createMemoryPlatform } from '../src/testing/memory-platform';
import { copyOf, harness, installStandardCatalog, type Harness } from './helpers';

/** N04: BackupService delegates ZIP/JSON parsing to Platform.archiveParser (the mobile Web Worker) and passes limits + signal + bytes. */
const open: Harness[] = [];
afterEach(async () => { while (open.length) await open.pop()!.cleanup(); });

describe('N04 Platform.archiveParser seam', () => {
  it('previewRestore and the create-time verification use the platform parser; sizes survive a parser that takes ownership of the buffer', async () => {
    const h = await harness();
    open.push(h);
    await installStandardCatalog(h);
    await h.collection.add(copyOf('tset-001'));
    const platform = createMemoryPlatform(h.t.env);
    const calls: Array<{ size: number; limits: number; hasSignal: boolean }> = [];
    const read = platform.filesystem.read.bind(platform.filesystem);
    platform.filesystem.read = async (input) => new Uint8Array(await read(input)); // a fresh copy per read, like the real store
    platform.archiveParser = async ({ bytes, limits, signal }) => {
      calls.push({ size: bytes.byteLength, limits: limits.entityBytes, hasSignal: signal !== undefined });
      const out = await parseArchive(bytes, (b) => platform.hash.sha256(b), limits);
      // simulate a worker transfer: the caller's buffer is detached afterwards
      structuredClone(bytes.buffer, { transfer: [bytes.buffer] });
      return out;
    };
    const service = new BackupService(h.ctx, platform);
    const created = await service.create({}); // produce(): verification parse
    expect(calls).toHaveLength(1);
    const progress: number[] = [];
    const controller = new AbortController();
    const preview = await service.previewRestore({ file: created.file }, (p) => progress.push(p.bytesDone), controller.signal);
    expect(calls).toHaveLength(2);
    expect(calls[1]).toMatchObject({ hasSignal: true });
    expect(calls[1]!.size).toBeGreaterThan(100);
    expect(preview.totalCards).toBe(1);
    expect(progress.every((n) => n === calls[1]!.size || n === 0)).toBe(true); // reported size is the pre-transfer size, never 0 after detach
  });

  it('a platform parser that rejects BACKUP_INVALID / CANCELLED surfaces unchanged', async () => {
    const h = await harness();
    open.push(h);
    const platform = createMemoryPlatform(h.t.env);
    const { BackupError, CancelledError } = await import('../src/errors');
    const service = new BackupService(h.ctx, platform);
    const src = await harness();
    open.push(src);
    await installStandardCatalog(src);
    const sp = createMemoryPlatform(src.t.env);
    const made = await new BackupService(src.ctx, sp).create({});
    const file = platform.put('x.fdx', sp.files.get(made.file.id)!.bytes);
    platform.archiveParser = async () => { throw new BackupError('BACKUP_INVALID', 'worker says no'); };
    await expect(service.previewRestore({ file })).rejects.toMatchObject({ code: 'BACKUP_INVALID', message: 'worker says no' });
    platform.archiveParser = async () => { throw new CancelledError(); };
    await expect(service.previewRestore({ file })).rejects.toMatchObject({ code: 'CANCELLED' });
  });
});
