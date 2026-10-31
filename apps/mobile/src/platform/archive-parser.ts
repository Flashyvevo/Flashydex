import { CancelledError, FDX_DEFAULT_LIMITS, parseArchive, type FdxLimits, type ParsedBackup, type Platform } from '@flashydex/core';
import { sha256 } from 'hash-wasm';
import { backupErrorFrom, type ArchiveWorkerRequest, type ArchiveWorkerResponse } from './archive-worker-core';

/** The slice of the Worker API this module uses (tests inject a fake). */
export type WorkerLike = {
  postMessage(message: ArchiveWorkerRequest, transfer?: Transferable[]): void;
  terminate(): void;
  onmessage: ((event: { data: ArchiveWorkerResponse }) => void) | null;
  onerror: ((event: unknown) => void) | null;
  onmessageerror: ((event: unknown) => void) | null;
};
export type ArchiveParserOptions = {
  /** Returns a new worker, or null/throws when workers are unavailable (-> in-thread fallback). */
  createWorker?: () => WorkerLike | null;
  handshakeMs?: number;
};

const defaultCreateWorker = (): WorkerLike | null => {
  if (typeof Worker === 'undefined') return null;
  return new Worker(new URL('./archive.worker.ts', import.meta.url), { type: 'module' }) as unknown as WorkerLike;
};

/**
 * N04: parse a `.fdx` in a dedicated Web Worker (same bounded-slice `parseArchive`). A job = one worker:
 *  1. ping/pong handshake while the bytes are still ours; no worker / handshake timeout / startup error -> in-thread fallback (bytes intact);
 *  2. the buffer is TRANSFERRED (not copied) to the worker;
 *  3. abort -> worker.terminate() (immediately frees its memory) + CancelledError; worker crash -> BACKUP_INVALID.
 */
export function createArchiveParser(options: ArchiveParserOptions = {}): NonNullable<Platform['archiveParser']> {
  const create = options.createWorker ?? defaultCreateWorker;
  const handshakeMs = options.handshakeMs ?? 4000;

  const inThread = (bytes: Uint8Array, limits: FdxLimits): Promise<ParsedBackup> => parseArchive(bytes, (b) => sha256(b), { ...FDX_DEFAULT_LIMITS, ...limits });

  return async ({ bytes, limits, signal }) => {
    if (signal?.aborted) throw new CancelledError();
    const worker = ((): WorkerLike | null => { try { return create(); } catch { return null; } })();
    if (!worker) return inThread(bytes, limits);
    const w = worker;

    return new Promise<ParsedBackup>((resolve, reject) => {
      let settled = false;
      let phase: 'handshake' | 'parsing' = 'handshake';
      const cleanup = () => {
        clearTimeout(timer);
        signal?.removeEventListener('abort', onAbort);
        w.onmessage = null; w.onerror = null; w.onmessageerror = null;
        w.terminate();
      };
      const finish = (fn: () => void) => { if (settled) return; settled = true; cleanup(); fn(); };
      const fallback = () => finish(() => { inThread(bytes, limits).then(resolve, reject); });
      const onAbort = () => finish(() => reject(new CancelledError()));
      signal?.addEventListener('abort', onAbort, { once: true });

      w.onerror = () => (phase === 'handshake' ? fallback() : finish(() => reject(backupErrorFrom('BACKUP_INVALID', 'The backup could not be processed'))));
      w.onmessageerror = w.onerror;
      w.onmessage = (event) => {
        const message = event.data;
        if (phase === 'handshake') {
          if (message.type !== 'pong') return fallback();
          clearTimeout(timer);
          phase = 'parsing';
          const owned = bytes.byteOffset === 0 && bytes.byteLength === bytes.buffer.byteLength;
          const payload = owned ? bytes : bytes.slice();
          w.postMessage({ type: 'parse', bytes: payload, limits }, [payload.buffer as ArrayBuffer]);
          return;
        }
        if (message.type === 'result') finish(() => resolve(message.parsed));
        else if (message.type === 'error') finish(() => reject(backupErrorFrom(message.code, message.message)));
      };
      const timer = setTimeout(fallback, handshakeMs);
      try { w.postMessage({ type: 'ping' }); } catch { fallback(); }
    });
  };
}
