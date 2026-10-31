import { afterEach, describe, expect, it } from 'vitest';
import { TransferService } from '../src/transfer/service';
import { createMemoryPlatform } from '../src/testing/memory-platform';
import { copyOf, harness, installStandardCatalog, ownedCount, type Harness } from './helpers';

const open: Harness[] = [];
afterEach(async () => { while (open.length) await open.pop()!.cleanup(); });

async function exportedDoc() {
  const h = await harness();
  open.push(h);
  await installStandardCatalog(h);
  const platform = createMemoryPlatform(h.t.env);
  const transfer = new TransferService(h.ctx, platform);
  await h.collection.add(copyOf('tset-001', { condition: 'NM' }));
  const out = await transfer.exportFile({ format: 'json' });
  const doc = JSON.parse(new TextDecoder().decode(platform.files.get(out.file.id)!.bytes)) as { ownedCards: Array<Record<string, unknown>> };
  return { h, platform, transfer, doc };
}

describe('import dry-run reports invalid rows instead of throwing (C2)', () => {
  it.each([
    ['imageUrl is the string "undefined"', { imageUrl: 'undefined' }],
    ['imageUrl is not http(s)', { imageUrl: 'javascript:alert(1)' }],
    ['name is empty', { name: '' }]
  ])('one invalid row (%s) -> valid:false report with a row error; zero DB writes', async (_label, patch) => {
    const { h, platform, transfer, doc } = await exportedDoc();
    doc.ownedCards[0] = { ...doc.ownedCards[0], ...patch };
    const file = platform.put('bad.json', JSON.stringify(doc), 'application/json');
    const before = await ownedCount(h);
    const report = await transfer.dryRun({ format: 'json', conflictPolicy: 'skip', file });
    expect(report.valid).toBe(false);
    expect(report.errorCount).toBeGreaterThan(0);
    expect(report.errors[0]).toMatchObject({ entity: 'ownedCards', row: 1 });
    expect(report.counts.ownedCards.error).toBe(1);
    expect(await ownedCount(h)).toBe(before);
  });

  it('a well-formed export dry-runs valid and commits with conflictPolicy skip as all-skipped', async () => {
    const { h, platform, transfer } = await exportedDoc();
    const out = await transfer.exportFile({ format: 'json' });
    const report = await transfer.dryRun({ format: 'json', conflictPolicy: 'skip', file: out.file });
    expect(report.valid).toBe(true);
    expect(report.counts.ownedCards).toMatchObject({ read: 1, create: 0, skip: 1 });
    const result = await transfer.commit({ id: report.id, planHash: report.planHash, confirm: true });
    expect(result.createdCopies).toBe(0);
    expect(result.skippedCopies).toBe(1);
    expect(await ownedCount(h)).toBe(1);
    expect(platform.files.size).toBeGreaterThan(0);
  });

  it('a file that is not an export throws a typed ImportError (mapped by the UI), not a generic failure', async () => {
    const { platform, transfer } = await exportedDoc();
    const file = platform.put('x.json', '{"nope":1}', 'application/json');
    await expect(transfer.dryRun({ format: 'json', conflictPolicy: 'skip', file })).rejects.toMatchObject({ code: 'IMPORT_INVALID' });
  });
});
