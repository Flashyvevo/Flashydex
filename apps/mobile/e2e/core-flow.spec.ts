import { expect, test } from '@playwright/test';
import { onboardAndInstall, openConfirmFor, trackErrors } from './helpers';

test.describe.configure({ timeout: 240_000 });

test('onboarding → install → add 2 Charizard V → one ×2 tile → detail → JSON export', async ({ page }) => {
  const errors = trackErrors(page);
  await onboardAndInstall(page);

  await openConfirmFor(page, 'Charizard', 'Charizard V');
  await page.getByTestId('qty-input').fill('2');
  await expect(page.getByTestId('qty-input')).toHaveValue('2');
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
