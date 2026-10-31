import { z } from 'zod';
import {
  ArtUrl, Cents, Company, Condition, Currency, DateOnly, Id, Instant, Language, ListResult, Money, Name, Notes, ProviderId, SafeInt, Variant
} from './primitives';

/** Entity / DTO schemas (docs/API.md "Shared response entity schemas"). */

export const gradeFields = {
  company: Company,
  companyLabel: Name.nullable().default(null),
  grade: z.string().trim().min(1).max(16),
  certNumber: z.string().trim().min(1).max(100).nullable().default(null),
  notes: Notes.nullable().default(null)
};
export const GradeInput = z
  .object(gradeFields)
  .strict()
  .refine((g) => (g.company === 'other') === (g.companyLabel !== null), {
    message: "companyLabel is required when company='other' and forbidden otherwise",
    path: ['companyLabel']
  });
export const GradeDto = z.object({ id: Id, ownedCardId: Id, ...gradeFields, createdAt: Instant, updatedAt: Instant }).strict();

export const acquisitionFields = {
  purchasedOn: DateOnly.nullable().default(null),
  source: Name.nullable().default(null),
  notes: Notes.nullable().default(null)
};
export const AcquisitionInput = z.object(acquisitionFields).strict();
export const AcquisitionDto = z
  .object({ id: Id, ...acquisitionFields, createdAt: Instant, updatedAt: Instant, copyCount: SafeInt })
  .strict();

export const namedFields = { name: Name, description: Notes.nullable().default(null) };
export const NamedInput = z.object(namedFields).strict();
export const LocationDto = z.object({ id: Id, ...namedFields, createdAt: Instant, updatedAt: Instant, copyCount: SafeInt }).strict();
export const GroupDto = LocationDto;

export const customFields = {
  name: Name,
  setId: ProviderId.nullable().default(null),
  setName: Name.nullable().default(null),
  localId: z.string().min(1).max(80).nullable().default(null),
  language: Language,
  rarity: z.string().min(1).max(100).nullable().default(null),
  imageUrl: ArtUrl.nullable().default(null),
  notes: Notes.nullable().default(null)
};
export const CustomInput = z.object(customFields).strict();
export const CustomDto = z.object({ id: Id, ...customFields, createdAt: Instant, updatedAt: Instant, copyCount: SafeInt }).strict();

export const PriceDto = z
  .object({
    id: Id,
    catalogCardId: ProviderId,
    language: Language,
    source: z.enum(['tcgplayer', 'cardmarket']),
    variant: Variant,
    variantDetail: z.string().max(120),
    providerVariantKey: ProviderId,
    currency: Currency,
    lowCents: Cents.nullable(),
    midCents: Cents.nullable(),
    highCents: Cents.nullable(),
    marketCents: Cents.nullable(),
    trendCents: Cents.nullable(),
    sourceUpdatedAt: Instant.nullable(),
    capturedAt: Instant
  })
  .strict();
export const ValuationDto = z
  .object({
    currency: Currency,
    cents: Cents,
    source: z.enum(['manual', 'tcgplayer', 'cardmarket']),
    priceSnapshotId: Id.nullable(),
    capturedAt: Instant
  })
  .strict();
export const CardSummary = z
  .object({
    id: ProviderId,
    language: Language,
    name: Name,
    setId: ProviderId,
    setName: Name.nullable(),
    localId: z.string().min(1).max(80),
    rarity: z.string().nullable(),
    imageUrl: ArtUrl.nullable(),
    availableVariants: z.array(Variant),
    detailsComplete: z.boolean(),
    ownedCount: SafeInt,
    /** The set's upstream official card count (read from the installed catalog at read time; null = unknown). */
    setOfficialCount: SafeInt.nullable()
  })
  .strict();
export const OwnedDto = z
  .object({
    id: Id,
    catalogCardId: ProviderId.nullable(),
    customCardId: Id.nullable(),
    name: Name,
    setId: ProviderId.nullable(),
    setName: Name.nullable(),
    localId: z.string().nullable(),
    language: Language,
    rarity: z.string().nullable(),
    imageUrl: ArtUrl.nullable(),
    variant: Variant,
    variantDetail: z.string().max(120),
    condition: Condition.nullable(),
    acquisitionId: Id.nullable(),
    acquisition: AcquisitionDto.nullable(),
    purchasePrice: Money.nullable(),
    storageLocationId: Id.nullable(),
    storageLocationName: Name.nullable(),
    scanSessionId: Id.nullable(),
    notes: Notes.nullable(),
    manualPrice: Money.nullable(),
    grade: GradeDto.nullable(),
    groupIds: z.array(Id),
    duplicateCount: SafeInt,
    valuations: z.array(ValuationDto),
    catalogAvailable: z.boolean(),
    /** Set official count from the installed catalog at read time (never stored in the owned snapshot). */
    setOfficialCount: SafeInt.nullable(),
    createdAt: Instant,
    updatedAt: Instant
  })
  .strict();
export const SetSummary = z
  .object({
    id: ProviderId,
    language: Language,
    name: Name,
    series: z.string().nullable(),
    status: z.enum(['published', 'unpublished']),
    releaseDate: DateOnly.nullable(),
    logoUrl: ArtUrl.nullable(),
    symbolUrl: ArtUrl.nullable(),
    officialCount: SafeInt.nullable(),
    totalCount: SafeInt.nullable(),
    catalogCount: SafeInt,
    catalogComplete: z.boolean(),
    ownedCount: SafeInt,
    customOwnedCount: SafeInt,
    ownedUnique: SafeInt,
    missingCount: SafeInt,
    duplicateExtras: SafeInt,
    completionPercent: z.number().min(0).max(100).nullable()
  })
  .strict();
export const CardDetail = CardSummary.extend({
  category: z.string().nullable(),
  illustrator: z.string().nullable(),
  latestPrices: z.array(PriceDto),
  ownedCopies: ListResult(OwnedDto),
  purchaseHistory: z.array(z.object({ acquisition: AcquisitionDto, purchasePrice: Money.nullable(), ownedCardId: Id }).strict()),
  syncedAt: Instant,
  detailSyncedAt: Instant.nullable()
}).strict();

export const CurrencyStats = z
  .object({
    currency: Currency,
    estimatedValueCents: SafeInt.nullable(),
    pricedCopies: SafeInt,
    totalCopies: SafeInt,
    valuedCopies: SafeInt,
    unvaluedCopies: SafeInt,
    totalPaidCents: SafeInt.nullable(),
    knownCostCopies: SafeInt,
    comparableCopies: SafeInt,
    comparableCostCents: SafeInt.nullable(),
    comparableValueCents: SafeInt.nullable(),
    gainLossCents: z.number().int().min(Number.MIN_SAFE_INTEGER).max(Number.MAX_SAFE_INTEGER).nullable()
  })
  .strict();
export const DashboardDto = z
  .object({
    totalCards: SafeInt,
    totalCopies: SafeInt,
    uniqueCards: SafeInt,
    duplicates: SafeInt,
    displayCurrency: Currency,
    pricedCopies: SafeInt,
    currencies: z.array(CurrencyStats).length(2),
    recent: z.array(OwnedDto).max(10)
  })
  .strict();

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
