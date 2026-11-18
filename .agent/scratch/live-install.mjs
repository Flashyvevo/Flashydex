// Live PRODUCTION install probe: https://flashydex.netlify.app + packs site. No interception.
import { chromium } from 'playwright';
import { mkdtempSync } from 'node:fs';
import { join } from 'node:path';
const APP = process.env.APP_ORIGIN || 'https://flashydex.netlify.app';
const ctx = await chromium.launchPersistentContext(mkdtempSync(join(process.env.LOCALAPPDATA, 'Temp', 'fdx-live-')), { headless: true, viewport: { width: 420, height: 860 } });
const page = ctx.pages()[0] ?? (await ctx.newPage());
const packReqs = [], errors = [];
page.on('response', (r) => { if (r.url().includes('flashydex-catalog-packs') && !/manifest|set-index/.test(r.url())) packReqs.push(`${r.status()} ${r.url().split('/').pop()}`); });
page.on('requestfailed', (r) => errors.push(r.failure()?.errorText + ' ' + r.url().slice(0, 120)));
page.on('pageerror', (e) => errors.push('pageerror ' + String(e).slice(0, 200)));
const body = async () => (await page.locator('body').innerText()).replace(/\s+/g, ' ');
try {
  await page.goto(APP + '/', { waitUntil: 'networkidle', timeout: 90_000 });
  await page.waitForURL(/\/welcome$/, { timeout: 30_000 });
  await page.getByTestId('welcome-start').click(); await page.getByTestId('notice-continue').click(); await page.getByTestId('languages-continue').click();
  await page.waitForURL(/\/welcome\/sets$/);
  const t0 = Date.now();
  await page.getByTestId('onboarding-finish').click();
  await page.waitForFunction(() => /English catalog ready|couldn’t|damaged|Not enough|interrupted/i.test(document.body.innerText), null, { timeout: 600_000 });
  console.log('install:', Math.round((Date.now() - t0) / 1000), 's;', (await body()).match(/English catalog ready|couldn’t[^.]*|damaged[^.]*/)?.[0]);
  await page.goto(APP + '/add', { waitUntil: 'networkidle' });
  await page.getByRole('searchbox').or(page.getByPlaceholder('Search name or number')).first().fill('Umbreon');
  await page.getByTestId('result-row').filter({ hasText: 'Umbreon' }).first().waitFor({ state: 'visible', timeout: 30_000 });
  console.log('Umbreon rows:', await page.getByTestId('result-row').count());
  await page.reload({ waitUntil: 'networkidle' });
  await page.goto(APP + '/settings/catalog', { waitUntil: 'networkidle' });
  console.log('EN row:', (await page.getByTestId('catalog-language-en').innerText()).replace(/\s+/g, ' '));
  console.log('packs:', packReqs, '| console errors:', errors.slice(0,4));
  console.log('LIVE_INSTALL_OK');
} catch (e) { console.log('FAILED', String(e).slice(0, 300)); console.log('BODY', (await body()).slice(0, 500)); console.log('packs:', packReqs, errors); }
finally { await ctx.close(); }
