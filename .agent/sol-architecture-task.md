Project root: C:/Projects/pokescan (cd there first). Read `BRIEF.md` fully, then `SPEC.md`. Follow BRIEF's Agent rules exactly.

## Your role: GPT Sol — architect (Stage A). You define architecture, data model, API contracts, import/export schemas and acceptance criteria for Phase 1. Implementation agents (Claude Sonnet) will build exactly what you specify, in parallel, so be precise: names, types, routes, status codes, error shapes.

## Your files (ownership)
- `docs/ARCHITECTURE.md`
- `docs/DATA-MODEL.md`
- `docs/API.md`
- `docs/IMPORT-EXPORT.md`
- `docs/PHASE1-ACCEPTANCE.md`
- `docs/DECISIONS.md` (ADR log, one entry per decision)
- `.agent/reports/sol-architecture-report.md`

## Inputs
- `BRIEF.md` (fixed stack — Next.js 15 App Router, Drizzle + better-sqlite3, zod, vitest, Playwright; entity list; PG-portability rules; catalog/collection separation).
- `SPEC.md` sections: CORE REQUIREMENTS, DATABASE MODEL, PRODUCT SCREENS, PRICE DATA, RELIABILITY RULES, MVP DEFINITION OF DONE.
- `.agent/reference/pokeum/app/models.py`, `app/reference/store.py`, `app/reference/sync.py`, `app/reference/tcgdex.py` (a working TCGdex sync — learn from it).
- Live API samples: `curl https://api.tcgdex.net/v2/en/cards/swsh3-136`, `curl https://api.tcgdex.net/v2/en/sets/swsh3`, `curl https://api.tcgdex.net/v2/ja/sets` (facts already verified in BRIEF; fetch more if you need shapes).
- If `.agent/research/tcgdex-api.md` or `.agent/research/variants-and-pricing.md` exist when you start (another agent is writing them in parallel), read them; if not, proceed from the live API and say so in your report.

## Do
1. `docs/ARCHITECTURE.md`: monorepo layout (exact folder tree for `apps/web`, `packages/schemas`, `services/recognition`), request flow, where server actions vs route handlers are used, how sync runs (CLI + in-app, resumable, idempotent, progress in `SyncState`), how the Phase 2 recognition service will plug in (server-side call from Next, contract stub only), config/env vars, LAN dev setup (0.0.0.0:3200), Postgres migration path. Keep it to what Phase 1 needs plus the seams for later phases.
2. `docs/DATA-MODEL.md`: every table with columns, types (Drizzle sqlite types + the PG equivalent), nullability, defaults, indexes, unique constraints, FKs and their on-delete behaviour (catalog→collection cascade forbidden; owned cards keep denormalized name/set/localId/language/imageUrl). Define the canonical `variant` enum (normal, holo, reverse_holo, first_edition, promo_stamped, other… — reconcile with TCGdex `variants` flags and tcgplayer price keys), `condition` enum (NM/LP/MP/HP/DMG + optional), `grading_company` enum (PSA/BGS/CGC/SGC/ACE/TAG/other), language codes (en, ja). Decide: is `OwnedCard` one row per physical copy or per (card, variant, condition) with quantity? Justify in DECISIONS.md — SPEC requires per-copy data (cert number, purchase price/date/source, storage location) so per-copy rows with grouping in queries is likely right; duplicates = count of rows per catalog_card_id+variant. Include `PriceSnapshot` (source, variant, currency, cents fields for low/mid/high/market/trend, captured_at) and manual override. Include `CustomCard` (user-created when catalog lacks the card) and how OwnedCard references either a CatalogCard or a CustomCard (exactly one). Include `ScanSession` minimal shape (Phase 3 uses it; create table now so the schema is stable). Provide the Drizzle schema as a code block the implementer can paste (`apps/web/src/db/schema.ts`).
3. `docs/API.md`: every Phase 1 endpoint: method, path, query/body zod schema (TypeScript), response schema, pagination (cursor or offset — decide), error shape `{error:{code,message,details?}}`, status codes. Minimum: catalog sets list/detail (with owned counts + completion + missing cards), catalog card search (name, set, localId, language, rarity; prefix + fuzzy-ish `LIKE`; limit 50), card detail (catalog + owned copies + latest price), owned cards list with ALL filters from SPEC "Collection" screen, create/update/delete owned card (+ bulk-add quantity N copies), acquisitions, storage locations CRUD, collection groups CRUD, custom cards CRUD, dashboard stats (total cards, unique, duplicates, est. value, total paid, gain/loss, recent), sync start/status/cancel, export (json, csv) and import (json, csv; dry-run + commit) with a conflict policy, backup (copy of sqlite) / restore.
4. `docs/IMPORT-EXPORT.md`: JSON export envelope (version, exportedAt, app version, arrays per entity, stable ids), the CSV column list (one row per owned copy; header names; date and money formats; variant/condition enum strings), import matching rules (by catalog card id, else by set_id+localId+language, else custom card), dry-run report shape. These become `packages/schemas` zod + JSON Schema.
5. `docs/PHASE1-ACCEPTANCE.md`: numbered, testable acceptance criteria per screen (Dashboard, Collection, Card Details, Sets, Settings/Data, Manual add/search flow) and per API group, each with the test type that proves it (vitest / Playwright / manual on phone). Include: performance budgets (search response < 300 ms on 40k cards; collection list paginated), data-safety criteria (resync never changes owned_card row count — write it as a test), mobile criteria (no horizontal overflow at 390px, tap targets ≥ 44px, bottom nav), empty states.
6. `docs/DECISIONS.md`: ADRs for each non-obvious choice.
7. Report to `.agent/reports/sol-architecture-report.md` and print it: files written, open questions, anything in SPEC you deliberately deferred.

## Don't
- Don't write application code (schema code block in the doc is fine). Don't change BRIEF.md or SPEC.md. Don't design Phase 2+ beyond stable table shapes and the service seam.
