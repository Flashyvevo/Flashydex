import { chromium, devices } from 'playwright';
import { readFileSync } from 'node:fs';
const b = await chromium.launch();
const ctx = await b.newContext({ ...devices['iPhone 14'], permissions: [] });
const p = await ctx.newPage();
const log = [];
p.on('console', m => { if (m.type()!=='log') log.push(`[${m.type()}] ${m.text().slice(0,300)}`); });
p.on('pageerror', e => log.push('PAGEERR '+String(e).slice(0,300)));
p.on('response', r => { if (r.url().includes('/api/')) log.push(`${r.status()} ${r.url().split('/').slice(-2).join('/')}`); });
p.on('requestfailed', r => { if (r.url().includes('/api/')) log.push('REQFAIL '+r.url()+' '+r.failure()?.errorText); });
const body = async () => (await p.locator('body').innerText()).replace(/\s+/g,' ');
await p.goto('https://flashydex.netlify.app/', { waitUntil: 'networkidle', timeout: 90000 });
await p.getByTestId('welcome-start').click(); await p.getByTestId('notice-continue').click(); await p.getByTestId('languages-continue').click();
await p.getByTestId('onboarding-finish').click();
await p.waitForFunction(() => /English catalog ready/.test(document.body.innerText), null, { timeout: 300000 });
await p.goto('https://flashydex.netlify.app/scan', { waitUntil: 'networkidle' }); await p.waitForTimeout(1500);
console.log('SCAN:', (await body()).slice(0,250));
// build a phone-size JPEG (4032x3024) with the reference card composited, inside the page
const ref = readFileSync('C:/Projects/flashydex/services/recognition/data/cache/images/en/swsh3-136.webp');
const big = await p.evaluate(async (bytes) => {
  const blob = new Blob([new Uint8Array(bytes)], { type: 'image/webp' });
  const img = await createImageBitmap(blob);
  const c = document.createElement('canvas'); c.width = 3024; c.height = 4032; const g = c.getContext('2d');
  g.fillStyle = '#6b5a42'; g.fillRect(0,0,c.width,c.height);
  for (let i=0;i<4000;i++){ g.fillStyle=`rgba(0,0,0,${Math.random()*0.08})`; g.fillRect(Math.random()*3024, Math.random()*4032, 40, 40); }
  const w = 2000, h = Math.round(w * img.height / img.width);
  g.save(); g.translate(1512, 2016); g.rotate(0.05); g.drawImage(img, -w/2, -h/2, w, h); g.restore();
  const out = await new Promise(r => c.toBlob(r, 'image/jpeg', 0.92));
  return Array.from(new Uint8Array(await out.arrayBuffer()));
}, Array.from(ref));
console.log('photo bytes', big.length);
const [chooser] = await Promise.all([p.waitForEvent('filechooser'), p.getByTestId('scan-take').click()]);
await chooser.setFiles({ name: 'IMG_0001.jpeg', mimeType: 'image/jpeg', buffer: Buffer.from(big) });
const t0 = Date.now();
for (let i=0;i<40;i++){ await p.waitForTimeout(1000); const t = await body(); if (/Confirm|possibilit|couldn|offline|busy|try again|unexpected|too large|wasn.t|error/i.test(t)) break; }
console.log('after', Math.round((Date.now()-t0)/1000),'s:', (await body()).slice(0,500));
console.log(log.join('\n'));
await b.close();
