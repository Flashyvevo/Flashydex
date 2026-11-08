/**
 * Read-only probe: prints which TCGdex `pricing` fields are present / null for a few cards, and which of them the
 * catalog builder currently drops. Writes nothing; does not import or alter the build pipeline.
 *
 *   npx tsx tools/catalog-builder/src/pricing-probe.ts [lang/cardId ...]
 *   e.g. npx tsx tools/catalog-builder/src/pricing-probe.ts en/swsh3-136 ja/SV1S-001
 */
import process from 'node:process';

const API = 'https://api.tcgdex.net/v2';
const DEFAULT_CARDS = ['en/swsh3-136', 'en/sv01-001', 'en/base1-4', 'en/xy1-1', 'ja/SV1S-001'];

const CARDMARKET_FIELDS = ['avg', 'low', 'trend', 'avg1', 'avg7', 'avg30', 'avg-holo', 'low-holo', 'trend-holo', 'avg1-holo', 'avg7-holo', 'avg30-holo'];
const TCGPLAYER_FIELDS = ['lowPrice', 'midPrice', 'highPrice', 'marketPrice', 'directLowPrice'];
/** What build-db / tcgdex prices.ts persists today: tcgplayer low/mid/high/market; cardmarket low/avg(->mid)/trend (+ -holo twins). */
const STORED_CARDMARKET = new Set(['avg', 'low', 'trend', 'avg-holo', 'low-holo', 'trend-holo']);
const STORED_TCGPLAYER = new Set(['lowPrice', 'midPrice', 'highPrice', 'marketPrice']);

type Json = Record<string, unknown>;
const isRecord = (v: unknown): v is Json => typeof v === 'object' && v !== null && !Array.isArray(v);

function describeValue(v: unknown): string {
  return v === undefined ? 'absent' : v === null ? 'null' : String(v);
}

async function probe(spec: string): Promise<void> {
  const response = await fetch(`${API}/${spec.replace('/', '/cards/')}`);
  if (!response.ok) {
    console.log(`\n== ${spec}: HTTP ${response.status}`);
    return;
  }
  const card = (await response.json()) as Json;
  const pricing = isRecord(card.pricing) ? card.pricing : null;
  console.log(`\n== ${spec} ${String(card.name)}  (fetched ${new Date().toISOString()})`);
  if (!pricing) return void console.log('   pricing: null/absent');

  const cm = isRecord(pricing.cardmarket) ? pricing.cardmarket : null;
  console.log(cm ? `   cardmarket  unit=${describeValue(cm.unit)} updated=${describeValue(cm.updated)} idProduct=${describeValue(cm.idProduct)}` : '   cardmarket: null/absent');
  if (cm) {
    for (const field of CARDMARKET_FIELDS) console.log(`     ${field.padEnd(11)} ${describeValue(cm[field]).padEnd(8)} ${STORED_CARDMARKET.has(field) ? 'stored' : 'DROPPED'}`);
  }
  const tp = isRecord(pricing.tcgplayer) ? pricing.tcgplayer : null;
  console.log(tp ? `   tcgplayer   unit=${describeValue(tp.unit)} updated=${describeValue(tp.updated)}` : '   tcgplayer: null/absent');
  if (tp) {
    for (const [key, entry] of Object.entries(tp)) {
      if (!isRecord(entry)) continue;
      console.log(`     [${key}] productId=${describeValue(entry.productId)}`);
      for (const field of TCGPLAYER_FIELDS) console.log(`       ${field.padEnd(15)} ${describeValue(entry[field]).padEnd(8)} ${STORED_TCGPLAYER.has(field) ? 'stored' : 'DROPPED'}`);
    }
  }
  const detailed = Array.isArray(card.variants_detailed) ? card.variants_detailed : [];
  console.log(`   variants_detailed: ${detailed.length} row(s), per-row pricing on ${detailed.filter((row) => isRecord(row) && isRecord(row.pricing)).length}`);
}

async function main(): Promise<void> {
  const specs = process.argv.slice(2);
  for (const spec of specs.length > 0 ? specs : DEFAULT_CARDS) await probe(spec); // sequential: be considerate to the public API
}

void main().catch((error: unknown) => {
  console.error(error);
  process.exitCode = 1;
});
