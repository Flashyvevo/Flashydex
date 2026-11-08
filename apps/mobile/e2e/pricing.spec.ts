import { expect, test, type Page } from '@playwright/test';
import { onboardAndInstall, skipProtectionPrompt, trackErrors } from './helpers';

// Pricing v2 Phase A: EUR-only cards get a derived USD value. Run with FLASHYDEX_E2E_PORT=3215 --project=mobile.
// Frankfurter is route-mocked; nothing here touches the network or the owner's data (fresh Playwright profile).
test.describe.configure({ timeout: 240_000 });

const KEY = 'fdx.fx.EURUSD';
const DAY = 86_400_000;
const isoDate = (offsetDays: number) => new Date(Date.now() + offsetDays * DAY).toISOString().slice(0, 10);

// swsh3-105 Darkrai: Cardmarket avg €2.25 for ('other','cardmarket_holo_unspecified') and NO TCGplayer row for that print → EUR-only.
// swsh3-10 Accelgor normal: TCGplayer market $0.10 → source-priced.
const EUR_ONLY = { language: 'en', catalogCardId: 'swsh3-105', variant: 'other', variantDetail: 'cardmarket_holo_unspecified' };
const NATIVE = { language: 'en', catalogCardId: 'swsh3-10', variant: 'normal' };

async function mockFrankfurter(page: Page, body: { date: string; rate: number } | 'fail'): Promise<void> {
  await page.route('https://api.frankfurter.dev/**', (route) =>
    body === 'fail' ? route.abort('internetdisconnected') : route.fulfill({ status: 200, contentType: 'application/json', body: JSON.stringify({ amount: 1.0, base: 'EUR', date: body.date, rates: { USD: body.rate } }) })
  );
}

async function seedCache(page: Page, rate: string, rateDate: string): Promise<void> {
  await page.context().addInitScript(([key, r, d]) => {
    if (!localStorage.getItem(key as string)) {
      localStorage.setItem(key as string, JSON.stringify({ v: 1, record: { base: 'EUR', quote: 'USD', rate: r, rateDate: d, provider: 'frankfurter', fetchedAt: '2020-01-01T00:00:00.000Z' } }));
    }
  }, [KEY, rate, rateDate]);
}

async function addCopies(page: Page, inputs: object[]): Promise<void> {
  await page.waitForFunction(() => Boolean((window as unknown as { __flashydexTest?: { services?: unknown } }).__flashydexTest?.services));
  await page.evaluate(async (list) => {
    const services = (window as unknown as { __flashydexTest: { services: { collection: { add(i: object): Promise<unknown> } } } }).__flashydexTest.services;
    for (const input of list) await services.collection.add(input);
  }, inputs);
}

test('dashboard shows converted coverage with the FX date; EUR-only value is added in USD', async ({ page }) => {
  const errors = trackErrors(page);
  const date = isoDate(-1);
  await mockFrankfurter(page, { date, rate: 1.1165 });
  await onboardAndInstall(page);
  await page.waitForFunction((k) => Boolean(localStorage.getItem(k)), KEY);
  await addCopies(page, [EUR_ONLY, NATIVE]);
  await page.goto('/');
  await expect(page.getByTestId('fx-coverage')).toHaveText(`1 source-priced · 1 converted (FX ${date}) · 0 unpriced`, { timeout: 30_000 });
  // 251 (225 EUR cents x 1.1165 = 251.2) + 10 native = $2.61
  await expect(page.getByTestId('value-primary')).toHaveText('$2.61');
  await expect(page.getByTestId('fx-stale')).toHaveCount(0);
  expect(errors.filter((e) => !/frankfurter|ERR_INTERNET_DISCONNECTED/i.test(e))).toEqual([]);
});

test('card with an EUR-only print shows both the € quote and the converted $ line', async ({ page }) => {
  const date = isoDate(-1);
  await mockFrankfurter(page, { date, rate: 1.1165 });
  await onboardAndInstall(page);
  await page.waitForFunction((k) => Boolean(localStorage.getItem(k)), KEY);
  await addCopies(page, [EUR_ONLY]);
  await page.goto('/cards/en/swsh3-105?variant=other');
  await expect(page.getByTestId('est-value')).toHaveText('Estimated value $2.51', { timeout: 30_000 });
  await expect(page.getByTestId('est-source')).toHaveText(`Cardmarket €2.25 → $2.51 · ECB rate 1.1165 (${date})`);
  await expect(page.getByTestId('est-source')).not.toContainText('TCGplayer');
});

test('offline / fetch failure keeps the cached rate and shows its date; a rate older than 7 days is badged stale', async ({ page }) => {
  await skipProtectionPrompt(page);
  const cachedDate = isoDate(-3);
  await seedCache(page, '1.2000', cachedDate);
  await mockFrankfurter(page, 'fail');
  await onboardAndInstall(page);
  await addCopies(page, [EUR_ONLY]);
  await page.goto('/');
  await expect(page.getByTestId('fx-coverage')).toHaveText(`0 source-priced · 1 converted (FX ${cachedDate}) · 0 unpriced`, { timeout: 30_000 });
  await expect(page.getByTestId('fx-stale')).toHaveCount(0);
  await page.goto('/cards/en/swsh3-105?variant=other');
  await expect(page.getByTestId('est-source')).toHaveText(`Cardmarket €2.25 → $2.70 · ECB rate 1.2000 (${cachedDate})`, { timeout: 30_000 });

  // Same cache, but make it 10 days old: still used (never silently dropped), flagged stale.
  const oldDate = isoDate(-10);
  await page.evaluate(([k, d]) => {
    const rec = JSON.parse(localStorage.getItem(k as string) as string);
    rec.record.rateDate = d;
    localStorage.setItem(k as string, JSON.stringify(rec));
  }, [KEY, oldDate]);
  await page.goto('/');
  await expect(page.getByTestId('fx-stale')).toHaveText(`FX rate from ${oldDate}`, { timeout: 30_000 });
});

test('no cached rate and no network: EUR-only value is "unavailable", never $0.00', async ({ page }) => {
  await mockFrankfurter(page, 'fail');
  await onboardAndInstall(page);
  await addCopies(page, [EUR_ONLY]);
  await page.goto('/');
  await expect(page.getByTestId('fx-unavailable')).toContainText('only a Cardmarket price — USD value unavailable', { timeout: 30_000 });
  await expect(page.getByTestId('value-primary')).toHaveCount(0);
  await expect(page.getByTestId('value-block')).not.toContainText('$0.00');
  await page.goto('/cards/en/swsh3-105?variant=other');
  await expect(page.getByTestId('est-unavailable')).toContainText('USD value unavailable — no exchange rate yet · Cardmarket avg €2.25', { timeout: 30_000 });
  await expect(page.getByTestId('est-value')).toHaveCount(0);
  await expect(page.locator('main, body').first()).not.toContainText('$0.00');
});
