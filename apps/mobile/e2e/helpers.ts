import { expect, type Page } from '@playwright/test';

/** Console errors + uncaught exceptions seen on a page (benign Vite/React-DevTools noise excluded). */
export function trackErrors(page: Page): string[] {
  const errors: string[] = [];
  page.on('pageerror', (error) => errors.push(`pageerror: ${error.message}`));
  page.on('console', (message) => {
    if (message.type() !== 'error') return;
    const text = message.text();
    errors.push(`console.error: ${text.slice(0, 300)}`);
  });
  return errors;
}

/** Fresh profile → /welcome → notice → languages (English) → sets → "Start download" → waits for the dev pack to finish. */
export async function onboardAndInstall(page: Page): Promise<void> {
  await page.goto('/');
  await expect(page).toHaveURL(/\/welcome$/, { timeout: 30_000 });
  await page.getByTestId('welcome-start').click();
  await expect(page).toHaveURL(/\/welcome\/notice$/);
  await page.getByTestId('notice-continue').click();
  await expect(page).toHaveURL(/\/welcome\/languages$/);
  await page.getByTestId('languages-continue').click();
  await expect(page).toHaveURL(/\/welcome\/sets$/);
  await page.getByTestId('onboarding-finish').click();
  await expect(page.getByText('English catalog ready').first()).toBeVisible({ timeout: 120_000 });
}

/** Search the catalog on /add and open the confirm sheet for the first result whose name matches. */
export async function openConfirmFor(page: Page, query: string, name: string): Promise<void> {
  await page.goto('/add');
  await page.getByRole('searchbox').or(page.getByPlaceholder('Search name, number or id')).first().fill(query);
  const row = page.getByTestId('result-row').filter({ hasText: name }).first();
  await expect(row).toBeVisible({ timeout: 30_000 });
  await row.click();
  await expect(page.getByTestId('confirm-sheet')).toBeVisible();
}
