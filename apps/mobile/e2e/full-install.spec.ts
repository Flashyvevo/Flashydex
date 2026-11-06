import { expect, test, type BrowserContext, type CDPSession, type Page } from '@playwright/test';
import { skipProtectionPrompt } from './helpers';

/**
 * W03/W08 evidence: install the REAL full EN pack (~12.3 MB zstd → 120,848,384 B raw at 64 KiB pages, 23,736 cards) through the real onboarding UI.
 * Needs the dev packs, so run it against the owner's server:
 *   FLASHYDEX_E2E_BASE_URL=https://127.0.0.1:3200 npx playwright test e2e/full-install.spec.ts --project=mobile
 *
 * Heap method: the page is sampled with CDP `Runtime.getHeapUsage` every ≤50 ms; every dedicated worker target (SQL worker,
 * OPFS stage/decode worker) is attached through a BROWSER-level CDP session (`Target.setDiscoverTargets` →
 * `Target.attachToTarget{flatten:false}` → `Target.sendMessageToTarget` `Runtime.getHeapUsage`), because Playwright's page
 * CDPSession cannot address flattened child sessions. Per tick, page + all live workers are summed.
 */
test.describe.configure({ timeout: 420_000 });

const X = 134_217_728;
const RAW_BYTES = Number(process.env.FLASHYDEX_FULL_RAW_BYTES ?? 120_848_384); // full EN, 64 KiB pages (ADR-055)

interface HeapReport {
  pagePeak: number;
  pageSamples: number;
  workers: Record<string, { peak: number; samples: number; failures: number }>;
  aggregatePeak: number | null;
  aggregateNote: string;
  intervalMsMax: number;
}
interface Sampler {
  stop(): Promise<HeapReport>;
}

async function startSampler(page: Page, context: BrowserContext): Promise<Sampler> {
  const pageSession = await context.newCDPSession(page);
  const browser = context.browser();
  if (!browser) throw new Error('no browser');
  const browserSession: CDPSession = await browser.newBrowserCDPSession();

  const live = new Map<string, { name: string; sessionId: string }>();
  const stats: Record<string, { peak: number; samples: number; failures: number }> = {};
  const pending = new Map<number, (v: number | null) => void>();
  let nextId = 1;
  const attaching = new Set<string>();

  browserSession.on('Target.receivedMessageFromTarget', (e: { sessionId: string; message: string }) => {
    try {
      const msg = JSON.parse(e.message) as { id?: number; result?: { usedSize?: number } };
      if (msg.id !== undefined) pending.get(msg.id)?.(msg.result?.usedSize ?? null);
    } catch {
      /* ignore */
    }
  });
  const attach = async (info: { targetId: string; type: string; url: string }) => {
    if (info.type !== 'worker' || live.has(info.targetId) || attaching.has(info.targetId)) return;
    attaching.add(info.targetId);
    try {
      const { sessionId } = (await browserSession.send('Target.attachToTarget', { targetId: info.targetId, flatten: false })) as { sessionId: string };
      const base = /sql\.worker/.test(info.url) ? 'sql-worker' : /opfs-stage/.test(info.url) ? 'decode-worker' : /pack-install/.test(info.url) ? 'pack-install-worker' : `worker:${info.url.split('/').pop()?.slice(0, 30)}`;
      live.set(info.targetId, { name: `${base}#${info.targetId.slice(0, 4)}`, sessionId });
    } catch {
      /* target already gone */
    } finally {
      attaching.delete(info.targetId);
    }
  };
  type TargetEvent = { targetInfo: { targetId: string; type: string; url: string } };
  browserSession.on('Target.targetCreated', (e: TargetEvent) => void attach(e.targetInfo));
  browserSession.on('Target.targetInfoChanged', (e: TargetEvent) => void attach(e.targetInfo));
  browserSession.on('Target.targetDestroyed', (e: { targetId: string }) => void live.delete(e.targetId));
  await browserSession.send('Target.setDiscoverTargets', { discover: true });

  const askWorker = (sessionId: string): Promise<number | null> =>
    new Promise((resolve) => {
      const id = nextId++;
      const timer = setTimeout(() => {
        pending.delete(id);
        resolve(null);
      }, 400);
      pending.set(id, (v) => {
        clearTimeout(timer);
        pending.delete(id);
        resolve(v);
      });
      browserSession.send('Target.sendMessageToTarget', { sessionId, message: JSON.stringify({ id, method: 'Runtime.getHeapUsage' }) }).catch(() => {
        clearTimeout(timer);
        pending.delete(id);
        resolve(null);
      });
    });

  let running = true;
  let pagePeak = 0;
  let pageSamples = 0;
  let aggregatePeak = 0;
  let measuredAnyWorker = false;
  let lastTick = Date.now();
  let intervalMsMax = 0;
  const loop = (async () => {
    while (running) {
      const tickStart = Date.now();
      intervalMsMax = Math.max(intervalMsMax, tickStart - lastTick);
      lastTick = tickStart;
      const targets = [...live.values()];
      const [pageHeap, ...workerHeaps] = await Promise.all([
        pageSession.send('Runtime.getHeapUsage').then((r) => (r as { usedSize: number }).usedSize).catch(() => null),
        ...targets.map(async (w) => ({ name: w.name, used: await askWorker(w.sessionId) }))
      ]);
      let sum = 0;
      if (pageHeap !== null) {
        pagePeak = Math.max(pagePeak, pageHeap as number);
        pageSamples += 1;
        sum += pageHeap as number;
      }
      for (const item of workerHeaps as Array<{ name: string; used: number | null }>) {
        const s = (stats[item.name] ??= { peak: 0, samples: 0, failures: 0 });
        if (item.used === null) {
          s.failures += 1;
          continue;
        }
        measuredAnyWorker = true;
        s.peak = Math.max(s.peak, item.used);
        s.samples += 1;
        sum += item.used;
      }
      aggregatePeak = Math.max(aggregatePeak, sum);
      const wait = 40 - (Date.now() - tickStart);
      if (wait > 0) await new Promise((r) => setTimeout(r, wait));
    }
  })();

  return {
    async stop() {
      running = false;
      await loop;
      const unmeasured = Object.entries(stats).filter(([, s]) => s.samples === 0);
      const measurable = measuredAnyWorker && unmeasured.length === 0;
      await browserSession.detach().catch(() => undefined);
      await pageSession.detach().catch(() => undefined);
      return {
        pagePeak,
        pageSamples,
        workers: stats,
        intervalMsMax,
        aggregatePeak: measurable ? aggregatePeak : null,
        aggregateNote: measurable
          ? 'page + every attached worker summed per tick (used JS heap; WASM linear memory is separate and not included)'
          : measuredAnyWorker
            ? `some workers could not be sampled: ${unmeasured.map(([n]) => n).join(', ')}`
            : 'no worker target could be sampled via CDP'
      };
    }
  };
}

test('full EN install through the onboarding UI: time, heap (page + workers), storage, search, reload', async ({ page, context }) => {
  await skipProtectionPrompt(page);
  // The app reads the small dev manifest URL by default; serve the full manifest there (pack URLs inside are absolute paths).
  const full = (await (await page.request.get('/dev-packs/full/catalog-manifest.json')).json()) as {
    languages: { en: { counts: { cards: number }; uncompressedBytes: number; compressedBytes: number; sha256: string } };
  };
  expect(full.languages.en.uncompressedBytes).toBe(RAW_BYTES);
  await page.route('**/dev-packs/catalog-manifest.json', (route) => route.fulfill({ json: full }));

  await page.goto('/');
  await expect(page).toHaveURL(/\/welcome$/, { timeout: 30_000 });
  await page.getByTestId('welcome-start').click();
  await page.getByTestId('notice-continue').click();
  await page.getByTestId('languages-continue').click();
  await expect(page).toHaveURL(/\/welcome\/sets$/);

  const sampler = await startSampler(page, context);
  const t0 = Date.now();
  await page.getByTestId('onboarding-finish').click();
  await expect(page.getByText('English catalog ready').first()).toBeVisible({ timeout: 360_000 });
  const installMs = Date.now() - t0;
  const heap = await sampler.stop();

  const storage = await page.evaluate(async () => {
    const e = await navigator.storage.estimate();
    return { usage: e.usage ?? null, quota: e.quota ?? null };
  });
  const measures = await page.evaluate(() =>
    performance.getEntriesByType('measure').filter((m) => m.name.startsWith('fdx:')).map((m) => ({ name: m.name, ms: Math.round(m.duration) }))
  );

  // search
  const searchTimes: number[] = [];
  await page.goto('/add');
  const box = page.getByRole('searchbox').or(page.getByPlaceholder('Search name or number')).first();
  const s0 = Date.now();
  await box.fill('Umbreon');
  await expect(page.getByTestId('result-row').filter({ hasText: 'Umbreon' }).first()).toBeVisible({ timeout: 30_000 });
  searchTimes.push(Date.now() - s0);
  const resultRows = await page.getByTestId('result-row').count();
  expect(resultRows).toBeGreaterThan(0);

  // reload: still installed, search still works
  await page.reload();
  await page.goto('/settings/catalog');
  await expect(page.getByTestId('catalog-language-en')).toContainText('Downloaded', { timeout: 30_000 });
  await page.goto('/add');
  const box2 = page.getByRole('searchbox').or(page.getByPlaceholder('Search name or number')).first();
  const r0 = Date.now();
  await box2.fill('Umbreon');
  await expect(page.getByTestId('result-row').filter({ hasText: 'Umbreon' }).first()).toBeVisible({ timeout: 30_000 });
  searchTimes.push(Date.now() - r0);

  const report = {
    installMs,
    rawBytes: RAW_BYTES,
    compressedBytes: full.languages.en.compressedBytes,
    cards: full.languages.en.counts.cards,
    pageHeapPeakBytes: heap.pagePeak,
    pageSamples: heap.pageSamples,
    sampleIntervalMsMax: heap.intervalMsMax,
    workers: heap.workers,
    aggregatePeakBytes: heap.aggregatePeak,
    aggregateNote: heap.aggregateNote,
    storageUsageBytes: storage.usage,
    storageQuotaBytes: storage.quota,
    searchUmbreonMs: searchTimes,
    resultRows,
    measures
  };
  console.log(`FULL-INSTALL-METRICS ${JSON.stringify(report)}`);
  test.info().annotations.push({ type: 'full-install-metrics', description: JSON.stringify(report) });

  expect(heap.pagePeak).toBeGreaterThan(0);
  expect(heap.pagePeak).toBeLessThan(X);
  if (heap.aggregatePeak !== null) expect(heap.aggregatePeak).toBeLessThan(X);
  expect(storage.usage).not.toBeNull();
  expect(storage.usage!).toBeLessThan(1.5 * RAW_BYTES);
});
