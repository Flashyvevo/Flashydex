import { STAGING_ROOT } from './contract';
import { PackInstallError } from '../pack-install/run-worker';
import type { StageFaults, StageIn, StageOut, StageStartMessage } from '../pack-install/opfs-stage-protocol';

/** Main-thread side of the OPFS stage worker + ordinary-OPFS staging directory helpers (`/flashydex-staging/<job>/...`). */

export type StageDone = Extract<StageOut, { type: 'done' }>;

export interface RunOpfsStageOptions {
  job: string;
  url: string;
  trustedOrigins: string[];
  expectedCompressedBytes: number;
  expectedUncompressedBytes: number;
  compressedSha256?: string;
  expectedSha256: string;
  signal?: AbortSignal;
  onProgress?: (phase: 'download' | 'decode', compressedBytes: number, decodedBytes: number, pendingBytes: number) => void;
  fault?: StageFaults;
  chunkBytes?: number;
}

export const newJobId = (): string => {
  const bytes = crypto.getRandomValues(new Uint8Array(10));
  return Array.from(bytes, (b) => b.toString(36).padStart(2, '0')).join('').slice(0, 16);
};

async function stagingRoot(create: boolean): Promise<FileSystemDirectoryHandle | null> {
  const root = await navigator.storage.getDirectory();
  try {
    return await root.getDirectoryHandle(STAGING_ROOT, { create });
  } catch (error) {
    if (error instanceof DOMException && error.name === 'NotFoundError') return null;
    throw error;
  }
}

/** Names of the job directories currently under the staging root. */
export async function listStagingJobs(): Promise<string[]> {
  const directory = await stagingRoot(false);
  if (!directory) return [];
  const jobs: string[] = [];
  for await (const [name, handle] of (directory as unknown as { entries(): AsyncIterable<[string, FileSystemHandle]> }).entries()) {
    if (handle.kind === 'directory') jobs.push(name);
  }
  return jobs;
}

/** Recursively removes one staging job. Idempotent; retries briefly because a just-terminated worker may still hold a handle. */
export async function removeStagingJob(job: string): Promise<void> {
  if (!/^[a-z0-9-]{6,64}$/.test(job)) return;
  const directory = await stagingRoot(false);
  if (!directory) return;
  for (let attempt = 0; attempt < 5; attempt += 1) {
    try {
      await directory.removeEntry(job, { recursive: true });
      return;
    } catch (error) {
      if (error instanceof DOMException && error.name === 'NotFoundError') return;
      if (attempt === 4) throw error;
      await new Promise((resolve) => setTimeout(resolve, 60 * (attempt + 1)));
    }
  }
}

/** Download + decode into OPFS staging (see opfs-stage.worker.ts). Resolves with counters + timestamps; the caller imports/cleans up. */
export function runOpfsStage(options: RunOpfsStageOptions): Promise<StageDone> {
  return new Promise<StageDone>((resolve, reject) => {
    const worker = new Worker(new URL('../pack-install/opfs-stage.worker.ts', import.meta.url), { type: 'module' });
    let settled = false;
    const send = (message: StageIn) => worker.postMessage(message);
    const finish = (action: () => void) => {
      if (settled) return;
      settled = true;
      options.signal?.removeEventListener('abort', onAbort);
      worker.terminate();
      action();
    };
    const onAbort = () => {
      send({ type: 'cancel' });
      setTimeout(() => finish(() => reject(new PackInstallError('CANCELLED', 'Install cancelled'))), 2000);
    };
    if (options.signal?.aborted) {
      finish(() => reject(new PackInstallError('CANCELLED', 'Install cancelled')));
      return;
    }
    options.signal?.addEventListener('abort', onAbort, { once: true });
    worker.onmessage = (event: MessageEvent<StageOut>) => {
      if (settled) return;
      const message = event.data;
      switch (message.type) {
        case 'progress':
          options.onProgress?.(message.phase, message.compressedBytes, message.decodedBytes, message.pendingBytes);
          break;
        case 'done':
          finish(() => resolve(message));
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
    const start: StageStartMessage = {
      type: 'start',
      job: options.job,
      url: options.url,
      trustedOrigins: options.trustedOrigins,
      expectedCompressedBytes: options.expectedCompressedBytes,
      expectedUncompressedBytes: options.expectedUncompressedBytes,
      compressedSha256: options.compressedSha256,
      expectedSha256: options.expectedSha256,
      chunkBytes: options.chunkBytes ?? 256 * 1024,
      fault: import.meta.env.DEV ? options.fault : undefined
    };
    send(start);
  });
}
