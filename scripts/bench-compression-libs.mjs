// Reproducible evidence for .agent/research/compression-libs.md
//   node scripts/bench-compression-libs.mjs [path/to/catalog.db]
// Without an argument a deterministic ~12 MB catalog-shaped SQLite file is generated.
import Database from 'better-sqlite3';
import { createHash, randomBytes } from 'node:crypto';
import { createReadStream, createWriteStream, mkdtempSync, readFileSync, rmSync, statSync, writeFileSync } from 'node:fs';
import { createRequire } from 'node:module';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { pipeline } from 'node:stream/promises';
import zlib from 'node:zlib';

const require = createRequire(new URL('../apps/mobile/package.json', import.meta.url));
const { Decompress, decompress: fzstdOneShot } = require('fzstd');
const { createSHA256 } = require('hash-wasm');
const builderRequire = createRequire(new URL('../tools/catalog-builder/package.json', import.meta.url));
const zstdNapi = builderRequire('zstd-napi');
let mongo = null;
try { mongo = builderRequire('@mongodb-js/zstd'); } catch { /* optional */ }

const MB = 1024 * 1024;
const work = mkdtempSync(join(tmpdir(), 'flashydex-bench-'));
const report = { node: process.version, platform: `${process.platform}-${process.arch}` };

function sampleRss() {
  let peak = process.memoryUsage().rss;
  const timer = setInterval(() => { peak = Math.max(peak, process.memoryUsage().rss); }, 15);
  return () => { clearInterval(timer); return Math.max(peak, process.memoryUsage().rss); };
}
const ms = (t0) => Math.round(performance.now() - t0);
const sha = (buf) => createHash('sha256').update(buf).digest('hex');

function makeDb(path) {
  // Deterministic LCG so the file is stable across runs.
  let seed = 12345;
  const rnd = () => (seed = (seed * 1664525 + 1013904223) >>> 0) / 2 ** 32;
  const words = 'darkness ablaze furret sentret pokemon trainer energy colorless uncommon normal reverse holo holofoil attack damage retreat weakness illustrator tetsuya koizumi regulation mark legal standard expanded'.split(' ');
  const db = new Database(path);
  db.pragma('journal_mode = DELETE');
  db.exec('CREATE TABLE cards (id TEXT PRIMARY KEY, name TEXT, raw_json TEXT)');
  const ins = db.prepare('INSERT INTO cards VALUES (?,?,?)');
  db.transaction(() => {
    for (let i = 0; i < 14000; i += 1) {
      const pick = () => words[Math.floor(rnd() * words.length)];
      const raw = JSON.stringify({
        id: `swsh${i}-${i}`, name: `${pick()} ${pick()}`, hp: Math.floor(rnd() * 300),
        attacks: Array.from({ length: 2 }, () => ({ name: pick(), effect: Array.from({ length: 12 }, pick).join(' '), damage: Math.floor(rnd() * 20) * 10 })),
        pricing: { cardmarket: { avg: +(rnd() * 20).toFixed(2), low: +(rnd() * 5).toFixed(2), trend: +(rnd() * 20).toFixed(2) } },
        image: `https://assets.tcgdex.net/en/swsh/swsh3/${i}`, uuid: randomBytes(6).toString('hex')
      });
      ins.run(`swsh${i}-${i}`, `${pick()} ${pick()}`, raw);
    }
  })();
  db.exec('VACUUM');
  db.close();
}

const dbPath = process.argv[2] ?? join(work, 'synthetic.db');
if (!process.argv[2]) makeDb(dbPath);
const raw = readFileSync(dbPath);
report.input = { path: process.argv[2] ?? 'synthetic', bytes: raw.length, sha256: sha(raw) };

// ---------- encoders ----------
report.encoders = {};
{
  const zst = join(work, 'napi.zst');
  const stop = sampleRss();
  const t0 = performance.now();
  const cs = new zstdNapi.CompressStream({ compressionLevel: 19, checksumFlag: true });
  await pipeline(createReadStream(dbPath), cs, createWriteStream(zst));
  report.encoders['zstd-napi stream L19'] = { compressedBytes: statSync(zst).size, ratio: +(raw.length / statSync(zst).size).toFixed(3), ms: ms(t0), peakRssMB: +(stop() / MB).toFixed(1) };
  report.napiZst = zst;
}
if (mongo) {
  const stop = sampleRss();
  const t0 = performance.now();
  const out = await mongo.compress(raw, 19);
  report.encoders['@mongodb-js/zstd one-shot L19'] = { compressedBytes: out.length, ratio: +(raw.length / out.length).toFixed(3), ms: ms(t0), peakRssMB: +(stop() / MB).toFixed(1) };
  report.mongoRoundTrip = sha(await mongo.decompress(out)) === report.input.sha256;
}
if (typeof zlib.createZstdCompress === 'function') {
  const zst = join(work, 'node.zst');
  const t0 = performance.now();
  await pipeline(createReadStream(dbPath), zlib.createZstdCompress({ params: { [zlib.constants.ZSTD_c_compressionLevel]: 19 } }), createWriteStream(zst));
  report.encoders['node:zlib zstd (experimental) L19'] = { compressedBytes: statSync(zst).size, ms: ms(t0) };
}

// ---------- fzstd streaming decode ----------
{
  const zst = readFileSync(report.napiZst);
  const hasher = await createSHA256();
  hasher.init();
  let outBytes = 0, chunks = 0, maxChunk = 0;
  const stop = sampleRss();
  const heap0 = process.memoryUsage().heapUsed;
  let heapPeak = heap0;
  const t0 = performance.now();
  const dec = new Decompress((chunk) => { hasher.update(chunk); outBytes += chunk.length; chunks += 1; maxChunk = Math.max(maxChunk, chunk.length); heapPeak = Math.max(heapPeak, process.memoryUsage().heapUsed); });
  const CHUNK = 64 * 1024;
  for (let o = 0; o < zst.length; o += CHUNK) dec.push(zst.subarray(o, Math.min(zst.length, o + CHUNK)), o + CHUNK >= zst.length);
  const digest = hasher.digest('hex');
  report.fzstdStreaming = { ok: digest === report.input.sha256 && outBytes === raw.length, outBytes, outputChunks: chunks, maxOutputChunkBytes: maxChunk, ms: ms(t0), peakRssMB: +(stop() / MB).toFixed(1), heapGrowthMB: +((heapPeak - heap0) / MB).toFixed(1) };
  const t1 = performance.now();
  const whole = fzstdOneShot(zst);
  report.fzstdOneShot = { ok: sha(Buffer.from(whole)) === report.input.sha256, ms: ms(t1) };
  delete report.napiZst;
}

// ---------- window limit (fzstd supports <= 2^25 = 32 MiB) ----------
if (!process.env.SKIP_WINDOW) {
  const total = 40 * MB;
  const buf = randomBytes(total);
  buf.copy(buf, total - 4 * MB, 0, 4 * MB); // 4 MiB repeated ~36 MiB later -> needs window > 32 MiB
  const cs = new zstdNapi.CompressStream({ compressionLevel: 3, windowLog: 27, enableLongDistanceMatching: true });
  const zst = join(work, 'wide.zst');
  await pipeline(async function* () { yield buf; }, cs, createWriteStream(zst));
  const data = readFileSync(zst);
  let outcome;
  try {
    const h = createHash("sha256"); let n = 0;
    const dec = new Decompress((chunk) => { h.update(chunk); n += chunk.length; });
    for (let o = 0; o < data.length; o += 65536) dec.push(data.subarray(o, Math.min(data.length, o + 65536)), o + 65536 >= data.length);
    outcome = h.digest("hex") === sha(buf) && n === buf.length ? "streaming decode correct" : `streaming decode WRONG (${n} bytes) - silent corruption`;
  } catch (e) { outcome = `rejected: ${e.message ?? e}`; }
  report.fzstdWindow27 = { compressedBytes: data.length, outcome };
}

// ---------- hash-wasm vs node crypto ----------
{
  const hasher = await createSHA256();
  hasher.init();
  const t0 = performance.now();
  for (let o = 0; o < raw.length; o += 256 * 1024) hasher.update(raw.subarray(o, Math.min(raw.length, o + 256 * 1024)));
  const hex = hasher.digest('hex');
  const wasmMs = performance.now() - t0;
  const t1 = performance.now();
  const nodeHex = sha(raw);
  const nodeMs = performance.now() - t1;
  report.sha256 = { equal: hex === nodeHex, hashWasmMBps: +((raw.length / MB) / (wasmMs / 1000)).toFixed(0), nodeCryptoMBps: +((raw.length / MB) / (nodeMs / 1000)).toFixed(0) };
}

// ---------- base64 overhead for Filesystem.appendFile ----------
{
  const buf = randomBytes(10 * MB);
  const toB64 = (bytes) => { let s = ''; for (let i = 0; i < bytes.byteLength; i += 0x8000) s += String.fromCharCode(...bytes.subarray(i, i + 0x8000)); return btoa(s); };
  report.base64 = {};
  for (const chunkSize of [64 * 1024, 256 * 1024, 1024 * 1024]) {
    let strBytes = 0, calls = 0;
    const t0 = performance.now();
    for (let o = 0; o < buf.length; o += chunkSize) { strBytes += toB64(buf.subarray(o, Math.min(buf.length, o + chunkSize))).length; calls += 1; }
    const jsMs = performance.now() - t0;
    const t1 = performance.now();
    let viaBuffer = 0;
    for (let o = 0; o < buf.length; o += chunkSize) viaBuffer += buf.subarray(o, Math.min(buf.length, o + chunkSize)).toString('base64').length;
    report.base64[`${chunkSize / 1024}KiB`] = { appendCalls: calls, base64Bytes: strBytes, expansion: +(strBytes / buf.length).toFixed(4), btoaLoopMs: Math.round(jsMs), nodeBufferMs: Math.round(performance.now() - t1), viaBuffer };
  }
}

rmSync(work, { recursive: true, force: true });
console.log(JSON.stringify(report, null, 2));
