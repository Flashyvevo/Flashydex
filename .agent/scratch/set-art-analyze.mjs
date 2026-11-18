import fs from 'node:fs';
const root = 'C:/Projects/flashydex/tools/catalog-builder/.cache';
for (const l of ['en', 'ja']) {
  const d = fs.readdirSync(`${root}/${l}/sets`).map((f) => JSON.parse(fs.readFileSync(`${root}/${l}/sets/${f}`, "utf8")).data);
  const nl = d.filter((s) => !s.logo);
  console.log(l, d.length, 'nologo', nl.length, 'nosym', d.filter((s) => !s.symbol).length);
  console.log(JSON.stringify(Object.keys(d[0])));
  console.log(JSON.stringify({ ...d.find((s) => s.logo), cards: undefined }));
  console.log(nl.slice(0, 15).map((s) => [s.id, s.name, s.serie?.id, s.releaseDate, JSON.stringify(s.cardCount), JSON.stringify(s.tcgOnline), s.cards?.length, s.symbol ?? ''].join(' | ')).join('\n'));
}
