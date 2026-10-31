export interface SqliteExecutor {
  execute(sql: string, params?: readonly unknown[]): Promise<readonly Record<string, unknown>[]>;
}

export type SupportedPlatform = 'web' | 'ios' | 'android' | 'node';

export interface DownloadProgress {
  receivedBytes: number;
  totalBytes: number | null;
}

export interface DownloadResult {
  bytes: number;
  contentType: string | null;
}

export interface StreamDecodeResult {
  bytes: number;
  sha256: string;
}

/** Platform-only file primitives. Catalog repositories remain platform agnostic. */
export interface PlatformFiles {
  download(url: string, destination: string, onProgress: (progress: DownloadProgress) => void, signal?: AbortSignal): Promise<DownloadResult>;
  decodeZstdToFile(source: string, destination: string, signal?: AbortSignal): Promise<StreamDecodeResult>;
  sha256File(path: string): Promise<string>;
  atomicRename(source: string, destination: string): Promise<void>;
  availableBytes(): Promise<number | null>;
  imageCache: {
    get(key: string): Promise<Blob | null>;
    put(key: string, value: Blob): Promise<void>;
    clear(): Promise<void>;
  };
}

// ---------------------------------------------------------------------------------------------------------
// Catalog pack storage + install adapter (added by sonnet-tooling; additive - nothing above changed).
// Implemented by apps/mobile/src/platform/pack-install (native Filesystem + web jeep store).
// docs/CATALOG-PACKS.md "Device installer state machine and file protocol", Director rulings S7/D18/D22/D27.
// ---------------------------------------------------------------------------------------------------------

export type CatalogLanguageCode = 'en' | 'ja';

/** Manifest language entry as consumed by the installer (docs/CATALOG-PACKS.md + Director note: setIndexUrl). */
export interface CatalogManifestEntry {
  currentVersion: string | null;
  targetVersion: string;
  fullPackUrl: string;
  setIndexUrl?: string;
  compressedBytes: number;
  uncompressedBytes: number;
  /** SHA-256 of the UNCOMPRESSED closed SQLite bytes (lowercase hex). */
  sha256: string;
  compressedSha256?: string;
  schemaVersion: number;
  builtAt: string;
  counts: { sets: number; cards: number; variants: number; prices: number; unpublishedSets: number };
}

/** Error codes the install flow raises (mapped to UX stages in Director ruling D12). */
export type PackInstallErrorCode =
  | 'HTTP_FAILED'
  | 'PACK_SIZE_MISMATCH'
  | 'PACK_HASH_MISMATCH'
  | 'PACK_INVALID'
  | 'APP_UPDATE_REQUIRED'
  | 'STORAGE_FULL'
  | 'UNSUPPORTED_CAPABILITY'
  | 'ACTIVATION_FAILED'
  | 'CANCELLED';

export type PackInstallPhase = 'downloading' | 'verifying' | 'validating' | 'activating' | 'installed';

export interface PackInstallProgress {
  phase: PackInstallPhase;
  /** Compressed bytes received so far / expected (manifest value, not Content-Length). */
  compressedBytesDone: number;
  compressedBytesTotal: number;
  /** Decompressed bytes produced and written so far / expected (manifest value). */
  decompressedBytesDone: number;
  decompressedBytesTotal: number;
}

/** Sequential, backpressured writer for one staged (not yet active) catalog file. */
export interface CatalogStagingFile {
  /** Opaque reference to the staged candidate (never exported, never shown). */
  readonly ref: string;
  /** What `append` wants: base64 strings (Capacitor Filesystem) or raw bytes (web store). */
  readonly chunkEncoding: 'base64' | 'bytes';
  append(chunk: Uint8Array | string): Promise<void>;
  /** Flush and close; resolves with the exact number of bytes written. */
  finish(): Promise<{ bytes: number }>;
  /** Delete the partial file (idempotent). */
  abort(): Promise<void>;
}

/** Minimal read-only SQL handle used for validation. */
export interface CatalogReadOnlyHandle {
  query(statement: string, values?: unknown[]): Promise<{ values?: unknown[] }>;
  close(): Promise<void>;
}

export interface PlatformCatalogStorage {
  readonly kind: 'native-file' | 'web-store';
  readonly capabilities: {
    /** Same-volume atomic rename of the candidate into the active slot. False on web (separate IndexedDB keys). */
    atomicRename: boolean;
    /** Catalog opens read-only through the driver (native: createNCConnection). */
    readOnlyOpen: boolean;
    /** Catalog directory is excluded from device backup (iOS isExcludedFromBackup / Android backup rules). */
    backupExcluded: boolean;
    /** Decoded bytes are written to a file in bounded chunks (false on web: assembled in memory). */
    streamingWrite: boolean;
  };
  /** Free bytes on the catalog volume, or null when the platform cannot tell (native needs a custom plugin). */
  availableBytes(): Promise<number | null>;
  beginStaging(request: { language: CatalogLanguageCode; version: string; expectedBytes: number }): Promise<CatalogStagingFile>;
  openReadOnly(ref: string): Promise<CatalogReadOnlyHandle>;
  /** Move the staged candidate into the active slot; any current active file is kept as `previous`. */
  activate(language: CatalogLanguageCode, candidateRef: string): Promise<{ activeRef: string; previousRef: string | null }>;
  /** Delete the retained previous copy (call only after the durable commit). */
  discardPrevious(language: CatalogLanguageCode): Promise<void>;
  /** Put `previous` back as active (rollback); false when there is none. */
  restorePrevious(language: CatalogLanguageCode): Promise<boolean>;
  activeRef(language: CatalogLanguageCode): Promise<string | null>;
  /** Delete the active file, previous copy and any staging leftovers for the language. */
  remove(language: CatalogLanguageCode): Promise<void>;
}
