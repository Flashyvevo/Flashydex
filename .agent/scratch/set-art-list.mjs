import fs from 'node:fs';
const root = 'C:/Projects/flashydex/tools/catalog-builder/.cache';
const load = (l) => fs.readdirSync(`${root}/${l}/sets`).map((f) => JSON.parse(fs.readFileSync(`${root}/${l}/sets/${f}`, 'utf8')).data);
const en = load('en'), ja = load('ja');
console.log('EN null logo:');
console.log(en.filter((s) => !s.logo).map((s) => `${s.id}|${s.name}|${s.serie?.id}|${s.cards.length}|sym=${s.symbol ? 1 : 0}`).join('\n'));
console.log('JA all:');
console.log(ja.map((s) => `${s.id}|${s.name}|${s.serie?.id}|${s.releaseDate}|${s.cardCount?.official}|cards=${s.cards.length}|sym=${s.symbol ? 1 : 0}`).join('\n'));
