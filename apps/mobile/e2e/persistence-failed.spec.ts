import { expect, test } from '@playwright/test';
import { onboardAndInstall, openConfirmFor, trackErrors } from './helpers';

test.describe.configure({ timeout: 240_000 });

/**
 * R02: a REAL IndexedDB put failure (QuotaExceededError thrown by IDBObjectStore.put, which is what jeep-sqlite's saveToStore uses)
 * after COMMIT must latch writes off, show the blocking state, never claim a reload that did not happen, and recover only through
 * a genuine reload that re-reads the persisted bytes.
 */
test('IndexedDB quota failure on save → persistence-failed latch, writes blocked, honest Reload, no doubled copies', async ({ page }) => {
  const errors = trackErrors(page);
  await page.addInitScript(() => {
    const original = IDBObjectStore.prototype.put;
    IDBObjectStore.prototype.put = function (this: IDBObjectStore, ...args: Parameters<IDBObjectStore['put']>) {
      const w = window as unknown as { __failPuts?: number };
      if (w.__failPuts && w.__failPuts > 0) {
        w.__failPuts -= 1; // one failed put = a transient quota error; jeep has already removed the old key by then
        throw new DOMException('quota exceeded (injected)', 'QuotaExceededError');
      }
      return original.apply(this, args);
    };
  });
  await onboardAndInstall(page);

  await openConfirmFor(page, 'Charizard', 'Charizard V');
  await page.evaluate(() => { (window as unknown as { __failPuts?: number }).__failPuts = 1; });
  await page.getByTestId('add-submit').click();

  await expect(page.getByTestId('persistence-failed')).toBeVisible({ timeout: 20_000 });
  // web reopen is unsupported (jeep closeConnection saves first): the only honest recovery is a real reload.
  await expect(page.getByTestId('persistence-reload')).toBeVisible({ timeout: 20_000 });
  await expect(page.getByText(/reloaded your data/i)).toHaveCount(0);

  await page.getByTestId('persistence-reload').click();
  await expect(page.getByTestId('persistence-failed')).toHaveCount(0, { timeout: 30_000 });

  // The failed save was never persisted and the persisted DB survived jeep's remove-then-put: still onboarded, catalog kept, no copy, nothing doubled.
  await page.goto('/collection');
  await expect(page).toHaveURL(/\/collection$/);
  await expect(page.getByTestId('card-tile')).toHaveCount(0);
  await openConfirmFor(page, 'Charizard', 'Charizard V');
  await page.getByTestId('add-submit').click();
  await expect(page.getByRole('heading', { name: /Added Charizard V/ })).toBeVisible({ timeout: 20_000 });
  await page.goto('/collection');
  const tile = page.getByTestId('card-tile').filter({ hasText: 'Charizard V' });
  await expect(tile).toHaveCount(1, { timeout: 20_000 });
  await expect(tile.first()).not.toContainText('×');
  expect(errors.filter((e) => !/quota|persist/i.test(e))).toEqual([]);
});
