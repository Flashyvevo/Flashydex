import { expect, test, type Page } from '@playwright/test';
import { onboardAndInstall, readOwnedCopies, trackErrors } from './helpers';
import { installFakeCamera, setScene, type Scene } from './scanner-live-helpers';
import { CHARIZARD_V, FURRET, VIEWPORTS, assertNoOverflow, assertTapTargets, makeJpeg, mockCardArt, mockHealth, mockIdentify, recognition, rect, submitPhoto } from './scanner-helpers';

test.describe.configure({ timeout: 300_000 });

const measure = (label: string, value: unknown) => console.log(`MEASURE ${label} ${JSON.stringify(value)}`);
const benign = (e: string) => /Failed to load resource|ERR_|net::/.test(e);

async function setup(page: Page, scene: Scene = 'good', url = '/scan?camera=live') {
  const errors = trackErrors(page);
  await installFakeCamera(page, scene);
  await mockCardArt(page);
  await mockHealth(page, true);
  const identify = await mockIdentify(page);
  const starts: number[] = [];
  page.on('request', (r) => r.url().endsWith('/api/identify') && starts.push(Date.now()));
  await onboardAndInstall(page);
  await page.goto(url);
  return { errors, identify, starts };
}

const liveReady = async (page: Page) => {
  await expect(page.getByTestId('live-video')).toHaveCSS('opacity', '1', { timeout: 8000 });
  await expect(page.getByTestId('live-skeleton')).toHaveCount(0);
};
const chip = (page: Page) => page.getByTestId('live-chip');
const trackStates = (page: Page) => page.evaluate(() => window.__fdxTracks.map((t) => t.readyState));

for (const vp of VIEWPORTS) {
  test.describe(`scanner live @ ${vp.width}x${vp.height}`, () => {
    test.use({ viewport: vp });

    test('viewfinder layout, quality chips, auto-capture → match → add → Scan Another → viewfinder', async ({ page }) => {
      const { errors, identify } = await setup(page, 'glare');
      await expect(page.getByTestId('live-view')).toBeVisible();
      await expect(page.getByTestId('live-video')).toBeVisible();
      await liveReady(page);
      for (const id of ['live-shutter', 'scan-take', 'scan-choose', 'scan-search', 'scan-browse', 'live-guide']) await expect(page.getByTestId(id)).toBeVisible();
      await expect(page.getByTestId('scan-capture')).toHaveCount(0);

      // Layout: viewfinder ≤ 62 % of the viewport, shutter + links visible without scrolling, no overflow, tap targets ≥ 44.
      const vf = await rect(page, 'live-viewfinder');
      const shutter = await rect(page, 'live-shutter');
      const browse = await rect(page, 'scan-browse');
      measure(`live-layout@${vp.width}`, { viewport: vp, viewfinder: vf, ratio: +(vf.height / vp.height).toFixed(3), shutter, browse });
      expect(vf.height / vp.height).toBeLessThanOrEqual(0.62);
      expect(shutter.width).toBeGreaterThanOrEqual(44);
      expect(shutter.height).toBeGreaterThanOrEqual(44);
      expect(browse.y + browse.height).toBeLessThanOrEqual(vp.height);
      expect(shutter.y + shutter.height).toBeLessThanOrEqual(vp.height);
      await assertNoOverflow(page);
      await assertTapTargets(page);
      const guide = await rect(page, 'live-guide');
      expect(Math.abs(guide.width / guide.height - 63 / 88)).toBeLessThan(0.02);

      // Glare is rejected (never auto-captured); the chip says why.
      await expect(chip(page)).toHaveText('Glare — tilt the card');
      await page.waitForTimeout(1500);
      expect(identify.calls).toBe(0);
      await setScene(page, 'blur');
      await expect(chip(page)).toHaveText('Blurry — hold still');
      await setScene(page, 'dark');
      await expect(chip(page)).toHaveText('Too dark');
      await page.waitForTimeout(800);
      expect(identify.calls).toBe(0);

      // A clean frame is auto-captured after a short streak and submitted as a JPEG.
      identify.reply = { json: recognition('match', [CHARIZARD_V], 0.97), delayMs: 400 };
      await setScene(page, 'good');
      await expect(chip(page)).toHaveText('Hold steady');
      await expect(page.getByTestId('scan-match')).toBeVisible({ timeout: 15_000 });
      expect(identify.calls).toBe(1);
      expect(identify.lastHeaders['authorization']).toBeUndefined();
      expect(identify.lastBody!.length).toBeGreaterThan(1000);
      expect(identify.lastBody!.includes(Buffer.from([0xff, 0xd8, 0xff]))).toBe(true);
      await expect(page.getByTestId('scan-card-name')).toHaveText('Charizard V');
      // The camera is released while the result is on screen.
      await expect.poll(async () => (await trackStates(page)).length > 0 && (await trackStates(page)).every((s) => s === 'ended')).toBe(true);
      await assertNoOverflow(page);
      await assertTapTargets(page);

      // confirm → add → Scan Another returns to the live viewfinder (not the system camera).
      await page.getByTestId('scan-confirm').click();
      await page.getByTestId('add-submit').click();
      await expect(page.getByTestId('scan-added')).toBeVisible({ timeout: 20_000 });
      const opensBefore = await page.evaluate(() => window.__fdxOpens);
      identify.reply = { json: recognition('match', [FURRET], 0.9) };
      await page.getByTestId('scan-another').click();
      await expect(page.getByTestId('live-view')).toBeVisible();
      await liveReady(page);
      expect(await page.evaluate(() => window.__fdxOpens)).toBeGreaterThan(opensBefore);

      // Second card straight through again.
      await expect(page.getByTestId('scan-card-name')).toHaveText('Furret', { timeout: 15_000 });
      expect((await readOwnedCopies(page)).length).toBe(1);
      expect(errors.filter((e) => !benign(e))).toEqual([]);
    });

    test('3 no-match attempts → coach (rate-limited, glare leads); Keep Scanning returns to live', async ({ page }) => {
      const { errors, identify, starts } = await setup(page, 'glare');
      await expect(chip(page)).toHaveText('Glare — tilt the card');
      await page.waitForTimeout(1200); // ≥ 3 rejected glare samples
      identify.reply = { json: recognition('no_match') };
      await setScene(page, 'good');
      // Retry notice while the viewfinder stays live; no no-match screen in between.
      await expect(chip(page)).toHaveText('Didn’t catch it — trying again', { timeout: 15_000 });
      await expect(page.getByTestId('scan-no-match')).toHaveCount(0);
      await expect(page.getByTestId('scan-coach')).toBeVisible({ timeout: 30_000 });
      expect(identify.calls).toBe(3);
      const gaps = starts.slice(1).map((t, i) => t - starts[i]!);
      measure(`retry-gaps@${vp.width}`, { gaps, span: starts[2]! - starts[0]! });
      for (const g of gaps) expect(g).toBeGreaterThanOrEqual(1450);
      expect(starts[2]! - starts[0]!).toBeLessThanOrEqual(10_000);

      await expect(page.getByTestId('scan-heading')).toHaveText('Let’s get a cleaner shot');
      await expect(page.getByTestId('scan-coach')).toHaveAttribute('data-lead', 'glare');
      const tips = await page.getByTestId('scan-coach-tips').locator('li').allTextContents();
      expect(tips).toEqual(['Tilt away from lights or windows to kill glare', 'Place the card on a dark, matte surface', 'Fill the frame, card flat', 'Wipe the sleeve or take it out']);
      for (const id of ['scan-coach-keep', 'scan-coach-take', 'scan-search-manually', 'scan-browse-sets']) await expect(page.getByTestId(id)).toBeVisible();
      await expect(page.getByTestId('scan-coach-keep')).toHaveText('Keep Scanning');
      await assertNoOverflow(page);
      await assertTapTargets(page);
      await expect.poll(async () => (await trackStates(page)).length > 0 && (await trackStates(page)).every((s) => s === 'ended')).toBe(true);
      // Take Photo opens the system camera input.
      const [chooser] = await Promise.all([page.waitForEvent('filechooser'), page.getByTestId('scan-coach-take').click()]);
      await chooser.setFiles([]);

      // Keep Scanning resets the attempt counter and goes back to the live viewfinder.
      identify.reply = { json: recognition('match', [CHARIZARD_V], 0.97) };
      await page.getByTestId('scan-coach-keep').click();
      await expect(page.getByTestId('live-view')).toBeVisible();
      await expect(page.getByTestId('scan-coach')).toHaveCount(0);
      await expect(page.getByTestId('scan-match')).toBeVisible({ timeout: 20_000 });
      expect(errors.filter((e) => !benign(e))).toEqual([]);
    });
  });
}

test.describe('scanner live: edge cases @ 390x844', () => {
  test.use({ viewport: { width: 390, height: 844 } });

  test('dark session → coach leads with lighting', async ({ page }) => {
    const { identify } = await setup(page, 'dark');
    await expect(chip(page)).toHaveText('Too dark');
    await page.waitForTimeout(1200);
    identify.reply = { json: recognition('no_card') };
    await setScene(page, 'good');
    await expect(page.getByTestId('scan-coach')).toBeVisible({ timeout: 30_000 });
    await expect(page.getByTestId('scan-coach')).toHaveAttribute('data-lead', 'light');
    await expect(page.getByTestId('scan-coach-tips').locator('li').first()).toHaveText('Add more light — the card looks too dark');
  });

  test('no dominant problem → coach leads with the dark surface', async ({ page }) => {
    const { identify } = await setup(page, 'good');
    identify.reply = { json: recognition('no_match') };
    await expect(page.getByTestId('scan-coach')).toBeVisible({ timeout: 30_000 });
    await expect(page.getByTestId('scan-coach')).toHaveAttribute('data-lead', 'dark-surface');
    await expect(page.getByTestId('scan-coach-tips').locator('li').first()).toHaveText('Place the card on a dark, matte surface');
  });

  test('manual shutter submits even a poor frame; never twice while in flight', async ({ page }) => {
    const { identify } = await setup(page, 'glare');
    await expect(chip(page)).toHaveText('Glare — tilt the card');
    identify.reply = { json: recognition('candidates', [CHARIZARD_V, FURRET], 0.5), delayMs: 1500 };
    await page.getByTestId('live-shutter').click();
    await expect(chip(page)).toHaveText('Analyzing card…');
    await page.getByTestId('live-shutter').click({ force: true });
    await page.getByTestId('live-shutter').click({ force: true });
    await expect(page.getByTestId('scan-candidates')).toBeVisible({ timeout: 15_000 });
    expect(identify.calls).toBe(1);
  });

  test('network error and 429 are errors, not attempts: error screen, no coach, counter untouched', async ({ page }) => {
    const { identify } = await setup(page, 'good');
    identify.reply = { status: 429, json: { error: { code: 'RATE_LIMITED', message: 'x', retryable: true } }, headers: { 'Retry-After': '7' } };
    await expect(page.getByTestId('scan-failure')).toBeVisible({ timeout: 15_000 });
    await expect(page.getByTestId('scan-failure')).toHaveAttribute('data-failure', 'rate_limited');
    await expect(page.getByTestId('scan-heading')).toHaveText('Slow down a moment');
    await expect(page.getByTestId('scan-coach')).toHaveCount(0);
    identify.reply = { json: recognition('match', [CHARIZARD_V], 0.97) };
    await page.getByTestId('scan-retry').click(); // Try again → back to the viewfinder
    await expect(page.getByTestId('scan-match')).toBeVisible({ timeout: 20_000 });
  });

  for (const scene of ['blank', 'denied', 'missing'] as const) {
    test(`camera ${scene} → silent fallback to the file-input flow`, async ({ page }) => {
      const t0 = Date.now();
      const { errors, identify } = await setup(page, scene);
      await expect(page.getByTestId('scan-capture')).toBeVisible({ timeout: 8000 });
      measure(`fallback-${scene}`, { ms: Date.now() - t0 });
      await expect(page.getByTestId('scan-camera-hint')).toHaveText('Using the camera app');
      await expect(page.getByTestId('live-view')).toHaveCount(0);
      await expect(page.getByTestId('scan-failure')).toHaveCount(0);
      await expect(page.getByTestId('scan-coach')).toHaveCount(0);
      for (const id of ['scan-take', 'scan-choose', 'scan-search', 'scan-browse']) await expect(page.getByTestId(id)).toBeVisible();
      await assertNoOverflow(page);
      await assertTapTargets(page);
      // …and the file flow works end to end.
      identify.reply = { json: recognition('match', [CHARIZARD_V], 0.97) };
      await submitPhoto(page, await makeJpeg(page));
      await expect(page.getByTestId('scan-match')).toBeVisible({ timeout: 15_000 });
      expect(errors.filter((e) => !benign(e))).toEqual([]);
    });
  }

  test('camera lost mid-session → fallback; mid-analysis keeps the result', async ({ page }) => {
    const { identify } = await setup(page, 'glare');
    await liveReady(page);
    // Lost while idle.
    await page.evaluate(() => window.__fdxTracks.at(-1)!.dispatchEvent(new Event('ended')));
    await expect(page.getByTestId('scan-capture')).toBeVisible();
    await expect(page.getByTestId('scan-camera-hint')).toBeVisible();

    // Lost while analyzing (fresh page load, viewfinder up, shutter pressed, then the track ends).
    await page.goto('/scan?camera=live');
    await liveReady(page);
    identify.reply = { json: recognition('match', [CHARIZARD_V], 0.97), delayMs: 2500 };
    await page.getByTestId('live-shutter').click();
    await expect(chip(page)).toHaveText('Analyzing card…');
    await page.evaluate(() => window.__fdxTracks.at(-1)!.dispatchEvent(new Event('ended')));
    await expect(page.getByTestId('scan-match')).toBeVisible({ timeout: 15_000 });
    expect(identify.calls).toBe(1);
  });

  test('page hidden pauses the video and sampling; visible resumes', async ({ page }) => {
    const { identify } = await setup(page, 'glare');
    await liveReady(page);
    const hide = (hidden: boolean) =>
      page.evaluate((h) => {
        Object.defineProperty(document, 'hidden', { configurable: true, get: () => h });
        document.dispatchEvent(new Event('visibilitychange'));
      }, hidden);
    await hide(true);
    await expect.poll(() => page.evaluate(() => document.querySelector('video')!.paused)).toBe(true);
    // No sampling while hidden: a good scene is not captured.
    await setScene(page, 'good');
    await page.waitForTimeout(1800);
    expect(identify.calls).toBe(0);
    identify.reply = { json: recognition('match', [CHARIZARD_V], 0.97) };
    await hide(false);
    await expect.poll(() => page.evaluate(() => document.querySelector('video')?.paused)).toBe(false);
    await expect(page.getByTestId('scan-match')).toBeVisible({ timeout: 15_000 });
  });

  test('leaving the route stops the camera', async ({ page }) => {
    await setup(page, 'glare');
    await liveReady(page);
    await page.getByTestId('scan-browse').click();
    await expect(page).toHaveURL(/\/sets/);
    await expect.poll(async () => (await trackStates(page)).length > 0 && (await trackStates(page)).every((s) => s === 'ended')).toBe(true);
  });

  test('file-input mode: two consecutive no-match photos → coach; Keep Scanning returns to the landing', async ({ page }) => {
    const { identify } = await setup(page, 'good', '/scan?camera=file');
    await expect(page.getByTestId('scan-capture')).toBeVisible();
    await expect(page.getByTestId('scan-camera-hint')).toHaveCount(0);
    expect(await page.evaluate(() => window.__fdxOpens)).toBe(0); // file mode never touches the camera
    const photo = await makeJpeg(page);
    identify.reply = { json: recognition('no_match') };
    await submitPhoto(page, photo);
    await expect(page.getByTestId('scan-no-match')).toBeVisible({ timeout: 15_000 });
    await expect(page.getByTestId('scan-coach')).toHaveCount(0);
    await submitPhoto(page, photo);
    await expect(page.getByTestId('scan-coach')).toBeVisible({ timeout: 15_000 });
    await expect(page.getByTestId('scan-no-match')).toHaveCount(0);
    await assertTapTargets(page);
    await page.getByTestId('scan-coach-keep').click();
    await expect(page.getByTestId('scan-capture')).toBeVisible();
    // Streak reset: the next no-match is the plain screen again.
    await submitPhoto(page, photo);
    await expect(page.getByTestId('scan-no-match')).toBeVisible({ timeout: 15_000 });
  });
});
