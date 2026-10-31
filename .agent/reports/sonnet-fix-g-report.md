# Sonnet fix-G report (Sol review 4: F01, F02)

## F01 - CatalogRepo mixed personal snapshot: FIXED
- packages/core/src/services/catalog.ts: getCard, getSet, listSets, listSetCards and searchCards now run under
  databases.consistentRead (collection revision + catalog epochs + handle generations; retry once, then STALE_READ)
  instead of protectedRead (generations only). consistentRead is a superset of protectedRead, so retired-handle
  protection is unchanged (its existing 8 tests still pass).
- Audit: collection-list (already consistentRead), portfolio.dashboard (already), hydrateOwned (single multi-step read,
  protectedRead; only called inside the guarded reads above or from write paths). No other public catalog+personal reads.
- Tests: packages/core/test/catalog-consistency.test.ts (7). Red before the fix (5 failed), green after:
  Sol's interleaving (sole copy deleted after COUNT, before copy-ID select) -> ownedCount 0, 0 copies, hasMore false;
  add in gap (2 owned == 2 copies, hasMore false); update in gap; real BackupService.restore in gap; write on every
  attempt -> STALE_READ; no-interleave baseline; getSet/listSetCards with an add mid-read -> coherent.

## F02 - ZIP descriptors / declared sizes: FIXED
- packages/core/src/backup/archive.ts:
  - verifyLocalHeaders: for descriptor-bearing entries (bit 3 in both headers) the descriptor is located via local
    header length + central compressed size (bounds-checked, size used only as a locator, never an allocation cap);
    optional 0x08074b50 signature handled; CRC, compressed size and uncompressed size must equal the central directory.
  - parseArchive: after inflating, each entry's ACTUAL length must equal the declared uncompressed size (applies to
    non-descriptor ZIPs too).
- Tests (backup-zip-headers.test.ts, +7 -> 15). 6 red before the fix, green after: genuine fflate streamed archive parses;
  corrupted descriptor CRC (Sol probe); wrong descriptor csize/usize; central sizes contradicting descriptor or pointing
  past file; zeroed/missing descriptor; coherently-wrong expanded size (+1, Sol probe) and understated (-1).
  Rejections are BACKUP_INVALID before any restore write (preview stage). SHA/bomb caps untouched.

## Gates (exit 0)
- npm run typecheck: pass
- npm run lint: 0 errors, 21 warnings (pre-existing react-refresh)
- npm test: core 367/367 in 32 files (was 353/31), mobile 40/40, pytest 1/1

Not done: N04 (caller-thread archive creation) and R04 - out of scope. No commits; :3200 untouched; no screenshots.
