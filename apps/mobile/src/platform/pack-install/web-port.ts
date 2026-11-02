import type { CatalogInstallPort, PackDiskState, PackEntry, PackStageResult } from '@flashydex/core';
import type { CatalogLanguageCode } from './storage-types';
import { WEB_ATOMIC_ACTIVATION_PROVEN, type WebCatalogStorage } from './web-store';

/**
 * `CatalogInstallPort` v2 for the web build over `WebCatalogStorage` (role store + sahpool client + OPFS stage worker). A thin adapter:
 * every behavior lives in web-store.ts so it can be driven in tests through the UNCHANGED core `CatalogInstallService`.
 */
export function createWebInstallPort(
  storage: WebCatalogStorage,
  options: { allowDevUrls: boolean; fetchManifest: CatalogInstallPort['fetchManifest']; enabled?: () => boolean }
): CatalogInstallPort {
  const enabled = options.enabled ?? (() => true);
  return {
    allowDevUrls: options.allowDevUrls,
    capabilities() {
      if (!enabled()) {
        return { fullInstall: false, atomicActivation: false, attachReads: false, catalogWrites: false, reason: 'DEV legacy storage mode: catalogs are disabled.' };
      }
      return {
        fullInstall: true,
        atomicActivation: WEB_ATOMIC_ACTIVATION_PROVEN,
        attachReads: false,
        catalogWrites: true,
        reason: WEB_ATOMIC_ACTIVATION_PROVEN ? null : 'Pointer + journal fault tests have not passed yet.'
      };
    },
    fetchManifest: options.fetchManifest,
    async stage(entry: PackEntry & { language: CatalogLanguageCode }, stageOptions): Promise<PackStageResult> {
      const result = await storage.stage(entry, {
        trustedOrigins: stageOptions.trustedOrigins,
        signal: stageOptions.signal,
        onProgress: (progress) => stageOptions.onProgress(progress)
      });
      return { language: result.language, version: result.version, sha256: result.sha256, bytes: result.bytes, candidateRef: result.candidateRef, metrics: result.metrics };
    },
    openForValidation: (ref) => storage.openValidationDriver(ref),
    activate: (language, candidateRef) => storage.activate(language, candidateRef),
    restorePrevious: (language) => storage.restorePrevious(language),
    discardPrevious: (language) => storage.discardPrevious(language),
    discardCandidate: (ref) => storage.discardCandidate(ref),
    inspect: (language): Promise<PackDiskState> => storage.inspect(language),
    remove: (language) => storage.remove(language)
  };
}
