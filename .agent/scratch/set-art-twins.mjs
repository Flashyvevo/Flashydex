import fs from 'node:fs';
const root = 'C:/Projects/flashydex/tools/catalog-builder/.cache';
const load = (l) => fs.readdirSync(`${root}/${l}/sets`).map((f) => JSON.parse(fs.readFileSync(`${root}/${l}/sets/${f}`, 'utf8')).data);
const en = load('en'), ja = load('ja');
console.log('EN sets (id|name|serie|date|official|logo):');
console.log(en.filter((s) => ['sv', 'swsh', 'sm', 'xy', 'bw', 'me'].includes(s.serie?.id)).sort((a, b) => a.releaseDate.localeCompare(b.releaseDate)).map((s) => `${s.id}|${s.name}|${s.serie.id}|${s.releaseDate}|${s.cardCount.official}|${s.logo ? 'L' : '-'}`).join('\n'));
console.log('AUTO official-count matches:');
for (const j of ja) {
  const c = en.filter((e) => e.cardCount.official === j.cardCount.official && e.cardCount.official > 0 && e.logo);
  if (c.length) console.log(`${j.id}(${j.cardCount.official}) -> ${c.map((e) => e.id).join(',')}`);
}
