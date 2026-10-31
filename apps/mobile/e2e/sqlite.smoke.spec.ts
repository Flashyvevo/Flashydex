import { expect, test } from '@playwright/test';

test.use({ viewport: { width: 390, height: 844 } });

test('opens FlashyDex with a working web SQLite driver', async ({ page }) => {
  await page.goto('/');
  await expect(page.getByRole('heading', { name: 'FlashyDex' })).toBeVisible();
  await expect(page.getByText(/SQLite \d+\.\d+\.\d+/)).toBeVisible({ timeout: 15_000 });
});
