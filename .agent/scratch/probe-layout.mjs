// Usage: node .agent/scratch/probe-layout.mjs <out.json> [width] [height]
// Fresh profile, onboarding + dev pack, add Charizard V x2, measure screens. DOM only, no screenshots.
import { createRequire } from 'node:module';
import fs from 'node:fs';
const require = createRequire('C:/Projects/flashydex/package.json');
const { chromium } = require('@playwright/test');

const out = process.argv[2];
const W = Number(process.argv[3] || 390), H = Number(process.argv[4] || 844);
const BASE = 'http://127.0.0.1:3200';

const browser = await chromium.launch();
const ctx = await browser.newContext({ viewport: { width: W, height: H }, isMobile: W < 600, hasTouch: W < 600, deviceScaleFactor: 1, acceptDownloads: true });
const page = await ctx.newPage();
const sleep = (ms) => page.waitForTimeout(ms);

async function onboard() {
  await page.goto(BASE + '/');
  await page.waitForURL(/\/welcome$/, { timeout: 30000 });
  await page.getByTestId('welcome-start').click();
  await page.getByTestId('notice-continue').click();
  await page.getByTestId('languages-continue').click();
  await page.getByTestId('onboarding-finish').click();
  await page.getByText('English catalog ready').first().waitFor({ timeout: 120000 });
}
async function addCharizard() {
  await page.goto(BASE + '/add');
  await page.getByPlaceholder('Search name, number or id').first().fill('Charizard');
  const row = page.getByTestId('result-row').filter({ hasText: 'Charizard V' }).first();
  await row.waitFor({ timeout: 30000 });
  await row.click();
  await page.getByTestId('confirm-sheet').waitFor();
  await page.getByTestId('qty-input').fill('2');
  await page.getByTestId('add-submit').click();
  await page.getByRole('heading', { name: /Added Charizard V/ }).waitFor({ timeout: 20000 });
}

const MEASURE = () => {
  const vis = (el) => {
    const r = el.getBoundingClientRect();
    if (r.width === 0 || r.height === 0) return false;
    const cs = getComputedStyle(el);
    if (cs.visibility === 'hidden' || cs.display === 'none' || Number(cs.opacity) === 0) return false;
    return true;
  };
  const sel = 'button,a,input,select,h1,h2,h3,p,[role=tab],[role=button],[role=switch]';
  const seen = {};
  const items = [];
  for (const el of document.querySelectorAll(sel)) {
    if (!vis(el)) continue;
    const r = el.getBoundingClientRect();
    const cs = getComputedStyle(el);
    const tid = el.getAttribute('data-testid');
    const txt = (el.getAttribute('aria-label') || el.textContent || el.getAttribute('placeholder') || '').trim().replace(/\s+/g, ' ').slice(0, 28);
    let key = `${el.tagName.toLowerCase()}|${tid || ''}|${txt}`;
    seen[key] = (seen[key] || 0) + 1;
    key += `#${seen[key]}`;
    const inP = !!el.closest('p') && el.tagName === 'A';
    items.push({
      key, x: +r.x.toFixed(1), y: +(r.y + scrollY).toFixed(1), w: +r.width.toFixed(1), h: +r.height.toFixed(1),
      pad: `${cs.paddingTop} ${cs.paddingRight} ${cs.paddingBottom} ${cs.paddingLeft}`,
      margin: `${cs.marginTop} ${cs.marginRight} ${cs.marginBottom} ${cs.marginLeft}`,
      color: cs.color, bg: cs.backgroundColor, cursor: cs.cursor, font: `${cs.fontSize}/${cs.fontWeight}/${cs.lineHeight}`,
      inP
    });
  }
  // C7 offenders (hidden full-size <select> overlays measured via wrapper)
  const offenders = items.filter((i) => !i.inP && (i.w < 44 || i.h < 44) && /^(button|a|input|select)\|/.test(i.key) ).map((i) => `${i.key} ${i.w}x${i.h}`);
  // overlaps between interactive elements that don't contain each other; clipped text (button/a/h/p)
  const els = [...document.querySelectorAll('button,a,input,select')].filter(vis);
  const overlaps = [];
  for (let i = 0; i < els.length; i++) for (let j = i + 1; j < els.length; j++) {
    const a = els[i], b = els[j];
    if (a.contains(b) || b.contains(a)) continue;
    const ra = a.getBoundingClientRect(), rb = b.getBoundingClientRect();
    const ox = Math.min(ra.right, rb.right) - Math.max(ra.left, rb.left), oy = Math.min(ra.bottom, rb.bottom) - Math.max(ra.top, rb.top);
    if (ox > 2 && oy > 2) overlaps.push(`${a.getAttribute('data-testid') || a.textContent.trim().slice(0, 18)} x ${b.getAttribute('data-testid') || b.textContent.trim().slice(0, 18)} (${ox.toFixed(0)}x${oy.toFixed(0)})`);
  }
  const clipped = [...document.querySelectorAll('button,a,h1,h2,h3,p,span')].filter(vis).filter((e) => e.scrollWidth > e.clientWidth + 1 && getComputedStyle(e).overflowX !== 'visible').map((e) => (e.getAttribute('data-testid') || e.textContent.trim().slice(0, 24)) + ' sw' + e.scrollWidth + '/cw' + e.clientWidth);
  return { overlaps, clipped, items, offenders, scrollWidth: document.documentElement.scrollWidth, innerWidth };
};

const results = {};
async function snap(name) {
  await sleep(600);
  results[name] = await page.evaluate(MEASURE);
}
async function go(path, name) {
  await page.goto(BASE + path);
  await sleep(500);
  await snap(name || path);
}

await onboard();
await addCharizard();

await go('/', '/');
await go('/collection', '/collection');
// owned id
const ownedHref = await page.evaluate(() => document.querySelector('[data-testid=card-tile]')?.getAttribute('href') || document.querySelector('[data-testid=card-tile] a')?.getAttribute('href') || document.querySelector('[data-testid=card-tile]')?.closest('a')?.getAttribute('href'));
// filter sheet
await page.getByTestId('filter-button').click();
await snap('/collection#filters');
await page.keyboard.press('Escape');
await go('/add?x', '/add');
await page.getByPlaceholder('Search name, number or id').first().fill('Charizard');
await page.getByTestId('result-row').filter({ hasText: 'Charizard V' }).first().waitFor({ timeout: 30000 });
await snap('/add#results');
await page.getByTestId('result-row').filter({ hasText: 'Charizard V' }).first().click();
await page.getByTestId('confirm-sheet').waitFor();
await sleep(800);
await snap('/add#confirm');
await go('/sets');
await go('/sets/en/swsh3');
await go('/cards/en/swsh3-19');
await page.getByTestId('copy-row').first().click();
await page.getByTestId('copy-save').waitFor();
await snap('/cards/en/swsh3-19#copy-editor');
await page.getByTestId('copy-cond-NM').click(); await sleep(300);
var saveDirty = await page.evaluate(() => { const e = document.querySelector('[data-testid=copy-save]'); const r = e.getBoundingClientRect(); const c = getComputedStyle(e); return { w: r.width, h: r.height, color: c.color, pad: c.padding, disabled: e.disabled }; });
await go('/settings');
await go('/settings/data');
await go('/settings/catalog');
await go('/settings/locations');
if (ownedHref) await go(ownedHref, 'owned:' + ownedHref);

// tab bar (already in each snapshot as nav links); explicit extras
await go('/', '/#tabbar-extra');
const extra = {};
extra.scanLabel = await page.evaluate(() => {
  const l = document.querySelector('[data-testid=tab-scan-label]')?.getBoundingClientRect();
  const c = document.querySelector('[aria-label^="Scan"]')?.getBoundingClientRect();
  return { label: l && { top: l.top, bottom: l.bottom }, circle: c && { top: c.top, bottom: c.bottom }, innerHeight };
});
// P2 title vs back
extra.p2 = {};
for (const p of ['/settings/data', '/settings/catalog', '/settings/locations', '/sets/en/swsh3', '/cards/en/swsh3-19', ownedHref]) {
  if (!p) continue;
  await page.goto(BASE + p); await sleep(900);
  extra.p2[p] = await page.evaluate(() => {
    const t = document.querySelector('[data-testid=bar-title]')?.getBoundingClientRect();
    const b = document.querySelector('[data-testid=back-button]')?.getBoundingClientRect();
    if (!t || !b) return null;
    return { title: [t.left, t.right], back: [b.left, b.right], intersects: !(t.right <= b.left || b.right <= t.left || t.bottom <= b.top || b.bottom <= t.top) };
  });
}
// P4
await page.goto(BASE + '/add'); await sleep(500);
await page.getByPlaceholder('Search name, number or id').first().fill('Charizard');
await page.getByTestId('result-row').first().waitFor({ timeout: 30000 });
extra.p4 = await page.evaluate(() => ({
  langTops: ['lang-all', 'lang-en', 'lang-ja'].map((t) => document.querySelector(`[data-testid=${t}]`)?.getBoundingClientRect().top),
  thumbX: [...document.querySelectorAll('[data-testid=result-row] img')].map((i) => i.getBoundingClientRect().x)
}));
// P5
await page.getByTestId('result-row').filter({ hasText: 'Charizard V' }).first().click();
await page.getByTestId('confirm-sheet').waitFor(); await sleep(800);
extra.p5 = await page.evaluate(() => ({ tag: document.activeElement?.tagName, text: document.activeElement?.textContent?.slice(0, 30), tabindex: document.activeElement?.getAttribute('tabindex'), outlineStyle: getComputedStyle(document.activeElement).outlineStyle }));
await page.keyboard.press('Tab');
extra.p5tab = await page.evaluate(() => ({ tag: document.activeElement?.tagName, label: (document.activeElement?.getAttribute('aria-label') || document.activeElement?.textContent || '').slice(0, 30), outlineStyle: getComputedStyle(document.activeElement).outlineStyle, outlineWidth: getComputedStyle(document.activeElement).outlineWidth }));
// P3 + copy-save computed
await page.goto(BASE + '/settings/data'); await sleep(800);
extra.p3 = await page.evaluate(() => Object.fromEntries(['export-json', 'export-csv', 'backup-create', 'restore-file'].map((t) => { const e = document.querySelector(`[data-testid=${t}]`); const c = e && getComputedStyle(e); return [t, c && { cursor: c.cursor, bg: c.backgroundColor, opacity: c.opacity, ariaDisabled: e.getAttribute('aria-disabled'), cls: e.className.slice(0, 80) }]; })));

extra.saveDirty = saveDirty; results.__extra = extra;
fs.writeFileSync(out, JSON.stringify(results, null, 1));
console.log('wrote', out, Object.keys(results).length, 'screens');
await browser.close();
