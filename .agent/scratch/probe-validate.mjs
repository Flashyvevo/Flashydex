import { chromium } from 'playwright';
const browser = await chromium.launch({ headless: true, args: ['--ignore-certificate-errors'] });
const ctx = await browser.newContext({ ignoreHTTPSErrors: true });
const page = await ctx.newPage();
page.on('console', (m) => { if (m.type() === 'error') console.log('[console.error]', m.text().slice(0, 200)); });
await page.goto('https://127.0.0.1:3200/harness.html#' + process.argv[2], { waitUntil: 'networkidle' }); await page.waitForTimeout(3000); page.on('framenavigated', f => console.log('NAV', f.url()));
const r = await page.evaluate(async () => {
  const h = await import('/src/platform/web-storage/harness.ts');
  await h.bootCore(location.hash.slice(1));
  const install = await h.installThroughCore({ language: 'en' });
  const ws = await import('/src/platform/web-sqlite/index.ts');
  const client = ws.getWebSqliteClient();
  const state = await h.poolState();
  const ref = state.roles.en.activeRef;
  const out = { install: { ok: install.ok, code: install.code, totalMs: install.totalMs, phases: install.phases }, ref, pragmas: {} };
  for (const cache of [32768]) {
    const d = await client.driver(ref, 'probe-' + cache, { mode: 'ro', create: false, role: 'validation', cacheKiB: cache });
    const q = async (sql) => { const t = performance.now(); const res = await d.proxy(sql, [], 'all'); return { ms: Math.round(performance.now() - t), rows: res.rows.length, first: String(res.rows[0]).slice(0, 40) }; };
    out.pragmas['cache' + cache] = {
      page_count: await q('PRAGMA page_count'),
      cache_size: await q('PRAGMA cache_size'),
      page_size: await q('PRAGMA page_size'),
      scan_cards_cold: await q("SELECT COUNT(*) FROM catalog_cards WHERE image_url LIKE 'zzz%'"),
      foreign_key_check: await q('PRAGMA foreign_key_check'),
      integrity_check: await q('PRAGMA integrity_check'),
    };
    await d.close();
  }
  return out;
});
console.log(JSON.stringify(r, null, 1));
await browser.close();
