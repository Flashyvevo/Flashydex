import { useEffect, useRef, useState } from 'react';
import { CameraError, openRearCamera, type CameraFailureKind, type RearCamera } from '../../lib/recognition/camera';

/** Opens the rear camera while `enabled`; stops every track when disabled/unmounted. `stream` is null while opening or after failure. */
export function useRearCamera(enabled: boolean, onFail: (kind: CameraFailureKind) => void): MediaStream | null {
  const [stream, setStream] = useState<MediaStream | null>(null);
  const onFailRef = useRef(onFail);
  useEffect(() => {
    onFailRef.current = onFail;
  });
  useEffect(() => {
    if (!enabled) return;
    let cancelled = false;
    let camera: RearCamera | null = null;
    openRearCamera().then(
      (c) => {
        if (cancelled) return c.stop();
        camera = c;
        setStream(c.stream);
      },
      (error: unknown) => {
        if (!cancelled) onFailRef.current(error instanceof CameraError ? error.kind : 'unavailable');
      }
    );
    return () => {
      cancelled = true;
      camera?.stop();
      queueMicrotask(() => setStream(null));
    };
  }, [enabled]);
  return enabled ? stream : null;
}
