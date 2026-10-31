import { expect, test, type Page } from '@playwright/test';
import { onboardAndInstall, trackErrors } from './helpers';

test.describe.configure({ mode: 'serial', timeout: 300_000 });

const ROUTES = [
  '/',
  '/collection',
  '/add',
  '/sets',
  '/sets/en/swsh3',
  '/cards/en/swsh3-19',
  '/settings',
  '/settings/catalog',
  '/settings/data',
  '/settings/locations',
  '/settings/about',
  '/settings/privacy',
  '/settings/licenses',
  '/custom-cards/new',
  '/welcome',
  '/welcome/notice',
  '/welcome/languages',
  '/welcome/sets'
];

test('every route renders without console errors or horizontal overflow', async ({ page }: { page: Page }) => {
  const errors = trackErrors(page);
  await onboardAndInstall(page);
  const problems: string[] = [];
  for (const route of ROUTES) {
    errors.length = 0;
    await page.goto(route);
    await expect(page.locator('main, [role="alert"], h1').first()).toBeVisible({ timeout: 30_000 });
    await page.waitForTimeout(400);
    const overflow = await page.evaluate(() => ({ sw: document.documentElement.scrollWidth, iw: window.innerWidth }));
    if (overflow.sw > overflow.iw) problems.push(`${route}: scrollWidth ${overflow.sw} > innerWidth ${overflow.iw}`);
    for (const e of errors) problems.push(`${route}: ${e}`);
  }
  expect(problems).toEqual([]);
});
