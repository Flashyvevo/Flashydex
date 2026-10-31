/// <reference lib="webworker" />
/**
 * Pack-install worker: fetch (progress + abort) -> incremental zstd decode (fzstd) -> incremental SHA-256 (hash-wasm)
 * -> bounded, acknowledged chunks for the main-thread writer. Never holds the decoded catalog.
 *
 * Capacitor plugins are NOT available here; the main thread owns file writes and acknowledges every chunk
 * (at most `maxInFlight` unacknowledged). docs/CATALOG-PACKS.md "Device installer state machine and file protocol".
 */
import { createSHA256 } from 'hash-wasm';
import type { AdapterErrorCode } from './storage-types';
import type { StartMessage, WorkerIn, WorkerOut } from './worker-protocol';
import { BoundedDecodeError, BoundedDecoder } from './bounded-decoder';
import { MAX_WINDOW_BYTES, ZSTD_HEADER_PROBE_BYTES, zstdWindowBytes } from './zstd-header';

class WorkerFailure extends Error {
  constructor(readonly code: AdapterErrorCode, message: string) {
    super(message);
  }
}

let controller: AbortController | undefined;
let cancelled = false;
let acked = 0;
let ackWaiter: (() => void) | undefined;
let activeDecoder: BoundedDecoder | undefined;
const chunkLengths = new Map<number, number>();

function post(message: WorkerOut, transfer: Transferable[] = []): void {
  self.postMessage(message, transfer);
}

self.addEventListener('message', (event: MessageEvent<WorkerIn>) => {
  const message = event.data;
  if (message.type === 'cancel') {
    cancelled = true;
    controller?.abort();
    ackWaiter?.();
    activeDecoder?.wake();
  } else if (message.type === 'ack') {
    acked += 1;
    const length = chunkLengths.get(message.seq);
    chunkLengths.delete(message.seq);
    if (length !== undefined) activeDecoder?.ack(length);
    ackWaiter?.();
  } else if (message.type === 'start') {
    void run(message);
  }
});

/** Native base64 encoding off the main thread (FileReader), falling back to a btoa loop. */
async function toBase64(bytes: Uint8Array): Promise<string> {
  if (typeof FileReader !== 'undefined') {
    const dataUrl = await new Promise<string>((resolve, reject) => {
      const reader = new FileReader();
      reader.onload = () => resolve(reader.result as string);
      reader.onerror = () => reject(reader.error ?? new Error('FileReader failed'));
      reader.readAsDataURL(new Blob([bytes as BlobPart]));
    });
    return dataUrl.slice(dataUrl.indexOf(',') + 1);
  }
  let binary = '';
  for (let index = 0; index < bytes.byteLength; index += 0x8000) binary += String.fromCharCode(...bytes.subarray(index, index + 0x8000));
  return btoa(binary);
}

async function run(start: StartMessage): Promise<void> {
  controller = new AbortController();
  cancelled = false;
  acked = 0;
  let sent = 0;
  let maxInFlightObserved = 0;
  let maxChunkBytes = 0;
  try {
    const started = performance.now();
    let response: Response;
    try {
      response = await fetch(start.url, { signal: controller.signal, cache: 'no-store' });
    } catch (error) {
      if (cancelled) throw error;
      throw new WorkerFailure('HTTP_FAILED', `Network error: ${error instanceof Error ? error.message : String(error)}`);
    }
    const finalOrigin = (() => { try { return new URL(response.url || start.url).origin; } catch { return ''; } })();
    if (!start.trustedOrigins.includes(finalOrigin)) throw new WorkerFailure('PACK_INVALID', `Pack response came from an untrusted origin (${finalOrigin || 'unknown'})`);
    if (!response.ok || !response.body) throw new WorkerFailure('HTTP_FAILED', `HTTP ${response.status} ${response.statusText}`);

    const decodedHasher = await createSHA256();
    decodedHasher.init();
    const compressedHasher = await createSHA256();
    compressedHasher.init();

    let compressedBytes = 0;
    let windowBytes = 0;
    let header = new Uint8Array(0);
    let headerChecked = false;
    let lastProgress = 0;

    const deliver = async (chunk: Uint8Array): Promise<void> => {
      decodedHasher.update(chunk);
      while (sent - acked >= start.maxInFlight) {
        await new Promise<void>((resolve) => { ackWaiter = resolve; });
        ackWaiter = undefined;
        if (cancelled) throw new DOMException('cancelled', 'AbortError');
      }
      const seq = sent;
      sent += 1;
      chunkLengths.set(seq, chunk.length);
      maxInFlightObserved = Math.max(maxInFlightObserved, sent - acked);
      maxChunkBytes = Math.max(maxChunkBytes, chunk.length);
      if (start.encoding === 'base64') {
        post({ type: 'chunk', seq, length: chunk.length, base64: await toBase64(chunk) });
      } else {
        post({ type: 'chunk', seq, length: chunk.length, bytes: chunk.buffer as ArrayBuffer }, [chunk.buffer as ArrayBuffer]);
      }
    };
    const decoder = new BoundedDecoder({
      expectedUncompressedBytes: start.expectedUncompressedBytes, chunkBytes: start.chunkBytes, deliver, isCancelled: () => cancelled
    });
    activeDecoder = decoder;
    const decode = async (input: Uint8Array, final: boolean): Promise<void> => {
      try {
        await decoder.push(input, final);
      } catch (error) {
        if (error instanceof BoundedDecodeError) throw new WorkerFailure(error.code, error.message);
        throw error;
      }
    };

    const reader = response.body.getReader();
    for (;;) {
      const { done, value } = await reader.read().catch((error: unknown) => {
        if (cancelled) throw error;
        throw new WorkerFailure('HTTP_FAILED', `Download interrupted: ${error instanceof Error ? error.message : String(error)}`);
      });
      if (done) break;
      if (!value || value.length === 0) continue;
      compressedBytes += value.length;
      if (compressedBytes > start.expectedCompressedBytes) throw new WorkerFailure('PACK_SIZE_MISMATCH', `Download exceeds the manifest size ${start.expectedCompressedBytes}`);
      if (!headerChecked) {
        const merged = new Uint8Array(header.length + value.length);
        merged.set(header);
        merged.set(value, header.length);
        header = merged;
        if (header.length >= ZSTD_HEADER_PROBE_BYTES) {
          headerChecked = true;
          try { windowBytes = zstdWindowBytes(header); } catch (error) { throw new WorkerFailure('PACK_INVALID', error instanceof Error ? error.message : String(error)); }
          if (windowBytes > MAX_WINDOW_BYTES) throw new WorkerFailure('PACK_INVALID', `zstd window ${windowBytes} exceeds the supported ${MAX_WINDOW_BYTES}`);
        }
      }
      compressedHasher.update(value);
      await decode(value, false);
      const now = performance.now();
      if (now - lastProgress >= 250) {
        lastProgress = now;
        post({ type: 'progress', compressedBytes, decodedBytes: decoder.decodedBytes, pendingBytes: decoder.pendingBytes });
      }
    }
    if (compressedBytes !== start.expectedCompressedBytes) throw new WorkerFailure('PACK_SIZE_MISMATCH', `Downloaded ${compressedBytes} bytes, manifest says ${start.expectedCompressedBytes}`);
    await decode(new Uint8Array(0), true);
    const decodedBytes = decoder.decodedBytes;
    if (decodedBytes !== start.expectedUncompressedBytes) throw new WorkerFailure('PACK_SIZE_MISMATCH', `Decoded ${decodedBytes} bytes, manifest says ${start.expectedUncompressedBytes}`);
    const compressedSha256 = compressedHasher.digest('hex');
    if (start.compressedSha256 && start.compressedSha256 !== compressedSha256) throw new WorkerFailure('PACK_HASH_MISMATCH', 'Compressed pack SHA-256 does not match the manifest');
    await decoder.settle(); // let the writer finish the tail before reporting completion
    post({
      type: 'done', decodedBytes, compressedBytes, sha256: decodedHasher.digest('hex'), compressedSha256, windowBytes,
      streamMs: Math.round(performance.now() - started), maxInFlightObserved, maxChunkBytes,
      pendingBytesMax: decoder.pendingBytesMax
    });
  } catch (error) {
    if (cancelled || (error instanceof DOMException && error.name === 'AbortError')) post({ type: 'cancelled' });
    else if (error instanceof WorkerFailure) post({ type: 'error', code: error.code, message: error.message });
    else post({ type: 'error', code: 'PACK_INVALID', message: error instanceof Error ? error.message : String(error) });
  } finally {
    controller = undefined;
    activeDecoder = undefined;
    chunkLengths.clear();
  }
}
