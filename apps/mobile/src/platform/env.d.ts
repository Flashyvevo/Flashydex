/// <reference types="vite/client" />

interface ImportMetaEnv {
  /** Catalog manifest URL; dev default is /dev-packs/catalog-manifest.json (see platform/pack-install). */
  readonly FLASHYDEX_MANIFEST_URL?: string;
  /** Comma-separated https origins trusted for manifests and packs (defaults: GitHub release hosts). */
  readonly FLASHYDEX_TRUSTED_ORIGINS?: string;
  /** Public recognizer base URL (build-time override; wins over runtime discovery). No secrets. */
  readonly FLASHYDEX_RECOG_URL?: string;
  /** Public recognizer discovery document URL (`{version:1,url,updatedAt?}`). */
  readonly FLASHYDEX_RECOG_CONFIG_URL?: string;
}

interface ImportMeta {
  readonly env: ImportMetaEnv;
}
