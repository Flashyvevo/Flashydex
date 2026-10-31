Sonnet fix-F report: Sol review 3 findings E01-E04 + N04 residue

Gates (all exit 0, run last in this order after the final edit):
  npm run typecheck   core + schemas + mobile clean
  npm run lint        0 errors, 21 warnings (the same react-refresh warnings as before)
  npm test            core 31 files / 353 tests (was 26 / 328); mobile 9 files / 40 tests (was 8 / 30); recognition pytest 1 passed
  npm run build       ok; emits dist/assets/archive.worker-*.js (192 kB)
  npm run e2e         22 tests: 21 passed, 1 skipped (restore-maintenance on desktop, a deliberate test.skip as before)
  Own :3201 server only; the :3200 HTTPS server was not touched. No screenshots, no commits.

Item -> status -> tests

E01 (P1) concurrent import replay returns success before the receipt is durable: FIXED
  Cause: commit() checked the latch once, then queued the receipt SELECT; a failing flush could set the latch while the SELECT waited.
  Fix: new Db.durableRead(fn) in db/sql.ts. It checks the persistence latch after queue admission, runs the read, and checks again, all
  under one serialized hold. transfer/service.ts commit() uses it for the receipt lookup. The in-memory committed-preview return also
  re-checks the latch. A receipt is returned only while storage is not latched. After recover() it is receipt-first against persisted state.
  Tests (test/persistence-replay.test.ts, Sol's exact ordering rebuilt with no scratch dependency):
    - PRE-persisted: first and replay both PERSISTENCE_FAILED, recover() shows 0 copies, retry applies exactly once
    - POST-persisted: both refused during the flush, after recover() the replay returns the stored receipt and there is still 1 copy
  Before the fix both failed (replay.ok=true). I ran them red first.

E02 (P2) .fdx accepts domain-invalid personal state: FIXED
  packages/schemas/src/backup.ts: new strict DisplayOverrides schema (optional name/setName/localId/rarity/imageUrl with the snapshot
  constraints; no unknown keys), used by CatalogAnnotationRow.
  core/backup/archive.ts validateReferences, which runs inside parseArchive and therefore zero-write preview, now also rejects:
    - an owned card whose language differs from its custom card
    - a duplicate followed set
    - a followed set whose language is not in settings.languages
    - updatedAt < createdAt on owned, custom, acquisition, location, group, grade and annotation rows
    - a scan session that ends before it starts
    - a disclaimer time after settings.updatedAt
  Rejection is BACKUP_INVALID with a readable reason.
  Tests (test/backup-semantics.test.ts, 8): Sol's four probes (custom-language, followed-settings, annotation-shape plus a name:42
  variant, reversed-audit) plus followed-unselected and scan-order. Each asserts preview rejection, the message, and that the target is
  unchanged (0 owned cards, same collection_revision). A valid rebuild still previews.
  Caveat: I wrote these tests after the fix and did not run them red, so I have not seen them fail on the old code.

E03 (P2) inconsistent local vs central ZIP headers / encryption: FIXED
  archive.ts: the central scan now also records the uncompressed size, and the encryption mask is 0x1|0x40|0x2000. verifyLocalHeaders
  rejects an encryption flag in EITHER header, requires the local and central flag words to be identical, and, when there is no data
  descriptor, compares the local uncompressed size as well as CRC and compressed size.
  Tests (test/backup-zip-headers.test.ts, 9): untouched parses; Sol's local-only bit 0; central-only bit 0 ("Encrypted" message);
  0x40 and 0x2000 in either header; local-only data-descriptor bit; UTF-8 bit mismatch in either header; local uncompressed size
  mismatch; local method mismatch. 4 of the new cases were red before the fix (the others already rejected).

E04 (P2) dashboard mixed snapshot: FIXED
  portfolio.ts dashboard now runs under consistentRead(['en','ja']). That captures the personal collection_revision plus catalog
  epochs/generations before and after, retries once, then throws STALE_READ. It replaces the protectedRead that only watched catalog generations.
  Tests (test/dashboard-consistency.test.ts, 5): Sol's delete-between-aggregate-and-hydration (0 copies / 0 recent), an add in the
  gap (2/2), an update in the gap, a write on every attempt giving STALE_READ, and the no-interleave baseline. 3 of the 5 were red on
  protectedRead; the update case and the baseline passed on both.
  Not covered: restore as the interleaving write. Restore bumps the revision too, so consistentRead covers it, but I did not write a test for it.

N04 residue (ZIP/JSON off the UI thread): FIXED, with the limits below
  core: optional Platform.archiveParser({bytes, limits, signal}). BackupService.parseBytes uses it for previewRestore and for the
  create-time verification, and falls back to in-thread parseArchive when it is absent. Sizes are captured before the call because the
  parser may take ownership of the buffer. Core now also exports parseArchive, FDX_DEFAULT_LIMITS, FdxLimits and ParsedBackup.
  mobile (apps/mobile/src/platform):
    archive.worker.ts           the worker, runs the same bounded-slice parseArchive plus validation
    archive-worker-core.ts      protocol + pure handler + typed error rebuild
    archive-parser.ts           client
    app-platform.ts             wired as platform.archiveParser
  Client behaviour:
    - one worker per job
    - ping/pong handshake first, while the bytes are still ours; no Worker, a throwing constructor, a startup error or a 4 s handshake
      timeout falls back to in-thread parse with the bytes intact
    - after the handshake the ArrayBuffer is TRANSFERRED, not copied
    - abort calls worker.terminate() immediately and rejects CANCELLED
    - a crash after hand-over gives BACKUP_INVALID (no silent UI-thread re-parse)
    - typed worker errors keep their code and message
  Tests: core test/backup-parser-seam.test.ts (2); mobile src/platform/archive-parser.test.ts (10: real handler, typed errors,
  success, no worker, throwing constructor, startup error, handshake timeout, crash, cancel mid-parse, already-aborted); e2e
  core-flow ".fdx backup -> fresh context -> restore" now asserts a worker whose URL matches /archive\.worker/ was created during
  restore. It passed in Chromium at both viewports.
  Not done (Sol's N04 text also asks for these): buildArchive still runs on the calling thread, and the file is still read whole into
  memory. The structured-clone of the parsed result back to the main thread is still main-thread work, so a very large backup still
  costs a clone on the UI thread. There are no retained-memory or resource tests.

N05 / N07 / N08 "partly" lines: closed by E01 / E04 / E03 above. N05 is covered by E01. N07's remaining gap (the dashboard's USER revision) is E04. N08's header-consistency gap is E03.

Files changed
  packages/core/src/db/sql.ts, transfer/service.ts, backup/archive.ts, backup/backup-service.ts, platform/platform.ts, services/portfolio.ts, index.ts
  packages/schemas/src/backup.ts
  apps/mobile/src/platform/{archive.worker.ts, archive-worker-core.ts, archive-parser.ts, archive-parser.test.ts, app-platform.ts}
  apps/mobile/e2e/core-flow.spec.ts
  new core tests: persistence-replay, backup-semantics, backup-zip-headers, dashboard-consistency, backup-parser-seam

Requests for others (outside my files)
  docs/API.md Director notes: E01 (durableRead; replay never succeeds while latched), E02 (new restore-invariant list; annotation
  overrides now strict), E03 (flags must match and no encryption in either header), E04 (dashboard under consistentRead), N04
  (Platform.archiveParser, with the transfer and abort contract). Also .agent/DIRECTOR-DECISIONS.md if the director logs these.
