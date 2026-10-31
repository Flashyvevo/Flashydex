# Phase 1 architecture

Status: Stage A implementation contract. BRIEF overrides SPEC. This document, DATA-MODEL.md, API.md, IMPORT-EXPORT.md and PHASE1-ACCEPTANCE.md form one contract; DECISIONS.md explains choices. Names in these documents are normative. SQL uses snake_case; JSON/TypeScript use camelCase unless explicitly CSV.

## Scope and process boundary

One trusted owner, one collection, one long-lived Next.js Node process, one SQLite file on local disk. No authentication, public hosting, camera, recognition algorithms, user system or currency conversion in Phase 1. Bind to the LAN, not the public Internet. Phase 1 includes the explicitly assigned variants, grading, purchase tracking, pricing, set completion and data tools despite their later phase numbers in SPEC. See acceptance criteria, not the full scanner MVP, for this phase's exit gate.

Next.js 15 App Router, TypeScript strict, Tailwind v4, @serwist/next; Drizzle ORM and better-sqlite3; shared zod contracts and generated JSON Schema; vitest and Playwright. Python 3.12/FastAPI is a skeleton with GET /health only, tested with pytest. Node 22.x is required by tooling; do not silently bless the ambient Node 24 installation.

## Exact logical layout

These are implementation target paths, not claims that files already exist. Feature modules own their services and tests. Barrel exports must not import server modules into the browser.

```text
flashydex/
  package.json                         # npm workspaces: apps/*, packages/*
  package-lock.json
  .env.example
  THIRD_PARTY_NOTICES.md
  docs/                                # architecture, contracts, UX, operator docs
  .agent/reports/
  data/                                # ignored; default root, resolved from repo root
    flashydex.sqlite
    backups/
    imports/                           # UUID directories, private uploaded bytes + plans
    runtime/                           # maintenance coordination; not source control
  apps/web/
    package.json
    next.config.ts
    tsconfig.json
    drizzle.config.ts
    public/manifest.webmanifest
    public/icons/
    drizzle/                           # checked-in generated migrations + journal
    scripts/
      sync.ts                          # npm run sync -- --lang en,ja
      sync-worker.ts                   # detached worker entry, same service as CLI
    src/
      app/
        layout.tsx
        page.tsx                       # Dashboard /
        globals.css
        collection/page.tsx
        collection/[ownedId]/page.tsx  # a physical copy, works without catalog
        cards/[language]/[cardId]/page.tsx
        sets/page.tsx
        sets/[language]/[setId]/page.tsx
        add/page.tsx                    # search -> editable confirmation -> add
        settings/page.tsx
        settings/data/page.tsx
        custom-cards/[customId]/page.tsx
        sw.ts                          # Serwist, production shell caching only
        api/
          health/route.ts
          catalog/sets/route.ts
          catalog/sets/[language]/[setId]/route.ts
          catalog/sets/[language]/[setId]/cards/route.ts
          catalog/cards/route.ts
          catalog/cards/[language]/[cardId]/route.ts
          owned-cards/route.ts
          owned-cards/bulk/route.ts
          owned-cards/[ownedId]/route.ts
          acquisitions/route.ts
          acquisitions/[id]/route.ts
          storage-locations/route.ts
          storage-locations/[id]/route.ts
          collection-groups/route.ts
          collection-groups/[id]/route.ts
          collection-groups/[id]/members/route.ts
          custom-cards/route.ts
          custom-cards/[id]/route.ts
          dashboard/route.ts
          sync/route.ts
          sync/[id]/route.ts
          sync/[id]/cancel/route.ts
          export/route.ts
          imports/dry-run/route.ts
          imports/[id]/route.ts
          imports/[id]/commit/route.ts
          backup/route.ts
          restore/dry-run/route.ts
          restore/commit/route.ts
      components/
        app-shell.tsx
        bottom-nav.tsx
        card-art.tsx
        empty-state.tsx
        skeletons.tsx
      db/
        client.ts                     # server-only singleton; PRAGMAs per connection
        schema.ts                     # paste schema from DATA-MODEL.md
        migrate.ts
      lib/
        config.ts                     # server env validation + absolute paths
        http.ts                       # validation, errors, same-origin checks
        maintenance.ts                # read/write gate + worker quiescence
        money.ts                      # cents arithmetic, never FX conversion
        identity.ts                   # composite language/provider key helpers
      features/
        catalog/{repository,service,tcgdex,pricing,sync}.ts
        collection/{repository,service,valuation}.ts
        data/{export,import,backup,restore}.ts
      tests/
        helpers/database.ts
        catalog.test.ts
        sync.test.ts
        collection.test.ts
        valuation.test.ts
        import-export.test.ts
        backup-restore.test.ts
        api.test.ts
    e2e/{shell,collection,sets,data}.spec.ts
  packages/schemas/
    package.json                       # workspace name @flashydex/schemas
    tsconfig.json
    src/
      primitives.ts
      entities.ts
      api.ts
      transfer.ts
      recognition.ts                  # type contract only; no implementation
      index.ts
    json-schema/
      collection-export.v1.schema.json
      import-report.v1.schema.json
    scripts/generate-json-schema.ts
    tests/transfer.test.ts
  services/recognition/
    pyproject.toml
    .venv/                            # ignored, py -3.12 -m venv .venv
    app/{__init__,main}.py             # /health only, no model dependencies
    tests/test_health.py
```

The braced names above expand to individual files (e.g. app/main.py); no additional service or queue is required. Extra UI components may be added within implementation ownership without changing contract names. There is deliberately no scanner route or working recognition proxy in Phase 1. Bottom navigation: Dashboard, Collection, Sets, Settings; prominent Add action links to /add. Never label an inactive camera button as working.

## Request and transaction flow

Browser -> same-origin /api route -> shared zod validation -> feature service -> repository -> Drizzle -> SQLite. Server Components invoke the same read services directly for initial rendering; do not HTTP-fetch localhost from the server. Client filters/mutations use route handlers. No independent server-action mutation implementations in Phase 1: in-app sync is POST /api/sync (the route option in BRIEF), not a long-running action. All route handlers touching SQLite declare runtime='nodejs'; never Edge. No DB handles, recognition origin or filesystem paths in client bundles.

A service owns transaction boundaries; a repository does not nest its own transaction. Validate references, write copy/grade/acquisition link/group memberships, increment app_state.collection_revision, then commit together. Network I/O is never inside a SQLite transaction. SQL is parameterized. Use explicit projections and batch aggregates; avoid one query per card. Personal mutations are serializable short writes. DB busy timeout 5 seconds then 503 DB_BUSY with Retry-After: 1; never report a partially committed mutation as success.

SQLite connections enable foreign_keys=ON, journal_mode=WAL, busy_timeout=5000. Use transactions for bulk adds, imports, cascading personal deletes and each sync checkpoint. Do not use INSERT OR REPLACE (it can delete rows); use ON CONFLICT DO UPDATE. No application writes catalog identities or user snapshots as a side-effect of a GET. No external API request is necessary to view or edit an existing copy.

## Stable identity and catalog separation

Provider id alone is not a locale key. Every catalog lookup and relation includes language, currently en or ja. `catalog_identities(language,id)` is an immutable minimal identity ledger. `catalog_sets` and `catalog_cards` are replaceable metadata caches. An owned card's catalog_card_id FK targets the ledger, not the metadata cache; the ledger cannot be deleted while personal data refers to it. This is an explicit CatalogCard reference through its stable identity, not an unvalidated free-text FK. Exactly one of catalog_card_id/custom_card_id is set. Denormalized name, setId, setName, localId, language, rarity and imageUrl are personal snapshots, not live foreign joins. A cache wipe deletes catalog_cards then catalog_sets, not the ledger or personal tables. Set metadata can be rebuilt without losing any reference. Catalog sync never updates any owned-card column, including snapshots.

An owned-card identity key in calculations is `(language,catalog_card_id)` or `custom:<uuid>`. Grouped copy counts and duplicates additionally include variant and variantDetail. Variant detail prevents two distinct stamped/other printings being collapsed. See DATA-MODEL for duplicate and completion equations.

## Sync: one engine, CLI and in-app

`npm run sync -- --lang en,ja` runs from repository root (web workspace alias allowed). Flags: --lang en,ja (default en,ja), --mode incremental|refresh (default incremental), --resume <sync UUID> (optional). SIGINT requests cancellation and waits for the current checkpoint. Exit 0 completed, 1 failed, 2 cancelled, 3 another active sync. CLI and HTTP call the same catalog/sync service, same locks and checkpoints.

POST /api/sync creates a durable sync_state row and spawns a detached Node worker with process.execPath plus an explicitly resolved TS runner/compiled entry, absolute cwd/config, stdio redirected to data/runtime/<id>.log. Do not shell-interpolate payloads, depend on PowerShell, or run an untracked promise inside a route request. The worker outlives navigation but not machine shutdown. Node spawn with detached:true + unref() must be tested on Windows and Linux; deployment is a persistent Node host, not serverless. Register a launch failure as failed and release the lock. Poll status every 2 seconds while visible; leaving the page does not cancel work.

`sync_state.lock_key` is UNIQUE nullable TEXT: active row holds literal `catalog`; inactive rows hold NULL. Start/acquire is one transaction; initial queued row already has a random worker_token, heartbeat_at=created_at and lease_expires_at=created_at+30s before spawn, so a crash before launch cannot leave an unrecoverable queued lock. Heartbeat every 5 seconds, lease 30 seconds. Only a worker whose worker_token matches may checkpoint/renew/release. On start, an expired lease is fenced by changing token and marking old run interrupted with lock released in the same transaction. Worker checks its token before every write; a delayed old worker must not resume writes. A resume reuses the interrupted/failed/cancelled run UUID, obtains a new token, increments attempt, resets lastError, retains checkpoint, and excludes concurrent starts. Completed runs cannot resume (409). Status reads label any expired active job (queued/running/cancel_requested) `interrupted` in the response, without writing on GET; the next start/resume performs recovery. Cancellation is durable cancel_requested, observed between batches; cancelling an inactive job is an idempotent no-op.

Algorithm:
1. Fetch language set listings in configured order, sorted by provider id. Persist a checkpoint manifest containing language, each set id, set-detail cards and per-card done/failure records. Progress is durable JSON TEXT, not an in-memory iterator. Listing/set-detail failures leave that unit incomplete.
2. Upsert set metadata with composite keys. Upsert brief cards (detail_synced_at=NULL only for newly created cards); insert identity ledger rows before metadata. Preserve previously detailed fields on brief refresh.
3. Fetch missing card details; incremental skips only detail_synced_at within last 24 hours, refresh fetches every card. Never use matching set counts alone to declare a set complete: Pokeum's count shortcut misses partial detail failures and price updates. Card counts refer to enumerated manifest, not number of successes.
4. Default network concurrency 4, configurable 1..8; 20-second request timeout, maximum 3 attempts on transport, 429 and 5xx (1s, 2s exponential delays, capped Retry-After at 30s). Permanent 4xx/invalid provider shapes are recorded, not silently swallowed. Write batches at most 25 cards, plus immutable deduplicated price observations, and checkpoint/progress in the SAME DB transaction. No local full-image download/index in this phase; retain CDN URLs.
5. Persist counts: setsTotal, setsDone, cardsTotal, cardsDone, cardsFailed. cardsTotal nullable until all manifests discovered. Done means processed successfully or deliberately skipped fresh; failures are not done. Snapshot manifests allow retry of failed entries and exact resumption after process death. A run with remaining failures ends failed, retains useful catalog data and can resume. Never mark 100% completed on partial failure. Set detail is refreshed on each new run even if count unchanged; resumed run uses its existing manifest.
6. Incremental/refresh are upserts only. Removed upstream cards are not pruned automatically. Finish/cancel/fail clears lock_key and records finished_at; cancel preserves partial data. No sync path writes owned_cards, custom_cards, grades, acquisitions, memberships, overrides or collection_revision.

Reference inspiration: .agent/reference/pokeum/app/reference/tcgdex.py separates pure parsers and transport and builds asset URLs; store.py uses explicit conflict updates; sync.py batches bounded detail fetches and idempotent work. Adapt those ideas, not its unlocalized primary keys, default normal=true assumption, swallowed failures or count-only freshness check. No reference code has been copied into these documents. If implementation copies any, retain MIT notice in THIRD_PARTY_NOTICES.md.

## Pricing/read semantics

Sync parses `variants_detailed[].pricing` and top-level `pricing` as fallback; deduplicate repeated provider blocks before inserting. Raw JSON is retained for provider evolution. Money is parsed from decimal text with decimal half-up to integer cents (no binary-float multiply-and-truncate). Missing/negative/invalid values remain NULL with a sync warning; zero is legitimate. PriceSnapshot uniqueness is semantic observation key described in DATA-MODEL, not sync run time. No scraping.

Per copy: manual override wins in its currency, otherwise only raw, exact supported variant prices can apply. USD: latest TCGplayer market then mid then low. EUR: Cardmarket trend then mid then low. Do not fall back across variants, grading states or currencies. Unsupported, graded-without-override, unknown-price copies are unvalued. Metrics return per-currency buckets, known-cost coverage and excluded-copy counts; never silently mix EUR/USD or show unknown as free. Card Details exposes provider and capturedAt and missing fields. No grade multiplier or condition discount is fabricated.

## Data operations and maintenance

See IMPORT-EXPORT for exchange contract. Dry-run uploads are staged under private data/imports/<UUID>, not public/. Server persists canonical plan, input SHA-256, result report, expiry and collectionRevision. Commit checks all of them and runs one transaction. JSON exports are consistent reads with all personal tables and relevant price history; CSV is a loss-limited interoperable copy view, explicitly labelled. Never export secrets, runtime lock tokens or absolute paths.

Backups use better-sqlite3 online backup API to a unique file: copying only a live WAL database main file is unsafe. GET backup streams the completed, integrity-checked SQLite snapshot; generated backup stays in configured backup directory. Restore stages an uploaded SQLite file, validates integrity, FK checks and exact supported migration version read-only without evaluating extensions or uploaded SQL. It returns a short-lived preview token/hash. Commit requires explicit confirmation. During replacement, reject new API work with 503 MAINTENANCE, stop/fence workers, drain readers/writers, online-backup the current database, close all handles including worker handles, replace DB plus managed WAL/SHM lifecycle on the same volume, reopen and check integrity. Failed replace reopens the previous verified copy. Acquire an OS-atomic exclusive directory lock in data/runtime for restore and require every application/CLI DB entry to check it; all workers must acknowledge stopped before replacement (otherwise 409 ACTIVE_WORK). No user-supplied filesystem path is accepted. This is a single deployment maintenance operation, not multi-node coordination. Requires persistent disk and write access. Document final startup recovery marker if the machine dies mid-swap; startup chooses only an integrity-verified prior or staged database, never creates an empty replacement silently.

## LAN/PWA and security boundary

`npm run dev` in apps/web runs `next dev -H 0.0.0.0 -p 3200`. Check port before starting; do not create another server. Windows Firewall access should be limited to the Private LAN profile. Phone opens http://<pc-ip>:3200; core browser UI/manual entry must work there. A service worker/install prompt and future camera APIs require HTTPS on a LAN address: do not promise full PWA installation over plain LAN HTTP. Production uses `next build` then `next start -H 0.0.0.0 -p 3200`, with trusted local HTTPS termination for install testing. Cache static app shell only, not /api responses, personal mutations or import/backup data. Offline shell explains network requirement; no offline mutation queue in Phase 1.

Every mutation validates configured APP_ORIGIN against Origin; accept same origin (including configured LAN host), reject missing Origin on browser mutations except authorized local CLI service calls that do not use HTTP. For automation, allow a local-only configured bearer ADMIN_API_TOKEN instead of Origin; disabled if absent. CORS disabled; no wildcard access. Host allowlist from APP_ORIGIN plus localhost dev origins prevents DNS-rebinding access. GET exports/backup require allowed Host and same-origin fetch metadata or configured bearer; UI downloads fetch a Blob from same origin. Token is server-only. This is basic LAN request safety, not authentication against a malicious LAN peer. Destructive restore needs confirmation and is never a GET.

Input caps: JSON body 1 MiB ordinary routes, data uploads 25 MiB, backup/restore 512 MiB; import max 100,000 copy rows and 250,000 total entity rows. Return 413 before parsing oversized uploads, use streaming temp files, never trust extension/MIME alone. Enforce URL scheme https/http only on art; no server-side fetch of arbitrary supplied art URLs. Third-party fetches restricted to configured TCGdex origin. No SQL/stack/paths/tokens in API errors. Private data routes Cache-Control: no-store.

## Configuration (server only unless stated)

| Variable | Default / validation |
|---|---|
| NODE_ENV | normal Next semantics |
| APP_ORIGIN | required absolute origin for deployed LAN host; dev http://localhost:3200 |
| DATABASE_PATH | data/flashydex.sqlite, resolved from repository root, not process cwd |
| DATA_DIR | data, resolved from repository root; imports/runtime under it |
| BACKUP_DIR | data/backups; same local filesystem for restore staging |
| TCGDEX_BASE_URL | https://api.tcgdex.net/v2; validated HTTPS origin/path, test injection permitted |
| TCGDEX_LANGUAGES | en,ja; nonempty distinct list restricted to en/ja |
| SYNC_CONCURRENCY | 4, integer 1..8 |
| SYNC_FRESH_HOURS | 24, positive integer |
| RECOGNITION_BASE_URL | http://127.0.0.1:8100; unused in Phase 1 except operator config validation |
| ADMIN_API_TOKEN | optional strong secret; never NEXT_PUBLIC_* |
| NEXT_PUBLIC_APP_NAME | flashydex; cosmetic only |

App version is read from workspace package.json, not a manually maintained export value. After Node22 `npm ci`, apply checked-in migrations with `npm run db:migrate` before starting app/CLI; schema generation belongs to development, not startup. The initial migration seeds app_state with id='collection', collection_revision=0 and a canonical UTC updated_at. The application must not create an empty replacement or silently migrate an uploaded restore. Upload/lease/time limits above are constants shared by API/tests; do not add conflicting magic defaults. Log job IDs and error codes, not imported notes/certificates or secret headers.

## Recognition seam (reserved, not Phase 1 endpoints)

Future browser -> Next POST /api/recognition -> server-side multipart POST /v1/recognize on FastAPI. Shared contract stub: request image bytes (JPEG/PNG/WebP, maximum 10 MiB), languages: Language[], scanSessionId?: UUID; response {requestId: UUID, status:'confident'|'uncertain'|'no_match'|'no_card_detected', candidates: Array<{catalogCardId:string,language:Language,confidence:number /*0..1*/,variant:Variant|null}>, durationMs:nonnegative integer}. Maximum THREE candidates total, best first; uncertain has no auto-selected winner. No persistence until an editable owner confirmation calls ordinary owned-card API. FastAPI GET /health returns {status:'ok',service:'recognition',version:string}; no recognition implementation, OCR or model install now. Next timeout/503 mapping will use normal error envelope later.

## PostgreSQL migration path

Keep schema/repository boundaries. PKs remain UUID TEXT or composite provider TEXT keys. ISO UTC timestamps/date-only strings remain TEXT initially on PG as well; a later migration may cast explicitly to timestamptz/date, not implicitly reinterpret timezone. integer cents map to PG INTEGER with bounds <=2,147,483,647 per amount; aggregate via BIGINT/Number safe-integer guard. SQLite boolean integer 0/1 maps to PG BOOLEAN; JSON TEXT may remain TEXT, later migrate to JSONB with explicit casting. Every FK/index/check and on-delete behavior has a PG equivalent. No SQLite FTS, JSON1 query dependency, rowid, replace semantics or SQLite enum type.

Generate PG-specific Drizzle schema/migrations (`pg-core`, driver pg) from this model when requested; do not pretend SQLite migration SQL runs on PG. Export consistent rows in FK order and import in a transaction; verify row counts, IDs, check constraints and currency totals. Replace LIKE case matching with normalized search columns and same escaped parameter behavior; compare pagination ordering in integration tests. Replace PRAGMAs/online backup/maintenance and lease acquisition with PG equivalents; sync conditional leases and logical identity keys remain unchanged. No PG runtime or dual-dialect abstraction is needed in Phase 1.
