import type { Language } from '@flashydex/core';

/**
 * Catalog `imageUrl` values are TCGdex image BASE urls (no extension): append the size/format here.
 * grids/search/sets use 'low', detail/zoom use 'high' (never bulk-download). User-provided custom-card URLs (anything that already
 * ends in an image extension) are returned untouched. null in -> null out (show the styled placeholder, never a broken <img>).
 */
export function cardImageUrl(imageUrl: string | null, size: 'low' | 'high' = 'low'): string | null {
  if (imageUrl === null) return null;
  if (/\.(webp|png|jpe?g|gif|avif)(\?.*)?$/i.test(imageUrl)) return imageUrl;
  return `${imageUrl.replace(/\/+$/, '')}/${size}.webp`;
}

/** Display helper: collector number for UI ("001/190" only when the set has an official count > 0; otherwise the localId alone). */
export function collectorNumber(localId: string | null, officialCount: number | null): string | null {
  if (localId === null) return null;
  return officialCount !== null && officialCount > 0 ? `${localId}/${String(officialCount).padStart(localId.length, '0')}` : localId;
}

export type { Language };
