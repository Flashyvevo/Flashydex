// DomainError → friendly copy (UX.md §12). Never "Oops", never blame the user.

export type ErrorCopy = { title: string; body: string; code: string | null; detail: string | null };

export function errorCode(error: unknown): string | null {
  if (error && typeof error === 'object' && 'code' in error && typeof (error as { code: unknown }).code === 'string') {
    return (error as { code: string }).code;
  }
  return null;
}

export function errorDetails(error: unknown): unknown {
  if (error && typeof error === 'object' && 'details' in error) return (error as { details: unknown }).details;
  return undefined;
}

export function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

export type ValidationIssue = { path: (string | number)[] | string; code?: string; message: string };
export function validationIssues(error: unknown): ValidationIssue[] {
  if (errorCode(error) !== 'VALIDATION_ERROR') return [];
  const d = errorDetails(error) as { issues?: ValidationIssue[] } | undefined;
  return d?.issues ?? [];
}

function baseCopy(error: unknown): Omit<ErrorCopy, "detail"> {
  const code = errorCode(error);
  const dependent = (errorDetails(error) as { dependentCount?: number } | undefined)?.dependentCount;
  switch (code) {
    case 'HTTP_FAILED':
    case 'PLATFORM_UNAVAILABLE':
      return { code, title: "You're offline", body: 'Your collection works offline. Downloads and price updates continue when you’re connected.' };
    case 'SERVER_ERROR':
      return { code, title: 'TCGdex isn’t responding', body: 'The catalog source is having trouble. Your collection is fine — try again later.' };
    case 'RATE_LIMITED':
      return { code, title: 'TCGdex asked us to slow down', body: 'Try again in a few minutes. Your collection is fine.' };
    case 'BAD_PAYLOAD':
      return { code, title: 'Couldn’t read the download', body: 'TCGdex sent something FlashyDex couldn’t read. Your collection is fine. Try again later.' };
    case 'DB_BUSY':
      return { code, title: 'Busy for a moment', body: 'FlashyDex is saving something else. Try again.' };
    case 'STORAGE_FULL':
      return { code, title: 'Your device is full', body: 'Nothing was saved. Free up space in Settings → General → iPhone Storage (Android: Settings → Storage), then try again.' };
    case 'PERSISTENCE_FAILED':
      return { code, title: 'Your last change may not have saved', body: 'Editing is paused while FlashyDex re-checks what was saved. Check the card afterwards and add it again if it’s missing — don’t retry before checking.' };
    case 'DB_UNAVAILABLE':
    case 'MIGRATION_FAILED':
      return { code, title: 'FlashyDex couldn’t open your data', body: 'Your collection hasn’t been deleted. Close and reopen the app. If this keeps happening, update FlashyDex from the App Store.' };
    case 'MAINTENANCE':
      return { code, title: 'FlashyDex is busy', body: 'A restore or catalog change is in progress. Keep FlashyDex open and try again in a moment.' };
    case 'STALE_READ':
      return { code, title: 'The catalog just changed', body: 'It was updating while this loaded. Try again.' };
    case 'ACTIVE_SYNC':
    case 'ACTIVE_WORK':
      return { code, title: 'A download is already running', body: 'A download is already running. This starts when that one finishes.' };
    case 'NOT_FOUND':
      return { code, title: 'Not found', body: 'This item doesn’t exist anymore. It may have been deleted.' };
    case 'IN_USE':
      return { code, title: 'Can’t delete yet', body: typeof dependent === 'number' ? `It’s still used by ${dependent} ${dependent === 1 ? 'card' : 'cards'}.` : 'It’s still in use.' };
    case 'CONFLICT':
      return { code, title: 'Already exists', body: 'You already have one with that name.' };
    case 'STALE_PREVIEW':
      return { code, title: 'Your collection changed', body: 'Preview again to see the latest.' };
    case 'PREVIEW_EXPIRED':
      return { code, title: 'Preview expired', body: 'Import previews last 30 minutes, restore previews 10. Choose the file again.' };
    case 'IMPORT_INVALID':
    case 'INVALID_JSON':
    case 'INVALID_CSV':
      return { code, title: 'This file can’t be imported', body: 'It isn’t a FlashyDex JSON export or a CSV with the expected columns.' };
    case 'BACKUP_INVALID':
      return { code, title: 'This backup can’t be used', body: 'It isn’t a FlashyDex backup, or it’s damaged. Your data is unchanged.' };
    case 'BACKUP_VERSION_UNSUPPORTED':
      return { code, title: 'This backup needs a newer FlashyDex', body: 'It was made by a newer version of the app. Update FlashyDex, then try again. Your data is unchanged.' };
    case 'ALREADY_RESTORED':
      return { code, title: 'Already restored', body: 'This backup was already restored. Choose the file again to restore it once more.' };
    case 'SIZE_LIMIT':
    case 'PAYLOAD_TOO_LARGE':
      return { code, title: 'File too large', body: 'The limit is 25 MB for imports and 512 MB for backups.' };
    case 'FILE_IO':
    case 'SHARE_FAILED':
      return { code, title: 'Couldn’t share the file', body: 'Try again. If it keeps failing, restart FlashyDex.' };
    case 'UNSUPPORTED_CAPABILITY':
      return { code, title: 'Not available on this device', body: errorMessage(error) };
    case 'PACK_HASH_MISMATCH':
    case 'PACK_SIZE_MISMATCH':
      return { code, title: 'The download was damaged', body: 'It wasn’t installed. Your current catalog is unchanged.' };
    case 'PACK_INVALID':
    case 'APP_UPDATE_REQUIRED':
      return { code, title: 'Update FlashyDex', body: 'This catalog needs a newer version of the app.' };
    case 'INSTANCE_LOCK':
      return { code, title: 'Editing is off in this tab', body: 'Close the other tab, then reload this one.' };
    case 'VALIDATION_ERROR':
      return { code, title: 'Check the highlighted fields', body: 'Fix the fields marked above.' };
    default:
      return { code, title: 'Something went wrong', body: 'Try again.' };
  }
}

export const isCancelled = (e: unknown): boolean => errorCode(e) === 'CANCELLED';

/** UX.md §12: friendly copy first, the machine code (and message) under "Details" so a failure is never opaque. */
export function describeError(error: unknown): ErrorCopy {
  const base = baseCopy(error);
  const code = base.code;
  const message = error instanceof Error ? error.message : typeof error === 'string' ? error : '';
  // Only typed errors expose their message under "Details"; an untyped error is a raw driver/runtime string and is never rendered.
  const detail = code ? `${code}${message ? `: ${message}` : ''}` : null;
  return { ...base, detail: detail ? detail.slice(0, 300) : null };
}
