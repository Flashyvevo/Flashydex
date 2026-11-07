# FlashyDex — catalog packs (Stage A3)

Normative Phase 1 design, not a claim of implemented/device-tested support. BRIEF's two OWNER UPDATEs and [COMPRESSION-STORAGE](COMPRESSION-STORAGE.md) govern. ADR-040–048 record this amendment. Catalog packs are the primary bootstrap/update path NOW; direct TCGdex requests remain refresh/fill-in. No personal data may enter a replaceable catalog. Recognition packs are separate, independently versioned Phase 2 zstd artifacts; f32/f16/int8 benchmarks and no source-image library remain binding, not Phase 1 implementation work.

## Driver capabilities

Evidence fetched with curl for this revision, pinned to `@capacitor-community/sqlite` v7.0.3 (Capacitor 7), with jeep-sqlite 2.8.0 source inspected. This is source/document verification, NOT execution on iOS/Android. Terra must pin the actual resolved versions and run the spikes below; do not infer v7 behavior from v8 master.

| Capability | Verified finding and design consequence |
|---|---|
| Native ATTACH via execute | v7 API exposes raw `execute` (no bind array), single-statement `run` with values, `query`, transactions on iOS/Android. It does NOT explicitly promise ATTACH. iOS `Database.executeSQL` delegates to `UtilsSQLCipher.execute`, whose non-DELETE path calls `sqlite3_exec`; Android `Database.execute` calls `_db.execSQL` per statement. Neither path inspected blocks ATTACH. Thus file-backed unencrypted ATTACH is source-supported in principle on BOTH, not proven on either device. Use `execute(ATTACH..., transaction=false)` OUTSIDE a transaction, fixed aliases `cat_en`/`cat_ja`, adapter-generated/private escaped paths only. No user SQL/paths, no assumption that bound ATTACH through `run` works cross-platform. `run` is documented for bound DML; iOS prepares/binds arbitrary SQL, but this is not a portable ATTACH guarantee. See S1–S4. |
| Web ATTACH | sql.js can interpret SQLite ATTACH SQL within its own virtual filesystem (e.g. a new in-memory attachment); that is NOT attachment of another jeep IndexedDB DB. jeep opens each stored byte array as a separate `new SQL.Database(retDB)` and persists each main DB with `mDb.export()`. No plugin/jeep API mounts an existing IndexedDB DB into another connection's VFS or persists an attached file. Therefore `ATTACH 'catalog-en.db'` cannot be relied on to expose the installed jeep catalog; it may merely create an empty virtual file. Web uses independent connections + TypeScript joins, never the native ATTACH path. Sources S5–S7. |
| Native opening a raw file | Conformed connections expect logical `foo`/`foo.db` -> physical `fooSQLite.db`. iOS configurable `Library/CapacitorDatabase`; Android app-private databases directory, not generic Filesystem `Directory.Data`. A closed externally written ordinary SQLite file with the correct name/location can be opened by conformed createConnection/open; native source opens the file directly, not JSON-only import. Existence must be checked BEFORE open (open may create an empty DB). `getUrl` resolves a connection's actual URL; it is not an arbitrary-path import/setter. See S1–S4, S8. Write-then-open a 100 MB file still needs native proof. |
| Exact unsuffixed/raw-path files | `getNCDatabasePath` + `isNCDatabase` + `createNCConnection(path, version)` support native non-conformed raw paths but READ-ONLY. Suitable for candidate validation of exact `catalog-en.db`; NOT the active refresh-writable catalog path. Do not claim NC connections can upsert prices. See S8. |
| copyFromAssets / HTTP / JSON | `copyFromAssets` copies bundled assets/databases (web also needs databases.json); it is not an arbitrary staging-file API. `getFromHTTPRequest` downloads DB/ZIP, not our size/hash/zstd/rollback protocol. `isDatabase` checks existence without connection, not integrity/version. `importFromJson` accepts the plugin's JsonSQLite schema/DDL, not a raw SQLite byte stream, not CollectionExportV1, not .fdx. None is used as a shortcut around our installer. S1, S8. |
| Large web catalog | Web-Usage explicitly describes development usage: sql.js in-memory queries, localforage/IndexedDB whole-database persistence at saveToStore/close/closeConnection. sql.js README explicitly warns native bindings avoid loading the entire database in memory. A roughly 60–120 MB file is a planning TEST SIZE, not a measured FlashyDex pack size or supported limit: open requires a full byte array + WASM pages; export/IndexedDB serialization adds copies, two open languages add pressure. Worker zstd alone cannot remove sql.js's whole-DB load. No documented safe 100 MB ceiling or guaranteed OPFS persistence in this pinned driver. S5–S7. |
| Web durability caveat | jeep 2.8.0 `UtilsStore.saveDBToStore` removes a key before setItem. Awaiting saveToStore is required but does NOT prove crash-atomic replacement or preserve the prior durable value if killed between those operations. Production-grade user persistence/pack activation must use a separately proven atomic IndexedDB transaction/generation adapter (no direct reliance on undocumented jeep internals without pin/tests). Otherwise label web dev/PWA storage experimental and block unsupported large-pack installation, keeping native iOS as the acceptance target; never silently weaken user-data safety. S6, S9. |

Issue search: GitHub search `repo:capacitor-community/sqlite "ATTACH DATABASE" in:body` returned total_count=0/incomplete_results=false; broader `"ATTACH"` returned unrelated attached-file/stack-trace matches, not a support guarantee. Absence of issues is NOT proof of support. [#583](https://github.com/capacitor-community/sqlite/issues/583) and its [maintainer comment](https://github.com/capacitor-community/sqlite/issues/583#issuecomment-2366269584) explain autosave was removed by default because saving large batches was slow. [#579](https://github.com/capacitor-community/sqlite/issues/579) reports web long tasks under CPU throttling, not a measured mobile catalog limit. [#61](https://github.com/capacitor-community/sqlite/issues/61) is historical pre-existing-file discussion, not current API proof. No retrieved issue establishes native ATTACH correctness. Queries: [exact ATTACH search](https://api.github.com/search/issues?q=repo%3Acapacitor-community%2Fsqlite%20%22ATTACH%20DATABASE%22%20in%3Abody), [web/large search](https://api.github.com/search/issues?q=repo%3Acapacitor-community%2Fsqlite%20%22large%22%20%22web%22).

Sources (raw URLs permit repeatable review):

- S1 [v7.0.3 README method matrix](https://raw.githubusercontent.com/capacitor-community/sqlite/v7.0.3/README.md), [API: locations / execute / run / isDatabase / getUrl / copyFromAssets / importFromJson](https://raw.githubusercontent.com/capacitor-community/sqlite/v7.0.3/docs/API.md), [definitions](https://raw.githubusercontent.com/capacitor-community/sqlite/v7.0.3/src/definitions.ts).
- S2 [iOS Database.swift executeSQL/runSQL/open](https://raw.githubusercontent.com/capacitor-community/sqlite/v7.0.3/ios/Plugin/Database.swift), [UtilsSQLCipher.swift execute, prepareSQL, openOrCreateDatabase](https://raw.githubusercontent.com/capacitor-community/sqlite/v7.0.3/ios/Plugin/Utils/UtilsSQLCipher.swift) (sqlite3_exec at lines 895–896; prepare/bind at 488 onward).
- S3 [Android Database.java execute/open](https://raw.githubusercontent.com/capacitor-community/sqlite/v7.0.3/android/src/main/java/com/getcapacitor/community/database/sqlite/SQLite/Database.java) (execSQL at line 420).
- S4 [iOS UtilsFile.swift](https://raw.githubusercontent.com/capacitor-community/sqlite/v7.0.3/ios/Plugin/Utils/UtilsFile.swift): configured-directory resolution and setExcludeFromiCloudBackup (`URLResourceValues.isExcludedFromBackup=true`). Backup exclusion is source-confirmed here; actual archive/device policy must still be audited.
- S5 [v7 Web-Usage](https://raw.githubusercontent.com/capacitor-community/sqlite/v7.0.3/docs/Web-Usage.md), [web.ts](https://raw.githubusercontent.com/capacitor-community/sqlite/v7.0.3/src/web.ts).
- S6 [jeep-sqlite 2.8.0 database.js](https://unpkg.com/jeep-sqlite@2.8.0/dist/collection/utils/database.js) (open lines 30–40; exportDB 144 onward), [utils-store.js](https://unpkg.com/jeep-sqlite@2.8.0/dist/collection/utils/utils-store.js) (setDBToStore/saveDBToStore), [utils-sqlite.js](https://unpkg.com/jeep-sqlite@2.8.0/dist/collection/utils/utils-sqlite.js).
- S7 [sql.js README](https://raw.githubusercontent.com/sql-js/sql.js/master/README.md) (memory architecture; moving upstream, not a pinned device test), [jeep 2.8.0 README](https://unpkg.com/jeep-sqlite@2.8.0/readme.md) (IndexedDB, local-disk raw import, historical OOM note).
- S8 [v7 NonConformedDatabases](https://raw.githubusercontent.com/capacitor-community/sqlite/v7.0.3/docs/NonConformedDatabases.md); S1's raw file/ZIP helper descriptions.
- S9 [#583 comments](https://api.github.com/repos/capacitor-community/sqlite/issues/583/comments) plus S6 persistence implementation.

### Decision: open/attach and portable join plans

DatabaseSet opens `flashydex-user.db` plus zero, EN, JA, or both catalogs. Owner filenames are logical roles/artifact names. Conformed native connections are `flashydex-user`, `catalog-en`, `catalog-ja`, producing `flashydex-userSQLite.db`, `catalog-enSQLite.db`, `catalog-jaSQLite.db`. This suffix is a plugin convention, NOT permission to put user tables in catalogs; exact portable pack filenames remain `catalog-<language>-<version>.db.zst`. Platform.DatabaseFiles owns translation, URLs and native sandbox access. Temporary/previous files exist only for installation/recovery, not extra logical data stores.

All platforms have a correct app-level join implementation. Native adapter enables `attachCatalogs=true` only AFTER its startup/self-test and Terra spike prove existing-file ATTACH/DETACH/reopen; failure selects TS joins, not unusable startup. ATTACH is optional read acceleration; independent per-language connection remains the writer. Never concurrent writer handles to a catalog; gate attach reads and writer by language queue. Attach/detach outside transactions, fixed alias, same driver/proxy; no cross-file FK or transaction assumption. Close/detach every reader before rename. Missing catalog is normal, never open/create it silently. A corrupt installed catalog is isolated; user DB remains usable.

| Query needing both domains | Portable two-query/merge algorithm |
|---|---|
| Owned list/detail/group grid | User DB snapshots/filter/group/page first, max50 displayed rows; batch catalog existence/series/price lookups per language by exact `(language,tcgdex_id)`, max100 card keys per batch (<=400 SQL parameters). Merge optional metadata, never overwrite personal snapshots. Missing catalog ->catalogAvailable=false, manual/history valuation still available. No per-copy N+1. |
| Catalog search/detail with owned counts | Catalog page first (max50); one grouped user query for returned identities; merge counts/copies. Bilingual search merges two sorted streams with identical rank/tie comparator and global offset; count per-language filtered totals then sum. Do not take a full page from EN and ignore JA. |
| Set list/completion/missing | Read user grouped owned IDs/counts for the selected language/set; catalog active-manifest pages (<=100) intersect against owned keys. Store only identity/count summaries in TS, not all card DTOs. Missing/owned filters applied BEFORE final page/total; scan candidates in100-key chunks until page complete and total counted. Set list max50; compute summary streams for completion_desc/owned filter, sort lightweight summaries globally, then page. No advertised-count denominator or page-then-filter bug. |
| Value/no-price sort and portfolio | Stream user identity/variant/detail/manual/grade/cost aggregates in100-identity batches; read matching latest catalog quotes and user historical quotes, choose DATA-MODEL's latest-source ordering, reduce coverage/value safely. value/priced filtering and sorting occurs before page; keep lightweight identity/value summaries, hydrate only max50 results. Revision+catalog generation guard allows retry if inputs changed. Graded/no override stays unpriced. |
| Known Pocket filter | Build known series-by-(language,setId) metadata in bounded set batches, then filter user snapshots; unknown/missing catalog series stays visible. Must occur before page/count. |
| Export/restore | Export solely from user DB personal/history snapshot. Restore doesn't depend on a cross-file FK: exact key resolves current catalog if available, otherwise keep ledger+denormalized snapshots. Catalog matching never substitutes another language or rewrites copy fields. |

Two-query means one domain projection plus one batched lookup per bounded chunk/language, not literally two round trips for an entire unbounded dataset. Every composite key includes language. Operation captures user revision + catalog generation; installation acquires a short read barrier; if either changes before return, retry once then typed STALE_READ (UI refetch). Optional ATTACH query must have parity with TS filtering/paging/totals, not a different business definition. No distributed transaction is introduced.

## Pack contents and schema

One language per ordinary unencrypted SQLite pack; no images, user entities, migrations to execute, recognition indexes, or full JSON dump distribution. Uses the SAME bundled catalog SQL schema as core, built with Node better-sqlite3 in tools/catalog-builder ONLY (not mobile dependency). `journal_mode=DELETE`, no WAL/SHM shipped, page size 65536 (ADR-055; was 4096 until 2026-10-31 — web OPFS reads are per-page synchronous calls, so fewer, larger pages cut validation and cold-search time by ~10×), foreign_keys ON during build, deterministic insert ordering. VACUUM after indexes/latest prices; close before hashing/compressing.

Tables (detailed column/types/constraints in DATA-MODEL):

- `catalog_sets`: language+exact set ID, name/search/series, status, actual active manifest in raw_json, upstream official/total counts, nullable logo/symbol, source timestamps. Store unpublished shells and exclude from normal browsing, never fabricate cards from advertised counts.
- `catalog_cards`: language+exact card ID, set FK IN SAME FILE, localId text/sort, names/rarity/category/illustrator, nullable image base, availability booleans including w_promo, normalized variants and raw provider detail for supported detail fields. No FK to user identity ledger.
- `catalog_variants`: language/card_id/variant_key PK; canonical variant+variant_detail, raw type/subtype/foil/size/stamps/provider variantId, attributes JSON; card FK. variant_key derives from canonical print-attribute tuple, NOT variantId (nonunique upstream).
- `catalog_latest_prices`: PriceSnapshot field shape, one latest observation per `(language,catalog_card_id,source,variant,variant_detail,provider_variant_key,currency)` at frozen build cutoff. Exact-print mapping/NULL prices from DATA-MODEL; no fabricated USD for JA. Card FK in same file. Not all provider history.
- `catalog_meta`: singleton language/version/schemaVersion/builtAt/builderVersion/source counts/source cutoff/schema fingerprint; immutable baseline metadata. Current refresh changes catalog rows, not baseline version/hash. `schema_migrations`: exact catalog-family migration receipts/checksums generated by trusted builder.

Device refresh writes this baseline catalog's cards/variants/latest prices in place. API observations for OWNED identities are ALSO recorded as immutable history in user.price_snapshots (not every build's entire catalog history). History learned on device survives replacement. Current valuation considers catalog baseline plus preserved user observations by source timestamp, not blindly latest installed build time. Manual override, annotation, custom card and copy snapshot are ALWAYS user DB. Catalog user corrections never go into raw provider cache; use user.catalog_annotations overlay for display corrections/notes and per-copy manual price override for valuation. Installing the next pack replaces device fill-ins/refresh-only metadata; explain that newer single-set fill-ins can require re-fetch. No silent correction loss.

## Manifest: JSON Schema and semantics

`catalog-manifest.json` is UTF-8 Draft2020-12; schema below is normative target for packages/schemas generation, not code added by this stage. Root currentVersion/targetVersion denote published release transition; per-language entries own their transition because EN/JA may advance independently. Device installed current version comes from installed_catalogs, NOT the remote `currentVersion`. Null currentVersion means first release; delta only applies on exact installed base. `sha256` ALWAYS hashes the UNCOMPRESSED, closed SQLite bytes (lowercase hex); optional compressedSha256 protects downloaded zstd separately. This avoids ambiguity in owner's decompress-then-SHA sequence. Counts are actual rows, not advertised totals.

```json
{
  "$schema": "https://json-schema.org/draft/2020-12/schema",
  "$id": "https://flashydex.local/schemas/catalog-manifest.v1.schema.json",
  "type": "object",
  "additionalProperties": false,
  "required": ["manifestVersion", "currentVersion", "targetVersion", "builtAt", "languages"],
  "properties": {
    "manifestVersion": {"const": 1},
    "currentVersion": {"anyOf": [{"$ref": "#/$defs/version"}, {"type": "null"}]},
    "targetVersion": {"$ref": "#/$defs/version"},
    "builtAt": {"type": "string", "format": "date-time"},
    "languages": {
      "type": "object", "additionalProperties": false, "minProperties": 1,
      "properties": {"en": {"$ref": "#/$defs/entry"}, "ja": {"$ref": "#/$defs/entry"}}
    },
    "signature": {
      "type": "object", "additionalProperties": false,
      "required": ["algorithm", "keyId", "value"],
      "properties": {
        "algorithm": {"const": "Ed25519"}, "keyId": {"type": "string", "minLength": 1, "maxLength": 80},
        "value": {"type": "string", "pattern": "^[A-Za-z0-9+/]{86}==$"}
      }
    }
  },
  "$defs": {
    "version": {"type": "string", "pattern": "^[0-9]{4}\\.[0-9]{2}\\.[0-9]{2}\\.[0-9]{3}$"},
    "hash": {"type": "string", "pattern": "^[a-f0-9]{64}$"},
    "bytes": {"type": "integer", "minimum": 1, "maximum": 9007199254740991},
    "https": {"type": "string", "format": "uri", "pattern": "^https://", "maxLength": 2048},
    "entry": {
      "type": "object", "additionalProperties": false,
      "required": ["currentVersion", "targetVersion", "fullPackUrl", "compressedBytes", "uncompressedBytes", "sha256", "schemaVersion", "builtAt", "counts"],
      "properties": {
        "currentVersion": {"anyOf": [{"$ref": "#/$defs/version"}, {"type": "null"}]},
        "targetVersion": {"$ref": "#/$defs/version"},
        "fullPackUrl": {"$ref": "#/$defs/https"},
        "compressedBytes": {"$ref": "#/$defs/bytes"}, "uncompressedBytes": {"$ref": "#/$defs/bytes"},
        "sha256": {"$ref": "#/$defs/hash"}, "compressedSha256": {"$ref": "#/$defs/hash"},
        "schemaVersion": {"type": "integer", "minimum": 1},
        "builtAt": {"type": "string", "format": "date-time"},
        "counts": {
          "type": "object", "additionalProperties": false,
          "required": ["sets", "cards", "variants", "prices", "unpublishedSets"],
          "properties": {
            "sets": {"type": "integer", "minimum": 0}, "cards": {"type": "integer", "minimum": 0},
            "variants": {"type": "integer", "minimum": 0}, "prices": {"type": "integer", "minimum": 0},
            "unpublishedSets": {"type": "integer", "minimum": 0}
          }
        },
        "delta": {
          "type": "object", "additionalProperties": false,
          "required": ["currentVersion", "targetVersion", "url", "algorithm", "compressedBytes", "uncompressedBytes", "sha256", "baseSha256"],
          "properties": {
            "currentVersion": {"$ref": "#/$defs/version"}, "targetVersion": {"$ref": "#/$defs/version"},
            "url": {"$ref": "#/$defs/https"}, "algorithm": {"type": "string", "minLength": 1, "maxLength": 80},
            "compressedBytes": {"$ref": "#/$defs/bytes"}, "uncompressedBytes": {"$ref": "#/$defs/bytes"},
            "sha256": {"$ref": "#/$defs/hash"}, "baseSha256": {"$ref": "#/$defs/hash"}
          }
        }
      }
    }
  }
}
```

Runtime cross-field validation additionally requires real UTC dates/calendar-valid date versions, safe integers, counts reconciliation, entry targetVersion<=root targetVersion, root currentVersion<targetVersion when nonnull, entry currentVersion<targetVersion, delta target=current entry target/base=entry current, no duplicate URL/unsupported compression, trusted repository release origin and redirect allowlist. Full pack suffix matches language+version; expected sizes must fit configured local resource limits, not trust enormous manifest claims. Phase1 cap per uncompressed catalog512MiB/compressed256MiB until measured budgets justify changing it; streaming output is stopped at expected bytes+1 regardless of header. HTTPS Content-Encoding identity for zstd; no gzip/Brotli recompression of zstd/WebP/ZIP. Manifest/text responses may negotiate normal HTTP compression.

Version scheme = date-based `YYYY.MM.DD.NNN` UTC, monotonically increasing fixed-width revision001..999 per day. Not semver: catalog content release is not a breaking API promise. Semantic compatibility lives in integer schemaVersion plus exact bundled migration fingerprint. App accepts only supported catalog schemaVersion/fingerprint; future ->APP_UPDATE_REQUIRED, keep old catalog. Do not run SQL migrations supplied by manifest/DB. Native plugin user_version stays adapter connection version1; core migration receipts/meta are authority. Release tags `catalog-YYYY.MM.DD.NNN`; artifacts immutable. Same version with different bytes/hash is a release error, never overwritten. Older target downgrade rejected except explicit local rollback. EN-only update may leave JA entry at an older target; root release is not a forced bilingual reinstall.

Signature optional Phase1, Ed25519 over RFC8785 canonical UTF-8 root with `signature` omitted; shipped public-key allowlist by keyId, no downloaded executable/key-as-trust. If present invalid/unknown ->reject, never ignore. No signing key required to ship Phase1: unsigned manifest fetched from configured repo over HTTPS with SHA integrity is explicitly NOT protection from a compromised publisher. URL repo is deployment config public metadata; Terra must resolve the actual git remote rather than invent an organization/release URL.

## tools/catalog-builder/ pipeline design

Target Node>=22 strict TypeScript workspace, plain fetch, better-sqlite3 build-only dependency, pinned zstd tool/library selected by Terra. Command contract (to implement, not existing commands): `npm run catalog:build -- --languages en,ja --version YYYY.MM.DD.NNN --resume`; `--prices-only` refreshes price observations in build work state, never alters frozen published bytes. Separate `catalog:publish -- --version ... --repo owner/repo`; network/publish never implicit in build/test.

1. Freeze run ID, UTC builtAt/cutoff, builderVersion (git SHA/toolchain), schema fingerprint, language selection. Create per-run work directory and transactional builder checkpoint DB / raw response files keyed by language+encoded request key+ETag/content hash. Secrets/tokens not in artifacts. Resume same frozen run, not a mix with already published outputs. Per-card responses have fetch time and upstream timestamps; cutoff means observed snapshot, NOT an impossible globally transactional upstream time.
2. GET `/v2/{lang}/sets`, each `/sets/{encodeURIComponent(setId)}`, each `/cards/{encodeURIComponent(cardId)}` from researched endpoints. Do not double-decode provider `%3F` tokens; preserve ID then encode once for path. Set briefs don't supply detail/pricing. Start concurrency8, backoff1/2/4s+jitter, Retry-After<=60s,429 halve, no SDK/no images. Set-list304 only skips discovery; revisit empty shells on each NEW run, separate price pass, persist manifests of actual cards[]. Research counts are historical fixtures, never hardcoded expected production totals. Use the shared pure core parser/variant-price mapper to prevent builder/device divergence; cite Pokeum idea sources, MIT notice if code copied.
3. Persist validated responses before marking units complete. Retry failed work on resume; do not publish with unexplained missing requested details, failed units, or invalid constraints. Legitimate upstream missing art/pricing/empty shell produces NULL/unpublished plus metrics/warnings, not fake data or a build failure by itself. Stable ordering and dedupe include language; assert no duplicate card/set identity.
4. Build fresh `.db.part` from bundled catalog-family migration files with better-sqlite3. One language only. Populate sets/cards/variants/latest prices with idempotent upserts/deterministic IDs persisted in the run; no user tables or history. Build meta count checks/fingerprint; enforce same indexes/checks as core. Pack inserts ordered by composite key. If same frozen inputs/config rerun, reuse verified outputs; deterministic bytes targeted by fixed metadata/toolchain, never claim bit-reproducibility across SQLite/tool versions. Same version output drift ->fail.
5. `PRAGMA integrity_check`='ok', `foreign_key_check` empty; compare actual counts/language/meta/fingerprint, reject triggers/views/virtual tables/extra tables/extensions outside bundled allowlist. `journal_mode=DELETE`, VACUUM, close all handles, assert no WAL/SHM. Hash final raw bytes with streaming Node crypto, get byte length, zstd stream compress to `catalog-<lang>-<version>.db.zst.part`, flush/close/rename to artifact. Compute optional compressed hash. Stream round-trip decompress to another file, verify byte count/SHA/integrity again, remove round-trip only after checks.
6. Produce manifest and per-language `catalog-<lang>-<version>.metrics.json`, validate schema + semantic rules, include manifest/hash in build summary JSON stdout (logs stderr). Resume completed steps by checking receipts+content hashes, never use filename existence alone. Failed run nonzero; incomplete metrics have measured=null with reason, not invented timings.
7. Explicit publish creates a draft GitHub Release of THIS repo, uploads zstd packs/manifest/metrics, reads assets back/downloads to verify lengths/hashes; publish release only once complete. CI stores build + device-benchmark metrics as artifacts. Update release discovery/latest manifest only after packs are downloadable. Existing release same version/hash is no-op; different bytes ->error. No git commit/push in this documentation task.

**Set logo fallbacks (`src/set-art.ts`).** TCGdex ships `logo` for 157/220 EN sets and none for JA. For a set with no native logo the builder resolves, in order: (1) probed alternate files `{lang}/{serie}/{id}/logo.webp|logo.png`; (2) JA only: the EN twin's logo via the hand-written `JA_TO_EN_LOGO` table (JA id -> one EN id, same product line; ignored unless that EN logo itself answers HTTP 200; count/date auto-matching was evaluated and rejected as ambiguous); (3) probed symbol (`symbol` from the set JSON, then `symbol.webp|png`). Every non-native URL needs an exact HTTP 200 HEAD, probe errors count as absent, nothing is guessed. The result is written to `catalog_sets.logo_url` (no schema change), provenance to `raw_json.logoSource` (`tcgdex|symbol|en-twin`, `null` = none), and the set-index JSON. Metrics JSON gains `setLogoCoverage` `{sets, withLogo, withSymbol, byProvenance{tcgdex,symbol,en-twin,none}}`. Sets left with no logo rely on the app's cover-card tile (UX 6.1). `--no-asset-check` skips all probing (native logos only).

## Device installer state machine and file protocol

Native mandatory path = file-backed streamed download/decode with bounded chunks, not CapacitorHttp returning a base64/string body. Platform binary transport is separate from small JSON Platform.http. A Web Worker runs zstd streaming decoder and incremental SHA256; it processes compressed file chunks and emits transferable Uint8Array output to a backpressured writer. Native bridge/file access may be main-thread-owned: relay bounded chunk messages to Platform.BinaryFiles, await each append acknowledgment; do not claim Capacitor plugins work inside workers. Native file downloader may write compressed bytes directly; worker reads chunks via adapter relay. No `response.arrayBuffer()`/`readFile()` of whole catalog, one-shot decoder, whole-file WebCrypto digest, or many unawaited base64 chunks. Provisional chunks<=256KiB, at most4 unacknowledged (tune only with measured peak); decoder zstd window max32MiB, reject larger windows. Library criteria and Terra ownership are in ARCHITECTURE/API.

| State | Durable checkpoint / transition |
|---|---|
| idle / installed | Active installed_catalogs row describes baseline version/hash/generation. No active entry = empty local catalog, valid app state. |
| checking | Validate bounded manifest/signature/URL/schema support/selected language and storage budget before creating job. Freeze entry/hash/options; idempotent same installed version+baseline hash resolves installed, not erase refreshed rows. One install job globally Phase1; same-language refresh lock held only as needed, not user write lock for full download. |
| downloading | Job ID, language, frozen entry, phase, compressedBytesDone, expected lengths, ETag, temp refs, previous active version/generation persisted in user.catalog_install_jobs. Stream to same-volume private `<job>.db.zst.part`, progress<=4Hz or every1MiB persisted. Count actual file bytes, not only HTTP Content-Length. |
| downloaded / size_checked | Require actual compressedBytes EXACT; optional compressed hash too. Reject length mismatch/HTTP error; old active untouched. No activation from incomplete Range response. |
| decompressing | Worker streams raw output to `<job>.db.part`, checks output bound/header/window, incremental SHA. Persist bytesDecoded and timings (diagnostic, not resumable decoder state). EOF/frame validation requires exact uncompressedBytes. On interruption restart decode from compressed file; no unsafe continuation of partial decoder/hash state. |
| verifying | Close/flush writer, finish raw SHA256==manifest sha256, SQLite magic and exact bytes. Wrong hash ->PACK_HASH_MISMATCH; never open/activate as valid. |
| validating | Isolated read-only/native NC candidate handle (or controlled staging conformed name) verifies queries below. Close before move. All validation executes only app-bundled queries, no provider migrations/triggers. |
| prepared | Acquire catalog-generation maintenance barrier, stop/fence same-language refresh, drain catalog readers/writer, detach aliases, checkpoint/truncate old WAL if enabled, close all catalog handles; user DB stays open. Record old file size+CURRENT digest (may differ from baseline after refresh), candidate digest and previous ref in flushed user journal BEFORE rename. Reserve old file; no deletion. |
| activating | Rename old active->private previous (if any), rename candidate->active within same volume; each rename atomic, pair is NOT one filesystem transaction. Journal+read barrier makes activation logically atomic: no reader sees missing/partial DB and startup recovers before opening catalog. Platform must prove same-volume rename semantics; copy+delete isn't activation. No cancellation after entering critical section (finish commit or rollback). |
| validating_active | Reopen existing file only (isDatabase+magic before open), recheck integrity/schema/meta/counts and lightweight search. Flush installed_catalogs update (version/hash/installedAt/status=installed, increment generation) + journal state=committed IN ONE user transaction. This durable pointer is activation commit point; then publish new handles/invalidate catalog/set/value query caches. User personal rows/revision untouched. |
| installed / cleanup | Keep previous through active reopen+durable commit validation. Afterwards remove previous/part/zst and terminal job staging on bounded cleanup. Rollback possible only while previous retained; do not promise indefinite version history. Check startup/second reopen before deferred cleanup if desired; no backup-sized leftovers without accounting. |
| cancelled / failed / interrupted / rolling_back | Cancel pre-critical stops scheduling/aborts binary transfer best-effort, fences late chunks, closes worker/writer, deletes partial decoded file; release job lock only after stop/cleanup. Network cancellation never changes active row. Failure in critical section restores previous, reopens/checks it, restores active receipt, then reports error. No previous on first install ->return to no catalog, not fabricated empty catalog DB. |

Recovery on every boot BEFORE any catalog open: job without prepared journal retains existing installed_catalogs state; mark interrupted, offer Retry. If compressed partial + strong unchanged ETag/Range/If-Range206 and exact Content-Range proved, resume bytes; otherwise restart download. Decompression always restarts. Prepared but no committed new installed row ->restore journal previous by digest/metadata (including crash between either rename or rename and SQL commit), discard candidate; if old not yet moved leave it. Committed new row ->validate active then finish cleanup; if invalid restore retained previous and old receipt. Crash during rollback repeats idempotently by file hashes/refs, never creates a new blank active DB. If neither candidate nor previous validates, isolate catalog/status=failed, show redownload, keep user DB. Persisted UI progress is advisory; actual files + receipt/journal determine truth. All paths/refs privately generated and confined.

Validation queries/allowlist: SQLite header, `PRAGMA integrity_check`, `PRAGMA foreign_key_check`, exact expected sqlite_master table/index definitions from bundled fingerprint, no triggers/views/virtual tables/unexpected objects, exact `schema_migrations` catalog fingerprint, singleton `SELECT language,version,schema_version,built_at,... FROM catalog_meta`, counts of sets/cards/variants/latest prices equal manifest, all rows language==selected, referential coverage/no duplicate keys, published-set manifests reconcile (unpublished empty allowed); sample indexed local search. Validation result is persisted; never trust only `PRAGMA user_version` or isDatabase. Read-only validation limits accidentally executing malicious schema objects. No extension loading.

Storage preflight uses measured bytes, not obsolete 250–700MiB guess: required additional space >=compressedBytes+uncompressedBytes+old-active journal/checkpoint overhead+max(32MiB,10% of uncompressedBytes) safety margin; old file is renamed, not copied. If platform needs a copy to retain old, add that full cost. Also count existing user DB/catalogs/cache/staging in total footprint. Low-space midstream/append/rename failures leave old usable. Cleanup knows active/pending/previous refs and never deletes user DB or an uncommitted rollback source.

Web: same service stages streamed decode into a tested chunk store/OPFS file, but jeep open still materializes full DB. `atomicFileReplace` and `largeCatalogOpen` capabilities false until Terra demonstrates a transactional generation store/import bridge with reopen/hash/kill tests and memory budget. No claim native atomic rename maps to IndexedDB. Unsupported ->UNSUPPORTED_CAPABILITY with native-device/download-later explanation, retain offline custom/import/owned functionality. Desktop web/PWA remains runnable dev convenience with small real fixtures or direct selected-set refresh; full-production catalogs on web are not an acceptance substitute for native. Any experimental exception to whole-DB-memory rule is explicit web limitation, not compliance with native streaming requirement.

### Languages, refresh consistency and delta seam

Adding JA later: setting selected languages alone never downloads. checkManifest shows only selected/not-installed language entry size; user explicitly installs JA, EN and user DB untouched. Owned JA restored without JA pack still displays from snapshots; exact-key metadata enriches after install. Language uninstall stops its jobs/closes handles/removes only that catalog+staging and marks installed row absent; never removes owned/history/notes/followed preferences or custom rows. Editing settings to deselect doesn't silently uninstall. EN/JA versions can differ.

Refresh uses independent catalog transaction then a USER operational checkpoint/history transaction. There is no multi-file atomic commit. Refresh payload/observationKey and pending checkpoint are persisted before application; upserts and history insertion idempotent. Crash after catalog commit before checkpoint replays safely, never marks progress done before durable catalog write. Missing checkpoint/history replay is retried; ownership never changes. Export holds user consistent snapshot; can't depend on racing catalog reads. Installer/refresh coordinated per language, token/generation fences prevent late refresh writing a newly activated file.

```ts
interface CatalogUpdateStrategy {
  kind: 'full' | 'delta';
  canApply(input: { installedVersion: string|null; currentFileSha256: string|null;
    entry: CatalogManifestEntry }): Promise<{supported:boolean; reason:string|null}>;
  materialize(input: { entry: CatalogManifestEntry; base: FileRef|null;
    destination: FileRef; signal: AbortSignal; onProgress: (p: CatalogProgress)=>void }): Promise<void>;
}
```

Phase1 DeltaStrategy always supported=false/reason='NOT_IMPLEMENTED', emits fallback reason and chooses FullStrategy; optional delta manifest entry doesn't break install. Future prefer delta only if compressedBytes<=70% of full and EXACT closed base digest==delta.baseSha256/schema/algorithm supported. Device-refreshed base usually differs from published base: full fallback, never patch wrong bytes. Delta.sha256 hashes decompressed patch payload; delta.uncompressedBytes its payload length; entry.sha256/entry.uncompressedBytes ALWAYS validate the final resulting DB. Apply patch ONLY to separate candidate, never active. Any missing base, failure/size/hash/schema/signature issue retries full once (normal full download validation still mandatory); cancellation never triggers an unwanted full download. Delta implementation absent is intentional, not an installer failure.

## Metrics contract

No compression completion claim based on ratio alone. One metrics JSON per pack build; stdout summary references it; CI archives it with manifest/toolchain. Device install metrics separate records keyed build version/language/platform/attempt; no collection IDs/card names/notes/URLs/private paths. Local development data, no analytics upload. Timings monotonic ms, sizes bytes, ratio=`uncompressedBytes/compressedBytes` (>1 means smaller transfer); report savings separately, never reverse ratio silently.

| Field | Builder measurement | Device/benchmark measurement |
|---|---|---|
| metricsVersion/runId/language/version/schemaVersion/sha256 | Required identity, frozen build inputs/toolchain | Same identity + OS/device/adapter/build profile |
| compressedBytes/uncompressedBytes/compressionRatio | Stat finalized files, calculated ratio | Actual transfer/output counters, verify expected |
| downloadMs | Post-publish read-back/download probe, otherwise null+reason='NOT_PUBLISHED'; source crawlMs is separate | Pack transfer only, report retries/resumed bytes separately |
| decompressMs | Round-trip zstd validation decode wall time | Worker start->EOF+flush (also separate verification/activationMs) |
| peakMemoryBytes | Builder peak RSS + decode subprocess peak if separate, attribution stated | Native process RSS/high-water + worker/WASM where observable; JS heap alone insufficient; null+reason if unavailable |
| installedFootprintBytes | Raw DB + actual required sidecars (zero expected after close); exclude build cache, report it separately | Active DB+WAL/SHM, user/catalog/cache totals separately, peak staging/previous bytes recorded |
| crawlMs/buildMs/compressMs/verifyMs/status/warnings | Actual durations/counts, failure nonzero | Retry/cancel/hash/schema/rollback outcomes, no fake100% |

Metrics JSON fields always present; an unmeasurable quantity is null with keyed reason in `unavailable`, never0 or invented. Per-pack development completion requires joined build/download/decode/representative-iPhone peak-memory/footprint evidence; builder-only nulls keep that gate outstanding. CI must not treat 'metrics file exists' as proof phone benchmarks passed. Native provisional gate: zstd/hash/file relay additional buffered memory bounded by window+four256KiB chunks+measured library overhead, not raw file size; report real peak and interaction long tasks, Terra sets a measured device threshold with director before claiming pass. No fixed memory multiple is asserted from desktop source review.

## Terra blocking spikes / unresolved execution evidence

1. iOS and Android v7 ATTACH: write two tiny ordinary SQLite files, execute ATTACH(transaction=false), query language-qualified user+catalog data, DETACH, refresh writer, close/reopen; test quote/space paths and failed/missing file without empty creation. Compare TS fallback exact results/totals. ATTACH failure only disables acceleration; does not block core.
2. Native write-then-open a roughly100 MB real-schema DB in configured directory, getUrl/isDatabase/NC-readonly candidate vs conformed writable active, fresh-install empty state, WAL-free close, atomic same-volume rename, force-kill every state and recover prior data. Native raw file installer capability is blocking for Phase1 packs.
3. Choose pinned streaming zstd + incremental SHA256 libraries and binary append/read/download adapters; measure WKWebView worker transfer/backpressure/32MiB-window rejection, 100 MB output without full JS allocation, cancellation/low-space/kill. No one-shot/base64 whole-file substitute.
4. jeep/sql.js test60/100/120 MB EN plus optional JA: open/save/reopen memory, long tasks/quota, transactional persistent generation replacement and user-db flush fault recovery. Default web=dev convenience, no full-native guarantees until proved; no unapproved driver swap.
5. .fdx streaming ZIP implementation, optional-image limits and restore after user-DB wipe with catalogs newer/absent; exact owned UUID/field equality. This is separate from pack validation and cannot be waived by raw DB copy support.

## Director notes — binding corrections (2026-10-30, Claude Opus director)

Rationale: `.agent/DIRECTOR-DECISIONS.md` (D18, D20, D27).

1. **Manifest entry addition (S9):** each language `entry` may carry optional `"setIndexUrl"` (same URL rules as `fullPackUrl`) pointing to `set-index-<lang>.json` emitted by the catalog builder: a JSON array of `{language,id,name,series,releaseDate,totalCount,officialCount,logoUrl,symbolUrl,status}` for every set in `/v2/{lang}/sets` (unpublished shells included with `status:'unpublished'`). The JSON Schema/zod for `entry` gains this optional property (`additionalProperties:false` otherwise unchanged). A copy of each index is bundled in the app at `apps/mobile/src/data/bootstrap/set-index-<lang>.json` so the first-run set picker works before any manifest or catalog.
2. **Dev URLs:** only when `import.meta.env.DEV`, `fullPackUrl`/`setIndexUrl` may be same-origin relative or `http://` URLs (dev packs served from `apps/mobile/public/dev-packs/`, manifest URL from `FLASHYDEX_MANIFEST_URL`, default `/dev-packs/catalog-manifest.json`). Production validation keeps `https://`. `public/dev-packs/` is excluded from production builds.
3. **Storage directories (S7, binding):** catalog DB files (active, candidate, previous) live in a backup-excluded directory (iOS `Library/Caches` or a directory with `URLResourceValues.isExcludedFromBackup = true`; Android `noBackupFilesDir` or cache). `flashydex-user.db` stays in backed-up app storage. Must be re-verified on the Mac (see `scripts/ios-notes.md`).
