import type { AdapterErrorCode, CatalogStagingFile } from './storage-types';
import type { StartMessage, WorkerIn, WorkerOut } from './worker-protocol';

export class PackInstallError extends Error {
  constructor(readonly code: AdapterErrorCode, message: string, options?: { cause?: unknown }) {
    super(message, options);
    this.name = 'PackInstallError';
  }
}

export type WorkerDone = Extract<WorkerOut, { type: 'done' }>;

export interface RunPackWorkerOptions {
  url: string;
  trustedOrigins: string[];
  expectedCompressedBytes: number;
  expectedUncompressedBytes: number;
  compressedSha256?: string;
  staging: CatalogStagingFile;
  signal?: AbortSignal;
  onProgress?: (compressedBytes: number, decodedBytes: number, pendingBytes: number) => void;
  /** CATALOG-PACKS provisional bounds; tunable only with measured peaks. */
  chunkBytes?: number;
  maxInFlight?: number;
}

/**
 * Runs one streamed download+decode+hash pass in a worker and appends every decoded chunk to `staging`, strictly
 * sequentially and acknowledged. Resolves with the worker's counters and raw SHA-256; the caller verifies against the manifest.
 */
export function runPackWorker(options: RunPackWorkerOptions): Promise<WorkerDone> {
  return new Promise((resolve, reject) => {
    const worker = new Worker(new URL('./pack-install.worker.ts', import.meta.url), { type: 'module' });
    let settled = false;
    let writeChain: Promise<void> = Promise.resolve();
    let writeFailure: unknown;

    const send = (message: WorkerIn) => worker.postMessage(message);
    const finish = (action: () => void) => {
      if (settled) return;
      settled = true;
      options.signal?.removeEventListener('abort', onAbort);
      worker.terminate();
      action();
    };
    const onAbort = () => {
      send({ type: 'cancel' });
      // The worker confirms with `cancelled`; if it is wedged, do not wait forever.
      setTimeout(() => finish(() => reject(new PackInstallError('CANCELLED', 'Install cancelled'))), 2000);
    };
    if (options.signal?.aborted) {
      finish(() => reject(new PackInstallError('CANCELLED', 'Install cancelled')));
      return;
    }
    options.signal?.addEventListener('abort', onAbort, { once: true });

    worker.onmessage = (event: MessageEvent<WorkerOut>) => {
      if (settled) return; // late output after cancel/failure is fenced off
      const message = event.data;
      switch (message.type) {
        case 'progress':
          options.onProgress?.(message.compressedBytes, message.decodedBytes, message.pendingBytes);
          break;
        case 'chunk': {
          const payload = message.base64 ?? (message.bytes ? new Uint8Array(message.bytes) : null);
          if (payload === null) break;
          writeChain = writeChain.then(async () => {
            if (settled || writeFailure) return;
            try {
              await options.staging.append(payload);
              if (!settled) send({ type: 'ack', seq: message.seq });
            } catch (error) {
              writeFailure = error;
              send({ type: 'cancel' });
              finish(() => reject(new PackInstallError('STORAGE_FULL', `Writing the catalog failed: ${error instanceof Error ? error.message : String(error)}`, { cause: error })));
            }
          });
          break;
        }
        case 'done':
          void writeChain.then(() => finish(() => (writeFailure ? undefined : resolve(message))));
          break;
        case 'error':
          finish(() => reject(new PackInstallError(message.code, message.message)));
          break;
        case 'cancelled':
          finish(() => reject(new PackInstallError('CANCELLED', 'Install cancelled')));
          break;
      }
    };
    worker.onerror = (event) => finish(() => reject(new PackInstallError('PACK_INVALID', `Worker failed: ${event.message}`)));

    const start: StartMessage = {
      type: 'start',
      url: options.url,
      trustedOrigins: options.trustedOrigins,
      encoding: options.staging.chunkEncoding,
      expectedCompressedBytes: options.expectedCompressedBytes,
      expectedUncompressedBytes: options.expectedUncompressedBytes,
      compressedSha256: options.compressedSha256,
      maxInFlight: options.maxInFlight ?? 4,
      chunkBytes: options.chunkBytes ?? 256 * 1024
    };
    send(start);
  });
}
