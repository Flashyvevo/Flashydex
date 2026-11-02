import { expect, test, type BrowserContext, type Page } from '@playwright/test';
import { createHash } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { zstdCompressSync, zstdDecompressSync } from 'node:zlib';

/**
 * Stage F B: OPFS staging worker (part 1, no sahpool needed) and the web install port (part 2, see bottom).
 * Run: FLASHYDEX_E2E_BASE_URL=https://127.0.0.1:3200 npx playwright test e2e/web-install.spec.ts --project=mobile
 */
const HARNESS = '/src/platform/web-storage/harness.ts';
const SMALL = '/dev-packs/catalog-manifest.json';
const FULL = '/dev-packs/full/catalog-manifest.json';
const MIB = 1024 * 1024;

type Staged = { job: string; files: { name: string; size: number }[] }[];
interface Done { compressedBytes: number; decodedBytes: number; sha256: string; maxChunkBytes: number; maxInFlightObserved: number; pendingBytesMax: number; windowBytes: number; timestamps: { start: number; downloadEnd: number; decodeEnd: number } }
type StageResult = { ok: true; done: Done; ms: number; heapPeak: number; heapSamples: number; staged: Staged } | { ok: false; code: string; message: string; heapPeak: number; staged: Staged };

async function openHarness(page: Page): Promise<void> {
  // The first import after a dependency change makes Vite re-optimize and reload the page: retry until the context is stable.
  for (let attempt = 0; ; attempt += 1) {
    try {
      await page.goto('/harness.html');
      await page.evaluate((path) => import(/* @vite-ignore */ path).then(() => undefined), HARNESS);
      await page.waitForTimeout(300);
      await page.evaluate(async (path) => { await (await import(/* @vite-ignore */ path)).clearStaging(); }, HARNESS);
      return;
    } catch (error) {
      if (attempt >= 5 || !/context was destroyed|navigation/i.test(String(error))) throw error;
      await page.waitForTimeout(1000);
    }
  }
}

const stage = (page: Page, options: Record<string, unknown>) =>
  page.evaluate(async ([path, opts]) => (await import(/* @vite-ignore */ path as string)).stageOnly(opts), [HARNESS, options] as const) as Promise<StageResult>;

test.describe('OPFS stage worker', () => {
  test('small pack: exact staged sizes, decoder bounds, hash, nothing left after cleanup', async ({ page }) => {
    await openHarness(page);
    const manifest = (await (await page.request.get(SMALL)).json()) as { languages: Record<string, { compressedBytes: number; uncompressedBytes: number; sha256: string }> };
    const entry = manifest.languages.en!;
    const result = await stage(page, { manifestUrl: SMALL, language: 'en', keep: true });
    expect(result.ok, JSON.stringify(result)).toBe(true);
    if (!result.ok) return;
    expect(result.done.decodedBytes).toBe(entry.uncompressedBytes);
    expect(result.done.compressedBytes).toBe(entry.compressedBytes);
    expect(result.done.sha256).toBe(entry.sha256);
    expect(result.done.maxChunkBytes).toBeLessThanOrEqual(262_144);
    expect(result.done.maxInFlightObserved).toBeLessThanOrEqual(4);
    expect(result.done.pendingBytesMax).toBeLessThanOrEqual(MIB);
    expect(result.done.windowBytes).toBeLessThanOrEqual(32 * MIB);
    expect(result.staged).toHaveLength(1);
    const files = Object.fromEntries(result.staged[0]!.files.map((f) => [f.name, f.size]));
    expect(files['pack.zst.part']).toBe(entry.compressedBytes);
    expect(files['catalog.db.part']).toBe(entry.uncompressedBytes);
    await page.evaluate(async (path) => (await import(/* @vite-ignore */ path)).clearStaging(), HARNESS);
  });

  const failures: Array<[string, Record<string, unknown>, string]> = [
    ['wrong raw SHA-256', { corrupt: 'sha' }, 'PACK_HASH_MISMATCH'],
    ['wrong compressed SHA-256', { corrupt: 'compressedSha' }, 'PACK_HASH_MISMATCH'],
    ['manifest compressed size too large (truncated download)', { corrupt: 'size' }, 'PACK_SIZE_MISMATCH'],
    ['untrusted final origin', { corrupt: 'origin' }, 'PACK_INVALID'],
    ['persistent short write', { fault: { shortWriteAtByte: 50_000, shortWritePersistent: true } }, 'ACTIVATION_FAILED'],
    ['quota exceeded during download', { fault: { quotaAfterBytes: 60_000 } }, 'STORAGE_FULL'],
    ['quota exceeded during decode', { fault: { quotaAfterBytes: 140_000 } }, 'STORAGE_FULL'],
    ['abort at download', { fault: { abortAt: 'download' } }, 'CANCELLED'],
    ['abort at decode', { fault: { abortAt: 'decode' } }, 'CANCELLED'],
    ['abort at verify', { fault: { abortAt: 'verify' } }, 'CANCELLED']
  ];
  for (const [name, options, code] of failures) {
    test(`fails cleanly: ${name} -> ${code}, staging directory removed`, async ({ page }) => {
      await openHarness(page);
      const result = await stage(page, { manifestUrl: SMALL, language: 'en', ...options });
      expect(result.ok).toBe(false);
      if (result.ok) return;
      expect(result.code, result.message).toBe(code);
      expect(result.staged).toEqual([]);
    });
  }

  test('a single short write is retried once and the install succeeds', async ({ page }) => {
    await openHarness(page);
    const result = await stage(page, { manifestUrl: SMALL, language: 'en', fault: { shortWriteAtByte: 50_000 } });
    expect(result.ok, JSON.stringify(result)).toBe(true);
  });

  test('cancel mid-flight through AbortSignal -> CANCELLED and no staging left', async ({ page }) => {
    await openHarness(page);
    const result = await stage(page, { manifestUrl: SMALL, language: 'en', fault: { decodeDelayMs: 50 }, abortAfterMs: 400 });
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.code).toBe('CANCELLED');
    expect(result.staged).toEqual([]);
  });

  test('FULL EN pack: staged + decoded + hashed in the worker, heap < 128 MiB, bounded chunks', async ({ page }) => {
    test.setTimeout(240_000);
    await openHarness(page);
    await page.bringToFront();
    const result = await stage(page, { manifestUrl: FULL, language: 'en', keep: true });
    expect(result.ok, JSON.stringify(result)).toBe(true);
    if (!result.ok) return;
    const phases = {
      downloadMs: Math.round(result.done.timestamps.downloadEnd - result.done.timestamps.start),
      decodeMs: Math.round(result.done.timestamps.decodeEnd - result.done.timestamps.downloadEnd)
    };
    console.log(`FULL-EN stage-only: ${JSON.stringify({ ...phases, totalMs: result.ms, heapPeak: result.heapPeak, heapSamples: result.heapSamples, maxChunk: result.done.maxChunkBytes, pendingMax: result.done.pendingBytesMax, window: result.done.windowBytes })}`);
    expect(result.done.decodedBytes).toBe(138_002_432);
    expect(result.done.sha256).toBe('bbca47b37ae46b73684ea784abb8c96ac9bba98b5317512cb6841285ec081606');
    expect(result.done.maxChunkBytes).toBeLessThanOrEqual(262_144);
    expect(result.done.pendingBytesMax).toBeLessThanOrEqual(MIB);
    expect(result.heapPeak).toBeLessThan(134_217_728);
    expect(result.staged[0]!.files.find((f) => f.name === 'catalog.db.part')?.size).toBe(138_002_432);
    await page.evaluate(async (path) => (await import(/* @vite-ignore */ path)).clearStaging(), HARNESS);
  });
});

/* ──────────────────────────────────────────────── Part 2: web install port through the UNCHANGED core services (real sahpool + real IDB role store) ──────────────────────────────────────────────── */
interface CoreResult { ok: boolean; code?: string; message?: string; receipt?: { version?: string; status?: string }; totalMs: number; phases: Record<string, number>; heapPeak: number; heapSamples: number; snapshots: { phase: string; active: string | null; previous: string | null; files: string[] }[] }
interface PoolState { files: string[]; roles: Record<string, { activeRef: string | null; previousRef: string | null; candidates: unknown[] }>; staging: string[]; usage: number | null }

/** Opens the harness and boots prepareStorage + createUserDriver + createServices (NO staging cleanup: kill tests rely on boot reconcile). */
/* v2 packs: same bytes except catalog_meta.version (all occurrences of the 14-char version string rewritten in place) -> a genuinely different release for core's republish guard. */
const V2S = '/dev-packs/mock-v2/small-manifest.json';
const V2F = '/dev-packs/mock-v2/full-manifest.json';
const V1_VERSION = '2026.10.31.001';
const V2_VERSION = '2026.10.31.002';
interface V2Pack { manifest: string; pack: Buffer; packName: string }
const v2Cache = new Map<string, V2Pack>();
function buildV2(kind: 'small' | 'full'): V2Pack {
  const cached = v2Cache.get(kind);
  if (cached) return cached;
  const dir = join(process.cwd(), 'public', 'dev-packs', kind === 'small' ? '' : 'full');
  const manifest = JSON.parse(readFileSync(join(dir, 'catalog-manifest.json'), 'utf8')) as { targetVersion: string; languages: Record<string, Record<string, unknown>> };
  const en = manifest.languages.en!;
  const raw = zstdDecompressSync(readFileSync(join(dir, `catalog-en-${V1_VERSION}.db.zst`)));
  const needle = Buffer.from(V1_VERSION);
  const replacement = Buffer.from(V2_VERSION);
  let hits = 0;
  for (let at = raw.indexOf(needle); at !== -1; at = raw.indexOf(needle, at + needle.length)) { replacement.copy(raw, at); hits += 1; }
  if (hits === 0) throw new Error('version string not found in the pack');
  const pack = zstdCompressSync(raw);
  const packName = `catalog-en-${V2_VERSION}.db.zst`;
  manifest.targetVersion = V2_VERSION;
  delete manifest.languages.ja;
  Object.assign(en, {
    targetVersion: V2_VERSION, fullPackUrl: `/dev-packs/mock-v2/${kind}/${packName}`, compressedBytes: pack.length, uncompressedBytes: raw.length,
    sha256: createHash('sha256').update(raw).digest('hex'), compressedSha256: createHash('sha256').update(pack).digest('hex')
  });
  const built = { manifest: JSON.stringify(manifest), pack, packName };
  v2Cache.set(kind, built);
  return built;
}
const mockedContexts = new WeakSet<BrowserContext>();
async function mockV2(context: BrowserContext): Promise<void> {
  if (mockedContexts.has(context)) return;
  mockedContexts.add(context);
  await context.route('**/dev-packs/mock-v2/**', async (route) => {
    const url = new URL(route.request().url());
    const kind = url.pathname.includes('/full') ? 'full' : 'small';
    const built = buildV2(kind);
    if (url.pathname.endsWith('-manifest.json')) await route.fulfill({ status: 200, contentType: 'application/json', body: built.manifest });
    else await route.fulfill({ status: 200, contentType: 'application/zstd', body: built.pack });
  });
}

async function openCore(page: Page, manifest = SMALL): Promise<void> {
  await mockV2(page.context());
  for (let attempt = 0; ; attempt += 1) {
    try {
      await page.goto('/harness.html');
      await page.evaluate(([path, url]) => import(/* @vite-ignore */ path as string).then((m) => m.bootCore(url as string)), [HARNESS, manifest] as const);
      return;
    } catch (error) {
      if (attempt >= 5 || !/context was destroyed|navigation|Execution context/i.test(String(error))) throw error;
      await page.waitForTimeout(1000);
    }
  }
}
const h = <T>(page: Page, fn: string, ...args: unknown[]) =>
  page.evaluate(async ([path, name, a]) => (await import(/* @vite-ignore */ path as string))[name as string](...(a as unknown[])), [HARNESS, fn, args] as const) as Promise<T>;
const install = (page: Page, options: Record<string, unknown> = {}) => h<CoreResult>(page, 'installThroughCore', options);
const search = (page: Page, q: string) => h<{ total: number; names: string[] }>(page, 'searchCore', q);
const pool = (page: Page) => h<PoolState>(page, 'poolState');
const enGenerations = (files: string[]) => files.filter((f) => f.startsWith("/catalog-en/"));
const userFiles = (files: string[]) => files.filter((f) => f.startsWith('/user/'));

test.describe('web install through core (OPFS + sahpool + IDB roles)', () => {
  test('small pack: install -> search -> reload -> still installed -> search', async ({ page }) => {
    test.setTimeout(120_000);
    await openCore(page);
    const first = await install(page);
    expect(first.ok, JSON.stringify(first)).toBe(true);
    console.log(`SMALL install phases: ${JSON.stringify({ ...first.phases, totalMs: first.totalMs })}`);
    const probe = await search(page, '');
    expect(probe.total).toBeGreaterThan(0);
    const needle = probe.names[0]!.slice(0, 3);
    expect((await search(page, needle)).total).toBeGreaterThan(0);
    const before = await pool(page);
    expect(before.staging).toEqual([]);
    expect(before.roles.en!.activeRef).toBeTruthy();
    await page.reload();
    await openCore(page);
    const receipt = (await h<{ status: string; version: string }>(page, 'coreReceipt'));
    expect(receipt.status).toBe('installed');
    const after = await pool(page);
    expect(after.roles.en!.activeRef).toBe(before.roles.en!.activeRef);
    expect(after.files).toEqual(before.files);
    expect((await search(page, needle)).total).toBeGreaterThan(0);
    expect((await search(page, '')).total).toBe(probe.total);
  });

  test('FULL EN: per-phase ms, heap < 128 MiB, usage < 1.5x (staging deleted), one EN generation, search Umbreon', async ({ page }) => {
    test.setTimeout(300_000);
    await openCore(page, FULL);
    await page.bringToFront();
    const result = await install(page);
    expect(result.ok, JSON.stringify(result)).toBe(true);
    console.log(`FULL-EN through core: ${JSON.stringify({ ...result.phases, totalMs: result.totalMs, heapPeak: result.heapPeak, heapSamples: result.heapSamples })}`);
    expect(result.heapPeak).toBeLessThan(134_217_728);
    expect(result.heapSamples).toBeGreaterThan(20);
    for (const phase of ['download', 'decode', 'import', 'validate', 'activate']) expect(result.phases[phase], phase).toBeGreaterThanOrEqual(0);
    const state = await pool(page);
    console.log(`FULL-EN pool: ${JSON.stringify({ files: state.files, usage: state.usage })}`);
    expect(state.staging).toEqual([]);
    expect(enGenerations(state.files)).toHaveLength(1);
    expect(state.usage!).toBeLessThan(1.5 * 138_002_432);
    expect((await search(page, 'Umbreon')).total).toBeGreaterThanOrEqual(1);
  });

  test('update keeps previous until commit; discardPrevious reclaims; second generation replaces the first', async ({ page }) => {
    test.setTimeout(240_000);
    await openCore(page, SMALL);
    expect((await install(page)).ok).toBe(true);
    const v1 = await pool(page);
    const oldRef = v1.roles.en!.activeRef!;
    const smallTotal = (await search(page, '')).total;
    // Update: a v2 pack (route-mocked manifest + bytes, catalog_meta version rewritten) installs over the active v1 catalog.
    const update = await install(page, { manifestUrl: V2S, snapshotPhases: true });
    expect(update.ok, JSON.stringify(update)).toBe(true);
    console.log(`UPDATE phases: ${JSON.stringify(update.snapshots.map((s) => ({ phase: s.phase, active: s.active === oldRef ? 'OLD' : s.active, previous: s.previous, files: s.files.length })))}`);
    const beforeCommit = update.snapshots.find((s) => s.phase === 'validating' || s.phase === 'verifying')!;
    expect(beforeCommit.active).toBe(oldRef); // previous (active) kept until commit
    expect(enGenerations(beforeCommit.files)).toContain(oldRef);
    const after = await pool(page);
    expect(after.roles.en!.activeRef).not.toBe(oldRef);
    expect(after.roles.en!.previousRef).toBeNull();
    expect(enGenerations(after.files)).toEqual([after.roles.en!.activeRef]);
    expect(after.staging).toEqual([]);
    expect((await search(page, '')).total).toBeGreaterThan(smallTotal);
    expect(userFiles(after.files)).toEqual(userFiles(v1.files));
  });

  test('rollback through core install.rollback restores the previous generation (kept via discardPrevious seam)', async ({ page }) => {
    test.setTimeout(240_000);
    await openCore(page, SMALL);
    await page.evaluate(() => { (window as unknown as { __fdxKeepPrevious: boolean }).__fdxKeepPrevious = true; });
    expect((await install(page)).ok).toBe(true);
    const oldRef = (await pool(page)).roles.en!.activeRef!;
    const smallTotal = (await search(page, '')).total;
    expect((await install(page, { manifestUrl: V2S })).ok).toBe(true);
    const mid = await pool(page);
    expect(mid.roles.en!.previousRef).toBe(oldRef);
    expect(enGenerations(mid.files)).toHaveLength(2);
    const rolled = await h<{ ok: boolean; code?: string }>(page, 'rollbackCore');
    expect(rolled.ok, JSON.stringify(rolled)).toBe(true);
    const back = await pool(page);
    expect(back.roles.en!.activeRef).toBe(oldRef);
    expect((await search(page, '')).total).toBe(smallTotal);
    // role transitions persist across reload
    await page.reload();
    await openCore(page, SMALL);
    const reloaded = await pool(page);
    expect(reloaded.roles.en!.activeRef).toBe(oldRef);
    expect(enGenerations(reloaded.files)).toContain(oldRef);
    expect((await search(page, '')).total).toBe(smallTotal);
  });

  test('uninstall (clear) persists across reload: catalog absent, files reclaimed, USER untouched', async ({ page }) => {
    test.setTimeout(120_000);
    await openCore(page, SMALL);
    expect((await install(page)).ok).toBe(true);
    const userBefore = userFiles((await pool(page)).files);
    await h(page, 'uninstallCore');
    await page.reload();
    await openCore(page, SMALL);
    const state = await pool(page);
    expect(state.roles.en!.activeRef).toBeNull();
    expect(enGenerations(state.files)).toEqual([]);
    expect(userFiles(state.files)).toEqual(userBefore);
    expect((await h<{ status: string }>(page, 'coreReceipt')).status).not.toBe('installed');
  });

  test('injected persistent short write during an update -> clean failure, previous catalog still searchable', async ({ page }) => {
    test.setTimeout(120_000);
    await openCore(page, SMALL);
    expect((await install(page)).ok).toBe(true);
    const before = await pool(page);
    const total = (await search(page, '')).total;
    await page.evaluate(() => { (window as unknown as { __flashydexTest: unknown }).__flashydexTest = { webInstallFault: { shortWriteAtByte: 50_000, shortWritePersistent: true } }; });
    const failed = await install(page, { manifestUrl: V2S });
    expect(failed.ok).toBe(false);
    expect(failed.code).toBeTruthy();
    const after = await pool(page);
    expect(after.roles.en!.activeRef).toBe(before.roles.en!.activeRef);
    expect(after.files).toEqual(before.files);
    expect(after.staging).toEqual([]);
    expect((await search(page, '')).total).toBe(total);
  });

  test('injected quota error during an update -> STORAGE_FULL, previous catalog still searchable', async ({ page }) => {
    test.setTimeout(120_000);
    await openCore(page, SMALL);
    expect((await install(page)).ok).toBe(true);
    const before = await pool(page);
    const total = (await search(page, '')).total;
    await page.evaluate(() => { (window as unknown as { __flashydexTest: unknown }).__flashydexTest = { webInstallFault: { quotaAfterBytes: 100_000 } }; });
    const failed = await install(page, { manifestUrl: V2S });
    expect(failed.ok).toBe(false);
    expect(failed.code).toBe('STORAGE_FULL');
    const after = await pool(page);
    expect(after.roles.en!.activeRef).toBe(before.roles.en!.activeRef);
    expect(after.files).toEqual(before.files);
    expect(after.staging).toEqual([]);
    expect((await search(page, '')).total).toBe(total);
  });

  test('corrupt role record -> METADATA_CORRUPT at boot and nothing is reset', async ({ page }) => {
    test.setTimeout(120_000);
    await openCore(page, SMALL);
    expect((await install(page)).ok).toBe(true);
    await page.goto('/harness.html'); // fresh page, nothing opened
    await page.evaluate(() => new Promise<void>((resolve, reject) => {
      const open = indexedDB.open('flashydex-web-storage-v1');
      open.onerror = () => reject(open.error);
      open.onsuccess = () => {
        const db = open.result;
        const tx = db.transaction('meta', 'readwrite');
        tx.objectStore('meta').put({ garbage: true }, 'state');
        tx.oncomplete = () => { db.close(); resolve(); };
        tx.onerror = () => reject(tx.error);
      };
    }));
    const err = await page.evaluate(([path, url]) => import(/* @vite-ignore */ path as string).then((m) => m.bootCore(url as string)).then(() => 'booted', (e: { code?: string }) => e.code ?? String(e)), [HARNESS, SMALL] as const);
    expect(err).toBe('METADATA_CORRUPT');
    const raw = await page.evaluate(() => new Promise<unknown>((resolve, reject) => {
      const open = indexedDB.open('flashydex-web-storage-v1');
      open.onsuccess = () => { const r = open.result.transaction('meta').objectStore('meta').get('state'); r.onsuccess = () => { open.result.close(); resolve(r.result); }; r.onerror = () => reject(r.error); };
      open.onerror = () => reject(open.error);
    }));
    expect(raw).toEqual({ garbage: true });
    const files = await page.evaluate(async () => { const root = await navigator.storage.getDirectory(); const out: string[] = []; for await (const [name] of (root as unknown as { entries(): AsyncIterable<[string, unknown]> }).entries()) out.push(name); return out; });
    expect(files.length).toBeGreaterThan(0); // pool dir untouched, nothing wiped
  });
});

test.describe('kill tests: page closed mid-install, boot reconcile in a NEW page of the same context', () => {
  async function killWhen(page: Page, ready: string, manifest: string, fault: Record<string, unknown> | null): Promise<void> {
    if (fault) await page.evaluate((f) => { (window as unknown as { __flashydexTest: unknown }).__flashydexTest = { webInstallFault: f }; }, fault);
    await page.evaluate(([path, url]) => { void import(/* @vite-ignore */ path as string).then((m) => m.startInstall({ manifestUrl: url as string })); }, [HARNESS, manifest] as const);
    const deadline = Date.now() + 120_000;
    for (;;) {
      if (await page.evaluate((expr) => Boolean(eval(expr)), ready)) break; // eslint-disable-line no-eval
      if (Date.now() > deadline) throw new Error(`kill trigger never fired: ${ready}`);
      await page.waitForTimeout(15);
    }
    await page.close({ runBeforeUnload: false });
  }
  const MID_DECODE = "(window.__fdxProgress || []).length > 1";
  const MID_IMPORT = "performance.getEntriesByName('fdx:pack-decode').length > 0";

  for (const [label, trigger, fault, manifest] of [
    ['mid-decode', MID_DECODE, { decodeDelayMs: 40 }, SMALL],
    ['mid-import', MID_IMPORT, null, FULL]
  ] as const) {
    test(`first install killed ${label} -> absent catalog, no staging, no orphan generation, USER untouched`, async ({ context }) => {
      test.setTimeout(240_000);
      const page = await context.newPage();
      await openCore(page, SMALL);
      const userBefore = userFiles((await pool(page)).files);
      await killWhen(page, trigger, manifest, fault);
      const next = await context.newPage();
      await openCore(next, SMALL);
      const state = await pool(next);
      expect(state.roles.en!.activeRef).toBeNull();
      expect(state.roles.en!.previousRef).toBeNull();
      expect(state.roles.en!.candidates).toEqual([]);
      expect(state.staging).toEqual([]);
      expect(enGenerations(state.files)).toEqual([]);
      expect(userFiles(state.files)).toEqual(userBefore);
      expect((await h<{ status: string }>(next, 'coreReceipt')).status).not.toBe('installed');
      // a retry after the crash succeeds from scratch
      expect((await install(next)).ok).toBe(true);
      expect((await search(next, '')).total).toBeGreaterThan(0);
    });

    test(`update killed ${label} -> previous catalog intact and searchable, no staging, one generation`, async ({ context }) => {
      test.setTimeout(300_000);
      const page = await context.newPage();
      await openCore(page, SMALL);
      expect((await install(page)).ok).toBe(true);
      const before = await pool(page);
      const total = (await search(page, '')).total;
      await killWhen(page, trigger, label === 'mid-import' ? V2F : V2S, fault);
      const next = await context.newPage();
      await openCore(next, SMALL);
      const state = await pool(next);
      expect(state.roles.en!.activeRef).toBe(before.roles.en!.activeRef);
      expect(state.roles.en!.candidates).toEqual([]);
      expect(state.staging).toEqual([]);
      expect(enGenerations(state.files)).toEqual(enGenerations(before.files));
      expect(userFiles(state.files)).toEqual(userFiles(before.files));
      expect((await search(next, '')).total).toBe(total);
    });
  }
});
