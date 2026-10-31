import { copyFileSync } from 'node:fs';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { TransferService } from '../src/transfer/service';
import { createMemoryPlatform } from '../src/testing/memory-platform';
import { createTestDatabases } from '../src/testing/node-driver';
import { copyOf, harness, harnessFor, installStandardCatalog, ownedCount, type Harness } from './helpers';

/** E01 (Sol review 3): a concurrent replay must never return success from a receipt whose flush is failing. */
const open: Harness[] = [];
afterEach(async () => { while (open.length) await open.pop()!.cleanup(); });

async function scenario(persisted: 'PRE' | 'POST') {
  let fail = false;
  let entered!: () => void;
  let release!: () => void;
  const entry = new Promise<void>((r) => { entered = r; });
  const hold = new Promise<void>((r) => { release = r; });
  let restoreFrom: string | null = null;
  let dir = '';
  const t = await createTestDatabases({
    userFaults: {
      afterCommit: async () => { if (fail) { fail = false; entered(); await hold; throw new Error('quota'); } },
      beforeReopen: () => { if (restoreFrom) copyFileSync(restoreFrom, join(dir, 'flashydex-user.db')); }
    }
  });
  dir = t.dir;
  const target = harnessFor(t);
  open.push(target);
  await installStandardCatalog(target);
  const src = await harness();
  open.push(src);
  await installStandardCatalog(src);
  await src.collection.add(copyOf('tset-001'));
  const sp = createMemoryPlatform(src.t.env);
  const tp = createMemoryPlatform(t.env);
  const ex = await new TransferService(src.ctx, sp).exportFile({ format: 'json' });
  const transfer = new TransferService(target.ctx, tp);
  const file = tp.put('in.json', sp.files.get(ex.file.id)!.bytes, 'application/json');
  const preview = await transfer.dryRun({ format: 'json', conflictPolicy: 'skip', file });
  if (persisted === 'PRE') { restoreFrom = join(dir, 'pre.db'); copyFileSync(join(dir, 'flashydex-user.db'), restoreFrom); }
  fail = true;
  const input = { id: preview.id, planHash: preview.planHash, confirm: true as const };
  const settle = <T>(p: Promise<T>) => p.then((value) => ({ ok: true as const, value }), (e: { code?: string }) => ({ ok: false as const, code: e.code }));
  const first = settle(transfer.commit(input));
  await entry; // A committed its SQL and is inside the failing flush
  const replay = settle(transfer.commit(input)); // B arrives while the latch is still clear
  await new Promise((r) => setTimeout(r, 20));
  release();
  return { first: await first, replay: await replay, target, t, transfer, input };
}

describe('E01 concurrent import replay during a failing flush', () => {
  it('PRE-persisted: the replay is refused (no success), recover() shows nothing persisted, retry applies exactly once', async () => {
    const s = await scenario('PRE');
    expect(s.first).toMatchObject({ ok: false, code: 'PERSISTENCE_FAILED' });
    expect(s.replay).toMatchObject({ ok: false, code: 'PERSISTENCE_FAILED' });
    expect(s.t.user.status()).toMatchObject({ writable: false, reason: 'persistence_failed' });
    await s.t.user.recover();
    expect(await ownedCount(s.target)).toBe(0);
    expect(await s.transfer.commit(s.input)).toMatchObject({ createdCopies: 1 });
    expect(await ownedCount(s.target)).toBe(1);
  });

  it('POST-persisted: the replay is refused during the flush; after recover() it returns the stored receipt without re-applying', async () => {
    const s = await scenario('POST');
    expect(s.first).toMatchObject({ ok: false, code: 'PERSISTENCE_FAILED' });
    expect(s.replay).toMatchObject({ ok: false, code: 'PERSISTENCE_FAILED' });
    await s.t.user.recover();
    expect(await s.transfer.commit(s.input)).toMatchObject({ createdCopies: 1 });
    expect(await ownedCount(s.target)).toBe(1);
  });
});
