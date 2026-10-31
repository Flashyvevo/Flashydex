import type { FileRef } from '@flashydex/schemas';
import type { FdxLimits, ParsedBackup } from '../backup/archive';

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
  /**
   * N04: optional off-main-thread `.fdx` ZIP/JSON parser (the same `parseArchive` run in a Worker). The implementation takes ownership of
   * `bytes` (it may transfer the buffer, leaving the caller's view empty), must honour `signal` (reject `CancelledError`) and must throw
   * the same `BackupError`s as `parseArchive`. When absent core parses on the calling thread.
   */
  archiveParser?(input: { bytes: Uint8Array; limits: FdxLimits; signal?: AbortSignal }): Promise<ParsedBackup>;
  /** Phase-1 image-cache seam (interface only; R13). Optional: platforms without a cache omit it. */
  imageCache?: {
    get(key: string): Promise<Blob | null>;
    put(key: string, value: Blob): Promise<void>;
    clear(): Promise<void>;
  };
}

/** Clock + id source used by every service (subset of Platform so tests can inject fixed values). */
export type Environment = Pick<Platform, 'clock' | 'ids'>;
