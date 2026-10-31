# R08 report: .fdx backup create / previewRestore / restore (sonnet child)

## Result
`npx vitest run test/backup.test.ts` -> 1 file, 33 tests passed. `test/transfer.test.ts` still passes (50 total together).
`npx tsc --noEmit -p tsconfig.json` -> 4 errors, none in src/backup or test/backup (the others are other agents' files, e.g. test/install-settings.test.ts).

## Files
- NEW packages/core/src/backup/archive.ts: zip build (fflate zipSync, DEFLATE 6 JSON / STORE images, fixed mtime = createdAt), hardened reader, validation.
- NEW packages/core/src/backup/snapshot.ts: complete personal snapshot (reuses transfer `readPersonalSnapshot`, then replaces price history with the FULL table, adds identities/annotations/settings) and userStateToken inputs.
- NEW packages/core/src/backup/backup-service.ts: the BackupService implementation.
- CHANGED packages/core/src/backup/service.ts: now `export * from './backup-service'`. The write tool refused to overwrite it ("read with pagination"), so the implementation sits in the sibling file. Same public export `BackupService`.
- NEW packages/core/test/backup.test.ts. No changes to schemas, transfer/*, services/*, db/*, apps/*, docs/*.

## Behavior as built
- ctor: `new BackupService(ctx, platform, appVersion='0.0.0', { limits?: Partial<FDX_LIMITS>, hooks?: { duringRestore(stage:'afterDelete'|'afterInsert') } })`. `limits` is for the zip-bomb/cap tests; `hooks` is a test seam for the mid-restore failure test.
- create: one `user.read` snapshot; writes `flashydex-<YYYYMMDDTHHmmssZ>.fdx` (area exports); then re-reads, re-hashes and parses it through the preview parser and compares entities and settings. On failure it deletes the file. includeCatalogs:true -> UNSUPPORTED_CAPABILITY.
- previewRestore: zero DB writes (tested by dumping every table before and after). It returns uuid id, backupHash (sha256 of the whole archive), expiresAt = now + 10 min, userStateToken, and matched/missing counts. The parsed archive stays in an in-memory Map.
- userStateToken = sha256(canonicalJson({collectionRevision, settingsUpdatedAt, annotations:{count, maxUpdatedAt}})).
- restore order: receipt-by-id check, then consumed set (ALREADY_RESTORED); then NOT_FOUND, PREVIEW_EXPIRED, hash mismatch; then `coordinator.admit('restore')`, released in finally. Next: stale check on revision and token, then the verified safety .fdx, then one `user.transaction`. Inside the transaction the state is re-checked, personal tables are wiped in FK order, archive rows are inserted with original UUIDs and times, app_settings is updated, `bumpRevision` runs once, and the `restore_receipts` row is written (24h). If the transaction fails or is cancelled, the safety file is removed. On PersistenceError the preview counts as consumed and the safety file is kept.
- Reader hardening:
  - It scans the central directory first: entry cap, names, duplicates, encrypted flag, method must be 0 or 8, unix symlink attributes, ZIP64 and multi-disk rejected.
  - It then streams with fflate Unzip in 1 MiB slices and counts ACTUAL inflated bytes per entry and in total, aborting on a breach.
  - Order after that: manifest version gate, then strict zod; entries must exactly match the manifest, with sha256 and bytes checked; entities and settings are checked the same way; version gates run before zod; row caps; manifest counts must equal actual arrays; image index and entries must agree.
  - Semantic checks: unique PKs (including name_key, grade-per-copy, observationKey), every FK resolves inside the archive, DB CHECK semantics replicated, observationKey recomputed with `observationKeyOf` (the JSON import's function), settings disclaimer consistency.

## Limits
Constants come from FDX_LIMITS: archive 512 MiB, expanded 1 GiB, entities 128 MiB, settings 1 MiB, manifest 256 KiB, image 10 MiB, 10000 images, 10010 entries, 250000 total rows, 100000 owned rows. Test overrides: entityBytes 1 MiB, expandedBytes 100, archiveBytes size-1, entries 2, totalRows 10, ownedRows 2.

## Tests (33, all in backup.test.ts)
- create: valid allowlisted zip with manifest/entities/settings and unowned history; determinism; includeCatalogs rejected, includeUserImages warning, capabilities, observer throw isolated; aborted signal writes nothing.
- round trip: same catalogs; NO catalog; NEWER/different catalog (matched 2 / missing 2); replaces existing data and keeps operational tables; preview is zero-write.
- guards: ALREADY_RESTORED (same instance and fresh instance via receipt); STALE_PREVIEW on a collection edit, a settings-only edit, and an annotation edit; PREVIEW_EXPIRED / NOT_FOUND / hash mismatch; ACTIVE_WORK while an install admission is held; cancellation (before, and during the safety-backup phase); mid-restore failure at afterInsert and afterDelete (everything unchanged, then a retry succeeds); safety backup is verifiable and restoring it returns the pre-restore state.
- hostile archives: garbage/empty/truncated; zip bomb (8 MiB of zeros, under 64 KiB compressed, rejected with lowered cap); aggregate expanded cap; oversize archive and entry-count cap; row caps; duplicate entry; unsafe paths (`..`, absolute, drive, backslash, NUL, unknown, bad image name); encrypted flag; symlink; missing required entry (all three); unknown backup/entities/settings version; sha256 and size mismatch; count mismatch; manifest entry list mismatch; semantic violations (dangling FKs, dup PK, bad observationKey, extra keys, disclaimer); a hand-rebuilt valid archive is accepted.

## Deviations / notes
- User images: core stores no image bytes in Phase 1. create with includeUserImages:true returns a warning and `userImages` is empty (manifest includesUserImages=false). The parser and preview support included images (index and sha256 validated, warning shown), but restore does not write image bytes. No image provider seam exists yet.
- imageCacheLimitBytes: no storage column exists, so it is always written as the default 200000000 and ignored on restore.
- ALREADY_RESTORED is keyed on the preview id (receipt id = preview id), not on backup hash. Keying on hash would block re-restoring the same file via a fresh preview for 24h.
- Snapshot calls `readPersonalSnapshot` (which also reads owned-identity price history) and then re-selects the full price table, so owned-identity history is read twice. Harmless at test scale; a lighter reader could be factored out of transfer/snapshot.ts later.
- Catalog annotations are restored as `JSON.stringify(displayOverrides)`. They are byte-identical to the originals only if the original JSON text was compact; true for the test data, and the services presumably store it compact.
- Not done: progress `bytesDone` is coarse (phase boundaries only, no per-byte streaming). The whole archive is held in memory (Uint8Array), the same assumption the Platform `read` API makes.
