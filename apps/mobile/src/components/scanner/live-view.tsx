import { Camera, Image as ImageIcon, Layers, Search } from 'lucide-react';
import { useEffect, useRef, useState } from 'react';
import { coverCrop, verifyPlayback, watchTrack } from '../../lib/recognition/camera';
import { COPY } from '../../lib/recognition/copy';
import { assessFrame, SAMPLE_EDGE, type Rejection } from '../../lib/recognition/frame-quality';
import { encodeJpeg, fitWithin, MAX_EDGE } from '../../lib/recognition/prepare';
import { Button, cx } from '../ui';

/** Samples per second for the quality loop, and how many consecutive passing samples trigger auto-capture. */
const SAMPLE_INTERVAL_MS = 160;
const AUTO_CAPTURE_STREAK = 4;

export type LiveViewProps = {
  /** null while the camera is opening: a skeleton shows, the buttons below stay usable. */
  stream: MediaStream | null;
  busy: boolean;
  retrying: boolean;
  /** Synchronous gate (session policy): in flight / min gap / 3-per-10 s. */
  canCapture: () => boolean;
  onCapture: (file: File) => void;
  onReject: (reason: Rejection) => void;
  /** Blank stream or the track ended / stayed muted: the page falls back to the file-input flow. */
  onUnusable: () => void;
  onTakePhoto: () => void;
  onChoosePhoto: () => void;
  onSearchManually: () => void;
  onBrowseBySet: () => void;
};

type Quality = 'ok' | Rejection;

const CHIP: Record<Rejection, string> = { dark: COPY.chipDark, glare: COPY.chipGlare, blur: COPY.chipBlur };

export function LiveView(props: LiveViewProps) {
  const { stream, busy, retrying } = props;
  const boxRef = useRef<HTMLDivElement>(null);
  const guideRef = useRef<HTMLDivElement>(null);
  const videoRef = useRef<HTMLVideoElement>(null);
  const [ready, setReady] = useState(false);
  const [quality, setQuality] = useState<Quality>('ok');
  // Latest props for the long-lived sampling loop (restarting it on every render would drop the streak).
  const live = useRef(props);
  useEffect(() => {
    live.current = props;
  });
  const captureRef = useRef<(() => void) | null>(null);

  useEffect(() => {
    const video = videoRef.current;
    if (!video || !stream) return;
    let disposed = false;
    let raf = 0;
    let lastTick = 0;
    let streak = 0;
    let capturing = false;
    let running = false;
    const sample = document.createElement('canvas');
    const sctx = sample.getContext('2d', { willReadFrequently: true });

    const guideCrop = () => {
      const box = boxRef.current?.getBoundingClientRect();
      const guide = guideRef.current?.getBoundingClientRect();
      if (!box || !guide || video.videoWidth === 0) return null;
      const crop = coverCrop({ w: video.videoWidth, h: video.videoHeight }, { w: box.width, h: box.height }, { x: guide.left - box.left, y: guide.top - box.top, w: guide.width, h: guide.height });
      return crop.w > 8 && crop.h > 8 ? crop : null;
    };

    const capture = () => {
      if (capturing || !live.current.canCapture()) return;
      const crop = guideCrop();
      if (!crop) return;
      capturing = true;
      const fit = fitWithin(Math.round(crop.w), Math.round(crop.h), MAX_EDGE);
      const canvas = document.createElement('canvas');
      canvas.width = fit.width;
      canvas.height = fit.height;
      canvas.getContext('2d')?.drawImage(video, crop.x, crop.y, crop.w, crop.h, 0, 0, fit.width, fit.height);
      encodeJpeg(canvas, fit.width, fit.height)
        .then((blob) => {
          if (!disposed && live.current.canCapture()) live.current.onCapture(new File([blob], 'live.jpg', { type: 'image/jpeg' }));
        })
        .catch(() => undefined)
        .finally(() => {
          capturing = false;
        });
    };
    captureRef.current = capture;

    const step = () => {
      if (live.current.busy || capturing || !sctx) {
        streak = 0;
        return;
      }
      const crop = guideCrop();
      if (!crop) return;
      const h = SAMPLE_EDGE;
      const w = Math.max(8, Math.round((SAMPLE_EDGE * crop.w) / crop.h));
      sample.width = w;
      sample.height = h;
      sctx.drawImage(video, crop.x, crop.y, crop.w, crop.h, 0, 0, w, h);
      const q = assessFrame(sctx.getImageData(0, 0, w, h));
      setQuality(q.reason ?? 'ok');
      if (q.reason) {
        streak = 0;
        live.current.onReject(q.reason);
        return;
      }
      streak += 1;
      if (streak >= AUTO_CAPTURE_STREAK && live.current.canCapture()) {
        streak = 0;
        capture();
      }
    };

    const loop = (ts: number) => {
      raf = requestAnimationFrame(loop);
      if (ts - lastTick < SAMPLE_INTERVAL_MS) return;
      lastTick = ts;
      step();
    };
    const start = () => {
      if (running || disposed) return;
      running = true;
      raf = requestAnimationFrame(loop);
    };
    const stop = () => {
      running = false;
      cancelAnimationFrame(raf);
      streak = 0;
    };
    const onVisibility = () => {
      if (document.hidden) {
        stop();
        video.pause();
      } else if (!disposed) {
        void video.play().catch(() => undefined);
        if (video.readyState >= 2) start();
      }
    };
    document.addEventListener('visibilitychange', onVisibility);
    const unwatch = watchTrack(stream, () => !disposed && live.current.onUnusable());

    verifyPlayback(video, stream).then(
      () => {
        if (disposed) return;
        setReady(true);
        if (!document.hidden) start();
      },
      () => {
        if (!disposed) live.current.onUnusable();
      }
    );

    return () => {
      disposed = true;
      stop();
      unwatch();
      document.removeEventListener('visibilitychange', onVisibility);
      captureRef.current = null;
      video.pause();
      video.srcObject = null;
      queueMicrotask(() => setReady(false));
    };
  }, [stream]);

  const chip = busy ? COPY.chipAnalyzing : quality !== 'ok' ? CHIP[quality] : retrying ? COPY.chipRetry : COPY.chipSteady;
  const corner = 'absolute size-6 border-accent';

  return (
    <section className="mx-auto flex w-full max-w-md flex-col gap-3 pt-1" data-testid="live-view" aria-label="Scan a card">
      <div ref={boxRef} className="relative aspect-[3/4] max-h-[50dvh] w-full overflow-hidden rounded-card bg-black" data-testid="live-viewfinder">
        <video ref={videoRef} playsInline muted autoPlay className={cx('absolute inset-0 size-full object-cover transition-opacity', ready ? 'opacity-100' : 'opacity-0')} data-testid="live-video" />
        {!ready && <div className="absolute inset-0 animate-pulse bg-skeleton" data-testid="live-skeleton" aria-hidden />}
        <div ref={guideRef} className="absolute left-1/2 top-1/2 h-[88%] -translate-x-1/2 -translate-y-1/2 rounded-[14px] shadow-[0_0_0_999px_rgba(0,0,0,0.55)]" style={{ aspectRatio: '63 / 88' }} data-testid="live-guide" aria-hidden>
          <span className={cx(corner, 'left-0 top-0 rounded-tl-[14px] border-l-[3px] border-t-[3px]')} />
          <span className={cx(corner, 'right-0 top-0 rounded-tr-[14px] border-r-[3px] border-t-[3px]')} />
          <span className={cx(corner, 'bottom-0 left-0 rounded-bl-[14px] border-b-[3px] border-l-[3px]')} />
          <span className={cx(corner, 'bottom-0 right-0 rounded-br-[14px] border-b-[3px] border-r-[3px]')} />
        </div>
        <div className="pointer-events-none absolute inset-x-0 top-3 flex justify-center px-3">
          <span role="status" aria-live="polite" className="rounded-full bg-black/70 px-3 py-1.5 text-small font-semibold text-white" data-testid="live-chip" data-state={busy ? 'analyzing' : quality === 'ok' ? (retrying ? 'retry' : 'steady') : quality}>
            {ready || busy ? chip : COPY.chipSteady}
          </span>
        </div>
      </div>

      <button
        type="button"
        data-testid="live-shutter"
        aria-label={COPY.shutter}
        aria-disabled={busy || !ready || undefined}
        onClick={() => !busy && ready && captureRef.current?.()}
        className={cx('mx-auto flex size-16 shrink-0 items-center justify-center rounded-full border-4 border-accent bg-surface-3 transition-transform active:scale-95', (busy || !ready) && 'opacity-45')}
      >
        <span className="size-11 rounded-full bg-accent" aria-hidden />
      </button>

      <div className="grid grid-cols-2 gap-x-2" data-testid="live-links">
        <Button variant="text" icon={Camera} data-testid="scan-take" onClick={props.onTakePhoto}>
          {COPY.takePhoto}
        </Button>
        <Button variant="text" icon={ImageIcon} data-testid="scan-choose" onClick={props.onChoosePhoto}>
          {COPY.choosePhoto}
        </Button>
        <Button variant="text" icon={Search} data-testid="scan-search" onClick={props.onSearchManually}>
          {COPY.searchManuallyTitle}
        </Button>
        <Button variant="text" icon={Layers} data-testid="scan-browse" onClick={props.onBrowseBySet}>
          {COPY.browseBySetTitle}
        </Button>
      </div>
    </section>
  );
}
