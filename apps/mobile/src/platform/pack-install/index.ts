/**
 * Catalog pack install API (device side). The data builder wraps this in `CatalogInstallService`
 * (user-DB journal + installed_catalogs); nothing here touches the user DB.
 *
 *   installCatalogPack(entry, { onProgress, signal }) -> { language, version, sha256, bytes, ref, previousRef, counts, metrics }
 *   finalizeCatalogInstall(language)   // after the caller's durable commit: drop the retained previous copy
 *   rollbackCatalogInstall(language)   // commit failed: put the previous copy back
 *   openCatalogDb(language)            // read-only SQLiteDBConnection for the ACTIVE catalog (wrap with createProxyCallback)
 */
import type { CatalogLanguageCode, CatalogManifestEntry } from '@flashydex/core';
import { PackInstallError, resolvePackUrl, type CatalogPackEntry } from './installer';

export {
  PackInstallError, closeCatalogDb, finalizeCatalogInstall, getCatalogStorage, installCatalogPack, isCatalogInstalled, openCatalogDb, openCatalogDbWritable,
  removeCatalog, resolvePackUrl, rollbackCatalogInstall
} from './installer';
export type { CatalogCounts, CatalogPackEntry, DeviceInstallMetrics, InstallOptions, InstallResult } from './installer';
export type { CatalogHandle } from './catalog-handle';

export interface CatalogManifestShape {
  manifestVersion: 1;
  currentVersion: string | null;
  targetVersion: string;
  builtAt: string;
  languages: Partial<Record<CatalogLanguageCode, CatalogManifestEntry>>;
}

/** Manifest URL: `FLASHYDEX_MANIFEST_URL` (Vite envPrefix), dev default `/dev-packs/catalog-manifest.json`. Null in production when unset. */
export function manifestUrl(): string | null {
  const configured = import.meta.env.FLASHYDEX_MANIFEST_URL;
  if (configured) return configured;
  return import.meta.env.DEV ? '/dev-packs/catalog-manifest.json' : null;
}

export async function fetchManifest(url: string | null = manifestUrl(), signal?: AbortSignal): Promise<CatalogManifestShape> {
  if (!url) throw new PackInstallError('HTTP_FAILED', 'No catalog manifest URL is configured');
  let response: Response;
  try {
    response = await fetch(resolvePackUrl(url), { signal, cache: 'no-store' });
  } catch (error) {
    if (signal?.aborted) throw new PackInstallError('CANCELLED', 'Cancelled');
    throw new PackInstallError('HTTP_FAILED', `Manifest request failed: ${error instanceof Error ? error.message : String(error)}`);
  }
  if (!response.ok) throw new PackInstallError('HTTP_FAILED', `Manifest HTTP ${response.status}`);
  const manifest = (await response.json()) as CatalogManifestShape;
  if (manifest?.manifestVersion !== 1 || typeof manifest.languages !== 'object' || manifest.languages === null) {
    throw new PackInstallError('PACK_INVALID', 'Unsupported or malformed catalog manifest');
  }
  return manifest;
}

/** Entries of a manifest with their language attached, in en, ja order. */
export function manifestEntries(manifest: CatalogManifestShape): CatalogPackEntry[] {
  return (['en', 'ja'] as const).flatMap((language) => {
    const entry = manifest.languages[language];
    return entry ? [{ ...entry, language }] : [];
  });
}
