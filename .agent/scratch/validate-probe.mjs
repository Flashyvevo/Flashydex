// Director probe: decode the full EN pack and time validation pragmas at different cache sizes (Node, sqlite-wasm in-memory is not
// representative of OPFS, so this uses node:sqlite if available, else reports).
import { readFileSync, writeFileSync } from 'node:fs';
import { decompress } from 'fzstd';
const out = process.argv[2];
const b = readFileSync('C:/Projects/flashydex/apps/mobile/public/dev-packs/full/catalog-en-2026.10.31.001.db.zst');
writeFileSync(out, decompress(new Uint8Array(b)));
const { DatabaseSync } = await import('node:sqlite');
for (const cs of [-1024, -4096, -32768]) {
  const db = new DatabaseSync(out, { readOnly: true });
  db.exec(`PRAGMA cache_size=${cs}`);
  let t = performance.now();
  const r = db.prepare('PRAGMA integrity_check').all();
  const a = performance.now() - t;
  t = performance.now();
  const f = db.prepare('PRAGMA foreign_key_check').all();
  const fk = performance.now() - t;
  console.log(cs, 'integrity_ms', Math.round(a), JSON.stringify(r[0]), 'fk_ms', Math.round(fk), f.length, JSON.stringify(db.prepare('PRAGMA page_size').get()), JSON.stringify(db.prepare('PRAGMA page_count').get()));
  db.close();
}
