import { expect, test } from '@playwright/test';

/**
 * REAL service worker smoke. Needs a PRODUCTION build served over http(s) on a secure origin (127.0.0.1 counts):
 *   npm run build --workspace=@flashydex/mobile   (or `vite build`), then serve dist/ (e.g. `vite preview --port 4173`)
 *   FLASHYDEX_SW_URL=http://127.0.0.1:4173 npx playwright test e2e/pwa-sw-smoke.spec.ts --project=mobile
 * Skipped when FLASHYDEX_SW_URL is unset (the dev server has no SW). The playwright baseURL is overridden per test.
 */
const SW_URL = process.env.FLASHYDEX_SW_URL;
test.skip(!SW_URL, 'set FLASHYDEX_SW_URL to a production build origin');
test.use({ baseURL: SW_URL });

const IMG = 'https://assets.tcgdex.net/en/base/base1/1/low.webp';
// A real decodable 1x1 image (served as image/webp: the browser sniffs content), so <img> onload fires.
const PIXEL = Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==', 'base64');

test('production SW: precache, offline shell, network-only packs, no HTML for code, bounded image cache', async ({ page, context }) => {
  await context.route('https://assets.tcgdex.net/**', (route) =>
    route.fulfill({ status: 200, headers: { 'content-type': 'image/webp', 'access-control-allow-origin': '*' }, body: PIXEL })
  );
  await page.goto('/');
  await page.evaluate(() => navigator.serviceWorker.ready.then(() => undefined));
  await expect.poll(() => page.evaluate(() => Boolean(navigator.serviceWorker.controller)), { timeout: 20_000 }).toBe(true);

  // precache: complete shell + wasm, nothing catalog-sized
  const precache = await page.evaluate(async () => {
    const names = (await caches.keys()).filter((n) => n.startsWith('flashydex-precache-'));
    const urls = (await Promise.all(names.map(async (n) => (await (await caches.open(n)).keys()).map((r) => new URL(r.url).pathname)))).flat();
    return { names, urls };
  });
  expect(precache.names).toHaveLength(1);
  expect(precache.urls).toContain('/index.html');
  expect(precache.urls.some((u) => u.endsWith('.wasm'))).toBe(true);
  expect(precache.urls.some((u) => /dev-packs|\.zst$|\.db$|catalog-manifest/.test(u))).toBe(false);

  // card art: viewed image is admitted by the SW ledger, then served offline
  await page.evaluate((src) => new Promise<void>((res, rej) => Object.assign(new Image(), { onload: () => res(), onerror: () => rej(new Error('img')), src })), IMG);
  const askStats = () =>
    page.evaluate(
      () =>
        new Promise<Record<string, unknown>>((resolve) => {
          const ch = new MessageChannel();
          ch.port1.onmessage = (e) => resolve(e.data.stats);
          navigator.serviceWorker.controller!.postMessage({ type: 'fdx:image-cache:stats', v: 1, id: 'smoke' }, [ch.port2]);
        })
    );
  await expect.poll(async () => (await askStats()).committedBytes, { timeout: 10_000 }).toBe(PIXEL.length);
  expect(await askStats()).toMatchObject({ enforced: true, entries: 1, reservedBytes: 0, limitBytes: 200_000_000 });

  await context.setOffline(true);
  await context.unroute('https://assets.tcgdex.net/**');
  await page.evaluate((src) => new Promise<void>((res, rej) => Object.assign(new Image(), { onload: () => res(), onerror: () => rej(new Error('offline image miss')), src })), IMG);

  // offline deep link -> shell (not the offline page, not a browser error)
  const nav = await page.goto('/settings/data');
  expect(nav?.status()).toBe(200);
  await expect(page.locator('#root')).toBeAttached();
  expect(await page.content()).not.toContain('needs one online visit');

  // pack/manifest: network only, so offline they fail; they are never served from a cache; code misses never get HTML
  const probes = await page.evaluate(async () => {
    const out: Record<string, string> = {};
    for (const p of ['/catalog-manifest.json', '/dev-packs/catalog-manifest.json', '/assets/definitely-missing.wasm', '/assets/definitely-missing.js']) {
      try {
        const r = await fetch(p, { cache: 'no-store' });
        out[p] = `${r.status} ${r.headers.get('content-type') ?? ''}`;
      } catch {
        out[p] = 'network-error';
      }
    }
    return out;
  });
  expect(probes['/catalog-manifest.json']).toBe('network-error');
  expect(probes['/dev-packs/catalog-manifest.json']).toBe('network-error');
  expect(probes['/assets/definitely-missing.wasm']).toBe('network-error'); // offline: asset-network has no fallback
  expect(probes['/assets/definitely-missing.js']).toBe('network-error');
  await context.setOffline(false);

  // online: a missing wasm/js is never answered with index.html
  const online = await page.evaluate(async () => {
    const r = await fetch('/assets/definitely-missing-online.wasm');
    return { status: r.status, type: r.headers.get('content-type') ?? '' };
  });
  expect(online.type).not.toContain('text/html');

  // nothing but our own namespaces
  const allCaches = await page.evaluate(() => caches.keys());
  for (const n of allCaches) expect(n.startsWith('flashydex-precache-') || n === 'flashydex-images-v1').toBe(true);
  const packsCached = await page.evaluate(async () => {
    for (const n of await caches.keys()) for (const r of await (await caches.open(n)).keys()) if (/catalog-manifest|\.zst|\.db$|dev-packs/.test(r.url)) return r.url;
    return null;
  });
  expect(packsCached).toBeNull();
});
