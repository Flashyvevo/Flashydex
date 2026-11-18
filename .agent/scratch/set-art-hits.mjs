import fs from 'node:fs';
const o = JSON.parse(fs.readFileSync('C:/Projects/flashydex/.agent/scratch/set-art-probe.json','utf8'));
for (const [k,v] of Object.entries(o)) if (Object.values(v.probes).includes(200)) console.log(k, JSON.stringify(v.probes));
for (const u of ['https://assets.tcgdex.net/en/sv/sv01/logo.webp','https://assets.tcgdex.net/ja/SV/SV1S/logo.webp','https://assets.tcgdex.net/ja/SV/SV1S/logo.png','https://assets.tcgdex.net/ja/SV/SV1S/symbol.webp','https://assets.tcgdex.net/ja/SV/SV1S/logo']) { const r = await fetch(u); console.log(u, r.status, r.headers.get('content-type')); }
