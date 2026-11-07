/** Cheap per-frame quality checks for the live viewfinder. Pure functions over an ImageData-like sample (downscaled ≤ 320 px). */

export type Sample = { data: ArrayLike<number>; width: number; height: number };

/** Longest edge of the sampled frame. */
export const SAMPLE_EDGE = 320;
/** Variance of the Laplacian (luma 0–255) below this = blurry. [needs owner iPhone] tune on real frames. */
export const MIN_SHARPNESS = 45;
/** Share of pixels with luma > GLARE_LUMA in the central 70 % region above this = glare. */
export const MAX_GLARE = 0.06;
export const GLARE_LUMA = 245;
/** Mean luma (0–255) below this = too dark. */
export const MIN_BRIGHTNESS = 45;

export type Rejection = 'dark' | 'glare' | 'blur';
export type FrameQuality = { ok: boolean; reason: Rejection | null; sharpness: number; glare: number; brightness: number };

function lumaPlane(s: Sample): Float32Array {
  const out = new Float32Array(s.width * s.height);
  for (let i = 0, p = 0; i < out.length; i++, p += 4) out[i] = 0.299 * s.data[p]! + 0.587 * s.data[p + 1]! + 0.114 * s.data[p + 2]!;
  return out;
}

function sharpnessOf(luma: Float32Array, w: number, h: number): number {
  if (w < 3 || h < 3) return 0;
  let sum = 0;
  let sumSq = 0;
  let n = 0;
  for (let y = 1; y < h - 1; y++) {
    for (let x = 1; x < w - 1; x++) {
      const i = y * w + x;
      const lap = luma[i - 1]! + luma[i + 1]! + luma[i - w]! + luma[i + w]! - 4 * luma[i]!;
      sum += lap;
      sumSq += lap * lap;
      n++;
    }
  }
  const mean = sum / n;
  return sumSq / n - mean * mean;
}

/** Variance of the Laplacian on luma. Flat → 0; fine detail → large. */
export function sharpness(s: Sample): number {
  return sharpnessOf(lumaPlane(s), s.width, s.height);
}

/** Share (0–1) of pixels with luma > 245 in the central 70 % region. */
export function glareFraction(s: Sample): number {
  const luma = lumaPlane(s);
  const x0 = Math.floor(s.width * 0.15);
  const x1 = Math.ceil(s.width * 0.85);
  const y0 = Math.floor(s.height * 0.15);
  const y1 = Math.ceil(s.height * 0.85);
  let hot = 0;
  let n = 0;
  for (let y = y0; y < y1; y++) {
    for (let x = x0; x < x1; x++) {
      n++;
      if (luma[y * s.width + x]! > GLARE_LUMA) hot++;
    }
  }
  return n === 0 ? 0 : hot / n;
}

/** Mean luma (0–255). */
export function brightness(s: Sample): number {
  const luma = lumaPlane(s);
  let sum = 0;
  for (const v of luma) sum += v;
  return luma.length === 0 ? 0 : sum / luma.length;
}

/** All three metrics + the first failing reason (dark → glare → blur: the more actionable problem wins). */
export function assessFrame(s: Sample): FrameQuality {
  const luma = lumaPlane(s);
  let sum = 0;
  for (const v of luma) sum += v;
  const b = luma.length === 0 ? 0 : sum / luma.length;
  const g = glareFraction(s);
  const sh = sharpnessOf(luma, s.width, s.height);
  const reason: Rejection | null = b < MIN_BRIGHTNESS ? 'dark' : g > MAX_GLARE ? 'glare' : sh < MIN_SHARPNESS ? 'blur' : null;
  return { ok: reason === null, reason, sharpness: sh, glare: g, brightness: b };
}

export type RejectionCounts = Record<Rejection, number>;
export const emptyRejections = (): RejectionCounts => ({ dark: 0, glare: 0, blur: 0 });

/** Which quality problem dominated a session (needs ≥ 3 rejected samples), or null. Ties prefer glare, then dark. */
export function dominantRejection(counts: RejectionCounts, min = 3): Rejection | null {
  let best: Rejection | null = null;
  for (const r of ['glare', 'dark', 'blur'] as const) if (counts[r] >= min && (best === null || counts[r] > counts[best])) best = r;
  return best;
}
