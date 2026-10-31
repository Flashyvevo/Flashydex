import { z } from 'zod';

/**
 * Contract of the FlashyDex recognition service (`services/recognition`, FastAPI):
 *   POST {base}/v1/identify   multipart: image (jpeg|png|webp ≤ 8 MB), lang? ('en'|'ja'|'any'), max_candidates? (1..5)
 *   Authorization: Bearer <FLASHYDEX_RECOG_TOKEN> when the service has a token configured.
 * The browser calls the service directly (CORS allowlist); nothing is persisted server-side.
 * Mirrors `services/recognition/app/api/schemas.py` (pydantic) field for field.
 */
export const RecognitionLang = z.enum(['en', 'ja']);
export const RecognitionLangHint = z.enum(['en', 'ja', 'any']);

export const RecognitionStatus = z.enum(['match', 'candidates', 'no_card', 'no_match']);
export type RecognitionStatus = z.infer<typeof RecognitionStatus>;

const Unit = z.number().min(0).max(1);

export const RecognitionSignals = z.object({
  hash: Unit.nullable(),
  embed: Unit.nullable(),
  ocr: Unit.nullable(),
  symbol: Unit.nullable()
});

/** Heuristic hints only (single still photo): never auto-commit a variant from these. */
export const RecognitionVariantHints = z.object({
  reverseHolo: Unit.optional(),
  firstEdition: Unit.optional(),
  stamp: Unit.optional()
});

export const RecognitionCandidate = z.object({
  language: RecognitionLang,
  cardId: z.string().min(1),
  localId: z.string(),
  name: z.string(),
  setId: z.string(),
  setName: z.string(),
  imageUrl: z.string().nullable(),
  score: Unit,
  signals: RecognitionSignals,
  /** Only populated on candidates[0]. */
  variantHints: RecognitionVariantHints
});
export type RecognitionCandidate = z.infer<typeof RecognitionCandidate>;

export const RecognitionResponse = z.object({
  /** `match` only above the high threshold with a clear margin; never auto-select `candidates`. */
  status: RecognitionStatus,
  confidence: Unit,
  /** match/candidates: 1..max_candidates (default 3, ≤ 5); no_card/no_match: []. */
  candidates: z.array(RecognitionCandidate).max(5),
  timingMs: z.record(z.string(), z.number()),
  indexVersion: z.string(),
  /** Extras beyond the owner contract (optional for consumers). */
  detection: z.object({ quadFound: z.boolean(), fallback: z.enum(['none', 'centre']) }).nullish(),
  ocr: z
    .object({ number: z.number().int().nullable(), total: z.number().int().nullable(), setCode: z.string().nullable(), confidence: z.number() })
    .nullish()
});
export type RecognitionResponse = z.infer<typeof RecognitionResponse>;

export const RecognitionErrorCode = z.enum([
  'UNAUTHORIZED', 'RATE_LIMITED', 'IMAGE_TOO_LARGE', 'INVALID_IMAGE', 'INVALID_LANG', 'INVALID_MAX_CANDIDATES',
  'UNSUPPORTED_IMAGE_TYPE', 'HEIC_UNSUPPORTED', 'INDEX_NOT_READY', 'MODEL_MISSING', 'BUSY'
]);
export const RecognitionError = z.object({ error: z.object({ code: z.string(), message: z.string() }) });

export const RecognitionHealth = z.object({
  status: z.enum(['ok', 'degraded']),
  service: z.literal('flashydex-recognition'),
  version: z.string(),
  model: z.string(),
  embedder: z.string().nullable(),
  ocr: z.boolean(),
  index: z.object({
    ready: z.boolean(),
    languages: z.array(RecognitionLang),
    counts: z.record(z.string(), z.number().int()),
    total: z.number().int(),
    version: z.string().nullable()
  }),
  error: z.string().nullable()
});

/** Draft 2020-12 JSON Schema of the identify response (same generator options as json-schema.ts). */
export const recognitionResponseJsonSchema = (): Record<string, unknown> => ({
  ...(z.toJSONSchema(RecognitionResponse, { target: 'draft-2020-12', io: 'output', unrepresentable: 'any' }) as Record<string, unknown>),
  $schema: 'https://json-schema.org/draft/2020-12/schema',
  $id: 'https://flashydex.local/schemas/recognition-response.v1.schema.json',
  title: 'FlashyDex recognition identify response v1'
});
