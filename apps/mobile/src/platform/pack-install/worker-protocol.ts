import type { PackInstallErrorCode } from '@flashydex/core';

/** Messages between the main thread (owns Capacitor plugins) and the pack-install worker (fetch + zstd + SHA-256). */
export interface StartMessage {
  type: 'start';
  url: string;
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
  | { type: 'progress'; compressedBytes: number; decodedBytes: number }
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
    }
  | { type: 'error'; code: PackInstallErrorCode; message: string }
  | { type: 'cancelled' };
