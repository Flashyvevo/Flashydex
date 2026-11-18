import fs from 'node:fs';
const root = 'C:/Projects/flashydex/tools/catalog-builder/.cache';
const load = (l) => fs.readdirSync(`${root}/${l}/sets`).map((f) => JSON.parse(fs.readFileSync(`${root}/${l}/sets/${f}`, 'utf8')).data);
const out = {};
const names = ['logo.webp', 'logo.png', 'symbol.webp', 'symbol.png'];
async function head(url) {
  for (let i = 0; i < 3; i++) {
    try { return (await fetch(url, { method: 'HEAD' })).status; } catch { /* retry */ }
  }
  return -1;
}
for (const l of ['en', 'ja']) {
  const nulls = load(l).filter((s) => !s.logo);
  const jobs = [];
  for (const s of nulls) for (const n of names) jobs.push({ l, s, n, url: `https://assets.tcgdex.net/${l}/${s.serie?.id}/${s.id}/${n}` });
  let i = 0;
  await Promise.all(Array.from({ length: 12 }, async () => {
    while (i < jobs.length) { const j = jobs[i++]; j.status = await head(j.url); }
  }));
  for (const j of jobs) (out[`${l}/${j.s.id}`] ??= { cards: j.s.cards.length, probes: {} }).probes[j.n] = j.status;
}
fs.writeFileSync('C:/Projects/flashydex/.agent/scratch/set-art-probe.json', JSON.stringify(out, null, 1));
for (const l of ['en', 'ja']) {
  const rows = Object.entries(out).filter(([k]) => k.startsWith(l + '/'));
  const c = (n) => rows.filter(([, v]) => v.probes[n] === 200).length;
  const any = rows.filter(([, v]) => v.probes['logo.webp'] === 200 || v.probes['logo.png'] === 200).length;
  const sym = rows.filter(([, v]) => !(v.probes['logo.webp'] === 200 || v.probes['logo.png'] === 200) && (v.probes['symbol.webp'] === 200 || v.probes['symbol.png'] === 200)).length;
  console.log(l, rows.length, 'logo.webp', c('logo.webp'), 'logo.png', c('logo.png'), 'symbol.webp', c('symbol.webp'), 'symbol.png', c('symbol.png'), 'anyLogo', any, 'symOnly', sym, 'errs', rows.filter(([, v]) => Object.values(v.probes).includes(-1)).length);
}
