import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { detectImageType, fitWithin, jpegExifOrientation, prepareImage } from './prepare';

const bytes = (...n: number[]) => new Uint8Array(n);
const ascii = (s: string) => [...s].map((c) => c.charCodeAt(0));

describe('detectImageType', () => {
  it('jpeg/png/webp', () => {
    expect(detectImageType(bytes(0xff, 0xd8, 0xff, 0xe0, 0, 0))).toBe('jpeg');
    expect(detectImageType(bytes(0x89, ...ascii('PNG'), 0x0d, 0x0a, 0x1a, 0x0a))).toBe('png');
    expect(detectImageType(bytes(...ascii('RIFF'), 1, 2, 3, 4, ...ascii('WEBP')))).toBe('webp');
  });
  it.each(['heic', 'heix', 'mif1', 'msf1', 'hevc'])('heic brand %s', (brand) => {
    expect(detectImageType(bytes(0, 0, 0, 24, ...ascii('ftyp'), ...ascii(brand), 0, 0, 0, 0))).toBe('heic');
  });
  it('unknown for other ftyp brands / junk / short', () => {
    expect(detectImageType(bytes(0, 0, 0, 24, ...ascii('ftyp'), ...ascii('mp42'), 0, 0, 0, 0))).toBe('unknown');
    expect(detectImageType(bytes(1, 2, 3))).toBe('unknown');
    expect(detectImageType(new Uint8Array(0))).toBe('unknown');
  });
});

describe('fitWithin', () => {
  it('downscales a 4000×3000 to 1600×1200', () => {
    expect(fitWithin(4000, 3000)).toMatchObject({ width: 1600, height: 1200 });
  });
  it('portrait long edge is height', () => {
    expect(fitWithin(3000, 4000)).toMatchObject({ width: 1200, height: 1600 });
  });
  it('never upscales', () => {
    expect(fitWithin(800, 600)).toEqual({ width: 800, height: 600, scale: 1 });
    expect(fitWithin(1600, 1600)).toMatchObject({ width: 1600, height: 1600, scale: 1 });
  });
  it('keeps at least 1 px', () => {
    expect(fitWithin(100000, 1).height).toBe(1);
  });
});

describe('prepareImage always re-encodes (S10-05)', () => {
  const ENCODED = new Blob(['re-encoded-pixels-no-exif'], { type: 'image/jpeg' });
  let drawn: Array<[number, number]> = [];
  let imageDims = { w: 1200, h: 900 };
  let decodeRejects = false;

  beforeEach(() => {
    drawn = [];
    vi.stubGlobal('OffscreenCanvas', undefined);
    vi.spyOn(URL, 'createObjectURL').mockReturnValue('blob:fake');
    vi.spyOn(URL, 'revokeObjectURL').mockImplementation(() => undefined);
    class FakeImage {
      onload: (() => void) | null = null;
      onerror: (() => void) | null = null;
      decoding = '';
      get naturalWidth() { return imageDims.w; }
      get naturalHeight() { return imageDims.h; }
      set src(_: string) { queueMicrotask(() => this.onload?.()); }
      decode() { return decodeRejects ? Promise.reject(new Error('EncodingError')) : Promise.resolve(); }
    }
    vi.stubGlobal('Image', FakeImage);
    const realCreate = document.createElement.bind(document);
    vi.spyOn(document, 'createElement').mockImplementation(((tag: string) => {
      if (tag !== 'canvas') return realCreate(tag);
      return {
        width: 0,
        height: 0,
        getContext: () => ({ fillRect: () => undefined, drawImage: (_s: unknown, _x: number, _y: number, w: number, h: number) => drawn.push([w, h]), set fillStyle(_v: string) {} }),
        toBlob: (cb: (b: Blob | null) => void) => cb(ENCODED),
      } as unknown as HTMLCanvasElement;
    }) as typeof document.createElement);
  });
  afterEach(() => {
    vi.unstubAllGlobals();
    vi.restoreAllMocks();
    decodeRejects = false;
    imageDims = { w: 1200, h: 900 };
  });

  const smallJpeg = () => new File([new Uint8Array([0xff, 0xd8, 0xff, 0xe1, 0, 4, 0, 0, 0xff, 0xd9])], 'p.jpg', { type: 'image/jpeg' });

  it('a small upright JPEG is NOT sent unchanged', async () => {
    const file = smallJpeg();
    const out = await prepareImage(file);
    expect(out.reencoded).toBe(true);
    expect(out.blob).toBe(ENCODED);
    expect(out.blob).not.toBe(file);
    expect(out.originalBytes).toBe(file.size);
    expect(drawn).toEqual([[1200, 900]]); // upright EXIF-applied dimensions, no resize
  });
  it('downscales a large photo to the 1600 px long edge', async () => {
    imageDims = { w: 4000, h: 3000 };
    await prepareImage(smallJpeg());
    expect(drawn).toEqual([[1600, 1200]]);
  });
  it('tolerates an img.decode() rejection after a successful load (iOS Safari)', async () => {
    decodeRejects = true;
    const out = await prepareImage(smallJpeg());
    expect(out.reencoded).toBe(true);
  });
});

describe('jpegExifOrientation', () => {
  function jpegWithOrientation(o: number, le = false): Uint8Array {
    const w16 = (v: number) => (le ? [v & 255, v >> 8] : [v >> 8, v & 255]);
    const w32 = (v: number) => (le ? [v & 255, (v >> 8) & 255, 0, 0] : [0, 0, (v >> 8) & 255, v & 255]);
    const tiff = [...(le ? [0x49, 0x49] : [0x4d, 0x4d]), ...w16(42), ...w32(8), ...w16(1), ...w16(0x0112), ...w16(3), ...w32(1), ...w16(o), 0, 0, ...w32(0)];
    const payload = [...ascii('Exif'), 0, 0, ...tiff];
    const len = payload.length + 2;
    return bytes(0xff, 0xd8, 0xff, 0xe1, len >> 8, len & 255, ...payload, 0xff, 0xd9);
  }
  it('reads big and little endian', () => {
    expect(jpegExifOrientation(jpegWithOrientation(6))).toBe(6);
    expect(jpegExifOrientation(jpegWithOrientation(8, true))).toBe(8);
    expect(jpegExifOrientation(jpegWithOrientation(1))).toBe(1);
  });
  it('null without EXIF or for non-jpeg', () => {
    expect(jpegExifOrientation(bytes(0xff, 0xd8, 0xff, 0xd9))).toBeNull();
    expect(jpegExifOrientation(bytes(1, 2, 3, 4))).toBeNull();
  });
});
