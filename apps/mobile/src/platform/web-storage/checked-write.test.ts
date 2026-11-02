import { describe, expect, it } from 'vitest';
import { checkedWrite, ShortWriteError, type WritableHandle } from './checked-write';

const memoryHandle = (limits: number[]): WritableHandle & { bytes: number[] } => {
  const bytes: number[] = [];
  return {
    bytes,
    write(buffer, { at }) {
      const count = Math.min(buffer.length, limits.length ? (limits.shift() as number) : buffer.length);
      for (let i = 0; i < count; i += 1) bytes[at + i] = buffer[i]!;
      return count;
    }
  };
};

describe('checkedWrite', () => {
  it('writes whole buffers at the explicit offset', () => {
    const handle = memoryHandle([]);
    expect(checkedWrite(handle, new Uint8Array([1, 2, 3]), 5)).toBe(1);
    expect(handle.bytes.slice(5)).toEqual([1, 2, 3]);
  });
  it('retries a single short write for the remainder', () => {
    const handle = memoryHandle([2]);
    expect(checkedWrite(handle, new Uint8Array([1, 2, 3, 4]), 0)).toBe(2);
    expect(handle.bytes).toEqual([1, 2, 3, 4]);
  });
  it('fails with an IO error when the retry is short as well', () => {
    expect(() => checkedWrite(memoryHandle([2, 1]), new Uint8Array([1, 2, 3, 4]), 0)).toThrow(ShortWriteError);
    expect(() => checkedWrite(memoryHandle([0, 0]), new Uint8Array([1]), 0)).toThrow(ShortWriteError);
  });
});
