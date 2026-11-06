import { expect, test } from '@playwright/test';
import { onboardAndInstall, trackErrors } from './helpers';

test.describe.configure({ timeout: 180_000 });
test.skip(({ isMobile }) => !isMobile, 'handoff harness is viewport-independent; run once (mobile project)');

type Handoff = { state: { reloads: number }; run(opts?: { workerWaiting?: boolean }): Promise<void> };
type Services = { collection: { createLocation(i: { name: string }): Promise<unknown>; listLocations(i: Record<string, unknown>): Promise<unknown> } };
type Hook = { services: Services; sqlDelayMs?: number };
declare global {
  interface Window { __flashydexTest?: Hook; __fdxHandoffTest?: Handoff }
}

/**
 * S5-04. The REAL handoff (write gate under the drivers, drain, closePath({drain:true}) per open path, worker shutdown) + the REAL
 * update controller against a fake service worker (DEV-only seam in components/pwa-ui.tsx), so no production build is needed.
 */
test('update handoff: an in-flight write completes, new writes are refused, the page reloads exactly once, the data is there afterwards', async ({ page }) => {
  const errors = trackErrors(page);
  await onboardAndInstall(page);
  await page.waitForFunction(() => Boolean(window.__flashydexTest?.services && window.__fdxHandoffTest));

  // Slow every SQL call so the write below is still mid-transaction when the handoff starts.
  await page.evaluate(() => { window.__flashydexTest!.sqlDelayMs = 250; });
  const result = await page.evaluate(async () => {
    const t = window.__flashydexTest!;
    const write = t.services.collection.createLocation({ name: 'Written during handoff' }).then(() => 'ok', (e: { code?: string }) => `err:${e.code}`);
    await new Promise((r) => setTimeout(r, 300)); // inside BEGIN..COMMIT
    const handoff = window.__fdxHandoffTest!.run();
    await new Promise((r) => setTimeout(r, 50));
    const late = await t.services.collection.createLocation({ name: 'Too late' }).then(() => 'ok', (e: { code?: string }) => `err:${e.code}`);
    await handoff;
    return { write: await write, late, reloads: window.__fdxHandoffTest!.state.reloads };
  });
  expect(result.write).toBe('ok'); // the admitted transaction finished
  expect(result.late).toBe('err:MAINTENANCE'); // the gate is real: a service call after the handoff started is refused
  expect(result.reloads).toBe(1);
  await expect(page.getByTestId('update-handoff')).toBeVisible();

  // The "reload" was the stand-in's counter: do the real one and prove the committed write survived.
  await page.reload();
  await page.waitForFunction(() => Boolean(window.__flashydexTest?.services));
  const names = await page.evaluate(async () => JSON.stringify(await window.__flashydexTest!.services.collection.listLocations({})));
  expect(names).toContain('Written during handoff');
  expect(names).not.toContain('Too late');
  expect(errors.filter((e) => !/MAINTENANCE|Maintenance|Failed to load resource/.test(e))).toEqual([]);
});

test('update handoff: no waiting worker leaves an explicit Reload instead of a stuck overlay; reload restores a working app', async ({ page }) => {
  await onboardAndInstall(page);
  await page.waitForFunction(() => Boolean(window.__fdxHandoffTest));
  await page.evaluate(() => window.__fdxHandoffTest!.run({ workerWaiting: false }));
  // The shell is mounted only inside the app routes; the overlay lives in UpdateToast (mounted at the root).
  await expect(page.getByTestId('update-handoff-failed')).toBeVisible();
  await expect(page.getByTestId('update-handoff-reload')).toBeVisible();
  expect(await page.evaluate(() => window.__fdxHandoffTest!.state.reloads)).toBe(0);
  await page.getByTestId('update-handoff-reload').click();
  await page.waitForFunction(() => Boolean(window.__flashydexTest?.services));
  await expect(page.getByTestId('update-handoff')).toHaveCount(0);
});

test('update handoff: a running catalog install refuses the restart and offers "Restart later" (never waits forever)', async ({ page }) => {
  await onboardAndInstall(page);
  await page.waitForFunction(() => Boolean(window.__fdxHandoffTest));
  // Hold the install flag the way the UI does: run a second install through the hook is racy, so use the long-job registry seam instead.
  await page.evaluate(() => {
    const w = window as unknown as { __fdxHandoffTest: Handoff & { setBusy?: (m: string | null) => void } };
    w.__fdxHandoffTest.setBusy?.('A catalog download is running.');
  });
  await page.evaluate(() => window.__fdxHandoffTest!.run());
  await expect(page.getByTestId('update-handoff-message')).toContainText('download is running');
  await expect(page.getByTestId('update-handoff-later')).toBeVisible();
  await page.getByTestId('update-handoff-later').click();
  await expect(page.getByTestId('update-handoff')).toHaveCount(0);
  // The app is still writable.
  await page.evaluate(() => window.__flashydexTest!.services.collection.createLocation({ name: 'Still works' }));
});

/**
 * S6-06: the writer lock is released ONLY after the handoff closed every handle and stopped the worker, so a blocked second tab of the
 * same context takes it over WITHOUT stealing (A never closes). Real Web Locks, real worker, fake service worker.
 */
for (const [label, opts, expectFailureCard] of [
  ['successful handoff', undefined, false],
  ['activation failure (no waiting worker)', { workerWaiting: false }, true]
] as const) {
  test(`writer lock release: ${label} -> the blocked tab B becomes the writer while A stays open, A is never a writer again`, async ({ context }) => {
    const a = await context.newPage();
    await onboardAndInstall(a);
    await a.waitForFunction(() => Boolean(window.__flashydexTest?.services && window.__fdxHandoffTest));

    const b = await context.newPage();
    await b.goto('/');
    await expect(b.getByTestId('instance-lock')).toBeVisible({ timeout: 30_000 }); // A holds the lock; B is blocked behind it
    const heldBefore = await a.evaluate(async () => (await navigator.locks.query()).held?.some((l) => l.name === 'flashydex-user-writer') ?? false);
    expect(heldBefore).toBe(true);

    await a.evaluate((o) => window.__fdxHandoffTest!.run(o), opts);
    if (expectFailureCard) {
      await expect(a.getByTestId('update-handoff-failed')).toBeVisible();
      await expect(a.getByTestId('update-handoff-reload')).toBeVisible(); // Reload offered
    }
    // B was granted the lock (no steal: A never closed, A's lock request callback settled) and reloaded into the real app.
    await expect(b.getByTestId('instance-lock')).toHaveCount(0, { timeout: 30_000 });
    // The lock screen disappears while B reloads: write through B once its fresh document has the services (retry across the navigation).
    await expect.poll(async () => b.evaluate(() => window.__flashydexTest!.services.collection.createLocation({ name: `B writes after ${Date.now()}` }).then(() => 'ok', (e: { code?: string }) => `err:${e.code}`)).catch(() => 'navigating'), { timeout: 45_000, intervals: [250, 500, 1000] }).toBe('ok');
    expect(a.isClosed()).toBe(false);
    // A's storage is closed for good: a write from the old page is refused.
    const lateWrite = await a.evaluate(() => window.__flashydexTest!.services.collection.createLocation({ name: 'A after release' }).then(() => 'ok', (e: { code?: string }) => `err:${e.code}`));
    expect(lateWrite).not.toBe('ok');
  });
}
