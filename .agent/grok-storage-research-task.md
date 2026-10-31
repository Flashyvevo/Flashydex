Project root: C:/Projects/flashydex (cd there first). Read `BRIEF.md` fully — the two OWNER UPDATE sections (App Store pivot; Compression & storage) are binding — then `docs/COMPRESSION-STORAGE.md` (owner spec, verbatim), then `SPEC.md`, then `.agent/research/*.md`. Follow BRIEF's Agent rules. Product name FlashyDex.

## Your role: Grok — research, Stage A3: on-device storage & compression facts for the architect/tooling agents
## Your files: `.agent/research/device-storage.md`, `.agent/reports/grok-storage-report.md`. Read-only elsewhere. Use curl; cite URLs; mark anything unverified.
## Do — answer with sources:
1. `@capacitor-community/sqlite`: ATTACH DATABASE support per platform (search README, API.md, issues); opening a DB file placed by the app (paths on iOS `Library/CapacitorDatabase` vs `Documents`, `copyFromAssets`, `getUrl`, `isDatabase`, `importFromJson` limits); iOS backup exclusion for replaceable catalog files; web implementation (jeep-sqlite + sql.js) persistence (IndexedDB) and practical DB size limits; known performance numbers for 50–150 MB DBs; WAL/journal settings on iOS.
2. WKWebView/Android WebView constraints: Web Worker + WASM availability, memory ceilings per WebView process on iPhone (what size decompression buffers are safe), `fetch` streaming (`ReadableStream`) support in WKWebView, OPFS availability in WKWebView (as of iOS 17/18), file write throughput via Capacitor Filesystem base64 vs alternatives (`capacitor-blob-writer`, plugin options).
3. Zstandard in JS: `fzstd` (size, streaming decode API, speed claims, maintenance), alternatives (`zstd-codec`, `@bokuweb/zstd-wasm`, `zstddec`), Node encoders (`@mongodb-js/zstd`, `zstd-napi`). Expected ratios for SQLite text-heavy DBs (any published numbers; otherwise say none).
4. Streaming SHA-256 in browser (`hash-wasm`, WebCrypto non-streaming limitation).
5. iOS App Store size facts: on-demand resources vs post-install downloads (what Apple allows for downloading data packs after install; App Thinning; cellular download limit 200 MB prompt), Apple's rules on "downloads must not change app behaviour" (2.5.2) — confirm data packs are fine.
6. Competitor reference: how Collectr / TCG Collector / Pokellector load their catalogs (bundled vs downloaded) if publicly documented.
Report `.agent/reports/grok-storage-report.md` and print it.
