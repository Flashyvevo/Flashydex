import fs from 'node:fs';
const r = JSON.parse(fs.readFileSync(process.argv[2], 'utf8'));
console.log(JSON.stringify(r.__extra));
for (const [k, v] of Object.entries(r)) if (k !== '__extra') console.log(k, v.items.length, 'sw', v.scrollWidth, 'iw', v.innerWidth, 'offenders', JSON.stringify(v.offenders));
for (const [k, v] of Object.entries(r)) if (k !== '__extra') console.log(k, 'overlaps', JSON.stringify(v.overlaps), 'clipped', JSON.stringify(v.clipped));
