# Compression / hashing / file-write library selection (evidence)

Author: sonnet-tooling, 2026-10-31. Host: Windows 11 x64, Node v24.19.0, SQLite 3.53.4 (better-sqlite3 13.0.3).
Reproduce: `node scripts/bench-compression-libs.mjs [path/to/catalog.db]` (generates a deterministic ~8.5 MB catalog-shaped DB when no path is given; `SKIP_WINDOW=1` skips the 40 MB window test).
Numbers marked **real** use the builder's actual output `catalog-en-2026.10.31.001.db` (swsh3, 201 cards); **synthetic** use the generated file. Everything here is desktop Node; nothing was measured in WKWebView/Android WebView.

## Decisions

| Role | Choice (pinned) | Why |
|---|---|---|
| Builder zstd encoder (Node) | `zstd-napi` 0.0.13, level 19, `checksumFlag: true`, streaming `CompressStream`/`DecompressStream` | Documented streaming API (file -> file, no whole-file buffer), prebuilt `binding.node` shipped in the tarball, loads on Windows x64 / Node 24 without a compiler, zstd 1.5.7 statically linked, explicit `windowLog` control. |
| Device decoder (Web Worker) | `fzstd` 0.1.1 streaming `Decompress` | Pure JS, ~8 kB min, runs in any worker/WebView with no WASM instantiate step, output arrives in <=128 KiB chunks that can be hashed/written and dropped. Constraint: max window 2^25 (32 MiB). |
| Streaming SHA-256 (device) | `hash-wasm` 4.12.0 `createSHA256()` (`init/update/digest`) | `crypto.subtle.digest` is one-shot (whole input in memory). hash-wasm is chunked and works in workers. |
| Pure sync SHA-256 (mapper keys only) | in-repo `packages/core/src/catalog/sha256.ts` | variant_key / observation_key are tiny strings; needs identical output in Node, web and native without async WebCrypto. Tested against `node:crypto`. |
| Chunked binary write (native) | `@capacitor/filesystem` 7.1.9 `appendFile` of base64 chunks <=256 KiB, sequential, each awaited | Only ATS-clean path with no extra plugin; base64 produced in the worker so the main thread only relays strings. Alternatives below. |
| Web "file" | assemble in memory -> write into jeep-sqlite's localforage store (`jeepSqliteStore/databases`, key `<name>SQLite.db`) | sql.js needs the whole DB as a byte array anyway; see `pack-install/web-store.ts`. |

Rejected: `@mongodb-js/zstd` 7.0.0 for the builder (works, but one-shot only: 272 MB peak RSS for an 8.5 MB input vs 175 MB streaming; kept only as a devDependency for the comparison in the bench). `node:zlib` zstd (`createZstdCompress`) works on Node 24.19 and gives the same bytes within 4 bytes but is still marked experimental and absent before Node 22.15; documented fallback only.

## 1. Node zstd encoder

Prebuilt binary check (this host): `require('@mongodb-js/zstd')` -> `compress/decompress/getDefinedNapiVersion`, round-trip OK; `zstd-napi` -> `CompressStream, Compressor, DecompressStream, Decompressor, compress, decompress`, round-trip OK. Neither needed node-gyp (npm 11 `allowScripts` skipped both install scripts and both still load). System `zstd` CLI: not installed (`which zstd` fails) - not used.

Level 19, synthetic 8,527,872 B input:

| Encoder | compressed B | ratio | ms | peak RSS |
|---|---|---|---|---|
| zstd-napi stream | 1,118,222 | 7.626 | 4,488 | 174.5 MB |
| @mongodb-js/zstd one-shot | 1,118,920 | 7.622 | 4,148 | 271.8 MB |
| node:zlib zstd (experimental) | 1,118,218 | - | 5,127 | - |

Level 19, **real** swsh3 pack, 1,835,008 B: zstd-napi 130,901 B (ratio 14.018, 500 ms, 149.6 MB RSS); mongodb 131,171 B (13.989, 435 ms); node:zlib 130,897 B (440 ms). The real catalog compresses ~2x better than the synthetic one because `raw_json` blobs repeat provider keys heavily.

Window: level 19 emits an 8 MiB window (`windowLog 23`); the builder reads the first frame header of every pack (`zstdWindowBytes`) and fails if the window exceeds 2^25. Verified on the real pack: `zstdWindowBytes: 8388608` in the metrics JSON.

## 2. Device streaming decoder: fzstd

API (verified by running it): `new Decompress((chunk, final) => ...)`; `push(chunk, isLast)`. Fed in 64 KiB pieces:
- real pack: 33 output chunks, max chunk 131,072 B, output byte-exact (sha256 equal), 99 ms, JS heap growth 0.6 MB (the library does not retain output);
- synthetic 8.5 MB: 110 chunks, max 131,072 B, 251 ms, heap growth 0.5 MB, byte-exact.
`fzstd.decompress` (one-shot) on the same data: 61 ms real / 203 ms synthetic - the worker uses streaming, not this.

Window limit: README says ultra levels with >32 MiB data may fail. Test with `windowLog 27` and a 4 MiB repeat ~36 MiB apart (40 MB total): fzstd streaming decoded it byte-correctly (no error, no corruption), but the compressed size (37.75 MB of 40 MB) shows the long match was only partly used, so this is **inconclusive**, not a guarantee. Policy: builder stays at level <=19 and fails on window > 2^25; the worker additionally refuses a frame header whose window exceeds 2^25.

Throughput caveat: fzstd's own README says WASM decoders are 30-40% faster for >100 MB payloads. Expected pack sizes are far below that (real swsh3 = 1.8 MB; a full EN catalog is estimated in the tens of MB once measured - **not measured**). Revisit `zstddec` (WASM, has `decodeStreaming`) only if a full-catalog device run is too slow.

## 3. Streaming SHA-256: hash-wasm

`createSHA256()`, 256 KiB chunks, real pack: result equals `node:crypto` (`equal: true`). Throughput in Node: hash-wasm ~203 MB/s vs node:crypto ~1,106 MB/s (synthetic run: 186 vs 1,175). At 203 MB/s a 100 MB pack hashes in ~0.5 s on this desktop; phone numbers are unmeasured. hash-wasm runs inside the pack-install worker next to the decoder so hashing never touches the main thread.

## 4. Filesystem.appendFile base64 overhead (10 MB random buffer, Node)

| Chunk | appendFile calls | total base64 bytes | expansion | JS `btoa(String.fromCharCode(...))` loop | `Buffer.toString('base64')` |
|---|---|---|---|---|---|
| 64 KiB | 160 | 13,981,440 | 1.3334x | 502 ms | 4 ms |
| 256 KiB | 40 | 13,981,120 | 1.3333x | 497 ms | 6 ms |
| 1 MiB | 10 | 13,981,040 | 1.3333x | 493 ms | 5 ms |

Reading: expansion is exactly 4/3 regardless of chunk size; the JS encode loop costs ~50 ms per MB (CPU, scales linearly) which is why encoding happens in the worker; chunk size changes bridge-call count, not bytes. A 100 MB catalog = ~133 MB of base64 strings crossing the Capacitor bridge in 400 x 256 KiB calls. The bridge/disk cost per `appendFile` is **not measurable off-device** - that is the first thing to measure on the iPhone. In the browser the worker encodes with `FileReader.readAsDataURL(new Blob([chunk]))` (native base64) and falls back to the loop.

Alternatives considered:
- `capacitor-blob-writer` 1.1.21: README version table stops at Capacitor 6, fast path starts a local HTTP server and asks for `NSAllowsArbitraryLoads`/cleartext, still wants a whole Blob (= whole file in JS memory). Rejected (conflicts with the ATS/App Store posture and the no-whole-file rule).
- Custom native stream (URLSession/FileHandle) so JS never sees decoded bytes: best fit, needs a small native plugin; recorded as a follow-up, not Phase 1.
- `Filesystem.writeFile` with a whole base64 string: the blob-writer README reports OOM at 32 MB on old devices. Rejected.

## 5. Native location choice (for reference)

iOS `Directory.LibraryNoCloud` (`Library/NoCloud`): `ion-ios-filesystem` `fetchNotSyncedLibrary` creates it and sets `isExcludedFromBackup = true` on the directory (source read, not executed). Android `Directory.Library` = `filesDir`; backup exclusion is done via `data_extraction_rules.xml` / `backup_rules.xml` excluding `flashydex/catalogs` and `flashydex/packs`. Both are re-verified on device per `scripts/ios-notes.md`.

## 6. sql.js / jeep-sqlite version pairing (found while fixing web SQLite)

jeep-sqlite 2.8.0 bundles its own sql.js glue (exports start at `I`, 34 wasm imports = sql.js 1.11/1.12). The hoisted root `sql.js` resolved to 1.15.2 (exports start at `N`), so `sql-wasm.wasm` from it fails with `LinkError: Import #34 "a" "I": function import requires a callable` and `componentOnReady()` never resolves. `apps/mobile` now pins `sql.js` 1.12.0 and `scripts/copy-sql-wasm.mjs` copies the wasm from that exact copy (sha1 3afa58d8...; identical to 1.11.0's).
