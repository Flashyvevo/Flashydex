# Stage E contract (binding between sonnet-core-e and sonnet-mobile-e) — Opus director, 2026-10-31

Source findings: `.agent/reports/sol-review-2.md` §4 (N01–N09). Only these public-surface additions are allowed; anything
else core changes must be internal or documented in `docs/API.md` under `## Director notes — Stage E (2026-10-31)`.

## E1 — Personal-write maintenance gate (N03, core)
- `StorageStatus` (packages/core/src/db/sql.ts) gains ONE field:
  `maintenance: null | { kind: 'restore' | 'catalog_activation'; language: 'en' | 'ja' | null; since: string /*ISO*/ }`.
  Existing `writable/reason/message` keep their meaning (persistence latch / instance lock). `storage.subscribe` emits on
  every maintenance enter/exit.
- While `maintenance.kind === 'restore'`: every personal write that is NOT the restore's own privileged transaction —
  including ones already queued behind it, and ones submitted during the safety-snapshot phase — rejects with
  `MaintenanceError` (code `MAINTENANCE`) and changes nothing. Restore enters the gate BEFORE the safety snapshot, drains
  in-flight work, re-checks `userStateToken` under the gate, exits in `finally`. Reads keep working.
- `catalog_activation` is reported for the duration of the per-language barrier during install/rollback/uninstall
  activation (personal writes are NOT blocked by it; catalog reads wait/retry per E2).

## E2 — Reader protection through activation (N07, core)
- Every public multi-statement catalog read (catalog search, card detail, sets list, set detail, set cards, dashboard,
  copy hydration, collection list) runs inside a reader lease OR a retire-detect-retry-once wrapper. A handle closed
  mid-operation must never surface as a raw driver error: result is either a correct answer from one consistent catalog,
  or a typed `CatalogError('STALE_READ')` / `MaintenanceError`. No new method names.

## E3 — Persistence latch for import replay (N05, core)
- `TransferService.commit` (and any receipt replay) checks the persistence latch FIRST and throws `PERSISTENCE_FAILED`
  while storage is `persistence_failed`. After `storage.recover()`, receipt-first semantics against persisted truth.

## E4 — Sync terminal status (N06, core)
- A run with any failed/pending set or discovery unit ends `status:'failed'` (resumable) with a non-null `lastError`
  `{code, message}`; never `completed` with a failed set.

## Mobile side (sonnet-mobile-e)
- Read `useStorageStatus().maintenance`. When `kind==='restore'`: full-screen blocking overlay
  `data-testid="maintenance-overlay"` ("Restoring your backup…" / "Don't close FlashyDex. This takes a moment."),
  all mutation buttons disabled. When `kind==='catalog_activation'`: non-blocking inline notice is enough.
- `MAINTENANCE` error copy already exists in `lib/errors.ts`; `STALE_READ` → silent single refetch, then the existing copy.
