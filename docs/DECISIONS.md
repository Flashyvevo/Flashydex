# Architecture decision records — Phase 1

Historical ADR-001–021 are retained as the Stage A record, NOT all current instructions. BRIEF OWNER UPDATE / Fixed stack and Stage A2 ADR-022 onward override conflicting statements. In particular ADR-012/013/017/019/020's server/Next/CLI/online-backup-only assumptions are superseded below. Unchanged identity/copy/money/transfer invariants survive. Each new decision names what changed, consequences and superseded records. No app code copied by these records.

## ADR-001 — One row per physical owned copy

Context: quantity alone cannot describe differing certificates, condition, purchase costs/dates/sources, locations and notes. Decision: OwnedCard is one physical item; bulk-add N inserts N UUID rows transactionally. Quantity and duplicates are query aggregates, not mutable columns. Group identity is language+catalog ID (or custom UUID)+variant+variantDetail, independent of condition/grade. Extras=SUM(count-1). Consequence: slightly more rows, lossless edits/export and no ambiguous per-copy metadata arrays. Rejected: one quantity row per card/condition, separate quantity decrements that lose certificates. Defined in DATA-MODEL and API OwnedCreate/BulkAdd.

## ADR-002 — Language is part of every catalog identity

Context: localized EN/JA metadata/IDs must never overwrite each other or combine ownership. Decision: composite `(language,id)` primary keys on catalog identities, sets and cards; every catalog URL/owned FK includes language, only en/ja initially. Keep provider id exact, not synthesized en: prefix in catalog_card_id. Consequence: explicit composite FKs/joins and separate set completion. Future languages can extend checks/contracts through migration. Reference Pokeum's globally single-language keys are not copied.

## ADR-003 — Permanent identity ledger, replaceable catalog cache, personal snapshots

Context: real FK integrity and cache-wipe safety conflict if owned rows directly reference disposable metadata. ON DELETE SET NULL also destroys source identity/exactly-one semantics. Decision: immutable catalog_identities ledger is the stable CatalogCard identity target; CatalogCard metadata is its replaceable detail. OwnedCard and PriceSnapshot reference ledger RESTRICT, catalog metadata references ledger; user copies retain denormalized name/set/local/language/art/rarity. Metadata deletion never touches copies; identity deletion blocked while referenced. Consequence: one extra small table and ledger stubs on offline import. Cache wipe excludes ledger. No unenforced dangling strings, disabled FKs or catalog->collection cascade.

## ADR-004 — Explicit custom identity, exactly one source

Context: catalog coverage must not block manual entry or stable export. Decision: CustomCard definition has UUID; SQL XOR check selects catalogCardId or customCardId. Definition reused by copies, no automatic name match to catalog, no implicit migration on sync. Editing definition doesn't overwrite stored copy snapshots. Referenced custom definition cannot be deleted/change language. Consequence: deliberate custom edits can diverge from historic copy display; JSON preserves both, CSV warns about limitation.

## ADR-005 — Single canonical variant plus explicit detail

Context: TCGdex flags, detailed variant types and marketplace keys are not identical; edition/stamp can combine with foil. Decision: closed canonical enum normal/holo/reverse_holo/first_edition/promo_stamped/shadowless/other; variantDetail carries explicit qualifier/unknown provider label. First-edition normal/holo use detail normal/holo; other requires detail. Preserve raw provider flags/details separately. Consequence: no price borrowing across ambiguous combinations, unknown variants remain representable and duplicates don't collapse distinct printings. Rejected: directly storing arbitrary marketplace keys as app enums, multiple boolean flags that falsely promise exact physical-combination inference. Available flags advertise, never prohibit owner-confirmed manual variant.

## ADR-006 — Unknown condition and graded presence are explicit

Context: unknown condition isn't NM; raw prices must not value a slab. Decision: condition nullable NM/LP/MP/HP/DMG, Grade child row presence means graded, company enum and optional cert stored as text. Grade labels remain text (including Authentic); no redundant isGraded flag or cert uniqueness. Consequence: raw/graded filter joins Grade, no grade multiplier and no fake default condition; graded valuation requires manual override.

## ADR-007 — Purchase event separate from allocated per-copy cost

Context: a lot can share purchase source/date while cards have different or unknown allocated cost. Decision: Acquisition stores date/source/notes; OwnedCard stores individual cents/currency, optional acquisition FK. Bulk-created event shared by copies; bulk price is per copy. No automatic lot splitting or redundant event total. Delete event in use is blocked to protect purchase history. Consequence: editing event intentionally changes displayed shared metadata; UI states this. Unknown dates/prices valid independently.

## ADR-008 — Integer money, immutable observations, per-copy manual override

Context: provider prices may be absent, repeated, out-of-date or variant-ambiguous. Decision: integer cents + USD/EUR, decimal half-up parsing, NULL unknown, zero valid. PriceSnapshot source+variant+currency quote is append-only with semantic SHA-256 observation key excluding capture time. Use latest sourceUpdatedAt then capturedAt, detailed provider quotes before top-level fallback, explicit closed key mapping. Ambiguous Cardmarket holo suffix isn't assigned to one of two foil types. Copy-level manual override wins and is never updated by sync. Consequence: some cards intentionally unvalued, history/dedupe is deterministic. No scraping, fake prices, grade/condition multipliers or FX conversion.

## ADR-009 — Portfolio currencies and comparable gain/loss kept separate

Context: USD paid cannot be subtracted from EUR quote; unknown cost isn't zero. Decision: USD primary bucket, EUR bucket shown as-is; total value/basis show known coverage, gain/loss only intersection of known value and known cost within same currency. Manual price replaces automatic estimates in other currency too. Empty/all-unknown money null. Consequence: UI labels comparable subset and exclusions rather than claiming full portfolio profit; no invented FX or zeros.

## ADR-010 — Offset pagination and normalized LIKE search

Context: personal manager needs simple random paging/filter totals, 40k local catalog rows, no database lock-in. Decision: offset/limit default30/max50, deterministic ties, reset page after mutations/filters. Indexed normalized name columns + escaped literal prefix/contains LIKE, exact localId preserved. No FTS5/trigram dependency. Consequence: contains may scan bounded 40k data and must meet measured p95<300ms; document hardware. Not edit-distance fuzzy search. Offset can shift under writes, acceptable single-owner UI refetch behavior. Upgrade only if benchmark shows need and contracts are amended.

## ADR-011 — Set completion counts card identities, not variants or copies

Context: duplicate/variant ownership and incomplete upstream catalogs can fake completion. Decision: active fetched set manifest is universe; numerator distinct catalog IDs with any copy, denominator manifest cards, completion only when manifest fully cached. Secret/extra cards included; upstream officialCount informational. Custom cards excluded, separately counted; missing is zero ownership, duplicates by variant grouping. Consequence: partial sync shows known counts and null percent, upstream-removed rows remain cache but not current manifest universe. No full variant master-set completion now.

## ADR-012 — Durable detached sync worker and resumable leases

Context: phone must leave page; route lifetime is not a job queue, CLI and app must not race. Decision: one shared service, persistent sync_state checkpoints, detached Node worker for in-app, CLI same engine. Global unique nullable lock_key, 30s lease, heartbeat5s, token fencing, atomic checkpoint+upsert batch, bounded network concurrency/retries. Incremental fresh-window detail skip, refresh fetch all, exact manifest status not count-only shortcut. Consequence: supports persistent Node/SQLite deployment only, needs tested Windows spawn/stop and stale recovery. No Redis/cron/Python catalog writer; no progress held only in memory. Partial failure stays failed/resumable, not successful100%.

## ADR-013 — Route handlers own Phase 1 mutation boundary

Context: implementation agents need one contract for browser, automation and tests. Decision: documented /api JSON routes plus shared services; Server Components call services for reads, clients call routes. No parallel server-action mutations; sync route satisfies BRIEF's route/action choice. Same-origin/Host checks, Node runtime, no-store data responses. Consequence: no duplicate validation/transaction logic or server-fetch-loopback; route wrappers remain thin. Single trusted-LAN owner is explicit, not public unauthenticated deployment advice.

## ADR-014 — Versioned JSON is canonical; CSV is documented copy projection

Context: interoperability and lossless complete personal backup are different needs. Decision: v1 strict zod + generated Draft2020-12 JSON Schema, stable UUIDs, all personal arrays plus relevant historical prices/offline catalog refs. CSV exact45 columns one per copy, reversible formula-safe escaping, integer cents, ISO dates, represented grade/acquisition/location/groups/session data. Document omitted unreferenced entities/history/audit timestamps and custom-definition divergence. Consequence: JSON/SQLite recommended for complete recovery, no false claim CSV preserves the whole DB. Unknown JSON schema version rejected, no speculative migrators.

## ADR-015 — Preview/commit with stable-key conflict policy

Context: duplicate physical cards are legitimate, file matching by name/variant can erase ownership; generated defaults must not change between preview and commit. Decision: immutable server-side dry-run plan, exact ID then exact triple then explicit custom rules, file/hash/revision binding, skip default or update by UUID, whole-file transaction. Update-owned makes incoming grade/members authoritative; missing owned rows never deleted. Same UUID stable; new CSV without IDs warns that new previews add new physical copies. Consequence: stale preview must rerun; no silent best-match/replace-all or skip-invalid mode. Explicit unavailable catalog ID survives as a ledger stub rather than forcing custom re-identification.

## ADR-016 — Transactional import receipts close exactly-once crash window

Context: a plan-file 'committed' flag written after database commit can be lost on crash and replay would duplicate generated copies. Decision: data_operation_receipts stores operation UUID, plan hash and exact commit result in SAME transaction as personal writes; repeat commit returns receipt for24h. app_state.collection_revision increments once per personal transaction and invalidates stale previews. Consequence: two small operational tables, excluded from personal export, no distributed queue/transaction needed. Cleanup receipts/staging doesn't change personal revision. Revision is not user/account auth or fine-grained optimistic locking.

## ADR-017 — Safe online backup and maintenance restore

Context: copying a live WAL main file is incomplete; Windows can't replace open DB handles. Decision: better-sqlite3 online backup, integrity/FK checks, staged restore with exact migration fingerprint, explicit confirmation, safety backup, exclusive maintenance coordination, stop workers/drain/close all handles before same-volume replacement, reopen/read back and rollback on failure. Consequence: controlled brief downtime; failure to quiesce is conflict, never swap anyway. Restore requires persistent local disk, startup recovery marker, not arbitrary path/SQL upload. No pretend zero-downtime multi-node restore.

## ADR-018 — Portable storage types and repository migration seam

Context: SQLite now, PostgreSQL later; implicit epochs/float money/SQLite extensions hinder portability. Decision: text UUIDs/composite keys, ISO UTC text/date strings, integer cents, integer booleans with PG BOOLEAN equivalent, validated JSON TEXT, explicit FKs/checks/indexes, Drizzle migrations; repository isolates SQLite APIs. Consequence: future PG schema/migrations/backup adapter required and tested, not a claim that SQLite SQL works unmodified. No multi-dialect runtime abstraction or PG setup in Phase1.

## ADR-019 — LAN HTTP manual UX, HTTPS PWA installation

Context: phone can browse LAN HTTP but service workers/install/camera need secure origin. Decision: bind0.0.0.0:3200, support browser manual workflow over LAN, test installability on trusted local HTTPS/production build; shell caching only, no personal API/offline writes. Consequence: honest platform limitations rather than a fake install claim, no camera in Phase1. Private firewall, basic same-origin protection; full auth/TLS ops beyond this scope must precede public exposure.

## ADR-020 — Recognition deferred behind a server-side seam

Context: current phase is manual manager, future phase uses Python recognizer and mobile scanning. Decision: create minimal ScanSession schema now, FastAPI health skeleton only, shared future request/candidate envelope maximum3 candidates and Next-only service calls. No implemented recognize endpoint, embeddings/OCR/camera/confidence tuning or scan UI. Consequence: stable copy/session FK and service vocabulary without premature algorithms or model installation; full scanner MVP remains incomplete by design.

## ADR-021 — Reference inspiration, not blind code transfer

Context: MIT Pokeum offers working sync/parsing but uses a different persistence/language model and later recognition concerns. Decision: cite app/reference/tcgdex.py pure parsers/retries/asset URLs, store.py conflict-upsert pattern, sync.py bounded work; do not transfer unlocalized keys/count-only freshness/default-normal/swallowed failure behavior. app/models.py informs vocabulary only, not recognition implementation now. Consequence: no code copied at Stage A; any implementation copy must retain MIT notice in THIRD_PARTY_NOTICES.md. Live sample confirms repeated price blocks and Cardmarket suffix ambiguity requiring stricter adapter tests.

## Stage A2 — accepted owner-pivot decisions

These entries implement the A2 App Store OWNER UPDATE / Fixed stack, not proposals to change that stack. ADR-039 records the later compression/storage update's precedence and required A3 amendment. Historical ADR text above remains for traceability; neither historical server choices nor superseded A2 storage assumptions are current owner intent.

## ADR-022 — Local-first, no required server

Supersedes ADR-012/013/019 deployment assumptions. Context: App Store reviewers/owners cannot depend on a private PC. Decision: catalog AND personal collection in device SQLite, offline launch/reads/mutations/import/export; no required account/server/API. Unsynced empty states/custom entry work offline, sync optional explicit action. Consequence: offline edits are Phase1, not deferred; no HTTP auth/Origin/Host/error/status/multipart or server maintenance protocol in app. Core typed errors replace HTTP statuses. Server backup/sync only Phase7 opt-in. Rejected: shipping LAN web client requiring owner's Next server.

## ADR-023 — Capacitor7 native shell, Vite/React19 monorepo

Supersedes ADR-013/019 and old Next layout. Decision: apps/mobile uses Vite+React19+strict TS+Tailwind4+TanStack Router file-based+TanStack Query, Capacitor7 committed ios/android, npm workspaces. Core domain logic packages/core, shared schemas packages/schemas, optional Python health services/recognition. UI/data hooks ->core methods, no server actions/route handlers. Preserve UX URLs, add requested /custom-cards/new and /settings/locations; $param route files not Next bracket directories. Disabled Scan explainer permitted but no working /scan/camera. Node>=22 includes24; Vite LAN3200 only. FLASHYDEX_ env prefix/public client config, user preferences in DB. Consequence: Mac native build required; no production Node deployment or website server.url wrapper.

## ADR-024 — Drizzle sqlite-proxy with portable async driver

Updates ADR-018, supersedes runtime better-sqlite3 assumptions. Decision: same core Drizzle sqlite-proxy queries on plugin native, plugin->jeep-sqlite/sql.js web, and better-sqlite3 async test adapter in Node. Core never imports platform/React/Node packages. TEXT/INTEGER/0-1/null/check/FK types supported; no JSON1/FTS/rowid/BigInt/Buffer/sync-driver dependence. Explicit positional projection mapping, iOS metadata normalization. No RETURNING reliance despite documented returnMode/Changes.values (Electron wording doesn't prove cross-platform parity); UUID+SELECT instead. run/query single statement, DDL execute, explicit UnitOfWork transaction with inner auto-transaction=false; all tasks queue, no network in transaction. Consequence: adapter parity/injected-failure tests mandatory, no fake repository-only integration or Drizzle better-sqlite3 substitution.

## ADR-025 — Core ordered SQL migrations on app startup

Updates ADR-018, supersedes external prestart migration command. Decision: drizzle-kit generates checked-in packages/core/migrations/*.sql, bundled at build. Core migrator tracks schema_migrations version/checksum/appliedAt, checks ordered applied prefix, one file+receipt atomic; statement-breakpoint-aware single-statement execution, no naive semicolon split. Bootstrap/seed app_state+app_settings, rerun no-op. Refuse future/checksum drift without empty replacement. No plugin upgrade-list second migration authority, no downloaded SQL. Raw restore exact supported fingerprint. Consequence: test actual plugin DDL/transactions and web persistence; no dual schema version truth.

## ADR-026 — Explicit CapacitorHttp native, fetch web

Overrides old universal-fetch wording only at transport seam; no SDK remains. Context: WKWebView transport quirks, both API/CDN BRIEF-verified CORS*. Decision: Platform.http explicit CapacitorHttp.request native, fetch web, no global patch; allowlisted HTTPS/encoded IDs/lowercase headers/validated JSON/304 no body. ETag discovery optimization, not data freshness proof; web falls back when headers/preflight unavailable (CORS* alone doesn't expose ETag). No required custom User-Agent on web. Native cancellation fences/discards late responses; no claimed AbortController native HTTP support. Consequence: same sync tested fake HTTP, no proxy/server or duplicated fetch domain logic.

## ADR-027 — Foreground app-scoped resumable sync

Supersedes ADR-012 detached worker/CLI and adjusts freshness policy. Decision: singleton SyncService persists checkpoint v2 per language/set/card, chosen all/followed sets, language selection frozen in run, concurrency8 configured6..8/adaptive floor1, retry initial+3 with backoff/jitter/Retry-After. Unique lock/fencing/heartbeat remain as app executor. Navigation continues foreground work; suspend/kill/tab closure may stop, startup interrupted/user resume. Metadata+prices+checkpoint atomic batches<=25, web flush before reported progress. Set-list304 doesn't suppress detail/price work. Separate prices_only re-GET detail writes only price snapshots+progress. No scheduled nightly/background jobs. Consequence: honest foreground limits; failed units not false100%, cancelled run retains useful data. Durable single-writer web-instance lock required in addition to DB lease.

## ADR-028 — Prebuilt catalog snapshot later, not Phase1 pipeline

Context: ~36k requests/~15–25min estimate and mobile storage/memory make catalog bootstrap expensive. Decision: leave a CatalogSource seam for later verified CI-generated .sqlite.gz snapshot staged/validated/imported as CATALOG ONLY. Never replace personal/settings/receipt tables or identity ledger referenced by collection. Phase1 implements direct REST crawl only; no snapshot producer/downloader, remote migrations or whole-user-DB overwrite. Consequence: future snapshot schema fingerprint/integrity/provenance/swap design required, not an undocumented shortcut now.

## ADR-029 — Grouped collection binding ruling and complete filters

Updates ADR-001/005/010 display query, not physical storage. Decision: groupBy:'card' one tile per(source,language,cardId,variant), qty and complete matching copyIds plus whole-group totals/IDs/representative/detail-condition-grade summaries. variantDetail remains precise duplicate identity subgroup, NOT extra top-level tiles. Filter copies then group/page; default grouped, explicit copy pages. ALL SPEC filters plus localId/no-price in selected currency/known series tcgp hide, collecting/completion and count/value sorts documented. Unknown-series offline snapshots retained. Dashboard unique/extras remain precise identity+variant+detail, whole collection totals never silently filtered. Consequence: no per-copy grid fallback, explicit partial-group semantics/no page-then-collapse; bounded full DTO hydration despite complete ID arrays. Recognizer abbreviation/manifest requests not Phase1 scope.

## ADR-030 — Logical flashydex.db vs plugin physical naming

Context: owner naming requirement vs plugin API appends SQLite.db (verified v7 API). Decision: public logical name/export basename flashydex.db; connection flashydex, actual flashydexSQLite.db resolved through getUrl in platform adapter. Never hack plugin files/native connection naming to force misleading path or hardcode sandbox path. Generated raw exports flashydex-<UTC compact>.db. All product names FlashyDex, build env FLASHYDEX_. Consequence: tooling documents plugin suffix explicitly, no stale product tokens; this is a capability distinction, not a product rename.

## ADR-031 — Local Filesystem/Share transfer and capability-safe backups

Updates ADR-014/015/016, supersedes ADR-017 native online-backup assumption. Decision: JSON v1 and exact45-column CSV unchanged, local picker/staged bytes/hash/plan then strict preview/atomic receipt commit. Native private persistent staging, Filesystem cache export/getUri/Share, web File/Blob download/private staging. No server upload/paths. JSON always portable backup; settings/catalog excluded v1 deliberately. Raw DB extra where tested: quiesce/checkpoint/close/copy/reopen/integrity/FK check, not live WAL main-only copy. Raw restore only proven platform capability, exact schema fingerprint/explicit RESTORE/safety copy/recovery marker; unsupported offers JSON merge/update honestly. Plugin JSON schema not portable app schema. Consequence: platform fakes plus actual OS tests, share cancellation not failed saved collection/external save guarantee. Receipts still same DB transaction; settings omitted doesn't break transfer v1.

## ADR-032 — Typed local AppSettings and web durable-ack boundary

New operational preferences, updates ADR-016 revision scope. Decision: app_settings singleton languages/followed sets/all switch/hide Pocket/default currency/disclaimer ack+time/onboarding time. Defaults explicit, first-run can skip, no network gate; schema_migrations second new operational table. Settings writes don't change personal collectionRevision or sync selection already frozen. SQL COMMIT on web not durable: await saveToStore with queue held, quota failure PersistenceError/stopped writes/reopen/recovery, not false Saved or blind bulk retry. IndexedDB documented baseline, OPFS not claimed for v7. Consequence:17 schema tables, portable v1 unchanged, browser multi-instance/eviction/memory caveats explicit.

## ADR-033 — Upstream publication/image/availability facts in schema

Amends ADR-011 and old catalog shape per binding BRIEF research. Decision: catalog_sets.status published/unpublished, empty shells stored/rechecked every catalog run even304/hidden normally; series is serie.id for tcgp. nullable image_url already valid and now explicit first-class state. Keep raw normal/holo/reverse/firstEdition plus w_promo 0-1 columns, wPromo no UI. Manifest count not upstream advertised count; official0 localId alone. Consequence: fixtures empty JA/EN shells/count mismatch/missing art, no forever-synced shells or invented image path/normal choice. Existing identity ledger/personal snapshot/FK invariants unchanged.

## ADR-034 — Qualified print price reconciliation from research

Refines ADR-005/008; supersedes low/trend fallback and root/shared-product assumptions in original architecture. Decision: enum unchanged; detail qualifies ball/gold/unlimited/edition-shadowless/stamp/subtype/size. Match detailed print attributes/product/key exactly, never variantId/order. Ball reverse uses holofoil on its OWN product; edition/unlimited keys chosen explicitly, shadowless null not sibling price. USD market->mid->null, EUR exact-print avg(mid)->null; auxiliary low/trend displayed/stored, never automatic fallback. Raw root fallback only one unambiguous detailed row; semantic providerVariantKey product+priceKey+qualifier for differentiated products prevents price history collision. Unknown/ambiguous quotes display-only other; no guessed cents/FX. Consequence: mapping table/fixtures binding; qualifiers expanded without enum/transfer structural version change; legacy keys still readable.

## ADR-035 — App Store/privacy constraints are Phase1 gates

New owner requirement. Decision: no required server/login/remote code loading, bundle app/WASM/migrations. FlashyDex-only name/icon/splash/store screenshots, no protected marks/art. Exact non-affiliation disclaimer in Settings/About, no collection by us; disclose direct TCGdex request metadata, user export/share, actual OS backup. Permission strings ready but no camera/photo prompt Phase1. Required-reason privacy manifest/plugin encryption export-compliance reviewed. Safe areas/44px targets/rem text scaling/VoiceOver labels/reduced motion/native share+haptics. Consequence: P/M criteria now, not promise of approval; actual iOS build/device evidence required, unknown rights/privacy details surfaced to director.

## ADR-036 — Repository/device benchmarks replace HTTP latency

Updates ADR-010/019. Decision: SAME core public-method validation/transaction tests via sqlite-proxy real temp-file Node adapter plus actual plugin parity. Core component vitest/Testing Library, Playwright Vite390×844+1280×800, pytest health. Search40k p95<300ms measured repository resolution including bridge, not old server route latency;10warmups/100samples, report hardware/p50/p95/max. Vite dev phone queryFn performance.now measurement explicitly documented; desktop Node preliminary only. Collection10k p95<300ms/dashboard<500ms retained, batching and render limits. Consequence: exact test/error/state criteria, no fake HTTP coverage or build-only completion, Mac/phone missing means outstanding.

## ADR-037 — PostgreSQL mirror and optional recognition adapters later

Updates ADR-018/020. Decision: PG possible SERVER-SIDE MIRROR Phase7, not device DB replacement; separate PG schema/migrations/export/conflict/auth work later. Recognition Phase2 seam has optional FastAPI endpoint OR on-device ORT Web/Mobile, same max-three-candidate contract, editable confirmation uses ordinary collection methods. Phase1 Python health skeleton never startup dependency, no Next proxy. Pokeum weights unavailable, no fake histogram production replacement. Consequence: no required server in any Phase1 flow, recognition/model packaging/auth/provenance review deferred with UX follow-up.

## ADR-038 — Evictable image cache and measured storage budget

Updates ADR-019 offline interpretation. Decision: offline app/metadata/personal data now, not guaranteed offline art; CDN low/high.webp in WebView/HTTP/browser cache only, explicit offline image cache Phase7. Native packaged shell/web PWA shell+WASM offline separate from LAN HTTP install limits. Catalog footprint4/8/12KiB×36,517 ->~143/285/428MiB before indexes/history;250–700MiB initial planning range,>=2x DB free space for staging, measure actual. sql.js RAM/flush/quota can limit full web catalog, smaller selections/low-space warnings/JSON backup. No unlimited OPFS/quota promise. Consequence: asset/storage failures honest, no metadata loss or fabricated placeholders masquerading as cards.

## ADR-039 — Later owner storage update requires separate Stage A3 amendment

Context: during this A2 run the director added BRIEF OWNER UPDATE2026-10-31 / docs/COMPRESSION-STORAGE.md and the separate A3 task. It supersedes the A2 task's explicit single-DB/crawl-primary/snapshot-later/JSON-plus-raw-backup scope. Decision: preserve requested A2 work as a clearly labelled baseline, put precedence notices on affected docs, and hand off rather than silently implement unassigned multi-DB/zstd/.fdx/new-file scope. Current owner intent is three DBs, production zstd packs/atomic installer, .fdx settings-aware backup, cache interface/metrics; A2 alone is NOT current design complete. A3 must amend placement/FKs, migrations, CatalogInstallService, backup format/restore, streaming/memory/bundle/metrics tests and supersede ADR-028/030/031/032/038 as needed. Consequence: do not implement those superseded A2 choices as owner-approved current storage. No claim A3 requirements were verified or built here.
