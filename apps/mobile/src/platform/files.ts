import { Capacitor } from '@capacitor/core';
import { Directory, Encoding, Filesystem } from '@capacitor/filesystem';
import type { PlatformFiles } from '@flashydex/core';
import { createSHA256 } from 'hash-wasm';
import { PackInstallError, getCatalogStorage } from './pack-install';

/**
 * Generic file primitives behind core's `PlatformFiles`. The catalog install itself does NOT go through these: it streams
 * download -> zstd decode -> SHA-256 -> staged file in one worker pass (`installCatalogPack`), which is what CATALOG-PACKS requires.
 * Native only; on web there is no file system, so the file methods throw UNSUPPORTED_CAPABILITY instead of faking it.
 */
const SCRATCH_ROOT = 'flashydex/packs';
const isNative = () => Capacitor.getPlatform() !== 'web';
const scratchDirectory = () => (Capacitor.getPlatform() === 'ios' ? Directory.LibraryNoCloud : Directory.Library);

function requireNative(what: string): void {
  if (!isNative()) throw new PackInstallError('UNSUPPORTED_CAPABILITY', `${what} needs a native file system; the web build installs packs through installCatalogPack`);
}

async function toBase64(bytes: Uint8Array): Promise<string> {
  const dataUrl = await new Promise<string>((resolve, reject) => {
    const reader = new FileReader();
    reader.onload = () => resolve(reader.result as string);
    reader.onerror = () => reject(reader.error ?? new Error('FileReader failed'));
    reader.readAsDataURL(new Blob([bytes as BlobPart]));
  });
  return dataUrl.slice(dataUrl.indexOf(',') + 1);
}

export const platformFiles: PlatformFiles = {
  async download(url, destination, onProgress, signal) {
    requireNative('download');
    const response = await fetch(url, { signal });
    if (!response.ok || !response.body) throw new PackInstallError('HTTP_FAILED', `HTTP ${response.status}`);
    const totalBytes = Number(response.headers.get('content-length')) || null;
    const path = `${SCRATCH_ROOT}/${destination}`;
    await Filesystem.mkdir({ path: SCRATCH_ROOT, directory: scratchDirectory(), recursive: true }).catch(() => undefined);
    await Filesystem.writeFile({ path, directory: scratchDirectory(), data: '', encoding: Encoding.UTF8 });
    const reader = response.body.getReader();
    let receivedBytes = 0;
    for (;;) {
      const { done, value } = await reader.read();
      if (done) break;
      await Filesystem.appendFile({ path, directory: scratchDirectory(), data: await toBase64(value) });
      receivedBytes += value.byteLength;
      onProgress({ receivedBytes, totalBytes });
    }
    return { bytes: receivedBytes, contentType: response.headers.get('content-type') };
  },

  async decodeZstdToFile() {
    throw new PackInstallError('UNSUPPORTED_CAPABILITY', 'Use installCatalogPack: it streams download, zstd decode and SHA-256 in one worker pass');
  },

  async sha256File(path) {
    requireNative('sha256File');
    const { uri } = await Filesystem.getUri({ path: `${SCRATCH_ROOT}/${path}`, directory: scratchDirectory() });
    const response = await fetch(Capacitor.convertFileSrc(uri)); // WebView streams local files; unverified on device (ios-notes.md)
    if (!response.ok || !response.body) throw new PackInstallError('HTTP_FAILED', `Cannot read ${path}`);
    const hasher = await createSHA256();
    hasher.init();
    const reader = response.body.getReader();
    for (;;) {
      const { done, value } = await reader.read();
      if (done) break;
      hasher.update(value);
    }
    return hasher.digest('hex');
  },

  async atomicRename(source, destination) {
    requireNative('atomicRename');
    await Filesystem.rename({ from: `${SCRATCH_ROOT}/${source}`, to: `${SCRATCH_ROOT}/${destination}`, directory: scratchDirectory(), toDirectory: scratchDirectory() });
  },

  async availableBytes() {
    return getCatalogStorage().availableBytes();
  },

  // Phase 7 implements the bounded LRU image cache; the interface exists so core can depend on it now.
  imageCache: {
    async get() { return null; },
    async put() { /* Phase 7 */ },
    async clear() { /* Phase 7 */ }
  }
};
