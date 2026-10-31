import { manifestUrl } from './pack-install';

/** Default trusted origins for catalog manifests and packs (D46 / CATALOG-PACKS). Core does all semantic URL validation. */
export const DEFAULT_TRUSTED_ORIGINS = [
  'https://github.com',
  'https://objects.githubusercontent.com',
  'https://release-assets.githubusercontent.com'
] as const;

function normalizeOrigin(value: string): string | null {
  try {
    const url = new URL(value.trim());
    return url.protocol === 'https:' || (import.meta.env.DEV && url.protocol === 'http:') ? url.origin : null;
  } catch {
    return null;
  }
}

/** `FLASHYDEX_TRUSTED_ORIGINS` (comma list) else the defaults; DEV additionally trusts the page origin (dev packs are same-origin). */
export function trustedOrigins(): string[] {
  const configured = import.meta.env.FLASHYDEX_TRUSTED_ORIGINS;
  const base = configured
    ? configured.split(',').map(normalizeOrigin).filter((origin): origin is string => origin !== null)
    : [...DEFAULT_TRUSTED_ORIGINS];
  if (import.meta.env.DEV && typeof window !== 'undefined') base.push(window.location.origin);
  return [...new Set(base)];
}

/** Value passed to `createServices({ catalog })`. */
export function catalogConfig(): { manifestUrl: string | null; trustedOrigins: string[] } {
  return { manifestUrl: manifestUrl(), trustedOrigins: trustedOrigins() };
}
