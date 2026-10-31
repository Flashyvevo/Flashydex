# Import/export v1

Normative shared implementation target: packages/schemas/src/transfer.ts and generated packages/schemas/json-schema/{collection-export.v1,import-report.v1}.schema.json. No application implementation is included in this document. API routes/statuses are in API.md. A backup is a whole-database SQLite snapshot; a JSON export is the complete portable personal collection and relevant price history; a CSV export is one physical copy per row with explicit limitations below.

## JSON envelope

UTF-8, application/json, no comments/trailing commas, schemaVersion exactly 1. All listed keys required, unknown keys rejected at every object level, nullable fields explicitly null. Do not apply creation defaults to an imported row. UUIDs and timestamps round-trip unchanged. No user-configurable paths, SQL, tokens, app_state revision or sync checkpoint in this format.

```ts
// Reuse primitive zod schemas from API.md; these definitions have no computed DTO fields.
import { z } from 'zod';
import { Id, ProviderId, Language, Variant, Condition, Company, Currency, Cents,
  Instant, DateOnly, Name, Notes, ArtUrl, SafeInt } from './primitives';

const Audit = {createdAt:Instant,updatedAt:Instant};
export const CatalogRefRow = z.object({id:ProviderId,language:Language,name:Name,
  setId:ProviderId,setName:Name.nullable(),localId:z.string().min(1).max(80),
  rarity:z.string().max(100).nullable(),imageUrl:ArtUrl.nullable()}).strict();
export const CustomCardRow = z.object({id:Id,name:Name,setId:ProviderId.nullable(),setName:Name.nullable(),
  localId:z.string().min(1).max(80).nullable(),language:Language,rarity:z.string().max(100).nullable(),
  imageUrl:ArtUrl.nullable(),notes:Notes.nullable(),...Audit}).strict();
export const AcquisitionRow = z.object({id:Id,purchasedOn:DateOnly.nullable(),source:Name.nullable(),
  notes:Notes.nullable(),...Audit}).strict();
export const StorageLocationRow = z.object({id:Id,name:Name,description:Notes.nullable(),...Audit}).strict();
export const CollectionGroupRow = StorageLocationRow;
export const ScanSessionRow = z.object({id:Id,status:z.enum(['open','closed','abandoned']),
  startedAt:Instant,endedAt:Instant.nullable(),notes:Notes.nullable()}).strict();
export const OwnedCardRow = z.object({id:Id,catalogCardId:ProviderId.nullable(),customCardId:Id.nullable(),
  name:Name,setId:ProviderId.nullable(),setName:Name.nullable(),localId:z.string().min(1).max(80).nullable(),
  language:Language,rarity:z.string().max(100).nullable(),imageUrl:ArtUrl.nullable(),variant:Variant,
  variantDetail:z.string().max(120),condition:Condition.nullable(),acquisitionId:Id.nullable(),
  purchasePriceCents:Cents.nullable(),purchaseCurrency:Currency.nullable(),storageLocationId:Id.nullable(),
  scanSessionId:Id.nullable(),notes:Notes.nullable(),manualPriceCents:Cents.nullable(),
  manualPriceCurrency:Currency.nullable(),...Audit}).strict();
export const GradeRow = z.object({id:Id,ownedCardId:Id,company:Company,companyLabel:Name.nullable(),
  grade:z.string().trim().min(1).max(16),certNumber:z.string().min(1).max(100).nullable(),
  notes:Notes.nullable(),...Audit}).strict();
export const GroupMemberRow = z.object({collectionGroupId:Id,ownedCardId:Id}).strict();
export const PriceSnapshotRow = z.object({id:Id,catalogCardId:ProviderId,language:Language,
  source:z.enum(['tcgplayer','cardmarket']),variant:Variant,variantDetail:z.string().max(120),
  providerVariantKey:ProviderId,currency:Currency,lowCents:Cents.nullable(),midCents:Cents.nullable(),
  highCents:Cents.nullable(),marketCents:Cents.nullable(),trendCents:Cents.nullable(),
  sourceUpdatedAt:Instant.nullable(),capturedAt:Instant,
  observationKey:z.string().regex(/^[a-f0-9]{64}$/)}).strict();
export const CollectionExportV1 = z.object({schemaVersion:z.literal(1),exportedAt:Instant,
  appVersion:z.string().min(1).max(80),
  catalogRefs:z.array(CatalogRefRow),customCards:z.array(CustomCardRow),
  acquisitions:z.array(AcquisitionRow),storageLocations:z.array(StorageLocationRow),
  collectionGroups:z.array(CollectionGroupRow),scanSessions:z.array(ScanSessionRow),
  ownedCards:z.array(OwnedCardRow).max(100000),grades:z.array(GradeRow),
  collectionGroupMembers:z.array(GroupMemberRow),priceSnapshots:z.array(PriceSnapshotRow),
}).strict();
```

Primitive exports must actually live in primitives.ts; API.md collects their definitions for readable specification, not to require transfer.ts to depend on route DTOs. `CollectionGroupRow` and `StorageLocationRow` have the same keys, not the same IDs/namespaces. Derived nameSearch/nameKey/localIdSort are omitted and recomputed on import. Full CatalogSet/CatalogCard/raw provider cache is intentionally NOT exported: sync can rebuild it; backup includes it. `catalogRefs` are offline identity/display seeds, not authoritative remote metadata. No generated id for a catalog ref: id remains exact TCGdex id.

Export within one consistent database read snapshot:
- all customCards, acquisitions (including currently unlinked purchase events), locations, groups, scanSessions, ownedCards, grades and memberships;
- all PriceSnapshots whose `(language,catalogCardId)` is referenced by currently owned catalog copies, preserving complete history for those identities;
- one CatalogRefRow per such identity. Choose snapshot from lexicographically smallest owned UUID for deterministic behavior, not fresh provider metadata. Personal copies retain their individual snapshots even when CatalogRefRow differs;
- sort entity UUID arrays by id ASC, catalogRefs by language,id, memberships by collectionGroupId,ownedCardId. Price history is ordered by id for stable round-trip, not by latest date.

Cross-row refinements after structural parsing (also emit JSON Schema constraints where expressible): unique primary keys in every array, unique grade ownedCardId, member pairs unique; exactly one owned source; all referenced personal entities present in file OR existing target DB; catalogRef exists in file for every referenced catalog id including every PriceSnapshot; copy/custom language matches; catalog copies have nonnull setId/localId; date validity and endedAt rules; paired money nullability; source-currency pairing; canonical variant/detail and company/label rules from API/DATA-MODEL; grade updatedAt>=createdAt, copy/audit likewise; no negative/overflow cents; max 250,000 total entity rows. Recompute and verify observationKey; never trust arbitrary hash. Exporter's own file must be self-contained for an empty database, not require existing personal rows. Import may reference existing rows to support a partial hand-authored file.

JSON Schema must be generated Draft 2020-12 with `$id` `https://flashydex.local/schemas/collection-export.v1.schema.json` and `additionalProperties:false`. Annotate refinements as descriptions where cross-record logic is not expressible; runtime zod/service validation remains required. Generate from zod with a tooling-supported generator, check in outputs, CI fails when generation changes tracked schema. No invented $ref that cannot resolve locally. `format:date-time`/`date`, enums, integer ranges, required arrays and nullable unions must be emitted. No need for a v2 migrator now: reject unknown versions, preserve original upload unchanged.

## CSV v1: exact ordered header

UTF-8; emit BOM for spreadsheet compatibility (parser accepts with/without BOM); RFC 4180 quoting with CRLF row endings; comma delimiter. One row equals one owned physical copy. No `quantity` column. Export has exactly these 45 columns in order:

```text
owned_card_id,catalog_card_id,custom_card_id,name,set_id,set_name,local_id,language,rarity,image_url,variant,variant_detail,condition,acquisition_id,purchase_date,purchase_source,acquisition_notes,purchase_price_cents,purchase_currency,storage_location_id,storage_location_name,storage_location_description,group_ids,group_names,group_descriptions,is_graded,grade_id,grading_company,grading_company_label,grade,cert_number,grade_notes,manual_price_cents,manual_price_currency,notes,custom_card_notes,custom_card_created_at,custom_card_updated_at,scan_session_id,scan_session_status,scan_session_started_at,scan_session_ended_at,scan_session_notes,created_at,updated_at
```

CSV import accepts exactly the named columns above in any order, requires `name,language,variant`, permits missing optional columns, rejects unknown/duplicate headers. This allows hand-authored minimal files while own exports are deterministic. Missing/empty optional cell ->NULL (except variant_detail ->''); missing/empty owned_card_id ->generate UUID once in persisted plan. If catalog_card_id and custom_card_id both present ->row error. A nonempty explicit id must validate its exact format before lookup; never silently repair a malformed UUID/provider identifier. Treat all ID/collector/certificate fields as strings, not numbers; spreadsheet software may damage leading zeros, so warn users to import as text.

| Column(s) | Format and semantics |
|---|---|
| owned_card_id, custom_card_id, acquisition_id, storage_location_id, grade_id, scan_session_id | canonical UUID strings or blank; catalog_card_id/set_id are provider text, not UUID |
| name, set_name, rarity, notes and *_notes / *_description | Unicode text; notes can contain quoted linebreaks; no max length bypass |
| language / variant / condition / grading_company | exact enums from DATA-MODEL; condition blank=unknown, never infer NM |
| variant_detail | '' standard normal/holo/reverse; first_edition qualifier or stamped/other detail as model |
| local_id | exact collector string, preserve zeros and Japanese letters; never numeric coercion |
| purchase_date | real YYYY-MM-DD or blank; date of Acquisition, no timezone |
| *_cents | nonnegative base-10 INTEGER cents string, no symbols, commas, decimals or exponent; e.g. 1250 is 12.50 of currency, 0 known free |
| *_currency | USD or EUR, required iff matching cents present; no implicit currency/FX |
| image_url | full http/https URL or blank; not fetched during import |
| group_ids / group_names / group_descriptions | JSON arrays in one quoted CSV cell. Parallel arrays in identical index order; ids strings UUID, names nonempty strings, descriptions string or null. Example export cell content `["uuid"]`; RFC4180 escapes quotes. Empty membership uses `[]` in all three cells |
| is_graded | literal true/false, exported always; absent inferred true only if grading_company AND grade present, otherwise false; false with any grade fields is an error |
| grade, cert_number | exact text; grade '9.5'/'Authentic', cert preserves zeros; grade_id required on own export, generated on external row if absent |
| custom_card_created_at / custom_card_updated_at / custom_card_notes | exported definition data for custom identity (otherwise blank); definition name/set/local/language/rarity/image use row snapshot fields; see CSV limitation below |
| scan_session_* | repeated session definition for rows linked to one session; exact status/time rules; blank if no session |
| created_at / updated_at | canonical UTC YYYY-MM-DDTHH:mm:ss.sssZ. External blanks default to preview timestamp; reused exact defaults during commit |

Acquisition createdAt/updatedAt, Grade createdAt/updatedAt, Location/Group timestamps, and PriceSnapshot history are NOT in CSV. Import initializes missing metadata timestamps to preview time and preserves existing target metadata on skip. JSON is the only lossless complete-collection exchange. CSV cannot preserve unreferenced groups/locations/acquisitions/customs/sessions or provider price history; it also cannot represent a custom definition diverging from the stored personal snapshot. Export uses snapshot card fields and custom definition notes/timestamps; warn when definitions diverge. These are explicit format limitations, not permission to omit per-copy purchase/grade/manual price fields.

Repeated CSV parent IDs must have identical parent values throughout the file, otherwise row errors (never last-row-wins). Rows with same acquisition ID share purchase_date/source/notes; same location ID share name/description; same group ID share name/description; same custom ID share definition fields; same session ID share definition. Imported grade_id has only one owning copy. IDs with no supplied definition may link an existing parent; otherwise report missing reference. Parent names without ID match target by normalized unique name; if absent create new UUID once in plan. Groups may omit group_ids but provide group_names/descriptions arrays of equal length (all missing IDs generated/resolved); do not encode memberships as comma-delimited strings. Acquisition fields without ID create a distinct event PER ROW; never deduplicate events by coincidental date/source. Explicit shared ID is required to group a purchase event across rows. A duplicate owned_card_id in one file is an error even if rows are identical.

### Spreadsheet formula safety, reversible

For text cells only, if raw text begins with `=`, `+`, `-`, `@`, tab, CR, LF or apostrophe, prefix one apostrophe on EXPORT. On IMPORT, remove exactly one leading apostrophe only if the following character belongs to that same trigger set. This is a documented transport escape, not a data mutation; doubling an existing leading apostrophe is necessary for reversibility. Validate raw formula-like text but never execute it. Do not apply this to integer cents, booleans, timestamps or the structured JSON-array cells. JSON-array cells always start with '[' (safe) and use JSON string escaping inside RFC4180 quoting. Quoting CSV alone is not formula safety. Tests must round-trip every trigger and quoted Japanese notes.

## Matching and conflicts (preview before write)

Matching order for a copy:
1. If explicit catalog_card_id exists, validate id/language as provided; use exact composite key if cached. If valid id is absent from cache, use exact set_id+local_id+language only if a UNIQUE cached card resolves AND the id agrees; disagreement is a conflict, never substitute another id behind the owner. Otherwise preserve explicit catalog identity by creating a ledger stub using required snapshot name/set_id/local_id/language; mark warning CATALOG_METADATA_MISSING. This offline exception is essential to lossless restore/export, not a fabricated catalog record.
2. If no explicit catalog id AND no explicit custom id, lookup exact `(set_id,local_id,language)` when all supplied; one match ->catalog reference. Preserve source localId exactly; don't strip zeros, guess language or match by card name alone. Multiple hits (corrupt cache) ->error AMBIGUOUS_CARD, not a best guess.
3. Explicit custom_card_id uses that definition from file/target, never guesses a catalog match. Otherwise unmatched metadata becomes a CustomCard using supplied snapshot fields. Generate one custom identity per exact normalized identity tuple `(language,name,set_id,set_name,local_id,rarity,image_url)` within THIS import plan; outside plan, no automatic name-based dedupe of existing customs. Record CUSTOM_CARD_CREATED warning. Empty set/local allowed for true custom data; name/language remain mandatory.

JSON already has explicit source IDs and preserves them; matching by triple/custom fallback primarily applies to hand-authored CSV. All generated IDs, default timestamps and resolved references are stored in the immutable plan. CatalogRef snapshots do not overwrite OwnedCard snapshots. Sync during preview cannot alter a committed plan's resolution.

Conflict policy applies per entity stable PK, NOT by card identity: multiple copies of the same catalog/variant are valid physical duplicates. A new owned UUID adds a physical card. Same UUID (or member composite key):
- `skip` (default): keep existing entire row, report skipped; do not replace its grade/groups through child rows. For a skipped owned copy, skip associated incoming grade/members as well. Independent other entities follow their own conflict resolution. Identical rows are counted skipped under either policy.
- `update`: update mutable transfer fields for existing UUID without changing id; validate all prospective references, merged uniqueness and check constraints. Update includes snapshot/identity only because preview explicitly identifies this destructive change; ordinary PATCH cannot. For every incoming owned UUID selected for update, the file's grade and group memberships are AUTHORITATIVE: remove old grade if absent in file, replace/preserve given grade ID according to full row, and replace memberships with file pairs (empty clears). Never delete an owned copy absent from the file. No deletion of independent parent entities absent from file. A CSV row has the same authoritative grade/members semantics after normalization.

Immutable PriceSnapshot conflict: identical id/observation content ->skip; same semantic observationKey with different id ->skip and map to existing (not referenced by copy); same UUID with different observation content ->error PRICE_IMMUTABLE under either policy. catalogRefs create identity ledger rows if absent but never update catalog metadata or personal rows implicitly. Normalized location/group name collision with a DIFFERENT UUID ->error NAME_CONFLICT; do not silently merge identities. On import update a Grade id already owned by another copy ->error REFERENCE_CONFLICT. Generated CSV name-only parent matching avoids a collision only when user didn't supply an explicit ID.

A repeated import of the same unchanged JSON or own CSV is idempotent by owned UUID; no row count increase. A minimal CSV WITHOUT owned UUIDs intentionally describes new physical copies: each NEW dry-run generates fresh IDs and therefore can add duplicates. The UI warns NO_STABLE_IDS; retrying the SAME committed preview returns its original result. No heuristic dedupe by name/variant that could erase true physical duplicates.

## Dry-run report / commit schemas

```ts
const EntityName = z.enum(['catalogRefs','customCards','acquisitions','storageLocations','collectionGroups',
  'scanSessions','ownedCards','grades','collectionGroupMembers','priceSnapshots']);
const Counts = z.object({read:SafeInt,create:SafeInt,update:SafeInt,skip:SafeInt,error:SafeInt}).strict();
const Issue = z.object({entity:EntityName,row:SafeInt.nullable(),id:z.string().nullable(),
  code:z.string(),message:z.string(),path:z.array(z.union([z.string(),z.number().int()]))}).strict();
export const ImportCommitResult = z.object({id:Id,committedAt:Instant,collectionRevision:SafeInt,
  createdCopies:SafeInt,updatedCopies:SafeInt,skippedCopies:SafeInt,totalCards:SafeInt,
  counts:z.object({catalogRefs:Counts,customCards:Counts,acquisitions:Counts,storageLocations:Counts,
    collectionGroups:Counts,scanSessions:Counts,ownedCards:Counts,grades:Counts,
    collectionGroupMembers:Counts,priceSnapshots:Counts}).strict()}).strict();
export const ImportReport = z.object({id:Id,status:z.enum(['preview','committed']),format:z.enum(['json','csv']),
  conflictPolicy:z.enum(['skip','update']),valid:z.boolean(),
  inputHash:z.string().regex(/^[a-f0-9]{64}$/),planHash:z.string().regex(/^[a-f0-9]{64}$/),
  createdAt:Instant,expiresAt:Instant,collectionRevision:SafeInt,
  counts:z.object({catalogRefs:Counts,customCards:Counts,acquisitions:Counts,storageLocations:Counts,
    collectionGroups:Counts,scanSessions:Counts,ownedCards:Counts,grades:Counts,
    collectionGroupMembers:Counts,priceSnapshots:Counts}).strict(),
  errors:z.array(Issue).max(100),warnings:z.array(Issue).max(100),
  errorCount:SafeInt,warningCount:SafeInt,
  changes:z.array(z.object({entity:EntityName,id:z.string(),action:z.enum(['create','update','skip']),
    changedFields:z.array(z.string())}).strict()).max(100),
  changesTruncated:z.boolean(),result:ImportCommitResult.nullable(),
}).strict();
```

ImportCommitResult is declared before ImportReport; no recursive schema is needed. Issue.row is 1-based data-row number excluding CSV header; JSON array element is index+1; envelope issue row=null. Counts partition every entity input into exactly one create/update/skip/error; `read = create+update+skip+error`. Multiple validation issues on the same row count it once as error; errorCount counts issues, can exceed counts.*.error. Generated parent rows count as read/create for normalized plan entities, not just visible CSV rows. Counts for group membership replacement describe incoming rows; `changedFields` on OwnedCard includes 'groupIds'/'grade' when existing child removal is required. Metadata-missing identity ledger insert counts as catalogRefs create; cached/existing identity is skip.

valid iff errorCount=0 (warnings do not prevent commit). `changes` is first 100 normalized rows in entity order shown by EntityName then stable primary key; changesTruncated iff more. Do not put notes, cert numbers or prior values in report; changedFields identifies field names only. UI confirms counts + update-destructive warning, never automatically commits after dry-run. No DB mutation at all in dry-run (including ledger inserts, revision, sync state or parent defaults); disk staging only. A plan with errors cannot commit.

PlanHash = SHA-256 over canonical UTF-8 JSON of `{schemaVersion:1,inputHash,conflictPolicy,collectionRevision,createdAt,rows}` with recursively lexicographic object keys and stable sorted entity rows; store and verify that exact serialization. Hash binds file, default IDs/times, resolution and intended changes. No executable SQL in plan. Commit revalidates references under one write transaction, compares revision, writes parents -> ledger -> copies -> grades/members/prices, increments revision once, reads count, commits, atomically marks staged plan committed. To survive a crash between DB commit and plan-file write, record an import receipt INSIDE the database transaction; see required `data_operation_receipts` table in DATA-MODEL. Receipt stores operation id, planHash, result JSON, committedAt; retry reads receipt and returns original result. Never claim file-only flags guarantee exactly-once behavior.

Delete staged raw bytes/plans at expiry (30 minutes). Completed receipt/result survives 24 hours for retry, cleanup can remove later; completed export/backup files have operator-managed retention. A preview of the same file after revision changed is a new operation, not a replay. Ordinary import errors return the standard envelope, using details `{reportId}` when a report exists. No partial import, no skip-invalid mode, no implicit replace-all.

## Required fixtures and interoperability proof

Golden JSON fixture includes EN+JA catalog ids with overlapping provider strings, a metadata-missing identity, two normal copies with different condition/purchase/storage, one reverse copy, one graded copy, an unknown cost, a known zero, manual EUR price, custom card, acquisition, group membership, scanSession row and repeated provider quote. Synthetic fixture records are allowed ONLY in tests, clearly marked as tests; never seed production UI with fake cards/prices.

Export -> import into empty DB -> export must match every personal field/UUID and included price observation exactly after removing envelope exportedAt/appVersion and server-local state. New DB cached metadata may remain empty; owned rendering must still work. CSV export -> import -> export must preserve all specified per-copy/represented parent fields, not claim full JSON equality for the documented lost fields. Test RFC4180 quotes/newlines, Unicode Japanese, enum rejection, formula-safe round-trip, invalid date, partial money pairs, unknown source, price dedupe, same file replay, stale plan and injected mid-transaction failure. JSON Schema and zod must accept the same golden files and reject the same structural invalid files.
