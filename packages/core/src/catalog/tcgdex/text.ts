import type { CatalogLanguage } from './types';

/** `name.normalize('NFKC').toLowerCase()` (DATA-MODEL). */
export function nameSearch(name: string): string {
  return name.normalize('NFKC').toLowerCase();
}

/** Display-sort key: every digit run padded to 12 digits; the original localId is kept separately. */
export function localIdSort(localId: string): string {
  return localId.replace(/\d+/g, (digits) => digits.padStart(12, '0'));
}

/** Stamp matching normalisation: case, hyphen and whitespace/underscore are insignificant. */
export function normalizeStamp(stamp: string): string {
  return stamp.normalize('NFKC').trim().toLowerCase().replace(/[\s_]+/g, '-').replace(/-+/g, '-');
}

/** Normalise a qualifier/detail token the same way (used for variant_detail pieces). */
export function normalizeToken(token: string): string {
  return normalizeStamp(token);
}

/**
 * Card-level `image` is an extension-less CDN base and is stored as given (nullable, never derived).
 * Empty strings are treated as absent.
 */
export function imageBase(image: unknown): string | null {
  return typeof image === 'string' && image.trim().length > 0 ? image : null;
}

/** Set logos are `{logo}.webp` (no quality segment). */
export function logoUrl(logo: unknown): string | null {
  return typeof logo === 'string' && logo.length > 0 ? `${logo}.webp` : null;
}

/**
 * Set symbols come back as `https://assets.tcgdex.net/univ/{serie}/{setId}/symbol`, which 404s with or
 * without an extension. `univ` is rewritten to the catalog language and `.webp` appended. The builder
 * may still null the URL after a HEAD check (research/tcgdex-api.md).
 */
export function symbolUrl(symbol: unknown, language: CatalogLanguage): string | null {
  if (typeof symbol !== 'string' || symbol.length === 0) return null;
  const rewritten = symbol.replace(/\/univ\//, `/${language}/`);
  return rewritten.endsWith('.webp') ? rewritten : `${rewritten}.webp`;
}

/** ISO instant (UTC, milliseconds) from any ISO-like provider string, else null. */
export function toUtcIso(value: unknown): string | null {
  if (typeof value !== 'string' || value.length === 0) return null;
  const time = Date.parse(value);
  return Number.isNaN(time) ? null : new Date(time).toISOString();
}

export function stringOrNull(value: unknown): string | null {
  return typeof value === 'string' && value.length > 0 ? value : null;
}

export function intOrNull(value: unknown): number | null {
  return typeof value === 'number' && Number.isInteger(value) && value >= 0 ? value : null;
}
