import { expect, test, type Page } from '@playwright/test';
import { catalogPoolState, installWorkerDeath, onboardAndInstall, openConfirmFor, trackErrors } from './helpers';

test.describe.configure({ timeout: 240_000 });

/**
 * R02 on the Stage F path. USER writes go through the SQL worker (synchronous=FULL, journal DELETE), so the equivalent of the old jeep
 * "save failed after COMMIT" is the storage worker dying around a write's COMMIT: the in-flight request rejects WORKER_DIED /
 * commitState `unknown` and the driver latches writes. Core latches persistence_failed (D43) when the post-COMMIT durability barrier
 * fails; the app must then block everything, never claim a reload that did not happen, and end up with exactly what is durably on disk
 * (no half-written row, no doubled copies, catalog untouched).
 */

type Flags = { __fdxLatchSeen?: number; __fdxBlockWorkers?: boolean; __fdxKilled?: number; __fdxDieAt?: 'commit' | 'barrier' | null };

/** Records every time the blocking latch overlay appears (in-place recovery can remove it again within a second). */
async function installLatchObserver(page: Page): Promise<void> {
  await page.addInitScript(() => {
    const w = window as unknown as Flags;
    const check = () => { if (document.querySelector('[data-testid="persistence-failed"]')) w.__fdxLatchSeen = (w.__fdxLatchSeen ?? 0) + 1; };
    new MutationObserver(check).observe(document, { childList: true, subtree: true });
  });
}

/** While `window.__fdxBlockWorkers` is true a new storage Worker cannot start, so the in-place reopen (recover()) must fail. */
async function installWorkerBlock(page: Page): Promise<void> {
  await page.addInitScript(() => {
    const w = window as unknown as Flags;
    const Original = window.Worker;
    window.Worker = new Proxy(Original, {
      construct(target, args, newTarget) {
        if (w.__fdxBlockWorkers) throw new DOMException('workers blocked (injected)', 'SecurityError');
        return Reflect.construct(target, args, newTarget) as Worker;
      }
    });
  });
}

async function addCharizardV(page: Page): Promise<void> {
  await openConfirmFor(page, 'Charizard', 'Charizard V');
  await page.getByTestId('add-submit').click();
  await expect(page.getByRole('heading', { name: /Added Charizard V/ })).toBeVisible({ timeout: 20_000 });
}

/** Exactly one Charizard V tile with exactly `copies` copies (the tile shows "×N" only above one), and no other tile. */
async function expectCopies(page: Page, copies: number): Promise<void> {
  await page.goto('/collection');
  await expect(page).toHaveURL(/\/collection$/);
  const tile = page.getByTestId('card-tile').filter({ hasText: 'Charizard V' });
  await expect(tile).toHaveCount(1, { timeout: 20_000 });
  if (copies === 1) await expect(tile.first()).not.toContainText('×');
  else await expect(tile.first()).toContainText(`×${copies}`);
  await expect(page.getByTestId('card-tile')).toHaveCount(1);
}

const killed = (page: Page) => page.evaluate(() => (window as unknown as Flags).__fdxKilled ?? 0);

async function setupWithOneCopy(page: Page) {
  await installLatchObserver(page);
  await installWorkerBlock(page);
  await installWorkerDeath(page);
  await onboardAndInstall(page);
  await addCharizardV(page); // one durably committed copy
  await expectCopies(page, 1);
  const before = await catalogPoolState(page);
  expect(before.activeRefs.en).toMatch(/^\/catalog-en\/g-/);
  return before;
}

async function expectStorageIntact(page: Page, before: Awaited<ReturnType<typeof catalogPoolState>>) {
  const after = await catalogPoolState(page);
  expect(after.activeRefs.en).toBe(before.activeRefs.en);
  expect(after.files).toEqual(before.files);
  expect(after.staging).toEqual([]);
}

test('worker dies after COMMIT, before the durability barrier → persistence-failed latch, in-place recovery re-reads disk, copy count exact', async ({ page }) => {
  const errors = trackErrors(page);
  const before = await setupWithOneCopy(page);

  await openConfirmFor(page, 'Charizard', 'Charizard V');
  await page.evaluate(() => { (window as unknown as Flags).__fdxDieAt = 'barrier'; });
  await page.getByTestId('add-submit').click();
  await expect.poll(() => killed(page), { timeout: 20_000 }).toBe(1);

  // The blocking latch appeared, and the write was never reported as a success.
  await expect.poll(() => page.evaluate(() => (window as unknown as Flags).__fdxLatchSeen ?? 0), { timeout: 20_000 }).toBeGreaterThan(0);
  await expect(page.getByRole('heading', { name: /Added Charizard V/ })).toHaveCount(0);
  // Worker restart is possible here, so the in-place reopen works (fresh worker, nothing replayed) and the latch clears without a reload.
  await expect(page.getByTestId('persistence-failed')).toHaveCount(0, { timeout: 30_000 });
  await expect(page.getByText(/reloaded your data/i)).toHaveCount(0);

  // COMMIT executed under synchronous=FULL before the barrier was lost: that copy is on disk, once. Never doubled, never half-written.
  await expectCopies(page, 2);
  await page.reload();
  await expectCopies(page, 2);
  await expectStorageIntact(page, before);

  // Writes work again, and nothing was replayed.
  await addCharizardV(page);
  await expectCopies(page, 3);
  expect(errors.filter((e) => !/quota|persist|worker|storage|commit/i.test(e))).toEqual([]);
});

test('worker dies after COMMIT and cannot restart → honest Reload only, writes blocked, reload shows the copy count exactly once', async ({ page }) => {
  const errors = trackErrors(page);
  const before = await setupWithOneCopy(page);

  await openConfirmFor(page, 'Charizard', 'Charizard V');
  await page.evaluate(() => {
    const w = window as unknown as Flags;
    w.__fdxBlockWorkers = true; // recover() cannot start a new worker, so only a real reload can recover
    w.__fdxDieAt = 'barrier';
  });
  await page.getByTestId('add-submit').click();

  await expect(page.getByTestId('persistence-failed')).toBeVisible({ timeout: 20_000 });
  await expect(page.getByTestId('persistence-reload')).toBeVisible({ timeout: 20_000 });
  await expect(page.getByText(/reloaded your data/i)).toHaveCount(0);
  await expect(page.getByRole('heading', { name: /Added Charizard V/ })).toHaveCount(0);
  // Still latched a moment later: the overlay does not dismiss itself.
  await page.waitForTimeout(1500);
  await expect(page.getByTestId('persistence-failed')).toBeVisible();

  await page.getByTestId('persistence-reload').click();
  await expect(page.getByTestId('persistence-failed')).toHaveCount(0, { timeout: 30_000 });

  await expectCopies(page, 2); // committed before the barrier was lost; exactly once
  await expectStorageIntact(page, before);
  expect(errors.filter((e) => !/quota|persist|worker|storage|commit|blocked/i.test(e))).toEqual([]);
});

test('worker dies AT the COMMIT (never executed) → no success claimed, nothing durable, reload leaves exactly the earlier copy', async ({ page }) => {
  const before = await setupWithOneCopy(page);

  await openConfirmFor(page, 'Charizard', 'Charizard V');
  await page.evaluate(() => { (window as unknown as Flags).__fdxDieAt = 'commit'; });
  await page.getByTestId('add-submit').click();
  await expect.poll(() => killed(page), { timeout: 20_000 }).toBe(1);
  await expect(page.getByRole('heading', { name: /Added Charizard V/ })).toHaveCount(0);

  await page.reload();
  await expectCopies(page, 1); // the uncommitted transaction is rolled back with the dead worker; the count is not doubled
  await expectStorageIntact(page, before);
});
