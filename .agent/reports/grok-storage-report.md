# Grok report — Stage A3, on-device storage and compression

Role: research. No code. No commit. No file outside the ownership list was edited.

Fetched 2026-10-31 UTC with curl. Plugin facts are from the v7.0.3 tag, not from master and not from memory. `web_extract` is not configured; it was not used for any fact in the note.

## Produced

- `.agent/research/device-storage.md`
- `.agent/reports/grok-storage-report.md` (this file)

## Verified

Plugin, tag v7.0.3, clone `https://github.com/capacitor-community/sqlite` at `1bb3bb87617522b742756e5a4b363544322a6dde`. README, API.md, definitions.ts, and Web-Usage.md also saved from raw.githubusercontent.com for that tag.

- `ATTACH DATABASE` appears only in the SQLCipher encrypt/decrypt helpers (iOS `UtilsEncryption.swift`, Android `UtilsSQLCipher.java`). Not in the method table, not in API.md, not in definitions.ts.
- GitHub issue search for the quoted phrase `ATTACH DATABASE` returned one hit, issue 148. The fetched body does not contain that phrase. Comments not fetched.
- `execute` defaults `transaction` to true, and iOS `executeSQL` wraps that in BEGIN/COMMIT. Trunk `src/attach.c` comments that an open transaction is an error, then does not test for one. Runtime not executed.
- Name rewrite: `{name}SQLite.db`, existing `.db` stripped first. Confirmed in v7.0.3 API.md.
- `getFromHTTPRequest` iOS source accepts only `.db` and `.zip`. No hash, no progress, no keep-previous-copy.
- `createNCConnection` is iOS/Android only, file must exist, opened read-only, no SQLite suffix. Web column is ❌.
- iOS backup flag is set on the directory, and only when `createDatabaseLocation` creates it. Apple's 2026 `isExcludedFromBackupKey` page says set the flag every time you save a file. Apple's 2026 iCloud-backup article says a directory flag is how you exclude a group, and that the flag is guidance, not a guarantee.
- Web store is IndexedDB (`jeepSqliteStore` / `databases`), sql.js in memory, `saveToStore` explicit. OPFS is not in the v7.0.3 README, API.md, or Web-Usage.md.
- No `journal_mode` assignment in v7.0.3 Swift or Java. API.md still says Android WAL2 is the default. Those two disagree. iOS SQLCipher pod constraint is `~>4.5.6`. Android dependency is `net.zetetic:sqlcipher-android:4.10.0`.

npm `latest` the same day: fzstd 0.1.1 (2024-03-15), zstd-codec 0.1.5 (2024-07-27), @bokuweb/zstd-wasm 0.0.27 (2025-02-17), zstddec 0.3.4 (2026-10-18), @mongodb-js/zstd 7.0.0 (2025-11-05), zstd-napi 0.0.13 (2026-07-15), hash-wasm 4.12.0 (2024-11-19), capacitor-blob-writer 1.1.21 (2026-10-22). READMEs fetched raw. zstddec 0.3.4 `decodeStreaming` is in the published `.d.mts`, not in the README.

hash-wasm README documents `createSHA256` / `update` / `digest`. MDN digest page says WebCrypto digest does not stream.

Filesystem 7.1.9 README: omitted `encoding` means base64. blob-writer README: writeFile OOM at 32 MB on an iPhone 6 and a Samsung A5; its own path wants `NSAllowsArbitraryLoads` and cleartext traffic.

Capacitor 7 update page: iOS deployment target 14.0. caniuse JSON on GitHub main: workers and WASM supported on Safari iOS since long before 14. MDN BCD `api/Response.json` on GitHub main: `Response.body` Safari 10.1, BYOB byte stream Safari 26.4. WebKit OPFS blog: iOS 15.2+, sync access handle worker-only.

Guidelines HTML, 240818 bytes, same day: 2.5.2 quoted in the note. It does not name SQLite. It forbids downloaded code that changes functionality. A data pack is not that sentence. It is also not an Apple approval.

ODR size table fetched from the archive guide: 512 MB per tag after slicing, 20 GB hosted, iOS bundle 2 GB. The 2026 advanced-optimization article still links that guide and says a web-service download via URLSession is the alternative when ODR is not used. The 2026 thinning article says a cellular install limit exists and does not state the megabyte number. 200 MB was not on any Apple page fetched today.

Competitor homepages: getcollectr.com 200, no catalog-packaging sentence. tcgcollector.com 403. pokellector.com 200, app links and disclaimer, no packaging sentence.

## Incomplete

- No phone, no simulator, no `sqlite3` on this host. ATTACH, journal mode, backup-flag inheritance, and jetsam were not executed.
- jeep-sqlite README raw URL 404'd. Web facts are from the plugin's Web-Usage.md and the sql.js README, not from jeep-sqlite's own source.
- SQLCipher's default journal mode was not fetched from Zetetic.
- IndexedDB quota in WKWebView: no Apple number fetched.
- WKWebView memory ceiling: no Apple number fetched. The 32 MB crash is the blob-writer README, old devices, base64 write path.
- `zstddec` generator body not read. Peak memory of `decodeStreaming` unverified.
- fzstd implementation not read. The streaming claim is the README's.
- No published zstd ratio for a text-heavy SQLite catalog. None invented.
- capacitor-blob-writer on Capacitor 7.6.10 not installed. Its table jumps from v6 to a v8 changelog line.
- ODR hosting chapter not fetched. Archive size table was.
- Competitor help/FAQ pages failed to save. Catalog loading is not documented on the pages that did save.
- Issue bodies fetched: 148, 440, 464, 623, 627, 628. The CursorWindow issue title was in the search results; its body was not fetched, and the number was not trusted. Not quoted as a 2 MB limit.
- caniuse OPFS feature JSON 404'd. iOS 15.2 date is the WebKit blog, not caniuse.

## Open questions

1. Architect: separate connections (recommended by the driver facts) or a device test of ATTACH with `transaction: false`? Web cannot ATTACH a second persisted database through this plugin either way.
2. Where does the catalog file live on iOS so the user DB can still be backed up? Plugin folder exclusion is directory-wide and one-shot. NC open is the native escape hatch, and it is read-only.
3. Is a full catalog on the desktop PWA in scope? sql.js cannot honor "never whole catalog in JS memory."
4. Device decoder: fzstd (tiny, stale, author warns above 100 MB, no level 20+) or zstddec 0.3.4 (maintained, streaming generator undocumented)? Builder must match that choice. Level 20+ is unsafe if fzstd is the decoder.
5. Who writes the decompressed bytes to disk without a cleartext local server? appendFile chunks are ATS-clean and still base64-per-chunk. blob-writer is faster and wants ATS exceptions the compliance note said not to add.
6. Cellular install cap in megabytes: App Store Connect will warn. Do not hard-code 200.
7. Does the owner want the user DB excluded from iCloud (prior plugin note) or included (Apple's default for user-created data)? The catalog should be excluded either way. Those two files should not share one exclusion flag.
