import { chromium, devices } from 'playwright';
import { readFileSync } from 'node:fs';
const b = await chromium.launch(); const ctx = await b.newContext({ ...devices['iPhone 14'] }); const p = await ctx.newPage();
const api=[]; p.on('response', r => { if (r.url().includes('/api/')) api.push(r.status()+' '+r.url().split('/').pop()); });
const body = async () => (await p.locator('body').innerText()).replace(/\s+/g,' ');
await p.goto('https://flashydex.netlify.app/', { waitUntil: 'networkidle', timeout: 90000 });
await p.getByTestId('welcome-start').click(); await p.getByTestId('notice-continue').click(); await p.getByTestId('languages-continue').click(); await p.getByTestId('onboarding-finish').click();
await p.waitForFunction(() => /English catalog ready/.test(document.body.innerText), null, { timeout: 300000 });
const mkPhoto = async (id) => { const ref = readFileSync(`C:/Projects/flashydex/services/recognition/data/cache/images/en/${id}.webp`);
  return Buffer.from(await p.evaluate(async (bytes) => { const img = await createImageBitmap(new Blob([new Uint8Array(bytes)],{type:'image/webp'}));
    const c=document.createElement('canvas'); c.width=3024;c.height=4032; const g=c.getContext('2d'); g.fillStyle='#2a2a2a'; g.fillRect(0,0,3024,4032);
    const w=2000,h=Math.round(w*img.height/img.width); g.save(); g.translate(1512,2016); g.rotate(0.06); g.drawImage(img,-w/2,-h/2,w,h); g.restore();
    const o=await new Promise(r=>c.toBlob(r,'image/jpeg',0.9)); return Array.from(new Uint8Array(await o.arrayBuffer())); }, Array.from(ref))); };
const scanOnce = async (id, viaScanAnother) => {
  if (!viaScanAnother) { await p.goto('https://flashydex.netlify.app/scan', { waitUntil: 'networkidle' }); await p.waitForTimeout(1500); }
  const photo = await mkPhoto(id);
  if (viaScanAnother) { await p.getByTestId('scan-another').click(); await p.waitForTimeout(800); }
  await p.getByTestId('scan-take-input').setInputFiles({ name: 'IMG.jpeg', mimeType: 'image/jpeg', buffer: photo });
  const t0=Date.now(); await p.waitForFunction(() => /Confirm & Add|possibilit|couldn|Try another/i.test(document.body.innerText), null, { timeout: 30000 });
  console.log(id, 'result in', Date.now()-t0, 'ms:', (await body()).match(/Card found.{0,80}|We found.{0,80}|couldn.{0,60}/i)?.[0]);
  await p.getByRole('button', { name: /Confirm & Add/ }).click(); await p.waitForTimeout(800);
  await p.getByRole('button', { name: /^Add/ }).last().click();
  await p.waitForFunction(() => /Added to collection/.test(document.body.innerText), null, { timeout: 15000 });
  console.log('  added; url', p.url());
  const notNow = p.getByRole('button', { name: 'Not now' }); if (await notNow.isVisible().catch(()=>false)) { await notNow.click(); console.log('  dismissed Protect sheet'); await p.waitForTimeout(500); }
};
await scanOnce('swsh3-136', false);
await scanOnce('swsh3-2', true);
console.log('still on /scan:', p.url().includes('/scan'));
await p.reload({ waitUntil: 'networkidle' }); await p.waitForTimeout(3000);
await p.goto('https://flashydex.netlify.app/collection', { waitUntil: 'networkidle' }); await p.waitForTimeout(2500);
const t = await body(); console.log('collection has Furret:', /Furret/.test(t), 'has', t.match(/\b(\w+)\b.{0,20}2\/189/)?.[0] ?? (/2\/189/.test(t)), 'cards text:', t.match(/\d+ cards?/)?.[0]);
console.log(api.join(' | ')); await b.close();
