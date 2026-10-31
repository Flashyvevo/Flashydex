import { BackupError, DomainError, parseArchive, type FdxLimits, type ParsedBackup } from '@flashydex/core';
import { sha256 } from 'hash-wasm';

/** N04: message protocol + pure handler of the `.fdx` parse worker (kept separate from `self` so it is unit-testable and shared with the fallback). */
export type ArchiveWorkerRequest = { type: 'ping' } | { type: 'parse'; bytes: Uint8Array; limits: FdxLimits };
export type ArchiveWorkerResponse =
  | { type: 'pong' }
  | { type: 'result'; parsed: ParsedBackup }
  | { type: 'error'; code: string; message: string };

const BACKUP_CODES = new Set(['BACKUP_INVALID', 'BACKUP_VERSION_UNSUPPORTED', 'ALREADY_RESTORED', 'SIZE_LIMIT', 'BACKUP_HASH_MISMATCH', 'BACKUP_COUNT_MISMATCH', 'BACKUP_UNSAFE_ENTRY']);

export async function handleArchiveRequest(request: ArchiveWorkerRequest): Promise<ArchiveWorkerResponse> {
  if (request.type === 'ping') return { type: 'pong' };
  try {
    return { type: 'result', parsed: await parseArchive(request.bytes, (b) => sha256(b), request.limits) };
  } catch (error) {
    if (error instanceof DomainError && BACKUP_CODES.has(error.code)) return { type: 'error', code: error.code, message: error.message };
    return { type: 'error', code: 'BACKUP_INVALID', message: 'The backup could not be read' };
  }
}

/** Rebuild the typed core error on the main thread. */
export function backupErrorFrom(code: string, message: string): BackupError {
  return new BackupError((BACKUP_CODES.has(code) ? code : 'BACKUP_INVALID') as ConstructorParameters<typeof BackupError>[0], message);
}
