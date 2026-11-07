import { describe, expect, it } from 'vitest';
import { classifyCameraError, coverCrop } from './camera';
import { attemptAllowed, ATTEMPT_WINDOW_MS, isNoMatch, MIN_ATTEMPT_GAP_MS } from './retry';

describe('classifyCameraError', () => {
  it('maps permission errors to denied and everything else to unavailable', () => {
    expect(classifyCameraError({ name: 'NotAllowedError' })).toBe('denied');
    expect(classifyCameraError({ name: 'NotFoundError' })).toBe('unavailable');
    expect(classifyCameraError({ name: 'OverconstrainedError' })).toBe('unavailable');
    expect(classifyCameraError(new Error('x'))).toBe('unavailable');
  });
});

describe('coverCrop', () => {
  it('maps a centred rect through object-fit: cover', () => {
    // 1920×1080 video in a 300×400 box: scale 400/1080, horizontally cropped.
    const crop = coverCrop({ w: 1920, h: 1080 }, { w: 300, h: 400 }, { x: 0, y: 0, w: 300, h: 400 });
    expect(crop.y).toBeCloseTo(0);
    expect(crop.h).toBeCloseTo(1080);
    expect(crop.w).toBeCloseTo(300 / (400 / 1080));
    expect(crop.x).toBeCloseTo((1920 - crop.w) / 2);
  });
  it('clamps to the video and handles empty input', () => {
    const crop = coverCrop({ w: 100, h: 100 }, { w: 100, h: 100 }, { x: -10, y: 90, w: 50, h: 50 });
    expect(crop.x).toBe(0);
    expect(crop.y + crop.h).toBeLessThanOrEqual(100);
    expect(coverCrop({ w: 0, h: 0 }, { w: 1, h: 1 }, { x: 0, y: 0, w: 1, h: 1 }).w).toBe(0);
  });
});

describe('attemptAllowed', () => {
  it('never while in flight', () => expect(attemptAllowed([], 10_000, true)).toBe(false));
  it('first attempt is allowed', () => expect(attemptAllowed([], 0, false)).toBe(true));
  it('needs 1.5 s between attempts', () => {
    expect(attemptAllowed([1000], 1000 + MIN_ATTEMPT_GAP_MS - 1, false)).toBe(false);
    expect(attemptAllowed([1000], 1000 + MIN_ATTEMPT_GAP_MS, false)).toBe(true);
  });
  it('never more than 3 within 10 s', () => {
    const starts = [0, 1600, 3200];
    expect(attemptAllowed(starts, 5000, false)).toBe(false);
    expect(attemptAllowed(starts, ATTEMPT_WINDOW_MS - 1, false)).toBe(false);
    expect(attemptAllowed(starts, ATTEMPT_WINDOW_MS, false)).toBe(true);
  });
});

describe('isNoMatch', () => {
  it('treats no_match and no_card as failed attempts only', () => {
    expect(isNoMatch('no_match')).toBe(true);
    expect(isNoMatch('no_card')).toBe(true);
    expect(isNoMatch('candidates')).toBe(false);
    expect(isNoMatch('match')).toBe(false);
  });
});
