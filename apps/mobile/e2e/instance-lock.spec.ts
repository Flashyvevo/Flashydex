import { expect, test } from '@playwright/test';
import { onboardAndInstall, openConfirmFor, trackErrors } from './helpers';

test.describe.configure({ timeout: 240_000 });

/**
 * R01: two tabs of one browser profile share IndexedDB. Only one may write. The second must NOT open storage and shows
 * INSTANCE_LOCK; when the first closes, the second takes over and keeps the saved ownership.
 */
test('a second tab is refused (instance-lock); closing the first lets the second take over without losing data; reload keeps working', async ({ context }) => {
  const first = await context.newPage();
  const errors = trackErrors(first);
  await onboardAndInstall(first);
  await openConfirmFor(first, 'Charizard', 'Charizard V');
  await first.getByTestId('add-submit').click();
  await expect(first.getByRole('heading', { name: /Added Charizard V/ })).toBeVisible({ timeout: 20_000 });

  const second = await context.newPage();
  await second.goto('/');
  await expect(second.getByTestId('instance-lock')).toBeVisible({ timeout: 30_000 });
  await expect(second.getByText('FlashyDex is open in another tab')).toBeVisible();
  await expect(second.getByText('Close the other tab, then reload this one.')).toBeVisible();
  await expect(second.getByTestId('instance-lock-reload')).toBeVisible();
  // storage must not have been opened behind the lock screen: no app chrome rendered.
  await expect(second.getByTestId('card-tile')).toHaveCount(0);
  // the tap target is large enough
  const box = await second.getByTestId('instance-lock-reload').boundingBox();
  expect(box!.height).toBeGreaterThanOrEqual(44);
  // reloading while the first tab is alive is still refused
  await second.reload();
  await expect(second.getByTestId('instance-lock')).toBeVisible({ timeout: 30_000 });

  // Close the first tab: the second takes over automatically (blocking lock request -> reload) or via Reload.
  await first.close();
  await expect(second.getByTestId('instance-lock')).toHaveCount(0, { timeout: 30_000 });

  await second.goto('/collection');
  const tiles = second.getByTestId('card-tile').filter({ hasText: 'Charizard V' });
  await expect(tiles).toHaveCount(1, { timeout: 20_000 });
  await expect(tiles.first()).not.toContainText('×'); // still the single saved copy

  // And it can edit: add a second copy, which merges into one ×2 tile.
  await openConfirmFor(second, 'Charizard', 'Charizard V');
  await second.getByTestId('add-submit').click();
  await expect(second.getByRole('heading', { name: /Added Charizard V/ })).toBeVisible({ timeout: 20_000 });
  await second.goto('/collection');
  await expect(second.getByTestId('card-tile').filter({ hasText: 'Charizard V' }).first()).toContainText('×2', { timeout: 20_000 });

  // A reload of the single tab releases and re-takes the lock.
  await second.reload();
  await expect(second.getByTestId('instance-lock')).toHaveCount(0);
  await expect(second.getByTestId('card-tile').filter({ hasText: 'Charizard V' }).first()).toContainText('×2', { timeout: 20_000 });
  expect(errors).toEqual([]);
});
