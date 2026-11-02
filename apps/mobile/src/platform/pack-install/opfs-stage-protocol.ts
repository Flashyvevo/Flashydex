import type { AdapterErrorCode } from './storage-types';

/** Fault seams for the OPFS stage worker. Only ever populated in DEV builds (main thread passes nothing in production; the worker ignores it). */
export interface StageFaults {
  /** The raw write that crosses this total-written-bytes offset returns short (half), once or on every retry. */
  shortWriteAtByte?: number;
  shortWritePersistent?: boolean;
  /** Throw QuotaExceededError once this many bytes were written across both staged files. */
  quotaAfterBytes?: number;
  /** Behave as if the user cancelled when the phase begins. */
  abortAt?: 'download' | 'decode' | 'verify';
  /** Sleep per received network chunk / per decoded chunk (lets e2e tests kill the page at a known phase). */
  downloadDelayMs?: number;
  decodeDelayMs?: number;
}

export interface StageStartMessage {
  type: 'start';
  job: string;
  url: string;
  /** Final `response.url` origin must be one of these (R09). */
  trustedOrigins: string[];
  expectedCompressedBytes: number;
  expectedUncompressedBytes: number;
  compressedSha256?: string;
  /** SHA-256 of the decoded SQLite file (manifest `sha256`). */
  expectedSha256: string;
  chunkBytes: number;
  fault?: StageFaults;
}

export type StageIn = StageStartMessage | { type: 'cancel' };

export type StageOut =
  | { type: 'progress'; phase: 'download' | 'decode'; compressedBytes: number; decodedBytes: number; pendingBytes: number }
  | {
      type: 'done';
      compressedBytes: number;
      decodedBytes: number;
      sha256: string;
      compressedSha256: string;
      windowBytes: number;
      maxChunkBytes: number;
      /** Max decoded chunks queued or written-but-unacknowledged (the decoder writes synchronously, so this is 1 in practice). */
      maxInFlightObserved: number;
      pendingBytesMax: number;
      /** timeOrigin + performance.now() epoch milliseconds, comparable across contexts. */
      timestamps: { start: number; downloadEnd: number; decodeEnd: number };
    }
  | { type: 'error'; code: AdapterErrorCode; message: string }
  | { type: 'cancelled' };
