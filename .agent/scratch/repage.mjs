// Experiment: re-page the EN catalog at 64 KiB and 16 KiB, zstd it, emit dev manifests for the harness.
import Database from 'better-sqlite3';
import { createHash } from 'node:crypto';
import { readFileSync, writeFileSync, mkdirSync, copyFileSync, statSync } from 'node:fs';
import { compress } from 'zstd-napi';

const src = 'C:/Projects/flashydex/tools/catalog-builder/dist-prod/catalog-en-2026.10.31.002.db';
const pub = 'C:/Projects/flashydex/apps/mobile/public/dev-packs';
const base = JSON.parse(readFileSync(`${pub}/full/catalog-manifest.json`, 'utf8'));
const version = '2026.10.31.002';
for (const kb of [64, 16]) {
  const dir = `${pub}/full${kb}`;
  mkdirSync(dir, { recursive: true });
  const dbPath = `${dir}/catalog-en-${version}.db`;
  copyFileSync(src, dbPath);
  const db = new Database(dbPath);
  db.pragma('journal_mode = DELETE');
  db.pragma(`page_size = ${kb * 1024}`);
  db.exec('VACUUM');
  const ps = db.pragma('page_size', { simple: true });
  const pc = db.pragma('page_count', { simple: true });
  db.close();
  const raw = readFileSync(dbPath);
  const zst = compress(raw, { compressionLevel: 19 });
  const packName = `catalog-en-${version}.db.zst`;
  writeFileSync(`${dir}/${packName}`, zst);
  const m = JSON.parse(JSON.stringify(base));
  m.targetVersion = version; m.languages = { en: { ...base.languages.en } };
  Object.assign(m.languages.en, {
    targetVersion: version, fullPackUrl: `/dev-packs/full${kb}/${packName}`, setIndexUrl: '/dev-packs/full/set-index-en.json',
    compressedBytes: zst.length, uncompressedBytes: raw.length,
    sha256: createHash('sha256').update(raw).digest('hex'), compressedSha256: createHash('sha256').update(zst).digest('hex')
  });
  writeFileSync(`${dir}/catalog-manifest.json`, JSON.stringify(m, null, 2));
  console.log(kb, 'KiB pages:', ps, 'page_count', pc, 'raw', raw.length, 'zst', zst.length);
}
