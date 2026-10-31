import type { SQLiteDBConnection } from '@capacitor-community/sqlite';

/**
 * App-owned catalog storage types (Stage D). Kept local on purpose: core only sees `CatalogInstallPort` v2
 * (stage / openForValidation / activate / restorePrevious / discardPrevious / discardCandidate / inspect / remove) and
 * never these file-level details.
 */
export type CatalogLanguageCode = 'en' | 'ja';

/** Error codes the adapter throws; core maps them to `CatalogError`. */
export type AdapterErrorCode =
  | 'HTTP_FAILED'
  | 'PACK_SIZE_MISMATCH'
  | 'PACK_HASH_MISMATCH'
  | 'PACK_INVALID'
  | 'APP_UPDATE_REQUIRED'
  | 'STORAGE_FULL'
  | 'UNSUPPORTED_CAPABILITY'
  | 'ACTIVATION_FAILED'
  | 'PAYLOAD_TOO_LARGE'
  | 'CANCELLED';

/** Sequential, backpressured writer for one staged (not yet active) catalog file. */
export interface CatalogStagingFile {
  readonly ref: string;
  readonly chunkEncoding: 'base64' | 'bytes';
  append(chunk: Uint8Array | string): Promise<void>;
  finish(): Promise<{ bytes: number }>;
  abort(): Promise<void>;
}

/** Read-only SQL handle plus the real driver connection (for sqlite-proxy). */
export interface CatalogHandle {
  readonly connection: SQLiteDBConnection;
  query(statement: string, values?: unknown[]): Promise<{ values?: unknown[] }>;
  close(): Promise<void>;
}

/** Disk / store truth for boot recovery (R06). Never derived from in-memory state. */
export interface DiskState {
  activeRef: string | null;
  previousRef: string | null;
  candidateRefs: string[];
}

export interface CatalogStorage {
  readonly kind: 'native-file' | 'web-store';
  readonly capabilities: { atomicRename: boolean; readOnlyOpen: boolean; backupExcluded: boolean; streamingWrite: boolean };
  availableBytes(): Promise<number | null>;
  beginStaging(request: { language: CatalogLanguageCode; version: string; expectedBytes: number }): Promise<CatalogStagingFile>;
  openReadOnly(ref: string): Promise<CatalogHandle>;
  activate(language: CatalogLanguageCode, candidateRef: string): Promise<{ activeRef: string; previousRef: string | null }>;
  restorePrevious(language: CatalogLanguageCode): Promise<boolean>;
  discardPrevious(language: CatalogLanguageCode): Promise<void>;
  /** Delete a STAGED candidate by ref. Refuses refs that are not staging files (never deletes active/previous). */
  discardCandidate(ref: string): Promise<void>;
  inspect(language: CatalogLanguageCode): Promise<DiskState>;
  activeRef(language: CatalogLanguageCode): Promise<string | null>;
  remove(language: CatalogLanguageCode): Promise<void>;
}
