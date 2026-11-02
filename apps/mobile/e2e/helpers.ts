import { expect, type Page } from '@playwright/test';

/** Console errors + uncaught exceptions seen on a page (benign Vite/React-DevTools noise excluded). */
export function trackErrors(page: Page): string[] {
  const errors: string[] = [];
  page.on('pageerror', (error) => errors.push(`pageerror: ${error.message}`));
  page.on('console', (message) => {
    if (message.type() !== 'error') return;
    const text = message.text();
    errors.push(`console.error: ${text.slice(0, 300)}`);
  });
  return errors;
}

/** The one-time "Protect your collection" sheet is covered by its own spec; everywhere else it would sit over the flow under test. */
export async function skipProtectionPrompt(page: Page): Promise<void> {
  await page.context().addInitScript(() => {
    try { localStorage.setItem('fdx:protection-seen', '1'); } catch { /* opaque origin */ }
  });
}

/** Fresh profile → /welcome → notice → languages (English) → sets → "Start download" → waits for the dev pack to finish. */
export async function onboardAndInstall(page: Page): Promise<void> {
  await skipProtectionPrompt(page);
  await page.goto('/');
  await expect(page).toHaveURL(/\/welcome$/, { timeout: 30_000 });
  await page.getByTestId('welcome-start').click();
  await expect(page).toHaveURL(/\/welcome\/notice$/);
  await page.getByTestId('notice-continue').click();
  await expect(page).toHaveURL(/\/welcome\/languages$/);
  await page.getByTestId('languages-continue').click();
  await expect(page).toHaveURL(/\/welcome\/sets$/);
  await page.getByTestId('onboarding-finish').click();
  await expect(page.getByText('English catalog ready').first()).toBeVisible({ timeout: 120_000 });
}

/** Search the catalog on /add and open the confirm sheet for the first result whose name matches. */
export async function openConfirmFor(page: Page, query: string, name: string): Promise<void> {
  await page.goto('/add');
  await page.getByRole('searchbox').or(page.getByPlaceholder('Search name or number')).first().fill(query);
  const row = page.getByTestId('result-row').filter({ hasText: name }).first();
  await expect(row).toBeVisible({ timeout: 30_000 });
  await row.click();
  await expect(page.getByTestId('confirm-sheet')).toBeVisible();
}

/** Read a Playwright download into a Buffer. */
export async function downloadBuffer(download: { createReadStream(): Promise<NodeJS.ReadableStream | null> }): Promise<Buffer> {
  const stream = await download.createReadStream();
  const chunks: Buffer[] = [];
  for await (const chunk of stream as AsyncIterable<Buffer>) chunks.push(Buffer.from(chunk));
  return Buffer.concat(chunks);
}

function findKey(value: unknown, key: string): unknown {
  if (value === null || typeof value !== 'object') return undefined;
  if (key in (value as Record<string, unknown>)) return (value as Record<string, unknown>)[key];
  for (const child of Object.values(value as Record<string, unknown>)) {
    const found = findKey(child, key);
    if (found !== undefined) return found;
  }
  return undefined;
}

/** Owned copy ids + notes (sorted by id) as seen by the app's own JSON export: the observable truth a restore must reproduce. */
export async function readOwnedCopies(page: Page): Promise<Array<{ id: string; notes: string | null }>> {
  await page.goto('/settings/data');
  const [download] = await Promise.all([page.waitForEvent('download', { timeout: 30_000 }), page.getByTestId('export-json').click()]);
  const doc = JSON.parse((await downloadBuffer(download)).toString('utf8')) as unknown;
  const owned = findKey(doc, 'ownedCards') as Array<{ id: string; notes: string | null }>;
  return owned.map((c) => ({ id: c.id, notes: c.notes ?? null })).sort((a, b) => a.id.localeCompare(b.id));
}
