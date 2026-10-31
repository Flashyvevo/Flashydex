# Architecture decision records — Phase 1

All entries accepted for this Stage A contract, subject to director approval before implementation changes the contract. BRIEF's fixed stack is an input, not re-litigated here. Each entry is one decision; implementation must raise a specific requested amendment rather than silently choose another design. No app code is copied by these records.

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
