/** Live rear camera for the scan viewfinder. Every failure is classified so the UI can fall back to the file-input flow silently
 *  (research/ios-camera.md: standalone iOS may hand back a blank stream or revoke permission — WebKit 282327 / 215884). */

export type CameraFailureKind = 'denied' | 'unavailable' | 'blank';

export class CameraError extends Error {
  readonly kind: CameraFailureKind;
  constructor(kind: CameraFailureKind, detail?: string) {
    super(`camera ${kind}${detail ? `: ${detail}` : ''}`);
    this.name = 'CameraError';
    this.kind = kind;
  }
}

export type RearCamera = { stream: MediaStream; stop: () => void };

export const BLANK_TIMEOUT_MS = 2500;
export const MUTED_LIMIT_MS = 1000;

/** Dev/test hook: `window.__fdxFakeCamera` supplies the MediaStream (or throws a DOMException). Ignored in production builds. */
type FakeCamera = () => MediaStream | Promise<MediaStream>;
function fakeCamera(): FakeCamera | null {
  if (!import.meta.env.DEV) return null;
  const f = (globalThis as { __fdxFakeCamera?: unknown }).__fdxFakeCamera;
  return typeof f === 'function' ? (f as FakeCamera) : null;
}

export function cameraSupported(): boolean {
  return typeof navigator !== 'undefined' && !!navigator.mediaDevices && typeof navigator.mediaDevices.getUserMedia === 'function';
}

/** Should /scan even try the live camera? (real getUserMedia, or the dev/test fake) */
export function cameraAvailable(): boolean {
  return fakeCamera() !== null || cameraSupported();
}

export function classifyCameraError(error: unknown): CameraFailureKind {
  const name = (error as { name?: string } | null)?.name;
  if (name === 'NotAllowedError' || name === 'SecurityError' || name === 'PermissionDeniedError') return 'denied';
  return 'unavailable';
}

export async function openRearCamera(): Promise<RearCamera> {
  const fake = fakeCamera();
  if (!fake && (!cameraSupported() || (typeof isSecureContext === 'boolean' && !isSecureContext))) throw new CameraError('unavailable', 'no mediaDevices / insecure context');
  let stream: MediaStream;
  try {
    stream = fake ? await fake() : await navigator.mediaDevices.getUserMedia({ video: { facingMode: { ideal: 'environment' }, width: { ideal: 1920 }, height: { ideal: 1080 } }, audio: false });
  } catch (error) {
    throw new CameraError(classifyCameraError(error), (error as { message?: string } | null)?.message);
  }
  return { stream, stop: () => stream.getTracks().forEach((t) => t.stop()) };
}

/** Attach `stream` to `video` and resolve once real frames flow; rejects with `blank` after `timeoutMs` (iOS standalone bug). */
export function verifyPlayback(video: HTMLVideoElement, stream: MediaStream, timeoutMs = BLANK_TIMEOUT_MS): Promise<void> {
  video.srcObject = stream;
  void video.play().catch(() => undefined);
  const flowing = () => video.readyState >= 2 && video.videoWidth > 0 && video.videoHeight > 0;
  return new Promise((resolve, reject) => {
    const started = Date.now();
    const tick = () => {
      if (flowing()) return resolve();
      const track = stream.getVideoTracks()[0];
      if (!track || track.readyState === 'ended') return reject(new CameraError('blank', 'track ended'));
      if (Date.now() - started >= timeoutMs) return reject(new CameraError('blank', `readyState ${video.readyState}, ${video.videoWidth}x${video.videoHeight}`));
      setTimeout(tick, 100);
    };
    tick();
  });
}

/** Calls `onLost` when the video track ends, or stays muted > 1 s (permission revoked / backgrounded-camera bug). Returns a disposer. */
export function watchTrack(stream: MediaStream, onLost: () => void, mutedLimitMs = MUTED_LIMIT_MS): () => void {
  const track = stream.getVideoTracks()[0];
  if (!track) return () => undefined;
  let timer: ReturnType<typeof setTimeout> | null = null;
  const clear = () => {
    if (timer) clearTimeout(timer);
    timer = null;
  };
  const armIfMuted = () => {
    clear();
    if (track.muted) timer = setTimeout(onLost, mutedLimitMs);
  };
  const onEnded = () => {
    clear();
    onLost();
  };
  track.addEventListener('ended', onEnded);
  track.addEventListener('mute', armIfMuted);
  track.addEventListener('unmute', clear);
  armIfMuted();
  return () => {
    clear();
    track.removeEventListener('ended', onEnded);
    track.removeEventListener('mute', armIfMuted);
    track.removeEventListener('unmute', clear);
  };
}

export type Rect = { x: number; y: number; w: number; h: number };

/** Map a rect given in the displayed box (video drawn with `object-fit: cover`) to source-video pixel coordinates, clamped. */
export function coverCrop(video: { w: number; h: number }, box: { w: number; h: number }, rect: Rect): Rect {
  if (video.w <= 0 || video.h <= 0 || box.w <= 0 || box.h <= 0) return { x: 0, y: 0, w: 0, h: 0 };
  const scale = Math.max(box.w / video.w, box.h / video.h);
  const offX = (video.w * scale - box.w) / 2;
  const offY = (video.h * scale - box.h) / 2;
  const x = Math.max(0, (rect.x + offX) / scale);
  const y = Math.max(0, (rect.y + offY) / scale);
  const w = Math.min(video.w - x, rect.w / scale);
  const h = Math.min(video.h - y, rect.h / scale);
  return { x, y, w: Math.max(0, w), h: Math.max(0, h) };
}
