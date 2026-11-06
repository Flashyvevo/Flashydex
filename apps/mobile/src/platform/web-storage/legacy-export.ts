import { LEGACY_JEEP } from './contract';

/**
 * Blocked-migration recovery (S5-08, WEB-STORAGE §5): lets the owner save the OLD (pre-Stage-F) collection bytes to a file when the
 * automatic move was refused. Strictly read-only raw IndexedDB: it never opens jeep, never enables the legacy driver, never writes or
 * deletes the legacy key, never touches the new sahpool/role store, and never offers a reset.
 */

/** Hard allocation cap for the export (the automatic migration cap is 16 MiB; export is allowed to be far larger, but not unbounded). */
export const LEGACY_EXPORT_MAX_BYTES = 512 * 1024 * 1024;
export const LEGACY_EXPORT_FILENAME = 'flashydex-old-collection.sqlite';

export type LegacyExportResult =
  | { ok: true; blob: Blob; bytes: number; filename: string }
  | { ok: false; reason: 'none' | 'too_large' | 'unreadable'; message: string };

const fail = (reason: 'none' | 'too_large' | 'unreadable', message: string): LegacyExportResult => ({ ok: false, reason, message });

export function readLegacyForExport(maxBytes: number = LEGACY_EXPORT_MAX_BYTES): Promise<LegacyExportResult> {
  if (typeof indexedDB === 'undefined') return Promise.resolve(fail('unreadable', 'This browser cannot read its saved data.'));
  return new Promise<LegacyExportResult>((resolve) => {
    let request: IDBOpenDBRequest;
    try {
      request = indexedDB.open(LEGACY_JEEP.dbName); // NO version: never upgrades, never creates a store
    } catch {
      resolve(fail('unreadable', 'The old collection could not be opened.'));
      return;
    }
    let existed = true;
    request.onupgradeneeded = (event) => {
      if (event.oldVersion === 0) {
        existed = false;
        request.transaction?.abort(); // it did not exist: do not leave an empty database behind
      }
    };
    request.onerror = () => resolve(existed ? fail('unreadable', 'The old collection could not be opened.') : fail('none', 'No old collection was found in this browser.'));
    request.onblocked = () => undefined;
    request.onsuccess = () => {
      const db = request.result;
      if (!db.objectStoreNames.contains(LEGACY_JEEP.storeName)) {
        db.close();
        resolve(fail('none', 'No old collection was found in this browser.'));
        return;
      }
      let get: IDBRequest;
      try {
        get = db.transaction(LEGACY_JEEP.storeName, 'readonly').objectStore(LEGACY_JEEP.storeName).get(LEGACY_JEEP.userKey);
      } catch {
        db.close();
        resolve(fail('unreadable', 'The old collection could not be read.'));
        return;
      }
      get.onerror = () => {
        db.close();
        resolve(fail('unreadable', 'The old collection could not be read.'));
      };
      get.onsuccess = () => {
        db.close();
        const value: unknown = get.result;
        if (value === undefined || value === null) resolve(fail('none', 'No old collection was found in this browser.'));
        else if (value instanceof Blob) resolve(value.size > maxBytes ? fail('too_large', 'The old collection is too large to export from here.') : { ok: true, blob: value, bytes: value.size, filename: LEGACY_EXPORT_FILENAME });
        else if (value instanceof ArrayBuffer || ArrayBuffer.isView(value)) {
          const bytes = value.byteLength;
          if (bytes > maxBytes) resolve(fail('too_large', 'The old collection is too large to export from here.'));
          else resolve({ ok: true, blob: new Blob([value as BlobPart], { type: 'application/vnd.sqlite3' }), bytes, filename: LEGACY_EXPORT_FILENAME });
        } else resolve(fail('unreadable', 'The old collection is in a format this build can’t export.'));
      };
    };
  });
}

/** Hands a blob to the browser as a download (anchor + object URL). */
export function downloadBlob(blob: Blob, filename: string): void {
  const url = URL.createObjectURL(blob);
  const a = document.createElement('a');
  a.href = url;
  a.download = filename;
  a.rel = 'noopener';
  document.body.appendChild(a);
  a.click();
  a.remove();
  setTimeout(() => URL.revokeObjectURL(url), 60_000);
}
