import { chromium } from 'playwright';
const b = await chromium.launch(); const p = await b.newPage({ viewport: { width: 390, height: 844 } });
await p.goto('https://flashydex.netlify.app/scan', { waitUntil: 'networkidle' }); await p.waitForTimeout(2500);
console.log('URL', p.url()); console.log((await p.locator('body').innerText()).replace(/\s+/g,' ').slice(0,400));
console.log('inputs', await p.locator('input[type=file]').evaluateAll(els => els.map(e => ({accept:e.accept, capture:e.getAttribute('capture')}))));
console.log('tab-scan', await p.getByTestId('tab-scan').getAttribute('aria-label').catch(()=>'none'));
await b.close();
