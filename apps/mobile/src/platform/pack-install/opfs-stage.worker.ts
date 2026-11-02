/// <reference lib="webworker" />
/**
 * OPFS stage worker (Stage F, web only; the native base64 worker is `pack-install.worker.ts`).
 *
 *   phase 1  fetch -> ordinary OPFS file `/flashydex-staging/<job>/pack.zst.part` (sync access handle, explicit offsets, checked writes,
 *            exact compressed byte count, optional compressed SHA-256). The decoder never sees the network.
 *   phase 2  read the staged compressed file back in 64 KiB blocks -> BoundedDecoder (<=32 MiB window, 16 KiB slices) -> decoded
 *            chunks (<=256 KiB) written at explicit offsets into `catalog.db.part`, incremental SHA-256. The decoder writes each chunk
 *            synchronously and acknowledges it at once, so pending output is bounded by the decoder's hard cap (1 MiB here).
 *   phase 3  SQLite header + bytes 18/19 == 1, exact size, SHA-256, flush, close both handles.
 *
 * No `arrayBuffer()`, no Blob, no concatenation of the pack or the database anywhere. The worker removes its job directory on failure.
 */
import { createSHA256 } from 'hash-wasm';
import { STAGED_DB_FILE, STAGED_PACK_FILE, STAGING_ROOT } from '../web-storage/contract';
import { checkedWrite, ShortWriteError, type WritableHandle } from '../web-storage/checked-write';
import type { AdapterErrorCode } from './storage-types';
import type { StageFaults, StageIn, StageOut, StageStartMessage } from './opfs-stage-protocol';
import { BoundedDecodeError, BoundedDecoder } from './bounded-decoder';
import { MAX_WINDOW_BYTES, ZSTD_HEADER_PROBE_BYTES, zstdWindowBytes } from './zstd-header';

class StageFailure extends Error {
  constructor(readonly code: AdapterErrorCode, message: string) {
    super(message);
  }
}

const READ_BLOCK = 64 * 1024;
const IO_CHUNK = 256 * 1024;
const SQLITE_MAGIC = 'SQLite format 3\u0000';

let cancelled = false;
let controller: AbortController | undefined;
let activeDecoder: BoundedDecoder | undefined;

const post = (message: StageOut) => self.postMessage(message);
const epoch = () => performance.timeOrigin + performance.now();
const sleep = (ms: number) => new Promise<void>((resolve) => setTimeout(resolve, ms));

self.addEventListener('message', (event: MessageEvent<StageIn>) => {
  const message = event.data;
  if (message.type === 'cancel') {
    cancelled = true;
    controller?.abort();
    activeDecoder?.wake();
  } else if (message.type === 'start') {
    void run(message);
  }
});

const isQuota = (error: unknown): boolean => error instanceof DOMException && (error.name === 'QuotaExceededError' || error.code === 22);

/** Wraps a raw handle with the DEV fault seams (short write, quota). Production passes `faults = undefined` and gets the raw handle. */
function faulty(handle: FileSystemSyncAccessHandle, faults: StageFaults | undefined, counter: { total: number; shortDone: boolean }): WritableHandle {
  return {
    write(buffer, options) {
      if (faults?.quotaAfterBytes !== undefined && counter.total + buffer.length > faults.quotaAfterBytes) throw new DOMException('Injected quota', 'QuotaExceededError');
      let slice = buffer;
      if (faults?.shortWriteAtByte !== undefined && counter.total + buffer.length > faults.shortWriteAtByte && (faults.shortWritePersistent || !counter.shortDone)) {
        counter.shortDone = true;
        slice = buffer.subarray(0, Math.floor(buffer.length / 2));
      }
      const written = handle.write(slice, options);
      counter.total += written;
      return written;
    }
  };
}

async function run(start: StageStartMessage): Promise<void> {
  cancelled = false;
  controller = new AbortController();
  const faults = import.meta.env.DEV ? start.fault : undefined;
  const handles: FileSystemSyncAccessHandle[] = [];
  const counter = { total: 0, shortDone: false };
  const startedAt = epoch();
  let jobRemoval: (() => Promise<void>) | undefined;
  try {
    if (!/^[a-z0-9-]{6,64}$/.test(start.job)) throw new StageFailure('PACK_INVALID', 'Invalid staging job id');
    const root = await navigator.storage.getDirectory();
    const stagingRoot = await root.getDirectoryHandle(STAGING_ROOT, { create: true });
    const jobDir = await stagingRoot.getDirectoryHandle(start.job, { create: true });
    jobRemoval = async () => { await stagingRoot.removeEntry(start.job, { recursive: true }); };
    const open = async (name: string): Promise<FileSystemSyncAccessHandle> => {
      const file = await jobDir.getFileHandle(name, { create: true });
      const handle = await file.createSyncAccessHandle();
      handles.push(handle);
      handle.truncate(0);
      return handle;
    };
    const checkCancel = () => { if (cancelled) throw new DOMException('cancelled', 'AbortError'); };

    // ───────── phase 1: download -> pack.zst.part
    if (faults?.abortAt === 'download') throw new DOMException('cancelled', 'AbortError');
    const packHandle = await open(STAGED_PACK_FILE);
    const packWriter = faulty(packHandle, faults, counter);
    let response: Response;
    try {
      response = await fetch(start.url, { signal: controller.signal, cache: 'no-store' });
    } catch (error) {
      if (cancelled) throw error;
      throw new StageFailure('HTTP_FAILED', `Network error: ${error instanceof Error ? error.message : String(error)}`);
    }
    const finalOrigin = (() => { try { return new URL(response.url || start.url).origin; } catch { return ''; } })();
    if (!start.trustedOrigins.includes(finalOrigin)) throw new StageFailure('PACK_INVALID', `Pack response came from an untrusted origin (${finalOrigin || 'unknown'})`);
    if (!response.ok || !response.body) throw new StageFailure('HTTP_FAILED', `HTTP ${response.status} ${response.statusText}`);

    const compressedHasher = await createSHA256();
    compressedHasher.init();
    let compressedBytes = 0;
    let header = new Uint8Array(0);
    let headerChecked = false;
    let windowBytes = 0;
    let lastProgress = 0;
    const reader = response.body.getReader();
    for (;;) {
      checkCancel();
      const { done, value } = await reader.read().catch((error: unknown) => {
        if (cancelled) throw error;
        throw new StageFailure('HTTP_FAILED', `Download interrupted: ${error instanceof Error ? error.message : String(error)}`);
      });
      if (done) break;
      if (!value || value.length === 0) continue;
      if (compressedBytes + value.length > start.expectedCompressedBytes) throw new StageFailure('PACK_SIZE_MISMATCH', `Download exceeds the manifest size ${start.expectedCompressedBytes}`);
      if (!headerChecked) {
        const merged = new Uint8Array(header.length + value.length);
        merged.set(header);
        merged.set(value, header.length);
        header = merged;
        if (header.length >= ZSTD_HEADER_PROBE_BYTES) {
          headerChecked = true;
          try { windowBytes = zstdWindowBytes(header); } catch (error) { throw new StageFailure('PACK_INVALID', error instanceof Error ? error.message : String(error)); }
          if (windowBytes > MAX_WINDOW_BYTES) throw new StageFailure('PACK_INVALID', `zstd window ${windowBytes} exceeds the supported ${MAX_WINDOW_BYTES}`);
        }
      }
      for (let offset = 0; offset < value.length; offset += IO_CHUNK) {
        checkedWrite(packWriter, value.subarray(offset, Math.min(value.length, offset + IO_CHUNK)), compressedBytes + offset);
      }
      compressedHasher.update(value);
      compressedBytes += value.length;
      if (faults?.downloadDelayMs) await sleep(faults.downloadDelayMs);
      const now = performance.now();
      if (now - lastProgress >= 250) {
        lastProgress = now;
        post({ type: 'progress', phase: 'download', compressedBytes, decodedBytes: 0, pendingBytes: 0 });
      }
    }
    if (compressedBytes !== start.expectedCompressedBytes) throw new StageFailure('PACK_SIZE_MISMATCH', `Downloaded ${compressedBytes} bytes, manifest says ${start.expectedCompressedBytes}`);
    const compressedSha256 = compressedHasher.digest('hex');
    if (start.compressedSha256 && start.compressedSha256 !== compressedSha256) throw new StageFailure('PACK_HASH_MISMATCH', 'Compressed pack SHA-256 does not match the manifest');
    if (!headerChecked) throw new StageFailure('PACK_INVALID', 'The pack is too short to be a zstd frame');
    packHandle.flush();
    const downloadEnd = epoch();
    post({ type: 'progress', phase: 'download', compressedBytes, decodedBytes: 0, pendingBytes: 0 });

    // ───────── phase 2: staged compressed file -> bounded decode -> catalog.db.part
    checkCancel();
    if (faults?.abortAt === 'decode') throw new DOMException('cancelled', 'AbortError');
    const dbHandle = await open(STAGED_DB_FILE);
    const dbWriter = faulty(dbHandle, faults, counter);
    const decodedHasher = await createSHA256();
    decodedHasher.init();
    let written = 0;
    let maxChunkBytes = 0;
    let maxInFlightObserved = 0;
    const decoder: BoundedDecoder = new BoundedDecoder({
      expectedUncompressedBytes: start.expectedUncompressedBytes,
      chunkBytes: IO_CHUNK,
      sliceBytes: 16 * 1024,
      isCancelled: () => cancelled,
      deliver: () => undefined, // unused: the sync sink below consumes every slice inside the decoder's output callback
      syncSink: (chunk) => {
        // Sync access handle writes are synchronous, so decoded bytes never queue: no relay, no whole-buffer, no copy.
        maxInFlightObserved = 1;
        maxChunkBytes = Math.max(maxChunkBytes, chunk.length);
        decodedHasher.update(chunk);
        checkedWrite(dbWriter, chunk, written);
        written += chunk.length;
      }
    });
    activeDecoder = decoder;
    let consumed = 0;
    let blocks = 0;
    let lastDecodeProgress = 0;
    while (consumed < compressedBytes) {
      checkCancel();
      const block = new Uint8Array(Math.min(READ_BLOCK, compressedBytes - consumed));
      const read = packHandle.read(block, { at: consumed });
      if (read !== block.length) throw new StageFailure('ACTIVATION_FAILED', 'Reading the staged pack failed');
      consumed += read;
      blocks += 1;
      if (blocks % 8 === 0) await sleep(0); // let the message loop deliver `cancel` (microtask-only awaits never yield to it)
      try {
        await decoder.push(block, false);
        if (faults?.decodeDelayMs) await sleep(faults.decodeDelayMs);
      } catch (error) {
        if (error instanceof BoundedDecodeError) throw new StageFailure(error.code, error.message);
        throw error;
      }
      const now = performance.now();
      if (now - lastDecodeProgress >= 250) {
        lastDecodeProgress = now;
        post({ type: 'progress', phase: 'decode', compressedBytes, decodedBytes: decoder.decodedBytes, pendingBytes: decoder.pendingBytes });
      }
    }
    try {
      await decoder.push(new Uint8Array(0), true);
    } catch (error) {
      if (error instanceof BoundedDecodeError) throw new StageFailure(error.code, error.message);
      throw error;
    }
    await decoder.settle();
    const decodeEnd = epoch();
    if (decoder.decodedBytes !== start.expectedUncompressedBytes) throw new StageFailure('PACK_SIZE_MISMATCH', `Decoded ${decoder.decodedBytes} bytes, manifest says ${start.expectedUncompressedBytes}`);
    post({ type: 'progress', phase: 'decode', compressedBytes, decodedBytes: decoder.decodedBytes, pendingBytes: 0 });

    // ───────── phase 3: verify, flush, close
    if (faults?.abortAt === 'verify') throw new DOMException('cancelled', 'AbortError');
    const sha256 = decodedHasher.digest('hex');
    if (sha256 !== start.expectedSha256) throw new StageFailure('PACK_HASH_MISMATCH', 'Decompressed SHA-256 does not match the manifest');
    dbHandle.flush();
    const head = new Uint8Array(20);
    if (dbHandle.read(head, { at: 0 }) !== 20) throw new StageFailure('PACK_INVALID', 'The decoded file is too short to be a SQLite database');
    if (new TextDecoder().decode(head.subarray(0, 16)) !== SQLITE_MAGIC) throw new StageFailure('PACK_INVALID', 'The decoded file is not a SQLite database');
    if (head[18] !== 1 || head[19] !== 1) throw new StageFailure('PACK_INVALID', 'The SQLite file is not in rollback-journal (DELETE) mode');
    for (const handle of handles.splice(0)) handle.close();
    post({ type: 'done', compressedBytes, decodedBytes: decoder.decodedBytes, sha256, compressedSha256, windowBytes, maxChunkBytes, maxInFlightObserved, pendingBytesMax: decoder.pendingBytesMax, timestamps: { start: startedAt, downloadEnd, decodeEnd } });
  } catch (error) {
    for (const handle of handles.splice(0)) { try { handle.close(); } catch { /* already closed */ } }
    await jobRemoval?.().catch(() => undefined);
    if (cancelled || (error instanceof DOMException && error.name === 'AbortError')) post({ type: 'cancelled' });
    else if (error instanceof StageFailure) post({ type: 'error', code: error.code, message: error.message });
    else if (isQuota(error)) post({ type: 'error', code: 'STORAGE_FULL', message: 'The browser storage quota was exceeded while staging the catalog' });
    else if (error instanceof ShortWriteError) post({ type: 'error', code: 'ACTIVATION_FAILED', message: error.message });
    else post({ type: 'error', code: 'PACK_INVALID', message: error instanceof Error ? error.message : String(error) });
  } finally {
    controller = undefined;
    activeDecoder = undefined;
  }
}
