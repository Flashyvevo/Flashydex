import { expect, test, type Page } from '@playwright/test';
import { onboardAndInstall, readOwnedCopies, trackErrors } from './helpers';
import { CHARIZARD_V, FURRET, VIEWPORTS, VMAX, assertNoOverflow, assertTapTargets, errorJson, makeJpeg, mockCardArt, mockHealth, mockIdentify, recognition, rect, submitPhoto } from './scanner-helpers';

test.describe.configure({ timeout: 300_000 });

const measure = (label: string, value: unknown) => console.log(`MEASURE ${label} ${JSON.stringify(value)}`);

async function setup(page: Page) {
  const errors = trackErrors(page);
  await mockCardArt(page);
  await mockHealth(page, true);
  const identify = await mockIdentify(page);
  await onboardAndInstall(page);
  await page.goto('/scan');
  await expect(page.getByTestId('scan-capture')).toBeVisible();
  return { errors, identify };
}

const ERRORS = [
  { code: 'PAYLOAD_TOO_LARGE', status: 413, kind: 'too_large', title: 'Photo too large', retry: false },
  { code: 'UNSUPPORTED_IMAGE', status: 415, kind: 'unsupported_image', title: 'Photo couldn’t be read', retry: false },
  { code: 'RECOGNIZER_BUSY', status: 503, kind: 'busy', title: 'Scanner is busy', retry: true, body: 'The scanner is busy — try again in a moment.' },
  { code: 'RATE_LIMITED', status: 429, kind: 'rate_limited', title: 'Slow down a moment', retry: true },
  { code: 'RECOGNIZER_OFFLINE', status: 502, kind: 'offline', title: 'Scanner offline', retry: true },
  { code: 'RECOGNIZER_TIMEOUT', status: 504, kind: 'timeout', title: 'That took too long', retry: true },
  { code: 'UNAUTHORIZED', status: 401, kind: 'offline', title: 'Scanner offline', retry: true }
] as const;

for (const vp of VIEWPORTS) {
  test.describe(`scanner mocked @ ${vp.width}x${vp.height}`, () => {
    test.use({ viewport: vp });

    test('landing, every result state, every error code, offline banner, catalog branches', async ({ page }) => {
      const { errors, identify } = await setup(page);
      const photo = await makeJpeg(page);

      // ── Landing ──────────────────────────────────────────────────────────────
      await expect(page.getByRole('heading', { name: 'Scan a card', level: 1 })).toBeVisible();
      for (const id of ['scan-take', 'scan-choose', 'scan-search', 'scan-browse']) await expect(page.getByTestId(id)).toBeVisible();
      await expect(page.getByTestId('scan-offline-banner')).toHaveCount(0);
      const takeInput = page.getByTestId('scan-take-input');
      const chooseInput = page.getByTestId('scan-choose-input');
      await expect(takeInput).toHaveAttribute('capture', 'environment');
      await expect(takeInput).toHaveAttribute('accept', 'image/jpeg,image/png,image/webp');
      await expect(chooseInput).toHaveAttribute('accept', 'image/jpeg,image/png,image/webp');
      expect(await chooseInput.getAttribute('capture')).toBeNull();
      await assertNoOverflow(page);
      await assertTapTargets(page);
      measure(`landing@${vp.width}`, { height: await page.evaluate(() => document.documentElement.scrollHeight), take: await rect(page, 'scan-take') });
      // No tab bar on the modal route.
      await expect(page.getByTestId('tab-bar')).toHaveCount(0);

      // ── match ────────────────────────────────────────────────────────────────
      identify.reply = { json: recognition('match', [{ ...CHARIZARD_V, variantHints: { reverseHolo: 0.9 } }, FURRET], 0.97), delayMs: 600 };
      await submitPhoto(page, photo);
      await expect(page.getByTestId('scan-analyzing')).toBeVisible();
      await expect(page.getByTestId('scan-cancel')).toBeVisible();
      await expect(page.getByText('Analyzing card…').first()).toBeVisible();
      await expect(page.getByTestId('scan-match')).toBeVisible({ timeout: 15_000 });
      await expect(page.getByTestId('scan-card-name')).toHaveText('Charizard V');
      await expect(page.getByText('Darkness Ablaze').first()).toBeVisible();
      await expect(page.getByTestId('scan-card-number')).toHaveText(/19\/189/);
      await expect(page.getByTestId('scan-confirm')).toBeVisible();
      // Request shape: multipart image, no Authorization header, relative URL.
      expect(identify.lastHeaders['authorization']).toBeUndefined();
      expect(identify.lastHeaders['content-type']).toContain('multipart/form-data');
      expect(identify.lastBody!.length).toBeGreaterThan(1000);
      await assertNoOverflow(page);
      await assertTapTargets(page);
      const art = await rect(page, 'card-art');
      measure(`match-art@${vp.width}`, art);
      expect(art.width).toBeGreaterThan(150);
      // Confirm opens the existing sheet; cancelling adds nothing.
      await page.getByTestId('scan-confirm').click();
      await expect(page.getByTestId('confirm-sheet')).toBeVisible();
      await page.getByTestId('sheet-cancel').tap(); // touch Cancel must close the sheet (regression: header pointer capture swallowed the click)
      await expect(page.getByTestId('confirm-sheet')).toHaveCount(0);
      // Mouse-style click and Escape close it too.
      await page.getByTestId('scan-confirm').click();
      await expect(page.getByTestId('confirm-sheet')).toBeVisible();
      await page.getByTestId('sheet-cancel').click();
      await expect(page.getByTestId('confirm-sheet')).toHaveCount(0);
      await page.getByTestId('scan-confirm').click();
      await expect(page.getByTestId('confirm-sheet')).toBeVisible();
      await page.keyboard.press('Escape');
      await expect(page.getByTestId('confirm-sheet')).toHaveCount(0);
      // "Wrong card" → the other candidates.
      await page.getByTestId('scan-wrong').click();
      await expect(page.getByTestId('scan-candidates')).toBeVisible();
      await expect(page.getByTestId('scan-candidate-0')).toContainText('Furret');

      // ── candidates ───────────────────────────────────────────────────────────
      identify.reply = { json: recognition('candidates', [CHARIZARD_V, { ...FURRET, score: 0.81 }, VMAX], 0.7) };
      await submitPhoto(page, photo);
      await expect(page.getByRole('heading', { name: 'We found a few possibilities' })).toBeVisible({ timeout: 15_000 });
      await expect(page.getByTestId('scan-confirm')).toHaveCount(0); // never auto-selected
      await expect(page.getByTestId('scan-candidate-2')).toBeVisible();
      await expect(page.getByTestId('scan-tile-label').first()).toHaveText('Charizard V — 19/189 — 92%');
      const tiles = [await rect(page, 'scan-candidate-0'), await rect(page, 'scan-candidate-1'), await rect(page, 'scan-candidate-2')];
      measure(`tiles@${vp.width}`, tiles);
      if (vp.width < 390) {
        expect(Math.abs(tiles[0]!.x - tiles[1]!.x)).toBeLessThan(2); // stacked
        expect(tiles[1]!.y).toBeGreaterThan(tiles[0]!.y + tiles[0]!.height - 2);
      } else {
        expect(Math.abs(tiles[0]!.y - tiles[1]!.y)).toBeLessThan(2); // 2-up
        expect(tiles[1]!.x).toBeGreaterThan(tiles[0]!.x + tiles[0]!.width - 2);
      }
      // 63:88 art box, and no layout shift once art has loaded.
      const artBoxes = await page.locator('[data-testid^="scan-candidate-"] [data-testid="card-art"]').evaluateAll((els) => els.map((e) => e.getBoundingClientRect()));
      for (const b of artBoxes) expect(Math.abs(b.height / b.width - 88 / 63)).toBeLessThan(0.02);
      await page.waitForLoadState('networkidle');
      const after = await rect(page, 'scan-candidate-0');
      expect(Math.abs(after.height - tiles[0]!.height)).toBeLessThan(2);
      expect(Math.abs(after.y - tiles[0]!.y)).toBeLessThan(2);
      await assertNoOverflow(page);
      await assertTapTargets(page);
      // tap → same confirm sheet
      await page.getByTestId('scan-candidate-1').click();
      await expect(page.getByTestId('confirm-sheet')).toBeVisible();
      await expect(page.getByRole('heading', { name: 'Furret' }).first()).toBeVisible();
      await page.getByTestId('sheet-cancel').tap();
      await expect(page.getByTestId('confirm-sheet')).toHaveCount(0);

      // ── no_match / no_card ───────────────────────────────────────────────────
      for (const status of ['no_match', 'no_card'] as const) {
        identify.reply = { json: recognition(status, [], 0.1) };
        await submitPhoto(page, photo);
        const nm = page.getByTestId('scan-no-match');
        await expect(nm).toBeVisible({ timeout: 15_000 });
        await expect(nm).toHaveAttribute('data-status', status);
        await expect(page.getByTestId('scan-heading')).toHaveText("We couldn't confidently identify this card.");
        for (const id of ['scan-try-another', 'scan-search-manually', 'scan-browse-sets']) await expect(page.getByTestId(id)).toBeVisible();
        await assertNoOverflow(page);
        await assertTapTargets(page);
      }

      // ── every error code ─────────────────────────────────────────────────────
      for (const e of ERRORS) {
        identify.reply = { status: e.status, json: errorJson(e.code, e.retry), headers: e.code === 'RATE_LIMITED' ? { 'Retry-After': '9' } : {} };
        await submitPhoto(page, photo);
        const f = page.getByTestId('scan-failure');
        await expect(f, e.code).toBeVisible({ timeout: 15_000 });
        await expect(f).toHaveAttribute('data-failure', e.kind);
        await expect(page.getByTestId('scan-heading')).toHaveText(e.title);
        if ('body' in e) await expect(page.getByTestId('scan-failure-body')).toHaveText(e.body);
        if (e.code === 'RATE_LIMITED') await expect(page.getByTestId('scan-failure-body')).toContainText('9 seconds');
        for (const id of ['scan-try-another', 'scan-search-manually', 'scan-browse-sets']) await expect(page.getByTestId(id), `${e.code} ${id}`).toBeVisible();
        if (e.retry) await expect(page.getByTestId('scan-retry')).toBeVisible();
        else await expect(page.getByTestId('scan-retry')).toHaveCount(0);
        await assertNoOverflow(page);
        await assertTapTargets(page);
      }
      // Retry re-posts the same photo.
      identify.reply = { json: recognition('no_match') };
      const before = identify.calls;
      identify.reply = { status: 503, json: errorJson('RECOGNIZER_BUSY') };
      await submitPhoto(page, photo);
      await expect(page.getByTestId('scan-retry')).toBeVisible({ timeout: 15_000 });
      identify.reply = { json: recognition('match', [CHARIZARD_V]) };
      await page.getByTestId('scan-retry').click();
      await expect(page.getByTestId('scan-match')).toBeVisible({ timeout: 15_000 });
      expect(identify.calls).toBe(before + 2);

      // ── unreadable / HEIC photos fail client-side with the helpful copy ─────
      const calls = identify.calls;
      const junk = Buffer.from('this is not an image');
      const [chooser] = await Promise.all([page.waitForEvent('filechooser'), page.getByTestId('scan-try-another').click()]);
      await chooser.setFiles({ name: 'photo.jpg', mimeType: 'image/jpeg', buffer: junk });
      await expect(page.getByTestId('scan-failure')).toHaveAttribute('data-failure', 'unsupported_image', { timeout: 15_000 });
      await expect(page.getByTestId('scan-failure-body')).toContainText('Try another photo');
      expect(identify.calls).toBe(calls); // never uploaded
      const heic = Buffer.concat([Buffer.from([0, 0, 0, 24]), Buffer.from('ftypheic'), Buffer.alloc(40)]);
      const [c2] = await Promise.all([page.waitForEvent('filechooser'), page.getByTestId('scan-try-another').click()]);
      await c2.setFiles({ name: 'IMG_0001.HEIC', mimeType: 'image/heic', buffer: heic });
      await expect(page.getByTestId('scan-failure-body')).toContainText('Most Compatible', { timeout: 15_000 });
      await expect(page.getByTestId('scan-failure-body')).toContainText('Choose a JPEG');
      expect(identify.calls).toBe(calls);

      // ── timeout (12 s in prod, shortened by the test hook) + cancel ─────────
      await page.evaluate(() => ((window as unknown as { __FDX_RECOG_TIMEOUT_MS__: number }).__FDX_RECOG_TIMEOUT_MS__ = 800));
      identify.reply = 'hang';
      await submitPhoto(page, photo);
      await expect(page.getByTestId('scan-failure')).toHaveAttribute('data-failure', 'timeout', { timeout: 15_000 });
      await page.evaluate(() => ((window as unknown as { __FDX_RECOG_TIMEOUT_MS__: number }).__FDX_RECOG_TIMEOUT_MS__ = 60_000));
      await submitPhoto(page, photo);
      await expect(page.getByTestId('scan-cancel')).toBeVisible();
      await page.getByTestId('scan-cancel').click();
      await expect(page.getByTestId('scan-capture')).toBeVisible();
      // network down
      identify.reply = 'abort';
      await page.getByTestId('scan-choose-input').setInputFiles({ name: 'card.jpg', mimeType: 'image/jpeg', buffer: photo });
      await expect(page.getByTestId('scan-failure')).toHaveAttribute('data-failure', 'offline', { timeout: 15_000 });

      // ── catalog-not-installed (JA catalog is not installed in this profile) ─
      identify.reply = { json: recognition('match', [{ language: 'ja', cardId: 'sv1-001', localId: '001', name: 'Sprigatito', setName: 'Scarlet ex' }], 0.95) };
      await submitPhoto(page, photo);
      const miss = page.getByTestId('scan-missing');
      await expect(miss).toBeVisible({ timeout: 15_000 });
      await expect(miss).toHaveAttribute('data-reason', 'lang_missing');
      await expect(page.getByTestId('scan-install-catalog')).toHaveText('Install Japanese catalog');
      await expect(page.getByTestId('scan-search-manually')).toBeVisible();
      await expect(page.getByTestId('scan-browse-sets')).toBeVisible();
      await expect(page.getByTestId('scan-confirm')).toHaveCount(0);
      await assertNoOverflow(page);
      await assertTapTargets(page);

      // ── card not in the installed catalog (index newer than catalog) ────────
      identify.reply = { json: recognition('match', [{ cardId: 'swsh3-9999', localId: '9999', name: 'Future Card' }], 0.95) };
      await page.getByTestId('scan-wrong').click();
      await submitPhoto(page, photo);
      await expect(page.getByTestId('scan-missing')).toHaveAttribute('data-reason', 'card_missing', { timeout: 15_000 });
      await expect(page.getByTestId('scan-missing-message')).toContainText('This card isn’t in your catalog yet — check for a newer catalog in Settings');
      await expect(page.getByTestId('scan-search-manually')).toBeVisible();
      await assertNoOverflow(page);
      // Search Manually → /add
      await page.getByTestId('scan-search-manually').click();
      await expect(page).toHaveURL(/\/add/);

      // ── landing actions navigate ────────────────────────────────────────────
      await page.goto('/scan');
      await page.getByTestId('scan-browse').click();
      await expect(page).toHaveURL(/\/sets/);
      await page.goto('/scan');
      await page.getByTestId('scan-search').click();
      await expect(page).toHaveURL(/\/add/);

      expect(errors.filter((e) => !/Failed to load resource|ERR_|net::/.test(e))).toEqual([]);
    });

    test('scanner offline banner (non-blocking) and nav entry', async ({ page }) => {
      await mockCardArt(page);
      await mockHealth(page, false);
      await mockIdentify(page);
      await onboardAndInstall(page);
      // Center tab = real Scan link
      await page.goto('/');
      const fab = page.getByTestId('tab-scan');
      await expect(fab).toHaveAttribute('aria-label', 'Scan a card');
      await expect(fab).toHaveAttribute('href', '/scan');
      await expect(page.getByTestId('tab-scan-label')).toHaveText('Scan');
      await expect(page.getByTestId('scan-sheet')).toHaveCount(0);
      const f = await rect(page, 'tab-scan');
      const label = await rect(page, 'tab-scan-label');
      measure(`fab@${vp.width}`, { fab: f, label });
      expect(f.width).toBeGreaterThanOrEqual(44);
      expect(label.y).toBeGreaterThanOrEqual(f.y + f.height - 1); // label sits under the circle
      await assertNoOverflow(page);
      await fab.click();
      await expect(page).toHaveURL(/\/scan$/);
      await expect(page.getByTestId('scan-offline-banner')).toBeVisible({ timeout: 10_000 });
      await expect(page.getByTestId('scan-offline-banner')).toContainText('Scanner offline');
      // Manual add is never blocked; capture buttons stay enabled.
      await expect(page.getByTestId('scan-take')).toBeEnabled();
      await expect(page.getByTestId('scan-search')).toBeEnabled();
      await assertNoOverflow(page);
      await assertTapTargets(page);
    });

    test('confirm → add → Added → Scan Another → second add → View Card → reload → copies persist', async ({ page }) => {
      const { errors, identify } = await setup(page);
      const photo = await makeJpeg(page);
      const before = await readOwnedCopies(page);
      expect(before).toHaveLength(0);
      await page.goto('/scan');

      // 1st scan: Charizard V
      identify.reply = { json: recognition('match', [CHARIZARD_V], 0.97) };
      await submitPhoto(page, photo);
      await page.getByTestId('scan-confirm').click();
      await expect(page.getByTestId('confirm-sheet')).toBeVisible();
      await page.getByTestId('add-submit').click();
      await expect(page.getByTestId('scan-added')).toBeVisible({ timeout: 20_000 });
      await expect(page.getByTestId('confirm-sheet')).toHaveCount(0);
      await expect(page.getByTestId('scan-heading')).toHaveText('Added to collection');
      await expect(page.getByTestId('scan-added-name')).toContainText('Charizard V');
      await expect(page).toHaveURL(/\/scan$/);
      await assertNoOverflow(page);
      await assertTapTargets(page);
      measure(`scan-height@${vp.width}`, await page.evaluate(() => document.documentElement.scrollHeight));

      // Scan Another → straight back to the capture file chooser, still on /scan
      identify.reply = { json: recognition('match', [FURRET], 0.9) };
      let [chooser] = await Promise.all([page.waitForEvent('filechooser'), page.getByTestId('scan-another').click()]);
      expect(chooser.isMultiple()).toBe(false);
      await expect(page).toHaveURL(/\/scan$/);
      await chooser.setFiles({ name: 'card2.jpg', mimeType: 'image/jpeg', buffer: photo });
      await expect(page.getByTestId('scan-card-name')).toHaveText('Furret', { timeout: 15_000 });
      await page.getByTestId('scan-confirm').click();
      await page.getByTestId('add-submit').click();
      await expect(page.getByTestId('scan-added')).toBeVisible({ timeout: 20_000 });

      // 3rd scan: duplicate Charizard V = ordinary quantity increment
      identify.reply = { json: recognition('match', [CHARIZARD_V], 0.97) };
      [chooser] = await Promise.all([page.waitForEvent('filechooser'), page.getByTestId('scan-another').click()]);
      await chooser.setFiles({ name: 'card3.jpg', mimeType: 'image/jpeg', buffer: photo });
      await page.getByTestId('scan-confirm').click();
      await page.getByTestId('add-submit').click();
      await expect(page.getByTestId('scan-added')).toBeVisible({ timeout: 20_000 });
      await expect(page.getByTestId('scan-added-name')).toContainText('Charizard V');

      // View Card
      await page.getByTestId('scan-view-card').click();
      await expect(page).toHaveURL(/\/cards\/en\/swsh3-19$/);

      // Reload: everything persisted, nothing else changed
      await page.reload();
      const owned = await readOwnedCopies(page);
      expect(owned).toHaveLength(3);
      await page.goto('/collection');
      await expect(page.getByTestId('card-tile')).toHaveCount(2, { timeout: 20_000 });
      await expect(page.getByTestId('card-tile').filter({ hasText: 'Charizard V' })).toContainText('×2');
      await expect(page.getByTestId('card-tile').filter({ hasText: 'Furret' })).toHaveCount(1);
      expect(errors.filter((e) => !/Failed to load resource|ERR_|net::/.test(e))).toEqual([]);
    });
  });
}
