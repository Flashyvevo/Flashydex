// @vitest-environment node
import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import { BoundedDecodeError, BoundedDecoder, DEFAULT_ACK_CAP_BYTES, DEFAULT_HARD_CAP_BYTES } from './bounded-decoder';

const MIB = 1024 * 1024;
const zeros = new Uint8Array(readFileSync(new URL('./fixtures/zeros-64mib.zst', import.meta.url)));

function harness(options: { expected: number; sliceBytes?: number; cancelAfterChunks?: number }) {

  let delivered = 0;
  let chunks = 0;
  let cancelled = false;
  const decoder: BoundedDecoder = new BoundedDecoder({
    expectedUncompressedBytes: options.expected,
    chunkBytes: 256 * 1024,
    sliceBytes: options.sliceBytes,
    isCancelled: () => cancelled,
    deliver: (chunk) => {
      delivered += chunk.length;
      chunks += 1;
      if (options.cancelAfterChunks !== undefined && chunks >= options.cancelAfterChunks) { cancelled = true; return; }
      setTimeout(() => decoder.ack(chunk.length), 0); // the main-thread writer acknowledges asynchronously
    }
  });
  return { decoder, delivered: () => delivered };
}

describe('BoundedDecoder (R05)', () => {
  it('fixture is a tiny frame that expands to 64 MiB', () => {
    expect(zeros.length).toBeLessThan(16 * 1024);
  });

  it('keeps queued+unacked decoded bytes bounded for a 64 MiB high-ratio frame fed in small slices', async () => {
    const { decoder, delivered } = harness({ expected: 64 * MIB, sliceBytes: 16 });
    await decoder.push(zeros, true);
    await decoder.settle();
    expect(delivered()).toBe(64 * MIB);
    expect(decoder.decodedBytes).toBe(64 * MIB);
    expect(decoder.pendingBytesMax).toBeGreaterThan(0);
    expect(decoder.pendingBytesMax).toBeLessThanOrEqual(DEFAULT_HARD_CAP_BYTES);
    // steady state is the ack cap; one 16-byte slice can add at most a few RLE blocks (128 KiB each) on top of it.
    expect(decoder.pendingBytesMax).toBeLessThanOrEqual(DEFAULT_ACK_CAP_BYTES + 2 * MIB);
    expect(decoder.pendingBytes).toBe(0);
  });

  it('aborts a tiny input that would expand past the hard cap in one push (the E5 case) with PACK_INVALID', async () => {
    const { decoder } = harness({ expected: 64 * MIB }); // default 32 KiB slices swallow the whole 2 KiB frame at once
    const error = await decoder.push(zeros, true).catch((e: unknown) => e);
    expect(error).toBeInstanceOf(BoundedDecodeError);
    expect((error as BoundedDecodeError).code).toBe('PACK_INVALID');
    expect(decoder.pendingBytesMax).toBeLessThanOrEqual(DEFAULT_HARD_CAP_BYTES);
    expect(decoder.decodedBytes).toBeLessThan(40 * MIB); // stopped near the cap, not after 64 MiB
  });

  it('aborts immediately when total decoded bytes exceed the manifest size', async () => {
    const { decoder, delivered } = harness({ expected: 1 * MIB, sliceBytes: 16 });
    const error = await decoder.push(zeros, true).catch((e: unknown) => e);
    expect((error as BoundedDecodeError).code).toBe('PACK_SIZE_MISMATCH');
    expect(delivered()).toBeLessThanOrEqual(1 * MIB + 256 * 1024);
  });

  it('stops on cancellation without decoding the rest', async () => {
    const { decoder } = harness({ expected: 64 * MIB, sliceBytes: 16, cancelAfterChunks: 3 });
    const error = await decoder.push(zeros, true).catch((e: unknown) => e);
    expect((error as DOMException).name).toBe('AbortError');
    expect(decoder.decodedBytes).toBeLessThan(64 * MIB);
  });

  it('rejects garbage input as PACK_INVALID', async () => {
    const { decoder } = harness({ expected: MIB });
    const error = await decoder.push(new Uint8Array(64).fill(7), true).catch((e: unknown) => e);
    expect((error as BoundedDecodeError).code).toBe('PACK_INVALID');
  });
});
