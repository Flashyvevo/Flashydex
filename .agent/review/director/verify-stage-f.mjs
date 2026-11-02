// Director Stage F verification (Opus). Run: cd apps/mobile && node ../../.agent/review/director/verify-stage-f.mjs [phase]
// Headless Chromium via Playwright, 390x844, against the owner's HTTPS dev server (full catalogs manifest).
// No screenshots: DOM/JS/CDP text only. Writes JSON to .agent/review/director/stage-f-metrics.json
import { chromium } from 'playwright';
import { writeFileSync, readFileSync, existsSync } from 'node:fs';

const BASE = process.env.FDX_BASE ?? 'https://127.0.0.1:3200';
const OUT = new URL('./stage-f-metrics.json', import.meta.url);
const phase = process.argv[2] ?? 'all';
const results = existsSync(OUT) ? JSON.parse(readFileSync(OUT, 'utf8')) : {};
const save = () => writeFileSync(OUT, JSON.stringify(results, null, 2));
const log = (...a) => console.log(new Date().toISOString().slice(11, 19), ...a);

const browser = await chromium.launch();
const bcdp = await browser.newBrowserCDPSession();

/** Sample JS heap of every worker target via browser-level CDP (Target.sendMessageToTarget, non-flattened). */
async function workerHeapSampler() {
  const attached = new Map(); // targetId -> sessionId
  let msgId = 1000;
  const pending = new Map();
  const peaks = {};
  bcdp.on('Target.receivedMessageFromTarget', ({ sessionId, message }) => {
    const m = JSON.parse(message);
    if (m.id && pending.has(m.id)) { pending.get(m.id)(m); pending.delete(m.id); }
  });
  const send = (sessionId, method, params = {}) => new Promise((resolve) => {
    const id = ++msgId; pending.set(id, resolve);
    bcdp.send('Target.sendMessageToTarget', { sessionId, message: JSON.stringify({ id, method, params }) }).catch(() => resolve(null));
    setTimeout(() => { if (pending.has(id)) { pending.delete(id); resolve(null); } }, 2000);
  });
  let stop = false;
  const loop = (async () => {
    while (!stop) {
      try {
        const { targetInfos } = await bcdp.send('Target.getTargets');
        for (const t of targetInfos) {
          if (!/worker/.test(t.type) || !t.url.startsWith(BASE)) continue;
          if (!attached.has(t.targetId)) {
            try { const { sessionId } = await bcdp.send('Target.attachToTarget', { targetId: t.targetId, flatten: false }); attached.set(t.targetId, { sessionId, url: t.url }); } catch { /* gone */ }
          }
        }
        let sum = 0;
        for (const [tid, { sessionId, url }] of attached) {
          const r = await send(sessionId, 'Runtime.getHeapUsage');
          const used = r?.result?.usedSize;
          if (typeof used === 'number') {
            const key = url.replace(/^.*\//, '').replace(/\?.*$/, '');
            peaks[key] = Math.max(peaks[key] ?? 0, used);
            sum += used;
          }
        }
        peaks.__sumPeak = Math.max(peaks.__sumPeak ?? 0, sum);
      } catch { /* ignore */ }
      await new Promise((r) => setTimeout(r, 100));
    }
  })();
  return { peaks, stop: async () => { stop = true; await loop; } };
}

async function newMobileContext() {
  return browser.newContext({ ignoreHTTPSErrors: true, viewport: { width: 390, height: 844 }, isMobile: true, hasTouch: true, deviceScaleFactor: 1 });
}

const measures = (page) => page.evaluate(() => Object.fromEntries(performance.getEntriesByType('measure').filter((m) => m.name.startsWith('fdx:')).map((m) => [m.name, Math.round(m.duration)])));

async function waitServices(page, ms = 60000) {
  await page.waitForFunction(() => !!window.__flashydexTest?.services, null, { timeout: ms });
}

const PROFILE = process.env.FDX_PROFILE ?? 'C:/Users/AshtonSeabolt/AppData/Local/hermes/cache/scratch/fdx-director-profile';
const persistent = () => chromium.launchPersistentContext(PROFILE, { ignoreHTTPSErrors: true, viewport: { width: 390, height: 844 }, isMobile: true, hasTouch: true, deviceScaleFactor: 1 });
const step = async (name, fn, ms = 180000) => { log('step', name); return Promise.race([fn(), new Promise((_, rej) => setTimeout(() => rej(new Error('timeout ' + name)), ms))]).catch((e) => ({ error: String(e) })); };

if (phase === 'install') {
  const { rmSync } = await import('node:fs');
  rmSync(PROFILE, { recursive: true, force: true });
}
if (phase === 'all' || phase === 'install') {
  const ctx = phase === 'install' ? await persistent() : await newMobileContext();
  const page = await ctx.newPage();
  await page.bringToFront();
  const consoleErrors = [];
  page.on('console', (m) => { if (m.type() === 'error') consoleErrors.push(m.text().slice(0, 300)); });
  await page.goto(BASE + '/');
  await page.getByTestId('welcome-start').click({ timeout: 60000 });
  await page.getByTestId('notice-continue').click();
  // EN only
  await page.getByTestId('lang-en').waitFor();
  for (const l of ['en', 'ja']) {
    const el = page.getByTestId(`lang-${l}`);
    const checked = await el.evaluate((n) => n.getAttribute('aria-checked') ?? n.getAttribute('aria-pressed') ?? (n.querySelector('input')?.checked ? 'true' : 'false'));
    if ((l === 'en') !== (checked === 'true')) await el.click();
  }
  results.downloadTotalText = await page.getByTestId('download-total').innerText().catch(() => null);
  await page.getByTestId('languages-continue').click();
  await page.getByTestId('onboarding-finish').waitFor();
  await page.evaluate(() => { const w = window; w.__heap = { peak: 0, n: 0 }; setInterval(() => { const m = performance.memory; if (m) { w.__heap.peak = Math.max(w.__heap.peak, m.usedJSHeapSize); w.__heap.n++; } }, 50); });
  const sampler = await workerHeapSampler();
  const t0 = Date.now();
  await page.getByTestId('onboarding-finish').click();
  log('install started');
  await waitServices(page);
  let status = null;
  for (;;) {
    status = await page.evaluate(async () => { const s = await window.__flashydexTest.services.install.status('en'); return { installed: s.installed ? { version: s.installed.version ?? null, cards: s.installed.cardCount ?? null } : null, job: s.job ? { status: s.job.status, phase: s.job.phase ?? null } : null, lastError: s.lastError ?? null }; }).catch((e) => ({ err: String(e) }));
    if (status?.installed?.version || status?.lastError || status?.job?.status === 'failed') break;
    if (Date.now() - t0 > 10 * 60 * 1000) break;
    await page.waitForTimeout(500);
  }
  const installMs = Date.now() - t0;
  await sampler.stop();
  results.install = { installMs, status, pageHeapPeak: await page.evaluate(() => window.__heap), workerHeapPeaks: sampler.peaks, measures: await measures(page) };
  log('install', JSON.stringify(results.install));
  save();
  if (phase === 'install') { await ctx.close(); await browser.close(); process.exit(0); }
}

if (phase === 'post') {
  const ctx = await persistent();
  const page = await ctx.newPage();
  await page.bringToFront();
  const consoleErrors = [];
  page.on('console', (m) => { if (m.type() === 'error') consoleErrors.push(m.text().slice(0, 300)); });
  await page.goto(BASE + '/');
  await waitServices(page);
  results.coldStartMeasures = await measures(page);
  results.afterInstall = await step('estimate', () => page.evaluate(async () => {
    const est = await navigator.storage.estimate();
    const usage = est.usage; const details = est.usageDetails ?? null;
    const files = [];
    try { const root = await navigator.storage.getDirectory(); for await (const [name] of root.entries()) files.push(name); } catch (e) { files.push('err ' + e); }
    return { usage, quota: est.quota, details, opfsRoot: files, heap: performance.memory?.usedJSHeapSize ?? null };
  }));
  log('afterInstall', JSON.stringify(results.afterInstall));
  save();
  // search p50/p95: 3 warmups + 10 timed 'Umbreon', then 100 mixed
  results.search = await step('search-umbreon', () => page.evaluate(async () => {
    const s = window.__flashydexTest.services;
    const time = async (q) => { const t = performance.now(); const r = await s.catalog.searchCards(q); return { ms: performance.now() - t, n: r.page?.total ?? r.data.length }; };
    const pct = (a, p) => { const b = [...a].sort((x, y) => x - y); return Math.round(b[Math.min(b.length - 1, Math.floor(p * b.length))] * 10) / 10; };
    const first = await time({ q: 'Umbreon', language: 'en' });
    for (let i = 0; i < 2; i++) await time({ q: 'Umbreon', language: 'en' });
    const umb = []; let count = 0;
    for (let i = 0; i < 10; i++) { const r = await time({ q: 'Umbreon', language: 'en' }); umb.push(r.ms); count = r.n; }
    return { firstMs: Math.round(first.ms), umbreonCount: count, umbreon: { p50: pct(umb, 0.5), p95: pct(umb, 0.95), max: pct(umb, 1), samples: umb.map((x) => Math.round(x)) } };
  }));
  log('search', JSON.stringify(results.search));
  save();
  results.searchMixed = await step('search-mixed', () => page.evaluate(async () => {
    const s = window.__flashydexTest.services;
    const pct = (a, p) => { const b = [...a].sort((x, y) => x - y); return Math.round(b[Math.min(b.length - 1, Math.floor(p * b.length))] * 10) / 10; };
    const qs = ['Pikachu', 'Charizard', 'Umbreon', 'Mew', 'Eevee', 'Gardevoir', 'Rayquaza', 'Lugia', 'Gengar', 'Snorlax'];
    const mixed = []; const t0 = performance.now();
    for (let i = 0; i < 100 && performance.now() - t0 < 120000; i++) { const q = qs[i % qs.length]; const match = i % 3 === 0 ? 'contains' : 'prefix'; const t = performance.now(); await s.catalog.searchCards({ q: q.slice(0, 3 + (i % 4)), language: 'en', match }); mixed.push(performance.now() - t); }
    return { n: mixed.length, p50: pct(mixed, 0.5), p95: pct(mixed, 0.95), max: pct(mixed, 1) };
  }), 150000);
  log('searchMixed', JSON.stringify(results.searchMixed));
  save();
  results.domAt390 = await page.evaluate(() => ({ scrollWidth: document.documentElement.scrollWidth, innerWidth }));
  // reload persistence + startup gate
  await page.reload();
  await waitServices(page);
  await page.waitForTimeout(1500);
  results.afterReload = await page.evaluate(async () => {
    const s = window.__flashydexTest.services; const st = await s.install.status('en');
    const t = performance.now(); const r = await s.catalog.searchCards({ q: 'Umbreon', language: 'en' });
    return { installed: !!st.installed, version: st.installed?.version ?? null, searchMs: Math.round(performance.now() - t), hits: r.page?.total ?? r.data.length, heap: performance.memory?.usedJSHeapSize ?? null };
  });
  results.afterReload.measures = await measures(page);
  log('reload', JSON.stringify(results.afterReload));
  // second tab lock
  const page2 = await ctx.newPage();
  await page2.goto(BASE + '/');
  await page2.waitForTimeout(5000);
  results.secondTab = { text: (await page2.locator('#root').innerText()).slice(0, 300), workers: page2.workers().map((w) => w.url().replace(/^.*\//, '')), hasServices: await page2.evaluate(() => !!window.__flashydexTest?.services) };
  log('second tab', JSON.stringify(results.secondTab));
  await page2.close();
  results.installConsoleErrors = consoleErrors.slice(0, 20);
  save();
  await ctx.close();
}

if (phase === 'all' || phase === 'migrate') {
  const ctx = await newMobileContext();
  const page = await ctx.newPage();
  await page.bringToFront();
  await page.goto(BASE + '/harness.html');
  await page.evaluate(() => localStorage.setItem('fdx:dev-legacy-jeep', '1'));
  await page.goto(BASE + '/');
  await waitServices(page);
  const dumpFn = async () => {
    const s = window.__flashydexTest.services;
    const strip = (o) => JSON.parse(JSON.stringify(o));
    return strip({ settings: await s.settings.get(), customs: (await s.collection.listCustom({})).data, locations: (await s.collection.listLocations({})).data, groups: (await s.collection.listGroups({})).data, owned: await s.collection.list({ limit: 50 }) });
  };
  await page.evaluate(async () => {
    const s = window.__flashydexTest.services;
    await s.settings.update({ languages: ['en', 'ja'], disclaimerAcknowledged: true, onboardingCompleted: true, hideTcgPocket: true });
    const loc = await s.collection.createLocation({ name: 'Binder Ünïcode 001' });
    const c1 = await s.collection.createCustom({ name: 'Director Seed EN', language: 'en', localId: '007', setName: 'Seed Set', rarity: 'Rare', notes: 'zero-test 0' });
    const c2 = await s.collection.createCustom({ name: 'ディレクター 種', language: 'ja', localId: '001' });
    await s.collection.add({ language: 'en', customCardId: c1.id, variant: 'normal', storageLocationId: loc.id, notes: 'leading 0007', purchasePrice: { cents: 0, currency: 'USD' } });
    await s.collection.add({ language: 'ja', customCardId: c2.id, variant: 'normal' });
    await s.collection.add({ language: 'en', customCardId: c1.id, variant: 'normal', purchasePrice: { cents: 1234, currency: 'USD' } });
    await s.collection.createGroup({ name: 'Trade 0' });
  });
  const before = await page.evaluate(dumpFn);
  const legacyBytes = await page.evaluate(() => new Promise((res) => { const r = indexedDB.open('jeepSqliteStore'); r.onsuccess = () => { const g = r.result.transaction('databases', 'readonly').objectStore('databases').get('flashydex-userSQLite.db'); g.onsuccess = () => res(g.result?.length ?? null); g.onerror = () => res(null); }; r.onerror = () => res(null); }));
  await page.evaluate(() => localStorage.removeItem('fdx:dev-legacy-jeep'));
  const t0 = Date.now();
  await page.reload();
  const sawProgress = await page.getByText(/Moving your collection/i).first().waitFor({ timeout: 8000 }).then(() => true, () => false);
  await waitServices(page);
  const migrateMs = Date.now() - t0;
  const after = await page.evaluate(dumpFn);
  const m1 = await measures(page);
  await page.reload();
  await waitServices(page);
  const after2 = await page.evaluate(dumpFn);
  const roleState = await page.evaluate(() => new Promise((res) => { const r = indexedDB.open('flashydex-web-storage-v1'); r.onsuccess = () => { const db = r.result; const names = [...db.objectStoreNames]; try { const st = db.transaction(names[0], 'readonly').objectStore(names[0]); const g = st.getAll(); g.onsuccess = () => res({ names, values: JSON.parse(JSON.stringify(g.result)).map((v) => ({ user: v.user ?? v.value?.user, migration: v.migration ?? v.value?.migration })) }); } catch (e) { res({ names, err: String(e) }); } }; r.onerror = () => res(null); }));
  const legacyStill = await page.evaluate(() => new Promise((res) => { const r = indexedDB.open('jeepSqliteStore'); r.onsuccess = () => { const g = r.result.transaction('databases', 'readonly').objectStore('databases').get('flashydex-userSQLite.db'); g.onsuccess = () => res(g.result?.length ?? null); }; r.onerror = () => res(null); }));
  results.migration = { legacyBytes, sawProgress, migrateMs, equal: JSON.stringify(before) === JSON.stringify(after), equalAfterSecondReload: JSON.stringify(before) === JSON.stringify(after2), ownedTiles: before.owned.data.length, customs: before.customs.length, measures: m1, roleState, legacyKeyRetainedBytes: legacyStill };
  if (!results.migration.equal) { results.migration.before = before; results.migration.after = after; }
  log('migration', JSON.stringify(results.migration).slice(0, 1500));
  save();
  await ctx.close();
}

await browser.close();
log('done');
