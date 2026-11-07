import { createFileRoute, useNavigate } from '@tanstack/react-router';
import { Camera, CloudOff, Image as ImageIcon, Layers, Search } from 'lucide-react';
import { useEffect, useRef, useState, type ChangeEvent } from 'react';
import { ModalPage, useCloseOrBack } from '../../components/page';
import { Coach } from '../../components/scanner/coach';
import { LiveView } from '../../components/scanner/live-view';
import { useRearCamera } from '../../components/scanner/use-rear-camera';
import { ScanFlow } from '../../components/scanner/scan-flow';
import { useSettings } from '../../data';
import { useLiveSession } from '../../data/recognition';
import { Banner, Button, Spinner } from '../../components/ui';
import { cameraAvailable } from '../../lib/recognition/camera';
import { checkScannerOnline } from '../../lib/recognition/client';
import { COPY } from '../../lib/recognition/copy';

export const Route = createFileRoute('/_modal/scan')({ component: ScanPage });

/** `accept` deliberately omits `image/*`: iOS then transcodes HEIC → JPEG for us (research/ios-camera.md §2). */
const ACCEPT = 'image/jpeg,image/png,image/webp';

/** Dev/test only: `?camera=live|file` forces a mode. Production builds ignore it. */
function forcedMode(): 'live' | 'file' | null {
  if (!import.meta.env.DEV) return null;
  const v = new URLSearchParams(window.location.search).get('camera');
  return v === 'live' || v === 'file' ? v : null;
}

function ScanPage() {
  const navigate = useNavigate();
  const close = useCloseOrBack('/');
  const takeRef = useRef<HTMLInputElement>(null);
  const chooseRef = useRef<HTMLInputElement>(null);
  const [shot, setShot] = useState<{ file: File; id: number; prior: number } | null>(null);
  const seq = useRef(0);
  /** Consecutive no-match photos (file input path): the second one shows the coach. */
  const streak = useRef(0);
  const [online, setOnline] = useState<boolean | null>(null);
  const [forced] = useState(forcedMode);
  /** The live camera was denied / unavailable / blank / lost: silently use the file-input flow. */
  const [fellBack, setFellBack] = useState(false);
  const session = useLiveSession();
  const mode: 'live' | 'file' = forced === 'file' || fellBack || (forced !== 'live' && !cameraAvailable()) ? 'file' : 'live';
  // Warm the settings query: the confirm sheet derives its default currency from it and would otherwise look "dirty" when it lands late.
  useSettings();

  // The camera runs only while the viewfinder is on screen; results, coach and errors release it (battery, iOS 90 s revoke bug).
  const wantCamera = mode === 'live' && !shot && (session.phase === 'live' || session.phase === 'analyzing');
  const stream = useRearCamera(wantCamera, () => setFellBack(true));

  // Checked once on mount; never gates manual add or the capture buttons.
  useEffect(() => {
    let live = true;
    void checkScannerOnline().then((ok) => live && setOnline(ok));
    return () => {
      live = false;
    };
  }, []);

  const onFile = (e: ChangeEvent<HTMLInputElement>) => {
    const file = e.target.files?.[0];
    e.target.value = ''; // the same photo can be picked again
    if (file) setShot({ file, id: ++seq.current, prior: streak.current });
  };

  const openCamera = () => takeRef.current?.click();
  const openLibrary = () => chooseRef.current?.click();
  /** Back to capture: the viewfinder in live mode, the system camera in file mode (must run synchronously inside a click so iOS allows the picker). Keeps the no-match streak. */
  const tryAnother = () => {
    setShot(null);
    session.reset();
    if (mode === 'file') openCamera();
  };
  /** Scan Another after an add: same, with fresh counters. */
  const scanAnother = () => {
    streak.current = 0;
    tryAnother();
  };
  /** Keep Scanning from the coach: no system camera, just the landing / viewfinder. */
  const keepScanning = () => {
    streak.current = 0;
    setShot(null);
    session.reset();
  };
  const toAdd = () => void navigate({ to: '/add' });
  const toSets = () => void navigate({ to: '/sets' });
  const flowCommon = { onSearchManually: toAdd, onBrowseBySet: toSets, onScanAnother: scanAnother, onTryAnother: tryAnother, onKeepScanning: keepScanning, onTakePhoto: openCamera } as const;

  let body;
  if (shot) {
    body = (
      <ScanFlow
        key={shot.id}
        file={shot.file}
        onCancel={() => setShot(null)}
        priorNoMatches={shot.prior}
        onOutcome={(kind) => {
          streak.current = kind === 'no_match' ? shot.prior + 1 : kind === 'ok' ? 0 : shot.prior;
        }}
        {...flowCommon}
      />
    );
  } else if ((session.phase === 'result' || session.phase === 'error') && session.outcome && session.file) {
    body = <ScanFlow file={session.file} outcome={session.outcome} onCancel={keepScanning} onRetry={keepScanning} {...flowCommon} />;
  } else if (session.phase === 'coach') {
    body = (
      <section className="mx-auto flex w-full max-w-md flex-col items-center pb-8 pt-2" aria-label="Scan a card">
        <Coach lead={session.lead} onKeepScanning={keepScanning} onTakePhoto={openCamera} onSearchManually={toAdd} onBrowseBySet={toSets} />
      </section>
    );
  } else if (mode === 'live') {
    body = (
      <LiveView
        stream={stream}
        busy={session.phase === 'analyzing'}
        retrying={session.retrying}
        canCapture={session.canSubmit}
        onCapture={session.submit}
        onReject={session.reject}
        onUnusable={() => setFellBack(true)}
        onTakePhoto={openCamera}
        onChoosePhoto={openLibrary}
        onSearchManually={toAdd}
        onBrowseBySet={toSets}
      />
    );
  } else if (session.phase === 'analyzing') {
    // The camera dropped mid-analysis: keep the in-flight result instead of discarding it.
    body = (
      <section className="mx-auto flex w-full max-w-md flex-col items-center gap-3 pt-6" data-testid="scan-analyzing" aria-label="Scan a card">
        <Spinner size={24} />
        <p className="text-body text-fg-muted">{COPY.analyzing}</p>
      </section>
    );
  } else {
    body = (
      <section className="mx-auto flex w-full max-w-md flex-col gap-3 pt-2" data-testid="scan-capture" aria-label="Scan a card">
        {fellBack && (
          <p className="text-center text-caption text-fg-subtle" data-testid="scan-camera-hint">
            {COPY.usingCameraApp}
          </p>
        )}
        <p className="text-center text-body text-fg-muted">Photograph one card on a plain background with the whole card in frame.</p>
        <Button variant="primary" full icon={Camera} data-testid="scan-take" onClick={openCamera}>
          {COPY.takePhoto}
        </Button>
        <Button variant="secondary" full icon={ImageIcon} data-testid="scan-choose" onClick={openLibrary}>
          {COPY.choosePhoto}
        </Button>
        <Button variant="secondary" full icon={Search} data-testid="scan-search" onClick={toAdd}>
          {COPY.searchManuallyTitle}
        </Button>
        <Button variant="secondary" full icon={Layers} data-testid="scan-browse" onClick={toSets}>
          {COPY.browseBySetTitle}
        </Button>
      </section>
    );
  }

  return (
    <ModalPage title="Scan a card" onClose={close}>
      <input ref={takeRef} type="file" accept={ACCEPT} capture="environment" className="hidden" data-testid="scan-take-input" aria-hidden tabIndex={-1} onChange={onFile} />
      <input ref={chooseRef} type="file" accept={ACCEPT} className="hidden" data-testid="scan-choose-input" aria-hidden tabIndex={-1} onChange={onFile} />

      {online === false && (
        <div className="mb-3">
          <Banner tone="warning" testId="scan-offline-banner">
            <span className="flex items-start gap-2">
              <CloudOff size={18} className="mt-0.5 shrink-0" aria-hidden />
              <span>Scanner offline — you can still add cards by search or by browsing a set.</span>
            </span>
          </Banner>
        </div>
      )}

      {body}
    </ModalPage>
  );
}
