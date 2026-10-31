import { Capacitor } from '@capacitor/core';
import { Directory, Filesystem } from '@capacitor/filesystem';
import { Haptics, ImpactStyle, NotificationType } from '@capacitor/haptics';
import { Share } from '@capacitor/share';
import { PlatformError, SizeLimitError, type FileRef, type Platform } from '@flashydex/core';
import { sha256 } from 'hash-wasm';
import localforage from 'localforage';
import { uuidV4 } from '../lib/uuid';

/**
 * Capacitor / web implementation of core's `Platform` (docs/API.md "Platform adapter").
 *  - Files are opaque registry entries. Bytes live in a private IndexedDB store (works in the WKWebView and the browser).
 *    Exports are additionally written to the native cache directory so the share sheet gets a real file URI.
 *  - Web "share" is a Blob download (anchor + revoked object URL); Web Share is not required.
 *  - A picked file's name never becomes a path.
 */
const store = localforage.createInstance({ name: 'flashydex-files', storeName: 'files' });
const isNative = () => Capacitor.getPlatform() !== 'web';
const registry = new Map<string, { name: string; mime: string; area: 'staging' | 'exports' | 'picked' }>();

const toBase64 = async (bytes: Uint8Array): Promise<string> => {
  const dataUrl = await new Promise<string>((resolve, reject) => {
    const reader = new FileReader();
    reader.onload = () => resolve(reader.result as string);
    reader.onerror = () => reject(reader.error ?? new Error('FileReader failed'));
    reader.readAsDataURL(new Blob([bytes as BlobPart]));
  });
  return dataUrl.slice(dataUrl.indexOf(',') + 1);
};

const ALLOWED_HTTP_HOSTS = new Set(['api.tcgdex.net', 'assets.tcgdex.net']);

async function pickBytes(accept: string): Promise<{ name: string; mime: string; bytes: Uint8Array } | null> {
  return new Promise((resolve, reject) => {
    const input = document.createElement('input');
    input.type = 'file';
    input.accept = accept;
    input.style.display = 'none';
    let settled = false;
    const finish = (value: { name: string; mime: string; bytes: Uint8Array } | null, error?: unknown) => {
      if (settled) return;
      settled = true;
      input.remove();
      if (error) reject(error);
      else resolve(value);
    };
    input.addEventListener('change', async () => {
      const file = input.files?.[0];
      if (!file) return finish(null);
      try {
        finish({ name: file.name, mime: file.type, bytes: new Uint8Array(await file.arrayBuffer()) });
      } catch {
        finish(null, new PlatformError('FILE_IO', 'The selected file could not be read'));
      }
    });
    input.addEventListener('cancel', () => finish(null)); // picker dismissed: no plan, no writes
    document.body.appendChild(input);
    input.click();
  });
}

export const platform: Platform = {
  clock: { now: () => new Date().toISOString() },
  ids: { uuid: () => uuidV4() },
  hash: { sha256: (bytes) => sha256(bytes) },

  filesystem: {
    async pick({ kind, maxBytes }) {
      const picked = await pickBytes(kind === 'backup' ? '.fdx,application/zip,application/octet-stream' : '.json,.csv,application/json,text/csv,text/plain');
      if (!picked) return null;
      if (picked.bytes.byteLength > maxBytes) throw new SizeLimitError('The selected file is too large', { maxBytes });
      const id = uuidV4();
      await store.setItem(id, picked.bytes);
      const safeName = picked.name.replace(/[^\p{L}\p{N}._ -]/gu, '_').slice(0, 200) || 'file';
      registry.set(id, { name: safeName, mime: picked.mime.slice(0, 100), area: 'picked' });
      return { id, name: safeName, mime: picked.mime.slice(0, 100), size: picked.bytes.byteLength };
    },
    async read({ file, maxBytes }) {
      const entry = registry.get(file.id);
      const bytes = await store.getItem<Uint8Array>(file.id);
      if (!entry || !bytes) throw new PlatformError('FILE_IO', 'The file is no longer available');
      if (bytes.byteLength > maxBytes) throw new SizeLimitError('File is too large', { maxBytes });
      if (bytes.byteLength !== file.size) throw new PlatformError('FILE_IO', 'The file changed on disk');
      return bytes;
    },
    async write({ name, mime, bytes, area }) {
      const id = uuidV4();
      try {
        await store.setItem(id, bytes);
        if (isNative() && area === 'exports') {
          await Filesystem.writeFile({ path: `flashydex/exports/${name}`, directory: Directory.Cache, data: await toBase64(bytes), recursive: true });
        }
      } catch {
        throw new PlatformError('FILE_IO', 'The file could not be written');
      }
      registry.set(id, { name, mime, area });
      return { id, name, mime, size: bytes.byteLength };
    },
    async remove({ file }) {
      const entry = registry.get(file.id);
      registry.delete(file.id);
      await store.removeItem(file.id).catch(() => undefined);
      if (entry && isNative() && entry.area === 'exports') {
        await Filesystem.deleteFile({ path: `flashydex/exports/${entry.name}`, directory: Directory.Cache }).catch(() => undefined);
      }
    }
  },

  async share({ files, title }) {
    try {
      if (isNative()) {
        const uris: string[] = [];
        for (const file of files) {
          const entry = registry.get(file.id);
          if (!entry) throw new PlatformError('SHARE_FAILED', 'The file is no longer available');
          uris.push((await Filesystem.getUri({ path: `flashydex/exports/${entry.name}`, directory: Directory.Cache })).uri);
        }
        await Share.share({ title, files: uris });
        return { outcome: 'shared' };
      }
      for (const file of files) {
        const entry = registry.get(file.id);
        const bytes = await store.getItem<Uint8Array>(file.id);
        if (!entry || !bytes) throw new PlatformError('SHARE_FAILED', 'The file is no longer available');
        const url = URL.createObjectURL(new Blob([bytes as BlobPart], { type: entry.mime || 'application/octet-stream' }));
        const anchor = document.createElement('a');
        anchor.href = url;
        anchor.download = entry.name;
        document.body.appendChild(anchor);
        anchor.click();
        anchor.remove();
        setTimeout(() => URL.revokeObjectURL(url), 10_000);
      }
      return { outcome: 'downloaded' };
    } catch (error) {
      if (error instanceof PlatformError) throw error;
      // The iOS share sheet rejects when the user dismisses it: that is a cancel, not a failure.
      if (error instanceof Error && /cancel/i.test(error.message)) return { outcome: 'cancelled' };
      throw new PlatformError('SHARE_FAILED', 'Sharing failed');
    }
  },

  async haptics({ kind }) {
    if (!isNative()) return; // best effort, post-commit only
    try {
      if (kind === 'selection') await Haptics.impact({ style: ImpactStyle.Light });
      else await Haptics.notification({ type: kind === 'success' ? NotificationType.Success : NotificationType.Error });
    } catch { /* haptic failure never turns a saved copy into a failed save */ }
  },

  async http({ url, headers, timeoutMs }, signal) {
    const target = new URL(url);
    if (target.protocol !== 'https:' || !ALLOWED_HTTP_HOSTS.has(target.hostname)) throw new PlatformError('HTTP_FAILED', 'This host is not allowed');
    const timeout = new AbortController();
    const timer = setTimeout(() => timeout.abort(), timeoutMs);
    const onAbort = () => timeout.abort();
    signal?.addEventListener('abort', onAbort, { once: true });
    try {
      const response = await fetch(url, { method: 'GET', headers, signal: timeout.signal });
      const out: Record<string, string> = {};
      response.headers.forEach((value, key) => { out[key.toLowerCase()] = value; });
      const body = response.status === 304 || response.status === 204 ? null : await response.json().catch(() => null);
      return { status: response.status, headers: out, body };
    } catch {
      throw new PlatformError('HTTP_FAILED', signal?.aborted ? 'Cancelled' : 'The request failed');
    } finally {
      clearTimeout(timer);
      signal?.removeEventListener('abort', onAbort);
    }
  }
};

export type { FileRef };
