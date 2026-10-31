import fs from 'node:fs';
const a = JSON.parse(fs.readFileSync(process.argv[2], 'utf8'));
const b = JSON.parse(fs.readFileSync(process.argv[3], 'utf8'));
for (const k of Object.keys(a)) {
  if (k === '__extra') continue;
  console.log(k, 'before offenders', JSON.stringify(a[k].offenders));
  // normalise overlap pairs by name only (drop sizes)
  const strip = (s) => s.replace(/ \(\d+x\d+\)$/, '');
  const sa = new Set(a[k].overlaps.map(strip)), sb = new Set(b[k].overlaps.map(strip));
  const added = [...sb].filter((x) => !sa.has(x));
  const removed = [...sa].filter((x) => !sb.has(x));
  const ca = new Set(a[k].clipped), cb = new Set(b[k].clipped);
  console.log('  overlaps +', JSON.stringify(added), '-', JSON.stringify(removed), '| clipped +', JSON.stringify([...cb].filter((x) => !ca.has(x))), '-', JSON.stringify([...ca].filter((x) => !cb.has(x))));
}
