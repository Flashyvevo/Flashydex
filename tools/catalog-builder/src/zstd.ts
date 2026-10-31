import { createHash } from 'node:crypto';
import { createReadStream, createWriteStream } from 'node:fs';
import { open, stat } from 'node:fs/promises';
import { Transform } from 'node:stream';
import { pipeline } from 'node:stream/promises';
import { CompressStream, DecompressStream } from 'zstd-napi';

export const ZSTD_LEVEL = 19;
/** fzstd (device decoder) supports a maximum back-reference distance of 2^25 bytes (research/compression-libs.md). */
export const MAX_WINDOW_BYTES = 2 ** 25;

export function sha256File(path: string): Promise<{ sha256: string; bytes: number }> {
  return new Promise((resolve, reject) => {
    const hash = createHash('sha256');
    let bytes = 0;
    createReadStream(path)
      .on('data', (chunk) => { hash.update(chunk); bytes += chunk.length; })
      .on('error', reject)
      .on('end', () => resolve({ sha256: hash.digest('hex'), bytes }));
  });
}

/** Streaming zstd level-19 compression with a frame checksum; no whole-file buffer. */
export async function compressFile(source: string, destination: string, level = ZSTD_LEVEL): Promise<void> {
  await pipeline(createReadStream(source), new CompressStream({ compressionLevel: level, checksumFlag: true }), createWriteStream(destination));
}

/** Parse the first zstd frame header and return its window size (RFC 8878 §3.1.1.1.2). */
export function zstdWindowBytes(header: Uint8Array, contentSize?: number): number {
  if (header.length < 6 || header[0] !== 0x28 || header[1] !== 0xb5 || header[2] !== 0x2f || header[3] !== 0xfd) throw new Error('Not a zstd frame');
  const descriptor = header[4]!;
  const singleSegment = (descriptor & 0x20) !== 0;
  if (singleSegment) return contentSize ?? 0; // window == content size; unknown without the FCS field
  const windowDescriptor = header[5]!;
  const exponent = windowDescriptor >> 3;
  const mantissa = windowDescriptor & 7;
  const base = 2 ** (10 + exponent);
  return base + (base / 8) * mantissa;
}

export interface RoundTrip { bytes: number; sha256: string; windowBytes: number; ms: number }

/** Decompress `source` to `destination` by streaming; returns counters. Used for the round-trip verification. */
export async function decompressFile(source: string, destination: string): Promise<RoundTrip> {
  const started = performance.now();
  const hash = createHash('sha256');
  let bytes = 0;
  const handle = await open(source, 'r');
  const head = Buffer.alloc(18);
  try { await handle.read(head, 0, 18, 0); } finally { await handle.close(); }
  const windowBytes = zstdWindowBytes(head);
  const counter = new Transform({
    transform(chunk: Buffer, _enc, cb) { hash.update(chunk); bytes += chunk.length; cb(null, chunk); }
  });
  await pipeline(createReadStream(source), new DecompressStream(), counter, createWriteStream(destination));
  return { bytes, sha256: hash.digest('hex'), windowBytes, ms: Math.round(performance.now() - started) };
}

export async function fileSize(path: string): Promise<number> {
  return (await stat(path)).size;
}
