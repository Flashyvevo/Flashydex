import { expect, test } from '@playwright/test';
import { downloadBuffer, onboardAndInstall, openConfirmFor, readOwnedCopies, trackErrors } from './helpers';

test.describe.configure({ timeout: 240_000 });

test('onboarding → install → add 2 Charizard V → one ×2 tile → detail → JSON export', async ({ page }) => {
  const errors = trackErrors(page);
  await onboardAndInstall(page);

  await openConfirmFor(page, 'Charizard', 'Charizard V');
  await page.getByTestId('qty-input').fill('2');
  await expect(page.getByTestId('qty-input')).toHaveValue('2');
  await page.getByRole('button', { name: 'More details' }).click();
  await page.locator('#pnotes').fill('binder page 3');
  await page.getByTestId('add-submit').click();
  await expect(page.getByRole('heading', { name: /Added Charizard V/ })).toBeVisible({ timeout: 20_000 });

  await page.goto('/collection');
  const tiles = page.getByTestId('card-tile').filter({ hasText: 'Charizard V' });
  await expect(tiles).toHaveCount(1, { timeout: 20_000 });
  await expect(tiles.first()).toContainText('×2');
  await expect(page.getByTestId('card-tile')).toHaveCount(1);

  await tiles.first().click();
  await expect(page.getByText('Darkness Ablaze').first()).toBeVisible({ timeout: 20_000 });
  await expect(page.getByText(/19\/189/).first()).toBeVisible();
  await expect(page.getByText('2 of 2 copies valued').or(page.getByText(/copies? valued/)).first()).toBeVisible();

  await page.goto('/settings/data');
  const [download] = await Promise.all([page.waitForEvent('download', { timeout: 30_000 }), page.getByTestId('export-json').click()]);
  const stream = await download.createReadStream();
  const chunks: Buffer[] = [];
  for await (const chunk of stream) chunks.push(Buffer.from(chunk as Buffer));
  const text = Buffer.concat(chunks).toString('utf8');
  expect(() => JSON.parse(text)).not.toThrow();
  expect(text).toContain('Charizard V');
  expect(errors).toEqual([]);
});

test('.fdx backup → fresh browser context (reinstall) → install dev pack → restore → same tiles, copy ids and notes', async ({ page, browser }) => {
  const errors = trackErrors(page);
  await onboardAndInstall(page);
  await openConfirmFor(page, 'Charizard', 'Charizard V');
  await page.getByTestId('qty-input').fill('2');
  await page.getByRole('button', { name: 'More details' }).click();
  await page.locator('#pnotes').fill('binder page 3');
  await page.getByTestId('add-submit').click();
  await expect(page.getByRole('heading', { name: /Added Charizard V/ })).toBeVisible({ timeout: 20_000 });

  const before = await readOwnedCopies(page);
  expect(before).toHaveLength(2);
  expect(before.every((c) => c.notes === 'binder page 3')).toBe(true);

  // Create the .fdx and capture the download.
  await page.goto('/settings/data');
  await expect(page.getByTestId('backup-create')).toBeEnabled({ timeout: 20_000 });
  const [backup] = await Promise.all([page.waitForEvent('download', { timeout: 60_000 }), page.getByTestId('backup-create').click()]);
  expect(backup.suggestedFilename()).toMatch(/^flashydex-.*\.fdx$/);
  const fdx = await downloadBuffer(backup);
  expect(fdx.length).toBeGreaterThan(100);
  expect(fdx.subarray(0, 2).toString('latin1')).toBe('PK'); // ZIP container

  // Fresh context = reinstall: no IndexedDB, no collection, no catalog.
  const viewport = page.viewportSize() ?? { width: 390, height: 844 };
  const fresh = await browser.newContext({ viewport, isMobile: viewport.width < 600, hasTouch: viewport.width < 600 });
  try {
    const page2 = await fresh.newPage();
    const errors2 = trackErrors(page2);
    await page.close(); // release the writer lock held by the first context's page (same origin, different profile, but keep the run tidy)
    await onboardAndInstall(page2);
    await page2.goto('/collection');
    await expect(page2.getByTestId('card-tile')).toHaveCount(0);

    await page2.goto('/settings/data');
    await page2.getByTestId('restore-file').click();
    await expect(page2.getByTestId('restore-sheet')).toBeVisible();
    const chooser = page2.waitForEvent('filechooser');
    await page2.getByTestId('restore-choose').click();
    (await chooser).setFiles({ name: backup.suggestedFilename(), mimeType: 'application/vnd.flashydex.backup+zip', buffer: fdx });

    await expect(page2.getByTestId('restore-dialog')).toBeVisible({ timeout: 60_000 });
    await expect(page2.getByTestId('restore-warning')).toHaveText('Replaces all personal data');
    await expect(page2.getByTestId('restore-counts')).toContainText('2 owned copies');
    await expect(page2.getByTestId('restore-catalog')).toContainText('match your installed catalog');
    await expect(page2.getByTestId('restore-confirm')).toBeDisabled();
    await page2.locator('#restore-type').fill('RESTORE');
    await page2.getByTestId('restore-confirm').click();
    await expect(page2.getByTestId('restore-done')).toBeVisible({ timeout: 120_000 });
    await expect(page2.getByTestId('safety-backup-name')).toContainText('.fdx');
    await page2.getByRole('button', { name: 'Done' }).click();

    await page2.goto('/collection');
    const tiles = page2.getByTestId('card-tile').filter({ hasText: 'Charizard V' });
    await expect(tiles).toHaveCount(1, { timeout: 20_000 });
    await expect(tiles.first()).toContainText('×2');
    const after = await readOwnedCopies(page2);
    expect(after).toEqual(before);
    expect(errors2).toEqual([]);
  } finally {
    await fresh.close();
  }
  expect(errors).toEqual([]);
});
