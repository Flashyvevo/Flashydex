import { createHash } from 'node:crypto';
import type { FileRef } from '@flashydex/schemas';
import { PlatformError } from '../errors';
import type { Environment, Platform } from '../platform/platform';

/** In-memory Platform for tests: opaque file registry, no paths, deterministic clock/ids from the injected environment. */
export type MemoryPlatform = Platform & {
  files: Map<string, { ref: FileRef; bytes: Uint8Array }>;
  /** Register bytes as if the user picked them. */
  put(name: string, bytes: Uint8Array | string, mime?: string): FileRef;
  shared: FileRef[][];
  nextPick: FileRef | null;
};

export function createMemoryPlatform(env: Environment): MemoryPlatform {
  const files = new Map<string, { ref: FileRef; bytes: Uint8Array }>();
  const platform: MemoryPlatform = {
    files,
    shared: [],
    nextPick: null,
    clock: env.clock,
    ids: env.ids,
    hash: { sha256: async (bytes) => createHash('sha256').update(bytes).digest('hex') },
    put(name, bytes, mime = 'application/octet-stream') {
      const data = typeof bytes === 'string' ? new TextEncoder().encode(bytes) : bytes;
      const ref: FileRef = { id: env.ids.uuid(), name, mime, size: data.byteLength };
      files.set(ref.id, { ref, bytes: data });
      return ref;
    },
    filesystem: {
      async pick() {
        const next = platform.nextPick;
        platform.nextPick = null;
        return next;
      },
      async read({ file, maxBytes }) {
        const entry = files.get(file.id);
        if (!entry) throw new PlatformError('FILE_IO', 'The file is no longer available');
        if (entry.bytes.byteLength > maxBytes) throw new PlatformError('FILE_IO', 'File too large');
        return entry.bytes;
      },
      async write({ name, mime, bytes }) {
        return platform.put(name, bytes, mime);
      },
      async remove({ file }) {
        files.delete(file.id);
      }
    },
    async share({ files: refs }) {
      platform.shared.push(refs);
      return { outcome: 'downloaded' };
    },
    async haptics() { /* no-op */ },
    async http() {
      throw new PlatformError('HTTP_FAILED', 'No network in tests');
    }
  };
  return platform;
}
