# FlashyDex — local-first architecture (Stage A2)

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

No root data/ DB for app operation. Logical database/export basename is flashydex.db. Plugin connection name flashydex produces physical flashydexSQLite.db (strips supplied .db, adds SQLite.db). Platform resolves getUrl(); never hardcode a path or claim exact physical basename is preserved. ADR-030 records this distinction.

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

1. Register adapters. Web mount/define jeep-sqlite, await readiness, load bundled sql-wasm.wasm, initWebStore, open persisted DB. No CDN runtime dependency. Hold a single writable instance lock (Web Locks if available; otherwise reject second writable tab explicitly). SQLite leases alone cannot coordinate separate sql.js memory copies.
2. Open unencrypted logical connection flashydex; enable/verify foreign_keys=ON, supported busy_timeout=5000. Native WAL only after capability check; web cannot depend on WAL/native filesystem PRAGMAs.
3. Apply bundled ordered packages/core/migrations/*.sql through core migrator + schema_migrations(version/checksum/appliedAt). Bootstrap tracking table IF NOT EXISTS; each file plus receipt atomic. Drizzle-kit generates during development, never on device. Unknown future schema/checksum drift blocks without deleting DB. Initial migration seeds app_state/app_settings.
4. Load AppSettings; recover abandoned SyncState as interrupted, retain progress. Failure shows storage retry/recovery, never silent empty replacement. Mount Router/Query after init. First-run explains sync size/time, offers language/set selection and skip/offline use; no automatic full crawl.

UnitOfWork queues ALL single-connection tasks including reads, owns explicit beginTransaction/commitTransaction/rollbackTransaction; scoped handles avoid queue re-entry. Inside transaction run/execute use transaction=false (plugin default true); no nested/savepoint dependency. No network/share/haptics inside transaction. UUIDs in service then SELECT by known keys, no RETURNING/last_insert_rowid dependency. ON CONFLICT DO UPDATE, never INSERT OR REPLACE.

Proxy handles run|all|get|values. SELECT -> plugin query (one statement) -> positional arrays in explicit projection order; strip ios_columns metadata when present, preserve null/0, never rely on arbitrary object enumeration. Bound DML ->run, DDL ->execute. execute permits raw batches, but core sends migration statements singly using drizzle-kit statement-breakpoint delimiters, not naive semicolon splitting. run/query NEVER receive multiple statements. DATA-MODEL specifies compatible SQL surface.

Web COMMIT alone isn't persistence: await saveToStore('flashydex') with queue held before successful mutation/checkpoint/migration. Quota/flush failure stops writes, raises PersistenceError, never says Saved. In-memory commit may exceed durable state: reopen last persisted DB before retry, use receipt for uncertain import, never blindly repeat bulk add. Offer recovery JSON if possible. Flush committed state only. Native success is SQLite commit. Personal transaction increments app_state.collection_revision once; sync never does.

## Test same core, not a Node substitute

Vitest real temporary SQLite FILES on Node>=22 with better-sqlite3 behind async SqlDriver; instantiate Drizzle through sqlite-proxy just like app. SAME repositories/migrator/services. Do not substitute drizzle-orm/better-sqlite3 in tests (misses proxy/async bugs). Fakes supply HTTP/clock/UUID/hash/filesystem/share/haptics/fault injection, not integration repositories. Web/native parity tests cover row ordering/aliases/nulls/booleans/joins/aggregates, FK errors, rollback/migrations and reopen durability. Node passing doesn't prove iOS bridge/IndexedDB.

## Foreground device sync

SyncService is app-scoped, not component-owned. Navigation doesn't stop foreground work. Suspend stops scheduling/checkpoints if time permits; OS kill/tab closure can interrupt anytime. Startup marks abandoned run interrupted; user-requested resume. No guaranteed iOS background job, nightly scheduler, CLI or detached server process.

Selection: languages en/ja, all sets OR language-qualified followed keys. AppSettings preferences; frozen run selection. Default concurrency8, configurable6..8, adaptive throttling floor1. Unique lock_key=catalog, worker_token fencing (legacy name now means app executor), heartbeat5s/lease30s. Verify token per write transaction. Web also needs single writable instance lock.

1. Conditional GET /v2/{lang}/sets using previous successful list ETag. 304 skips discovery ONLY, never text/image/price refresh. Use saved listing, otherwise unconditional GET. CORS * does not expose ETag or guarantee If-None-Match preflight: web falls back to normal GET if unavailable.
2. Selected set detail, URL-encode IDs once including SM1+. Store advertised counts AND cards[] manifest. Empty shell ->catalog_sets.status=unpublished, hidden normally, recheck EVERY new catalog run even list304. Nonempty ->published. No count-only freshness or automatic pruning. officialCount0 displays localId alone.
3. Persist checkpoint v2. Brief upsert preserves detail, image_url nullable. Incremental fetches missing/failed/stale details (24h freshness); refresh all selected. prices_only re-GETs existing selected detail and writes PriceSnapshot ONLY plus operational SyncState, no catalog/owned update. Metadata timestamp doesn't suppress requested price refresh.
4. Fetch/validate outside SQL; serialized batches <=25 cards + deduplicated immutable prices + per-set/card checkpoint in SAME transaction/web flush. Yield between batches. Web AbortController20s; native connect/read20s each, not hard wall-time abort. Initial attempt+3 retries,1/2/4s+jitter; Retry-After capped60s. 429 halves concurrency floor1, slowly recover to configured bound. Retry transport/429/5xx, not permanent4xx/schema error. Persist failures/warnings; incomplete ->failed, never false100%.
5. Cancel persists cancel_requested, stops scheduling, aborts web if possible. Native CapacitorHttp has no guaranteed abort API: fence/drop late responses, finish bounded in-flight work. Mark cancelled/release lock, keep data/checkpoint. Resume same UUID/new token/attempt, skip done/retry failed/pending. Crash rolls back card/progress together.

Transport in apps/mobile/src/platform: explicit CapacitorHttp.request on native to bypass WKWebView quirks; fetch on web; no global patch. API and asset CDN CORS * are BRIEF verified facts, no proxy needed. Origin allowlist/encoded paths/lowercase headers,304 no JSON parse,200 zod-validated. Web cannot set User-Agent; no custom-header preflight requirement merely for client identification. No @tcgdex/sdk.

Reference ideas: .agent/reference/pokeum/app/reference/tcgdex.py pure parsers/URLs, sync.py fetch/writer separation, store.py upserts. Don't copy count-only freshness/unlocalized keys/default-normal/image download. No code copied here; implementation copying code retains MIT notice in THIRD_PARTY_NOTICES.md.

## Storage footprint and image policy

Research36,517 EN+JA briefs, ~36k detail calls; full crawl ~15–25min planning estimate, not phone SLA. Selection reduces download.

UNMEASURED planning calculation:4/8/12KiB normalized+raw metadata/card ->142.6/285.3/427.9MiB for36,517, BEFORE indexes/ledger/history/manifests/journal/serialization. Budget roughly250–700MiB initially; reserve >=2x current DB for backup/staging/serialization. Measure actual footprint/history growth. sql.js holds DB in RAM; persistence can transiently duplicate it. Browser quota/eviction/RAM vary; use navigator.storage.estimate/persist if available, low-space warnings/small selections/regular JSON export, catch quota failure. OPFS is a future adapter possibility, NOT a verified pinned-v7 jeep capability; documented baseline is IndexedDB/localforage.

Art nullable base ->styled placeholder, no invented URL. {image}/low.webp grids,/high.webp detail;63:88/lazy loading. Logo .webp; symbol univ ->selected language then .webp, nullable on404. Native WebView/HTTP/browser cache only, evictable. No predownload/base64 art/guaranteed offline art; ~26k images at16–20KiB adds ~406–508MiB thumbnails alone. Explicit offline image cache Phase7. PWA caches bundled shell/assets/WASM, not transfer files/mutation results. Production HTTPS/localhost offline testing separate from LAN HTTP.

## Transfer, backup and optional servers

IMPORT-EXPORT keeps v1 JSON/exact CSV. Picker ->bounded private file ->dryRun ->explicit confirm ->atomic commit+receipt. Native Filesystem cache/getUri ->Share; web File picker/Blob download. Share cancellation isn't export data loss; share resolution isn't proof external save.

Backup always portable JSON; raw DB copy additional capability-gated output, not fictitious native online-backup API. Quiesce sync/queue, checkpoint WAL successfully, close all handles, resolve/copy DB to cache, reopen/validate then share. Web saveToLocalDisk documented, not universal Share-compatible URI. Raw replacement requires proven platform support, integrity/FK/migration fingerprint, RESTORE confirmation/safety copy/recovery. Unsupported platforms explain JSON import merge/update, not pretend whole-DB replacement.

Phase7 optional BackupSyncPort mirrors exports/changes to owner-selected authenticated server later with opt-in/conflict/privacy design. PostgreSQL path = SERVER-SIDE MIRROR LATER, NOT replacement for device SQLite. Keep text IDs/ISO times/integer cents/explicit FKs portable; PG schema/migrations/driver/backup separate future work, no dual-dialect runtime now.

Phase2 RecognitionPort selects optional FastAPI endpoint OR on-device ORT Web/Mobile. Shared shape: image<=10MiB,languages,optional scanSessionId; status confident|uncertain|no_match|no_card_detected; max THREE ranked candidates(language/catalogCardId/confidence/optional variant hint),durationMs. Editable confirmation ->CollectionRepo only persistence path. Missing/unlicensed weights cannot become fake production encoder. Phase1 Python GET /health ->{status:ok,service:recognition,version:string}, never startup dependency; no recognizer installed.

## App Store, privacy and configuration

Bundle native HTML/JS/CSS/WASM, no production server.url website wrapper, OTA/remote code loading/evaluated JS/SQL migrations or hidden remote features. Catalog/images validated data only. Reviewer needs no LAN/server; offline empty states work.

FlashyDex identity: no Pokémon/Nintendo marks/character art in app name/icon/splash/store screenshots. Settings/About exact disclaimer: “FlashyDex is not affiliated with Nintendo, Creatures, GAME FREAK or The Pokémon Company”. Acknowledgement stored without blocking local access. Privacy: no collection by us; disclose direct TCGdex API/CDN IP/request metadata; no analytics/photo uploads. Explicit user share/export only. OS cloud-backup behavior must match policy; don't claim cloud-free if automatic backup enabled.

Prepare NSCameraUsageDescription/NSPhotoLibraryUsageDescription, never request permissions Phase1. Audit Filesystem required-reason PrivacyInfo.xcprivacy. No custom encryption; included SQLCipher/library export compliance still reviewed. Safe-area shell/sheets/bottom controls; rem/Dynamic-Type-friendly scale/no viewport text lock; VoiceOver/aria nav+primary labels,44px targets/reduced motion. Native haptics/share not prerequisites for DB writes. Actual Mac/simulator/device verification required, docs don't imply App Store approval.

Project build env FLASHYDEX_ prefix; Vite envPrefix explicitly includes it, all client values public. Name FlashyDex/logical DB flashydex.db/HTTPS TCGdex base/concurrency8 defaults; languages/sets/currency in AppSettings. No admin bearer/APP_ORIGIN/server DB path. npm run dev ->vite --host 0.0.0.0 --port 3200; no second server, stop agent-started server. Mac:npx cap sync ios && npx cap open ios. Plain LAN HTTP doesn't prove install/service-worker support.

## Capability evidence (curl checked for this revision)

- [Capacitor](https://capacitorjs.com/docs), [v7 HTTP](https://capacitorjs.com/docs/v7/apis/http): explicit native helper, patch default disabled, timeouts/large-bridge caveat.
- [SQLite v7.0.3 README](https://raw.githubusercontent.com/capacitor-community/sqlite/v7.0.3/README.md), [API](https://raw.githubusercontent.com/capacitor-community/sqlite/v7.0.3/docs/API.md), [definitions](https://raw.githubusercontent.com/capacitor-community/sqlite/v7.0.3/src/definitions.ts): native/web, suffix, transactions, single-statement run/query, execute batches, RETURNING caveat, IndexedDB/saveToStore/getUrl. Checked v7 deliberately, not only latest v8.
- [v7 Filesystem](https://capacitorjs.com/docs/v7/apis/filesystem), [Share](https://capacitorjs.com/docs/v7/apis/share): file URIs/privacy manifest/Android cache sharing/web caveat.
- [Drizzle proxy](https://orm.drizzle.team/docs/connect-drizzle-proxy), [sqlite driver](https://raw.githubusercontent.com/drizzle-team/drizzle-orm/main/drizzle-orm/src/sqlite-proxy/driver.ts), [session](https://raw.githubusercontent.com/drizzle-team/drizzle-orm/main/drizzle-orm/src/sqlite-proxy/session.ts): async positional-row contract. Tooling pins versions/proves parity.
