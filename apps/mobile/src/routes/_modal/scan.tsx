import { createFileRoute, useNavigate } from '@tanstack/react-router';
import { Camera, CloudOff, Image as ImageIcon, Layers, Search } from 'lucide-react';
import { useEffect, useRef, useState, type ChangeEvent } from 'react';
import { ModalPage, useCloseOrBack } from '../../components/page';
import { ScanFlow } from '../../components/scanner/scan-flow';
import { useSettings } from '../../data';
import { Banner, Button } from '../../components/ui';
import { checkScannerOnline } from '../../lib/recognition/client';
import { COPY } from '../../lib/recognition/copy';

export const Route = createFileRoute('/_modal/scan')({ component: ScanPage });

/** `accept` deliberately omits `image/*`: iOS then transcodes HEIC → JPEG for us (research/ios-camera.md §2). */
const ACCEPT = 'image/jpeg,image/png,image/webp';

function ScanPage() {
  const navigate = useNavigate();
  const close = useCloseOrBack('/');
  const takeRef = useRef<HTMLInputElement>(null);
  const chooseRef = useRef<HTMLInputElement>(null);
  const [shot, setShot] = useState<{ file: File; id: number } | null>(null);
  const seq = useRef(0);
  const [online, setOnline] = useState<boolean | null>(null);
  // Warm the settings query: the confirm sheet derives its default currency from it and would otherwise look "dirty" when it lands late.
  useSettings();

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
    if (file) setShot({ file, id: ++seq.current });
  };

  const openCamera = () => takeRef.current?.click();
  /** Must run synchronously inside a click handler so iOS allows the picker. */
  const scanAnother = () => {
    setShot(null);
    openCamera();
  };
  const toAdd = () => void navigate({ to: '/add' });
  const toSets = () => void navigate({ to: '/sets' });

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

      {shot ? (
        <ScanFlow key={shot.id} file={shot.file} onCancel={() => setShot(null)} onTryAnother={scanAnother} onSearchManually={toAdd} onBrowseBySet={toSets} onScanAnother={scanAnother} />
      ) : (
        <section className="mx-auto flex w-full max-w-md flex-col gap-3 pt-2" data-testid="scan-capture" aria-label="Scan a card">
          <p className="text-center text-body text-fg-muted">Photograph one card on a plain background with the whole card in frame.</p>
          <Button variant="primary" full icon={Camera} data-testid="scan-take" onClick={openCamera}>
            {COPY.takePhoto}
          </Button>
          <Button variant="secondary" full icon={ImageIcon} data-testid="scan-choose" onClick={() => chooseRef.current?.click()}>
            {COPY.choosePhoto}
          </Button>
          <Button variant="secondary" full icon={Search} data-testid="scan-search" onClick={toAdd}>
            {COPY.searchManuallyTitle}
          </Button>
          <Button variant="secondary" full icon={Layers} data-testid="scan-browse" onClick={toSets}>
            {COPY.browseBySetTitle}
          </Button>
        </section>
      )}
    </ModalPage>
  );
}
