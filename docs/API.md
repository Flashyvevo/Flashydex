# FlashyDex — packages/core repository and service interfaces

Scope notice: requested Stage A2 interfaces. Newer BRIEF 2026-10-31 [storage update](COMPRESSION-STORAGE.md) supersedes single-DB install/backup assumptions; Stage A3 must add catalog-pack installation, multi-DB joining, .fdx backup/settings and bounded image-cache contracts. These repository/transfer interfaces are the A2 baseline, not proof that A3 is designed or implemented. See ADR-039.

Normative TypeScript contracts in packages/core, NOT HTTP routes. UI calls these through TanStack Query hooks in apps/mobile/src/data. Core is framework-free, with injected Platform/SqlDriver. Shared strict zod schemas live in packages/schemas/src/{primitives,entities,api,transfer}.ts. [DATA-MODEL](DATA-MODEL.md), [ARCHITECTURE](ARCHITECTURE.md), [IMPORT-EXPORT](IMPORT-EXPORT.md) and [acceptance](PHASE1-ACCEPTANCE.md) are binding. No app code is implemented by this document.

## Conventions, errors, paging

Methods resolve directly to DTOs or Page<T> (not HTTP response envelopes). Page<T> = {data:T[],page:{offset,limit,total,hasMore}}; total is filtered row count (groups if groupBy:'card', copies otherwise), hasMore=offset+data.length<total. Default30/max50, stable identity/id ties. Reset page after filter/mutation. All inputs strict zod; actual numbers/booleans, not URL strings. Read methods never mutate or fetch provider data. Nullable response fields are present as null. Successful mutation means native SQLite commit or web commit+saveToStore, not optimistic UI alone.

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
export const PageQuery = z.object({offset:z.number().int().min(0).max(10000000).default(0),
  limit:z.number().int().min(1).max(50).default(30)}).strict();
export const Empty = z.object({}).strict();
export const ById = z.object({id:Id}).strict();
export const SetKey = z.object({language:Language,setId:ProviderId}).strict();
export const CardKey = z.object({language:Language,cardId:ProviderId}).strict();
export const Hash = z.string().regex(/^[a-f0-9]{64}$/);
export const BoolQuery = z.boolean(); // Historical schema name, actual boolean input now.
type Input<S extends z.ZodTypeAny> = z.input<S>;
type Page<T> = {data:T[];page:{offset:number;limit:number;total:number;hasMore:boolean}};
export const PageMeta = z.object({offset:SafeInt,limit:z.number().int().min(1).max(50),total:SafeInt,hasMore:z.boolean()}).strict();
export const Result = <S extends z.ZodTypeAny>(schema:S) => z.object({data:schema}).strict();
export const ListResult = <S extends z.ZodTypeAny>(schema:S) => z.object({data:z.array(schema),page:PageMeta}).strict();
export const ErrorResponse = z.object({error:z.object({
  code:z.string(),message:z.string(),details:z.unknown().optional(),
}).strict()}).strict();
```

URL alias parsing belongs to UI hooks, not core coercion. Validate identifiers exactly before lookup, never repair UUIDs/provider tokens. Public methods throw DomainError extends Error with readonly code/message/details?. Safe details only, no SQL/stack/paths/private notes/certificates/tokens. ErrorResponse is an optional UI serialization shape, NOT an HTTP response.

| Class | code(s) / meaning |
|---|---|
| ValidationError | VALIDATION_ERROR; sorted `{path,code,message}` issues |
| NotFoundError | NOT_FOUND; entity/id, includes missing parent |
| InUseError | IN_USE; dependentCount |
| ConflictError | CONFLICT; normalized name/ID/hash collision |
| StalePreviewError | STALE_PREVIEW; expectedRevision/actualRevision |
| PreviewExpiredError | PREVIEW_EXPIRED |
| InvalidStateError | INVALID_STATE |
| ActiveWorkError | ACTIVE_SYNC / ACTIVE_WORK |
| ImportError | IMPORT_INVALID / INVALID_JSON / INVALID_CSV |
| BackupError | BACKUP_INVALID |
| SizeLimitError | PAYLOAD_TOO_LARGE |
| StorageError | DB_BUSY / STORAGE_FULL / DB_UNAVAILABLE / MIGRATION_FAILED |
| PersistenceError | PERSISTENCE_FAILED; in-memory commit may exceed durable state |
| MaintenanceError | MAINTENANCE |
| PlatformError | PLATFORM_UNAVAILABLE / FILE_IO / SHARE_FAILED / HTTP_FAILED |
| UnsupportedCapabilityError | UNSUPPORTED_CAPABILITY |
| CancelledError | CANCELLED; never claims committed copy rollback |

EVERY method below may throw ValidationError, StorageError, PersistenceError, MaintenanceError; method tables name ADDITIONAL errors. Unexpected internal error sanitized to INTERNAL_ERROR. DB_BUSY after bounded5s, not an HTTP Retry-After. Missing delete target ->NotFoundError, except documented membership no-op. Every mutation resolves after native commit/web flush. On uncertain persistence reopen/refetch before user retry; don't auto-retry bulk add.

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
  status:z.enum(['published','unpublished']),
  releaseDate:DateOnly.nullable(),logoUrl:ArtUrl.nullable(),symbolUrl:ArtUrl.nullable(),
  officialCount:SafeInt.nullable(),totalCount:SafeInt.nullable(),catalogCount:SafeInt,catalogComplete:z.boolean(),
  ownedCount:SafeInt,customOwnedCount:SafeInt,ownedUnique:SafeInt,missingCount:SafeInt,
  duplicateExtras:SafeInt,completionPercent:z.number().min(0).max(100).nullable()}).strict();
```

Grade refinements are on final input schemas rather than ZodEffects prior to `.shape` composition. Nullable empty optional text is normalized as DATA-MODEL states. Every response computed nullable field is present, not omitted. Ordered groupIds lexicographic; availableVariants in canonical enum order; valuations USD then EUR. For manual valuation capturedAt is OwnedCard.updatedAt (copy edit timestamp, not marketplace time).

## CatalogRepo

```ts
export const SetListQuery = PageQuery.extend({language:Language.optional(),q:z.string().trim().max(100).optional(),
  status:z.enum(['published','unpublished','all']).default('published'),hideTcgPocket:z.boolean().optional(),
  owned:z.boolean().optional(),sort:z.enum(['release_desc','name_asc','completion_desc']).default('release_desc')}).strict();
export const SetCardsQuery = PageQuery.extend({...SetKey.shape,
  ownership:z.enum(['all','owned','missing']).default('all'),duplicates:z.boolean().optional()}).strict();
export const CardSearchQuery = PageQuery.extend({q:z.string().trim().max(100).optional(),setId:ProviderId.optional(),
  localId:z.string().min(1).max(80).optional(),language:Language.optional(),rarity:z.string().min(1).max(100).optional(),
  match:z.enum(['prefix','contains']).default('prefix'),hideTcgPocket:z.boolean().optional()}).strict();
export const CardDetailQuery = PageQuery.extend({...CardKey.shape}).strict();
export const CardDetail = CardSummary.extend({category:z.string().nullable(),illustrator:z.string().nullable(),
  latestPrices:z.array(PriceDto),ownedCopies:ListResult(OwnedDto),
  purchaseHistory:z.array(z.object({acquisition:AcquisitionDto,purchasePrice:Money.nullable(),ownedCardId:Id}).strict()),
  syncedAt:Instant,detailSyncedAt:Instant.nullable()}).strict();
// DTO value/type namespaces intentionally share names; no hand-maintained duplicate shape.
export type GradeDto = z.infer<typeof GradeDto>;
export type AcquisitionDto = z.infer<typeof AcquisitionDto>;
export type LocationDto = z.infer<typeof LocationDto>;
export type GroupDto = z.infer<typeof GroupDto>;
export type CustomDto = z.infer<typeof CustomDto>;
export type PriceDto = z.infer<typeof PriceDto>;
export type ValuationDto = z.infer<typeof ValuationDto>;
export type CardSummary = z.infer<typeof CardSummary>;
export type OwnedDto = z.infer<typeof OwnedDto>;
export type SetSummary = z.infer<typeof SetSummary>;
export type CardDetail = z.infer<typeof CardDetail>;
export type CurrencyStats = z.infer<typeof CurrencyStats>;
export type DashboardDto = z.infer<typeof DashboardDto>;
// ImportReport/ImportCommitResult are imported types from transfer.ts, not redeclared here.
interface CatalogRepo {
  listSets(input:Input<typeof SetListQuery>):Promise<Page<SetSummary>>;
  getSet(input:Input<typeof SetKey>):Promise<SetSummary & {missingPreview:CardSummary[]}>;
  listSetCards(input:Input<typeof SetCardsQuery>):Promise<Page<CardSummary>>;
  searchCards(input:Input<typeof CardSearchQuery>):Promise<Page<CardSummary>>;
  getCard(input:Input<typeof CardDetailQuery>):Promise<CardDetail>;
}
```

| Method | Additional errors | Notes |
|---|---|---|
| listSets | none | published default, hideTcgPocket defaults AppSettings, excludes known series tcgp. owned true/false ->ownedCount>0/=0. release DESC null-last,language,id; nameSearch ASC,language,id; completion DESC null-last,language,id. |
| getSet | NotFoundError | Missing preview max20/localIdSort,id; unpublished exact lookup allowed, no false completion. |
| listSetCards | NotFoundError | Active manifest only, localIdSort/id. Missing=no owned identity in any variant; duplicate eligibility precise variant/detail groups. |
| searchCards | none | Local normalized escaped name prefix/contains, exact set/localId/language/rarity AND. Rank exact/prefix/contains then nameSearch,language,id; no remote fallback. |
| getCard | NotFoundError | Owned copy page<=50 createdAt/id DESC; purchaseHistory only returned page's non-null events, date DESC null-last,id. Prices latest per source/variant/detail/currency/providerVariantKey. Missing metadata doesn't hide owned snapshot. |

LIKE escapes %, _ and backslash; localId literal ('001'!='1'), no silent padding/slash parsing/ID repair. Empty shells hidden/rechecked on sync; official0 shows localId alone. series=provider serie.id. Completion/missing use DATA-MODEL active manifest, never advertised counts as cached rows. RawJson not exposed as uncontrolled DTO.

## CollectionRepo

```ts
export const AcquisitionLink = z.union([z.object({id:Id}).strict(),z.object({create:AcquisitionInput}).strict()]);
export const OwnedCreate = z.object({language:Language,catalogCardId:ProviderId.optional(),customCardId:Id.optional(),
  variant:Variant,variantDetail:z.string().trim().max(120).default(''),condition:Condition.nullable().default(null),
  purchasePrice:Money.nullable().default(null),acquisition:AcquisitionLink.nullable().default(null),
  storageLocationId:Id.nullable().default(null),notes:Notes.nullable().default(null),manualPrice:Money.nullable().default(null),
  grade:GradeInput.nullable().default(null),groupIds:z.array(Id).max(100).default([])}).strict();
export const OwnedPatch = z.object({variant:Variant.optional(),variantDetail:z.string().trim().max(120).optional(),
  condition:Condition.nullable().optional(),purchasePrice:Money.nullable().optional(),acquisitionId:Id.nullable().optional(),
  storageLocationId:Id.nullable().optional(),notes:Notes.nullable().optional(),manualPrice:Money.nullable().optional(),
  grade:GradeInput.nullable().optional(),groupIds:z.array(Id).max(100).optional()}).strict();
export const OwnedListQuery = PageQuery.extend({groupBy:z.enum(['card','copy']).default('card'),
  q:z.string().trim().max(100).optional(),localId:z.string().min(1).max(80).optional(),setId:ProviderId.optional(),
  rarity:z.string().min(1).max(100).optional(),language:Language.optional(),
  condition:z.enum(['NM','LP','MP','HP','DMG','unknown']).optional(),grading:z.enum(['raw','graded']).optional(),
  duplicates:z.boolean().optional(),storageLocationId:z.union([Id,z.literal('none')]).optional(),groupId:Id.optional(),
  variant:Variant.optional(),acquisitionId:Id.optional(),priced:z.enum(['none','some']).optional(),
  currency:Currency.optional(),hideTcgPocket:z.boolean().optional(),
  sort:z.enum(['created_desc','name_asc','set_asc','count_desc','value_desc','value_asc']).default('created_desc')}).strict();
export const BulkAdd = z.object({quantity:z.number().int().min(1).max(100),copy:OwnedCreate}).strict();
export const OwnedUpdate = z.object({id:Id,patch:OwnedPatch}).strict();
export const NamedQuery = PageQuery.extend({q:z.string().trim().max(100).optional()}).strict();
export const CustomQuery = NamedQuery.extend({language:Language.optional()}).strict();
export const AcquisitionQuery = PageQuery.extend({source:z.string().max(200).optional(),from:DateOnly.optional(),to:DateOnly.optional()}).strict();
export const AcquisitionPatch = z.object({purchasedOn:DateOnly.nullable().optional(),source:Name.nullable().optional(),notes:Notes.nullable().optional()}).strict();
export const NamedPatch = z.object({name:Name.optional(),description:Notes.nullable().optional()}).strict();
export const CustomPatch = CustomInput.partial().strict();
export const AcquisitionUpdate = z.object({id:Id,patch:AcquisitionPatch}).strict();
export const NamedUpdate = z.object({id:Id,patch:NamedPatch}).strict();
export const CustomUpdate = z.object({id:Id,patch:CustomPatch}).strict();
export const MembersInput = z.object({id:Id,ownedCardIds:z.array(Id).min(1).max(100)}).strict();
type CollectionCardGroup = {source:'catalog'|'custom';language:z.infer<typeof Language>;cardId:string;
  variant:z.infer<typeof Variant>;qty:number;copyIds:string[];totalQty:number;allCopyIds:string[];representative:OwnedDto;
  variantDetails:Array<{variantDetail:string;qty:number}>;
  conditions:Array<{condition:z.infer<typeof Condition>|null;qty:number}>;grading:{raw:number;graded:number}};
interface CollectionRepo {
  list(input:Input<typeof OwnedListQuery> & {groupBy:'copy'}):Promise<Page<OwnedDto>>;
  list(input:Input<typeof OwnedListQuery> & {groupBy?:'card'}):Promise<Page<CollectionCardGroup>>;
  getCopy(input:Input<typeof ById>):Promise<OwnedDto>;
  add(input:Input<typeof OwnedCreate>):Promise<OwnedDto>;
  bulkAdd(input:Input<typeof BulkAdd>):Promise<{created:number;copies:OwnedDto[]}>;
  update(input:Input<typeof OwnedUpdate>):Promise<OwnedDto>;
  remove(input:Input<typeof ById>):Promise<void>;
  listAcquisitions(input:Input<typeof AcquisitionQuery>):Promise<Page<AcquisitionDto>>;
  getAcquisition(input:Input<typeof ById>):Promise<AcquisitionDto>;
  createAcquisition(input:Input<typeof AcquisitionInput>):Promise<AcquisitionDto>;
  updateAcquisition(input:Input<typeof AcquisitionUpdate>):Promise<AcquisitionDto>;
  removeAcquisition(input:Input<typeof ById>):Promise<void>;
  listLocations(input:Input<typeof NamedQuery>):Promise<Page<LocationDto>>;
  getLocation(input:Input<typeof ById>):Promise<LocationDto>;
  createLocation(input:Input<typeof NamedInput>):Promise<LocationDto>;
  updateLocation(input:Input<typeof NamedUpdate>):Promise<LocationDto>;
  removeLocation(input:Input<typeof ById>):Promise<void>;
  listGroups(input:Input<typeof NamedQuery>):Promise<Page<GroupDto>>;
  getGroup(input:Input<typeof ById>):Promise<GroupDto>;
  createGroup(input:Input<typeof NamedInput>):Promise<GroupDto>;
  updateGroup(input:Input<typeof NamedUpdate>):Promise<GroupDto>;
  removeGroup(input:Input<typeof ById>):Promise<void>;
  addMembers(input:Input<typeof MembersInput>):Promise<GroupDto>;
  removeMembers(input:Input<typeof MembersInput>):Promise<GroupDto>;
  listCustom(input:Input<typeof CustomQuery>):Promise<Page<CustomDto>>;
  getCustom(input:Input<typeof ById>):Promise<CustomDto>;
  createCustom(input:Input<typeof CustomInput>):Promise<CustomDto>;
  updateCustom(input:Input<typeof CustomUpdate>):Promise<CustomDto>;
  removeCustom(input:Input<typeof ById>):Promise<void>;
}
```

Service refinements mandatory: exactly one catalog/custom source; unique group/member IDs; grade company=other iff label nonnull; variant/detail per DATA-MODEL qualified-print mapping; PATCH>=1 supplied field and merged state valid; from<=to; real parent refs/language match. Explicit null clears, omission preserves. Ordinary update cannot change identity/snapshot/audit fields. No assumed variant/condition. Bulk quantity>1 with grade cert rejected; cents PER COPY; one shared acquisition.create; copies/grade/members/revision atomic.

BINDING owner ruling: groupBy:'card' gives one row per (language,cardId,variant), with source discriminator so custom UUID and catalog ID cannot collide. variantDetail subgroups do not split top-level tiles. Compute precise duplicates over identity+variant+detail across WHOLE collection first; apply filters to copies THEN group/page, never collapse one paged copy list. qty/copyIds describe matching copies; totalQty/allCopyIds entire group. ID arrays complete, distinct UUID ASC; representative newest matching createdAt/id; summaries matching copies. Single huge group may contain many IDs but only one full OwnedDto; chunk ID projection, don't truncate or render all editors. Detail copies stay paginated. Dashboard precise unique/duplicates remain DATA-MODEL, not tile count.

Filters AND: q normalized snapshot-name contains, localId exact, set, rarity, language, condition unknown=null, raw/graded=Grade absence/presence, duplicates precise count>1/=1, storage none=null, group, variant, acquisition. priced none/some = no/one effective quote in currency (default AppSettings); USD absent+EUR present remains no-USD, zero counts priced. hideTcgPocket defaults settings, excludes known catalog_sets.series='tcgp'; custom/unknown-series/missing-cache snapshots remain visible, never guessed/deleted. Does not filter dashboard/export/backup totals.

Sort created representative DESC/id; name nameSearch ASC/id; set language,setId null-last,localId text,id; count_desc group qty DESC then identity (reject groupBy:copy); value sum of KNOWN matching-copy values in currency, null-last BOTH directions, identity ties. Partially valued groups remain partial, never price missing copies as0. Copy-mode value sorts individual effective value. Stable group tie source/language/cardId/variant; grade/condition/storage don't split precise duplicates.

| Methods | Additional errors | Notes |
|---|---|---|
| list | none | Above grouping/filter/paging, no network. |
| getCopy | NotFoundError | Snapshot-safe after catalog wipe. |
| add, bulkAdd | NotFoundError | Catalog source requires local metadata; offline absent ->sync/custom, import may use ledger stub. All-or-nothing refs. |
| update | NotFoundError | Grade replacement retains UUID; grade:null deletes; manualPrice:null clears money pair; groupIds replaces membership transactionally. |
| remove | NotFoundError | Exact copy + grade/members, not event/definition/other copies. UI confirmation. |
| listAcquisitions | none | purchasedOn DESC null-last,id; source contains/date bounds inclusive, unknown excluded by bound. |
| getAcquisition, updateAcquisition | NotFoundError | Event edit affects shared date/source, not per-copy cents. |
| createAcquisition | none | No implicit lot cost split. |
| removeAcquisition | NotFoundError, InUseError | Referenced history protected. |
| listLocations, listGroups | none | nameKey/id ASC, normalized literal q. |
| getLocation, getGroup | NotFoundError | copyCount used for confirm. |
| createLocation, createGroup | ConflictError | Normalized unique names. |
| updateLocation, updateGroup | NotFoundError, ConflictError | Empty patches invalid, no silent merge. |
| removeLocation | NotFoundError | Clears copy storage references, no deleted copies, revision once. |
| removeGroup | NotFoundError | Removes membership, not copies. |
| addMembers, removeMembers | NotFoundError | Existing/absent membership no-op, all specified parent/copy IDs must exist. |
| listCustom | none | nameSearch/id ASC; explicit language. |
| getCustom | NotFoundError | Definition +copyCount, not implicit owned copy. |
| createCustom | none | Same name permitted; no catalog auto-merge. |
| updateCustom | NotFoundError, ConflictError | Referenced language immutable; definition edits never rewrite copy snapshots. |
| removeCustom | NotFoundError, InUseError | Protected when referenced. |

## PortfolioService

```ts
export const DashboardInput = z.object({currency:Currency.optional()}).strict();
export const CurrencyStats = z.object({currency:Currency,estimatedValueCents:SafeInt.nullable(),
  pricedCopies:SafeInt,totalCopies:SafeInt,valuedCopies:SafeInt,unvaluedCopies:SafeInt,
  totalPaidCents:SafeInt.nullable(),knownCostCopies:SafeInt,comparableCopies:SafeInt,
  comparableCostCents:SafeInt.nullable(),comparableValueCents:SafeInt.nullable(),gainLossCents:SignedSafeInt.nullable()}).strict();
export const DashboardDto = z.object({totalCards:SafeInt,totalCopies:SafeInt,uniqueCards:SafeInt,duplicates:SafeInt,
  displayCurrency:Currency,pricedCopies:SafeInt,currencies:z.array(CurrencyStats).length(2),recent:z.array(OwnedDto).max(10)}).strict();
interface PortfolioService { dashboard(input:Input<typeof DashboardInput>):Promise<DashboardDto>; }
```

Common errors only. totalCards=totalCopies=count owned; whole collection, no hidden Pocket/filter exclusions. Top pricedCopies = chosen display currency (settings default), label “pricedCopies of totalCopies copies priced”. Each bucket pricedCopies=valuedCopies, unvaluedCopies=totalCopies-pricedCopies. USD then EUR, never sum/convert. DATA-MODEL equations binding: manual wins, graded without override unvalued, raw USD market->mid->null, EUR avg(mid)->null, no low/trend/variant fallback. Empty/all-unknown money null, coverage0; true zero priced. Paid known amounts, comparable gain/loss only known price/cost same currency, not misleading full portfolio gain. Safe-int sum guards. Recent10 by createdAt/id DESC, preserve imported historical timestamps.

## SyncService

```ts
export const Selection = z.discriminatedUnion('scope',[
  z.object({scope:z.literal('all'),sets:z.array(SetKey).max(0)}).strict(),
  z.object({scope:z.literal('followed'),sets:z.array(SetKey).min(1).max(1000)}).strict(),
]);
export const SyncStart = z.object({languages:z.array(Language).min(1).max(2).optional(),selection:Selection.optional(),
  mode:z.enum(['incremental','refresh','prices_only']).default('incremental')}).strict();
type SyncDto = {id:string;status:'queued'|'running'|'cancel_requested'|'completed'|'failed'|'cancelled'|'interrupted';
  languages:z.infer<typeof Language>[];selection:z.infer<typeof Selection>;mode:'incremental'|'refresh'|'prices_only';attempt:number;
  setsTotal:number|null;setsDone:number;cardsTotal:number|null;cardsDone:number;cardsFailed:number;
  sets:Array<{language:z.infer<typeof Language>;setId:string;status:'pending'|'running'|'done'|'failed'|'unpublished';
    cardsTotal:number|null;cardsDone:number;cardsFailed:number}>;
  warnings:Array<{code:string;language:z.infer<typeof Language>;cardId:string|null;message:string}>;
  lastError:{code:string;message:string;details?:unknown}|null;heartbeatAt:string|null;leaseExpiresAt:string|null;
  startedAt:string|null;finishedAt:string|null;createdAt:string;updatedAt:string};
interface SyncService {
  start(input:Input<typeof SyncStart>):Promise<SyncDto>;
  list(input:Input<typeof PageQuery>):Promise<Page<SyncDto>>;
  get(input:Input<typeof ById>):Promise<SyncDto>;
  cancel(input:Input<typeof ById>):Promise<SyncDto>;
  resume(input:Input<typeof ById>):Promise<SyncDto>;
}
```

| Method | Additional errors | Notes |
|---|---|---|
| start | ActiveWorkError, PlatformError | Defaults Settings selection/languages; distinct keys, selected languages match; nonempty sets unless all. Durable queued run then foreground app engine; resolves promptly, not after crawl. Launch failure durable failed. |
| list | none | createdAt/id DESC; no network/recovery side effect. |
| get | NotFoundError | Summary per-set counters/max100 warnings, never tokens/full card checkpoint. |
| cancel | NotFoundError | Active ->cancel_requested, inactive idempotent; committed catalog retained. |
| resume | NotFoundError, ActiveWorkError, InvalidStateError | Same UUID/frozen selection, new token/attempt; completed cannot resume. |

ARCHITECTURE retry/fencing/foreground/ETag rules binding. Read polls don't reject for crawl errors; errors stored lastError/failed units. Startup explicitly recovers interrupted jobs; get/list don't mutate. Navigation continues, suspend/tab-close/OS-kill do NOT promise progress. Native HTTP cancellation means stop scheduling/discard late responses, no guaranteed abort. prices_only writes PriceSnapshot+operational progress only, not catalog/owned. DATA-MODEL checkpoint v2.

## SettingsRepo

```ts
export const SettingsPatch = z.object({languages:z.array(Language).min(1).max(2).optional(),
  setsFollowed:z.array(SetKey).max(1000).optional(),syncAllSets:z.boolean().optional(),hideTcgPocket:z.boolean().optional(),
  defaultCurrency:Currency.optional(),disclaimerAcknowledged:z.boolean().optional(),onboardingCompleted:z.boolean().optional()}).strict();
type AppSettings = {languages:z.infer<typeof Language>[];setsFollowed:z.infer<typeof SetKey>[];syncAllSets:boolean;
  hideTcgPocket:boolean;defaultCurrency:z.infer<typeof Currency>;disclaimerAcknowledged:boolean;
  disclaimerAcknowledgedAt:string|null;onboardingCompletedAt:string|null;updatedAt:string};
interface SettingsRepo {
  get(input:Input<typeof Empty>):Promise<AppSettings>;
  update(input:Input<typeof SettingsPatch>):Promise<AppSettings>;
}
```

Common errors only. update>=1 field; distinct languages/keys, merged validity; removing language requires explicitly removing its followed sets. Defaults DATA-MODEL: en+ja selected, no followed sets, all=false, hide Pocket=true, USD, unacknowledged/not-onboarded. Empty preference valid, start sync requires selection. Ack/onboarding times generated by clock, clear resets null. Durable independent settings, no collectionRevision increment/import invalidation. Disclaimer/privacy readable before acknowledgement/offline.

## Platform adapter

```ts
type FileRef = {id:string;name:string;mime:string;size:number}; // Opaque app-private registry entry, NOT path.
export const FileRefSchema = z.object({id:Id,name:z.string().min(1).max(200),mime:z.string().max(100),size:SafeInt}).strict();
export const PickInput = z.object({kind:z.enum(['transfer','database']),maxBytes:SafeInt}).strict();
export const ReadInput = z.object({file:FileRefSchema,maxBytes:SafeInt}).strict();
export const WriteInput = z.object({name:z.string().regex(/^flashydex-[a-zA-Z0-9._-]+$/).max(200),mime:z.string().max(100),
  bytes:z.instanceof(Uint8Array),area:z.enum(['staging','exports'])}).strict();
export const RemoveFileInput = z.object({file:FileRefSchema}).strict();
export const ShareInput = z.object({files:z.array(FileRefSchema).min(1).max(2),title:Name}).strict();
export const HapticInput = z.object({kind:z.enum(['selection','success','error'])}).strict();
export const HttpInput = z.object({url:z.string().url(),method:z.literal('GET'),headers:z.record(z.string(),z.string()),
  timeoutMs:z.number().int().min(1).max(60000)}).strict();
interface Platform {
  filesystem:{
    pick(input:Input<typeof PickInput>):Promise<FileRef|null>;
    read(input:Input<typeof ReadInput>):Promise<Uint8Array>;
    write(input:Input<typeof WriteInput>):Promise<FileRef>;
    remove(input:Input<typeof RemoveFileInput>):Promise<void>;
  };
  share(input:Input<typeof ShareInput>):Promise<{outcome:'shared'|'downloaded'|'cancelled'}>;
  haptics(input:Input<typeof HapticInput>):Promise<void>;
  http(input:Input<typeof HttpInput>,signal?:AbortSignal):Promise<{status:number;headers:Record<string,string>;body:unknown}>;
  clock:{now():string}; ids:{uuid():string}; hash:{sha256(bytes:Uint8Array):Promise<string>};
}
```

Platform methods errors: ValidationError, PlatformError, SizeLimitError, CancelledError; absent picker selection returns null, no mutation. Registry verifies FileRef id/real size, never trusts supplied metadata. clock.now input Empty/output Instant; ids.uuid Empty/Id; hash.sha256 input z.instanceof(Uint8Array)/output Hash. AbortSignal is nonpersisted execution control. Core never imports Capacitor/DOM/Node APIs.

Native staging persistent private files; generated exports Filesystem cache writeFile UTF8/chunked binary, getUri ->Share files. Android cache-share restriction respected. Web picker File->bytes adapter; private staging IndexedDB (OPFS only if available/tested); Blob/objectURL download+revoke, no guarantee Web Share exists. No full collection in localStorage. Imported filenames can't become paths. Haptics best effort postcommit (unsupported web no-op).

HTTP GET HTTPS TCGdex allowlist, explicit CapacitorHttp native/fetch web, lowercase headers,304 no body. Native signal cancellation best-effort discard, not guaranteed network abort; web AbortController. Inject fixed response/file/clock/id fakes in core tests. Separate internal SqlDriver/DatabaseFiles capabilities own SQL/raw-copy operations; no public arbitrary SQL to UI.

## TransferService / BackupService

```ts
export const ExportInput = z.object({format:z.enum(['json','csv'])}).strict();
export const ImportOptions = z.object({format:z.enum(['json','csv']),conflictPolicy:z.enum(['skip','update']).default('skip')}).strict();
export const ImportDryRun = ImportOptions.extend({file:FileRefSchema}).strict();
export const ImportCommit = z.object({id:Id,planHash:Hash,confirm:z.literal(true)}).strict();
export const BackupCreate = z.object({includeRawDatabase:z.boolean().default(true)}).strict();
export const RestoreDryRun = z.object({file:FileRefSchema}).strict();
export const RestoreCommit = z.object({id:Id,backupHash:Hash,confirm:z.literal('RESTORE')}).strict();
type ExportFile = {file:FileRef;format:'json'|'csv';warnings:string[]};
type BackupCapabilities = {rawCopy:boolean;rawRestore:boolean;reason:string|null};
type BackupResult = {json:FileRef;database:FileRef|null;warnings:string[]};
type BackupPreview = {id:string;backupHash:string;expiresAt:string;schemaFingerprint:string;totalCards:number;
  customCards:number;collectionRevision:number;warning:string};
type RestoreResult = {restored:true;totalCards:number;safetyBackupName:string;restartRequired:false};
// ImportReport/ImportCommitResult = exact zod inference from IMPORT-EXPORT.md.
interface TransferService {
  exportFile(input:Input<typeof ExportInput>):Promise<ExportFile>;
  shareExport(input:Input<typeof ShareInput>):Promise<{outcome:'shared'|'downloaded'|'cancelled'}>;
  dryRun(input:Input<typeof ImportDryRun>):Promise<ImportReport>;
  getImport(input:Input<typeof ById>):Promise<ImportReport>;
  commit(input:Input<typeof ImportCommit>):Promise<ImportCommitResult>;
}
interface BackupService {
  capabilities(input:Input<typeof Empty>):Promise<BackupCapabilities>;
  create(input:Input<typeof BackupCreate>):Promise<BackupResult>;
  previewRestore(input:Input<typeof RestoreDryRun>):Promise<BackupPreview>;
  restore(input:Input<typeof RestoreCommit>):Promise<RestoreResult>;
}
```

| Method | Additional errors | Notes |
|---|---|---|
| exportFile | PlatformError, SizeLimitError | Consistent local snapshot ->UTF8 JSON/CSV private file, flashydex-<UTC compact>.json/.csv; no HTTP response. |
| shareExport | PlatformError, CancelledError | Native Share via Filesystem URI/web Blob. Cancel separately, never claim external save guaranteed. |
| dryRun | ImportError, PlatformError, SizeLimitError | <=25MiB before parse,100k copies/250k total entities; zero DB writes, immutable locally persisted plan/hash/default IDs. Well-formed invalid rows ->valid=false report, invalid syntax throws. |
| getImport | NotFoundError, PreviewExpiredError | Local staging or committed receipt metadata; preview30min. |
| commit | NotFoundError, ImportError, StalePreviewError, PreviewExpiredError, ConflictError | Receipt FIRST same UUID/hash returns prior result for24h even expired preview/current revision changed. Otherwise verify file/plan/revision/expiry/validity/refs, whole transaction+receipt/revision once. |
| capabilities | PlatformError | Probe actual raw-copy/restore support, never optimistic defaults. |
| create | PlatformError, ActiveWorkError, BackupError, SizeLimitError | JSON always. Unsupported raw requested ->database:null+warning, not fake DB. Supported: quiesce/checkpoint/close/copy/reopen/integrity+FK validate before result. |
| previewRestore | UnsupportedCapabilityError, BackupError, PlatformError, SizeLimitError | Raw <=512MiB, isolated validation exact schema_migrations fingerprint;10min hash/revision preview. No SQL/plugin-JSON execution. |
| restore | UnsupportedCapabilityError, NotFoundError, BackupError, PreviewExpiredError, StalePreviewError, ActiveWorkError, InvalidStateError, PlatformError | RESTORE; fence/drain/close handles, verified safety backup, same-volume swap/recovery marker, reopen/integrity/FKs/read count before result. Failure reopens prior file; consumed token cannot replay. |

Portable JSON backup/import is merge/update, not deletion of absent copies. Raw replacement only where tested; unsupported capability doesn't remove JSON backup. Plugin exportToJson/importFromJson is a DIFFERENT schema, never substitute for CollectionExportV1. No native better-sqlite3 online backup assumption. User share/download outcome is reported honestly. BackupService optional authenticated server mirror is Phase7 seam only, no remote backup now.

## UX mapping and intentional omissions

All screen routes remain ARCHITECTURE/UX URLs. Accepted R1 grouped grid (no per-copy fallback), R2 localId, R3 value/count sorts, R5 collecting/completion, R6 known Pocket, R7 no-price. Set-code/abbreviation R4 and recognition manifest R8/R9 remain follow-up, no new Phase1 scanner work. Aliases priced=none|some / pocket=1 map to typed priced/hideTcgPocket; no stale app HTTP calls. Form condition default unknown, not assumed NM. Undo bulk add calls remove per returned ID and must show any partial failure (no atomic multi-delete promised).

No camera/scan create, price scraping, arbitrary SQL/catalog wipe/update, public upload or remote backup implementation in Phase1. Grade/manual price mutate only with copy. Read/write tests must assert durable state, not HTTP status.
