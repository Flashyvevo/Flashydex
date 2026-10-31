/// <reference types="vite/client" />

interface ImportMetaEnv {
  /** Catalog manifest URL; dev default is /dev-packs/catalog-manifest.json (see platform/pack-install). */
  readonly FLASHYDEX_MANIFEST_URL?: string;
}

interface ImportMeta {
  readonly env: ImportMetaEnv;
}
