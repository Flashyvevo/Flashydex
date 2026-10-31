import { z } from 'zod';
import { Hash, Language } from './primitives';

/** Catalog manifest v1 (docs/CATALOG-PACKS.md "Manifest" + Director note: optional setIndexUrl). */
const Version = z.string().regex(/^[0-9]{4}\.[0-9]{2}\.[0-9]{2}\.[0-9]{3}$/);
const Bytes = z.number().int().min(1).max(Number.MAX_SAFE_INTEGER);
const Count = z.number().int().min(0);
const ISO = z.string().datetime();

/** `allowDevUrls`: same-origin relative or http:// URLs (Director D27, `import.meta.env.DEV` only). */
function urlSchema(allowDevUrls: boolean) {
  return z
    .string()
    .max(2048)
    .refine(
      (value) => value.startsWith('https://') || (allowDevUrls && (value.startsWith('/') || value.startsWith('http://'))),
      allowDevUrls ? 'URL must be https:// (or a dev-only relative/http URL)' : 'URL must be https://'
    );
}

export function createCatalogManifestSchema(options: { allowDevUrls?: boolean } = {}) {
  const url = urlSchema(options.allowDevUrls === true);
  const Entry = z
    .object({
      currentVersion: Version.nullable(),
      targetVersion: Version,
      fullPackUrl: url,
      setIndexUrl: url.optional(),
      compressedBytes: Bytes,
      uncompressedBytes: Bytes,
      sha256: Hash,
      compressedSha256: Hash.optional(),
      schemaVersion: z.number().int().min(1),
      builtAt: ISO,
      counts: z.object({ sets: Count, cards: Count, variants: Count, prices: Count, unpublishedSets: Count }).strict(),
      delta: z
        .object({
          currentVersion: Version,
          targetVersion: Version,
          url,
          algorithm: z.string().min(1).max(80),
          compressedBytes: Bytes,
          uncompressedBytes: Bytes,
          sha256: Hash,
          baseSha256: Hash
        })
        .strict()
        .optional()
    })
    .strict();
  return z
    .object({
      manifestVersion: z.literal(1),
      currentVersion: Version.nullable(),
      targetVersion: Version,
      builtAt: ISO,
      languages: z
        .object({ en: Entry.optional(), ja: Entry.optional() })
        .strict()
        .refine((v) => v.en !== undefined || v.ja !== undefined, 'At least one language entry is required'),
      signature: z
        .object({ algorithm: z.literal('Ed25519'), keyId: z.string().min(1).max(80), value: z.string().regex(/^[A-Za-z0-9+/]{86}==$/) })
        .strict()
        .optional()
    })
    .strict();
}

export const CatalogManifestSchema = createCatalogManifestSchema();
export type CatalogManifest = z.infer<typeof CatalogManifestSchema>;
export type CatalogManifestEntryV1 = NonNullable<CatalogManifest['languages']['en']>;

/** One row of `set-index-<lang>.json` (builder output, Director D20). */
export const SetIndexRow = z
  .object({
    language: Language,
    id: z.string().min(1).max(200),
    name: z.string().min(1).max(200),
    series: z.string().nullable(),
    releaseDate: z.string().nullable(),
    totalCount: z.number().int().min(0).nullable(),
    officialCount: z.number().int().min(0).nullable(),
    logoUrl: z.string().nullable(),
    symbolUrl: z.string().nullable(),
    status: z.enum(['published', 'unpublished'])
  })
  .strict();
export const SetIndex = z.array(SetIndexRow);
export type SetIndexRow = z.infer<typeof SetIndexRow>;
