/**
 * Worker protocol v1 (WEB-STORAGE §3 "Messages"). Pure types + helpers shared by the client (main thread) and the worker core.
 * Nothing here touches SQLite or OPFS. No SQL text, bind values or rows ever appear in an error.
 */
import { WebStorageError, WEB_STORAGE_PROTOCOL, type CommitState, type WebStorageErrorCode } from '../web-storage/contract';

export const PROTOCOL = WEB_STORAGE_PROTOCOL;

export type WorkerOp =
  | 'init'
  | 'open'
  | 'exec'
  | 'batch'
  | 'durableBarrier'
  | 'reopen'
  | 'close'
  | 'cancel'
  | 'stageImport'
  | 'importBytes'
  | 'storageStats'
  | 'shutdown'
  | 'unlink'
  | 'list'
  | 'ensureCapacity'
  | 'fault' // DEV only
  | 'exportFile'; // DEV only (tests export a DB to seed the legacy IndexedDB)

export type ProxyMethod = 'run' | 'all' | 'values' | 'get';

export interface Statement {
  sql: string;
  params: unknown[];
  method: ProxyMethod;
}

export interface RequestEnvelope {
  protocol: typeof PROTOCOL;
  sessionId: string;
  requestId: number;
  op: WorkerOp;
  dbId?: number;
  expectedGeneration?: number;
  payload: unknown;
}

export interface WireError {
  code: WebStorageErrorCode;
  message: string;
  sqliteCode?: number;
  retryable: boolean;
  commitState: CommitState;
  /** Authoritative connection state after a failed statement (lets the client keep transaction ownership exact). */
  inTransaction?: boolean;
}

export interface Timings {
  /** Milliseconds spent executing inside the worker (monotonic worker clock). */
  execMs: number;
}

export type ResponseEnvelope =
  | { kind: 'response'; protocol: typeof PROTOCOL; sessionId: string; requestId: number; ok: true; payload: unknown; timings: Timings }
  | { kind: 'response'; protocol: typeof PROTOCOL; sessionId: string; requestId: number; ok: false; error: WireError; timings: Timings };

export interface ProgressMessage {
  kind: 'progress';
  sessionId: string;
  requestId: number;
  bytes: number;
}

export interface ReadyMessage {
  kind: 'ready';
  protocol: typeof PROTOCOL;
}

export type WorkerMessage = ResponseEnvelope | ProgressMessage | ReadyMessage;

// ───────────────────────── payloads ─────────────────────────
export interface InitPayload {
  protocol: number;
  /** DEV-only fault seam (ignored in production builds). */
  fault?: FaultSpec;
}

export interface InitResult {
  sqliteVersion: string;
  capacity: number;
  fileCount: number;
  wasmMemoryBytes: number | null;
  timings: { poolReadyMs: number; probeMs: number };
}

export interface OpenPayload {
  path: string;
  mode: 'rw' | 'ro';
  create: boolean;
  role: 'user' | 'catalog' | 'validation';
  cacheKiB: number;
}

export interface OpenResult {
  dbId: number;
  pragmas: Record<string, string | number | null>;
}

export interface ExecResult {
  rows: unknown[];
  inTransaction: boolean;
}

export interface BatchPayload {
  statements: Statement[];
  atomic?: boolean;
}

export interface BatchResult {
  results: { rows: unknown[] }[];
  failedAt: number | null;
  error: WireError | null;
  inTransaction: boolean;
}

export interface StageImportPayload {
  job: string;
  name: string;
  target: string;
  expectedBytes: number;
  expectedSha256: string;
}

export interface ImportBytesPayload {
  target: string;
  bytes: Uint8Array;
  expectedSha256: string;
}

export interface ImportResult {
  bytes: number;
  sha256: string;
  ms: number;
  maxChunkBytes: number;
}

export interface StatsResult {
  capacity: number;
  fileCount: number;
  files: string[];
  openDbs: { dbId: number; path: string; mode: 'rw' | 'ro'; inTransaction: boolean }[];
  wasmMemoryBytes: number | null;
  workerHeapUsedBytes: number | null;
  unavailable: Record<string, string>;
}

/** DEV-only worker fault injection (never honoured when `import.meta.env.DEV` is false). */
export interface FaultSpec {
  /** Fail `init` with INIT_FAILED after the VFS was installed (storage must stay untouched). */
  initFail?: 'after-vfs' | 'before-vfs';
  /** Fail the next streamed import supplier once `afterBytes` bytes were served. 'short' ends the file early; 'stall' never returns. */
  supplier?: { kind: 'short' | 'quota' | 'io' | 'stall'; afterBytes: number };
  /** Delay (ms) after every supplier chunk: widens the window for interleaved USER writes / worker kill. */
  chunkDelayMs?: number;
}

// ───────────────────────── error helpers ─────────────────────────
export function wireError(error: unknown): WireError {
  if (error instanceof WebStorageError) {
    return {
      code: error.code,
      message: error.message,
      sqliteCode: error.details.sqliteCode,
      retryable: error.details.retryable ?? false,
      commitState: error.details.commitState ?? 'not_started'
    };
  }
  return { code: 'IO', message: 'Unexpected storage error', retryable: false, commitState: 'unknown' };
}

export function fromWire(error: WireError): WebStorageError {
  return new WebStorageError(error.code, error.message, { commitState: error.commitState, retryable: error.retryable, sqliteCode: error.sqliteCode });
}

/** Strip anything that can carry user data from an engine message: quoted SQL fragments after `near`, long strings, control chars. */
export function sanitizeMessage(message: string): string {
  return message
    .replace(/^SQLITE_[A-Z0-9_]+:\s*/, '')
    .replace(/^sqlite3 result code \d+:\s*/, '')
    .replace(/near "[^"]*"/g, 'near …')
    .replace(/\p{Cc}+/gu, ' ')
    .slice(0, 200);
}

export const IMPORT_CHUNK_BYTES = 256 * 1024;
export const BATCH_MAX_STATEMENTS = 25;
export const BATCH_MAX_BYTES = 256 * 1024;
