import { expect, test, type Page } from '@playwright/test';
import { onboardAndInstall, trackErrors } from './helpers';

test.describe.configure({ timeout: 300_000 });

// 1×1 PNG: lets the cover-card <img> load deterministically without network access.
const PIXEL = Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==', 'base64');
const TCGDEX_ASSETS = '**/assets.tcgdex.net/**';
const isLogoOrSymbol = (url: string) => /\/(logo|symbol)(\.\w+)?$/.test(new URL(url).pathname);

type Mode = 'live' | 'no-logo' | 'all-fail';

/** Control what the browser gets for TCGdex assets: `no-logo` 404s logos/symbols and stubs card art; `all-fail` 404s everything. */
async function mockAssets(page: Page, mode: Mode): Promise<void> {
  await page.unroute(TCGDEX_ASSETS).catch(() => undefined);
  if (mode === 'live') return;
  await page.route(TCGDEX_ASSETS, async (route) => {
    const url = route.request().url();
    if (mode === 'all-fail' || isLogoOrSymbol(url)) return route.fulfill({ status: 404, contentType: 'text/plain', body: 'nope' });
    return route.fulfill({ status: 200, contentType: 'image/png', body: PIXEL });
  });
}

async function tiles(page: Page) {
  return page.getByTestId('set-art').evaluateAll((els) =>
    els.map((el) => {
      const r = el.getBoundingClientRect();
      return { tier: el.getAttribute('data-tier'), w: Math.round(r.width), h: Math.round(r.height), imgs: el.querySelectorAll('img').length, broken: [...el.querySelectorAll('img')].filter((i) => i.complete && i.naturalWidth === 0).length };
    })
  );
}

const overflow = (page: Page) => page.evaluate(() => document.documentElement.scrollWidth - window.innerWidth);

test('set tiles: logo -> cover card -> id chip, fixed boxes, no overflow at 375/390/430', async ({ page }) => {
  const errors = trackErrors(page);
  await onboardAndInstall(page);

  await test.step('real logo: tcgdex <img> in a 56x32 tile', async () => {
    await page.goto('/sets?show=all');
    const row = page.getByTestId('set-row').filter({ hasText: 'Darkness Ablaze' });
    await expect(row).toBeVisible({ timeout: 30_000 });
    const art = row.getByTestId('set-art');
    await expect(art).toHaveAttribute('data-tier', 'logo');
    const src = await art.locator('img').getAttribute('src');
    expect(src).toMatch(/assets\.tcgdex\.net\/.*swsh3.*logo\.webp$/);
    const box = await art.boundingBox();
    expect([Math.round(box!.width), Math.round(box!.height)]).toEqual([56, 32]);
  });

  await test.step('logo 404s: the cover card (low.webp) takes over in the same box', async () => {
    await mockAssets(page, 'no-logo');
    await page.goto('/sets?show=all');
    const art = page.getByTestId('set-row').filter({ hasText: 'Darkness Ablaze' }).getByTestId('set-art');
    await expect(art).toHaveAttribute('data-tier', 'cover', { timeout: 30_000 });
    const img = art.locator('img');
    await expect(img).toHaveAttribute('src', /assets\.tcgdex\.net\/.*swsh3\/.*\/low\.webp$/);
    expect(await img.evaluate((i: HTMLImageElement) => [i.complete, i.naturalWidth > 0, getComputedStyle(i).objectFit])).toEqual([true, true, 'cover']);
    const box = await art.boundingBox();
    expect([Math.round(box!.width), Math.round(box!.height)]).toEqual([56, 32]);
    expect((await tiles(page)).every((t) => t.broken === 0)).toBe(true);
  });

  await test.step('set page header uses the same precedence in a 240x80 box', async () => {
    await page.goto('/sets/en/swsh3');
    const art = page.getByTestId('set-art').first();
    await expect(art).toHaveAttribute('data-tier', 'cover', { timeout: 30_000 });
    const box = await art.boundingBox();
    expect([Math.round(box!.width), Math.round(box!.height)]).toEqual([240, 80]);
  });

  await test.step('cover card also fails: id chip, never a broken image', async () => {
    await mockAssets(page, 'all-fail');
    await page.goto('/sets?show=all');
    const art = page.getByTestId('set-row').filter({ hasText: 'Darkness Ablaze' }).getByTestId('set-art');
    await expect(art).toHaveAttribute('data-tier', 'chip', { timeout: 30_000 });
    await expect(art).toHaveText('swsh3');
    expect(await art.locator('img').count()).toBe(0);
  });

  await test.step('every tile resolves out of the loading state', async () => {
    await mockAssets(page, 'no-logo');
    await page.goto('/sets?show=all');
    await expect(page.getByTestId('set-art').first()).toHaveAttribute('data-tier', 'cover', { timeout: 30_000 });
    const states = await tiles(page);
    expect(states.length).toBeGreaterThan(0);
    expect(states.filter((t) => t.tier === 'loading')).toEqual([]);
  });

  for (const width of [375, 390, 430]) {
    await test.step(`measure ${width}px: no horizontal overflow, fixed tile boxes`, async () => {
      await page.setViewportSize({ width, height: 844 });
      for (const [route, expected] of [['/sets?show=all', [56, 32]], ['/sets/en/swsh3', [240, 80]], ['/welcome/sets', [56, 32]]] as const) {
        await page.goto(route);
        if (route === '/welcome/sets') await page.getByRole('radio', { name: 'Only sets I pick' }).click();
        await expect(page.getByTestId('set-art').first()).toBeVisible({ timeout: 30_000 });
        await expect(page.getByTestId('set-art').first()).not.toHaveAttribute('data-tier', 'loading', { timeout: 30_000 });
        await page.waitForTimeout(300);
        expect(await overflow(page), `${route} @${width}`).toBeLessThanOrEqual(0);
        for (const t of await tiles(page)) expect([t.w, t.h], `${route} @${width} tile`).toEqual(expected);
      }
    });
  }

  expect(errors.filter((e) => !/Failed to load resource|404/.test(e))).toEqual([]);
});
