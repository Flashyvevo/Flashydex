# Phase 1 HTTP API

Normative names and wire shapes. Base `/api`; Next Node route handlers only. API DTO keys camelCase. All responses JSON unless marked download/204. All JSON objects below are strict (`.strict()`); reject unknown keys, not silently discard them. Shared definitions belong in packages/schemas/src/{primitives,entities,api,transfer}.ts. Import/export definitions are in IMPORT-EXPORT.md and are part of this contract.

## Conventions, errors, paging

Success is `{data:T}`; list is `{data:T[],page:{offset,limit,total,hasMore}}`. `total` is the filtered total, never page length; `hasMore = offset + data.length < total`. Offset pagination chosen for straightforward personal collection filtering; inserts can shift subsequent pages, so UI resets to offset 0 after mutations/filter changes. Every ordering has a deterministic id/language tie-breaker. Search maximum 50, collection maximum 50, other lists maximum 50. No unbounded owned-copy list, including card detail. Export is the deliberate all-records streaming exception.

```ts
import { z } from 'zod';
export const Id = z.string().uuid();
export const ProviderId = z.string().min(1).max(200);
export const Language = z.enum(['en', 'ja']);
export const Variant = z.enum(['normal','holo','reverse_holo','first_edition','promo_stamped','shadowless','other']);
export const Condition = z.enum(['NM','LP','MP','HP','DMG']);
export const Company = z.enum(['PSA','BGS','CGC','SGC','ACE','TAG','other']);
export const Currency = z.enum(['USD','EUR']);
export const Cents = z.number().int().min(0).max(2147483647);
export const SafeInt = z.number().int().min(0).max(Number.MAX_SAFE_INTEGER);
export const SignedSafeInt = z.number().int().min(Number.MIN_SAFE_INTEGER).max(Number.MAX_SAFE_INTEGER);
export const Instant = z.string().datetime({ offset: false }).refine(v =>
  /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/.test(v), 'Canonical UTC timestamp required');
export const DateOnly = z.string().regex(/^\d{4}-\d{2}-\d{2}$/).refine(value => {
  const [year,month,day] = value.split('-').map(Number);
  const date = new Date(0);
  date.setUTCFullYear(year,month-1,day);
  return date.getUTCFullYear() === year && date.getUTCMonth() === month-1 && date.getUTCDate() === day;
}, 'Invalid calendar date');
export const Name = z.string().trim().min(1).max(200);
export const Notes = z.string().max(5000);
export const ArtUrl = z.string().url().max(2048).refine(v => ['https:','http:'].includes(new URL(v).protocol));
export const Money = z.object({cents:Cents,currency:Currency}).strict();
const QInt = (def:number,max:number) => z.preprocess(v => v === undefined ? String(def) : v,
  z.string().regex(/^\d+$/).transform(Number).pipe(z.number().int().min(0).max(max)));
export const PageQuery = z.object({offset:QInt(0,10000000),limit:QInt(30,50)
  .refine(v => v >= 1, 'limit must be >= 1')}).strict();
export const BoolQuery = z.enum(['true','false']).transform(v => v === 'true');
export const PageMeta = z.object({offset:SafeInt,limit:z.number().int().min(1).max(50),total:SafeInt,hasMore:z.boolean()}).strict();
export const Result = <S extends z.ZodTypeAny>(schema:S) => z.object({data:schema}).strict();
export const ListResult = <S extends z.ZodTypeAny>(schema:S) => z.object({data:z.array(schema),page:PageMeta}).strict();
export const ErrorResponse = z.object({error:z.object({
  code:z.string(),message:z.string(),details:z.unknown().optional(),
}).strict()}).strict();
```

QInt supplies a string default before parsing, compatible with zod 3/4; missing offset=0/limit=30, digit strings parsed once, all other values invalid. No z.coerce.boolean() ('false' must not become true). All examples are TypeScript contracts, not permission to omit stated refinements.

URL path params use Id or ProviderId as appropriate and Language, decoding once; missing route ->404, invalid UUID/language ->400. Reject duplicate query keys. Headers for ordinary mutation: Content-Type application/json; browser Origin must match APP_ORIGIN. Empty JSON body only accepted where explicitly stated. Same-origin protection and caps from ARCHITECTURE apply to every endpoint.

Common failures (apply to every route as relevant):

| HTTP | code | details |
|---|---|---|
| 400 | VALIDATION_ERROR | `{issues:Array<{path:(string|number)[],code:string,message:string}>}` sorted by path |
| 400 | INVALID_JSON | absent |
| 403 | ORIGIN_FORBIDDEN | absent |
| 404 | NOT_FOUND | `{entity:string,id:string}` |
| 409 | IN_USE | `{entity:string,id:string,dependentCount:number}` |
| 409 | CONFLICT | `{field:string}` for unique name/ID collisions |
| 409 | STALE_PREVIEW | `{expectedRevision:number,actualRevision:number}` |
| 409 | ACTIVE_SYNC / ACTIVE_WORK | `{syncId:string}` if applicable |
| 409 | INVALID_STATE | `{status:string}` |
| 410 | PREVIEW_EXPIRED | absent |
| 413 | PAYLOAD_TOO_LARGE | `{maxBytes:number}` |
| 415 | UNSUPPORTED_MEDIA_TYPE | absent |
| 422 | IMPORT_INVALID / BACKUP_INVALID | safe validation issues or reportId |
| 503 | DB_BUSY | absent, Retry-After: 1 |
| 503 | MAINTENANCE / WORKER_UNAVAILABLE | absent |
| 500 | INTERNAL_ERROR | absent; server logs internal cause, never stack in body |

Referenced ID not found in mutation ->404 NOT_FOUND, mismatched existing identity/language or forbidden field combination ->400 VALIDATION_ERROR. No HTML error bodies on API paths. Every DELETE is 204 with zero bytes when it deleted/existed; missing resource ->404, except idempotent membership removal explicitly documented. HTTP methods not supported ->405 plus Allow. All responses no-store. No 200-shaped success for failure.

## Shared response entity schemas

These are also the entity building blocks for transfer schemas, except transfer excludes computed fields and has the exact row representation defined there. `...shape` means zod object shape spread, not an undocumented field.

```ts
export const GradeInput = z.object({
  company:Company,companyLabel:Name.nullable().default(null),grade:z.string().trim().min(1).max(16),
  certNumber:z.string().trim().min(1).max(100).nullable().default(null),notes:Notes.nullable().default(null),
}).strict(); // refine company='other' iff companyLabel!=null
export const GradeDto = z.object({
  id:Id,ownedCardId:Id,...GradeInput.shape,createdAt:Instant,updatedAt:Instant,
}).strict();
export const AcquisitionInput = z.object({purchasedOn:DateOnly.nullable().default(null),
  source:Name.nullable().default(null),notes:Notes.nullable().default(null)}).strict();
export const AcquisitionDto = z.object({id:Id,...AcquisitionInput.shape,createdAt:Instant,updatedAt:Instant,copyCount:SafeInt}).strict();
export const NamedInput = z.object({name:Name,description:Notes.nullable().default(null)}).strict();
export const LocationDto = z.object({id:Id,...NamedInput.shape,createdAt:Instant,updatedAt:Instant,copyCount:SafeInt}).strict();
export const GroupDto = LocationDto; // same JSON fields; distinct route/entity name
export const CustomInput = z.object({name:Name,setId:ProviderId.nullable().default(null),
  setName:Name.nullable().default(null),localId:z.string().min(1).max(80).nullable().default(null),
  language:Language,rarity:z.string().min(1).max(100).nullable().default(null),
  imageUrl:ArtUrl.nullable().default(null),notes:Notes.nullable().default(null)}).strict();
export const CustomDto = z.object({id:Id,...CustomInput.shape,createdAt:Instant,updatedAt:Instant,copyCount:SafeInt}).strict();
export const PriceDto = z.object({id:Id,catalogCardId:ProviderId,language:Language,
  source:z.enum(['tcgplayer','cardmarket']),variant:Variant,variantDetail:z.string().max(120),
  providerVariantKey:ProviderId,currency:Currency,lowCents:Cents.nullable(),midCents:Cents.nullable(),
  highCents:Cents.nullable(),marketCents:Cents.nullable(),trendCents:Cents.nullable(),
  sourceUpdatedAt:Instant.nullable(),capturedAt:Instant}).strict();
export const ValuationDto = z.object({currency:Currency,cents:Cents,
  source:z.enum(['manual','tcgplayer','cardmarket']),priceSnapshotId:Id.nullable(),capturedAt:Instant}).strict();
export const CardSummary = z.object({id:ProviderId,language:Language,name:Name,setId:ProviderId,
  setName:Name.nullable(),localId:z.string().min(1).max(80),rarity:z.string().nullable(),
  imageUrl:ArtUrl.nullable(),availableVariants:z.array(Variant),detailsComplete:z.boolean(),
  ownedCount:SafeInt}).strict();
export const OwnedDto = z.object({id:Id,catalogCardId:ProviderId.nullable(),customCardId:Id.nullable(),
  name:Name,setId:ProviderId.nullable(),setName:Name.nullable(),localId:z.string().nullable(),language:Language,
  rarity:z.string().nullable(),imageUrl:ArtUrl.nullable(),variant:Variant,variantDetail:z.string().max(120),
  condition:Condition.nullable(),acquisitionId:Id.nullable(),acquisition:AcquisitionDto.nullable(),
  purchasePrice:Money.nullable(),storageLocationId:Id.nullable(),storageLocationName:Name.nullable(),
  scanSessionId:Id.nullable(),notes:Notes.nullable(),manualPrice:Money.nullable(),grade:GradeDto.nullable(),
  groupIds:z.array(Id),duplicateCount:SafeInt,valuations:z.array(ValuationDto),
  catalogAvailable:z.boolean(),createdAt:Instant,updatedAt:Instant}).strict();
export const SetSummary = z.object({id:ProviderId,language:Language,name:Name,series:z.string().nullable(),
  releaseDate:DateOnly.nullable(),logoUrl:ArtUrl.nullable(),symbolUrl:ArtUrl.nullable(),
  officialCount:SafeInt.nullable(),totalCount:SafeInt.nullable(),catalogCount:SafeInt,catalogComplete:z.boolean(),
  ownedCount:SafeInt,customOwnedCount:SafeInt,ownedUnique:SafeInt,missingCount:SafeInt,
  duplicateExtras:SafeInt,completionPercent:z.number().min(0).max(100).nullable()}).strict();
```

Grade refinements are on final input schemas rather than ZodEffects prior to `.shape` composition. Nullable empty optional text is normalized as DATA-MODEL states. Every response computed nullable field is present, not omitted. Ordered groupIds lexicographic; availableVariants in canonical enum order; valuations USD then EUR. For manual valuation capturedAt is OwnedCard.updatedAt (copy edit timestamp, not marketplace time).

## Health

GET `/health`: no query/body; 200 `Result(z.object({status:z.literal('ok'),database:z.literal('ok'),version:z.string()}).strict())`. Tests must execute a database read. 503 DB_BUSY/MAINTENANCE or INTERNAL_ERROR as appropriate; do not return ok for inaccessible DB. Python /health is a different process documented in ARCHITECTURE.

## Catalog and sets

```ts
export const SetListQuery = PageQuery.extend({language:Language.optional(),q:z.string().trim().max(100).optional(),
  sort:z.enum(['release_desc','name_asc']).default('release_desc')}).strict();
export const SetCardsQuery = PageQuery.extend({ownership:z.enum(['all','owned','missing']).default('all'),
  duplicates:BoolQuery.optional()}).strict();
export const CardSearchQuery = PageQuery.extend({q:z.string().trim().max(100).optional(),
  setId:ProviderId.optional(),localId:z.string().min(1).max(80).optional(),language:Language.optional(),
  rarity:z.string().min(1).max(100).optional(),match:z.enum(['prefix','contains']).default('prefix')}).strict();
export const CardDetail = CardSummary.extend({category:z.string().nullable(),illustrator:z.string().nullable(),
  latestPrices:z.array(PriceDto),ownedCopies:ListResult(OwnedDto),
  purchaseHistory:z.array(z.object({acquisition:AcquisitionDto,purchasePrice:Money.nullable(),ownedCardId:Id}).strict()),
  syncedAt:Instant,detailSyncedAt:Instant.nullable()}).strict();
```

| Method/path | Input | Success | Order/notes |
|---|---|---|---|
| GET /catalog/sets | SetListQuery | 200 ListResult(SetSummary) | releaseDate desc NULL last,language asc,id asc; name sort nameSearch,language,id |
| GET /catalog/sets/:language/:setId | path Language/ProviderId; no query | 200 Result(SetSummary.extend({missingPreview:z.array(CardSummary).max(20)}).strict()) | preview first 20 missing by localIdSort,id; 404 no cached set |
| GET /catalog/sets/:language/:setId/cards | SetCardsQuery | 200 ListResult(CardSummary) | active manifest cards only, localIdSort,id; 404 missing set; duplicates=true any variant group>1, false none |
| GET /catalog/cards | CardSearchQuery | 200 ListResult(CardSummary) | rank exact name, prefix name, contains name then nameSearch,language,id |
| GET /catalog/cards/:language/:cardId | PageQuery for ownedCopies | 200 Result(CardDetail) | copy page createdAt desc,id desc; 404 missing metadata; offline copy page still works |

CardSearch q searches nameSearch only (collector number has dedicated localId filter); prefix matches `normalizedQ%`, contains matches `%normalizedQ%` (fuzzy-ish literal substring, not edit-distance). Prefix UI may explicitly retry contains when no results, label broad results. Escape %, _ and backslash with explicit SQL ESCAPE; no user wildcard syntax. localId exact literal preserves '001'; other filters exact AND. No filters returns first page, not remote fetch. Search detail pricing never blocks on network. Card Detail latestPrices is latest observation per `(source,variant,variantDetail,currency,providerVariantKey)` ordered source asc,variant canonical order,variantDetail asc,key asc. purchaseHistory contains only the returned ownedCopies page with non-null acquisitionId, in purchasedOn desc NULL last,id desc; its pagination is that same copy page, not an unbounded second array. UI can load further copy pages to inspect further purchase history. MissingCount counts currently loaded active manifest cards lacking ownership; if incomplete it is labelled 'known missing'. See DATA-MODEL equations.

## Owned copies and bulk add

```ts
export const OwnedListQuery = PageQuery.extend({q:z.string().trim().max(100).optional(),
  setId:ProviderId.optional(),rarity:z.string().min(1).max(100).optional(),language:Language.optional(),
  condition:z.enum(['NM','LP','MP','HP','DMG','unknown']).optional(),
  grading:z.enum(['raw','graded']).optional(),duplicates:BoolQuery.optional(),
  storageLocationId:z.union([Id,z.literal('none')]).optional(),groupId:Id.optional(),
  variant:Variant.optional(),acquisitionId:Id.optional(),
  sort:z.enum(['created_desc','name_asc','set_asc']).default('created_desc')}).strict();
export const AcquisitionLink = z.union([
  z.object({id:Id}).strict(),z.object({create:AcquisitionInput}).strict(),
]);
export const OwnedCreate = z.object({language:Language,catalogCardId:ProviderId.optional(),customCardId:Id.optional(),
  variant:Variant,variantDetail:z.string().trim().max(120).default(''),condition:Condition.nullable().default(null),
  purchasePrice:Money.nullable().default(null),acquisition:AcquisitionLink.nullable().default(null),
  storageLocationId:Id.nullable().default(null),notes:Notes.nullable().default(null),
  manualPrice:Money.nullable().default(null),grade:GradeInput.nullable().default(null),
  groupIds:z.array(Id).max(100).default([])}).strict();
// Refine exactly one catalogCardId/customCardId, other requires detail, groupIds unique,
// companyLabel rule, source language match. No identity snapshots accepted from ordinary UI.
export const OwnedPatch = z.object({variant:Variant.optional(),variantDetail:z.string().trim().max(120).optional(),
  condition:Condition.nullable().optional(),purchasePrice:Money.nullable().optional(),
  acquisitionId:Id.nullable().optional(),storageLocationId:Id.nullable().optional(),
  notes:Notes.nullable().optional(),manualPrice:Money.nullable().optional(),
  grade:GradeInput.nullable().optional(),groupIds:z.array(Id).max(100).optional()}).strict();
export const BulkAdd = z.object({quantity:z.number().int().min(1).max(100),copy:OwnedCreate}).strict();
```

OwnedPatch must contain >=1 key and validate the merged copy, e.g. changing other to normal must clear inapplicable variantDetail or fail validation; omission preserves, explicit null clears. variantDetail must be '' for normal/holo/reverse_holo; for first_edition allowed '', 'normal', 'holo'; for shadowless/promo_stamped arbitrary qualifier <=120; other requires nonempty. API doesn't guess variant or condition. Grade cert uniqueness not enforced. Creating graded bulk quantity>1 with non-null certNumber ->400 (enter individual certificates separately). Bulk price is PER COPY, N=3 and cents=100 means total cost 300. Bulk `acquisition.create` creates one event shared by all N; not N events.

| Method/path | Input | Success |
|---|---|---|
| GET /owned-cards | OwnedListQuery | 200 ListResult(OwnedDto) |
| POST /owned-cards | OwnedCreate | 201 Result(OwnedDto), Location: /api/owned-cards/:id |
| POST /owned-cards/bulk | BulkAdd | 201 Result(z.object({created:z.number().int().min(1).max(100),copies:z.array(OwnedDto).min(1).max(100)}).strict()) |
| GET /owned-cards/:ownedId | Id path, no query | 200 Result(OwnedDto) |
| PATCH /owned-cards/:ownedId | OwnedPatch | 200 Result(OwnedDto) |
| DELETE /owned-cards/:ownedId | no body | 204 |

Every create/update/delete is one transaction including grade and membership, referenced events and revision. Unknown parent fails entire bulk add. Card must exist in local catalog to ordinary-create via catalogCardId; 404 guides owner to sync or custom add. Import can restore a metadata-missing catalog identity; UI may edit/delete it without provider access. Raw/graded is derived from grade presence. q matches snapshot name contains literal normalized q. All list filters AND, duplicate count computed BEFORE these filters. duplicates=true means all members of duplicate groups, false only singleton groups. condition unknown ->IS NULL. location none ->IS NULL. created order DESC,id DESC; name order nameSearch,id ASC; set order language,setId NULL last,localId text ASC,id ASC (not a promised natural collector sort for personal snapshots). Whole-collection group counts remain visible even if one member matches current filters. No mutation retries without explicit user action after an uncertain network result; UI refetches first and prevents double submission.

## Acquisitions

```ts
export const AcquisitionQuery = PageQuery.extend({source:z.string().max(200).optional(),
  from:DateOnly.optional(),to:DateOnly.optional()}).strict(); // from<=to
export const AcquisitionPatch = z.object({purchasedOn:DateOnly.nullable().optional(),
  source:Name.nullable().optional(),notes:Notes.nullable().optional()}).strict(); // >=1 supplied key
```

GET `/acquisitions` ->200 ListResult(AcquisitionDto), purchasedOn desc NULL last,id desc; source literal substring, date bounds inclusive, unknown dates excluded when bounds given. POST `/acquisitions` body AcquisitionInput ->201 Result(AcquisitionDto). GET `/acquisitions/:id` no query ->200 Result(AcquisitionDto). PATCH same path AcquisitionPatch ->200 same. DELETE same path no body ->204 or409 IN_USE; changing purchasedOn/source updates all linked copies' displayed purchase event. No stored lot total; per-copy price belongs on owned-card API. Details of copies via GET /owned-cards?acquisitionId=... (paginated).

## Storage locations, groups and memberships

```ts
export const NamedQuery = PageQuery.extend({q:z.string().trim().max(100).optional()}).strict();
export const NamedPatch = z.object({name:Name.optional(),description:Notes.nullable().optional()}).strict();
export const MembersBody = z.object({ownedCardIds:z.array(Id).min(1).max(100)}).strict(); // unique IDs
```

For each resource `/storage-locations` (LocationDto) and `/collection-groups` (GroupDto): GET list NamedQuery ->200 ListResult(Dto), nameKey,id ASC, q contains literal normalized name; POST NamedInput ->201 Result(Dto); GET `/:id` no query ->200 Result(Dto); PATCH `/:id` NamedPatch (>=1 key) ->200 Result(Dto); DELETE `/:id` no body ->204. Normalized name collision ->409 CONFLICT. Deleting storage clears locations on copies, never deletes copies; deleting group clears memberships, never copies. Counts for confirmation come from GET exact resource.

POST `/collection-groups/:id/members` MembersBody ->200 Result(GroupDto), add memberships (existing is no-op). DELETE same path MembersBody ->200 Result(GroupDto), remove specified memberships (absent membership is no-op). Group and all referenced copies must exist, otherwise404 and no change. Adding/removing uses one transaction, never partially succeeds. Copies for a group: GET /owned-cards?groupId=...; there is no separate unbounded members list. JSON DELETE body is intentional and must be tested by client/tooling.

## Custom cards

```ts
export const CustomQuery = PageQuery.extend({q:z.string().trim().max(100).optional(),language:Language.optional()}).strict();
export const CustomPatch = z.object({name:Name.optional(),setId:ProviderId.nullable().optional(),
  setName:Name.nullable().optional(),localId:z.string().min(1).max(80).nullable().optional(),
  language:Language.optional(),rarity:z.string().min(1).max(100).nullable().optional(),
  imageUrl:ArtUrl.nullable().optional(),notes:Notes.nullable().optional()}).strict();
```

GET `/custom-cards` CustomQuery ->200 ListResult(CustomDto), nameSearch,id ASC. POST same path CustomInput ->201 Result(CustomDto). GET `/custom-cards/:id` no query ->200 Result(CustomDto). PATCH CustomPatch (>=1 key) ->200 same. DELETE no body ->204 or409 IN_USE. A referenced custom definition cannot change language (409 CONFLICT field=language); other edits don't overwrite copy snapshots. UI custom create then owned create is a two-step flow; a failed owned save leaves the reusable definition, not an invisible physical copy. No automatic identity merge.

## Dashboard and valuations

```ts
export const CurrencyStats = z.object({currency:Currency,estimatedValueCents:SafeInt.nullable(),
  valuedCopies:SafeInt,unvaluedCopies:SafeInt,totalPaidCents:SafeInt.nullable(),knownCostCopies:SafeInt,
  comparableCopies:SafeInt,comparableCostCents:SafeInt.nullable(),comparableValueCents:SafeInt.nullable(),
  gainLossCents:SignedSafeInt.nullable()}).strict();
export const DashboardDto = z.object({totalCards:SafeInt,uniqueCards:SafeInt,duplicates:SafeInt,
  currencies:z.array(CurrencyStats).length(2),recent:z.array(OwnedDto).max(10)}).strict();
```

GET `/dashboard`, no query/body ->200 Result(DashboardDto). USD then EUR, no combined FX number. Equations, coverage, override precedence, no raw estimates on graded copies and empty-state null behavior are specified in DATA-MODEL. Unknown cost isn't zero. Calculations use integer sums, not floating display conversions.

## Sync

```ts
export const SyncStart = z.object({languages:z.array(Language).min(1).max(2).optional(),
  mode:z.enum(['incremental','refresh']).optional(),resumeId:Id.optional()}).strict();
// resumeId excludes languages/mode; without resume use configured languages and incremental.
export const SyncDto = z.object({id:Id,status:z.enum(['queued','running','cancel_requested','completed','failed','cancelled','interrupted']),
  languages:z.array(Language),mode:z.enum(['incremental','refresh']),attempt:SafeInt,
  setsTotal:SafeInt.nullable(),setsDone:SafeInt,cardsTotal:SafeInt.nullable(),cardsDone:SafeInt,cardsFailed:SafeInt,
  warnings:z.array(z.object({code:z.string(),language:Language,cardId:ProviderId.nullable(),message:z.string()}).strict()).max(100),
  lastError:ErrorResponse.shape.error.nullable(),heartbeatAt:Instant.nullable(),leaseExpiresAt:Instant.nullable(),
  startedAt:Instant.nullable(),finishedAt:Instant.nullable(),createdAt:Instant,updatedAt:Instant}).strict();
```

| Method/path | Input | Success |
|---|---|---|
| POST /sync | SyncStart, `{}` allowed | 202 Result(SyncDto); Location: /api/sync/:id |
| GET /sync | PageQuery | 200 ListResult(SyncDto), createdAt desc,id desc |
| GET /sync/:id | no query | 200 Result(SyncDto) |
| POST /sync/:id/cancel | `{}` only | 202 Result(SyncDto) active; 200 same if already inactive |

Language list distinct, only en/ja. Another active lease ->409 ACTIVE_SYNC; completed resume ->409 INVALID_STATE; launch failure ->503 WORKER_UNAVAILABLE with durable failed status visible via returned job id in error details `{syncId}`. Cancellation is a request, not immediate data rollback. Poll status until terminal. GET never starts workers or clears stale rows. Background API/CLI behavior, fencing/checkpointing and retry guarantees: ARCHITECTURE. Worker errors are status.lastError, not failed HTTP polling. Price failures may warn without failing catalog details; invalid detail fetches fail their units. No remote API call occurs synchronously in GET status.

## Export, import, backup, restore

Multipart requests contain named fields only. Model file input as `z.instanceof(File)` in route environment with server limits enforced while streaming, not just after buffering. Query/body shapes and transfer envelope/report schemas are defined below and in IMPORT-EXPORT; both are normative.

```ts
export const ExportQuery = z.object({format:z.enum(['json','csv'])}).strict();
export const ImportOptions = z.object({format:z.enum(['json','csv']),conflictPolicy:z.enum(['skip','update']).default('skip')}).strict();
export const ImportCommit = z.object({planHash:z.string().regex(/^[a-f0-9]{64}$/),confirm:z.literal(true)}).strict();
export const BackupPreview = z.object({restoreId:Id,backupHash:z.string().regex(/^[a-f0-9]{64}$/),
  expiresAt:Instant,schemaVersion:z.string(),totalCards:SafeInt,customCards:SafeInt,
  collectionRevision:SafeInt,warning:z.string()}).strict();
export const RestoreCommit = z.object({restoreId:Id,backupHash:z.string().regex(/^[a-f0-9]{64}$/),confirm:z.literal('RESTORE')}).strict();
export const RestoreResult = z.object({restored:z.literal(true),totalCards:SafeInt,
  safetyBackupName:z.string(),restartRequired:z.literal(false)}).strict();
```

| Method/path | Query/body | Success |
|---|---|---|
| GET /export | ExportQuery | 200 attachment, application/json or text/csv; filename flashydex-<UTC compact>.json/.csv; contract in IMPORT-EXPORT |
| POST /imports/dry-run | multipart `file`, `format`, `conflictPolicy` (ImportOptions) | 201 Result(ImportReport); Location /api/imports/:id; preview even when valid=false |
| GET /imports/:id | no query | 200 Result(ImportReport); 404 unknown; 410 expired |
| POST /imports/:id/commit | ImportCommit | 200 Result(ImportCommitResult); repeat exact completed token returns same result, never adds copies twice |
| GET /backup | no query/body | 200 application/vnd.sqlite3 attachment flashydex-<UTC compact>.sqlite; completed online snapshot only |
| POST /restore/dry-run | multipart `file` only | 201 Result(BackupPreview); preview current and replacement counts in UI before confirm |
| POST /restore/commit | RestoreCommit | 200 Result(RestoreResult); or maintenance/active/stale/invalid failure |

ImportReport/ImportCommitResult definitions in IMPORT-EXPORT. Import commit validates path/body then looks up an unexpired transactional receipt FIRST: same id/hash returns the stored result even if the original preview expired or collection revision has since changed; different hash returns409 CONFLICT. Only a receipt miss proceeds to preview expiry/revision/precondition checks. Invalid JSON/CSV syntax ->400 VALIDATION_ERROR with byte/row location (no private data echo); well-formed file with invalid rows ->201 valid=false report; commit invalid plan ->422 IMPORT_INVALID. Whole import transactional; policy is only skip or update by stable primary key, never append-for-collision. No arbitrary record delete via import. JSON schema version mismatch ->422 IMPORT_INVALID. Plans expire after 30 minutes; uploaded bytes/plan deleted after expiry, retain only completed result metadata for 24 hours so retries are idempotent. Preview reruns/resolves references from immutable uploaded bytes and computes exact plan; commit never trusts a caller-submitted row plan. Stale personal revision ->409 STALE_PREVIEW, require a new dry-run. Sync may enrich metadata but must not re-resolve an already hashed plan differently; preconditions include catalog reference target integrity (ledger stubs can be inserted if cache disappeared).

Restore preview expires after 10 minutes and binds file hash plus current collectionRevision. Stale revision ->409 STALE_PREVIEW; current sync needs explicit cancel and terminal status before commit. Replacement must have exact supported drizzle migration fingerprint; never run uploaded SQL or auto-downgrade. Invalid backup ->422 BACKUP_INVALID. A successful restore response is generated only after reopening/checking replacement and reading totalCards. Safety backup filename is a basename, not a server path. Commit cannot replay after success (409 INVALID_STATE); user can re-preview the same backup if intentionally restoring again. All import/restore file tokens are random UUIDs bound to private server state, not paths supplied by client.

## Endpoint coverage ownership boundary

No Phase 1 API for camera, recognition, scan-session creation, price scraping, bulk deletion, arbitrary SQL, catalog wipe or public asset upload. No separate Grade endpoint: Grade is a transactional child of owned-card create/PATCH. No separate manual-price endpoint: use manualPrice on owned-card PATCH. No API for changing catalog metadata by hand: use CustomCard. These omissions are intentional, not missing contracts.
