Project root: C:/Projects/flashydex (cd there first). Read `BRIEF.md` fully — the two OWNER UPDATE sections (App Store pivot; Compression & storage) are binding — then `docs/COMPRESSION-STORAGE.md` (owner spec, verbatim), then `SPEC.md`, then `.agent/research/*.md`. Follow BRIEF's Agent rules. Product name FlashyDex.

## Your role: GPT Terra — tooling, Stage A3: catalog pack pipeline + device-side decompression spike
Read `docs/CATALOG-PACKS.md` and the updated `docs/ARCHITECTURE.md` if they exist (Sol is writing them in parallel; if missing, follow BRIEF + `docs/COMPRESSION-STORAGE.md` and say so). Your Stage A2 scaffold (`apps/mobile`, `packages/core`) exists — build on it.

## Your files (ownership)
- `tools/catalog-builder/**` (new workspace)
- `.github/workflows/catalog-packs.yml` (new)
- `apps/mobile/src/platform/**` (download/decompress/hash/file primitives + worker), `apps/mobile/vite.config.ts`, `apps/mobile/package.json`, `apps/mobile/public/**`
- `packages/core/src/platform/types.ts` (Platform adapter interface additions: download with progress+abort, streaming zstd decode to file, sha256 of file, atomic rename, free space, image cache stub)
- `scripts/**`, root `package.json`, `README.md`
- `.agent/reports/terra-tooling-v3-report.md`

## Do
1. **Library selection with evidence** (npm view + README via curl; measure where cheap): Node-side zstd encoder for the builder (`@mongodb-js/zstd` prebuilt napi vs `zstd-napi` vs `zstd.ts`); device-side streaming decoder that runs in a Web Worker inside WKWebView/Android WebView and the browser (`fzstd` pure-JS streaming is the leading candidate; check size, streaming API, memory); streaming SHA-256 (`hash-wasm`); Capacitor Filesystem chunked append (`appendFile` base64 overhead — measure; alternatives: `@capacitor/filesystem` `writeFile` with Blob in 7.x? `capacitor-blob-writer`?). Record choices + numbers in `.agent/research/compression-libs.md`.
2. `tools/catalog-builder/`: TypeScript CLI (`npm run catalog:build -- --lang en [--sets swsh3,sv1] [--out dist/]`): crawl TCGdex (endpoints and quirks per `.agent/research/tcgdex-api.md`: concurrency 6–8, backoff, `+` in set ids URL-encoded, nullable image, `univ`→lang symbol rewrite, empty shells → `unpublished`), build `catalog-{lang}.db` with better-sqlite3 using the catalog schema from `packages/core` (if the schema isn't there yet, create `tools/catalog-builder/src/schema.sql` matching `docs/DATA-MODEL.md`'s catalog tables and flag it), `VACUUM`, zstd level 19 → `.db.zst`, sha256, `catalog-manifest.json` per `docs/CATALOG-PACKS.md`, metrics JSON (compressed/uncompressed bytes, ratio, crawl duration, compress duration, peak RSS). Resumable via an on-disk crawl cache (`.cache/<lang>/<cardId>.json`). Prove it on `--sets swsh3` end-to-end and paste the metrics.
3. Device side: `apps/mobile/src/platform/pack-install/` — worker that fetches a URL with progress + AbortSignal, streams through zstd decode and SHA-256, appends to a temp file in chunks, returns {bytes, sha256}; a tiny dev page route `/dev/pack-test` (guarded by `import.meta.env.DEV`) that installs the `swsh3` test pack you built (serve it from `public/dev-packs/` in dev) and opens it with the SQLite driver, printing row counts. Prove in the browser at 390×844 via Playwright that the flow completes and the DB opens. Note what cannot be proven without the Mac (native file paths, ATTACH) in `scripts/ios-notes.md`.
4. CI `catalog-packs.yml`: manual dispatch + weekly cron; builds EN and JA packs, uploads as GitHub Release assets tagged `catalog-vYYYY.MM.DD`, publishes manifest; stores metrics artifact. Don't run it now; validate YAML.
5. Verify: `npm run typecheck`, `npm run lint`, `npm test`, `npm run build`, builder on `swsh3`, Playwright spike pass. Paste real output.
6. Report `.agent/reports/terra-tooling-v3-report.md` and print it.

## Don't
Don't implement the real catalog repositories/UI (Sonnet does). Don't edit `docs/`. Don't touch `apps/mobile/src/styles/tokens.css`. Don't publish a release. Kill dev servers you start. Don't commit.
