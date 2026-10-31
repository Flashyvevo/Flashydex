/** zstd frame-header helpers shared by the pack-install worker and tests. */

/** fzstd decodes back-references up to 2^25 bytes (research/compression-libs.md). */
export const MAX_WINDOW_BYTES = 2 ** 25;

export const ZSTD_MAGIC = [0x28, 0xb5, 0x2f, 0xfd] as const;

/** Minimum bytes needed to read the window descriptor (magic 4 + frame header descriptor 1 + window descriptor 1). */
export const ZSTD_HEADER_PROBE_BYTES = 6;

/** Window size from the first frame header (RFC 8878 3.1.1.1.2). Single-segment frames have window == content size (unknown here -> 0). */
export function zstdWindowBytes(header: Uint8Array): number {
  if (header.length < ZSTD_HEADER_PROBE_BYTES) throw new Error('zstd header truncated');
  for (let i = 0; i < ZSTD_MAGIC.length; i += 1) if (header[i] !== ZSTD_MAGIC[i]) throw new Error('Not a zstd frame');
  const descriptor = header[4]!;
  if ((descriptor & 0x20) !== 0) return 0;
  const windowDescriptor = header[5]!;
  const base = 2 ** (10 + (windowDescriptor >> 3));
  return base + (base / 8) * (windowDescriptor & 7);
}
