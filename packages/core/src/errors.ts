/** Domain errors (docs/API.md "Conventions, errors, paging"). Safe details only: no SQL, stack, paths or private notes. */
export class DomainError extends Error {
  readonly code: string;
  readonly details?: unknown;
  constructor(code: string, message: string, details?: unknown) {
    super(message);
    this.name = new.target.name;
    this.code = code;
    if (details !== undefined) this.details = details;
  }
  toJSON(): { code: string; message: string; details?: unknown } {
    return this.details === undefined ? { code: this.code, message: this.message } : { code: this.code, message: this.message, details: this.details };
  }
}

export type ValidationIssue = { path: string; code: string; message: string };

export class ValidationError extends DomainError {
  constructor(message: string, issues: ValidationIssue[] = []) {
    super('VALIDATION_ERROR', message, { issues: [...issues].sort((a, b) => a.path.localeCompare(b.path) || a.code.localeCompare(b.code)) });
  }
}
export class NotFoundError extends DomainError {
  constructor(entity: string, id?: string, message?: string) {
    super('NOT_FOUND', message ?? `${entity} not found`, { entity, ...(id === undefined ? {} : { id }) });
  }
}
export class InUseError extends DomainError {
  constructor(entity: string, dependentCount: number) {
    super('IN_USE', `${entity} is still in use`, { entity, dependentCount });
  }
}
export class ConflictError extends DomainError {
  constructor(message: string, details?: unknown) {
    super('CONFLICT', message, details);
  }
}
export class StalePreviewError extends DomainError {
  constructor(expectedRevision: number, actualRevision: number) {
    super('STALE_PREVIEW', 'The collection changed after this preview was created', { expectedRevision, actualRevision });
  }
}
export class PreviewExpiredError extends DomainError {
  constructor() {
    super('PREVIEW_EXPIRED', 'This preview has expired');
  }
}
export class InvalidStateError extends DomainError {
  constructor(message: string, details?: unknown) {
    super('INVALID_STATE', message, details);
  }
}
export class ActiveWorkError extends DomainError {
  constructor(code: 'ACTIVE_SYNC' | 'ACTIVE_WORK' = 'ACTIVE_WORK', message = 'Another download or sync is already running') {
    super(code, message);
  }
}
export class ImportError extends DomainError {
  constructor(code: 'IMPORT_INVALID' | 'INVALID_JSON' | 'INVALID_CSV', message: string, details?: unknown) {
    super(code, message, details);
  }
}
export class BackupError extends DomainError {
  constructor(code: 'BACKUP_INVALID' | 'BACKUP_VERSION_UNSUPPORTED' | 'ALREADY_RESTORED' | 'SIZE_LIMIT' | 'BACKUP_HASH_MISMATCH' | 'BACKUP_COUNT_MISMATCH' | 'BACKUP_UNSAFE_ENTRY' = 'BACKUP_INVALID', message = 'Invalid backup') {
    super(code, message);
  }
}
export class SizeLimitError extends DomainError {
  constructor(message = 'File is too large', details?: unknown) {
    super('PAYLOAD_TOO_LARGE', message, details);
  }
}
export class StorageError extends DomainError {
  constructor(code: 'DB_BUSY' | 'STORAGE_FULL' | 'DB_UNAVAILABLE' | 'MIGRATION_FAILED' | 'INSTANCE_LOCK', message: string, details?: unknown) {
    super(code, message, details);
  }
}
export class PersistenceError extends DomainError {
  constructor(message = 'The change may not have been saved to storage. Reload before retrying.') {
    super('PERSISTENCE_FAILED', message);
  }
}
export class MaintenanceError extends DomainError {
  constructor() {
    super('MAINTENANCE', 'Storage is being maintained. Try again in a moment.');
  }
}
export class PlatformError extends DomainError {
  constructor(code: 'PLATFORM_UNAVAILABLE' | 'FILE_IO' | 'SHARE_FAILED' | 'HTTP_FAILED', message: string, details?: unknown) {
    super(code, message, details);
  }
}
export class UnsupportedCapabilityError extends DomainError {
  constructor(message = 'Not implemented yet', details?: unknown) {
    super('UNSUPPORTED_CAPABILITY', message, details);
  }
}
export class CancelledError extends DomainError {
  constructor(message = 'Cancelled') {
    super('CANCELLED', message);
  }
}
/** Catalog install failures: HTTP_FAILED, PACK_*, MANIFEST_INVALID, MANIFEST_SIGNATURE_INVALID, PAYLOAD_TOO_LARGE, APP_UPDATE_REQUIRED, NO_ROLLBACK, CATALOG_NOT_INSTALLED, STALE_READ ... */
export class CatalogError extends DomainError {}

export function isDomainError(value: unknown): value is DomainError {
  return value instanceof DomainError;
}

/** Map anything thrown into a DomainError. Unexpected errors become sanitized INTERNAL_ERROR. */
export function toDomainError(error: unknown): DomainError {
  if (error instanceof DomainError) return error;
  if (error && typeof error === 'object' && 'code' in error && typeof (error as { code: unknown }).code === 'string' && 'message' in error) {
    // Errors from platform adapters (e.g. PackInstallError) carry a safe code + message.
    const e = error as { code: string; message: string };
    if (/^[A-Z_]+$/.test(e.code)) return new DomainError(e.code, e.message);
  }
  const message = error instanceof Error ? error.message : '';
  if (/SQLITE_BUSY|database is locked/i.test(message)) return new StorageError('DB_BUSY', 'The database is busy. Try again.');
  if (/SQLITE_FULL|disk is full|database or disk is full/i.test(message)) return new StorageError('STORAGE_FULL', 'The device storage is full.');
  return new DomainError('INTERNAL_ERROR', 'Something went wrong.');
}
