import { expect, test, type Page } from '@playwright/test';

/**
 * Real Cache Storage + real IndexedDB + real Web Lock, tiny byte limit, synthetic art (route-mocked https://assets.tcgdex.net/**).
 * Run: FLASHYDEX_E2E_BASE_URL=https://127.0.0.1:3200 npx playwright test e2e/pwa-image-cache.spec.ts --project=mobile
 * The service worker itself needs a production build; see .agent/reports/sonnet-pwa-report.md for the shell-f scenarios.
 */
test.describe.configure({ mode: 'serial' });

async function routeArt(page: Page): Promise<void> {
  await page.route('https://assets.tcgdex.net/**', async (route) => {
    const m = /\/t\/([a-z]+)\/(\d+)\/([^/]+)\/low\.webp$/.exec(new URL(route.request().url()).pathname);
    if (!m) return route.fulfill({ status: 400, body: 'bad' });
    const [, kind, bytes] = m;
    const cors = { 'access-control-allow-origin': '*' };
    const body = Buffer.alloc(Number(bytes), 7);
    if (kind === 'missing') return route.fulfill({ status: 404, headers: { ...cors, 'content-type': 'image/webp' }, body: 'nope' });
    if (kind === 'html') return route.fulfill({ status: 200, headers: { ...cors, 'content-type': 'text/html' }, body: '<html></html>' });
    // Playwright's route.fulfill auto-adds ACAO for cross-origin requests, so a genuinely CORS-less answer cannot be mocked;
    // a CORS failure surfaces to fetch() as a TypeError exactly like an aborted request, which is what we assert here.
    if (kind === 'nocors') return route.abort('failed');
    if (kind === 'slow') await new Promise((r) => setTimeout(r, 30));
    return route.fulfill({ status: 200, headers: { ...cors, 'content-type': 'image/webp' }, body });
  });
}

/** Skip-when-busy with the PRODUCTION slot count: some images are served network-only, every body arrives whole, the cap holds. */
test('skip-when-busy: concurrent images beyond the admission slots are served network-only and the cache never exceeds the cap', async ({ page }) => {
  await routeArt(page);
  await page.goto('/harness.html');
  const limit = 3000;
  const r = (await page.evaluate(
    (opts) => import('/src/platform/pwa/harness.ts').then((m) => m.runBusy(opts)),
    { limit, perEntryMax: 2000, entryBytes: 1000, images: 30 }
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  )) as Record<string, any>;
  expect(r.error).toBeNull();
  expect(r.servedWhole).toBe(true);
  expect(r.statuses).toEqual([200]);
  expect(r.admits).toBeGreaterThanOrEqual(1);
  expect(r.admits).toBeLessThan(r.images); // some were served network-only
  expect(r.waits).toBe(r.admits); // only admitted ones held the worker alive
  expect(r.peak).toBeLessThanOrEqual(limit);
  expect(r.committed).toBeLessThanOrEqual(limit);
  expect(r.keys).toBe(r.rows);
});

test('controlled admission: ledger engine holds the cap, LRU order, bypass rules and reconciliation on real browser stores', async ({ page }) => {
  await routeArt(page);

  await page.goto('/harness.html');
  const limit = 5000;
  const entryBytes = 1000;
  const r = (await page.evaluate(
    (opts) => import('/src/platform/pwa/harness.ts').then((m) => m.run(opts)),
    { limit, perEntryMax: 2000, entryBytes }
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  )) as Record<string, any>;

  expect(r.error).toBeNull();
  // 1. never above the cap on the real stores; ledger and Cache Storage agree
  expect(r.sequential.sum).toBeLessThanOrEqual(limit);
  expect(r.sequential.rows).toBe(r.sequential.expectedMax);
  expect(r.sequential.keys).toBe(r.sequential.rows);
  expect(r.sequential.allCommitted).toBe(true);
  expect(r.sequential.keysMatchRows).toBe(true);
  // 2. LRU honours a cache-hit touch
  expect(r.lru).toEqual({ touchedSurvived: true, nextOldestEvicted: true });
  // 3. 30 concurrent admissions: the shadow check ran on every write and never saw sum > limit
  expect(r.concurrent.sum).toBeLessThanOrEqual(limit);
  expect(r.concurrent.peak).toBeLessThanOrEqual(limit);
  expect(r.concurrent.writes).toBeGreaterThan(60);
  expect(r.concurrent.keys).toBe(r.sequential.expectedMax);
  expect(r.concurrent.allCommitted).toBe(true);
  // 4. 404 / html / oversized pass through uncached; no-CORS fails closed and is never stored
  expect(r.bypass.statuses).toEqual({ missing: '404', html: '200', ok: '200' });
  expect(r.bypass.noCors).toBe('error');
  expect(r.bypass.rowsDelta).toBe(0);
  expect(r.bypass.leaked).toBe(0);
  // 5. restart reconciliation
  expect(r.reconcile).toEqual({ enforced: true, reserved: 0, orphanGone: true, pendingGone: true, victimRowDropped: true, consistent: true, sumMatchesStats: true });
  // 6. shrink evicts before the ack and persists; clear empties both stores
  expect(r.shrink.limit).toBe(entryBytes * 2);
  expect(r.shrink.committed).toBeLessThanOrEqual(entryBytes * 2);
  expect(r.shrink.rowSum).toBe(r.shrink.committed);
  expect(r.shrink.keys).toBeLessThanOrEqual(2);
  expect(r.shrink.persistedLimit).toBe(entryBytes * 2);
  expect(r.clear).toEqual({ entries: 0, committed: 0, keys: 0, rows: 0 });
});
