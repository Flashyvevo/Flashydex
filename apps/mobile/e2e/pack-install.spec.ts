import { expect, test, type Page } from '@playwright/test';
import { catalogPoolState, type CatalogPoolState } from './helpers';

interface Manifest {
  languages: Record<string, { targetVersion: string; sha256: string; uncompressedBytes: number; compressedBytes: number; counts: Record<string, number> }>;
}
interface Metrics { counts: { sets: number; cards: number; variants: number; prices: number; unpublishedSets: number }; sha256: string; uncompressedBytes: number }

async function loadDevPack(page: Page, language: 'en' | 'ja') {
  const manifest = (await (await page.request.get('/dev-packs/catalog-manifest.json')).json()) as Manifest;
  const entry = manifest.languages[language];
  expect(entry, `dev manifest has a ${language} entry (run npm run catalog:dev-pack)`).toBeDefined();
  const metrics = (await (await page.request.get(`/dev-packs/catalog-${language}-${entry!.targetVersion}.metrics.json`)).json()) as Metrics;
  return { entry: entry!, metrics };
}

/** The harness' own pool snapshots (taken in-page right after activate and after finalize). */
async function harnessPool(page: Page, which: 'pool-before-finalize' | 'pool-after'): Promise<CatalogPoolState> {
  return JSON.parse((await page.getByTestId(which).textContent()) ?? '{}') as CatalogPoolState;
}

async function openHarness(page: Page) {
  const errors: string[] = [];
  page.on('pageerror', (error) => errors.push(error.message));
  await page.goto('/dev/pack-test');
  await expect(page.getByTestId('pack-status')).toHaveText('ready', { timeout: 20_000 });
  return errors;
}

/** Nothing installed: no catalog file in the pool, no role pointers, no OPFS staging directories. */
function expectNoCatalog(state: CatalogPoolState): void {
  expect(state.files).toEqual([]);
  expect(state.activeRefs.en ?? null).toBeNull();
  expect(state.activeRefs.ja ?? null).toBeNull();
  expect(state.previousRefs.en ?? null).toBeNull();
  expect(state.previousRefs.ja ?? null).toBeNull();
  expect(state.staging).toEqual([]);
}

for (const language of ['en', 'ja'] as const) {
  test(`installs the ${language.toUpperCase()} dev pack, opens it and the row counts match the builder metrics`, async ({ page }) => {
    const errors = await openHarness(page);
    const { entry, metrics } = await loadDevPack(page, language);
    expectNoCatalog(await catalogPoolState(page));

    await page.getByTestId(`install-${language}`).click();
    await expect(page.getByTestId('pack-status')).toHaveText('installed', { timeout: 60_000 });

    await expect(page.getByTestId('pack-language')).toHaveText(language);
    await expect(page.getByTestId('pack-version')).toHaveText(entry.targetVersion);
    await expect(page.getByTestId('pack-bytes')).toHaveText(String(entry.uncompressedBytes));
    await expect(page.getByTestId('pack-sha256')).toHaveText(entry.sha256);
    expect(metrics.sha256).toBe(entry.sha256);
    await expect(page.getByTestId('pack-previous')).toHaveText('false');

    await expect(page.getByTestId('count-catalog_sets')).toHaveText(String(metrics.counts.sets));
    await expect(page.getByTestId('count-catalog_cards')).toHaveText(String(metrics.counts.cards));
    await expect(page.getByTestId('count-catalog_variants')).toHaveText(String(metrics.counts.variants));
    await expect(page.getByTestId('count-catalog_latest_prices')).toHaveText(String(metrics.counts.prices));
    await expect(page.getByTestId('first-card')).not.toHaveText('');

    const deviceMetrics = JSON.parse((await page.getByTestId('pack-metrics').textContent()) ?? '{}') as Record<string, unknown>;
    expect(deviceMetrics).toMatchObject({ metricsVersion: 2, language, storageKind: 'web-store', peakMemoryBytes: null });
    expect(Number(deviceMetrics.maxInFlightObserved)).toBeLessThanOrEqual(4);
    expect(Number(deviceMetrics.maxChunkBytes)).toBeLessThanOrEqual(256 * 1024);
    expect(Number(deviceMetrics.pendingBytesMax)).toBeLessThanOrEqual(32 * 1024 * 1024);
    expect(Number(deviceMetrics.zstdWindowBytes)).toBeLessThanOrEqual(2 ** 25);

    // Pool truth: exactly one catalog file for this language, referenced as active; nothing for the other language; no staging left over.
    const pool = await catalogPoolState(page);
    const active = pool.activeRefs[language];
    expect(active).toMatch(new RegExp(`^/catalog-${language}/g-[A-Za-z0-9_-]+\\.db$`));
    expect(pool.files).toEqual([active]);
    expect(pool.previousRefs[language] ?? null).toBeNull();
    expect(pool.activeRefs[language === 'en' ? 'ja' : 'en'] ?? null).toBeNull();
    expect(pool.staging).toEqual([]);
    expect(errors).toEqual([]);
  });
}

test('reinstalling over an installed catalog keeps the previous copy until finalize, then leaves only the active one', async ({ page }) => {
  await openHarness(page);
  const { metrics } = await loadDevPack(page, 'en');
  await page.getByTestId('install-en').click();
  await expect(page.getByTestId('pack-status')).toHaveText('installed', { timeout: 60_000 });
  const first = await catalogPoolState(page);
  const firstRef = first.activeRefs.en!;
  expect(first.files).toEqual([firstRef]);

  await page.getByTestId('install-en').click();
  await expect(page.getByTestId('pack-previous')).toHaveText('true', { timeout: 60_000 });
  await expect(page.getByTestId('pack-status')).toHaveText('installed');
  await expect(page.getByTestId('count-catalog_cards')).toHaveText(String(metrics.counts.cards));

  // Between activate and finalize: the NEW generation is active, the OLD one is still on disk as previous (rollback target).
  const mid = await harnessPool(page, 'pool-before-finalize');
  const secondRef = mid.activeRefs.en!;
  expect(secondRef).not.toBe(firstRef);
  expect(mid.previousRefs.en).toBe(firstRef);
  expect(mid.files).toEqual([firstRef, secondRef].sort());

  // After finalize: only the active generation remains, no previous pointer, no staging.
  const done = await catalogPoolState(page);
  expect(done.activeRefs.en).toBe(secondRef);
  expect(done.previousRefs.en ?? null).toBeNull();
  expect(done.files).toEqual([secondRef]);
  expect(done.staging).toEqual([]);
  expect(await harnessPool(page, 'pool-after')).toEqual(done);
});

test('removing an installed catalog leaves no catalog file, role pointer or staging', async ({ page }) => {
  await openHarness(page);
  await page.getByTestId('install-en').click();
  await expect(page.getByTestId('pack-status')).toHaveText('installed', { timeout: 60_000 });
  expect((await catalogPoolState(page)).files).toHaveLength(1);

  await page.getByTestId('remove').click();
  await expect(page.getByTestId('pack-status')).toHaveText('ready', { timeout: 20_000 });
  await expect(page.getByTestId('count-catalog_sets')).toHaveCount(0);
  expectNoCatalog(await catalogPoolState(page));
});

test('a manifest hash mismatch fails with PACK_HASH_MISMATCH and installs nothing', async ({ page }) => {
  await page.route('**/dev-packs/catalog-manifest.json', async (route) => {
    const manifest = (await (await route.fetch()).json()) as Manifest;
    manifest.languages.en!.sha256 = '0'.repeat(64);
    await route.fulfill({ json: manifest });
  });
  await openHarness(page);
  await page.getByTestId('install-en').click();
  await expect(page.getByTestId('pack-status')).toHaveText('error', { timeout: 60_000 });
  await expect(page.getByTestId('pack-error')).toContainText('PACK_HASH_MISMATCH');
  await expect(page.getByTestId('count-catalog_sets')).toHaveCount(0);
  await expect.poll(async () => (await catalogPoolState(page)).staging, { timeout: 10_000 }).toEqual([]);
  expectNoCatalog(await catalogPoolState(page));
});

test('a wrong compressed size fails with PACK_SIZE_MISMATCH and installs nothing', async ({ page }) => {
  await page.route('**/dev-packs/catalog-manifest.json', async (route) => {
    const manifest = (await (await route.fetch()).json()) as Manifest;
    manifest.languages.en!.compressedBytes += 1;
    await route.fulfill({ json: manifest });
  });
  await openHarness(page);
  await page.getByTestId('install-en').click();
  await expect(page.getByTestId('pack-status')).toHaveText('error', { timeout: 60_000 });
  await expect(page.getByTestId('pack-error')).toContainText('PACK_SIZE_MISMATCH');
  await expect.poll(async () => (await catalogPoolState(page)).staging, { timeout: 10_000 }).toEqual([]);
  expectNoCatalog(await catalogPoolState(page));
});

test('cancelling a slow download aborts cleanly and leaves no catalog', async ({ page }) => {
  await page.route('**/*.db.zst', async (route) => {
    await new Promise((resolve) => setTimeout(resolve, 4000));
    await route.continue().catch(() => undefined);
  });
  await openHarness(page);
  await page.getByTestId('install-en').click();
  await expect(page.getByTestId('pack-status')).toHaveText('downloading');
  await page.getByTestId('cancel').click();
  await expect(page.getByTestId('pack-status')).toHaveText('cancelled', { timeout: 10_000 });
  await expect(page.getByTestId('count-catalog_sets')).toHaveCount(0);
  await expect.poll(async () => (await catalogPoolState(page)).staging, { timeout: 10_000 }).toEqual([]);
  expectNoCatalog(await catalogPoolState(page));
});
