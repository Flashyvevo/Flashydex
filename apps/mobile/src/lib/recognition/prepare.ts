/** Client-side photo preparation: decode (EXIF-aware) → downscale (long edge ≤ 1600, never upscale) → JPEG q0.85. */

export const MAX_EDGE = 1600;
export const JPEG_QUALITY = 0.85;

export type ImageType = 'jpeg' | 'png' | 'webp' | 'heic' | 'unknown';

const ascii = (b: Uint8Array, from: number, to: number): string => String.fromCharCode(...b.subarray(from, to));

/** Detect by magic bytes (never by file name / MIME, which iOS gets wrong for HEIC). */
export function detectImageType(b: Uint8Array): ImageType {
  if (b.length >= 3 && b[0] === 0xff && b[1] === 0xd8 && b[2] === 0xff) return 'jpeg';
  if (b.length >= 8 && b[0] === 0x89 && ascii(b, 1, 4) === 'PNG') return 'png';
  if (b.length >= 12 && ascii(b, 0, 4) === 'RIFF' && ascii(b, 8, 12) === 'WEBP') return 'webp';
  if (b.length >= 12 && ascii(b, 4, 8) === 'ftyp') {
    const brand = ascii(b, 8, 12);
    if (['heic', 'heix', 'mif1', 'msf1', 'hevc', 'hevx', 'heim', 'heis'].includes(brand)) return 'heic';
  }
  return 'unknown';
}

/** EXIF orientation (1..8) of a JPEG, or null when absent/unreadable. Only the first 64 KB are scanned. */
export function jpegExifOrientation(b: Uint8Array): number | null {
  if (detectImageType(b) !== 'jpeg') return null;
  let o = 2;
  const end = Math.min(b.length, 65_536);
  while (o + 4 < end) {
    if (b[o] !== 0xff) return null;
    const marker = b[o + 1]!;
    if (marker === 0xda || marker === 0xd9) return null;
    const len = (b[o + 2]! << 8) | b[o + 3]!;
    if (marker === 0xe1 && ascii(b, o + 4, o + 10) === 'Exif\0\0') {
      const t = o + 10;
      const le = b[t] === 0x49;
      const u16 = (p: number) => (le ? b[p]! | (b[p + 1]! << 8) : (b[p]! << 8) | b[p + 1]!);
      const u32 = (p: number) => (le ? (b[p]! | (b[p + 1]! << 8) | (b[p + 2]! << 16) | (b[p + 3]! << 24)) >>> 0 : ((b[p]! << 24) | (b[p + 1]! << 16) | (b[p + 2]! << 8) | b[p + 3]!) >>> 0);
      const ifd = t + u32(t + 4);
      if (ifd + 2 > b.length) return null;
      const n = u16(ifd);
      for (let i = 0; i < n; i++) {
        const e = ifd + 2 + i * 12;
        if (e + 12 > b.length) return null;
        if (u16(e) === 0x0112) {
          const v = u16(e + 8);
          return v >= 1 && v <= 8 ? v : null;
        }
      }
      return null;
    }
    o += 2 + len;
  }
  return null;
}

/** Fit inside `max` on the long edge; never upscales. */
export function fitWithin(width: number, height: number, max = MAX_EDGE): { width: number; height: number; scale: number } {
  const long = Math.max(width, height);
  if (long <= max) return { width, height, scale: 1 };
  const scale = max / long;
  return { width: Math.max(1, Math.round(width * scale)), height: Math.max(1, Math.round(height * scale)), scale };
}

/** `reencoded` is always true: every photo goes through canvas so EXIF/GPS/device metadata never leaves the device. */
export type PreparedImage = { blob: Blob; width: number; height: number; originalBytes: number; bytes: number; ms: number; reencoded: true; type: ImageType };

export class PrepareError extends Error {
  readonly heic: boolean;
  /** Which step failed and the browser's own message — shown in the error body so phone failures are diagnosable. */
  readonly reason: string;
  constructor(heic: boolean, stage: 'decode' | 'size' | 'encode' = 'decode', cause?: unknown) {
    const detail = cause instanceof Error ? cause.message : cause ? String(cause) : '';
    super(heic ? 'HEIC could not be decoded' : 'Image could not be decoded');
    this.name = 'PrepareError';
    this.heic = heic;
    this.reason = `${stage}${detail ? `: ${detail}` : ''}`;
  }
}

type Drawable = { source: CanvasImageSource; width: number; height: number; close: () => void };

async function decode(blob: Blob): Promise<Drawable> {
  // <img> decode only: Safari's createImageBitmap(blob) ignores EXIF orientation (research/ios-camera.md §3).
  const url = URL.createObjectURL(blob);
  try {
    const img = new Image();
    img.decoding = 'async';
    const loaded = new Promise<void>((resolve, reject) => {
      img.onload = () => resolve();
      img.onerror = () => reject(new Error('image load failed'));
    });
    img.src = url;
    await loaded;
    // iOS Safari rejects decode() for large photos (and under memory pressure in standalone mode) even though the
    // image has loaded and draws correctly, so a decode() rejection after a successful load is not an error.
    try {
      await img.decode();
    } catch {
      /* drawn from the loaded element below */
    }
    // <img> applies EXIF orientation by default (image-orientation: from-image), so naturalWidth/Height are upright.
    return { source: img, width: img.naturalWidth, height: img.naturalHeight, close: () => URL.revokeObjectURL(url) };
  } catch (error) {
    URL.revokeObjectURL(url);
    throw error;
  }
}

export async function encodeJpeg(source: CanvasImageSource, width: number, height: number): Promise<Blob> {
  if (typeof OffscreenCanvas === 'function') {
    try {
      const canvas = new OffscreenCanvas(width, height);
      const ctx = canvas.getContext('2d');
      if (ctx) {
        ctx.fillStyle = '#fff';
        ctx.fillRect(0, 0, width, height);
        ctx.drawImage(source, 0, 0, width, height);
        const blob = await canvas.convertToBlob({ type: 'image/jpeg', quality: JPEG_QUALITY });
        if (blob.size > 0) return blob;
      }
    } catch {
      /* fall back to a DOM canvas (Safari OffscreenCanvas quirks) */
    }
  }
  const canvas = document.createElement('canvas');
  canvas.width = width;
  canvas.height = height;
  const ctx = canvas.getContext('2d');
  if (!ctx) throw new Error('canvas unavailable');
  ctx.fillStyle = '#fff';
  ctx.fillRect(0, 0, width, height);
  ctx.drawImage(source, 0, 0, width, height);
  return new Promise((resolve, reject) => canvas.toBlob((b) => (b ? resolve(b) : reject(new Error('encode failed'))), 'image/jpeg', JPEG_QUALITY));
}

export async function prepareImage(file: Blob): Promise<PreparedImage> {
  const t0 = performance.now();
  const head = new Uint8Array(await file.slice(0, 65_536).arrayBuffer());
  const type = detectImageType(head);
  let drawable: Drawable;
  try {
    drawable = await decode(file);
  } catch (error) {
    throw new PrepareError(type === 'heic', 'decode', error);
  }
  try {
    if (drawable.width < 1 || drawable.height < 1) throw new PrepareError(type === 'heic', 'size', `${drawable.width}x${drawable.height}`);
    // Always re-encode (never forward the original bytes): canvas output carries no EXIF/GPS, and the
    // <img> decode above already applied EXIF orientation so the pixels are upright.
    const fit = fitWithin(drawable.width, drawable.height);
    const blob = await encodeJpeg(drawable.source, fit.width, fit.height);
    return { blob, width: fit.width, height: fit.height, originalBytes: file.size, bytes: blob.size, ms: performance.now() - t0, reencoded: true, type };
  } catch (error) {
    if (error instanceof PrepareError) throw error;
    throw new PrepareError(type === 'heic', 'encode', error);
  } finally {
    drawable.close();
  }
}
