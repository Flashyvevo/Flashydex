# pokescan — shared project brief (read fully before doing anything)

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

## Fixed stack (decided — do not relitigate)
- Monorepo: `apps/web` (Next.js 15 App Router, TypeScript strict, Tailwind v4, mobile-first PWA via `@serwist/next`), `services/recognition` (Python 3.12 venv, FastAPI — Phase 2; Phase 1 = skeleton + health route only), `packages/schemas` (zod schemas + JSON Schema for import/export, shared).
- Data: SQLite via **Drizzle ORM + better-sqlite3** in `apps/web`. Schema must be Postgres-portable: integer PKs or text UUIDs (no SQLite-only types), ISO-8601 text timestamps, `integer` cents for money (never float), explicit FKs, migrations via `drizzle-kit`. Catalog tables and collection tables are separate groups; collection rows reference catalog by stable TCGdex card id (`catalog_card_id` text) **and** carry denormalized `name/set_id/local_id/language` so a catalog wipe/resync never orphans or deletes owned cards. `ON DELETE CASCADE` from catalog to collection is forbidden.
- Catalog sync runs as a Next.js server action / route + a CLI script (`npm run sync -- --lang en,ja`), resumable, idempotent (upsert), with progress persisted so a phone can leave the page.
- API: Next.js route handlers under `/api/*`, JSON, zod-validated, documented in `docs/API.md`. The recognition service (Phase 2) will be called server-side from Next; the browser never calls FastAPI directly.
- Tests: vitest (unit/integration against a temp SQLite file), Playwright (smoke, mobile viewport 390×844), pytest for the Python skeleton.
- Node 22.x, npm. Python **3.12** (`py -3.12`), venv at `services/recognition/.venv`. Windows host (git-bash); scripts must work in bash on Windows AND Linux (no PowerShell-only steps).
- Dev server: `npm run dev` in `apps/web` binds `0.0.0.0:3200` so a phone on the LAN can open `http://<pc-ip>:3200`. Do NOT use ports 3000/3100/8080 (taken by other projects).
- Money: store cents + ISO currency code; display in USD by default with EUR shown as-is for Cardmarket data. Don't convert currencies in Phase 1.
- Entities (minimum, from SPEC): CatalogSet, CatalogCard, OwnedCard, Acquisition, Grade, StorageLocation, PriceSnapshot, CollectionGroup, ScanSession, CustomCard, SyncState.

## Quality bar
- Owner judges visually on his phone. Mobile-first, polished, fast: dark theme default, thumb-reachable bottom nav, card art prominent, no layout shift from images (fixed aspect 63:88), skeleton loaders, no horizontal scroll at 390px.
- Nothing fabricated: no placeholder prices, no fake card data, no "lorem". Empty states are real empty states.
- Every mutation has a test. Every feature has acceptance criteria met before "done". "Compiles" ≠ done.
- Documented import/export schemas (JSON Schema in `packages/schemas`, CSV columns in `docs/IMPORT-EXPORT.md`).

## Agent rules
- You are one of several agents working in this repo. Only edit files in YOUR ownership list (in your task file). If you need a change elsewhere, write it as a request in `.agent/reports/<your-role>-requests.md`.
- Never run `git commit` or `git push`; the director commits. Never delete files you don't own. Never `rm -rf` anything outside your ownership.
- Anthropic (Claude) agents: do NOT call capture_screenshot or view images — it crashes the session. Verify with DOM checks via `js()` in a browser session named after your role (`session="<role>"`).
- Don't start a second dev server if one is running on 3200 (check `netstat -ano | grep :3200`); if you start one, kill it before you finish.
- `web_extract` is not available; use `curl` in the terminal or the browser tool for web pages.
- End with a short report written to `.agent/reports/<role>-report.md`: what you produced (paths), what you verified (commands + results), what's incomplete, open questions. Also print that report as your final answer.
