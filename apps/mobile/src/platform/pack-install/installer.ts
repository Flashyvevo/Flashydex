import { Directory, Filesystem } from '@capacitor/filesystem';
import { Capacitor } from '@capacitor/core';

export type InstallProgress = { receivedBytes: number; totalBytes: number | null; writtenBytes: number };
export type InstalledPack = { bytes: number; sha256: string; temporaryPath: string };

type WorkerMessage =
  | { type: 'progress'; receivedBytes: number; totalBytes: number | null }
  | { type: 'chunk'; chunk: ArrayBuffer; final: boolean; uncompressedBytes: number }
  | { type: 'complete'; bytes: number; sha256: string; compressedBytes: number }
  | { type: 'aborted'; message: string }
  | { type: 'error'; message: string };

const webFiles = new Map<string, Blob[]>();

function base64(bytes: Uint8Array): string {
  let binary = '';
  const block = 0x8000;
  for (let index = 0; index < bytes.byteLength; index += block) binary += String.fromCharCode(...bytes.subarray(index, index + block));
  return btoa(binary);
}

async function resetFile(path: string): Promise<void> {
  if (Capacitor.getPlatform() === 'web') {
    webFiles.set(path, []);
    return;
  }
  try { await Filesystem.deleteFile({ path, directory: Directory.Data }); } catch { /* not yet present */ }
}

async function append(path: string, chunk: Uint8Array): Promise<void> {
  if (Capacitor.getPlatform() === 'web') {
    webFiles.get(path)?.push(new Blob([chunk]));
    return;
  }
  await Filesystem.appendFile({ path, data: base64(chunk), directory: Directory.Data });
}

export async function readTemporaryPack(path: string): Promise<Blob> {
  if (Capacitor.getPlatform() === 'web') return new Blob(webFiles.get(path) ?? []);
  const result = await Filesystem.readFile({ path, directory: Directory.Data });
  if (typeof result.data !== 'string') return result.data;
  const decoded = atob(result.data);
  return new Blob([Uint8Array.from(decoded, (character) => character.charCodeAt(0))]);
}

/** Downloads, verifies and writes a zstd pack without putting its decoded bytes on the UI thread. */
export function installCatalogPack(url: string, temporaryPath: string, onProgress: (progress: InstallProgress) => void, signal?: AbortSignal): Promise<InstalledPack> {
  return new Promise(async (resolve, reject) => {
    await resetFile(temporaryPath);
    const worker = new Worker(new URL('./pack-install.worker.ts', import.meta.url), { type: 'module' });
    let writtenBytes = 0;
    const abort = () => worker.postMessage({ type: 'cancel' });
    signal?.addEventListener('abort', abort, { once: true });
    worker.onmessage = async (event: MessageEvent<WorkerMessage>) => {
      try {
        const message = event.data;
        if (message.type === 'progress') {
          onProgress({ ...message, writtenBytes });
        } else if (message.type === 'chunk') {
          const chunk = new Uint8Array(message.chunk);
          await append(temporaryPath, chunk);
          writtenBytes += chunk.byteLength;
        } else if (message.type === 'complete') {
          worker.terminate();
          resolve({ bytes: message.bytes, sha256: message.sha256, temporaryPath });
        } else {
          worker.terminate();
          reject(new Error(message.message));
        }
      } catch (error) {
        worker.terminate();
        reject(error);
      } finally {
        signal?.removeEventListener('abort', abort);
      }
    };
    worker.onerror = (event) => { worker.terminate(); reject(new Error(event.message)); };
    worker.postMessage({ type: 'start', url });
  });
}
