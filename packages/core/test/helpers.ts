import { CatalogRepo } from '../src/services/catalog';
import { CollectionRepo } from '../src/services/collection';
import type { ServiceContext } from '../src/services/context';
import { PortfolioService } from '../src/services/portfolio';
import { SettingsRepo } from '../src/services/settings';
import { createCatalogFile, createTestDatabases, type TestDatabases } from '../src/testing/node-driver';
import { seedCatalog, type FixtureCard, type FixturePrice, type FixtureSet } from '../src/testing/catalog-fixture';
import type { Language, OwnedCreate } from '@flashydex/schemas';
import type { z } from 'zod';

export type Harness = {
  t: TestDatabases;
  ctx: ServiceContext;
  settings: SettingsRepo;
  catalog: CatalogRepo;
  collection: CollectionRepo;
  portfolio: PortfolioService;
  cleanup(): Promise<void>;
};

export function harnessFor(t: TestDatabases): Harness {
  const ctx: ServiceContext = { databases: t.databases, env: t.env };
  return { t, ctx, settings: new SettingsRepo(ctx), catalog: new CatalogRepo(ctx), collection: new CollectionRepo(ctx), portfolio: new PortfolioService(ctx), cleanup: () => t.cleanup() };
}

export async function harness(): Promise<Harness> {
  return harnessFor(await createTestDatabases());
}

/** Write a catalog file through the bundled catalog migration chain, seed it, and (re)open the reader. */
export async function installCatalog(h: Harness, language: Language, data: { sets: FixtureSet[]; cards: FixtureCard[]; prices?: FixturePrice[] }): Promise<void> {
  const writer = await createCatalogFile(h.t.catalogPath(language), language, h.t.env);
  await seedCatalog(writer, language, data);
  await writer.close();
  await h.t.databases.invalidateCatalog(language);
}

/** Clearly synthetic test catalog: 5-card published set, an unpublished shell, a TCG Pocket set. */
export const TEST_SET = { id: 'tset', name: 'Test Set Alpha', series: 'tseries', releaseDate: '2020-02-07' } satisfies FixtureSet;
export const testCards = (setId = 'tset', prefix = 'tset'): FixtureCard[] =>
  ['001', '002', '003', '004', '005'].map((localId, i) => ({
    id: `${prefix}-${localId}`, setId, localId, name: ['Alpha Mon', 'Beta Mon', 'Gamma Mon', 'Delta Mon', 'Alpha Beast'][i] as string,
    rarity: i === 0 ? 'Rare' : 'Common', imageUrl: `https://assets.example.test/${prefix}/${localId}`, variants: i === 0 ? ['normal', 'reverse_holo', 'holo'] : ['normal']
  }));

export async function installStandardCatalog(h: Harness, language: Language = 'en'): Promise<void> {
  await installCatalog(h, language, {
    sets: [
      TEST_SET,
      { id: 'pocket', name: 'Pocket Set', series: 'tcgp', releaseDate: '2024-10-30' },
      { id: 'shell', name: 'Empty Shell', series: 'tseries', releaseDate: '2021-01-01', status: 'unpublished', manifest: [], officialCount: 0, totalCount: 30 }
    ],
    cards: [...testCards(), { id: 'pocket-001', setId: 'pocket', localId: '001', name: 'Pocket Mon', rarity: 'Common' }]
  });
}

type Create = z.input<typeof OwnedCreate>;
export const copyOf = (cardId: string, extra: Partial<Create> = {}): Create => ({ language: 'en', catalogCardId: cardId, variant: 'normal', ...extra }) as Create;
export const customCopy = (customCardId: string, extra: Partial<Create> = {}): Create => ({ language: 'en', customCardId, variant: 'normal', ...extra }) as Create;

export const MISSING_UUID = '99999999-9999-4999-8999-999999999999';

export async function dumpPersonal(h: Harness): Promise<Record<string, unknown[][]>> {
  const out: Record<string, unknown[][]> = {};
  for (const table of ['owned_cards', 'grades', 'acquisitions', 'storage_locations', 'collection_groups', 'collection_group_members', 'custom_cards', 'catalog_identities', 'price_snapshots', 'scan_sessions']) {
    out[table] = await h.t.user.rows(`SELECT * FROM ${table} ORDER BY 1, 2`);
  }
  return out;
}

export const revision = async (h: Harness): Promise<number> => Number(await h.t.user.scalar<number>("SELECT collection_revision FROM app_state WHERE id = 'collection'"));
export const ownedCount = async (h: Harness): Promise<number> => Number(await h.t.user.scalar<number>('SELECT COUNT(*) FROM owned_cards'));
