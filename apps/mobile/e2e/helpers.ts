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

export interface CatalogPoolState {
  /** Catalog files in the SQLite pool (`/catalog-<lang>/g-<job>.db`), sorted. */
  files: string[];
  activeRefs: Record<string, string | null>;
  previousRefs: Record<string, string | null>;
  /** OPFS staging job directories still present. */
  staging: string[];
}

/** Stage F storage truth read in-page: pool catalog files + role-store pointers + OPFS staging jobs (replaces the old jeep IndexedDB key listing). */
export async function catalogPoolState(page: Page): Promise<CatalogPoolState> {
  return page.evaluate(async () => {
    const [{ getWebSqliteClient }, { getRoleStore }, { listStagingJobs }] = await Promise.all([
      import('/src/platform/web-sqlite/index.ts'), import('/src/platform/web-storage/role-store.ts'), import('/src/platform/web-storage/opfs-staging.ts')
    ] as never[]) as unknown as [
      { getWebSqliteClient(): { listFiles(): Promise<string[]> } },
      { getRoleStore(): { load(): Promise<{ languages: Record<string, { activeRef: string | null; previousRef: string | null }> }> } },
      { listStagingJobs(): Promise<string[]> }
    ];
    const files = (await getWebSqliteClient().listFiles()).map(String).filter((f) => f.startsWith('/catalog-')).sort();
    const languages = (await getRoleStore().load()).languages;
    const activeRefs: Record<string, string | null> = {};
    const previousRefs: Record<string, string | null> = {};
    for (const [language, roles] of Object.entries(languages)) { activeRefs[language] = roles.activeRef; previousRefs[language] = roles.previousRef; }
    return { files, activeRefs, previousRefs, staging: await listStagingJobs() };
  });
}

/**
 * Worker death at a chosen point of a USER write (R02 fault on the Stage F path). Install BEFORE the first navigation, then set
 * `window.__fdxDieAt` to 'commit' or 'barrier'. The next matching message to the SQL worker is swallowed and the worker is terminated
 * through the client's DEV seam, so the in-flight request rejects WORKER_DIED / commitState `unknown`:
 *  - 'commit':  the COMMIT never executes (nothing is durable); core sees a failed COMMIT.
 *  - 'barrier': the COMMIT already executed (synchronous=FULL) and the durability barrier is lost; core latches persistence_failed (D43).
 * `window.__fdxKilled` counts how many times the fault fired.
 */
export async function installWorkerDeath(page: Page): Promise<void> {
  await page.addInitScript(() => {
    const w = window as unknown as { __fdxDieAt?: 'commit' | 'barrier' | null; __fdxKilled?: number };
    const original = Worker.prototype.postMessage;
    const matches = (message: unknown, at: 'commit' | 'barrier'): boolean => {
      const m = message as { op?: string; payload?: { sql?: string; statements?: { sql?: string }[] } } | null;
      if (!m) return false;
      if (at === 'barrier') return m.op === 'durableBarrier';
      if (m.op !== 'exec' && m.op !== 'batch') return false;
      const isCommit = (sql?: string) => typeof sql === 'string' && /^\s*(COMMIT|END)\b/i.test(sql);
      return isCommit(m.payload?.sql) || (m.payload?.statements ?? []).some((s) => isCommit(s.sql));
    };
    Worker.prototype.postMessage = function (this: Worker, ...args: unknown[]) {
      if (w.__fdxDieAt && matches(args[0], w.__fdxDieAt)) {
        w.__fdxDieAt = null;
        w.__fdxKilled = (w.__fdxKilled ?? 0) + 1;
        void import('/src/platform/web-sqlite/index.ts' as never).then((mod: { getWebSqliteClient(): { __terminateWorker(): void } }) => mod.getWebSqliteClient().__terminateWorker());
        return;
      }
      return (original as (...a: unknown[]) => void).apply(this, args);
    } as typeof Worker.prototype.postMessage;
  });
}
