import { z } from 'zod';

/** Strict primitives shared by every contract (docs/API.md "Conventions"). */
export const Id = z.string().uuid();
export const ProviderId = z.string().min(1).max(200);
export const Language = z.enum(['en', 'ja']);
export const Variant = z.enum(['normal', 'holo', 'reverse_holo', 'first_edition', 'promo_stamped', 'shadowless', 'other']);
export const Condition = z.enum(['NM', 'LP', 'MP', 'HP', 'DMG']);
export const Company = z.enum(['PSA', 'BGS', 'CGC', 'SGC', 'ACE', 'TAG', 'other']);
export const Currency = z.enum(['USD', 'EUR']);
export const Cents = z.number().int().min(0).max(2147483647);
export const SafeInt = z.number().int().min(0).max(Number.MAX_SAFE_INTEGER);
export const SignedSafeInt = z.number().int().min(Number.MIN_SAFE_INTEGER).max(Number.MAX_SAFE_INTEGER);
export const Instant = z
  .string()
  .datetime({ offset: false })
  .refine((v) => /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/.test(v), 'Canonical UTC timestamp required');
export const DateOnly = z
  .string()
  .regex(/^\d{4}-\d{2}-\d{2}$/)
  .refine((value) => {
    const [year, month, day] = value.split('-').map(Number) as [number, number, number];
    const date = new Date(0);
    date.setUTCFullYear(year, month - 1, day);
    return date.getUTCFullYear() === year && date.getUTCMonth() === month - 1 && date.getUTCDate() === day;
  }, 'Invalid calendar date');
export const Name = z.string().trim().min(1).max(200);
export const Notes = z.string().max(5000);
export const ArtUrl = z
  .string()
  .url()
  .max(2048)
  .refine((v) => URL.canParse(v) && ['https:', 'http:'].includes(new URL(v).protocol), 'http(s) URL required');
export const Money = z.object({ cents: Cents, currency: Currency }).strict();
export const PageQuery = z
  .object({ offset: z.number().int().min(0).max(10000000).default(0), limit: z.number().int().min(1).max(50).default(30) })
  .strict();
export const Empty = z.object({}).strict();
export const ById = z.object({ id: Id }).strict();
export const SetKey = z.object({ language: Language, setId: ProviderId }).strict();
export const CardKey = z.object({ language: Language, cardId: ProviderId }).strict();
export const Hash = z.string().regex(/^[a-f0-9]{64}$/);
export const BoolQuery = z.boolean();
export const PageMeta = z.object({ offset: SafeInt, limit: z.number().int().min(1).max(50), total: SafeInt, hasMore: z.boolean() }).strict();
export const Result = <S extends z.ZodType>(schema: S) => z.object({ data: schema }).strict();
export const ListResult = <S extends z.ZodType>(schema: S) => z.object({ data: z.array(schema), page: PageMeta }).strict();
export const ErrorResponse = z
  .object({ error: z.object({ code: z.string(), message: z.string(), details: z.unknown().optional() }).strict() })
  .strict();

export type Page<T> = { data: T[]; page: { offset: number; limit: number; total: number; hasMore: boolean } };
export type Input<S extends z.ZodType> = z.input<S>;

export type Id = z.infer<typeof Id>;
export type ProviderId = z.infer<typeof ProviderId>;
export type Language = z.infer<typeof Language>;
export type Variant = z.infer<typeof Variant>;
export type Condition = z.infer<typeof Condition>;
export type Company = z.infer<typeof Company>;
export type Currency = z.infer<typeof Currency>;
export type Money = z.infer<typeof Money>;
export type Hash = z.infer<typeof Hash>;
export type SetKey = z.infer<typeof SetKey>;
export type CardKey = z.infer<typeof CardKey>;
