import { z } from 'zod';
import { CollectionExportV1, FdxManifestV1 } from './transfer';
import { CatalogManifestSchema } from './manifest';

/**
 * Draft 2020-12 JSON Schemas generated from the strict zod schemas (single source of truth).
 * Cross-record rules (unique keys, parent references, observationKey recomputation) are not expressible in JSON Schema:
 * they are described in `description` and enforced at runtime by the importer.
 */
const CROSS_RECORD =
  'Cross-record rules enforced at runtime by the importer: unique primary keys per array, unique grade ownedCardId, unique member pairs; exactly one of ' +
  'catalogCardId/customCardId per copy; every referenced parent present in the file or the target; a catalogRefs entry for every referenced catalog id; ' +
  'priceSnapshots observationKey = SHA-256 of [language,catalogCardId,source,variant,variantDetail,providerVariantKey,currency,sourceUpdatedAt,low,mid,high,market,trend]; ' +
  "paired money/currency nullability; source/currency pairing (tcgplayer=USD, cardmarket=EUR); variant 'other' needs variantDetail; company 'other' iff companyLabel; " +
  'updatedAt >= createdAt; at most 100000 copies and 250000 total rows.';

function generate(schema: z.ZodType, id: string, title: string, description: string): Record<string, unknown> {
  const json = z.toJSONSchema(schema, { target: 'draft-2020-12', io: 'output', unrepresentable: 'any' }) as Record<string, unknown>;
  return { ...json, $schema: 'https://json-schema.org/draft/2020-12/schema', $id: id, title, description };
}

export const collectionExportJsonSchema = (): Record<string, unknown> =>
  generate(CollectionExportV1, 'https://flashydex.local/schemas/collection-export.v1.schema.json', 'FlashyDex collection export v1', CROSS_RECORD);
export const fdxManifestJsonSchema = (): Record<string, unknown> =>
  generate(FdxManifestV1, 'https://flashydex.local/schemas/fdx-manifest.v1.schema.json', 'FlashyDex .fdx backup manifest v1', 'Backup manifest; entry hashes are verified over decompressed bytes.');
export const catalogManifestJsonSchema = (): Record<string, unknown> =>
  generate(CatalogManifestSchema, 'https://flashydex.local/schemas/catalog-manifest.v1.schema.json', 'FlashyDex catalog manifest v1', 'Catalog pack manifest (docs/CATALOG-PACKS.md).');

export const JSON_SCHEMA_FILES = {
  'collection-export.v1.schema.json': collectionExportJsonSchema,
  'fdx-manifest.v1.schema.json': fdxManifestJsonSchema,
  'catalog-manifest.v1.schema.json': catalogManifestJsonSchema
} as const;
