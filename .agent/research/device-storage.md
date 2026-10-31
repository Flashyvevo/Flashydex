# On-device storage and compression — facts for the architect

Fetched 2026-10-31 UTC with curl. Plugin source is the v7.0.3 tag of `capacitor-community/sqlite` (detached at `1bb3bb87617522b742756e5a4b363544322a6dde`; the tag itself is not a commit). Versions below are what the npm registry returned that day. Nothing here was run on a phone. "Unverified" means the page or the source does not settle it.

This note does not override `docs/COMPRESSION-STORAGE.md`. It is the evidence for the ATTACH decision the brief leaves to the architect, and for the pack install path.

## 1. ATTACH is not a plugin feature

User-level `ATTACH DATABASE` is not in the v7.0.3 README method table, not in `docs/API.md`, and not in `src/definitions.ts`.

A repo search of `*.swift`, `*.java`, and `*.ts` at that tag finds `ATTACH DATABASE` in exactly two places, both SQLCipher migration, not a public API:

- `ios/Plugin/Utils/UtilsEncryption.swift` lines 44 and 118, encrypt/decrypt via `sqlcipher_export`
- `android/.../UtilsSQLCipher.java` lines 111 and 174, same idea

GitHub issue search `repo:capacitor-community/sqlite "ATTACH DATABASE"` returned `total_count` 1, issue 148, title "Open prepopulated encrypted database". The fetched body is about `copyFromAssets` plus `setEncryptionSecret`. It does not contain the words ATTACH DATABASE. Comments were not fetched. No issue title documents user ATTACH.

An unquoted sqlite.org search for the words "cannot ATTACH database within transaction" returned 22 pages that match the words separately. The quoted phrase returned 0. Trunk `src/attach.c` (https://sqlite.org/src/raw/src/attach.c?ci=trunk, 19647 bytes) has a comment listing "Transaction currently open" as an error to check (line 167). The code under that comment checks the attached-database limit and a duplicate name. It does not test for an open transaction. Do not treat "ATTACH fails inside a transaction" as a documented SQLite rule from these two fetches. It is unverified at runtime.

What the plugin does document:

- `execute` defaults `transaction` to true (`src/definitions.ts` `async execute(statements, transaction = true)`, and iOS `CapacitorSQLitePlugin.swift` `call.getBool("transaction") ?? true`). iOS `Database.executeSQL` then issues `BEGIN` before the SQL and `COMMIT` after, unless that flag is false.
- So a caller who sends `ATTACH` through the default `execute` wraps it in a transaction. Whether that fails was not executed. If anyone tests it, pass `transaction: false`. Do not ship ATTACH on that hope.
- Separate connections are the documented model. `createConnection` per database name, read-only since 4.1.0-7 on Android, iOS, and Electron, and not on web (README method table: `createConnection (ReadOnly)` web column is ❌).
- `SQLITE_LIMIT_ATTACHED` exists (https://www.sqlite.org/c3ref/c_limit_attached.html: "The maximum number of attached databases"). The fetched page does not state the numeric default. Two catalogs plus a user DB would be under any plausible default. Irrelevant if ATTACH is not used.

Recommendation, as a fact about the driver, not a product decision: plan app-level joins across connections. Native can open the user DB read-write and each catalog read-only. Web cannot open a read-only connection, and web ATTACH of a second IndexedDB database into one sql.js instance is not implemented by this plugin. Cross-db SQL joins are a native experiment, not the Phase 1 contract.

## 2. Opening a file the app placed

The plugin does not open an arbitrary path as a normal connection. It rewrites the name.

API.md, v7.0.3, Databases Location: the plugin adds the suffix `SQLite` and the extension `.db`. A name that already ends in `.db` has that extension stripped first. `catalog-en` and `catalog-en.db` both become `catalog-enSQLite.db`. `flashydex` becomes `flashydexSQLite.db`. The brief's `flashydex.db` will not be the on-disk name if this plugin is the writer. Same fact as `.agent/research/capacitor-plugins.md`; confirmed again in the v7.0.3 API.md, not only master.

### Normal open, after the file is already in the plugin folder

`isDatabase` — "Check if a SQLite database exists without connection", since 3.0.0-beta.5, all four platforms in the method table.

`open` of a non-encrypted DB — all four platforms. Encrypted open is not on web.

`getUrl` — "GetUrl get the database Url", since 3.3.3-4. Method table: Android ✅, iOS ✅, Electron ❌, Web ❌. iOS implementation returns `file://` plus the path, and only if a connection already exists (`CapacitorSQLite.getUrl` throws "Connection to … not available" otherwise). It is not a way to learn the folder before the first open.

iOS open flags in `UtilsSQLCipher.swift`: `SQLITE_OPEN_READONLY` or `SQLITE_OPEN_CREATE | SQLITE_OPEN_READWRITE`, always or'd with `SQLITE_OPEN_FULLMUTEX`. No `journal_mode` pragma in that open.

### `copyFromAssets`

API: "Copy databases from public/assets/databases folder to application databases folder", since 2.9.0. iOS `copyFromAssets` copies `*.db` and unzips `*.zip` from the assets databases folder, and calls `setPathSuffix` so the destination has the `SQLite` suffix. `overwrite` defaults to true in the JS wrapper.

This is the bundled-asset path. The owner spec forbids a catalog-sized file in the IPA/APK. Do not use it for catalog packs. It does prove the plugin can open a file that was copied into its folder before `open()`.

### `getFromHTTPRequest`

Since 4.1.1. API text: "Get database or zipped database(s) from url". Method table marks it ✅ on Android, iOS, Electron, and web, since 4.2.0.

iOS `UtilsDownloadFromHTTP.swift` rejects anything that is not a `.db` or `.zip` URL ("download: Not a .zip or .db url"). It uses `URLSession.shared.downloadTask` to a temp file, then moves it into the database location. A `.db` whose name does not already contain `SQLite` is renamed `foo.db` → `fooSQLite.db`. Zip entries are extracted only if the entry extension is `db`. No SHA-256. No expected-size argument. The JS signature is `Promise<void>` — no progress callback on this method (import-from-JSON has `sqliteImportProgressEvent`; this download does not). No "keep the previous file until the new one validates."

A `.db.zst` URL will be rejected by that guard. This method is not the owner install flow. It is evidence that a native download-to-file exists for zip and raw db, and that it does not do zstd, hash, or atomic rollback.

### Non-conformed connection (the path that opens a file the app placed itself)

README method table, iOS and Android only (Electron ❌, Web ❌):

- `getNCDatabasePath` — since 3.3.3-1, "get a non conformed database path"
- `createNCConnection` — since 3.3.3-1
- `isNCDatabase`, `closeNCConnection`

iOS `createNCConnection` requires the file to already exist, and constructs `Database` with `readonly: true`. It does not add the `SQLite` suffix. The path is used as given (`isFileExist(filePath: databasePath)`).

Android `Database` open: if `isNCDB()` or read-only, it calls `SQLiteDatabase.openDatabase(..., OPEN_READONLY)`. Same read-only result.

`getFolderURL` on iOS only allows folder roots `Applications`, `Library`, `tmp`, `cache`, `Documents`, `default`. Anything else throws "Folder '…' not allowed". `Library/CapacitorDatabase` resolves to the app Library URL plus `CapacitorDatabase`.

So a catalog file written by the app to a real path under Library (or Caches) can be opened read-only on iOS and Android without the `SQLite` suffix, via `createNCConnection`. It cannot be opened that way on web. It cannot be written through that connection. Activation of a new catalog is a file replace plus a new read-only connection, not an in-place SQL import.

`importFromJson` is a different thing. It takes the plugin's own JSON object as a string, all platforms, since 2.0.0-3. No byte cap in API.md or in the options type. The whole string crosses the bridge. Progress events exist. It is the wrong tool for a 50–150 MB catalog, and it is not the collection export schema (already decided in `docs/API.md`). No numeric bridge limit was found in the files fetched. Unverified what the bridge does at tens of megabytes of JSON.

## 3. iOS location and backup exclusion

API.md, iOS:

- Default: "in the Documents folder of YOUR_APPLICATION".
- Or the folder in `capacitor.config.ts`, "since 3.3.3-2". The doc says: "In that case the databases will not be not visible to iTunes and not backed up to iCloud." Example value `iosDatabaseLocation: "Library/CapacitorDatabase"`. The double negative is theirs.

Source, `UtilsFile.createDatabaseLocation`: the exclusion call runs only when the directory does not already exist. It sets `isExcludedFromBackup = true` on the directory URL, then, if the location is not Documents/default, moves existing `*SQLite.db` files out of Documents. It does not set the flag again on later files. It does not set the flag on each database file.

Apple, fetched the same day:

- https://developer.apple.com/documentation/foundation/urlresourcekey/isexcludedfrombackupkey.md — "Set this property each time you save a file because some common file operations cause this property to reset to false." Copyright 2026.
- https://developer.apple.com/documentation/foundation/optimizing-your-app-s-data-for-icloud-backup.md — purgeable data belongs in `tmp` or `Library/Caches`, which iCloud Backup excludes by default. Do not use those directories to hide nonpurgeable data. Re-downloadable nonpurgeable data (Apple's example is an offline movie) should be marked with `isExcludedFromBackup`. "To indicate the system can exclude a group of related files from iCloud Backup, move those files into a directory and update the directory's isExcludedFromBackup resource value." "Because certain file operations can reset resource values, make sure you set an excluded file's resource values each time you save it." The flag "exists only to provide guidance to the system" and "is not a mechanism to guarantee those items never appear in a backup."

Consequences, from those two sources plus the plugin source:

1. One `iosDatabaseLocation` applies to every database the plugin creates. A directory-level exclusion covers the user DB and the catalog DBs if they share that folder. You cannot exclude only the catalogs by setting the plugin location.
2. The plugin sets the flag once, on directory creation, not on each new file. Apple says set it each time you save a file. A catalog file written later by our downloader is not covered by a second call in this plugin.
3. Caches is excluded by default and may be purged. A catalog the user expects to keep is nonpurgeable and re-downloadable, which is Apple's "mark excludable" case, not the Caches case. `tmp` is worse.
4. The user DB should not inherit a catalog exclusion if the owner wants iCloud backup of the collection. The way the plugin is written, that split means the catalog file lives outside the plugin folder and is opened with `createNCConnection` (native, read-only), while `flashydex` stays in `Library/CapacitorDatabase`. Web cannot do the NC open. On web both live in IndexedDB; backup exclusion is an iOS file flag and does not apply.

Android, from the v7.0.3 README, not from a generated project: suggested `AndroidManifest.xml` sets `android:allowBackup="false"` and a `data_extraction_rules.xml` that excludes the `database` domain from cloud-backup and device-transfer. That is a README example. `cap sync` was not run. If the app does not copy those excludes, Android Auto Backup may include the databases. Unverified until the Android project exists.

## 4. Web: jeep-sqlite, IndexedDB, not OPFS

v7.0.3 README: "SQLite databases are backed by jeep-sqlite and stored in IndexedDB."

v7.0.3 API.md: "stored in Web browser INDEXEDDB storage as a localforage store under the jeepSqliteStore name and databases table name."

v7.0.3 `docs/Web-Usage.md`: jeep-sqlite uses sql.js "for sql in-memory queries" and stores the database in that localforage store "when one requires" the save. `initWebStore` and `saveToStore` are web-only (method table). The same page: IndexedDB support is checked via userAgent. Selecting an iPhone in Chrome device mode can break that check (`No available storage method found`). Do not treat a spoofed phone UA on desktop Chrome as a web-storage test.

sql.js README, https://raw.githubusercontent.com/sql-js/sql.js/master/README.md, fetched the same day: "It uses a virtual database file stored in memory, and thus doesn't persist the changes made to the database." It can import an existing sqlite file and export the database as a typed array. The README says a native binding is preferable because sql.js "will also be able to work on database files directly instead of having to load the entire database in memory, avoiding out of memory errors" — that sentence is about native bindings, and the grammar is theirs; the point they are making is that loading the whole file into memory causes out-of-memory errors.

OPFS does not appear in the v7.0.3 README or API.md. The brief's "OPFS/IndexedDB" line is still only half true: IndexedDB yes, OPFS no, for this plugin. Confirmed again after reading Web-Usage.md, which the earlier plugin note had not fetched.

Practical size: no plugin page states a maximum database size. No issue fetched states a measured result for a 50–150 MB file. The web path holds the whole database in the WASM heap, and `saveToStore` copies that image into IndexedDB, so peak memory is at least the file size plus the serialized copy. A 150 MB catalog on web is a 150 MB WASM allocation plus a second copy at flush, inside the WebView process. That conflicts with "never whole catalog in JS memory." On web, that requirement cannot be met with this driver. Native file open can meet it. The desktop PWA is the path that cannot.

IndexedDB quota on iOS was not fetched as a current Apple number. Do not plan against a remembered 500 MB or 1 GB cap. `navigator.storage.estimate()` is the runtime check. Unverified what a WKWebView origin actually gets.

`getUrl`, read-only connections, and NC connections are all ❌ on web. The web catalog, if it exists at all, is a named database inside jeep-sqlite, loaded entirely into sql.js. `getFromHTTPRequest` is marked ✅ on web in the method table. Its web implementation was not read (jeep-sqlite README raw URL 404'd). Do not assume the web method streams to disk. sql.js has nowhere to stream to except memory.

## 5. WAL / journal mode

API.md section "Write-Ahead Logging (WAL)", v7.0.3, quoted in full:

- "Electron, Web platforms only WAL journal_mode is implemented"
- "Both WAL and WAL2 journal_mode are implemented"
- "Android WAL2 is set by default, so you do not need to set it up"

iOS is not named.

Source at the same tag:

- No `journal_mode` string in any `*.swift` or `*.java` file.
- Android open is `SQLiteDatabase.openOrCreateDatabase` / `openDatabase` from `net.zetetic:sqlcipher-android:4.10.0` (`android/build.gradle`). No `enableWriteAheadLogging` call found.
- iOS pod constraint is `SQLCipher`, `~>4.5.6` (`ios/Podfile`). Open flags do not set a journal mode.
- Electron has `getJournalMode`, which reads `pragma('journal_mode')`. No write of `journal_mode = WAL` was found in the electron sources searched.

The API.md Android WAL2 sentence is not backed by the v7.0.3 Java that was searched. Treat iOS journal mode as "whatever SQLCipher 4.5.6 defaults to." That default was not fetched from Zetetic. Unverified.

For the pack: ship one file. A WAL catalog has sidecar `-wal` / `-shm` files; copying only the main file is an incomplete database. The repo already says that for backups (`docs/DECISIONS.md`). The builder should checkpoint before packing. The exact pragma was not re-fetched from sqlite.org this session.

## 6. Performance numbers for 50–150 MB

None published by the plugin for a database of that size. Searched issues (`large database OR memory OR IndexedDB OR performance OR WAL`, 30 hits) and fetched the ones whose titles were about memory or large rows.

- Issue 623, plugin 7.0.0, iOS, closed by the reporter: paging 500-row pages over a 10k-row table, each row about 12 KB, allocated 700 MB that was not freed, measured in Safari's memory tab on a physical iPhone. https://github.com/capacitor-community/sqlite/issues/623. This is a user report about result-set retention, not a file-size benchmark. Do not `SELECT` a catalog table without a limit.
- Issue 627, plugin 6.0.2, Android, closed not_planned: `OutOfMemoryError` on startup, reporter says queries up to about 1024 KB, hard to reproduce. https://github.com/capacitor-community/sqlite/issues/627. Not a 50–150 MB file test.
- Issue 464, closed: batch insert reported as slow; the user tried `PRAGMA` journal mode MEMORY. No timings in the fetched body. https://github.com/capacitor-community/sqlite/issues/464.

Android `CursorWindow` "row too big" was a title in the issue search (`bug: Row too big to fit into CursorWindow requiredPos=0, totalRows=0 - 7.0.1 Android Only`). The body of that issue was not fetched (the number pairing in the search JSON was not trusted after a mismatch). Do not quote a 2 MB row limit as if this repo's issue stated it. Catalog rows of card metadata are small; the risk is selecting too many rows, not one card row exceeding a window. Unverified against the issue body.

No number in any fetched page says a 50 MB or 150 MB database is fine, or is not fine, on iOS native SQLite. Native SQLCipher opens a file. The memory risk on native is the query result crossing the bridge, not the file size. On web the file size is the memory size.

## 7. WKWebView and Android WebView

Capacitor 7's own update page says raise the iOS deployment target to iOS 14.0: https://capacitorjs.com/docs/updating/7-0 (the fetched HTML's edit link points at `versioned_docs/version-v8/main/updating/7-0.md`; the sentence on the page is "change iOS Deployment Target to iOS 14.0"). Plan for iOS 14 WebKit as the floor, and for newer WebKit on devices that have updated. Do not require an iOS 17-only API without a runtime check.

### Workers and WASM

caniuse feature JSON, https://github.com/Fyrd/caniuse `main`, fetched 2026-10-31:

- Web Workers: `ios_saf` first `y` is 8, last listed `y` is 27.2. Safari `y` from 4.
- WebAssembly: `ios_saf` first `y` is 11.0-11.2, last 27.2. Safari `y` from 11.
- Android Browser and Chrome for Android latest rows in that file are `y` for both.

A Capacitor 7 iOS app (deployment target 14) has workers and WASM in WKWebView, on the evidence that WKWebView uses the system WebKit and caniuse marks those features supported on Safari iOS since well before 14. WKWebView is not a separate caniuse row. Not run on a device. Android System WebView is updated separately from `minSdkVersion`. The plugin README example still says `minSdkVersion = 23`. A device stuck on an old WebView is a support problem, not something these tables rule out. Unverified against a specific WebView version.

### Memory ceiling

No Apple page fetched states a WKWebView or WebContent jetsam limit in megabytes. Do not invent one. Do not pick "64 MB is safe" as an Apple number.

The only measured crash number in a fetched README is from `capacitor-blob-writer` (below): `Filesystem.writeFile` of 32 MB crashed WKWebView on an iPhone 6, and threw `OutOfMemoryError` on a Samsung A5. Those are old devices, the benchmark is undated, and the failure is the base64 write path, not a general heap ceiling. It is still the only concrete "this size killed the webview" number found.

What follows from the owner spec plus that gap: decompression must emit chunks and write them, and must not allocate the decompressed catalog as one `Uint8Array`. A safe full-catalog JS buffer does not exist in the sources fetched. Chunk size should stay at the decompressor's own output block (zstd's stream output size, or whatever `fzstd.Decompress` hands the callback), not the file size.

### `fetch` streaming

MDN browser-compat-data `api/Response.json` on GitHub `main`, fetched the same day:

- `Response.body`: Safari `version_added` 10.1, `safari_ios` mirrors, `webview_android` mirrors Chrome (Chrome 43).
- `Response.body` readable byte stream (BYOB): Safari `version_added` 26.4, `safari_ios` mirrors. Not required for a default `getReader()` loop.
- `Response.textStream`: Safari `version_added` false.

caniuse `streams` marks Safari and `ios_saf` as partial (`a #4`) through 27.2. Note 4 is "No support for BYOB stream readers." That matches the BCD split: a default `ReadableStream` reader on `response.body` is the old feature; BYOB is new.

So a chunked download via `fetch` + `response.body.getReader()` is in the compat data for every iOS version Capacitor 7 supports. Two caveats, both unverified on a device:

1. BCD has no WKWebView row. Safari iOS is the proxy.
2. `@capacitor/core` CapacitorHttp, when `enabled`, patches `fetch`. The earlier plugin note recorded that the patch defaults to off. `capacitor-blob-writer` 1.1.11 changelog says it "works around CapacitorHttp's patching of window.fetch." Do not turn the global patch on for the pack download until someone checks that `response.body` still exists on the patched fetch. Use `fetch` with the patch off, or a native download.

### OPFS

WebKit, https://webkit.org/blog/12257/the-file-system-access-api-with-origin-private-file-system/, fetched the same day:

- Origin private file system enabled from WebKit commit 242951@main.
- "available in Safari on macOS 12.2 and above, iOS 15.2 and above."
- `FileSystemSyncAccessHandle` "is only available in Worker."
- Storage lifetime "is the same as other persistent storage types like IndexedDB." Not available in private browsing.

A caniuse feature file named `wf-origin-private-file-system.json` and `origin-private-file-system.json` both 404'd on the caniuse raw repo. A search snippet said caniuse lists Safari on iOS from 16.4. That snippet was not verified against the data file. Cite the WebKit blog for 15.2, and feature-detect `navigator.storage.getDirectory`. Do not assume WKWebView matches Safari until a device test. Do not plan the plugin's web store on OPFS. jeep-sqlite uses IndexedDB.

iOS 17 and 18 are above 15.2, so the blog says OPFS is present. The sync access handle still requires a worker. Writing a 150 MB file through OPFS from a worker is a possible web path that this plugin does not use. Building that path would mean not using jeep-sqlite for the catalog. Out of scope unless the architect rejects sql.js for the catalog on web.

## 8. Writing the decompressed file

`@capacitor/filesystem` 7.1.9 README, https://unpkg.com/@capacitor/filesystem@7.1.9/README.md:

`WriteFileOptions.encoding`: "The encoding to write the file in. If not provided, data is written as base64 encoded. Pass Encoding.UTF8 to write data as string." Same sentence on `appendFile`. A binary SQLite file written without `encoding` is base64 on the bridge. Base64 expands the buffer by about 4/3 and the bridge holds the string. That is the path the blob-writer README says dies at 32 MB on old devices.

`capacitor-blob-writer` 1.1.21, published 2026-10-22, https://github.com/diachedelic/capacitor-blob-writer (README fetched raw). "A faster, more stable alternative to @capacitor/filesystem's Filesystem.writeFile for writing Blobs." Peer `@capacitor/core` >= 3 and `@capacitor/filesystem` >= 1. The README's version table stops at Capacitor v6 → plugin v1. Changelog v1.1.20 says "Adds support for Capacitor v8." v1.1.21 does not mention Capacitor 7 specifically. 7 sits between 6 and 8. Unverified on Capacitor 7.6.10 until someone installs it.

How it writes, from that README: on iOS and Android it starts an HTTP server on a random port and `PUT`s the blob. It asks for `NSAllowsArbitraryLoads` = true and `android:usesCleartextTraffic="true"`. That conflicts with the earlier compliance note that said not to add a cleartext ATS exception. The README also calls the local server a potential security risk (GCDWebServer / nanohttpd). Fallback, which cannot be disabled, splits the blob and uses `Filesystem.appendFile`. `fast_mode` is web-only and stores a Blob in IndexedDB instead of a base64 string.

Its own benchmarks (device and date not stated beyond the model names):

- iPhone 6: `writeFile` out of memory at 32 MB ("Crashes the WKWebView, which immediately reloads the page"). BlobWriter 128 MB in 3.1 s. 512 MB: "WebKit encountered an internal error."
- Samsung A5: `writeFile` out of memory at 32 MB (`java.lang.OutOfMemoryError`). BlobWriter 256 MB in 17.5 s. 512 MB: "Quota exceeded."
- Desktop Chrome: `writeFile` 512 MB throws "The serialized keys and/or value are too large." BlobWriter fast mode 512 MB in 1.1 s.

Those numbers are the plugin author's, on old phones. They are not a 2026 iPhone measurement. They are enough to reject `Filesystem.writeFile` of a whole catalog as base64.

None of these writers stream a zstd decode to disk by themselves. The owner flow (download → decompress in a worker → temp file → hash → open) needs a chunked writer:

- Native, ATS-clean: `appendFile` of each decompressor chunk, without holding the whole file as one base64 string. Each chunk is still base64. Slower. No new plist key.
- Native, faster, compliance cost: `capacitor-blob-writer`, which wants a cleartext local server and still wants the decompressed bytes as a Blob unless the caller feeds it incrementally. The README's `blob` option is one Blob. Building that Blob is the whole catalog in JS memory. That fails the owner rule even if the write is fast.
- Native, best fit, not in the sqlite plugin: a small native stream (URLSession or a file handle) so JS never sees the decompressed bytes. `getFromHTTPRequest` is that shape for zip only. zstd is not in it. A custom native writer is an implementation request, not a fact.
- Web: there is no file. The bytes have to enter sql.js. See section 4.

## 9. Zstandard

npm `latest` on 2026-10-31. Unpacked size is `dist.unpackedSize` from the registry, not a minified bundle size, except where the README states one.

### `fzstd` 0.1.1

https://github.com/101arrowz/fzstd README, fetched raw. Last publish 2024-03-15. No newer version on the registry. Maintenance: one release in 22 months, as of this fetch.

README title claim: "High performance Zstandard decompression in a pure JavaScript, 8kB package." Body: "at 8kB minified and 3.8kB after gzipping." Registry unpacked size is 65318 bytes. The 8 kB figure is the minified build, not the unpacked package. Description on npm says "(de)compression"; the README only documents decompress. No compress API in the fetched README.

APIs:

- `fzstd.decompress(Uint8Array)` returns a `Uint8Array`. Optional output buffer. If the output buffer is too small, "fzstd will assume the buffer is sufficiently sized, so it will yield corrupt data." Do not pass a short buffer.
- `new fzstd.Decompress(callback)`. `push(chunk)` and `push(last, true)`. Callback receives output chunks. README: "use data streams to minimize memory usage while decompressing." The example pushes chunks into an array, which would reassemble the whole output. The caller can write each chunk and drop it. Whether the library itself retains every output chunk was not verified by reading the implementation.

Speed claim, same README: "WebAssembly ports of Zstandard are usually significantly (30-40%) faster than fzstd. For very large decompression payloads (>100 MB), you'll usually want to use a WebAssembly port instead." A catalog at the top of the 50–150 MB range is in the range the author says to avoid.

Window limit, same README: maximum backreference distance of 2^25 bytes. "If you need to decompress files with an ultra compression level (20 or greater) AND your files can be above 32MB decompressed, fzstd may fail." Level 19 and below are outside that sentence. If the device decoder is fzstd, the Node encoder must not use level 20 or higher. That is a builder constraint, not a guess.

### `zstd-codec` 0.1.5

https://github.com/yoshihitoh/zstd-codec README. Last publish 2024-07-27. Unpacked 2078690 bytes. Emscripten. Simple and Streaming APIs, plus dictionaries.

Simple API, quoted: "Available Emscripten's heap size is 16MiB" and "(input.length + output.length) should be less than 12MiB." A catalog pack fails that limit on the simple API.

Streaming API exists (`decompressChunks`). The README example assigns the return value to one `data` variable. It is chunked input, not a callback that lets the caller discard output. Do not treat it as a stream-to-file decoder. The 12 MiB heap note is only on the simple API. What the streaming API does with a 150 MB output was not measured.

### `@bokuweb/zstd-wasm` 0.0.27

https://github.com/bokuweb/zstd-wasm README. Last publish 2025-02-17. Unpacked 903925 bytes. "For now support only simple API." `compress(buffer, level)` and `decompress(buffer)` return `Uint8Array`. No streaming method in the fetched README. Full input and full output in memory. Not the device decoder for a catalog.

### `zstddec` 0.3.4

https://www.npmjs.com/package/zstddec and https://github.com/donmccurdy/zstddec. Last publish 2026-10-18. Unpacked 341291 bytes. The actively updated WASM decoder of this set.

README (same text on GitHub main and on the published package): `ZSTDDecoder.decode(compressedArray, uncompressedSize)`. Limitation, quoted: the decoder "may fail with the error `wasm function signature contains illegal type` when the `uncompressedSize` is not known in advance." The manifest has `uncompressedBytes`. Pass it if this decoder is used for the one-shot API.

The published 0.3.4 type file `dist/zstddec-stream.d.mts` also exports `decodeStreaming(arrays: Iterable<Uint8Array>): Generator<Uint8Array>`. The README does not document that method. It is in the package that was published. Build note in the README: streaming wasm exports `ZSTD_decompressStream`, last built June 2025, zstd v1.5.7 (`f8745da6`), emscripten 4.0.10. Whether `decodeStreaming` retains the full output was not verified by reading the generator body.

This is the WASM candidate if fzstd's >100 MB warning or the 32 MB window limit is unacceptable. It still yields bytes in JS. Something else has to write them to a file without concatenating them.

### Node encoders (catalog-builder, not the phone)

`@mongodb-js/zstd` 7.0.0, published 2025-11-05, registry `modified` 2026-07-15. https://github.com/mongodb-js/zstd. Native addon. `engines.node` >= 20.19.0. `mongodb:zstd_version` in the package metadata is 1.5.6. API in the README: `compress(buffer, level): Promise<Buffer>` and `decompress(buffer): Promise<Buffer>`. One-shot. Windows x64 is a listed prebuild, which matches this host. No streaming function in that API section. Fine for a builder that can hold the sqlite file in a Node process. Not for the device.

`zstd-napi` 0.0.13, published 2026-07-15. https://github.com/drakedevel/zstd-napi. Native, Node-API. README: statically links zstd 1.5.7. Streaming and single-pass. Node 22 is "Maint. LTS" and marked first-class in that README; Node 24 is Active LTS and also marked. Windows x64 prebuild. This is the one of the two that documents streaming, which matters if the builder should not hold input and output at once. Both are Node-only.

A system `zstd` binary was not checked on this machine. Not a recommendation.

### Ratios

No published compression ratio for a text-heavy SQLite database of this shape was found. None is stated here. The owner spec already requires the builder to print compressed size, uncompressed size, and ratio. That measurement is the number. Do not copy a zstd corpus ratio (silesia, or a JSON benchmark) onto this catalog.

## 10. Streaming SHA-256

`hash-wasm` 4.12.0, published 2024-11-19. https://github.com/Daninet/hash-wasm README. Unpacked package is 1799970 bytes because every algorithm is in the tarball. The README's per-algorithm table lists "SHA-2: SHA-224, SHA-256" at 7 kB gzipped. Tree-shaking is claimed ("Webpack only bundles the hash algorithms you use"). Vite tree-shaking of this package was not tested.

Streaming, from that README: `createSHA256()`, then `init()`, `update(chunk)` in a loop, `digest("binary")` returns a `Uint8Array`. "Supports chunked input streams." "Works in Web Workers." The example uses SHA-1; the API list includes `createSHA256()`. Shorthand `sha256(data)` wants the whole buffer. Use `createSHA256` for a pack.

WebCrypto, MDN https://developer.mozilla.org/en-US/docs/Web/API/SubtleCrypto/digest, fetched the same day: "Note that this API does not support streaming input: you must read the entire input into memory before passing it into the digest function." `digest("SHA-256", data)` where `data` is an ArrayBuffer, TypedArray, or DataView. Available in workers, secure context. Do not hash a catalog with `crypto.subtle.digest` unless the whole decompressed file is already in memory, which the owner spec forbids.

A native hash (CommonCrypto on iOS, or the sqlite plugin) was not found as a method on this plugin. The JS streaming hash is the path that matches the spec without a new native plugin. Unverified: whether `hash-wasm` `update()` copies the chunk, and the bytes/second on an iPhone.

## 11. App Store size, ODR, and 2.5.2

Guidelines HTML, https://developer.apple.com/app-store/review/guidelines/, 240818 bytes, fetched 2026-10-31. Same byte size as the Stage A2 fetch the same day. 2.5.2, quoted from that file:

"Apps should be self-contained in their bundles, and may not read or write data outside the designated container area, nor may they download, install, or execute code which introduces or changes features or functionality of the app, including other apps. Educational apps designed to teach, develop, or allow students to test executable code may, in limited circumstances, download code provided that such code is not used for other purposes. Such apps must make the source code provided by the app completely viewable and editable by the user."

Apple has not, in that paragraph, written "a SQLite file is data" or "a zstd catalog is allowed." The prohibition is on code that introduces or changes features or functionality. A catalog pack does not add a feature if the app already knows how to open that schema. Downloading a new WASM decoder, a new JS bundle, or a plugin after review would be the thing 2.5.2 names. Do not `eval` downloaded text. Do not hot-update the Capacitor web bundle. This is the same reading as `docs/APP-STORE-COMPLIANCE.md`. It is not an Apple approval letter. The compliance doc's ONNX caveat still stands for Phase 2 weights; this note does not extend it.

### On-demand resources versus a post-install download

These are different mechanisms.

ODR, archive guide, fetched 2026-10-31 from https://developer.apple.com/library/archive/documentation/FileManagement/Conceptual/On_Demand_Resources_Guide/PlatformSizesforOn-DemandResources.html. The page is in Apple's documentation archive. The 2026 article below still links to that guide. Numbers from the archive page, not re-stated on a non-archive page this session:

- Tag: no more than 512 MB after app slicing. Ideal tag size "less than or equal to 64 MB."
- Hosted on-demand resources, presliced, on the App Store: 20 GB.
- iOS app bundle: 2 GB (sliced). tvOS app bundle: 4 GB.
- Initial install tags: 2 GB sliced. Initial install plus prefetched tags: 4 GB.
- In-use on-demand resources: 2 GB sliced.
- Asset packs: 1000.
- "The total size limit for the on-demand resources associated with an app are in addition to the size limit for the app bundle downloaded by the user."

ODR tags are downloaded by the system (`NSBundleResourceRequest`), from the App Store or from a host the app configures (the guide has a hosting chapter; that chapter was not fetched). They are not "fetch this GitHub Release URL in JS." A zstd SQLite file can be an ODR asset only if it is packed as a tagged resource and the app copies it out before open. That is a different pipeline from `catalog-en-{version}.db.zst` on GitHub Releases. Phase 1's chosen host is GitHub Releases. ODR is the alternative, not the spec.

Post-install download, current article, copyright 2026: https://developer.apple.com/documentation/xcode/doing-advanced-optimization-to-further-reduce-your-app-s-size.md. "If you can't adopt on-demand resources, consider implementing a web service that provides them, and download them in the background as needed, using URLSession." That sentence is Apple describing the non-ODR path. A catalog pack fetched after install is that shape. Background URLSession is optional; Phase 1 is foreground. The article does not say the download must be URLSession rather than `fetch`. It names URLSession as the example.

### App thinning

https://developer.apple.com/documentation/xcode/reducing-your-app-s-size.md, copyright 2026. App thinning "ensures that an app's IPA file only contains resources and code that's necessary to run the app on a particular device." App Store and TestFlight builds are thinned already. The size report lists compressed (download) and uncompressed (installed) sizes, and a separate "On Demand Resources size" line. Thinning does not shrink a catalog that is not in the IPA. Keeping the catalog out of the IPA is what makes the thinned download small. The article says not to measure size from the raw IPA, the xcarchive, or the uploaded IPA, because those contain files the user does not download. App Store Connect is the accurate number. Not run here.

### Cellular 200 MB

The 2026 "Reducing your app's size" article says the App Store limits the size of apps users can install over a mobile connection, and that App Store Connect warns if a build exceeds the limit. It does not state the number of megabytes.

The 200 MB figure is in 2019 press (CNET, 9to5Mac, Cult of Mac, via a web search this session) describing a raise from 150 MB to 200 MB, and in a third-party description of an iOS 13 setting "Ask If Over 200 MB." No Apple page fetched today states 200 MB. The number is unverified for 2026. Do not put "200 MB cellular cap" in a user-facing string.

That limit, whatever it is, is the App Store install of the app. It is not a cap on an in-app download of a data pack after install. Nothing fetched says an in-app HTTPS download of a catalog prompts at 200 MB. Unverified whether iOS shows any cellular prompt for a non-App-Store URL. The app should still show its own progress and let the user cancel, which the owner spec already requires.

## 12. Competitors

Not publicly documented, on the pages fetched.

- https://getcollectr.com/ returned 200, 38521 bytes. The visible line is "Catalog your collection, track its real-time value" — the verb, not a data file. No sentence about a bundled database or a downloaded card database. FAQ and help URLs were not successfully saved (curl write error). App Store description was already quoted in the Stage A2 report; it was not re-fetched for catalog-loading claims.
- https://www.tcgcollector.com/ returned 403 to this client.
- https://www.pokellector.com/ returned 200. It links the iOS app and the Play listing and repeats the affiliation disclaimer. No sentence about how the card list is loaded.

No blog post, help page, or App Store text fetched this session says whether Collectr, TCG Collector, or Pokellector ship the catalog in the binary or download it. Do not copy a guess into the architecture.

## 13. What is solid enough to build on

Solid, from source or an Apple/MDN page fetched this session:

- Do not depend on ATTACH. Use one connection per database. Native catalogs can be read-only. Web cannot.
- On-disk name is `{logical}SQLite.db` if the plugin creates it. A file the app places itself and opens with `createNCConnection` keeps the name it was given, and is read-only, iOS and Android only.
- `getFromHTTPRequest` is zip or db, not zstd, and has no hash and no rollback.
- iOS backup exclusion in the plugin is a one-time directory flag. Apple says set the file flag on every save, and says the flag is guidance, not a guarantee. User DB and catalog should not share an excluded directory if the collection is supposed to be backed up.
- Web store is IndexedDB via jeep-sqlite/sql.js, whole database in memory, explicit `saveToStore`. Not OPFS. A full catalog on web violates the memory rule of the owner spec.
- Do not base64 a catalog through `Filesystem.writeFile`.
- Device zstd decoder: `fzstd` 0.1.1 streams and is tiny, and its author says use WASM above 100 MB, and do not use level 20+ for files over 32 MB. `zstddec` 0.3.4 is the maintained WASM decoder and has an undocumented `decodeStreaming` generator. `zstd-codec` simple API is capped around 12 MiB. `@bokuweb/zstd-wasm` is one-shot.
- Builder encoder: `@mongodb-js/zstd` 7.0.0 one-shot, or `zstd-napi` 0.0.13 if the builder wants streaming. Both are Node native, Windows x64 prebuilds exist.
- Hash with `hash-wasm` `createSHA256` `update`/`digest`, in a worker. Not `crypto.subtle.digest`.
- `fetch` `response.body` is in BCD for Safari since 10.1. Keep CapacitorHttp's fetch patch off until that stream is tested under the patch.
- 2.5.2 does not forbid a data pack. It forbids downloaded code that changes functionality. ODR is a different, Apple-hosted mechanism with a 512 MB tag cap in the archive guide. The 2026 optimization article explicitly allows a web-service download when ODR is not used.
- No compression ratio is known until the builder measures one.

Unverified, and should be a device test rather than a guess:

- ATTACH inside `execute` with `transaction: false`, on iOS SQLCipher and on Android SQLCipher 4.10.0.
- iOS default `journal_mode` under SQLCipher ~>4.5.6.
- Whether a file written into `Library/CapacitorDatabase` after the directory already exists is actually excluded from iCloud backup.
- WKWebView jetsam threshold on a current iPhone. No Apple number was found.
- `response.body` under Capacitor's WKWebView, and under a patched `fetch`.
- `zstddec` `decodeStreaming` peak memory on a 100 MB+ frame.
- IndexedDB quota in a Capacitor WKWebView.
- `capacitor-blob-writer` 1.1.21 on Capacitor 7.6.10.
- Any competitor's catalog packaging.
