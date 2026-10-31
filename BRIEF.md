# FlashyDex — shared project brief (read fully before doing anything)

Self-hosted Pokémon TCG collection manager + card scanner. Full product spec: `SPEC.md` (authoritative; read it).
This brief adds the decisions, stack, and rules every agent must follow. If SPEC.md and this brief conflict, this brief wins.

## Current stage: PHASE 1 ONLY
Application shell, database, TCGdex catalog sync (EN + JA), search, manual collection management, CSV/JSON export/import,
runnable on the owner's phone over LAN. NO camera, NO recognition code in Phase 1 (design docs for Phase 2 are allowed).
Do not build Phase 2–7 features unless your task file says so.

## Verified facts (checked live 2026-10-30 — do not re-verify, do not contradict)
- TCGdex REST: `https://api.tcgdex.net/v2/{lang}/sets` → `[{id,name,cardCount:{total,official},logo?,symbol?}]`. EN = 220 sets, JA = 184 sets.
- `https://api.tcgdex.net/v2/{lang}/sets/{setId}` → set with `cards: [{id, localId, name, image?}]`.
- `https://api.tcgdex.net/v2/{lang}/cards/{cardId}` → full card: `id` (e.g. `swsh3-136`), `localId` ("136"), `name`, `rarity`, `category`, `illustrator`, `image` (base URL, append `/high.webp` or `/low.webp` / `.png` / `.jpg`), `set{id,name,cardCount,logo,symbol}`, `variants{normal,reverse,holo,firstEdition,wPromo}`, `variants_detailed[{type,size,variantId,thirdParty{cardmarket,tcgplayer},pricing{cardmarket{unit:"EUR",avg,low,trend,avg1,avg7,avg30,...-holo variants,updated}, tcgplayer{unit:"USD",updated,<variantKey>{lowPrice,midPrice,highPrice,marketPrice,directLowPrice}}}}]`, plus `hp,types,stage,attacks,weaknesses,retreat,regulationMark,legal,dexId` for Pokémon cards.
- Pricing may be absent for many cards/variants. Never fabricate a price; store null.
- Reference implementation (MIT): `.agent/reference/pokeum/` (TBLgGamin/pokeum). Its `app/reference/tcgdex.py`, `sync.py`, `store.py` are a working TCGdex sync; `app/recognize/*`, `app/signals/*`, `app/variants/*`, `app/vision/*` are the Phase 2 recognition reference. Read, understand, adapt; cite the file when you adapt code. Keep its MIT notice in `THIRD_PARTY_NOTICES.md` if any code is copied.

## Decisions from Stage A research (2026-10-30 — override anything below that conflicts)
Source: `.agent/research/tcgdex-api.md`, `variants-and-pricing.md`, `pokeum-notes.md`, `.agent/reports/grok-research-report.md`. Read them.
1. **Catalog identity = `(language, tcgdex_id)`.** EN and JA share ids (`neo4-100`…`neo4-113`, set ids `neo1`–`neo4`). Every catalog table has `language` in its unique key; owned/custom/price rows reference catalog by `(language, tcgdex_id)` (or a surrogate PK derived from both). Never key on `tcgdex_id` alone.
2. **Empty set shells** (68 JA, 4 EN) advertise `cardCount.total` but return `cards: []`. Store them with `status = 'unpublished'`, hide from Sets by default, re-check on each sync (don't mark synced-forever). `cardCount.official == 0` (promo sets) → display `localId` alone, never `001/000`.
3. **Images**: `image` is absent on ~1.7k EN and ~8.9k JA cards → `image_url` nullable; UI shows a styled placeholder (set logo or card-back), never a broken img. Build URLs as `{image}/high.webp` / `/low.webp`. Set symbol URLs on `univ/...` 404 — rewrite `univ` → `{lang}` and append `.webp`; treat as nullable if 404.
4. **Sync**: plain `fetch`, no `@tcgdex/sdk`. Set-list ETag → 304 is the cheap "anything new?" check; set detail (cards briefs) + per-card detail for full fields; concurrency 8, retry with backoff, URL-encode set ids containing `+` (`SM1+`). Full EN+JA ≈ 36k card requests ≈ 15–25 min. Pricing lives in card detail only → price refresh = re-GET card detail; make it a separate job (`--prices-only`) that only writes PriceSnapshot rows.
5. **Variant enum is the one in `docs/DATA-MODEL.md`** (`normal | holo | reverse_holo | first_edition | promo_stamped | shadowless | other` + `variantDetail` qualifier; pokeball/masterball/1st-ed-holo are expressed via `variantDetail`). The TCGdex-variant → enum → price-key mapping research is in `variants-and-pricing.md`; DATA-MODEL's mapping section is binding. `wPromo` kept as a column, no UI.
6. **Prices**: JA cards usually have EUR (Cardmarket) only. Show "No USD price" / EUR value, never 0; portfolio total counts only priced copies and says "N of M copies priced".
7. Pokeum's ONNX weights are NOT downloadable (release 404) — Phase 2 must plan to produce/obtain an encoder; Phase 1 unaffected.

## OWNER UPDATE 2026-10-30 — App Store pivot (overrides everything that conflicts, including Stage A docs written before it)
The product is **FlashyDex** (`flashydex`). It must be submittable to the Apple App Store (and Google Play later). Consequences, decided by the owner:
- **Local-first.** All user data AND the card catalog live on the device in SQLite. The app is fully functional with no server at all (an App Store reviewer has no access to the owner's home server). TCGdex is synced directly from the device (API + asset CDN verified CORS `*`).
- **Native shell = Capacitor 7** (iOS first, Android kept buildable). Web build also runs in a desktop browser for development and as a PWA.
- **No Next.js.** Web app = **Vite + React 19 + TypeScript strict + Tailwind v4 + TanStack Router (file-based) + TanStack Query**. No server runtime in the app.
- **Self-hosted server is optional and later** (Phase 7: backup/sync; Phase 2: recognition endpoint as ONE option next to on-device ONNX Runtime Web/Mobile). Nothing in Phase 1 may require it.
- **App Store compliance is a Phase 1 deliverable**: no Pokémon/Nintendo trademarks or character art in app name, icon, splash or store screenshots; in-app "FlashyDex is not affiliated with Nintendo, Creatures, GAME FREAK or The Pokémon Company" disclaimer; privacy policy (no data collection by us; TCGdex requests disclosed); `NSCameraUsageDescription`/`NSPhotoLibraryUsageDescription` strings ready; export-compliance (no custom encryption); works offline after sync; accessible (Dynamic Type-friendly rem scale, VoiceOver labels); iOS safe-area insets everywhere; no "web wrapper" feel — native camera/haptics/share-sheet via Capacitor plugins, instant navigation, no page reloads.
- Rename: every former `pokescan` name → `flashydex` / `FlashyDex`; env prefix `FLASHYDEX_`; user db file `flashydex-user.db`.
- **Driver facts (Grok, `.agent/research/device-storage.md`)**: `@capacitor-community/sqlite` has no `ATTACH` → one connection per DB file, app-level joins in core. Pack files are opened natively read-only (`createNCConnection`, iOS/Android only). The web build (jeep-sqlite/sql.js) keeps the entire DB in memory → **web = development + limited mode (followed sets only, small catalog); native iOS/Android is the product.** Catalog DBs and the user DB live in different directories so backup exclusion applies to catalogs only.

## OWNER UPDATE 2026-10-31 — Compression & storage architecture (binding; full text in `docs/COMPRESSION-STORAGE.md`)
- **Three SQLite files**: `flashydex-user.db` (all personal data + settings + custom cards), `catalog-en.db`, `catalog-ja.db` (replaceable). Personal data never lives in a catalog DB. Core must work with the user DB plus 0..n catalog DBs (ATTACH where the driver supports it; otherwise app-level joins — the architect verifies `@capacitor-community/sqlite` ATTACH support on iOS/Android/web and decides).
- **Catalog distribution = versioned packs we build**: `catalog-manifest.json` + `catalog-en-{version}.db.zst` + `catalog-ja-{version}.db.zst` (Zstandard). A Node pipeline in `tools/catalog-builder/` crawls TCGdex → builds the catalog SQLite (same schema as core) → zstd → writes manifest (currentVersion/targetVersion, full-pack URL, optional delta URL, compressedBytes, uncompressedBytes, sha256, schemaVersion) → publishes (GitHub Releases of this repo in Phase 1). Delta packs: manifest + abstraction ready, implementation deferred.
- **Install flow on device**: download (progress, cancellable) → size check → streaming decompress to temp file (worker, not main thread; never whole catalog in JS memory) → SHA-256 → open → validate schema/version → atomic activate → keep previous valid copy until success. Failed update never destroys the working catalog. User picks languages; only selected catalogs are downloaded. Nothing catalog-sized is bundled in the IPA/APK.
- **Per-card TCGdex API sync is now the refresh/fill-in path** (price refresh, sets newer than the pack, user-triggered single-set fetch), not the primary install path. Keep it; it must still work.
- **Images**: low.webp in grids/search/sets/candidates, high.webp only on detail/zoom; never bulk-download; bounded LRU image cache 150–250 MB configurable (Phase 7 implements; Phase 1 relies on WebView HTTP cache but the cache interface exists in core's Platform adapter). No recompression of WebP.
- **Backup = `.fdx`** (versioned, compressed archive: manifest + collection + settings + custom cards + optional user images; no catalog unless requested). Restore must work after reinstall + fresh catalog download. JSON/CSV export remain as interchange formats.
- **Recognition packs** (Phase 2) are versioned independently of catalog packs, zstd, precomputed embeddings (benchmark f32/f16/int8), no source images on device.
- **Metrics**: record compressed/uncompressed size, ratio, download + decompression durations, peak memory, installed footprint for every pack build (catalog-builder prints them; CI stores them as artifacts).

## Fixed stack (decided — do not relitigate)
- Monorepo (npm workspaces):
  - `apps/mobile` — Vite + React 19 + TS strict + Tailwind v4 + TanStack Router + TanStack Query + Capacitor 7 (`ios/` and `android/` generated, committed). Dev server `npm run dev` → `vite --host 0.0.0.0 --port 3200` for LAN testing in a phone browser; native run via `npx cap sync ios && npx cap open ios` on the Mac.
  - `packages/core` — framework-free TypeScript domain layer: Drizzle schema + migrations (SQL files), repository interfaces + implementations, TCGdex sync engine, import/export, pricing/portfolio math, search. Tested with vitest against real SQLite (better-sqlite3 in Node tests only — it is a devDependency of core, never shipped to the app).
  - `packages/schemas` — zod + JSON Schema for import/export and the recognition API contract.
  - `services/recognition` — Python 3.12 FastAPI (Phase 2 option; Phase 1 = health skeleton only).
- **Database = SQLite on device via `@capacitor-community/sqlite`** (iOS/Android native; web via its sql.js/jeep-sqlite wasm shim with OPFS/IndexedDB persistence). Drizzle ORM through `drizzle-orm/sqlite-proxy` over that driver, so `packages/core` queries run unchanged in Node tests (better-sqlite3) and on device. Schema rules unchanged: Postgres-portable types, ISO-8601 text timestamps, integer cents, explicit FKs, catalog tables and collection tables separate, catalog identity `(language, tcgdex_id)`, collection rows carry denormalized name/set/localId/language/imageUrl, catalog→collection CASCADE forbidden. Migrations = ordered `.sql` files applied by core's migrator on app start (drizzle-kit generates them).
- **Catalog sync runs on device** (TCGdex REST via `fetch`/CapacitorHttp): resumable, idempotent upserts, progress persisted in `SyncState`, concurrency 6–8, backoff, continues while the user navigates (foreground only in Phase 1; background tasks later). User can choose languages and sets to sync ("sets I collect") or everything. Design the data path so a prebuilt catalog snapshot (downloaded `.sqlite.gz` built in CI) can replace the per-card crawl later — don't build the snapshot pipeline in Phase 1.
- **"API" = `packages/core` repository interfaces** (TypeScript), not HTTP. `docs/API.md` documents those interfaces (method signatures, zod input schemas, result types, error types). The UI calls them through TanStack Query hooks in `apps/mobile/src/data/`.
- Images: card art is loaded from `assets.tcgdex.net` (`{image}/low.webp` in grids, `/high.webp` on detail), cached by the native WebView/HTTP cache; explicit offline image cache is Phase 7.
- Tests: vitest in `packages/core` (real SQLite, temp file) and `apps/mobile` (component tests, Testing Library); Playwright against the Vite dev build at 390×844 (iPhone-like) and 1280×800; pytest for Python.
- Node ≥ 22 (host has 24 — fine; `better-sqlite3` is Node-test-only). Python 3.12. Windows host (git-bash) for development; iOS build on the owner's Mac. Scripts must be bash-portable.
- Ports: 3200 only. Never 3000/3100/8080.
- Money: integer cents + ISO currency; display USD by default, EUR shown as-is; no conversion in Phase 1; "N of M copies priced".
- Entities (minimum): CatalogSet, CatalogCard, OwnedCard, Acquisition, Grade, StorageLocation, PriceSnapshot, CollectionGroup, ScanSession, CustomCard, SyncState, AppSettings.

## Quality bar
- Owner judges visually on his phone. Mobile-first, polished, fast: dark theme default, thumb-reachable bottom nav, card art prominent, no layout shift from images (fixed aspect 63:88), skeleton loaders, no horizontal scroll at 390px.
- Nothing fabricated: no placeholder prices, no fake card data, no "lorem". Empty states are real empty states.
- Every mutation has a test. Every feature has acceptance criteria met before "done". "Compiles" ≠ done.
- Documented import/export schemas (JSON Schema in `packages/schemas`, CSV columns in `docs/IMPORT-EXPORT.md`).

## Agent rules
- You are one of several agents working in this repo. Only edit files in YOUR ownership list (in your task file). If you need a change elsewhere, write it as a request in `.agent/reports/<your-role>-requests.md`.
- Never run `git commit` or `git push`; the director commits. Never delete files you don't own. Never `rm -rf` anything outside your ownership.
- Anthropic (Claude) agents: do NOT call capture_screenshot or view images — it crashes the session. Verify with DOM checks via `js()` in a browser session named after your role (`session="<role>"`).
- Don't start a second dev server if one is running on 3200 (Vite) (check `netstat -ano | grep :3200`); if you start one, kill it before you finish.
- `web_extract` is not available; use `curl` in the terminal or the browser tool for web pages.
- End with a short report written to `.agent/reports/<role>-report.md`: what you produced (paths), what you verified (commands + results), what's incomplete, open questions. Also print that report as your final answer.