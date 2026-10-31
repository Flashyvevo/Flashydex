// Director verification helper: read catalog_meta + counts from a raw catalog DB (read-only).
import Database from 'better-sqlite3';
const path = process.argv[2];
const db = new Database(path, { readonly: true });
console.log(JSON.stringify(db.prepare('SELECT * FROM catalog_meta').all()));
for (const t of ['catalog_sets', 'catalog_cards', 'catalog_variants', 'catalog_latest_prices']) {
  console.log(t, db.prepare(`SELECT COUNT(*) AS n FROM ${t}`).get().n);
}
