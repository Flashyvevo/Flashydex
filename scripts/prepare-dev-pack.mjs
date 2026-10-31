// npm run catalog:dev-pack [-- --from tools/catalog-builder/dist] [--langs en,ja]
//
// Copies the catalog-builder output (swsh3 EN pack, SV2a JA pack when built) into apps/mobile/public/dev-packs/ and writes a
// DEV manifest whose URLs are same-origin relative (/dev-packs/...), served at /dev-packs/catalog-manifest.json.
// Director ruling D27: relative/http URLs are legal only in dev; public/dev-packs is stripped from production builds
// (apps/mobile/vite.config.ts). Nothing here touches the network.
import { createHash } from 'node:crypto';
import { copyFile, mkdir, readFile, readdir, rm, stat, writeFile } from 'node:fs/promises';
import { basename, join, resolve } from 'node:path';

const args = process.argv.slice(2);
const flag = (name, fallback) => { const i = args.indexOf(`--${name}`); return i >= 0 ? args[i + 1] : fallback; };
const from = resolve(flag('from', 'tools/catalog-builder/dist'));
const wanted = flag('langs', 'en,ja').split(',').map((s) => s.trim()).filter(Boolean);
const target = resolve('apps/mobile/public/dev-packs');
const MAX_PACK_BYTES = 1024 * 1024; // commit-size guard: dev packs must stay small

const sha256 = async (path) => createHash('sha256').update(await readFile(path)).digest('hex');

let source;
try {
  source = JSON.parse(await readFile(join(from, 'catalog-manifest.json'), 'utf8'));
} catch {
  console.error(`No catalog-manifest.json in ${from}. Build first, e.g.:\n  npm run catalog:build -- --lang en --sets swsh3 --out dist`);
  process.exit(1);
}

await mkdir(target, { recursive: true });
const keep = new Set(['catalog-manifest.json']);
const languages = {};
let rootTarget = null;
let rootBuiltAt = null;
const summary = [];

for (const language of wanted) {
  const entry = source.languages?.[language];
  if (!entry) { console.warn(`skip ${language}: not in the source manifest`); continue; }
  const pack = `catalog-${language}-${entry.targetVersion}.db.zst`;
  const metrics = `catalog-${language}-${entry.targetVersion}.metrics.json`;
  const index = `set-index-${language}.json`;
  for (const file of [pack, metrics, index]) {
    const sourcePath = join(from, file);
    await stat(sourcePath).catch(() => { throw new Error(`Missing ${sourcePath}`); });
    await copyFile(sourcePath, join(target, file));
    keep.add(file);
  }
  const packPath = join(target, pack);
  const size = (await stat(packPath)).size;
  if (size !== entry.compressedBytes) throw new Error(`${pack}: size ${size} != manifest compressedBytes ${entry.compressedBytes}`);
  if (entry.compressedSha256 && (await sha256(packPath)) !== entry.compressedSha256) throw new Error(`${pack}: compressedSha256 mismatch`);
  if (size > MAX_PACK_BYTES) throw new Error(`${pack} is ${size} bytes (> ${MAX_PACK_BYTES}); dev packs must stay small - rebuild with fewer sets`);
  languages[language] = { ...entry, fullPackUrl: `/dev-packs/${pack}`, setIndexUrl: `/dev-packs/${index}` };
  if (!rootTarget || entry.targetVersion > rootTarget) rootTarget = entry.targetVersion;
  if (!rootBuiltAt || entry.builtAt > rootBuiltAt) rootBuiltAt = entry.builtAt;
  summary.push({ language, pack, compressedBytes: size, uncompressedBytes: entry.uncompressedBytes, counts: entry.counts });
}
if (Object.keys(languages).length === 0) throw new Error('No requested language found in the source manifest');

const manifest = { manifestVersion: 1, currentVersion: null, targetVersion: rootTarget, builtAt: rootBuiltAt, languages };
await writeFile(join(target, 'catalog-manifest.json'), `${JSON.stringify(manifest, null, 2)}\n`);

for (const file of await readdir(target)) {
  if (!keep.has(file) && file !== '.gitkeep' && file !== 'README.md') await rm(join(target, file), { force: true });
}
console.log(JSON.stringify({ target, manifest: '/dev-packs/catalog-manifest.json', packs: summary, files: [...keep].map((f) => basename(f)).sort() }, null, 2));
