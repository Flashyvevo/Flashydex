# FlashyDex Compression & Storage Architecture

Compression is a first-class architecture requirement. Optimize for low hosting bandwidth, fast mobile startup, low device storage use, and low memory pressure.

## Catalog storage

Do not distribute the production card catalog as one large uncompressed JSON document.

Separate user data from replaceable catalog data.

Target databases:

- flashydex-user.db
- catalog-en.db
- catalog-ja.db

User collection data must never live inside a replaceable catalog database.

Build versioned catalog artifacts:

- catalog-manifest.json
- catalog-en-{version}.db.zst
- catalog-ja-{version}.db.zst

Use Zstandard for downloadable catalog packs.

Catalog installation flow:

download
→ verify expected size
→ decompress
→ verify SHA-256
→ open SQLite
→ validate schema/version
→ atomically activate
→ retain previous valid copy until activation succeeds
→ remove previous copy only after successful validation

A failed update must never destroy the currently working catalog.

## Incremental updates

Design the manifest format for differential updates from the beginning.

Support:

- currentVersion
- targetVersion
- full-pack URL
- optional delta-pack URL
- compressedBytes
- uncompressedBytes
- SHA-256
- schemaVersion

Prefer delta updates when significantly smaller than the full package.

Fall back to the complete compressed catalog when a delta cannot be safely applied.

Do not require delta updates in the first implementation if they materially delay Phase 1, but the manifest and update abstraction must permit them later.

## Image policy

Do not package the full card-image library with FlashyDex.

Use TCGdex WebP assets.

Use low-resolution WebP for:

- collection grids
- search results
- set browsers
- candidate lists

Use high-resolution WebP only for:

- card detail views
- explicit zoom/full-card display

Never bulk-download all card images.

Implement a bounded local image cache with LRU eviction.

Initial cache target:
150–250 MB maximum.

The cache limit must be configurable later.

Do not recompress already compressed WebP images merely for storage.

## Recognition data

Recognition indexes must not require storing every source card image on the user's device.

Precompute visual embeddings during catalog/index generation.

Benchmark at minimum:

- Float32
- Float16
- Int8 quantized representations where technically appropriate

Measure:

- package size
- memory usage
- decompression time
- top-1 recognition accuracy
- top-3 recognition accuracy
- inference latency on representative iPhones

Use the smallest representation that does not materially harm recognition reliability.

Compress recognition index packages with Zstandard.

Recognition packs must be independently versionable from catalog packs.

## HTTP compression

For normal API/text responses, allow the CDN/server to negotiate Brotli or gzip.

Do not manually double-compress already compressed files such as:

- WebP
- JPEG
- PNG
- ZIP
- Zstandard packages

Large controlled downloadable assets use explicit Zstandard packages.

## Backup format

Create a FlashyDex backup format with extension:

.fdx

The backup format must be versioned.

Conceptual contents:

manifest
collection data
settings
custom cards
optional user-provided images

Compress the backup archive.

Backups must contain the user's collection data, not the entire downloadable TCGdex catalog unless explicitly requested.

A restore must be possible after reinstalling the application and downloading a fresh catalog.

## App bundle budget

Keep the initial IPA/APK small.

Do not bundle:

- complete card catalogs
- complete image libraries
- unnecessary recognition source images
- language catalogs the user did not select

Bundle only:

- application code
- UI assets
- schema/migrations
- minimal bootstrap metadata
- essential recognition/runtime assets

Download optional catalogs and larger recognition resources after installation.

## Performance requirements

Compression must not create excessive memory pressure.

Do not require loading an entire decompressed catalog into JavaScript memory.

Prefer streaming/file-based decompression into a temporary file where practical.

Large processing tasks must not block the main UI thread.

Display download/decompression progress for user-visible initial setup.

The user must be able to cancel optional downloads.

## Metrics

Record these values during development for every production asset pack:

- compressed size
- uncompressed size
- compression ratio
- download duration
- decompression duration
- peak memory consumption
- installed disk footprint

Do not declare compression work complete based only on file-size reduction.

Optimize the total experience:
network + CPU + memory + storage + reliability.