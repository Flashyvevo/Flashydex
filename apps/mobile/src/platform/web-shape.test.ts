// @vitest-environment node
import { afterEach, describe, expect, it } from 'vitest';
import {
  CatalogRepo, CollectionRepo, PortfolioService, TransferService, type ProxyCallback
} from '@flashydex/core';
import {
  createCatalogFile, createMemoryPlatform, createTestDatabases, FixedEnvironment, seedCatalog, type ProxyFactory, type TestDatabases
} from '@flashydex/core/testing';
import { createProxyCallback } from './sqlite-proxy';

/**
 * C1 regression: the web/jeep plugin returns rows as OBJECTS, so duplicate projected column names (`c.name`, `s.name`) collapse.
 * This runs the SAME scenario on the array-returning Node driver and on the jeep-shaped (objects) driver wrapped by the real
 * `createProxyCallback`, and asserts identical results — plus the stored snapshot equals the catalog card.
 */
const webFactory: ProxyFactory = (connection) => createProxyCallback(connection) as ProxyCallback;

const SETS = [{ id: 'swsh3', name: 'Darkness Ablaze', series: 'swsh', releaseDate: '2020-08-14', officialCount: 189, totalCount: 201 }];
const CARDS = [
  { id: 'swsh3-19', setId: 'swsh3', localId: '19', name: 'Charizard V', rarity: 'Holo Rare V', imageUrl: 'https://assets.tcgdex.net/en/swsh/swsh3/19', variants: ['holo' as const] },
  { id: 'swsh3-20', setId: 'swsh3', localId: '20', name: 'Charmander', rarity: 'Common', imageUrl: 'https://assets.tcgdex.net/en/swsh/swsh3/20', variants: ['normal' as const, 'reverse_holo' as const] }
];
const PRICES = [{ cardId: 'swsh3-19', source: 'tcgplayer' as const, variant: 'holo' as const, market: 715, low: 500, mid: 700, high: 900 }];

const open: TestDatabases[] = [];
afterEach(async () => { while (open.length) await open.pop()!.cleanup(); });

async function scenario(proxyFactory?: ProxyFactory) {
  const t = await createTestDatabases({ env: new FixedEnvironment(undefined, true), proxyFactory });
  open.push(t);
  const writer = await createCatalogFile(t.catalogPath('en'), 'en', t.env);
  await seedCatalog(writer, 'en', { sets: SETS, cards: CARDS, prices: PRICES });
  await writer.close();
  await t.databases.invalidateCatalog('en');
  const ctx: ConstructorParameters<typeof CollectionRepo>[0] = { databases: t.databases, env: t.env };
  const collection = new CollectionRepo(ctx);
  const catalog = new CatalogRepo(ctx);
  const portfolio = new PortfolioService(ctx);
  const platform = createMemoryPlatform(t.env);
  const transfer = new TransferService(ctx, platform);

  const first = await collection.add({ language: 'en', catalogCardId: 'swsh3-19', variant: 'holo' });
  await collection.add({ language: 'en', catalogCardId: 'swsh3-19', variant: 'holo' });
  await collection.add({ language: 'en', catalogCardId: 'swsh3-20', variant: 'normal', condition: 'NM' });
  const exported = await transfer.exportFile({ format: 'json' });
  const doc = JSON.parse(new TextDecoder().decode(platform.files.get(exported.file.id)!.bytes)) as { ownedCards: Array<Record<string, unknown>>; catalogRefs: unknown[] };
  const report = await transfer.dryRun({ format: 'json', conflictPolicy: 'skip', file: exported.file });
  return {
    first,
    stored: doc.ownedCards.map((row) => Object.fromEntries(Object.entries(row).filter(([key]) => !["id", "createdAt", "updatedAt"].includes(key)))),
    refs: doc.catalogRefs,
    grouped: await collection.list({ groupBy: 'card' }),
    copies: await collection.list({ groupBy: 'copy' }),
    one: await collection.getCopy({ id: first.id }),
    search: await catalog.searchCards({ q: 'Charizard' } as never),
    setCards: await catalog.listSetCards({ language: 'en', setId: 'swsh3' } as never),
    sets: await catalog.listSets({ language: 'en' } as never),
    card: await catalog.getCard({ language: 'en', cardId: 'swsh3-19' } as never),
    dashboard: await portfolio.dashboard({}),
    reportValid: report.valid
  };
}

describe('web (object-row) driver parity — C1', () => {
  it('stores the exact catalog snapshot (name/setName/localId/rarity/imageUrl)', async () => {
    const web = await scenario(webFactory);
    expect(web.first).toMatchObject({
      name: 'Charizard V', setId: 'swsh3', setName: 'Darkness Ablaze', localId: '19', rarity: 'Holo Rare V', imageUrl: 'https://assets.tcgdex.net/en/swsh/swsh3/19'
    });
    expect(web.stored[0]).toMatchObject({
      name: 'Charizard V', setName: 'Darkness Ablaze', localId: '19', rarity: 'Holo Rare V', imageUrl: 'https://assets.tcgdex.net/en/swsh/swsh3/19'
    });
    expect(JSON.stringify(web.stored)).not.toContain('undefined');
  });

  it('every read path (list, search, set cards, set list, card detail, dashboard, export, dry-run) equals the array driver', async () => {
    const arrays = await scenario();
    const web = await scenario(webFactory);
    expect(web.grouped).toEqual(arrays.grouped);
    expect(web.copies).toEqual(arrays.copies);
    expect(web.one).toEqual(arrays.one);
    expect(web.search).toEqual(arrays.search);
    expect(web.setCards).toEqual(arrays.setCards);
    expect(web.sets).toEqual(arrays.sets);
    expect(web.card).toEqual(arrays.card);
    expect(web.dashboard).toEqual(arrays.dashboard);
    expect(web.stored).toEqual(arrays.stored);
    expect(web.refs).toEqual(arrays.refs);
    expect(web.reportValid).toBe(true);
    expect(arrays.reportValid).toBe(true);
  });
});
