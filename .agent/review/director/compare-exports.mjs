// Director check: compare ownedCards (+ every personal array) of two FlashyDex JSON exports, ignoring export metadata.
import { readFileSync } from 'node:fs';
const [a, b] = process.argv.slice(2).map((p) => JSON.parse(readFileSync(p, 'utf8')));
const find = (v, k) => {
  if (v === null || typeof v !== 'object') return undefined;
  if (k in v) return v[k];
  for (const c of Object.values(v)) { const f = find(c, k); if (f !== undefined) return f; }
  return undefined;
};
const canon = (rows) => JSON.stringify([...(rows ?? [])].sort((x, y) => String(x.id ?? JSON.stringify(x)).localeCompare(String(y.id ?? JSON.stringify(y)))));
let ok = true;
for (const k of ['ownedCards', 'customCards', 'acquisitions', 'grades', 'storageLocations', 'collectionGroups', 'collectionGroupMembers', 'priceSnapshots']) {
  const x = find(a, k), y = find(b, k);
  const same = canon(x) === canon(y);
  ok &&= same;
  console.log(k, (x ?? []).length, (y ?? []).length, same ? 'IDENTICAL' : 'DIFF');
}
const ids = (find(a, 'ownedCards') ?? []).map((r) => r.id).sort();
console.log('owned ids sample', ids.slice(0, 3).join(','));
console.log(ok ? 'ALL IDENTICAL' : 'MISMATCH');
