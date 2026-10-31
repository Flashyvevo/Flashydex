# FlashyDex — local-first architecture (Stage A3)

Current compression/storage contract: separate personal and per-language catalog databases, versioned zstd packs as primary install path, safe activation/recovery, .fdx backups, image-cache seam and measured pack budgets. [CATALOG-PACKS](CATALOG-PACKS.md) contains driver evidence, manifest schema, builder/installer state machine and portable join plans. BRIEF OWNER UPDATEs and [COMPRESSION-STORAGE](COMPRESSION-STORAGE.md) override older snapshot-later/direct-crawl-primary instructions. ADR-040–048 supersede the affected A2 choices; these documents specify targets, not completed native implementation.

Normative Phase 1 target, not an implementation claim. BRIEF OWNER UPDATE / Fixed stack override SPEC's obsolete server direction. Read [DATA-MODEL](DATA-MODEL.md), [repository interfaces](API.md), [transfer](IMPORT-EXPORT.md), [acceptance](PHASE1-ACCEPTANCE.md), [ADRs](DECISIONS.md) and [UX](UX.md) together. SQL snake_case; TS/JSON camelCase. ADR-022 onward supersede incompatible historical ADRs.

## Boundary and stack

No account, backend API, home server or required connection. Catalog AND personal data live in device SQLite. Unsynced installs launch offline with real empty states, settings/custom entry/import; synced catalog search, collection mutations, cached-price calculations and transfer work offline. Art is best-effort. No camera/recognition implementation in Phase 1. Existing assigned manual-management, price, completion and data-safety gates survive; this is not the scanner MVP.

Vite + React 19 + strict TypeScript + Tailwind v4 + TanStack Router (file-based) + TanStack Query; Capacitor 7 (iOS first, Android buildable); npm workspaces. Node >=22 (24 supported), Python3.12. No Next.js, Server Components, server actions, app HTTP routes, detached sync process or production Node runtime. better-sqlite3 is a core devDependency for Node tests ONLY, never in mobile/web bundles.

## Monorepo target

Paths describe targets, not implemented artifacts.

```text
flashydex/
  package.json                         # npm workspaces
  package-lock.json
  docs/
  apps/mobile/
    package.json
    vite.config.ts
    capacitor.config.ts                # appName FlashyDex, webDir dist
    ios/                               # generated, committed; build on owner's Mac
    android/                           # generated, committed
    public/{manifest.webmanifest,icons/,assets/sql-wasm.wasm}
    src/
      main.tsx
      startup.ts
      routes/                          # TanStack file modules, $param convention
      routeTree.gen.ts
      data/                            # TanStack Query keys/hooks/invalidation
      platform/                        # native/web Platform and SqlDriver
      components/
      styles/
    tests/                             # vitest + Testing Library
    e2e/                               # Playwright 390x844 and 1280x800
  packages/core/
    package.json                       # @flashydex/core
    drizzle.config.ts
    migrations/                        # ordered generated .sql, bundled at build
    src/
      db/{schema,driver,proxy,migrate,unit-of-work}.ts
      repositories/{catalog,collection,settings}.ts
      services/{sync,portfolio,transfer,backup}.ts
      tcgdex/{client,parse,prices}.ts
      domain/{identity,money,errors}.ts
      platform.ts                      # interfaces only
      index.ts
    tests/
      adapters/node-sqlite.ts           # better-sqlite3 behind sqlite-proxy
      {driver,migrations,catalog,collection,sync,portfolio,transfer,backup}.test.ts
  packages/schemas/
    src/{primitives,entities,api,transfer,recognition,index}.ts
    json-schema/{collection-export.v1,import-report.v1}.schema.json
    scripts/generate-json-schema.ts
    tests/
  services/recognition/                 # optional Python3.12 FastAPI health only
    pyproject.toml
    app/{__init__,main}.py
    tests/test_health.py
```

No root data/ DB for app operation. Logical roles: flashydex-user.db (personal/settings/history/operations), catalog-en.db and catalog-ja.db (replaceable, writable provider baseline). Plugin conformed connection names flashydex-user/catalog-en/catalog-ja become physical flashydex-userSQLite.db/catalog-enSQLite.db/catalog-jaSQLite.db. Platform resolves getUrl/native directory conventions; pack filenames retain the exact owner artifact names. Non-conformed exact-path connections are native READ-ONLY, validation only. See ADR-040/041 and CATALOG-PACKS Driver capabilities. No catalog cache owns a personal row or cross-file FK.

DatabaseSet always opens user DB, opens only installed language catalogs, supports 0..n catalog handles. Native ATTACH is source-supported but not device-proven: probe and enable read acceleration via fixed cat_en/cat_ja aliases only after Terra's spike. Missing/unsupported ATTACH ->independent connections and TS two-query batched merge, max50 displayed rows/100 lookup identities per batch/<=400 bind parameters. Web MUST use TS joins; separate jeep DBs cannot be attached as persisted files via the public API. No cross-file transaction or FK, no silent empty catalog creation. Joined filters/sorts/counts precede pagination; CATALOG-PACKS enumerates exact collection/search/completion/valuation/Pocket/transfer algorithms and generation guards.

Additional target paths: tools/catalog-builder/ (Node TS producer/publisher), packages/core/migrations/{user,catalog}/ (independent chains), core services/catalog-install and catalog-update-strategy, mobile platform binary-files/database-files, workers/catalog-decode.worker.ts, schemas catalog-manifest.v1/fdx-manifest.v1/pack-metrics.v1. Terra chooses/pins libraries; these are architecture paths, not app code created in this stage.

## Routes and layers

Preserve UX URLs; [param] is documentation, not Next syntax. TanStack modules use $param.

| URL | Screen |
|---|---|
| `/` | Dashboard |
| `/collection` | grouped grid / compact list |
| `/collection/[ownedId]` | exact-copy editor, snapshot-safe |
| `/cards/[language]/[cardId]` | catalog detail |
| `/custom-cards/new` | custom definition creation |
| `/custom-cards/[customId]` | custom detail/edit |
| `/sets` | sets |
| `/sets/[language]/[setId]` | detail/missing/duplicates |
| `/add` | search -> editable confirmation -> bulk add |
| `/settings` | defaults, first-run entry, About/disclaimer/privacy |
| `/settings/data` | sync/transfer/backup |
| `/settings/locations` | locations |

No /scan route in Phase1. Active nav Dashboard/Collection/Sets/Settings plus prominent Add. UX may retain center disabled Scan explainer, never imply camera works. No reload to save/navigate. URL aliases lang/cond/dupes/loc/set map into typed inputs in hooks, not HTTP requests.

```text
UI / TanStack Router
 -> TanStack Query hooks in apps/mobile/src/data
 -> packages/core repositories/services + strict zod validation
 -> Drizzle sqlite-proxy + core UnitOfWork
 -> SqlDriver
      native: @capacitor-community/sqlite
      web: same plugin -> jeep-sqlite -> sql.js WASM -> IndexedDB
      tests: Node better-sqlite3 -> SAME sqlite-proxy callback
```

Core imports schemas, not React/TanStack/Capacitor/browser/Node/native DB packages. Inject Platform/SqlDriver. Use explicit projections and batched enrichment, not per-card queries. Durable mutations invalidate collection/dashboard/set/detail keys; checkpoints invalidate catalog keys. Cancelling a stale read ignores results; cancelling UI work does not roll back committed mutations.

## Startup, migrations and durability

1. Register adapters. Web mounts jeep-sqlite, awaits readiness, loads bundled web-only sql-wasm.wasm, initWebStore and single writable-instance lock (Web Locks or explicitly reject second writable tab). sql.js copies cannot coordinate by SQLite leases alone. Web is runnable development/PWA convenience; large-pack and crash-atomic persistence capabilities are not assumed (CATALOG-PACKS evidence).
2. Open unencrypted logical flashydex-user; enable/verify foreign_keys=ON, supported busy_timeout=5000. Native WAL only after capability check; web cannot depend on native filesystem/WAL PRAGMAs. Never open an absent catalog merely to create one.
3. Apply bundled ordered packages/core/migrations/user/*.sql through core migrator + user.schema_migrations(version/checksum/appliedAt). Bootstrap tracking IF NOT EXISTS; file+receipt atomic. Initial user migration seeds app_state/app_settings. Unknown future/checksum drift blocks without deleting user DB. Drizzle-kit generates in development, never device. Catalog-family migrations are independent and applied by builder or to a staged copy using ONLY bundled SQL, never downloaded SQL.
4. Recover catalog install journal BEFORE opening installed catalogs. Validate active receipt/files, rollback interrupted activation or finish committed cleanup; then open installed languages and validate catalog schema/fingerprint. Bad catalog isolated/redownload CTA, personal data stays open. Load settings and recover abandoned refresh jobs as interrupted/user resume. First-run shows real empty states and clear Download catalog CTA with per-language transfer/storage size, cancel/skip/offline custom/import. No automatic full crawl or pack download.

UnitOfWork queues ALL single-connection tasks including reads, owns explicit beginTransaction/commitTransaction/rollbackTransaction; scoped handles avoid queue re-entry. Inside transaction run/execute use transaction=false (plugin default true); no nested/savepoint dependency. No network/share/haptics inside transaction. UUIDs in service then SELECT by known keys, no RETURNING/last_insert_rowid dependency. ON CONFLICT DO UPDATE, never INSERT OR REPLACE.

Proxy handles run|all|get|values. For all/values return {rows: positionalRowArrays}; for get return {rows: firstPositionalRow} (undefined when absent), NOT a nested one-row array; run returns the agreed empty rows payload after success. The upstream sqlite-proxy session treats get separately. SELECT -> plugin query (one statement) -> positional arrays in explicit projection order; strip ios_columns metadata when present, preserve null/0, never rely on arbitrary object enumeration. Bound DML ->run, DDL ->execute. execute permits raw batches, but core sends migration statements singly using drizzle-kit statement-breakpoint delimiters, not naive semicolon splitting. run/query NEVER receive multiple statements. DATA-MODEL specifies compatible SQL surface.

Web COMMIT alone isn't persistence: await the proven persistent-store adapter with queue held before successful user mutation/checkpoint/migration (catalog flush separately). Baseline jeep saveToStore is necessary but its remove-then-set implementation is NOT crash-atomic; Terra must prove transactional IndexedDB replacement/generation storage, or declare the web durability gate outstanding. Quota/flush failure stops writes, raises PersistenceError, never says Saved. Reopen last durable user generation before retry and check import receipts; never blindly repeat bulk add. Offer recovery JSON/.fdx if possible. Native success is SQLite commit. Personal transaction increments user.app_state.collection_revision once; provider refresh and pack operational writes never do. User and catalog commits are independent, with replay/fencing rules below, not a distributed UnitOfWork.

## Test same core, not a Node substitute

Vitest real temporary SQLite FILES on Node>=22 with better-sqlite3 behind async SqlDriver; instantiate Drizzle through sqlite-proxy just like app. SAME repositories/migrator/services. Do not substitute drizzle-orm/better-sqlite3 in tests (misses proxy/async bugs). Fakes supply HTTP/clock/UUID/hash/filesystem/share/haptics/fault injection, not integration repositories. Web/native parity tests cover row ordering/aliases/nulls/booleans/joins/aggregates, FK errors, rollback/migrations and reopen durability. Node passing doesn't prove iOS bridge/IndexedDB.

## Catalog installation and foreground refresh

CatalogInstallService (API) owns manifest/check/install/progress/cancel/recovery/rollback/uninstall. Complete state machine in CATALOG-PACKS: download ->exact compressed size ->worker streaming zstd to temp ->uncompressed SHA256 ->isolated schema/count/integrity validation ->journaled same-volume atomic renames ->active reopen ->durable installed_catalogs receipt ->cleanup previous. Old valid file survives every precommit failure/kill. Barrier prevents readers seeing a half-swap; no rename of open/WAL-active handles. All personal data stays in user DB. Delta strategy interface exists, Phase1 reports NOT_IMPLEMENTED and selects full pack. New language install touches only that language. Metrics emitted for every build/install; no data collection/upload by us.

Terra selects/pins compression/hash/file libraries, not this document. Required: true streaming zstd decode with bounded window, incremental SHA256 (WebCrypto.digest of whole file is insufficient), chunked read/append with backpressure, worker-compatible WASM with CSP/bundled runtime/no remote code, cancellation and transferables, Node/browser/native bridge integration, maintained license and measured iPhone peak RSS. A decoder that returns the entire decompressed Uint8Array is disqualified. Workers cannot assume Capacitor plugin access: main-thread adapter relays <=256KiB chunks/at most4 in flight to file writer; await append ACK. Separate native binary download-to-file transport; small-JSON CapacitorHttp is not a large base64 download solution. Spike worker memory, same-volume rename and100 MB write/open before claiming support. Web sql.js still materializes DB and remains large-pack capability-gated.

SyncService is refresh/fill-in, NOT primary bootstrap: prices, newer sets, single-set user request, optional selected-set direct fallback for web development. App-scoped, navigation continues foreground work; suspension/kill interrupts; no guaranteed background work. For a native language with no installed catalog, start returns CATALOG_NOT_INSTALLED plus Download catalog action; manual/custom/import remain. Web's explicitly experimental small catalog may be created by bundled catalog migrations with catalog_meta.version='development' (never published pack version); no acceptance shortcut. Both adapters retain direct TCGdex engine.

SyncService is app-scoped, not component-owned. Navigation doesn't stop foreground work. Suspend stops scheduling/checkpoints if time permits; OS kill/tab closure can interrupt anytime. Startup marks abandoned run interrupted; user-requested resume. No guaranteed iOS background job, nightly scheduler, CLI or detached server process.

Selection: languages en/ja, all sets OR language-qualified followed keys. AppSettings preferences; frozen run selection. Default concurrency8, configurable6..8, adaptive throttling floor1. Unique lock_key=catalog, worker_token fencing (legacy name now means app executor), heartbeat5s/lease30s. Verify token per write transaction. Web also needs single writable instance lock.

1. Conditional GET /v2/{lang}/sets using previous successful list ETag. 304 skips discovery ONLY, never text/image/price refresh. Use saved listing, otherwise unconditional GET. CORS * does not expose ETag or guarantee If-None-Match preflight: web falls back to normal GET if unavailable.
2. Selected set detail, URL-encode IDs once including SM1+. Store advertised counts AND cards[] manifest. Empty shell ->catalog_sets.status=unpublished, hidden normally, recheck EVERY new catalog run even list304. Nonempty ->published. No count-only freshness or automatic pruning. officialCount0 displays localId alone.
3. Persist checkpoint v3 in USER DB. Brief upsert preserves detail, image_url nullable. Incremental fetches missing/failed/stale details (24h freshness); refresh all selected. prices_only re-GETs existing selected detail and updates catalog_latest_prices plus user operational progress/owned-reference history only, no card metadata/owned/settings update. Metadata timestamp doesn't suppress requested price refresh.
4. Fetch/validate outside SQL; batches<=25. Persist pending payload/fencing in user sync checkpoint, commit idempotent catalog upserts/latest quotes in per-language UnitOfWork, THEN commit user checkpoint+deduplicated price history for OWNED identities and acknowledge progress. Never claim these two DB commits are atomic. Crash after catalog commit replays same payload/observation keys before advancing; unowned quotes don't create user ledger/history. Catalog install generation/token fence rejects retired writes. Yield between batches. Web must durably flush corresponding catalog before user completion receipt. AbortController20s on web; native connect/read20s each, not hard wall-time abort. Initial+3 retries1/2/4s+jitter; Retry-After<=60s;429 halves concurrency floor1, recover to configured bound. Retry transport/429/5xx, not permanent4xx/schema. Failures/warnings remain visible, never false100%.
5. Cancel persists cancel_requested, stops scheduling, aborts web if possible. Native CapacitorHttp has no guaranteed abort API: fence/drop late responses, finish bounded in-flight work. Mark cancelled/release lock, keep data/checkpoint. Resume same UUID/new token/attempt, skip done/retry failed/pending. Crash may leave catalog ahead of user progress; idempotent replay reconciles, never pretends a cross-file rollback.

Transport in apps/mobile/src/platform: explicit CapacitorHttp.request on native to bypass WKWebView quirks; fetch on web; no global patch. API and asset CDN CORS * are BRIEF verified facts, no proxy needed. Origin allowlist/encoded paths/lowercase headers,304 no JSON parse,200 zod-validated. Web cannot set User-Agent; no custom-header preflight requirement merely for client identification. No @tcgdex/sdk.

Reference ideas: .agent/reference/pokeum/app/reference/tcgdex.py pure parsers/URLs, sync.py fetch/writer separation, store.py upserts. Don't copy count-only freshness/unlocalized keys/default-normal/image download. No code copied here; implementation copying code retains MIT notice in THIRD_PARTY_NOTICES.md.

## Storage footprint and image policy

Catalogs are compressed downloads, not bundled JSON or a first-run36k crawl. The historical ~36k calls/15–25min estimate describes the BUILDER/full optional refresh, not user bootstrap. Actual finalized per-language DB/zstd bytes, ratio, transfer/decode/peak RSS/installed footprint come from pack metrics JSON; ~60–120 MB is a driver spike range, not a measured product budget. Installer preflight accounts compressed temp + decoded candidate + retained old catalog + journals/sidecars/safety margin (formula in CATALOG-PACKS). No obsolete250–700MiB guess as an acceptance result. sql.js whole-DB memory/export/IndexedDB limits make web a dev convenience for large catalogs; native is production path. Probe storage estimate/persist if available, quota failure/eviction honest, .fdx backup always recommended. No verified OPFS capability claim for jeep v7.

Art nullable base ->styled placeholder; {image}/low.webp for collection/search/sets/candidates, high.webp only detail/explicit zoom;63:88/lazy loading. Logos .webp; symbol univ->language+.webp, nullable404. Never bulk-download/recompress WebP or package image library. Platform.imageCache interface exists Phase1: resolve/touch/stats/clear/setLimit, LRU cap default200,000,000 bytes configurable150,000,000..250,000,000 bytes. Phase1 adapter mode=http-cache delegates to WebView HTTP cache and reports enforced=false/unknown byte stats, cannot promise cap/offline retention. Phase7 file-backed mode enforces cap/LRU before reporting bounded=true. Eviction never removes user-provided custom images/backup files. PWA caches shell/assets/web WASM, not private transfer files/mutations.

IPA/APK budget: application HTML/JS/CSS, UI assets, bundled schema/migrations, bootstrap manifest URL/schema/public verification keys, streaming codec/hash runtime only as needed. No complete EN/JA catalog, pack .db/.zst, card-image library, optional language data, recognition source images or unused recognition assets. Phase2 essential runtime only when actually needed, larger weights/indexes downloaded as independently versioned packs. Web-only jeep/sql-wasm assets should be excluded from native bundle via platform build profile once verified; until exclusion is implemented report actual bytes. CI inventories uncompressed bundle assets + compressed IPA/APK size by category and fails any catalog payload inclusion. No invented initial-MB result; measured bundle report required.

## Transfer, backup and optional servers

IMPORT-EXPORT keeps v1 JSON/exact CSV. Picker ->bounded private file ->dryRun ->explicit confirm ->atomic commit+receipt. Native Filesystem cache/getUri ->Share; web File picker/Blob download. Share cancellation isn't export data loss; share resolution isn't proof external save.

BackupService produces versioned compressed `.fdx` ZIP (DEFLATE JSON, STORE already-compressed images/zstd), default user data/settings/customs/optional personal images, NO catalog. JSON/CSV remain interchange, not the full backup format. IMPORT-EXPORT defines manifest/entries/caps/restore. Restore parses data only into a fresh staged USER DB with bundled migrations, validates counts/FKs/UUIDs, explicit RESTORE+safety .fdx, quiesces personal writes, atomically activates user generation with recovery journal. It never replaces downloaded catalogs or trusts archived installed_catalogs receipts. Exact (language,tcgdex_id) enrichment after fresh download, snapshot fallback when absent; zero network needed to recover owned data. No raw DB restore public API or online-backup dependency. Optional catalog payload export is explicit and capability-gated, restored only through catalog installer after separate validation/confirmation.

Phase7 optional BackupSyncPort mirrors exports/changes to owner-selected authenticated server later with opt-in/conflict/privacy design. PostgreSQL path = SERVER-SIDE MIRROR LATER, NOT replacement for device SQLite. Keep text IDs/ISO times/integer cents/explicit FKs portable; PG schema/migrations/driver/backup separate future work, no dual-dialect runtime now.

Phase2 RecognitionPort selects optional FastAPI endpoint OR on-device ORT Web/Mobile. Shared shape: image<=10MiB,languages,optional scanSessionId; status confident|uncertain|no_match|no_card_detected; max THREE ranked candidates(language/catalogCardId/confidence/optional variant hint),durationMs. Editable confirmation ->CollectionRepo only persistence path. Missing/unlicensed weights cannot become fake production encoder. Phase1 Python GET /health ->{status:ok,service:recognition,version:string}, never startup dependency; no recognizer installed.

## App Store, privacy and configuration

Bundle native HTML/JS/CSS/WASM, no production server.url website wrapper, OTA/remote code loading/evaluated JS/SQL migrations or hidden remote features. Catalog/images validated data only. Reviewer needs no LAN/server; offline empty states work.

FlashyDex identity: no Pokémon/Nintendo marks/character art in app name/icon/splash/store screenshots. Settings/About exact disclaimer: “FlashyDex is not affiliated with Nintendo, Creatures, GAME FREAK or The Pokémon Company”. Acknowledgement stored without blocking local access. Privacy: no collection by us; disclose direct TCGdex API/CDN IP/request metadata; no analytics/photo uploads. Explicit user share/export only. OS cloud-backup behavior must match policy; don't claim cloud-free if automatic backup enabled.

Prepare NSCameraUsageDescription/NSPhotoLibraryUsageDescription, never request permissions Phase1. Audit Filesystem required-reason PrivacyInfo.xcprivacy. No custom encryption; included SQLCipher/library export compliance still reviewed. Safe-area shell/sheets/bottom controls; rem/Dynamic-Type-friendly scale/no viewport text lock; VoiceOver/aria nav+primary labels,44px targets/reduced motion. Native haptics/share not prerequisites for DB writes. Actual Mac/simulator/device verification required, docs don't imply App Store approval.

Project build env FLASHYDEX_ prefix; Vite envPrefix explicitly includes it, all client values public. Name FlashyDex/logical user DB flashydex-user.db/HTTPS TCGdex base/concurrency8 defaults; catalog pack manifest HTTPS URL is public build config; languages/sets/currency in AppSettings. No admin bearer/APP_ORIGIN/server DB path. npm run dev ->vite --host 0.0.0.0 --port 3200; no second server, stop agent-started server. Mac:npx cap sync ios && npx cap open ios. Plain LAN HTTP doesn't prove install/service-worker support.

## Capability evidence (curl checked for this revision)

- [Capacitor](https://capacitorjs.com/docs), [v7 HTTP](https://capacitorjs.com/docs/v7/apis/http): explicit native helper, patch default disabled, timeouts/large-bridge caveat.
- [SQLite v7.0.3 README](https://raw.githubusercontent.com/capacitor-community/sqlite/v7.0.3/README.md), [API](https://raw.githubusercontent.com/capacitor-community/sqlite/v7.0.3/docs/API.md), [definitions](https://raw.githubusercontent.com/capacitor-community/sqlite/v7.0.3/src/definitions.ts): native/web, suffix, transactions, single-statement run/query, execute batches, RETURNING caveat, IndexedDB/saveToStore/getUrl. Checked v7 deliberately, not only latest v8.
- [v7 Filesystem](https://capacitorjs.com/docs/v7/apis/filesystem), [Share](https://capacitorjs.com/docs/v7/apis/share): file URIs/privacy manifest/Android cache sharing/web caveat.
- [Drizzle proxy](https://orm.drizzle.team/docs/connect-drizzle-proxy), [sqlite driver](https://raw.githubusercontent.com/drizzle-team/drizzle-orm/main/drizzle-orm/src/sqlite-proxy/driver.ts), [session](https://raw.githubusercontent.com/drizzle-team/drizzle-orm/main/drizzle-orm/src/sqlite-proxy/session.ts): async positional-row contract. Tooling pins versions/proves parity.

## 2026-10-31 — Owner update: production web/PWA storage

The owner is not yet an Apple developer. Primary distribution is now the HTTPS web/PWA on Netlify, installable on iOS/Android; Capacitor remains for later and native iOS/TestFlight workflows are manual-only. This dated section supersedes earlier web=development/limited, native-only full-catalog, jeep web durability/startup and HTTP-cache-only web instructions above. Native storage contracts otherwise remain unchanged. Detailed contract and curl-verified citations: [WEB-STORAGE](WEB-STORAGE.md); ADR-049–054; appended web production acceptance gates. This is a design, not an implementation or benchmark pass.

Web path: UI/hooks -> unchanged packages/core repositories/SqlDriver/sqlite-proxy -> WebSqliteWorkerDriver -> dedicated module worker -> @sqlite.org/sqlite-wasm (spike pin3.54.1-build1) -> explicitly installed opfs-sahpool VFS -> OPFS. No COOP/COEP/SharedArrayBuffer required; no full-catalog JS/WASM image, sql.js deserialize/export or transient memory fallback. Owner reference138 MB EN + one whole save copy is already276 MB decimal before overhead. One worker owns USER plus0..n language DBs, one physical connection per file; read/write wrappers share queues/refcounts. App-level bounded TS joins remain, no core changes or new ATTACH dependency.

Acquire existing flashydex-user-writer Web Lock BEFORE pool initialization/migration; second tab opens no storage, including read-only handles. Missing lock/failed worker persistence probe fails closed, not read-only sahpool initialization. Stable pool directory /flashydex-sqlite-v1, initialCapacity16 plus reserveMinimumCapacity16 on existing pools; capacity is file slots including journals/temp/previous, not MB. clearOnInit=false and preserveOnInitFailure=true are mandatory; default init-failure cleanup must never destroy USER. No wipe/removeVfs recovery. DELETE journal/FULL synchronous and OPFS xSync/flush replace jeep saveToStore. Same core afterCommit hook is an ordered durability/health acknowledgement, never a whole-DB save. Unknown commit ->write latch/reopen/receipt check, not blind retry.

Packs: bounded compressed OPFS stage ->decoder worker incremental zstd+SHA/checked createSyncAccessHandle writes ->closed ordinary raw stage ->chunk-supplier pool.importDb into unique closed generation ->unchanged core candidate validation. Staging lives outside pool directory; opaque pool files must not be renamed/edited. Public pool has chunked import, unlink and whole-array export but NO rename. importDb forces SQLite header18/19 to DELETE; require both already1 so valid pack hash is unchanged. Account compressed stage+TWO raw copies during import, not native rename-only footprint. No catalog exportFile/full-array overload. pauseVfs/unpauseVfs close/release/reacquire the WHOLE pool and are not an activation tool.

Web activation keeps generation filenames stable. Adapter-only small IndexedDB role metadata atomically moves active->previous and candidate->active, consumes candidate membership and awaits transaction completion; no bytes copied at switch. Core PREPARED journal precedes switch; core new installed_catalogs+committed journal transaction remains commit authority; barrier/reopen/rollback precede exposure. No cross-store transaction is claimed. Previous survives until durable success, inspect reads actual role+pool state and restorePrevious switches roles back. Physical atomicRename stays false; atomicActivation becomes true only after the logical pointer+journal fault matrix passes. Legacy IndexedDB USER migrates once through staged import/read-back/marker; catalogs re-download, no dual writes, no legacy deletion before verified backup.

Safari17/18 tab and installed Home Screen app are production targets, plus Chrome Android109+, Chromium108+ and Firefox111+ after worker probes (MDN sync-handle subfeature floors). Safari browser/Home Screen quota is up to60% of total disk per origin/up to80% overall, NOT guaranteed free space; embedded non-browser WKWebView is a different15%/20% tier. Always estimate/catch quota. Safari ITP can delete script storage after seven days OF SAFARI USE without site interaction; not seven wall-clock days. Request navigator.storage.persist() contextually, display real persisted/grant state and offer iOS Share ->Add to Home Screen guidance. Home Screen has its own use counter per WebKit; persist protects normal best-effort eviction but is not a documented universal ITP bypass. Private browsing is not a durable product environment; no reliable private detector or guaranteed retention. External JSON/.fdx backups remain necessary. Canonical origin and browser/PWA container transitions must not silently strand data.

Web PWA Phase1 includes app/worker/WASM/offline-shell precache, network-only/no-store manifests and packs, no cached private transfers, and byte-bounded image SW LRU (default200,000,000 payload bytes, configurable150–250 MB). Cache.put/IDB ledger reservations+reconciliation are required; maxEntries is not a byte cap and opaque responses are not measurable. Native HTTP-cache seam can remain unchanged. Prompt updates replace autoUpdate: never reload an active form/transaction/install/migration; drain/close/release then activate+reload. Vite config, SW registration, UI/Diagnostics and Netlify config need separately assigned integration ownership outside platform-only builders.

Targets: aggregate page+worker JS heap<128 MiB during real full EN install; committed SQLite+codec WASM<=96 MiB reported separately, combined non-double-counted target<160 MiB. Expected warm USER+EN40–68 MiB/install75–109 MiB are planning estimates, not results or browser ceilings. USER cache~2 MiB/each catalog~4 MiB with bounded projections; cache_size is a suggestion, not a total memory cap. Mid-range-phone cached-shell interactive startup p95<=2s, storage gate<=1.2s; real23.7k EN Chromium search p95<300ms, retain40k synthetic scaling separately. Reuse fdx:* marks, attach measurement to all workers, report unavailable metrics honestly; physical Safari17/18, kill/quota/migration/update tests remain release gates. No existing Diagnostics screen was found during this review, so one must be integrated rather than assumed.
