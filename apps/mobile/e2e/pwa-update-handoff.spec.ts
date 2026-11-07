import { expect, test, type BrowserContext, type Page } from '@playwright/test';
import { catalogPoolState, onboardAndInstall, trackErrors } from './helpers';

test.describe.configure({ timeout: 180_000 });
test.skip(({ isMobile }) => !isMobile, 'handoff harness is viewport-independent; run once (mobile project)');

type Handoff = { state: { reloads: number }; run(opts?: { workerWaiting?: boolean }): Promise<void> };
type Services = { collection: { createLocation(i: { name: string }): Promise<unknown>; listLocations(i: Record<string, unknown>): Promise<unknown> } };
type Hook = { services: Services; sqlDelayMs?: number };
declare global {
  interface Window { __flashydexTest?: Hook; __fdxHandoffTest?: Handoff }
}

/**
 * S5-04. The REAL handoff (write gate under the drivers, drain, closePath({drain:true}) per open path, worker shutdown) + the REAL
 * update controller against a fake service worker (DEV-only seam in components/pwa-ui.tsx), so no production build is needed.
 */
test('update handoff: an in-flight write completes, new writes are refused, the page reloads exactly once, the data is there afterwards', async ({ page }) => {
  const errors = trackErrors(page);
  await onboardAndInstall(page);
  await page.waitForFunction(() => Boolean(window.__flashydexTest?.services && window.__fdxHandoffTest));

  // Slow every SQL call so the write below is still mid-transaction when the handoff starts.
  await page.evaluate(() => { window.__flashydexTest!.sqlDelayMs = 250; });
  const result = await page.evaluate(async () => {
    const t = window.__flashydexTest!;
    const write = t.services.collection.createLocation({ name: 'Written during handoff' }).then(() => 'ok', (e: { code?: string }) => `err:${e.code}`);
    await new Promise((r) => setTimeout(r, 300)); // inside BEGIN..COMMIT
    const handoff = window.__fdxHandoffTest!.run();
    await new Promise((r) => setTimeout(r, 50));
    const late = await t.services.collection.createLocation({ name: 'Too late' }).then(() => 'ok', (e: { code?: string }) => `err:${e.code}`);
    await handoff;
    return { write: await write, late, reloads: window.__fdxHandoffTest!.state.reloads };
  });
  expect(result.write).toBe('ok'); // the admitted transaction finished
  expect(result.late).toBe('err:MAINTENANCE'); // the gate is real: a service call after the handoff started is refused
  expect(result.reloads).toBe(1);
  await expect(page.getByTestId('update-handoff')).toBeVisible();

  // The "reload" was the stand-in's counter: do the real one and prove the committed write survived.
  await page.reload();
  await page.waitForFunction(() => Boolean(window.__flashydexTest?.services));
  const names = await page.evaluate(async () => JSON.stringify(await window.__flashydexTest!.services.collection.listLocations({})));
  expect(names).toContain('Written during handoff');
  expect(names).not.toContain('Too late');
  expect(errors.filter((e) => !/MAINTENANCE|Maintenance|Failed to load resource/.test(e))).toEqual([]);
});

test('update handoff: no waiting worker leaves an explicit Reload instead of a stuck overlay; reload restores a working app', async ({ page }) => {
  await onboardAndInstall(page);
  await page.waitForFunction(() => Boolean(window.__fdxHandoffTest));
  await page.evaluate(() => window.__fdxHandoffTest!.run({ workerWaiting: false }));
  // The shell is mounted only inside the app routes; the overlay lives in UpdateToast (mounted at the root).
  await expect(page.getByTestId('update-handoff-failed')).toBeVisible();
  await expect(page.getByTestId('update-handoff-reload')).toBeVisible();
  expect(await page.evaluate(() => window.__fdxHandoffTest!.state.reloads)).toBe(0);
  await page.getByTestId('update-handoff-reload').click();
  await page.waitForFunction(() => Boolean(window.__flashydexTest?.services));
  await expect(page.getByTestId('update-handoff')).toHaveCount(0);
});

test('update handoff: a running catalog install refuses the restart and offers "Restart later" (never waits forever)', async ({ page }) => {
  await onboardAndInstall(page);
  await page.waitForFunction(() => Boolean(window.__fdxHandoffTest));
  // Hold the install flag the way the UI does: run a second install through the hook is racy, so use the long-job registry seam instead.
  await page.evaluate(() => {
    const w = window as unknown as { __fdxHandoffTest: Handoff & { setBusy?: (m: string | null) => void } };
    w.__fdxHandoffTest.setBusy?.('A catalog download is running.');
  });
  await page.evaluate(() => window.__fdxHandoffTest!.run());
  await expect(page.getByTestId('update-handoff-message')).toContainText('download is running');
  await expect(page.getByTestId('update-handoff-later')).toBeVisible();
  await page.getByTestId('update-handoff-later').click();
  await expect(page.getByTestId('update-handoff')).toHaveCount(0);
  // The app is still writable.
  await page.evaluate(() => window.__flashydexTest!.services.collection.createLocation({ name: 'Still works' }));
});

/**
 * S6-06: the writer lock is released ONLY after the handoff closed every handle and stopped the worker, so a blocked second tab of the
 * same context takes it over WITHOUT stealing (A never closes). Real Web Locks, real worker, fake service worker.
 */
for (const [label, opts, expectFailureCard] of [
  ['successful handoff', undefined, false],
  ['activation failure (no waiting worker)', { workerWaiting: false }, true]
] as const) {
  test(`writer lock release: ${label} -> the blocked tab B becomes the writer while A stays open, A is never a writer again`, async ({ context }) => {
    const a = await context.newPage();
    await onboardAndInstall(a);
    await a.waitForFunction(() => Boolean(window.__flashydexTest?.services && window.__fdxHandoffTest));

    const b = await context.newPage();
    await b.goto('/');
    await expect(b.getByTestId('instance-lock')).toBeVisible({ timeout: 30_000 }); // A holds the lock; B is blocked behind it
    const heldBefore = await a.evaluate(async () => (await navigator.locks.query()).held?.some((l) => l.name === 'flashydex-user-writer') ?? false);
    expect(heldBefore).toBe(true);

    await a.evaluate((o) => window.__fdxHandoffTest!.run(o), opts);
    if (expectFailureCard) {
      await expect(a.getByTestId('update-handoff-failed')).toBeVisible();
      await expect(a.getByTestId('update-handoff-reload')).toBeVisible(); // Reload offered
    }
    // B was granted the lock (no steal: A never closed, A's lock request callback settled) and reloaded into the real app.
    await expect(b.getByTestId('instance-lock')).toHaveCount(0, { timeout: 30_000 });
    // The lock screen disappears while B reloads: write through B once its fresh document has the services (retry across the navigation).
    await expect.poll(async () => b.evaluate(() => window.__flashydexTest!.services.collection.createLocation({ name: `B writes after ${Date.now()}` }).then(() => 'ok', (e: { code?: string }) => `err:${e.code}`)).catch(() => 'navigating'), { timeout: 45_000, intervals: [250, 500, 1000] }).toBe('ok');
    expect(a.isClosed()).toBe(false);
    // A's storage is closed for good: a write from the old page is refused.
    const lateWrite = await a.evaluate(() => window.__flashydexTest!.services.collection.createLocation({ name: 'A after release' }).then(() => 'ok', (e: { code?: string }) => `err:${e.code}`));
    expect(lateWrite).not.toBe('ok');
  });
}

/**
 * S7-01 (P1): a retired page must never re-acquire the pool the new page legitimately owns. Same context, real Web Locks, real worker,
 * real sahpool. A completes the handoff (or fails activation after it); A then tries a lazy catalog open, a user driver, a prepare and a
 * delayed open/reopen through the REAL production factories and the REAL singleton client: every one rejects RETIRED, no new `Worker` is
 * constructed on A (counted by an init-script wrapper) and B boots, writes and KEEPS writing while A stays open (B's pool boot would
 * fail with a held-SAH INIT_FAILED if A had re-acquired any handle).
 */
type RetiredProbe = { results: Record<string, string>; workers: number };
for (const [label, opts, expectFailureCard] of [
  ['successful handoff', undefined, false],
  ['activation failure (no waiting worker)', { workerWaiting: false }, true]
] as const) {
  test(`retired page (${label}): lazy catalog open + delayed open/reopen reject RETIRED, no new worker on A, B boots and writes while A stays open`, async ({ context }) => {
    await context.addInitScript(() => {
      const w = window as unknown as { __fdxWorkers: number; Worker: typeof Worker };
      w.__fdxWorkers = 0;
      const Original = w.Worker;
      w.Worker = class extends Original {
        constructor(...args: ConstructorParameters<typeof Worker>) {
          super(...args);
          w.__fdxWorkers += 1;
        }
      };
    });
    const a = await context.newPage();
    await onboardAndInstall(a);
    await a.waitForFunction(() => Boolean(window.__flashydexTest?.services && window.__fdxHandoffTest));
    const workersBefore = await a.evaluate(() => (window as unknown as { __fdxWorkers: number }).__fdxWorkers);
    expect(workersBefore).toBeGreaterThanOrEqual(1);

    const b = await context.newPage();
    await b.goto('/');
    await expect(b.getByTestId('instance-lock')).toBeVisible({ timeout: 30_000 });

    await a.evaluate((o) => window.__fdxHandoffTest!.run(o), opts);
    if (expectFailureCard) await expect(a.getByTestId('update-handoff-failed')).toBeVisible();

    // A, still open and retired: every route back into storage, immediately AND delayed.
    const probe = await a.evaluate(async (): Promise<RetiredProbe> => {
      const db = await import('/src/platform/app-database.ts');
      const sql = await import('/src/platform/web-sqlite/client.ts');
      const client = sql.getWebSqliteClient();
      const code = (p: Promise<unknown>) => p.then(() => 'ok', (e: { code?: string }) => e.code ?? String(e));
      const attempt = () => ({
        prepare: code(db.prepareStorage()),
        userDriver: code(db.createUserDriver()),
        catalogEn: code(db.catalogSource.open('en')),
        catalogJa: code(db.catalogSource.open('ja')),
        catalogWritable: code(db.catalogSource.openWritable!('en')),
        init: code(client.init()),
        open: code(client.driver('/user/u-retired01.db', 'late', { mode: 'rw', create: false, role: 'user' })),
        openRo: code(client.driver('/catalog-en/g-retired01.db', 'late-ro', { mode: 'ro', create: false, role: 'catalog' })),
        list: code(client.listFiles()),
        importStage: code(client.importFromStaging({ target: '/catalog-en/g-retired01.db', source: { job: 'j', name: 'n' }, expectedBytes: 10, expectedSha256: 'a'.repeat(64) } as never))
      });
      const settle = async (pending: ReturnType<typeof attempt>) => Object.fromEntries(await Promise.all(Object.entries(pending).map(async ([k, v]) => [k, await v])));
      const now = await settle(attempt());
      await new Promise((r) => setTimeout(r, 800)); // delayed open/reopen
      const later = await settle(attempt());
      const results: Record<string, string> = {};
      for (const [k, v] of Object.entries(now)) results[`now.${k}`] = v as string;
      for (const [k, v] of Object.entries(later)) results[`later.${k}`] = v as string;
      return { results, workers: (window as unknown as { __fdxWorkers: number }).__fdxWorkers };
    });
    for (const [key, value] of Object.entries(probe.results)) expect(value, key).toBe('RETIRED');
    expect(probe.workers).toBe(workersBefore); // no new Worker constructed on the retired page

    // B takes over (no steal), boots a worker, writes - and keeps writing after A's attempts.
    await expect(b.getByTestId('instance-lock')).toHaveCount(0, { timeout: 30_000 });
    const write = (name: string) => b.evaluate((n) => window.__flashydexTest!.services.collection.createLocation({ name: n }).then(() => 'ok', (e: { code?: string }) => `err:${e.code}`), name).catch(() => 'navigating');
    await expect.poll(() => write(`B writes ${Date.now()}`), { timeout: 45_000, intervals: [250, 500, 1000] }).toBe('ok');
    expect(await write(`B writes again ${Date.now()}`)).toBe('ok');
    expect(a.isClosed()).toBe(false);
    expect(await a.evaluate(() => (window as unknown as { __fdxWorkers: number }).__fdxWorkers)).toBe(workersBefore);
    expect(await b.evaluate(() => (window as unknown as { __fdxWorkers: number }).__fdxWorkers)).toBeGreaterThanOrEqual(1);
  });
}

/**
 * S8-01 (P1): the handoff must not release the writer lock while an admitted catalog/sync job is alive (admission -> final USER receipt,
 * role-store IndexedDB transitions included). Sol's reproduction: A starts uninstall of the small EN catalog, its role IO is held behind
 * a real fixture IndexedDB transaction, A requests the handoff. B (same context, blocked on the lock) must stay blocked until A's job has
 * settled; then B boots with a CONSISTENT receipt (installed + active, or absent + no orphan - never installed + null active).
 */
type Gate = { promise: Promise<void>; open(): void };
const gate = (): Gate => {
  let open!: () => void;
  const promise = new Promise<void>((resolve) => { open = resolve; });
  return { promise, open };
};
type JobServices = { settings: { update(i: Record<string, unknown>): Promise<unknown> }; install: { installed(l: string): Promise<{ status: string }>; install(l: string, on: (p: unknown) => void, s: AbortSignal): Promise<unknown>; uninstall(i: { language: string; confirm: true }): Promise<unknown> }; catalog: { searchCards(i: Record<string, unknown>): Promise<{ page: { total: number } }> }; sync: { start(i: Record<string, unknown>): Promise<unknown> } };
type Win = { __flashydexTest?: { services: JobServices }; __fdxHandoffTest?: { run(): Promise<void> }; __fdxJob?: Promise<string>; __fdxHandoff?: Promise<void>; __fdxRoleHold?: { released: boolean; done: Promise<void> } };

/** A REAL readwrite IndexedDB transaction on the role store, kept alive with read requests until released: later role transactions queue behind it. */
async function holdRoleStore(page: Page): Promise<void> {
  await page.evaluate(() => new Promise<void>((resolve, reject) => {
    const open = indexedDB.open('flashydex-web-storage-v1');
    open.onerror = () => reject(open.error);
    open.onsuccess = () => {
      const db = open.result;
      const tx = db.transaction('meta', 'readwrite');
      const store = tx.objectStore('meta');
      const hold = { released: false, done: new Promise<void>((done) => { tx.oncomplete = () => { db.close(); done(); }; }) };
      (window as unknown as Win).__fdxRoleHold = hold;
      const pump = () => { if (!hold.released) store.get('state').onsuccess = pump; };
      pump();
      resolve();
    };
  }));
}
async function releaseRoleStore(page: Page): Promise<void> {
  await page.evaluate(async () => { const h = (window as unknown as Win).__fdxRoleHold!; h.released = true; await h.done; });
}
const activeJobs = (page: Page) => page.evaluate(async () => ((await import(/* @vite-ignore */ '/src/platform/web-storage/job-registry.ts' as string)) as { jobRegistry: { active(): Array<{ kind: string; durable: boolean }> } }).jobRegistry.active().map((j) => `${j.kind}:${j.durable}`));
const lockHeld = (page: Page) => page.evaluate(async () => (await navigator.locks.query()).held?.some((l) => l.name === 'flashydex-user-writer') ?? false);

async function blockedSecondTab(context: BrowserContext, a: Page): Promise<Page> {
  const b = await context.newPage();
  await b.goto('/');
  await expect(b.getByTestId('instance-lock')).toBeVisible({ timeout: 30_000 });
  expect(await lockHeld(a)).toBe(true);
  return b;
}
/** B stays blocked and A keeps the lock for `ms` while the handoff is requested and the job is alive. */
async function expectStillOwned(a: Page, b: Page, ms = 2500): Promise<void> {
  await a.waitForTimeout(ms);
  await expect(b.getByTestId('instance-lock')).toBeVisible();
  expect(await lockHeld(a)).toBe(true);
}
async function bootedConsistent(b: Page, expectLanguage: 'en' | 'ja' = 'en'): Promise<{ status: string; total: number | null }> {
  await expect(b.getByTestId('instance-lock')).toHaveCount(0, { timeout: 45_000 });
  await b.waitForFunction(() => Boolean((window as unknown as Win).__flashydexTest?.services), undefined, { timeout: 45_000 });
  const view = await b.evaluate(async (language) => {
    const services = (window as unknown as Win).__flashydexTest!.services;
    const status = (await services.install.installed(language)).status;
    const total = await services.catalog.searchCards({ q: '', language, limit: 5 }).then((r) => r.page.total, () => null);
    return { status, total };
  }, expectLanguage);
  const pool = await catalogPoolState(b);
  const files = pool.files.filter((f) => f.startsWith(`/catalog-${expectLanguage}/`));
  const active = pool.activeRefs[expectLanguage] ?? null;
  if (view.status === 'installed') {
    expect(active, 'installed receipt with a null active mapping').not.toBeNull();
    expect(files).toContain(active);
    expect(view.total).toBeGreaterThan(0); // search works
  } else {
    expect(view.status).toBe('absent');
    expect(active).toBeNull();
    expect(files, 'orphan catalog generation').toEqual([]);
  }
  return view;
}
const lateWriteOnA = (a: Page) => a.evaluate(() => (window as unknown as { __flashydexTest: { services: { collection: { createLocation(i: { name: string }): Promise<unknown> } } } }).__flashydexTest.services.collection.createLocation({ name: 'A after handoff' }).then(() => 'ok', (e: { code?: string }) => `err:${e.code}`));

test('S8-01 uninstall with its role IO held: handoff waits, B stays blocked until the uninstall settled, B boots absent with no orphan', async ({ context }) => {
  const a = await context.newPage();
  await onboardAndInstall(a);
  await a.waitForFunction(() => Boolean((window as unknown as Win).__flashydexTest?.services && (window as unknown as Win).__fdxHandoffTest));
  const b = await blockedSecondTab(context, a);

  await holdRoleStore(a);
  await a.evaluate(() => {
    const w = window as unknown as Win;
    w.__fdxJob = w.__flashydexTest!.services.install.uninstall({ language: 'en', confirm: true }).then(() => 'ok', (e: { code?: string }) => `err:${e.code}`);
  });
  await expect.poll(() => activeJobs(a), { timeout: 15_000 }).toContain('uninstall:false');
  await a.evaluate(() => { const w = window as unknown as Win; w.__fdxHandoff = w.__fdxHandoffTest!.run(); });

  await expectStillOwned(a, b); // the lock is NOT released while the uninstall's role IO is queued
  expect(await a.evaluate(() => (window as unknown as Win).__fdxRoleHold!.released)).toBe(false);

  await releaseRoleStore(a);
  expect(await a.evaluate(() => (window as unknown as Win).__fdxJob)).toBe('ok'); // the receipt transaction was admitted (never MAINTENANCE)
  await a.evaluate(() => (window as unknown as Win).__fdxHandoff);
  expect(await bootedConsistent(b)).toMatchObject({ status: 'absent' });
  expect(await lateWriteOnA(a)).not.toBe('ok');
  expect(await b.evaluate(() => (window as unknown as { __flashydexTest: { services: { collection: { createLocation(i: { name: string }): Promise<unknown> } } } }).__flashydexTest.services.collection.createLocation({ name: 'B writes' }).then(() => 'ok', (e: { code?: string }) => `err:${e.code}`))).toBe('ok');
});

test('S8-01 install in progress (download stalled), no canceller: the handoff waits for the whole install, B boots consistent', async ({ context }) => {
  const stall = gate();
  await context.route('**/dev-packs/catalog-ja-*.zst', async (route) => { await stall.promise; await route.continue().catch(() => undefined); });
  const a = await context.newPage();
  await onboardAndInstall(a);
  await a.waitForFunction(() => Boolean((window as unknown as Win).__flashydexTest?.services && (window as unknown as Win).__fdxHandoffTest));
  const b = await blockedSecondTab(context, a);

  await a.evaluate(() => (window as unknown as Win).__flashydexTest!.services.settings.update({ languages: ['en', 'ja'] })); // JA must be a selected catalog
  // No canceller registered (a caller outside install-hooks): the handoff must wait for the whole install.
  await a.evaluate(() => {
    const w = window as unknown as Win;
    w.__fdxJob = w.__flashydexTest!.services.install.install('ja', () => undefined, new AbortController().signal).then(() => 'ok', (e: { code?: string }) => `err:${e.code}`);
  });
  await expect.poll(() => activeJobs(a), { timeout: 30_000 }).toContain('install:false');
  await a.evaluate(() => { const w = window as unknown as Win; w.__fdxHandoff = w.__fdxHandoffTest!.run(); });
  await expectStillOwned(a, b);
  stall.open();
  expect(await a.evaluate(() => (window as unknown as Win).__fdxJob)).toBe('ok');
  await a.evaluate(() => (window as unknown as Win).__fdxHandoff);
  expect(await bootedConsistent(b, 'ja')).toMatchObject({ status: 'installed' });
  expect(await bootedConsistent(b, 'en')).toMatchObject({ status: 'installed' });
});

test('S8-01 install in progress with a canceller (install-hooks): the pre-durable install is aborted, EN stays intact, the lock is released afterwards', async ({ context }) => {
  const stall = gate(); // never opened: only the abort can end the stalled download
  await context.route('**/dev-packs/catalog-ja-*.zst', async (route) => { await stall.promise; await route.continue().catch(() => undefined); });
  const a = await context.newPage();
  await onboardAndInstall(a);
  await a.waitForFunction(() => Boolean((window as unknown as Win).__flashydexTest?.services && (window as unknown as Win).__fdxHandoffTest));
  const b = await blockedSecondTab(context, a);

  await a.evaluate(() => (window as unknown as Win).__flashydexTest!.services.settings.update({ languages: ['en', 'ja'] }));
  await a.evaluate(async () => {
    const w = window as unknown as Win;
    const { jobRegistry } = (await import(/* @vite-ignore */ '/src/platform/web-storage/job-registry.ts' as string)) as { jobRegistry: { registerCanceller(k: string, f: () => void): () => void } };
    const controller = new AbortController();
    jobRegistry.registerCanceller('install', () => controller.abort());
    w.__fdxJob = w.__flashydexTest!.services.install.install('ja', () => undefined, controller.signal).then(() => 'ok', (e: { code?: string }) => `err:${e.code}`);
  });
  await expect.poll(() => activeJobs(a), { timeout: 30_000 }).toContain('install:false');
  await a.evaluate(() => { const w = window as unknown as Win; w.__fdxHandoff = w.__fdxHandoffTest!.run(); });
  await a.evaluate(() => (window as unknown as Win).__fdxHandoff);
  expect(await a.evaluate(() => (window as unknown as Win).__fdxJob)).toBe('err:CANCELLED');
  expect(await bootedConsistent(b, 'en')).toMatchObject({ status: 'installed' });
  expect((await bootedConsistent(b, 'ja')).status).toBe('absent');
  stall.open();
});

test('S8-01 sync in progress: the handoff waits for the sync lease to settle, B boots consistent', async ({ context }) => {
  const stall = gate();
  await context.route('**/api.tcgdex.net/**', async (route) => { await stall.promise; await route.fulfill({ status: 200, contentType: 'application/json', body: '[]' }).catch(() => undefined); });
  const a = await context.newPage();
  await onboardAndInstall(a);
  await a.waitForFunction(() => Boolean((window as unknown as Win).__flashydexTest?.services && (window as unknown as Win).__fdxHandoffTest));
  const b = await blockedSecondTab(context, a);

  await a.evaluate(() => {
    const w = window as unknown as Win;
    w.__fdxJob = w.__flashydexTest!.services.sync.start({ mode: 'incremental' }).then(() => 'ok', (e: { code?: string }) => `err:${e.code}`);
  });
  await expect.poll(() => activeJobs(a), { timeout: 30_000 }).toContain('sync:false');
  await a.evaluate(() => { const w = window as unknown as Win; w.__fdxHandoff = w.__fdxHandoffTest!.run(); });
  await expectStillOwned(a, b);
  stall.open();
  await a.evaluate(() => (window as unknown as Win).__fdxHandoff);
  expect(await bootedConsistent(b, 'en')).toMatchObject({ status: 'installed' });
});
