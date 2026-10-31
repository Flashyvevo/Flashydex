import { sha256Hex } from '../sha256';
import { normalizeStamp, normalizeToken } from './text';
import type { CatalogLanguage, CatalogVariant, CatalogVariantRow, RawVariantRow } from './types';
import { CATALOG_VARIANTS } from './types';

/** Print attributes of one `variants_detailed` row after normalisation. */
export interface PrintAttributes {
  type: string;
  subtype: string | null;
  foil: string | null;
  size: string;
  /** Normalised (case/hyphen/space-insensitive), sorted, de-duplicated. */
  stamps: string[];
}

export interface MappedPrint {
  /** Original provider row (kept so pricing can be read from the MATCHED row, never by array order). */
  row: RawVariantRow;
  attrs: PrintAttributes;
  variant: CatalogVariant;
  variantDetail: string;
  variantKey: string;
}

const MAX_DETAIL = 120;

function clean(value: unknown): string | null {
  return typeof value === 'string' && value.trim().length > 0 ? normalizeToken(value) : null;
}

export function printAttributes(row: RawVariantRow): PrintAttributes {
  const stamps = Array.isArray(row.stamp)
    ? [...new Set(row.stamp.filter((s): s is string => typeof s === 'string').map(normalizeStamp).filter(Boolean))].sort()
    : [];
  return {
    type: clean(row.type) ?? 'normal',
    subtype: clean(row.subtype),
    foil: clean(row.foil),
    size: clean(row.size) ?? 'standard',
    stamps
  };
}

function detail(...parts: Array<string | null | undefined>): string {
  return parts.filter((part): part is string => Boolean(part)).join(',').slice(0, MAX_DETAIL);
}

/**
 * Canonical Variant + qualifier per the BINDING table in docs/DATA-MODEL.md "Variants and source
 * reconciliation". Resolves by type/subtype/normalised stamp/foil/size - never by array order or variantId.
 */
export function classifyPrint(attrs: PrintAttributes): { variant: CatalogVariant; variantDetail: string } {
  const { type, subtype, foil, size, stamps } = attrs;
  const sizeQualifier = size !== 'standard' ? size : null;
  if (type !== 'normal' && type !== 'holo' && type !== 'reverse') {
    // Unknown detailed variant types become other with raw type/size as a nonempty detail.
    return { variant: 'other', variantDetail: detail(type, sizeQualifier) };
  }
  const firstEdition = stamps.includes('1st-edition');
  const otherStamps = stamps.filter((stamp) => stamp !== '1st-edition');

  if (firstEdition) {
    const base = subtype === 'shadowless' ? `shadowless:${type}` : type;
    const extraSubtype = subtype && subtype !== 'shadowless' ? subtype : null;
    return { variant: 'first_edition', variantDetail: detail(base, extraSubtype, foil, sizeQualifier, ...otherStamps) };
  }
  if (subtype === 'shadowless') {
    return { variant: 'shadowless', variantDetail: detail(type, foil, sizeQualifier, ...otherStamps) };
  }
  if (otherStamps.length > 0) {
    return { variant: 'promo_stamped', variantDetail: detail(...otherStamps, subtype, foil, sizeQualifier) };
  }
  if (type === 'reverse') {
    if (!subtype && !sizeQualifier) {
      if (!foil) return { variant: 'reverse_holo', variantDetail: '' };
      if (foil === 'pokeball' || foil === 'masterball') return { variant: 'reverse_holo', variantDetail: foil };
    }
  } else if (type === 'holo') {
    if (!sizeQualifier) {
      if (!subtype && !foil) return { variant: 'holo', variantDetail: '' };
      if (subtype === 'unlimited' && !foil) return { variant: 'holo', variantDetail: 'unlimited' };
      if (foil === 'gold' && !subtype) return { variant: 'holo', variantDetail: 'gold' };
    }
  } else if (!sizeQualifier && !foil) {
    if (!subtype) return { variant: 'normal', variantDetail: '' };
    if (subtype === 'unlimited') return { variant: 'normal', variantDetail: 'unlimited' };
  }
  const qualifier = detail(subtype, foil, sizeQualifier) || type;
  return { variant: 'other', variantDetail: qualifier };
}

/** variant_key = SHA-256 of canonical JSON `[type,subtype,foil,size,sortedNormalizedStamps]` (DATA-MODEL). */
export function variantKey(attrs: PrintAttributes): string {
  return sha256Hex(JSON.stringify([attrs.type, attrs.subtype, attrs.foil, attrs.size, attrs.stamps]));
}

/**
 * Classify every detailed row; truly identical print tuples (same variant_key) are merged, keeping the
 * first row that carries pricing so price data is not lost to an unpriced twin.
 */
export function classifyPrints(rows: readonly RawVariantRow[] | undefined): MappedPrint[] {
  const byKey = new Map<string, MappedPrint>();
  for (const row of rows ?? []) {
    const attrs = printAttributes(row);
    const key = variantKey(attrs);
    const existing = byKey.get(key);
    if (existing) {
      if (!existing.row.pricing && row.pricing) existing.row = row;
      continue;
    }
    byKey.set(key, { row, attrs, ...classifyPrint(attrs), variantKey: key });
  }
  return [...byKey.values()].sort((a, b) =>
    CATALOG_VARIANTS.indexOf(a.variant) - CATALOG_VARIANTS.indexOf(b.variant)
    || a.variantDetail.localeCompare(b.variantDetail)
    || a.variantKey.localeCompare(b.variantKey));
}

export function toVariantRow(language: CatalogLanguage, cardId: string, print: MappedPrint): CatalogVariantRow {
  const providerId = typeof print.row.variantId === 'string' && print.row.variantId.length > 0 ? print.row.variantId : null;
  return {
    language,
    cardId,
    variantKey: print.variantKey,
    variant: print.variant,
    variantDetail: print.variantDetail,
    providerVariantId: providerId,
    type: print.attrs.type,
    subtype: print.attrs.subtype,
    foil: print.attrs.foil,
    size: print.attrs.size,
    stampsJson: JSON.stringify(print.attrs.stamps),
    attributesJson: JSON.stringify(print.row)
  };
}

/** TCGdex availability booleans -> canonical Variant strings (true advertises availability only). */
export function availableVariants(flags: Record<string, unknown> | undefined): CatalogVariant[] {
  const out = new Set<CatalogVariant>();
  if (flags?.normal === true) out.add('normal');
  if (flags?.holo === true) out.add('holo');
  if (flags?.reverse === true) out.add('reverse_holo');
  if (flags?.firstEdition === true) out.add('first_edition');
  if (flags?.wPromo === true) out.add('promo_stamped');
  return CATALOG_VARIANTS.filter((variant) => out.has(variant));
}
