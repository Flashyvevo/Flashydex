/**
 * Checked writes for OPFS sync access handles (WEB-STORAGE §4 step 2): explicit offsets, a short write is retried ONCE for the
 * remainder, a second short write is an IO error. Pure over a minimal handle interface so it is unit-testable.
 */
export interface WritableHandle {
  write(buffer: Uint8Array, options: { at: number }): number;
}

export class ShortWriteError extends Error {
  constructor(readonly at: number, readonly expected: number, readonly written: number) {
    super(`Short write at offset ${at}: wrote ${written} of ${expected} bytes`);
    this.name = 'ShortWriteError';
  }
}

/** Writes all of `data` at `offset`. Returns the number of raw `write` calls made (for tests). */
export function checkedWrite(handle: WritableHandle, data: Uint8Array, offset: number): number {
  let written = 0;
  let calls = 0;
  let retried = false;
  while (written < data.length) {
    const count = handle.write(data.subarray(written), { at: offset + written });
    calls += 1;
    written += count;
    if (written < data.length) {
      if (retried) throw new ShortWriteError(offset, data.length, written);
      retried = true;
    }
  }
  return calls;
}
