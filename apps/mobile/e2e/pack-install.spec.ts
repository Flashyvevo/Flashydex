import { expect, test, type Page } from '@playwright/test';

test.use({ viewport: { width: 390, height: 844 } });

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

async function jeepKeys(page: Page): Promise<string[]> {
  return page.evaluate(
    () => new Promise<string[]>((resolve) => {
      const open = indexedDB.open('jeepSqliteStore');
      open.onerror = () => resolve([]);
      open.onsuccess = () => {
        const db = open.result;
        if (!db.objectStoreNames.contains('databases')) { db.close(); resolve([]); return; }
        const request = db.transaction('databases', 'readonly').objectStore('databases').getAllKeys();
        request.onsuccess = () => { db.close(); resolve((request.result as string[]).filter((k) => k.startsWith('catalog-'))); };
        request.onerror = () => { db.close(); resolve([]); };
      };
    })
  );
}

async function openHarness(page: Page) {
  const errors: string[] = [];
  page.on('pageerror', (error) => errors.push(error.message));
  await page.goto('/dev/pack-test');
  await expect(page.getByTestId('pack-status')).toHaveText('ready', { timeout: 20_000 });
  return errors;
}

for (const language of ['en', 'ja'] as const) {
  test(`installs the ${language.toUpperCase()} dev pack, opens it and the row counts match the builder metrics`, async ({ page }) => {
    const errors = await openHarness(page);
    const { entry, metrics } = await loadDevPack(page, language);

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
    expect(deviceMetrics).toMatchObject({ metricsVersion: 1, language, storageKind: 'web-store', peakMemoryBytes: null });
    expect(Number(deviceMetrics.maxInFlightObserved)).toBeLessThanOrEqual(4);
    expect(Number(deviceMetrics.maxChunkBytes)).toBeLessThanOrEqual(256 * 1024);
    expect(Number(deviceMetrics.zstdWindowBytes)).toBeLessThanOrEqual(2 ** 25);

    expect(await jeepKeys(page)).toEqual([`catalog-${language}SQLite.db`]);
    expect(errors).toEqual([]);
  });
}

test('reinstalling over an installed catalog keeps the previous copy until finalize, then leaves only the active one', async ({ page }) => {
  await openHarness(page);
  const { metrics } = await loadDevPack(page, 'en');
  await page.getByTestId('install-en').click();
  await expect(page.getByTestId('pack-status')).toHaveText('installed', { timeout: 60_000 });
  await page.getByTestId('install-en').click();
  await expect(page.getByTestId('pack-previous')).toHaveText('true', { timeout: 60_000 });
  await expect(page.getByTestId('pack-status')).toHaveText('installed');
  await expect(page.getByTestId('count-catalog_cards')).toHaveText(String(metrics.counts.cards));
  expect(await jeepKeys(page)).toEqual(['catalog-enSQLite.db']);
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
  expect(await jeepKeys(page)).toEqual([]);
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
  expect(await jeepKeys(page)).toEqual([]);
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
  expect(await jeepKeys(page)).toEqual([]);
});
