import { createHash } from 'node:crypto';
import { createReadStream, createWriteStream } from 'node:fs';
import { mkdir, readFile, rm } from 'node:fs/promises';
import { dirname, join } from 'node:path';
import { pipeline } from 'node:stream/promises';
import Database from 'better-sqlite3';
import { DecompressStream } from 'zstd-napi';
import { failedChecks } from './verify-checks';

interface Entry {
  sha256: string;
  uncompressedBytes: number;
  compressedBytes: number;
  compressedSha256?: string;
  schemaVersion: number;
  targetVersion: string;
  fullPackUrl: string;
  counts: { sets: number; cards: number; variants: number; prices: number; unpublishedSets: number };
}
interface Manifest { languages: Record<'en' | 'ja', Entry> }

const [manifestPath] = process.argv.slice(2);
if (!manifestPath) throw new Error('Usage: tsx src/verify-pack.ts <catalog-manifest.json>');
const manifest = JSON.parse(await readFile(manifestPath, 'utf8')) as Manifest;
const version = (manifest as Manifest & { targetVersion: string }).targetVersion;
const out: unknown[] = [];
for (const language of ['en', 'ja'] as const) {
  const entry = manifest.languages[language];
  const pack = join(dirname(manifestPath), `catalog-${language}-${version}.db.zst`);
  const raw = `${pack}.verify.db`;
  await mkdir(dirname(raw), { recursive: true });
  // Compressed artifact: byte length and SHA-256 must match the manifest before anything is trusted.
  const compressedHash = createHash('sha256');
  let compressedBytes = 0;
  for await (const chunk of createReadStream(pack)) { compressedHash.update(chunk); compressedBytes += chunk.length; }
  const compressedSha256 = compressedHash.digest('hex');
  await pipeline(createReadStream(pack), new DecompressStream(), createWriteStream(raw));
  const hash = createHash('sha256');
  let bytes = 0;
  for await (const chunk of createReadStream(raw)) { hash.update(chunk); bytes += chunk.length; }
  const db = new Database(raw, { readonly: true });
  const count = (table: string) => (db.prepare(`SELECT COUNT(*) n FROM ${table}`).get() as { n: number }).n;
  const counts = { sets: count('catalog_sets'), cards: count('catalog_cards'), variants: count('catalog_variants'), prices: count('catalog_latest_prices'), unpublishedSets: (db.prepare("SELECT COUNT(*) n FROM catalog_sets WHERE status='unpublished'").get() as { n: number }).n, cardsWithoutImage: (db.prepare('SELECT COUNT(*) n FROM catalog_cards WHERE image_url IS NULL').get() as { n: number }).n };
  const cards = db.prepare('SELECT id, name, local_id AS localId, rarity, image_url AS imageUrl, has_normal AS normal, has_reverse AS reverse, has_holo AS holo, has_first_edition AS firstEdition, w_promo AS wPromo FROM catalog_cards ORDER BY id LIMIT 5').all();
  const tail = db.prepare('SELECT id, name, local_id AS localId, rarity, image_url AS imageUrl, has_normal AS normal, has_reverse AS reverse, has_holo AS holo, has_first_edition AS firstEdition, w_promo AS wPromo FROM catalog_cards ORDER BY id DESC LIMIT 5').all();
  const integrity = db.pragma('integrity_check', { simple: true });
  const foreignKeyViolations = (db.pragma('foreign_key_check') as unknown[]).length;
  const meta = db.prepare('SELECT language, version, schema_version AS schemaVersion FROM catalog_meta').all() as Array<{ language: string; version: string; schemaVersion: number }>;
  const metaMatches = meta.length === 1 && meta[0]!.language === language && meta[0]!.version === entry.targetVersion && meta[0]!.schemaVersion === entry.schemaVersion;
  db.close();
  const checks = await Promise.all([...cards, ...tail].map(async (card: any) => {
    const api = await fetch(`https://api.tcgdex.net/v2/${language}/cards/${encodeURIComponent(card.id)}`);
    const live = await api.json() as any;
    return { id: card.id, ok: api.ok && card.name === live.name && card.localId === live.localId && card.rarity === live.rarity && card.imageUrl === (live.image ?? null) && card.normal === Number(Boolean(live.variants?.normal)) && card.reverse === Number(Boolean(live.variants?.reverse)) && card.holo === Number(Boolean(live.variants?.holo)) && card.firstEdition === Number(Boolean(live.variants?.firstEdition)) && card.wPromo === Number(Boolean(live.variants?.wPromo)) };
  }));
  const rawSha256 = hash.digest('hex');
  const { cardsWithoutImage: _cardsWithoutImage, ...manifestCounts } = counts;
  out.push({ language, sha256: rawSha256, shaMatches: rawSha256 === entry.sha256, bytes, bytesMatch: bytes === entry.uncompressedBytes, compressedSha256, compressedShaMatches: entry.compressedSha256 === undefined || compressedSha256 === entry.compressedSha256, compressedBytes, compressedBytesMatch: compressedBytes === entry.compressedBytes, fullPackUrlMatches: entry.fullPackUrl.endsWith(`/catalog-${language}-${version}.db.zst`), integrity, foreignKeyViolations, meta, metaMatches, counts, countsMatch: JSON.stringify(manifestCounts) === JSON.stringify(entry.counts), liveChecks: checks });
  await rm(raw, { force: true });
}
process.stdout.write(`${JSON.stringify(out, null, 2)}\n`);
const failed = failedChecks(out as Array<Record<string, unknown>>);
if (failed.length) {
  process.stderr.write(`verify-pack FAILED checks: ${failed.join(', ')}\n`);
  process.exitCode = 1;
}
