import { createHash } from 'node:crypto';
import { mkdir, readFile, rename, stat, writeFile } from 'node:fs/promises';
import { dirname, join, resolve } from 'node:path';
import process from 'node:process';
import Database from 'better-sqlite3';
import { compress } from '@mongodb-js/zstd';

const API = 'https://api.tcgdex.net/v2';
const SCHEMA_VERSION = 1;
const BUILDER_VERSION = '0.0.0';

type Language = 'en' | 'ja';
type Json = Record<string, unknown>;
type SetBrief = Json & { id: string; name: string; cardCount?: { official?: number; total?: number } };
type CardBrief = Json & { id: string; localId: string; name: string; image?: string };
type CardDetail = Json & { id: string; localId: string; name: string; set: { id: string }; variants?: Record<string, boolean>; variants_detailed?: Json[] };

type Options = { language: Language; sets?: string[]; outDir: string };

type Counts = { sets: number; cards: number; variants: number; prices: number; unpublishedSets: number };

function usage(): never {
  throw new Error('Usage: npm run catalog:build -- --lang en [--sets swsh3,sv1] [--out dist/]');
}

function parseArgs(argv: string[]): Options {
  let language: Language | undefined;
  let sets: string[] | undefined;
  let outDir = 'dist';
  for (let index = 0; index < argv.length; index += 1) {
    const value = argv[index];
    if (value === '--lang') {
      const candidate = argv[++index];
      if (candidate !== 'en' && candidate !== 'ja') usage();
      language = candidate;
    } else if (value === '--sets') {
      sets = argv[++index]?.split(',').map((entry) => entry.trim()).filter(Boolean);
      if (!sets?.length) usage();
    } else if (value === '--out') {
      outDir = argv[++index] ?? usage();
    } else usage();
  }
  if (!language) usage();
  return { language, sets, outDir: resolve(outDir) };
}

function normalize(value: string): string { return value.normalize('NFKC').toLowerCase(); }
function localIdSort(value: string): string { return value.replace(/\d+/g, (digits) => digits.padStart(12, '0')); }
function now(): string { return new Date().toISOString(); }
function sha256(bytes: Uint8Array): string { return createHash('sha256').update(bytes).digest('hex'); }
function rss(): number { return process.memoryUsage().rss; }
function urlFor(language: Language, path: string): string { return `${API}/${language}/${path.split('/').map(encodeURIComponent).join('/')}`; }

async function fetchJson<T>(url: string, cachePath?: string): Promise<T> {
  if (cachePath) {
    try { return JSON.parse(await readFile(cachePath, 'utf8')) as T; } catch { /* fetch below */ }
  }
  let lastError: unknown;
  for (let attempt = 0; attempt < 4; attempt += 1) {
    try {
      const response = await fetch(url, { headers: { 'User-Agent': 'FlashyDex catalog builder/0.0.0' } });
      if (!response.ok) throw new Error(`${response.status} ${response.statusText} for ${url}`);
      const data = await response.json() as T;
      if (cachePath) {
        await mkdir(dirname(cachePath), { recursive: true });
        await writeFile(cachePath, JSON.stringify(data));
      }
      return data;
    } catch (error) {
      lastError = error;
      await new Promise((resolveDelay) => setTimeout(resolveDelay, 500 * (2 ** attempt)));
    }
  }
  throw lastError instanceof Error ? lastError : new Error(String(lastError));
}

async function mapConcurrent<T, R>(items: readonly T[], limit: number, mapper: (item: T) => Promise<R>): Promise<R[]> {
  const output = new Array<R>(items.length);
  let cursor = 0;
  await Promise.all(Array.from({ length: Math.min(limit, items.length) }, async () => {
    while (true) {
      const current = cursor++;
      if (current >= items.length) return;
      output[current] = await mapper(items[current]);
    }
  }));
  return output;
}

function canonicalVariant(row: Json): { key: string; variant: string; detail: string } {
  const type = String(row.type ?? 'normal');
  const subtype = String(row.subtype ?? '');
  const foil = String(row.foil ?? '');
  const size = String(row.size ?? 'standard');
  const stamps = Array.isArray(row.stamp) ? row.stamp.map(String).sort() : [];
  const normalizedStamps = stamps.join('|').toLowerCase().replace(/[ _]/g, '-');
  let variant = type === 'reverse' ? 'reverse_holo' : type === 'holo' ? 'holo' : 'normal';
  if (subtype === 'shadowless') variant = 'shadowless';
  else if (normalizedStamps.includes('1st-edition') || normalizedStamps.includes('1st-edition')) variant = 'first_edition';
  else if (stamps.length > 0 || foil || size !== 'standard') variant = 'promo_stamped';
  const detail = [subtype, foil, size !== 'standard' ? size : '', stamps.join(',')].filter(Boolean).join(' · ');
  return { key: sha256(Buffer.from(JSON.stringify([type, subtype, foil, size, stamps]))), variant, detail };
}

function cents(value: unknown): number | null {
  if (typeof value !== 'number' || !Number.isFinite(value)) return null;
  return Math.round(value * 100);
}

function insertPrices(db: Database.Database, language: Language, card: CardDetail, variant: { variant: string; detail: string; key: string }, detail: Json, capturedAt: string): number {
  const pricing = detail.pricing as Json | undefined;
  if (!pricing) return 0;
  let count = 0;
  const cardmarket = pricing.cardmarket as Json | null | undefined;
  if (cardmarket && typeof cardmarket === 'object') {
    const values = [cents(cardmarket.low), cents(cardmarket.avg), null, cents(cardmarket['avg-holo']), cents(cardmarket.trend ?? cardmarket['trend-holo'])];
    if (values.some((value) => value !== null)) {
      db.prepare(`INSERT OR REPLACE INTO catalog_latest_prices VALUES (?, ?, 'cardmarket', ?, ?, ?, 'EUR', ?, ?, ?, ?, ?, ?, ?)`)
        .run(language, card.id, variant.variant, variant.detail, variant.key, values[0], values[1], values[2], values[3], values[4], typeof cardmarket.updated === 'string' ? cardmarket.updated : null, capturedAt);
      count += 1;
    }
  }
  const tcgplayer = pricing.tcgplayer as Json | null | undefined;
  if (tcgplayer && typeof tcgplayer === 'object') {
    const preferred = variant.variant === 'reverse_holo' ? 'reverse-holofoil' : variant.variant === 'first_edition' ? '1st-edition-holofoil' : variant.variant === 'holo' || variant.detail.includes('pokeball') || variant.detail.includes('masterball') ? 'holofoil' : 'normal';
    const quote = tcgplayer[preferred] as Json | undefined;
    if (quote && typeof quote === 'object') {
      const values = [cents(quote.lowPrice), cents(quote.midPrice), cents(quote.highPrice), cents(quote.marketPrice)];
      if (values.some((value) => value !== null)) {
        db.prepare(`INSERT OR REPLACE INTO catalog_latest_prices VALUES (?, ?, 'tcgplayer', ?, ?, ?, 'USD', ?, ?, ?, ?, NULL, ?, ?)`)
          .run(language, card.id, variant.variant, variant.detail, `${variant.key}:${preferred}`, values[0], values[1], values[2], values[3], typeof tcgplayer.updated === 'string' ? tcgplayer.updated : null, capturedAt);
        count += 1;
      }
    }
  }
  return count;
}

async function main(): Promise<void> {
  const options = parseArgs(process.argv.slice(2));
  const started = performance.now();
  const startRss = rss();
  let peakRss = startRss;
  const sample = () => { peakRss = Math.max(peakRss, rss()); };
  const cacheRoot = resolve('.cache', options.language);
  const list = await fetchJson<SetBrief[]>(urlFor(options.language, 'sets'), join(cacheRoot, '_sets.json'));
  const selected = options.sets ? list.filter((set) => options.sets?.includes(set.id)) : list;
  if (options.sets && selected.length !== options.sets.length) throw new Error('At least one requested set was not present in TCGdex set list.');
  const setDetails = await mapConcurrent(selected, 8, (set) => fetchJson<Json>(urlFor(options.language, `sets/${set.id}`), join(cacheRoot, '_sets', `${set.id}.json`)));
  const briefs = setDetails.flatMap((set) => (Array.isArray(set.cards) ? set.cards as CardBrief[] : []).map((card) => ({ card, set })));
  const cards = await mapConcurrent(briefs, 8, ({ card }) => fetchJson<CardDetail>(urlFor(options.language, `cards/${card.id}`), join(cacheRoot, `${card.id}.json`)));
  sample();

  await mkdir(options.outDir, { recursive: true });
  const version = new Date().toISOString().slice(0, 10).replaceAll('-', '.') + '.001';
  const dbPath = join(options.outDir, `catalog-${options.language}-${version}.db`);
  const db = new Database(dbPath);
  const schema = await readFile(new URL('./schema.sql', import.meta.url), 'utf8');
  db.exec(schema);
  const builtAt = now();
  const insertSet = db.prepare(`INSERT INTO catalog_sets VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`);
  let unpublishedSets = 0;
  for (const set of setDetails) {
    const cardsInSet = Array.isArray(set.cards) ? set.cards : [];
    const status = cardsInSet.length === 0 ? 'unpublished' : 'published';
    if (status === 'unpublished') unpublishedSets += 1;
    const symbol = typeof set.symbol === 'string' ? set.symbol.replace('/univ/', `/${options.language}/`) + '.webp' : null;
    insertSet.run(options.language, set.id, set.name, normalize(String(set.name)), (set.serie as Json | undefined)?.id ?? null, status, set.releaseDate ?? null, (set.cardCount as Json | undefined)?.official ?? null, (set.cardCount as Json | undefined)?.total ?? null, typeof set.logo === 'string' ? `${set.logo}.webp` : null, symbol, JSON.stringify(set), builtAt);
  }
  const insertCard = db.prepare(`INSERT INTO catalog_cards VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`);
  const insertVariant = db.prepare(`INSERT INTO catalog_variants VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`);
  let variants = 0;
  let prices = 0;
  for (const card of cards) {
    const flags = card.variants ?? {};
    const variantRows = Array.isArray(card.variants_detailed) && card.variants_detailed.length ? card.variants_detailed : [{ type: 'normal', size: 'standard' }];
    insertCard.run(options.language, card.id, card.set.id, card.localId, localIdSort(card.localId), card.name, normalize(card.name), card.rarity ?? null, card.category ?? null, card.illustrator ?? null, card.image ?? null, Number(Boolean(flags.normal)), Number(Boolean(flags.holo)), Number(Boolean(flags.reverse)), Number(Boolean(flags.firstEdition)), Number(Boolean(flags.wPromo)), JSON.stringify(Object.entries(flags).filter(([, value]) => value).map(([key]) => key)), JSON.stringify(card), builtAt, typeof card.updated === 'string' ? card.updated : null);
    for (const row of variantRows) {
      const variant = canonicalVariant(row);
      insertVariant.run(options.language, card.id, variant.key, variant.variant, variant.detail, row.type ?? null, row.subtype ?? null, row.foil ?? null, row.size ?? null, JSON.stringify(row.stamp ?? []), row.variantId ?? null, JSON.stringify(row));
      variants += 1;
      prices += insertPrices(db, options.language, card, variant, row, builtAt);
    }
  }
  const fingerprint = sha256(Buffer.from(schema));
  db.prepare(`INSERT INTO schema_migrations VALUES (1, ?, ?)`).run(builtAt, fingerprint);
  db.prepare(`INSERT INTO catalog_meta VALUES (1, ?, ?, ?, ?, ?, ?, ?, ?, ?)`).run(options.language, version, SCHEMA_VERSION, builtAt, BUILDER_VERSION, setDetails.length, cards.length, builtAt, fingerprint);
  db.pragma('foreign_keys = ON');
  db.exec('VACUUM');
  db.close();
  sample();

  const bytes = await readFile(dbPath);
  const crawlDurationMs = Math.round(performance.now() - started);
  const compressStarted = performance.now();
  const compressed = await compress(bytes, 19);
  const compressDurationMs = Math.round(performance.now() - compressStarted);
  const zstPath = `${dbPath}.zst`;
  await writeFile(zstPath, compressed);
  const counts: Counts = { sets: setDetails.length, cards: cards.length, variants, prices, unpublishedSets };
  const manifest = {
    manifestVersion: 1,
    currentVersion: null,
    targetVersion: version,
    builtAt,
    languages: {
      [options.language]: {
        currentVersion: null,
        targetVersion: version,
        fullPackUrl: `https://github.com/Flashyvevo/flashydex/releases/download/catalog-v${version}/catalog-${options.language}-${version}.db.zst`,
        compressedBytes: compressed.byteLength,
        uncompressedBytes: bytes.byteLength,
        sha256: sha256(bytes),
        compressedSha256: sha256(compressed),
        schemaVersion: SCHEMA_VERSION,
        builtAt,
        counts
      }
    }
  };
  const metrics = { language: options.language, version, compressedBytes: compressed.byteLength, uncompressedBytes: bytes.byteLength, compressionRatio: Number((compressed.byteLength / bytes.byteLength).toFixed(4)), crawlDurationMs, compressDurationMs, peakRssBytes: Math.max(peakRss, rss()), installedFootprintBytes: bytes.byteLength, counts };
  await writeFile(join(options.outDir, 'catalog-manifest.json'), `${JSON.stringify(manifest, null, 2)}\n`);
  await writeFile(join(options.outDir, `catalog-${options.language}-${version}.metrics.json`), `${JSON.stringify(metrics, null, 2)}\n`);
  await rename(dbPath, join(options.outDir, `catalog-${options.language}.db`));
  console.log(JSON.stringify({ db: join(options.outDir, `catalog-${options.language}.db`), zst: zstPath, metrics }, null, 2));
}

void main().catch((error: unknown) => { console.error(error); process.exitCode = 1; });
