import { Camera, Layers, ScanLine, Search } from 'lucide-react';
import { useEffect, useRef } from 'react';
import { coachBullets, COPY, type CoachLead } from '../../lib/recognition/copy';
import { Button } from '../ui';

export type CoachProps = {
  lead: CoachLead;
  onKeepScanning: () => void;
  /** Must run synchronously inside the click (opens the system camera input). */
  onTakePhoto: () => void;
  onSearchManually: () => void;
  onBrowseBySet: () => void;
};

/** Shown after 3 failed live attempts (or 2 consecutive no-match photos): coaching, never a dead end. */
export function Coach({ lead, onKeepScanning, onTakePhoto, onSearchManually, onBrowseBySet }: CoachProps) {
  const heading = useRef<HTMLHeadingElement>(null);
  useEffect(() => heading.current?.focus({ preventScroll: true }), []);
  return (
    <div className="flex w-full flex-col items-center gap-3 text-center" data-testid="scan-coach" data-lead={lead}>
      <div role="status" aria-live="polite" className="sr-only">
        {COPY.coachTitle}
      </div>
      <div className="flex size-16 items-center justify-center rounded-full bg-accent-soft text-accent-fg" aria-hidden>
        <ScanLine size={32} />
      </div>
      <h2 ref={heading} tabIndex={-1} className="text-h3 font-semibold outline-none" data-testid="scan-heading">
        {COPY.coachTitle}
      </h2>
      <ul className="w-full max-w-xs list-disc space-y-1 pl-5 text-left text-body text-fg-muted" data-testid="scan-coach-tips">
        {coachBullets(lead).map((tip) => (
          <li key={tip}>{tip}</li>
        ))}
      </ul>
      <Button variant="primary" full className="max-w-xs" icon={ScanLine} data-testid="scan-coach-keep" onClick={onKeepScanning}>
        {COPY.keepScanning}
      </Button>
      <Button variant="secondary" full className="max-w-xs" icon={Camera} data-testid="scan-coach-take" onClick={onTakePhoto}>
        {COPY.takePhoto}
      </Button>
      <Button variant="secondary" full className="max-w-xs" icon={Search} data-testid="scan-search-manually" onClick={onSearchManually}>
        {COPY.searchManuallyTitle}
      </Button>
      <Button variant="secondary" full className="max-w-xs" icon={Layers} data-testid="scan-browse-sets" onClick={onBrowseBySet}>
        {COPY.browseBySetTitle}
      </Button>
    </div>
  );
}
