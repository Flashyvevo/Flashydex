import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { InUseError, NotFoundError, ValidationError } from '../src/errors';
import { copyOf, customCopy, dumpPersonal, harness, installStandardCatalog, MISSING_UUID, ownedCount, revision, type Harness } from './helpers';

let h: Harness;
beforeEach(async () => {
  h = await harness();
  await installStandardCatalog(h, 'en');
});
afterEach(() => h.cleanup());

const rejects = async (promise: Promise<unknown>, ctor: new (...a: never[]) => Error, code?: string) => {
  const error = await promise.then(() => null, (e: unknown) => e);
  expect(error).toBeInstanceOf(ctor);
  if (code) expect((error as { code: string }).code).toBe(code);
};

describe('add (54, 62, 24)', () => {
  it('snapshots catalog fields and inserts the identity ledger row in the same transaction; revision +1', async () => {
    const before = await revision(h);
    const copy = await h.collection.add(copyOf('tset-001', { condition: 'NM', purchasePrice: { cents: 1250, currency: 'USD' }, notes: 'binder' }));
    expect(copy).toMatchObject({
      catalogCardId: 'tset-001', customCardId: null, name: 'Alpha Mon', setId: 'tset', setName: 'Test Set Alpha', localId: '001', language: 'en', rarity: 'Rare',
      imageUrl: 'https://assets.example.test/tset/001', variant: 'normal', variantDetail: '', condition: 'NM', purchasePrice: { cents: 1250, currency: 'USD' },
      notes: 'binder', grade: null, groupIds: [], duplicateCount: 1, catalogAvailable: true
    });
    expect(await h.t.user.rows("SELECT language, id FROM catalog_identities")).toEqual([['en', 'tset-001']]);
    expect(await revision(h)).toBe(before + 1);
  });

  it('defaults to unspecified condition and no assumed price (null stays null, never 0)', async () => {
    const copy = await h.collection.add(copyOf('tset-002'));
    expect(copy.condition).toBeNull();
    expect(copy.purchasePrice).toBeNull();
    expect(copy.manualPrice).toBeNull();
    expect(copy.valuations).toEqual([]);
  });

  it('validation failures write nothing and leave the revision unchanged', async () => {
    const snapshot = await dumpPersonal(h);
    const rev = await revision(h);
    await rejects(h.collection.add({ language: 'en', variant: 'normal' } as never), ValidationError, 'VALIDATION_ERROR'); // neither source
    await rejects(h.collection.add({ language: 'en', variant: 'normal', catalogCardId: 'tset-001', customCardId: MISSING_UUID } as never), ValidationError); // both
    await rejects(h.collection.add({ ...copyOf('tset-001'), surprise: 1 } as never), ValidationError); // unknown key
    await rejects(h.collection.add(copyOf('tset-001', { variant: 'other' })), ValidationError); // other needs detail
    await rejects(h.collection.add(copyOf('tset-001', { purchasePrice: { cents: 1.5, currency: 'USD' } })), ValidationError); // fraction
    await rejects(h.collection.add(copyOf('tset-001', { purchasePrice: { cents: -1, currency: 'USD' } })), ValidationError);
    await rejects(h.collection.add(copyOf('tset-001', { purchasePrice: { cents: 2147483648, currency: 'USD' } })), ValidationError); // overflow
    await rejects(h.collection.add(copyOf('tset-001', { grade: { company: 'other', grade: '9' } as never })), ValidationError); // other needs label
    await rejects(h.collection.add(copyOf('tset-001', { grade: { company: 'PSA', companyLabel: 'x', grade: '9' } as never })), ValidationError);
    await rejects(h.collection.add(copyOf('tset-001', { condition: 'MINT' as never })), ValidationError);
    await rejects(h.collection.add(copyOf('nope-001')), NotFoundError, 'NOT_FOUND'); // unknown catalog card
    await rejects(h.collection.add({ ...copyOf('tset-001'), language: 'ja' }), NotFoundError); // ja catalog absent
    await rejects(h.collection.add(copyOf('tset-001', { storageLocationId: MISSING_UUID })), NotFoundError);
    await rejects(h.collection.add(copyOf('tset-001', { groupIds: [MISSING_UUID] })), NotFoundError);
    await rejects(h.collection.add(copyOf('tset-001', { acquisition: { id: MISSING_UUID } })), NotFoundError);
    await rejects(h.collection.add(customCopy(MISSING_UUID)), NotFoundError);
    expect(await dumpPersonal(h)).toEqual(snapshot);
    expect(await revision(h)).toBe(rev);
  });

  it('rolls back everything (created acquisition, ledger, copy) when a later step fails', async () => {
    const rev = await revision(h);
    const snapshot = await dumpPersonal(h);
    await rejects(h.collection.add(copyOf('tset-001', { acquisition: { create: { purchasedOn: '2026-02-30' } } as never })), ValidationError); // impossible date
    await rejects(h.collection.add(copyOf('tset-001', { acquisition: { create: { purchasedOn: '2026-01-01', source: 'Shop' } }, groupIds: [MISSING_UUID] })), NotFoundError);
    expect(await dumpPersonal(h)).toEqual(snapshot);
    expect(await revision(h)).toBe(rev);
  });

  it('rejects a custom card whose language differs from the copy language', async () => {
    const custom = await h.collection.createCustom({ name: 'Home Brew', language: 'ja' });
    await rejects(h.collection.add(customCopy(custom.id)), ValidationError);
  });

  it('stores a grade with preserved cert zeros; Grade row presence defines graded; company other requires a label (29)', async () => {
    const copy = await h.collection.add(copyOf('tset-001', { grade: { company: 'PSA', grade: '9.5', certNumber: '000123' } as never }));
    expect(copy.grade).toMatchObject({ company: 'PSA', grade: '9.5', certNumber: '000123', companyLabel: null });
    const other = await h.collection.add(copyOf('tset-001', { grade: { company: 'other', companyLabel: 'Local Lab', grade: 'Authentic' } as never }));
    expect(other.grade).toMatchObject({ company: 'other', companyLabel: 'Local Lab', grade: 'Authentic', certNumber: null });
  });
});

describe('bulkAdd (21)', () => {
  it('creates exactly N distinct copies atomically with per-copy cost and one shared acquisition', async () => {
    const rev = await revision(h);
    const result = await h.collection.bulkAdd({
      quantity: 3, copy: copyOf('tset-002', { purchasePrice: { cents: 100, currency: 'USD' }, acquisition: { create: { purchasedOn: '2026-03-04', source: 'Card Shop' } } })
    });
    expect(result.created).toBe(3);
    expect(new Set(result.copies.map((c) => c.id)).size).toBe(3);
    expect(result.copies.every((c) => c.purchasePrice?.cents === 100)).toBe(true);
    expect(new Set(result.copies.map((c) => c.acquisitionId)).size).toBe(1);
    expect(Number(await h.t.user.scalar('SELECT SUM(purchase_price_cents) FROM owned_cards'))).toBe(300);
    expect(Number(await h.t.user.scalar('SELECT COUNT(*) FROM acquisitions'))).toBe(1);
    expect(result.copies[0]?.duplicateCount).toBe(3);
    expect(await revision(h)).toBe(rev + 1); // once per transaction
  });

  it('rejects 0, negative, 101, fractions, a graded cert with N>1; invalid parent rolls the whole batch back', async () => {
    const rev = await revision(h);
    for (const quantity of [0, -1, 101, 2.5]) await rejects(h.collection.bulkAdd({ quantity, copy: copyOf('tset-001') }), ValidationError);
    await rejects(h.collection.bulkAdd({ quantity: 2, copy: copyOf('tset-001', { grade: { company: 'PSA', grade: '10', certNumber: '1' } as never }) }), ValidationError);
    await rejects(h.collection.bulkAdd({ quantity: 5, copy: copyOf('tset-001', { storageLocationId: MISSING_UUID }) }), NotFoundError);
    expect(await ownedCount(h)).toBe(0);
    expect(await revision(h)).toBe(rev);
    const ok = await h.collection.bulkAdd({ quantity: 2, copy: copyOf('tset-001', { grade: { company: 'PSA', grade: '10' } as never }) });
    expect(ok.copies.map((c) => c.grade?.id)).not.toContain(undefined);
    expect(new Set(ok.copies.map((c) => c.grade?.id)).size).toBe(2); // each copy owns its own grade row
  });

  it('accepts the maximum of 100', async () => {
    const result = await h.collection.bulkAdd({ quantity: 100, copy: copyOf('tset-003') });
    expect(result.created).toBe(100);
    expect(await ownedCount(h)).toBe(100);
  });
});

describe('update (17, 27, 54)', () => {
  it('changes only the intended copy; omission preserves, explicit null clears', async () => {
    const [a, b] = (await h.collection.bulkAdd({ quantity: 2, copy: copyOf('tset-001', { condition: 'NM', purchasePrice: { cents: 500, currency: 'USD' }, notes: 'keep' }) })).copies;
    const box = await h.collection.createLocation({ name: 'Binder 1' });
    const rev = await revision(h);
    const updated = await h.collection.update({ id: a!.id, patch: { condition: 'LP', storageLocationId: box.id, manualPrice: { cents: 999, currency: 'EUR' } } });
    expect(updated).toMatchObject({ condition: 'LP', storageLocationName: 'Binder 1', notes: 'keep', purchasePrice: { cents: 500, currency: 'USD' }, manualPrice: { cents: 999, currency: 'EUR' } });
    expect(updated.valuations).toEqual([{ currency: 'EUR', cents: 999, source: 'manual', priceSnapshotId: null, capturedAt: updated.updatedAt }]);
    expect(await revision(h)).toBe(rev + 1);
    expect(await h.collection.getCopy({ id: b!.id })).toEqual(b); // sibling untouched

    const cleared = await h.collection.update({ id: a!.id, patch: { condition: null, notes: null, manualPrice: null, storageLocationId: null, purchasePrice: null } });
    expect(cleared).toMatchObject({ condition: null, notes: null, manualPrice: null, storageLocationId: null, purchasePrice: null, valuations: [] });
  });

  it('replaces grade keeping its UUID, deletes with null, and replaces group membership transactionally', async () => {
    const copy = await h.collection.add(copyOf('tset-001', { grade: { company: 'PSA', grade: '8', certNumber: '1' } as never }));
    const g1 = await h.collection.createGroup({ name: 'Favorites' });
    const g2 = await h.collection.createGroup({ name: 'Trade' });
    const regraded = await h.collection.update({ id: copy.id, patch: { grade: { company: 'BGS', grade: '9.5' } as never, groupIds: [g1.id, g2.id] } });
    expect(regraded.grade?.id).toBe(copy.grade?.id);
    expect(regraded.grade).toMatchObject({ company: 'BGS', grade: '9.5', certNumber: null });
    expect(regraded.groupIds).toEqual([g1.id, g2.id].sort());
    const swapped = await h.collection.update({ id: copy.id, patch: { groupIds: [g2.id], grade: null } });
    expect(swapped.groupIds).toEqual([g2.id]);
    expect(swapped.grade).toBeNull();
    expect(Number(await h.t.user.scalar('SELECT COUNT(*) FROM grades'))).toBe(0);
  });

  it('validation, unknown copy and bad parents change nothing', async () => {
    const copy = await h.collection.add(copyOf('tset-001', { condition: 'NM' }));
    const snapshot = await dumpPersonal(h);
    const rev = await revision(h);
    await rejects(h.collection.update({ id: copy.id, patch: {} }), ValidationError);
    await rejects(h.collection.update({ id: copy.id, patch: { name: 'Renamed' } as never }), ValidationError); // snapshot fields are not patchable
    await rejects(h.collection.update({ id: copy.id, patch: { catalogCardId: 'tset-002' } as never }), ValidationError);
    await rejects(h.collection.update({ id: copy.id, patch: { variant: 'other' } }), ValidationError);
    await rejects(h.collection.update({ id: copy.id, patch: { purchasePrice: { cents: 5, currency: 'GBP' as never } } }), ValidationError);
    await rejects(h.collection.update({ id: 'not-a-uuid', patch: { notes: 'x' } }), ValidationError);
    await rejects(h.collection.update({ id: MISSING_UUID, patch: { notes: 'x' } }), NotFoundError);
    await rejects(h.collection.update({ id: copy.id, patch: { notes: 'x', storageLocationId: MISSING_UUID } }), NotFoundError);
    await rejects(h.collection.update({ id: copy.id, patch: { notes: 'x', groupIds: [MISSING_UUID] } }), NotFoundError);
    expect(await dumpPersonal(h)).toEqual(snapshot);
    expect(await revision(h)).toBe(rev);
  });

  it('changing the variant resets the qualifier unless one is supplied', async () => {
    const copy = await h.collection.add(copyOf('tset-001', { variant: 'first_edition', variantDetail: 'holo' }));
    expect((await h.collection.update({ id: copy.id, patch: { variant: 'normal' } })).variantDetail).toBe('');
    expect((await h.collection.update({ id: copy.id, patch: { variant: 'other', variantDetail: 'jumbo' } })).variantDetail).toBe('jumbo');
  });
});

describe('remove (18, 54)', () => {
  it('removes exactly that copy with its grade and memberships; unrelated rows remain', async () => {
    const group = await h.collection.createGroup({ name: 'G' });
    const a = await h.collection.add(copyOf('tset-001', { grade: { company: 'PSA', grade: '9' } as never, groupIds: [group.id], acquisition: { create: { source: 'Shop' } } }));
    const b = await h.collection.add(copyOf('tset-001'));
    const rev = await revision(h);
    await h.collection.remove({ id: a.id });
    expect(await ownedCount(h)).toBe(1);
    expect(Number(await h.t.user.scalar('SELECT COUNT(*) FROM grades'))).toBe(0);
    expect(Number(await h.t.user.scalar('SELECT COUNT(*) FROM collection_group_members'))).toBe(0);
    expect(Number(await h.t.user.scalar('SELECT COUNT(*) FROM acquisitions'))).toBe(1); // purchase history stays
    expect(Number(await h.t.user.scalar('SELECT COUNT(*) FROM collection_groups'))).toBe(1);
    expect(await h.collection.getCopy({ id: b.id })).toMatchObject({ id: b.id });
    expect(await revision(h)).toBe(rev + 1);
  });

  it('unknown copy is NotFoundError and changes nothing', async () => {
    await h.collection.add(copyOf('tset-001'));
    const rev = await revision(h);
    await rejects(h.collection.remove({ id: MISSING_UUID }), NotFoundError);
    await rejects(h.collection.remove({ id: 'bad' }), ValidationError);
    expect(await ownedCount(h)).toBe(1);
    expect(await revision(h)).toBe(rev);
  });
});

describe('acquisitions (55, 29)', () => {
  it('create/list/get/update/remove with bounds, shared edits and InUse protection', async () => {
    const jan = await h.collection.createAcquisition({ purchasedOn: '2026-01-10', source: 'Local Shop' });
    const mar = await h.collection.createAcquisition({ purchasedOn: '2026-03-05', source: 'Online Store' });
    const unknown = await h.collection.createAcquisition({ source: 'Gift' });
    const list = await h.collection.listAcquisitions({});
    expect(list.data.map((a) => a.id)).toEqual([mar.id, jan.id, unknown.id]); // date DESC, unknown last
    expect((await h.collection.listAcquisitions({ source: 'shop' })).data.map((a) => a.id)).toEqual([jan.id]);
    expect((await h.collection.listAcquisitions({ from: '2026-01-10', to: '2026-01-10' })).data.map((a) => a.id)).toEqual([jan.id]); // inclusive
    expect((await h.collection.listAcquisitions({ from: '2026-01-01' })).data.map((a) => a.id)).toEqual([mar.id, jan.id]); // unknown excluded by a bound
    await rejects(h.collection.listAcquisitions({ from: '2026-05-01', to: '2026-01-01' }), ValidationError);

    const copies = (await h.collection.bulkAdd({ quantity: 2, copy: copyOf('tset-001', { acquisition: { id: jan.id }, purchasePrice: { cents: 700, currency: 'USD' } }) })).copies;
    const edited = await h.collection.updateAcquisition({ id: jan.id, patch: { source: 'Convention', purchasedOn: '2026-01-11' } });
    expect(edited).toMatchObject({ source: 'Convention', purchasedOn: '2026-01-11', copyCount: 2 });
    const after = await h.collection.getCopy({ id: copies[0]!.id });
    expect(after.acquisition).toMatchObject({ source: 'Convention', purchasedOn: '2026-01-11' }); // shared event edit...
    expect(after.purchasePrice).toEqual({ cents: 700, currency: 'USD' }); // ...never touches per-copy cents

    await rejects(h.collection.updateAcquisition({ id: jan.id, patch: {} }), ValidationError);
    await rejects(h.collection.updateAcquisition({ id: MISSING_UUID, patch: { source: 'x' } }), NotFoundError);
    await rejects(h.collection.removeAcquisition({ id: jan.id }), InUseError, 'IN_USE');
    await h.collection.removeAcquisition({ id: unknown.id });
    await rejects(h.collection.getAcquisition({ id: unknown.id }), NotFoundError);
    expect(await h.collection.getAcquisition({ id: jan.id })).toMatchObject({ copyCount: 2 });
  });
});

describe('locations and groups (56)', () => {
  it('normalized unique names, conflicts, empty patches, FK effects, revision once', async () => {
    const box = await h.collection.createLocation({ name: 'Shoe Box', description: 'closet' });
    await rejects(h.collection.createLocation({ name: '  shoe box ' }), Error, 'CONFLICT');
    await rejects(h.collection.createLocation({ name: 'ＳＨＯＥ　ＢＯＸ' }), Error, 'CONFLICT'); // NFKC
    const other = await h.collection.createLocation({ name: 'Desk' });
    await rejects(h.collection.updateLocation({ id: other.id, patch: { name: 'SHOE BOX' } }), Error, 'CONFLICT');
    await rejects(h.collection.updateLocation({ id: other.id, patch: {} }), ValidationError);
    expect((await h.collection.updateLocation({ id: box.id, patch: { description: null } })).description).toBeNull();
    expect((await h.collection.listLocations({ q: 'desk' })).data.map((l) => l.id)).toEqual([other.id]);

    const copies = (await h.collection.bulkAdd({ quantity: 2, copy: copyOf('tset-001', { storageLocationId: box.id }) })).copies;
    expect((await h.collection.getLocation({ id: box.id })).copyCount).toBe(2);
    const rev = await revision(h);
    await h.collection.removeLocation({ id: box.id });
    expect(await revision(h)).toBe(rev + 1);
    expect(await ownedCount(h)).toBe(2); // copies stay
    expect((await h.collection.getCopy({ id: copies[0]!.id })).storageLocationId).toBeNull();
    await rejects(h.collection.removeLocation({ id: box.id }), NotFoundError);
  });

  it('addMembers/removeMembers are all-or-nothing, idempotent, and bump the revision only when something changed', async () => {
    const group = await h.collection.createGroup({ name: 'Deck' });
    const [a, b] = (await h.collection.bulkAdd({ quantity: 2, copy: copyOf('tset-004') })).copies;
    const rev = await revision(h);
    expect((await h.collection.addMembers({ id: group.id, ownedCardIds: [a!.id, b!.id] })).copyCount).toBe(2);
    expect(await revision(h)).toBe(rev + 1);
    await h.collection.addMembers({ id: group.id, ownedCardIds: [a!.id] }); // no-op
    expect(await revision(h)).toBe(rev + 1);
    await rejects(h.collection.removeMembers({ id: group.id, ownedCardIds: [a!.id, MISSING_UUID] }), NotFoundError);
    expect((await h.collection.getGroup({ id: group.id })).copyCount).toBe(2); // nothing partially removed
    expect((await h.collection.removeMembers({ id: group.id, ownedCardIds: [a!.id] })).copyCount).toBe(1);
    await h.collection.removeGroup({ id: group.id });
    expect(await ownedCount(h)).toBe(2); // group delete removes memberships, not copies
    expect(Number(await h.t.user.scalar('SELECT COUNT(*) FROM collection_group_members'))).toBe(0);
    await rejects(h.collection.addMembers({ id: MISSING_UUID, ownedCardIds: [a!.id] }), NotFoundError);
  });
});

describe('custom cards (23, 57)', () => {
  it('creates, lists, updates without rewriting snapshots, protects referenced rows, allows same names', async () => {
    const a = await h.collection.createCustom({ name: 'Home Brew', language: 'en' });
    const b = await h.collection.createCustom({ name: 'Home Brew', language: 'en', setName: 'Fan Set', localId: 'X1', imageUrl: 'https://img.example.test/x.png', notes: 'n' });
    expect(a.id).not.toBe(b.id); // same name allowed
    expect(a).toMatchObject({ setId: null, setName: null, localId: null, rarity: null, imageUrl: null, copyCount: 0 });
    const copy = await h.collection.add(customCopy(a.id, { variant: 'holo' }));
    expect(copy).toMatchObject({ customCardId: a.id, catalogCardId: null, name: 'Home Brew', setId: null, localId: null, catalogAvailable: false });

    const renamed = await h.collection.updateCustom({ id: a.id, patch: { name: 'Renamed Brew', rarity: 'Rare' } });
    expect(renamed).toMatchObject({ name: 'Renamed Brew', rarity: 'Rare', copyCount: 1 });
    expect((await h.collection.getCopy({ id: copy.id })).name).toBe('Home Brew'); // snapshot not rewritten
    await rejects(h.collection.updateCustom({ id: a.id, patch: { language: 'ja' } }), Error, 'CONFLICT'); // referenced language immutable
    expect((await h.collection.updateCustom({ id: b.id, patch: { language: 'ja' } })).language).toBe('ja'); // unreferenced: fine
    await rejects(h.collection.updateCustom({ id: a.id, patch: {} }), ValidationError);
    await rejects(h.collection.updateCustom({ id: MISSING_UUID, patch: { name: 'x' } }), NotFoundError);
    await rejects(h.collection.removeCustom({ id: a.id }), InUseError);
    await h.collection.removeCustom({ id: b.id });
    expect((await h.collection.listCustom({ q: 'renamed' })).data.map((c) => c.id)).toEqual([a.id]);
    await h.collection.remove({ id: copy.id });
    await h.collection.removeCustom({ id: a.id });
    await rejects(h.collection.getCustom({ id: a.id }), NotFoundError);
  });
});

describe('catalog independence (28, 38)', () => {
  it('wiping catalog_cards and catalog_sets with FKs ON leaves every owned snapshot readable and editable', async () => {
    const group = await h.collection.createGroup({ name: 'G' });
    const copy = await h.collection.add(copyOf('tset-001', { grade: { company: 'PSA', grade: '9' } as never, groupIds: [group.id], manualPrice: { cents: 100, currency: 'USD' } }));
    await h.t.databases.close(); // release the readers, then wipe the catalog file as a cache wipe would
    const { createNodeDriver } = await import('../src/testing/node-driver');
    const wipe = createNodeDriver(h.t.catalogPath('en'));
    wipe.raw.pragma('foreign_keys = ON');
    wipe.raw.exec('DELETE FROM catalog_latest_prices; DELETE FROM catalog_variants; DELETE FROM catalog_cards; DELETE FROM catalog_sets;');
    await wipe.close();
    const reopened = await h.t.reopen();
    const h2 = (await import('./helpers')).harnessFor(reopened);
    const read = await h2.collection.getCopy({ id: copy.id });
    expect(read).toMatchObject({ name: 'Alpha Mon', setName: 'Test Set Alpha', catalogAvailable: false, grade: { company: 'PSA' } });
    expect((await h2.collection.list({})).data).toHaveLength(1);
    expect((await h2.collection.update({ id: copy.id, patch: { notes: 'still editable' } })).notes).toBe('still editable');
    await expect(h2.t.user.run("DELETE FROM catalog_identities WHERE id = 'tset-001'")).rejects.toThrow(/FOREIGN KEY/); // ledger protected
    await rejects(h2.catalog.getCard({ language: 'en', cardId: 'tset-001' }), NotFoundError); // catalog detail is NotFound, the copy is not hidden
    await h2.cleanup();
    h = h2;
  });
});
