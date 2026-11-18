import fs from 'node:fs';
const o = JSON.parse(fs.readFileSync('C:/Projects/flashydex/.agent/scratch/set-art-coverage.json','utf8'));
for (const l of ['en','ja']) console.log(l, 'none', o[l].none.length, 'published', o[l].none.filter(x=>x.published).length, 'shell', o[l].none.filter(x=>!x.published).length);
