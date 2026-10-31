/**
 * Pure bounded zstd decode loop (R05). The worker shell feeds network bytes in; this module guarantees that
 * decoded-but-unacknowledged bytes stay bounded INSIDE decoder emission, not after it:
 *  - compressed input is fed to fzstd in slices of `sliceBytes` (default 32 KiB);
 *  - the fzstd output callback counts every byte; if decoded total exceeds `expectedUncompressedBytes`, or pending
 *    (queued + posted-but-unacked) bytes would exceed `hardCapBytes` (default 32 MiB), the callback THROWS, which aborts
 *    `push` immediately (PACK_INVALID: a tiny input that expands past the cap is a decompression bomb);
 *  - after each slice, queued chunks are delivered and the loop awaits acks until pending <= `ackCapBytes` (default 4 MiB).
 * `pendingBytesMax` is the high-water mark of queued + unacked bytes.
 */
import { Decompress } from 'fzstd';

export class BoundedDecodeError extends Error {
  constructor(readonly code: 'PACK_INVALID' | 'PACK_SIZE_MISMATCH', message: string) {
    super(message);
    this.name = 'BoundedDecodeError';
  }
}

export interface BoundedDecoderOptions {
  expectedUncompressedBytes: number;
  chunkBytes: number;
  sliceBytes?: number;
  ackCapBytes?: number;
  hardCapBytes?: number;
  /** Receives each decoded chunk (a private copy). May await writer back-pressure. The owner later calls `ack(length)`. */
  deliver: (chunk: Uint8Array) => Promise<void> | void;
  isCancelled?: () => boolean;
}

export const DEFAULT_SLICE_BYTES = 32 * 1024;
export const DEFAULT_ACK_CAP_BYTES = 4 * 1024 * 1024;
export const DEFAULT_HARD_CAP_BYTES = 32 * 1024 * 1024;

export class BoundedDecoder {
  pendingBytes = 0;
  pendingBytesMax = 0;
  decodedBytes = 0;
  private readonly queue: Uint8Array[] = [];
  private readonly decoder: Decompress;
  private readonly slice: number;
  private readonly ackCap: number;
  private readonly hardCap: number;
  private waiter: (() => void) | undefined;

  constructor(private readonly options: BoundedDecoderOptions) {
    this.slice = options.sliceBytes ?? DEFAULT_SLICE_BYTES;
    this.ackCap = options.ackCapBytes ?? DEFAULT_ACK_CAP_BYTES;
    this.hardCap = options.hardCapBytes ?? DEFAULT_HARD_CAP_BYTES;
    this.decoder = new Decompress((chunk) => this.emit(chunk));
  }

  /** Runs INSIDE fzstd's synchronous output loop: throwing here stops further expansion. */
  private emit(chunk: Uint8Array): void {
    this.decodedBytes += chunk.length;
    if (this.decodedBytes > this.options.expectedUncompressedBytes) {
      throw new BoundedDecodeError('PACK_SIZE_MISMATCH', `Decoded output exceeds the manifest size ${this.options.expectedUncompressedBytes}`);
    }
    if (this.pendingBytes + chunk.length > this.hardCap) {
      throw new BoundedDecodeError('PACK_INVALID', `Decoded output expanded beyond ${this.hardCap} pending bytes from a small input (decompression bomb)`);
    }
    this.pendingBytes += chunk.length;
    this.pendingBytesMax = Math.max(this.pendingBytesMax, this.pendingBytes);
    // fzstd may emit views into internal buffers: copy before the data leaves this call stack.
    for (let offset = 0; offset < chunk.length; offset += this.options.chunkBytes) {
      this.queue.push(chunk.slice(offset, Math.min(chunk.length, offset + this.options.chunkBytes)));
    }
  }

  /** The writer finished with `bytes` decoded bytes. */
  ack(bytes: number): void {
    this.pendingBytes -= bytes;
    this.waiter?.();
  }

  /** Wake a pending wait (cancellation). */
  wake(): void {
    this.waiter?.();
  }

  private async drain(): Promise<void> {
    while (this.queue.length > 0) {
      if (this.options.isCancelled?.()) throw new DOMException('cancelled', 'AbortError');
      await this.options.deliver(this.queue.shift()!);
    }
    while (this.pendingBytes > this.ackCap) {
      await new Promise<void>((resolve) => { this.waiter = resolve; });
      this.waiter = undefined;
      if (this.options.isCancelled?.()) throw new DOMException('cancelled', 'AbortError');
    }
  }

  /** Feed compressed bytes (any size); they are sliced internally. */
  async push(input: Uint8Array, final = false): Promise<void> {
    for (let offset = 0; offset < input.length; offset += this.slice) {
      this.pushSlice(input.subarray(offset, Math.min(input.length, offset + this.slice)), false);
      await this.drain();
    }
    if (final) {
      this.pushSlice(new Uint8Array(0), true);
      await this.drain();
    }
  }

  private pushSlice(slice: Uint8Array, final: boolean): void {
    try {
      this.decoder.push(slice, final);
    } catch (error) {
      if (error instanceof BoundedDecodeError) throw error;
      throw new BoundedDecodeError('PACK_INVALID', `zstd decode failed: ${error instanceof Error ? error.message : String(error)}`);
    }
  }

  /** Wait until every delivered byte has been acknowledged. */
  async settle(): Promise<void> {
    while (this.pendingBytes > 0) {
      await new Promise<void>((resolve) => { this.waiter = resolve; });
      this.waiter = undefined;
      if (this.options.isCancelled?.()) throw new DOMException('cancelled', 'AbortError');
    }
  }
}
