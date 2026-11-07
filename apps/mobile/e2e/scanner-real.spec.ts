import { execFileSync } from 'node:child_process';
import { existsSync, readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { expect, test, type APIRequestContext } from '@playwright/test';
import { onboardAndInstall, trackErrors } from './helpers';
import { assertNoOverflow, submitPhoto } from './scanner-helpers';

/** @real — posts generated fixture photos through the DEV proxy to the real recognition service (127.0.0.1:8900). Skips when /api/recognizer/health is not ok. */
test.describe.configure({ timeout: 600_000, mode: 'serial' });
// Opt-in: `FLASHYDEX_E2E_REAL=1 npx playwright test e2e/scanner-real`. Skipped in every default `e2e/scanner` run.
test.skip(!process.env.FLASHYDEX_E2E_REAL, 'real recognizer: set FLASHYDEX_E2E_REAL=1');

const dir = join(dirname(fileURLToPath(import.meta.url)), 'fixtures', 'scanner');
type Fixture = { id: string; name: string; file: string; transform: string };

function fixtures(): Fixture[] {
  if (!existsSync(join(dir, 'manifest.json')) || !existsSync(join(dir, 'unsupported.jpg'))) execFileSync(process.execPath, [join(dir, 'make.mjs')], { stdio: 'inherit' });
  return JSON.parse(readFileSync(join(dir, 'manifest.json'), 'utf8')) as Fixture[];
}
const bytes = (file: string) => readFileSync(join(dir, file));

let healthy = false;
test.beforeAll(async ({ request }) => {
  const res = await request.get('/api/recognizer/health', { timeout: 5000 }).catch(() => null);
  if (!res?.ok()) return;
  const body = (await res.json().catch(() => null)) as { ok?: boolean; status?: string; index?: { ready?: boolean } } | null;
  healthy = !!body && body.ok !== false && body.status !== 'degraded' && body.index?.ready !== false;
});

// The service allows 30 requests / minute / IP: pace posts and honour Retry-After.
let last = 0;
async function identifyApi(request: APIRequestContext, file: string) {
  for (let attempt = 0; attempt < 4; attempt++) {
    const wait = 2300 - (Date.now() - last);
    if (wait > 0) await new Promise((r) => setTimeout(r, wait));
    last = Date.now();
    const res = await request.post('/api/identify', { multipart: { image: { name: file, mimeType: 'image/jpeg', buffer: bytes(file) }, lang: 'en', max_candidates: '3' } });
    if (res.status() === 429) {
      await new Promise((r) => setTimeout(r, (Number(res.headers()['retry-after']) || 20) * 1000));
      continue;
    }
    return { status: res.status(), json: (await res.json()) as { status?: string; candidates?: Array<{ cardId: string; score: number }>; error?: { code: string } } };
  }
  throw new Error('rate limited repeatedly');
}

test('@real reference images → correct card; transforms ≥3/5 each; a wrong card is never a confident match', async ({ request }) => {
  test.skip(!healthy, 'recognizer not healthy on /api/recognizer/health');
  const all = fixtures();
  const table: Record<string, string[]> = {};
  const wrongMatches: string[] = [];
  const correctBy: Record<string, number> = {};
  for (const f of all) {
    const r = await identifyApi(request, f.file);
    expect(r.status, `${f.file} → HTTP`).toBe(200);
    const top = r.json.candidates?.[0];
    const correct = top?.cardId === f.id;
    const inList = !!r.json.candidates?.some((c) => c.cardId === f.id);
    (table[f.transform] ??= []).push(`${f.id}:${r.json.status}:${top?.cardId ?? '-'}@${top ? top.score.toFixed(2) : '-'}${correct ? ' ✓' : inList ? ' (in list)' : ' ✗'}`);
    if (correct) correctBy[f.transform] = (correctBy[f.transform] ?? 0) + 1;
    if (r.json.status === 'match' && !correct) wrongMatches.push(`${f.file} → ${top?.cardId}`);
    if (f.transform === 'ref') {
      expect(r.json.status, `${f.file} reference must be a match`).toBe('match');
      expect(top?.cardId, `${f.file} reference card`).toBe(f.id);
    }
  }
  console.log('REAL table', JSON.stringify(table, null, 1));
  console.log('REAL correct-by-transform', JSON.stringify(correctBy));
  console.log('REAL wrong confident matches', JSON.stringify(wrongMatches));
  for (const t of ['rot90', 'rot180', 'glare', 'blur', 'sleeve']) expect(correctBy[t] ?? 0, `${t} correct`).toBeGreaterThanOrEqual(3);
  expect(wrongMatches, 'wrong card returned as confident match').toEqual([]);
});

test('@real unsupported file → error', async ({ request }) => {
  test.skip(!healthy, 'recognizer not healthy');
  const r = await identifyApi(request, 'unsupported.jpg');
  console.log('REAL unsupported', r.status, JSON.stringify(r.json));
  expect(r.status).toBeGreaterThanOrEqual(400);
  expect(r.status).toBeLessThan(500);
  expect(r.json.error?.code).toBeTruthy();
});

test('@real UI: real photo through the Scan screen; unsupported copy; offline; interrupted request', async ({ page }) => {
  test.skip(!healthy, 'recognizer not healthy');
  const errors = trackErrors(page);
  page.on('response', async (res) => {
    if (res.url().endsWith('/api/identify')) console.log('REAL ui identify', res.status(), (await res.text().catch(() => '')).slice(0, 300));
  });
  page.on('requestfailed', (req) => console.log('REAL ui requestfailed', req.url(), req.failure()?.errorText));
  await onboardAndInstall(page);
  await page.goto('/scan?camera=file');
  await expect(page.getByTestId('scan-capture')).toBeVisible();
  await expect(page.getByTestId('scan-offline-banner')).toHaveCount(0);

  // Real recognition (reference + a transformed photo)
  const ref = fixtures().find((f) => f.id === 'swsh3-19' && f.transform === 'ref')!;
  await page.getByTestId('scan-choose-input').setInputFiles({ name: 'ref.jpg', mimeType: 'image/jpeg', buffer: bytes(ref.file) });
  await expect(page.getByTestId('scan-match')).toBeVisible({ timeout: 60_000 });
  await expect(page.getByTestId('scan-card-name')).toHaveText('Charizard V');
  await expect(page.getByTestId('scan-card-number')).toHaveText(/19\/189/);
  await assertNoOverflow(page);

  // Unsupported (.txt renamed .jpg): fails in the browser, never uploaded, helpful copy
  let posted = 0;
  await page.route('**/api/identify', async (route) => {
    posted++;
    await route.continue();
  });
  await submitPhoto(page, bytes('unsupported.jpg'));
  await expect(page.getByTestId('scan-failure')).toHaveAttribute('data-failure', 'unsupported_image', { timeout: 15_000 });
  await expect(page.getByTestId('scan-failure-body')).toContainText('Try another photo');
  expect(posted).toBe(0);
  for (const id of ['scan-try-another', 'scan-search-manually', 'scan-browse-sets']) await expect(page.getByTestId(id)).toBeVisible();

  // Recognizer offline (request aborted)
  await page.unroute('**/api/identify');
  await page.route('**/api/identify', (route) => route.abort('connectionrefused'));
  await submitPhoto(page, bytes(ref.file));
  await expect(page.getByTestId('scan-failure')).toHaveAttribute('data-failure', 'offline', { timeout: 15_000 });
  await expect(page.getByTestId('scan-retry')).toBeVisible();

  // Interrupted request: delayed upstream, user cancels, no late result appears
  await page.unroute('**/api/identify');
  let delayed = 0;
  await page.route('**/api/identify', async (route) => {
    delayed++;
    await new Promise((r) => setTimeout(r, 4000));
    await route.continue().catch(() => undefined);
  });
  await submitPhoto(page, bytes(ref.file));
  await expect(page.getByTestId('scan-cancel')).toBeVisible();
  await page.getByTestId('scan-cancel').click();
  await expect(page.getByTestId('scan-capture')).toBeVisible();
  await page.waitForTimeout(5000);
  await expect(page.getByTestId('scan-capture')).toBeVisible();
  await expect(page.getByTestId('scan-match')).toHaveCount(0);
  expect(delayed).toBe(1);
  expect(errors.filter((e) => !/Failed to load resource|ERR_|net::/.test(e))).toEqual([]);
});
