import { expect, test } from '@playwright/test';
import { downloadBuffer, onboardAndInstall, openConfirmFor, readOwnedCopies, trackErrors } from './helpers';

test.describe.configure({ timeout: 300_000 });
test.skip(({ isMobile }) => !isMobile, 'restore harness is viewport-independent; run once (mobile project)');

type Hook = { services: { collection: { createLocation(i: { name: string }): Promise<unknown>; listLocations(i: Record<string, unknown>): Promise<unknown> } }; sqlDelayMs?: number };
declare global {
  interface Window { __flashydexTest?: Hook }
}

/**
 * N03 / E1: while a restore replaces personal data the UI shows a blocking overlay, a write from a second code path is refused
 * with MAINTENANCE and changes nothing, and the final data is exactly the archive. The restore is slowed with the DEV-only
 * `window.__flashydexTest.sqlDelayMs` seam so it can be observed.
 */
test('restore: blocking overlay, concurrent write refused with MAINTENANCE, final data equals the archive', async ({ page }) => {
  const errors = trackErrors(page);
  await onboardAndInstall(page);
  await openConfirmFor(page, 'Charizard', 'Charizard V');
  await page.getByTestId('qty-input').fill('2');
  await page.getByRole('button', { name: 'More details' }).click();
  await page.locator('#pnotes').fill('binder page 3');
  await page.getByTestId('add-submit').click();
  await expect(page.getByRole('heading', { name: /Added Charizard V/ })).toBeVisible({ timeout: 20_000 });
  const archived = await readOwnedCopies(page);
  expect(archived).toHaveLength(2);

  await page.goto('/settings/data');
  await expect(page.getByTestId('backup-create')).toBeEnabled({ timeout: 20_000 });
  const [backup] = await Promise.all([page.waitForEvent('download', { timeout: 60_000 }), page.getByTestId('backup-create').click()]);
  const fdx = await downloadBuffer(backup);

  // Diverge from the archive: this write must NOT survive the restore.
  await page.evaluate(() => window.__flashydexTest!.services.collection.createLocation({ name: 'After backup' }));

  await page.getByTestId('restore-file').click();
  const chooser = page.waitForEvent('filechooser');
  await page.getByTestId('restore-choose').click();
  (await chooser).setFiles({ name: backup.suggestedFilename(), mimeType: 'application/vnd.flashydex.backup+zip', buffer: fdx });
  await expect(page.getByTestId('restore-dialog')).toBeVisible({ timeout: 60_000 });
  await page.locator('#restore-type').fill('RESTORE');

  await page.evaluate(() => { window.__flashydexTest!.sqlDelayMs = 400; });
  await page.getByTestId('restore-confirm').click();

  const overlay = page.getByTestId('maintenance-overlay');
  await expect(overlay).toBeVisible({ timeout: 20_000 });
  await expect(overlay).toHaveAttribute('role', 'alertdialog');
  await expect(overlay).toContainText('Restoring your backup…');
  await expect(overlay).toContainText('Don’t close FlashyDex. This takes a moment.');
  // Everything underneath is unreachable.
  expect(await page.evaluate(() => document.getElementById('root')?.hasAttribute('inert'))).toBe(true);

  // A write from a second code path while the gate is closed is refused and changes nothing.
  const refused = await page.evaluate(async () => {
    try {
      await window.__flashydexTest!.services.collection.createLocation({ name: 'During restore' });
      return 'accepted';
    } catch (e) {
      return (e as { code?: string }).code ?? 'untyped';
    }
  });
  expect(refused).toBe('MAINTENANCE');

  await page.evaluate(() => { window.__flashydexTest!.sqlDelayMs = 0; });
  await expect(overlay).toBeHidden({ timeout: 120_000 });
  await expect(page.getByTestId('restore-done')).toBeVisible({ timeout: 30_000 });
  await page.getByRole('button', { name: 'Done' }).click();

  const locations = JSON.stringify(await page.evaluate(() => window.__flashydexTest!.services.collection.listLocations({})));
  expect(locations).not.toContain('During restore');
  expect(locations).not.toContain('After backup');
  expect(await readOwnedCopies(page)).toEqual(archived);
  // The expected MAINTENANCE refusal is the only console error allowed.
  expect(errors.filter((e) => !/MAINTENANCE/.test(e))).toEqual([]);
});
