import type { FileRef } from '@flashydex/schemas';

/** docs/API.md "Platform adapter". Core never imports Capacitor/DOM/Node APIs; apps and tests inject an implementation. */
export interface Platform {
  filesystem: {
    pick(input: { kind: 'transfer' | 'backup'; maxBytes: number }): Promise<FileRef | null>;
    read(input: { file: FileRef; maxBytes: number }): Promise<Uint8Array>;
    write(input: { name: string; mime: string; bytes: Uint8Array; area: 'staging' | 'exports' }): Promise<FileRef>;
    remove(input: { file: FileRef }): Promise<void>;
  };
  share(input: { files: FileRef[]; title: string }): Promise<{ outcome: 'shared' | 'downloaded' | 'cancelled' }>;
  haptics(input: { kind: 'selection' | 'success' | 'error' }): Promise<void>;
  http(
    input: { url: string; method: 'GET'; headers: Record<string, string>; timeoutMs: number },
    signal?: AbortSignal
  ): Promise<{ status: number; headers: Record<string, string>; body: unknown }>;
  clock: { now(): string };
  ids: { uuid(): string };
  hash: { sha256(bytes: Uint8Array): Promise<string> };
}

/** Clock + id source used by every service (subset of Platform so tests can inject fixed values). */
export type Environment = Pick<Platform, 'clock' | 'ids'>;
