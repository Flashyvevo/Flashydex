import fs from 'node:fs';
const a = JSON.parse(fs.readFileSync(process.argv[2], 'utf8'));
const b = JSON.parse(fs.readFileSync(process.argv[3], 'utf8'));
let n = 0;
for (const k of Object.keys(a)) {
  if (k === '__extra') continue;
  const ma = new Map(a[k].items.map((i) => [i.key, i])), mb = new Map(b[k]?.items.map((i) => [i.key, i]) || []);
  for (const [key, x] of ma) {
    const y = mb.get(key);
    if (!y) { console.log(`[${k}] MISSING after: ${key}`); n++; continue; }
    const d = [];
    for (const f of ['x', 'y', 'w', 'h']) if (Math.abs(x[f] - y[f]) > 2) d.push(`${f} ${x[f]}→${y[f]}`);
    for (const f of ['color', 'bg', 'cursor', 'pad', 'margin']) if (x[f] !== y[f] && (f !== 'pad' && f !== 'margin' || true)) d.push(`${f} ${x[f]}→${y[f]}`);
    if (d.length) { console.log(`[${k}] ${key}: ${d.join(' | ')}`); n++; }
  }
  for (const key of mb.keys()) if (!ma.has(key)) { console.log(`[${k}] NEW after: ${key}`); n++; }
}
console.log('diff count', n);
