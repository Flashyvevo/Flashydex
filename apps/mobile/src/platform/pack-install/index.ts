/**
 * Catalog pack device API. Core's `CatalogInstallService` drives it through `CatalogInstallPort` v2 (platform/app-database.ts);
 * nothing here touches the user DB or validates catalog SQL.
 *
 *   stageCatalogPack(entry, { trustedOrigins, onProgress, signal }) -> { language, version, sha256, bytes, candidateRef, metrics }
 *   getCatalogStorage().activate / restorePrevious / discardPrevious / discardCandidate / inspect / remove
 *   fetchManifestText({ maxBytes })   // bounded stream read, never response.text() first
 *   openCatalogDb(language)           // read-only SQLiteDBConnection for the ACTIVE catalog (wrap with createProxyCallback)
 */
import { PackInstallError, resolvePackUrl } from './installer';

export {
  PackInstallError, closeCatalogDb, getCatalogStorage, isCatalogInstalled, openCatalogDb, openCatalogDbWritable, openCatalogRef, removeCatalog,
  resolvePackUrl, stageCatalogPack
} from './installer';
export type { DeviceInstallMetrics, PackEntryInput, StageOptions, StageProgress, StageResult, WritableCatalog } from './installer';
export type { CatalogHandle, CatalogLanguageCode, CatalogStorage, DiskState } from './storage-types';

/** Manifest URL: `FLASHYDEX_MANIFEST_URL` (Vite envPrefix), dev default `/dev-packs/catalog-manifest.json`. Null in production when unset. */
export function manifestUrl(): string | null {
  const configured = import.meta.env.FLASHYDEX_MANIFEST_URL;
  if (configured) return configured;
  return import.meta.env.DEV ? '/dev-packs/catalog-manifest.json' : null;
}

/**
 * Bounded manifest read (R09): the body is consumed with a stream reader and aborted the moment it exceeds `maxBytes`
 * (PAYLOAD_TOO_LARGE); `response.text()` is never called on an unbounded body. Returns the final URL after redirects so core
 * can check it against trustedOrigins.
 */
export async function fetchManifestText(
  { maxBytes, url = manifestUrl() }: { maxBytes: number; url?: string | null },
  signal?: AbortSignal
): Promise<{ text: string; finalUrl: string; requestedUrl: string }> {
  if (!url) throw new PackInstallError('HTTP_FAILED', 'No catalog manifest URL is configured');
  const requestedUrl = resolvePackUrl(url);
  let response: Response;
  try {
    response = await fetch(requestedUrl, { signal, cache: 'no-store' });
  } catch (error) {
    if (signal?.aborted) throw new PackInstallError('CANCELLED', 'Cancelled');
    throw new PackInstallError('HTTP_FAILED', `Manifest request failed: ${error instanceof Error ? error.message : String(error)}`);
  }
  if (!response.ok || !response.body) throw new PackInstallError('HTTP_FAILED', `Manifest HTTP ${response.status}`);
  const declared = Number(response.headers.get('content-length'));
  if (Number.isFinite(declared) && declared > maxBytes) {
    await response.body.cancel().catch(() => undefined);
    throw new PackInstallError('PAYLOAD_TOO_LARGE', 'The catalog manifest is too large');
  }
  const reader = response.body.getReader();
  const chunks: Uint8Array[] = [];
  let received = 0;
  try {
    for (;;) {
      const { done, value } = await reader.read();
      if (done) break;
      received += value.length;
      if (received > maxBytes) {
        await reader.cancel().catch(() => undefined);
        throw new PackInstallError('PAYLOAD_TOO_LARGE', 'The catalog manifest is too large');
      }
      chunks.push(value);
    }
  } catch (error) {
    if (error instanceof PackInstallError) throw error;
    if (signal?.aborted) throw new PackInstallError('CANCELLED', 'Cancelled');
    throw new PackInstallError('HTTP_FAILED', `Manifest download interrupted: ${error instanceof Error ? error.message : String(error)}`);
  }
  const bytes = new Uint8Array(received);
  let offset = 0;
  for (const chunk of chunks) {
    bytes.set(chunk, offset);
    offset += chunk.length;
  }
  return { text: new TextDecoder('utf-8').decode(bytes), finalUrl: response.url || requestedUrl, requestedUrl };
}
