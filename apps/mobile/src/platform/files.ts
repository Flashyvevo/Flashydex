import { Directory, Filesystem } from '@capacitor/filesystem';
import type { PlatformFiles } from '@flashydex/core';
import { installCatalogPack, readTemporaryPack } from './pack-install/installer';

const scratchPrefix = 'flashydex/packs/';

function toBase64(bytes: Uint8Array): string {
  let binary = '';
  for (let index = 0; index < bytes.byteLength; index += 0x8000) binary += String.fromCharCode(...bytes.subarray(index, index + 0x8000));
  return btoa(binary);
}

export const platformFiles: PlatformFiles = {
  async download(url, destination, onProgress, signal) {
    const response = await fetch(url, { signal });
    if (!response.ok || !response.body) throw new Error(`Download failed: ${response.status}`);
    const totalBytes = Number(response.headers.get('content-length')) || null;
    let receivedBytes = 0;
    const chunks: Uint8Array[] = [];
    const reader = response.body.getReader();
    while (true) {
      const { done, value } = await reader.read();
      if (done) break;
      if (!value) continue;
      chunks.push(value);
      receivedBytes += value.byteLength;
      onProgress({ receivedBytes, totalBytes });
    }
    await Filesystem.writeFile({ path: `${scratchPrefix}${destination}`, data: toBase64(new Blob(chunks) as never), directory: Directory.Data, recursive: true });
    return { bytes: receivedBytes, contentType: response.headers.get('content-type') };
  },
  async decodeZstdToFile(source, destination, signal) {
    const result = await installCatalogPack(source, `${scratchPrefix}${destination}`, () => {}, signal);
    return { bytes: result.bytes, sha256: result.sha256 };
  },
  async sha256File(path) {
    const blob = await readTemporaryPack(`${scratchPrefix}${path}`);
    const digest = await crypto.subtle.digest('SHA-256', await blob.arrayBuffer());
    return Array.from(new Uint8Array(digest), (part) => part.toString(16).padStart(2, '0')).join('');
  },
  async atomicRename(source, destination) {
    await Filesystem.rename({ from: `${scratchPrefix}${source}`, to: `${scratchPrefix}${destination}`, directory: Directory.Data });
  },
  async availableBytes() { return null; },
  imageCache: {
    async get() { return null; },
    async put() { /* Phase 7 bounded LRU implementation */ },
    async clear() { /* Phase 7 bounded LRU implementation */ }
  }
};
