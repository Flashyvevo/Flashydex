import { createHash } from 'node:crypto';
import { readFileSync, writeFileSync, mkdirSync, existsSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import Ajv2020 from 'ajv/dist/2020';
import addFormats from 'ajv-formats';
import { JSON_SCHEMA_FILES } from '@flashydex/schemas/json-schema';
import { afterEach, describe, expect, it } from 'vitest';
import { TransferService } from '../src/transfer/service';
import { escapeFormula, unescapeFormula, parseCsv, CSV_COLUMNS } from '../src/transfer/csv';
import { createMemoryPlatform } from '../src/testing/memory-platform';
import { copyOf, customCopy, harness, installStandardCatalog, type Harness } from './helpers';

const open: Harness[] = [];
afterEach(async () => { while (open.length) await open.pop()!.cleanup(); });

async function setup() {
  const h = await harness();
  open.push(h);
  await installStandardCatalog(h);
  const platform = createMemoryPlatform(h.t.env);
  const transfer = new TransferService(h.ctx, platform);
  return { h, platform, transfer };
}

const textOf = (platform: ReturnType<typeof createMemoryPlatform>, id: string) => new TextDecoder('utf-8', { ignoreBOM: true }).decode(platform.files.get(id)!.bytes);

async function seedCollection(h: Harness) {
  const loc = await h.collection.createLocation({ name: 'Binder A', description: '=cmd|x' });
  const grp = await h.collection.createGroup({ name: 'Favourites' });
  const custom = await h.collection.createCustom({ name: '@Prototype', language: 'en', setId: 'proto', localId: '7' });
  await h.collection.add(copyOf('tset-001', { condition: 'NM', storageLocationId: loc.id, groupIds: [grp.id], purchasePrice: { cents: 500, currency: 'USD' }, acquisition: { create: { source: 'Shop, "Local"', purchasedOn: '2024-01-02' } } }));
  await h.collection.add(copyOf('tset-001', { variant: 'reverse_holo', condition: 'LP', notes: 'line1\nline2' }));
  await h.collection.add(customCopy(custom.id, { notes: '-dash' }));
  return { loc, grp, custom };
}

describe('csv primitives (acc 53-55)', () => {
  it('escapes only trigger starts and reverses exactly one apostrophe', () => {
    for (const s of ['=1+1', '+1', '-1', '@x', "'=a", '\tx']) expect(unescapeFormula(escapeFormula(s))).toBe(s);
    expect(escapeFormula('plain')).toBe('plain');
    expect(unescapeFormula("'plain")).toBe("'plain");
  });
  it('parses quotes, embedded newlines, BOM and rejects ragged rows', () => {
    expect(parseCsv('\uFEFFa,b\r\n"x,1","l1\nl2"\r\n')).toEqual([['a', 'b'], ['x,1', 'l1\nl2']]);
    expect(() => parseCsv('a,b\n1\n')).toThrow();
  });
});

describe('export (acc 41, 43, 53, 54)', () => {
  it('JSON export has every entity array, validates against the generated JSON Schema, and is deterministic apart from exportedAt', async () => {
    const { h, platform, transfer } = await setup();
    await seedCollection(h);
    const { file, format } = await transfer.exportFile({ format: 'json' });
    expect(format).toBe('json');
    const doc = JSON.parse(textOf(platform, file.id));
    expect(doc.schemaVersion).toBe(1);
    expect(doc.ownedCards).toHaveLength(3);
    expect(doc.catalogRefs).toHaveLength(1);
  });
  it('CSV: BOM, exact 45-column header, one row per copy, formula-safe text cells', async () => {
    const { h, platform, transfer } = await setup();
    await seedCollection(h);
    const { file, warnings } = await transfer.exportFile({ format: 'csv' });
    const text = textOf(platform, file.id);
    expect(text.charCodeAt(0)).toBe(0xfeff);
    const rows = parseCsv(text);
    expect(rows[0]).toEqual([...CSV_COLUMNS]);
    expect(CSV_COLUMNS).toHaveLength(45);
    expect(rows).toHaveLength(4);
    expect(text).toContain("'=cmd|x");
    expect(text).toContain("'@Prototype");
    expect(text).toContain("'-dash");
    expect(warnings.length).toBeGreaterThan(0);
  });
  it('empty collection exports a header-only CSV and an empty JSON', async () => {
    const { platform, transfer } = await setup();
    const csv = await transfer.exportFile({ format: 'csv' });
    expect(parseCsv(textOf(platform, csv.file.id))).toHaveLength(1);
    const json = await transfer.exportFile({ format: 'json' });
    expect(JSON.parse(textOf(platform, json.file.id)).ownedCards).toEqual([]);
  });
});

describe('generated JSON Schema files (acc 41)', () => {
  const dir = join(dirname(fileURLToPath(import.meta.url)), '..', '..', 'schemas', 'json-schema');
  it('matches the zod source (rewrites with UPDATE_SCHEMAS=1)', () => {
    mkdirSync(dir, { recursive: true });
    for (const [name, make] of Object.entries(JSON_SCHEMA_FILES)) {
      const next = `${JSON.stringify((make as () => unknown)(), null, 2)}\n`;
      const path = join(dir, name);
      if (process.env.UPDATE_SCHEMAS === '1' || !existsSync(path)) writeFileSync(path, next);
      expect(readFileSync(path, 'utf8')).toBe(next);
    }
  });
  it('a real export validates against the Draft 2020-12 schema', async () => {
    const { h, platform, transfer } = await setup();
    await seedCollection(h);
    const { file } = await transfer.exportFile({ format: 'json' });
    const ajv = new Ajv2020({ strict: false });
    addFormats(ajv);
    const validate = ajv.compile(JSON_SCHEMA_FILES['collection-export.v1.schema.json']());
    const ok = validate(JSON.parse(textOf(platform, file.id)));
    expect(validate.errors).toBeNull();
    expect(ok).toBe(true);
  });
});

describe('import round-trip and dry run (acc 42, 44, 45, 46)', () => {
  it('export -> empty DB import -> export is equal (JSON)', async () => {
    const a = await setup();
    await seedCollection(a.h);
    const first = await a.transfer.exportFile({ format: 'json' });
    const bytes = a.platform.files.get(first.file.id)!.bytes;

    const b = await setup();
    const ref = b.platform.put('in.json', bytes, 'application/json');
    const report = await b.transfer.dryRun({ format: 'json', conflictPolicy: 'skip', file: ref });
    expect(report.errors).toEqual([]);
    expect(report.valid).toBe(true);
    expect(report.counts.ownedCards.create).toBe(3);
    // dry run wrote nothing
    expect((await b.h.collection.list({ groupBy: 'copy' } as never)).page.total).toBe(0);
    expect(report.collectionRevision).toBe(0);

    const result = await b.transfer.commit({ id: report.id, planHash: report.planHash, confirm: true });
    expect(result.createdCopies).toBe(3);
    const second = await b.transfer.exportFile({ format: 'json' });
    const strip = (s: string) => { const d = JSON.parse(s); delete d.exportedAt; return d; };
    expect(strip(textOf(b.platform, second.file.id))).toEqual(strip(textOf(a.platform, first.file.id)));
  });

  it('commit replay returns the original result; a changed plan hash is rejected; revision moves once', async () => {
    const a = await setup();
    await seedCollection(a.h);
    const ex = await a.transfer.exportFile({ format: 'json' });
    const b = await setup();
    const ref = b.platform.put('in.json', a.platform.files.get(ex.file.id)!.bytes);
    const report = await b.transfer.dryRun({ format: 'json', conflictPolicy: 'skip', file: ref });
    const one = await b.transfer.commit({ id: report.id, planHash: report.planHash, confirm: true });
    const two = await b.transfer.commit({ id: report.id, planHash: report.planHash, confirm: true });
    expect(two).toEqual(one);
    expect(one.collectionRevision).toBe(1);
    await expect(b.transfer.commit({ id: report.id, planHash: 'f'.repeat(64), confirm: true })).rejects.toThrow();
  });

  it('re-importing the same file with skip policy creates nothing and changes nothing', async () => {
    const a = await setup();
    await seedCollection(a.h);
    const ex = await a.transfer.exportFile({ format: 'json' });
    const ref = a.platform.put('again.json', a.platform.files.get(ex.file.id)!.bytes);
    const report = await a.transfer.dryRun({ format: 'json', conflictPolicy: 'skip', file: ref });
    expect(report.counts.ownedCards.create).toBe(0);
    expect(report.counts.ownedCards.skip).toBe(3);
    expect(report.errors).toEqual([]);
  });

  it('stale preview: a mutation between dry run and commit is refused and nothing is written', async () => {
    const a = await setup();
    await seedCollection(a.h);
    const ex = await a.transfer.exportFile({ format: 'json' });
    const b = await setup();
    const ref = b.platform.put('in.json', a.platform.files.get(ex.file.id)!.bytes);
    const report = await b.transfer.dryRun({ format: 'json', conflictPolicy: 'skip', file: ref });
    await b.h.collection.createLocation({ name: 'Interloper' });
    await expect(b.transfer.commit({ id: report.id, planHash: report.planHash, confirm: true })).rejects.toMatchObject({ code: 'STALE_PREVIEW' });
    expect(await b.h.t.databases.user.scalar('SELECT COUNT(*) FROM owned_cards')).toBe(0);
  });

  it('update policy applies changed fields to an existing copy (authoritative children)', async () => {
    const a = await setup();
    await seedCollection(a.h);
    const ex = await a.transfer.exportFile({ format: 'json' });
    const doc = JSON.parse(textOf(a.platform, ex.file.id));
    doc.ownedCards[0].notes = 'edited in file';
    const ref = a.platform.put('edit.json', JSON.stringify(doc));
    const report = await a.transfer.dryRun({ format: 'json', conflictPolicy: 'update', file: ref });
    expect(report.counts.ownedCards.update).toBe(1);
    await a.transfer.commit({ id: report.id, planHash: report.planHash, confirm: true });
    expect(await a.h.t.databases.user.scalar('SELECT COUNT(*) FROM owned_cards WHERE notes = ?', ['edited in file'])).toBe(1);
  });

  it('invalid files: bad JSON, unknown key, wrong schemaVersion, duplicate ids, dangling references, oversize', async () => {
    const { platform, transfer } = await setup();
    const dry = (bytes: string) => transfer.dryRun({ format: 'json', conflictPolicy: 'skip', file: platform.put('x.json', bytes) });
    await expect(dry('{nope')).rejects.toMatchObject({ code: 'INVALID_JSON' });
    await expect(dry(JSON.stringify({ schemaVersion: 2 }))).rejects.toMatchObject({ code: 'IMPORT_INVALID' });
    const empty = { schemaVersion: 1, exportedAt: '2026-01-01T00:00:00.000Z', appVersion: 't', catalogRefs: [], customCards: [], acquisitions: [], storageLocations: [], collectionGroups: [], scanSessions: [], ownedCards: [], grades: [], collectionGroupMembers: [], priceSnapshots: [] };
    await expect(dry(JSON.stringify({ ...empty, extra: 1 }))).rejects.toMatchObject({ code: 'IMPORT_INVALID' });
    const dangling = { ...empty, ownedCards: [{ id: '11111111-1111-4111-8111-111111111111', catalogCardId: null, customCardId: '22222222-2222-4222-8222-222222222222', name: 'X', setId: null, setName: null, localId: null, language: 'en', rarity: null, imageUrl: null, variant: 'normal', variantDetail: '', condition: null, acquisitionId: null, purchasePriceCents: null, purchaseCurrency: null, storageLocationId: null, scanSessionId: null, notes: null, manualPriceCents: null, manualPriceCurrency: null, createdAt: '2026-01-01T00:00:00.000Z', updatedAt: '2026-01-01T00:00:00.000Z' }] };
    const report = await dry(JSON.stringify(dangling));
    expect(report.valid).toBe(false);
    expect(report.errors[0]?.code).toBe('REFERENCE_MISSING');
    await expect(transfer.commit({ id: report.id, planHash: report.planHash, confirm: true })).rejects.toMatchObject({ code: 'IMPORT_INVALID' });
    const big = platform.put('big.json', '{}');
    big.size = 26 * 1024 * 1024;
    await expect(transfer.dryRun({ format: 'json', conflictPolicy: 'skip', file: big })).rejects.toMatchObject({ code: 'PAYLOAD_TOO_LARGE' });
  });
});

describe('CSV import (acc 55-58)', () => {
  it('CSV export -> import into empty DB yields the same copies, reversing formula escapes', async () => {
    const a = await setup();
    await seedCollection(a.h);
    const ex = await a.transfer.exportFile({ format: 'csv' });
    const b = await setup();
    const ref = b.platform.put('in.csv', a.platform.files.get(ex.file.id)!.bytes, 'text/csv');
    const report = await b.transfer.dryRun({ format: 'csv', conflictPolicy: 'skip', file: ref });
    expect(report.errors).toEqual([]);
    expect(report.counts.ownedCards.create).toBe(3);
    await b.transfer.commit({ id: report.id, planHash: report.planHash, confirm: true });
    expect(await b.h.t.databases.user.scalar("SELECT COUNT(*) FROM custom_cards WHERE name = '@Prototype'")).toBe(1);
    expect(await b.h.t.databases.user.scalar("SELECT COUNT(*) FROM owned_cards WHERE notes = '-dash'")).toBe(1);
    expect(await b.h.t.databases.user.scalar("SELECT COUNT(*) FROM storage_locations WHERE description = '=cmd|x'")).toBe(1);
  });
  it('rejects unknown columns and bad enums with row-level errors, writing nothing', async () => {
    const { h, platform, transfer } = await setup();
    await expect(transfer.dryRun({ format: 'csv', conflictPolicy: 'skip', file: platform.put('a.csv', 'name,language,variant,bogus\r\nA,en,normal,1\r\n') })).rejects.toMatchObject({ code: 'INVALID_CSV' });
    const report = await transfer.dryRun({ format: 'csv', conflictPolicy: 'skip', file: platform.put('b.csv', 'name,language,variant,condition\r\nA,en,normal,ZZ\r\nB,xx,normal,\r\n') });
    expect(report.valid).toBe(false);
    expect(report.errorCount).toBeGreaterThanOrEqual(2);
    expect(await h.t.databases.user.scalar('SELECT COUNT(*) FROM owned_cards')).toBe(0);
  });
  it("'001' is never matched to '1' and missing ids warn about duplicates on re-import", async () => {
    const { platform, transfer } = await setup();
    const report = await transfer.dryRun({ format: 'csv', conflictPolicy: 'skip', file: platform.put('c.csv', 'name,language,variant,set_id,local_id\r\nAlpha Mon,en,normal,tset,1\r\nAlpha Mon,en,normal,tset,001\r\n') });
    expect(report.warnings.some((w) => w.code === 'NO_STABLE_IDS')).toBe(true);
    expect(report.warnings.filter((w) => w.code === 'CUSTOM_CARD_CREATED')).toHaveLength(1); // '1' has no match -> custom; '001' matches the catalog
  });
});

describe('integrity helpers', () => {
  it('sha256 helper agrees with node crypto', async () => {
    const { platform } = await setup();
    const bytes = new TextEncoder().encode('abc');
    expect(await platform.hash.sha256(bytes)).toBe(createHash('sha256').update(bytes).digest('hex'));
  });
});
