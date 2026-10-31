import type { AdapterErrorCode } from './storage-types';

/** Messages between the main thread (owns Capacitor plugins) and the pack-install worker (fetch + zstd + SHA-256). */
export interface StartMessage {
  type: 'start';
  url: string;
  /** Final `response.url` origin must be one of these (R09); the worker rejects anything else with PACK_INVALID. */
  trustedOrigins: string[];
  /** What the main-thread writer wants: base64 strings (native appendFile) or raw bytes (web store). */
  encoding: 'base64' | 'bytes';
  expectedCompressedBytes: number;
  expectedUncompressedBytes: number;
  compressedSha256?: string;
  /** Max unacknowledged decoded chunks (CATALOG-PACKS: at most 4). */
  maxInFlight: number;
  /** Decoded chunk size handed to the writer (CATALOG-PACKS provisional: <= 256 KiB). */
  chunkBytes: number;
}

export type WorkerIn = StartMessage | { type: 'ack'; seq: number } | { type: 'cancel' };

export type WorkerOut =
  | { type: 'progress'; compressedBytes: number; decodedBytes: number; pendingBytes: number }
  | { type: 'chunk'; seq: number; length: number; bytes?: ArrayBuffer; base64?: string }
  | {
      type: 'done';
      decodedBytes: number;
      compressedBytes: number;
      sha256: string;
      compressedSha256: string;
      windowBytes: number;
      streamMs: number;
      maxInFlightObserved: number;
      maxChunkBytes: number;
      /** High-water mark of decoded bytes queued or posted but not yet acknowledged (R05). */
      pendingBytesMax: number;
    }
  | { type: 'error'; code: AdapterErrorCode; message: string }
  | { type: 'cancelled' };
