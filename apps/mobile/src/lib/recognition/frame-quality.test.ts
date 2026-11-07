import { describe, expect, it } from 'vitest';
import { assessFrame, brightness, dominantRejection, emptyRejections, glareFraction, MAX_GLARE, MIN_BRIGHTNESS, MIN_SHARPNESS, sharpness, type Sample } from './frame-quality';

/** Build an RGBA sample from a luma function. */
function make(w: number, h: number, luma: (x: number, y: number) => number): Sample {
  const data = new Uint8ClampedArray(w * h * 4);
  for (let y = 0; y < h; y++)
    for (let x = 0; x < w; x++) {
      const i = (y * w + x) * 4;
      const v = luma(x, y);
      data[i] = data[i + 1] = data[i + 2] = v;
      data[i + 3] = 255;
    }
  return { data, width: w, height: h };
}

const flat = (v: number) => make(120, 160, () => v);
const checker = make(120, 160, (x, y) => ((Math.floor(x / 4) + Math.floor(y / 4)) % 2 === 0 ? 70 : 150));
/** Smooth gradient: detail-free like an out-of-focus frame. */
const gradient = make(120, 160, (x) => 60 + x);
const blob = make(120, 160, (x, y) => ((x - 60) ** 2 + (y - 80) ** 2 < 30 ** 2 ? 255 : 100));

describe('frame quality', () => {
  it('flat frames are not sharp, a checker pattern is', () => {
    expect(sharpness(flat(120))).toBe(0);
    expect(sharpness(gradient)).toBeLessThan(MIN_SHARPNESS);
    expect(sharpness(checker)).toBeGreaterThan(MIN_SHARPNESS * 10);
  });

  it('white blob in the centre is glare, an edge-only highlight is ignored', () => {
    expect(glareFraction(blob)).toBeGreaterThan(MAX_GLARE);
    expect(glareFraction(checker)).toBe(0);
    const edge = make(120, 160, (x) => (x < 10 ? 255 : 100));
    expect(glareFraction(edge)).toBe(0);
  });

  it('brightness is the mean luma', () => {
    expect(brightness(flat(100))).toBeCloseTo(100, 0);
    expect(brightness(flat(10))).toBeLessThan(MIN_BRIGHTNESS);
  });

  it('assessFrame reports the most actionable reason first', () => {
    expect(assessFrame(checker)).toMatchObject({ ok: true, reason: null });
    expect(assessFrame(flat(10)).reason).toBe('dark');
    expect(assessFrame(blob).reason).toBe('glare');
    expect(assessFrame(gradient).reason).toBe('blur');
  });

  it('dominantRejection needs 3 samples and prefers glare on a tie', () => {
    expect(dominantRejection(emptyRejections())).toBeNull();
    expect(dominantRejection({ dark: 2, glare: 2, blur: 2 })).toBeNull();
    expect(dominantRejection({ dark: 5, glare: 5, blur: 1 })).toBe('glare');
    expect(dominantRejection({ dark: 6, glare: 3, blur: 1 })).toBe('dark');
  });
});
