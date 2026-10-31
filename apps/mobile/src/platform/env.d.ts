/// <reference types="vite/client" />

interface ImportMetaEnv {
  /** Catalog manifest URL; dev default is /dev-packs/catalog-manifest.json (see platform/pack-install). */
  readonly FLASHYDEX_MANIFEST_URL?: string;
  /** Comma-separated https origins trusted for manifests and packs (defaults: GitHub release hosts). */
  readonly FLASHYDEX_TRUSTED_ORIGINS?: string;
}

interface ImportMeta {
  readonly env: ImportMetaEnv;
}
