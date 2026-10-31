import { expect, test } from '@playwright/test';
import { trackErrors } from './helpers';


test('fresh profile opens the DB and lands on /welcome', async ({ page }) => {
  const errors = trackErrors(page);
  await page.goto('/');
  await expect(page).toHaveURL(/\/welcome$/, { timeout: 30_000 });
  await expect(page.getByRole('heading', { name: 'Your card collection, in your pocket' })).toBeVisible();
  await expect(page.getByTestId('welcome-start')).toBeVisible();
  expect(errors).toEqual([]);
});
