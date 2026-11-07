import { useNavigate } from '@tanstack/react-router';
import { Camera, CheckCircle2, CloudOff, SearchX } from 'lucide-react';
import { useEffect, useMemo, useRef, useState, type ReactNode } from 'react';
import { useCandidateAvailability, useScan, type Availability, type ScanState } from '../../data/recognition';
import { useCatalogInstall, useRemoveCopy } from '../../data';
import { useSettings, useUpdateSettings } from '../../data';
import { collectorNumber, LANGUAGE_BADGE, LANGUAGE_NAMES, type Language, type Variant } from '../../lib/format';
import { suggestVariant, type RecognitionCandidate } from '../../lib/recognition/client';
import { cardMissing, catalogMissing, COPY, failureCopy, installCatalog } from '../../lib/recognition/copy';
import { isNoMatch } from '../../lib/recognition/retry';
import { AddConfirmSheet, type AddedInfo } from '../add-confirm';
import { CardArt, LangBadge } from '../card';
import { Banner, Button, LinkButton, ProgressBar, Spinner } from '../ui';
import { Coach } from './coach';

export type ScanFlowProps = {
  file: File;
  onCancel: () => void;
  /** Re-open the capture input (Take Photo). */
  onTryAnother: () => void;
  onSearchManually: () => void;
  onBrowseBySet: () => void;
  /** After a successful add: clear the photo and re-open the camera input (must run inside the click handler). */
  onScanAnother: () => void;
  /** A settled result from the live session: shown as-is (no upload of `file`). */
  outcome?: ScanState;
  /** Retry button override (live: back to the viewfinder). Defaults to re-running the same photo. */
  onRetry?: () => void;
  /** Consecutive no-match photos before this one; ≥ 1 turns this no-match into the coach. */
  priorNoMatches?: number;
  /** Reports the settled kind once (drives the file-mode no-match streak). */
  onOutcome?: (kind: 'no_match' | 'ok' | 'failed') => void;
  /** Coach actions (file mode): Keep Scanning resets the streak; Take Photo opens the system camera inside the click. */
  onKeepScanning?: () => void;
  onTakePhoto?: () => void;
};

type PickProps = Omit<ScanFlowProps, 'file' | 'onCancel' | 'onScanAnother'> & { onPick: (candidate: RecognitionCandidate, isTop: boolean) => void };

const percent = (score: number): number => Math.round(score * 100);
/** TCGdex `…/low.webp` → base URL, so CardArt can paint low first and swap to high.webp. */
const artBase = (url: string | null): string | null => (url ? url.replace(/\/(low|high)\.webp$/, '') : null);

function useObjectUrl(file: File): string | null {
  const [url, setUrl] = useState<string | null>(null);
  useEffect(() => {
    const u = URL.createObjectURL(file);
    queueMicrotask(() => setUrl(u));
    return () => URL.revokeObjectURL(u);
  }, [file]);
  return url;
}

/** Moves focus to the heading whenever `key` changes (screen readers announce the new state). */
function Heading({ stateKey, children, className }: { stateKey: string; children: ReactNode; className?: string }) {
  const ref = useRef<HTMLHeadingElement>(null);
  useEffect(() => {
    ref.current?.focus({ preventScroll: true });
  }, [stateKey]);
  return (
    <h2 ref={ref} tabIndex={-1} className={`text-h3 font-semibold outline-none ${className ?? ''}`} data-testid="scan-heading">
      {children}
    </h2>
  );
}

export function ScanFlow(props: ScanFlowProps) {
  const { file, onCancel } = props;
  const scan = useScan(props.outcome ? null : file);
  const state: ScanState = props.outcome ?? scan.state;
  const retry = props.onRetry ?? scan.retry;
  const { onOutcome } = props;
  const reported = useRef<ScanState | null>(null);
  useEffect(() => {
    if (reported.current === state) return;
    if (state.phase === 'done') onOutcome?.(isNoMatch(state.response.status) ? 'no_match' : 'ok');
    else if (state.phase === 'failed') onOutcome?.('failed');
    else return;
    reported.current = state;
  }, [state, onOutcome]);
  const thumb = useObjectUrl(file);
  const navigate = useNavigate();
  const remove = useRemoveCopy();
  const [view, setView] = useState<'main' | 'wrong'>('main');
  const [missing, setMissing] = useState<{ candidate: RecognitionCandidate; availability: Availability } | null>(null);
  const [pick, setPick] = useState<{ candidate: RecognitionCandidate; isTop: boolean } | null>(null);
  const [added, setAdded] = useState<{ info: AddedInfo; language: Language; cardId: string; undone: boolean } | null>(null);
  const pickProps: PickProps = { onTryAnother: props.onTryAnother, onSearchManually: props.onSearchManually, onBrowseBySet: props.onBrowseBySet, onPick: (candidate, isTop) => setPick({ candidate, isTop }) };

  const undoAdd = async () => {
    if (!added) return;
    for (const id of added.info.ids) {
      try {
        await remove.mutateAsync({ id });
      } catch {
        return;
      }
    }
    setAdded({ ...added, undone: true });
  };

  const suggestion: Variant | null = pick?.isTop ? (suggestVariant(pick.candidate.variantHints, ['normal', 'holo', 'reverse_holo', 'first_edition', 'promo_stamped']) as Variant | null) : null;
  const confirmSheet = (
    <AddConfirmSheet
      target={pick ? { kind: 'catalog', language: pick.candidate.language, cardId: pick.candidate.cardId } : null}
      suggestedVariant={suggestion}
      onClose={() => setPick(null)}
      onAddAnother={props.onScanAnother}
      onAdded={(info) => {
        if (!pick) return;
        setAdded({ info, language: pick.candidate.language, cardId: pick.candidate.cardId, undone: false });
        setPick(null);
      }}
    />
  );

  const stateKey = added ? 'added' : state.phase === 'analyzing' ? 'analyzing' : state.phase === 'failed' ? `failed:${state.failure.kind}` : `${state.response.status}:${view}:${missing?.candidate.cardId ?? ''}`;
  const live = added ? COPY.addedToCollection : state.phase === 'analyzing' ? COPY.analyzing : state.phase === 'failed' ? failureCopy(state.failure).title : state.response.status === 'match' ? 'Card found' : state.response.status === 'candidates' ? COPY.possibilities : COPY.notIdentified;

  let body: ReactNode;
  if (added) {
    body = (
      <div className="flex w-full flex-col items-center gap-3 text-center" data-testid="scan-added">
        <CheckCircle2 size={56} className="text-positive" aria-hidden />
        <Heading stateKey={stateKey}>{added.undone ? 'Removed' : COPY.addedToCollection}</Heading>
        <p className="max-w-[34ch] break-words text-body text-fg-muted" data-testid="scan-added-name">
          {added.undone ? `${added.info.name} was removed again.` : `${added.info.name} × ${added.info.qty}${added.info.setName ? ` · ${added.info.setName}` : ''}`}
        </p>
        <Button variant="primary" full className="max-w-xs" icon={Camera} data-testid="scan-another" onClick={props.onScanAnother}>
          {COPY.scanAnother}
        </Button>
        {!added.undone && (
          <>
            <Button variant="secondary" full className="max-w-xs" data-testid="scan-view-card" onClick={() => void navigate({ to: '/cards/$language/$cardId', params: { language: added.language, cardId: added.cardId } })}>
              {COPY.viewCard}
            </Button>
            <Button variant="text" loading={remove.isPending} data-testid="scan-undo" onClick={() => void undoAdd()}>
              Undo
            </Button>
          </>
        )}
      </div>
    );
  } else if (state.phase === 'analyzing') {
    body = (
      <div className="flex w-full flex-col items-center gap-4" data-testid="scan-analyzing">
        <PhotoThumb src={thumb} />
        <div className="flex items-center gap-2" data-testid="scan-status">
          <Spinner size={20} />
          <Heading stateKey={stateKey}>{COPY.analyzing}</Heading>
        </div>
        <div className="w-full max-w-xs">
          <ProgressBar value={null} max={null} label={state.step === 'preparing' ? COPY.preparing : COPY.analyzing} />
        </div>
        <Button variant="secondary" full className="max-w-xs" data-testid="scan-cancel" onClick={onCancel}>
          {COPY.cancel}
        </Button>
      </div>
    );
  } else if (state.phase === 'failed') {
    const c = failureCopy(state.failure);
    body = (
      <div className="flex w-full flex-col items-center gap-3 text-center" data-testid="scan-failure" data-failure={state.failure.kind}>
        <div className="flex size-16 items-center justify-center rounded-full bg-warning-soft text-warning" aria-hidden>
          <CloudOff size={32} />
        </div>
        <Heading stateKey={stateKey}>{c.title}</Heading>
        <p className="max-w-[34ch] text-body text-fg-muted" data-testid="scan-failure-body">
          {c.body}
        </p>
        {c.canRetry && (
          <Button variant="primary" full className="max-w-xs" data-testid="scan-retry" onClick={retry}>
            {COPY.tryAgain}
          </Button>
        )}
        <Button variant={c.canRetry ? 'secondary' : 'primary'} full className="max-w-xs" icon={Camera} data-testid="scan-try-another" onClick={props.onTryAnother}>
          {COPY.tryAnotherPhoto}
        </Button>
        <Fallbacks onSearchManually={props.onSearchManually} onBrowseBySet={props.onBrowseBySet} />
      </div>
    );
  } else if (missing) {
    body = (
      <div className="flex w-full flex-col items-center gap-4">
        <CandidateCard candidate={missing.candidate} availability={missing.availability} />
        <MissingOffer candidate={missing.candidate} availability={missing.availability} {...pickProps} stateKey={stateKey} />
        <Button variant="text" onClick={() => setMissing(null)} data-testid="scan-back">
          {COPY.backToPossibilities}
        </Button>
      </div>
    );
  } else {
    const { response } = state;
    const [top, ...others] = response.candidates;
    if (response.status === 'match' && top && view === 'main') {
      body = (
        <div className="flex w-full flex-col items-center gap-4" data-testid="scan-match">
          <MatchView candidate={top} stateKey={stateKey} {...pickProps} onWrong={() => setView('wrong')} />
        </div>
      );
    } else if ((response.status === 'candidates' && response.candidates.length > 0) || (response.status === 'match' && view === 'wrong' && others.length > 0)) {
      const list = response.status === 'match' ? others : response.candidates;
      body = (
        <div className="flex w-full flex-col items-center gap-4" data-testid="scan-candidates">
          <Heading stateKey={stateKey}>{response.status === 'match' ? COPY.otherPossibilities : COPY.possibilities}</Heading>
          <p className="text-body text-fg-muted">{COPY.tapToContinue}</p>
          <ul className="grid w-full grid-cols-1 gap-3 min-[390px]:grid-cols-2">
            {list.map((c, i) => (
              <li key={`${c.language}:${c.cardId}`}>
                <CandidateTile
                  candidate={c}
                  testId={`scan-candidate-${i}`}
                  onSelect={(availability) => {
                    if (availability.state === 'ok') pickProps.onPick(c, response.status === 'candidates' && i === 0);
                    else setMissing({ candidate: c, availability });
                  }}
                />
              </li>
            ))}
          </ul>
          <Button variant="text" data-testid="scan-try-another" icon={Camera} onClick={props.onTryAnother}>
            {COPY.tryAnotherPhoto}
          </Button>
          <Fallbacks onSearchManually={props.onSearchManually} onBrowseBySet={props.onBrowseBySet} secondary />
        </div>
      );
    } else if ((props.priorNoMatches ?? 0) >= 1) {
      body = <Coach lead="dark-surface" onKeepScanning={props.onKeepScanning ?? props.onTryAnother} onTakePhoto={props.onTakePhoto ?? props.onTryAnother} onSearchManually={props.onSearchManually} onBrowseBySet={props.onBrowseBySet} />;
    } else {
      body = (
        <div className="flex w-full flex-col items-center gap-3 text-center" data-testid="scan-no-match" data-status={response.status}>
          <div className="flex size-16 items-center justify-center rounded-full bg-surface-3 text-fg-subtle" aria-hidden>
            <SearchX size={32} />
          </div>
          <Heading stateKey={stateKey}>{COPY.notIdentified}</Heading>
          {response.status === 'no_card' && <p className="max-w-[34ch] text-body text-fg-muted">{COPY.noCardHint}</p>}
          <Button variant="primary" full className="max-w-xs" icon={Camera} data-testid="scan-try-another" onClick={props.onTryAnother}>
            {COPY.tryAnotherPhoto}
          </Button>
          <Fallbacks onSearchManually={props.onSearchManually} onBrowseBySet={props.onBrowseBySet} />
        </div>
      );
    }
  }

  return (
    <section data-testid="scan-flow" aria-label="Card scan" className="mx-auto flex w-full max-w-md flex-col items-center gap-4 pb-8 pt-2">
      <div role="status" aria-live="polite" className="sr-only" data-testid="scan-live">
        {live}
      </div>
      {state.phase === 'failed' && !added && <PhotoThumb src={thumb} small />}
      {body}
      {confirmSheet}
    </section>
  );
}

function PhotoThumb({ src, small }: { src: string | null; small?: boolean }) {
  return (
    <div className={`flex items-center justify-center overflow-hidden rounded-card bg-skeleton ${small ? 'h-24 w-20' : 'h-56 w-44'}`} data-testid="scan-thumb">
      {src && <img src={src} alt="Your photo" className="size-full object-contain" draggable={false} />}
    </div>
  );
}

function Fallbacks({ onSearchManually, onBrowseBySet, secondary }: Pick<ScanFlowProps, 'onSearchManually' | 'onBrowseBySet'> & { secondary?: boolean }) {
  return (
    <div className={`flex w-full max-w-xs ${secondary ? 'flex-row justify-center gap-1' : 'flex-col gap-2'}`} data-testid="scan-fallbacks">
      <Button variant={secondary ? 'text' : 'secondary'} full={!secondary} data-testid="scan-search-manually" onClick={onSearchManually}>
        {COPY.searchManually}
      </Button>
      <Button variant={secondary ? 'text' : 'secondary'} full={!secondary} data-testid="scan-browse-sets" onClick={onBrowseBySet}>
        {COPY.browseBySet}
      </Button>
    </div>
  );
}

function CandidateCard({ candidate: c, availability }: { candidate: RecognitionCandidate; availability: Availability }) {
  const number = collectorNumber(c.localId, availability.state === 'ok' ? availability.setOfficialCount : null);
  return (
    <div className="flex w-full flex-col items-center gap-3 text-center" data-testid="scan-candidate-card">
      <div className="w-full max-w-[260px]">
        <CardArt image={artBase(c.imageUrl)} size="high" lowFirst priority meta={{ name: c.name, setName: c.setName, localId: c.localId }} alt={`${c.name} card art`} />
      </div>
      <div className="min-w-0">
        <h3 className="break-words text-h3 font-semibold" data-testid="scan-card-name">
          {c.name}
        </h3>
        <p className="text-small text-fg-muted">{c.setName}</p>
        <p className="mt-1 flex items-center justify-center gap-2 text-small text-fg-muted">
          <span data-testid="scan-card-number">{number}</span>
          <LangBadge language={c.language} />
          <span data-testid="scan-card-score">{percent(c.score)}%</span>
        </p>
      </div>
    </div>
  );
}

function MatchView({ candidate, onWrong, stateKey, ...props }: PickProps & { candidate: RecognitionCandidate; onWrong: () => void; stateKey: string }) {
  const availability = useCandidateAvailability(candidate);
  return (
    <>
      <Heading stateKey={stateKey} className="sr-only">
        We found your card
      </Heading>
      <CandidateCard candidate={candidate} availability={availability} />
      {availability.state === 'ok' || availability.state === 'checking' ? (
        <div className="flex w-full max-w-xs flex-col gap-2">
          <Button variant="primary" full loading={availability.state === 'checking'} data-testid="scan-confirm" onClick={() => props.onPick(candidate, true)}>
            {COPY.confirmAdd}
          </Button>
          <Button variant="secondary" full data-testid="scan-wrong" onClick={onWrong}>
            {COPY.wrongCard}
          </Button>
          <Button variant="text" data-testid="scan-try-another" icon={Camera} onClick={props.onTryAnother}>
            {COPY.tryAnotherPhoto}
          </Button>
        </div>
      ) : (
        <>
          <MissingOffer candidate={candidate} availability={availability} {...props} stateKey={stateKey} />
          <Button variant="text" data-testid="scan-wrong" onClick={onWrong}>
            {COPY.wrongCard}
          </Button>
        </>
      )}
    </>
  );
}

function CandidateTile({ candidate: c, onSelect, testId }: { candidate: RecognitionCandidate; onSelect: (a: Availability) => void; testId: string }) {
  const availability = useCandidateAvailability(c);
  const number = collectorNumber(c.localId, availability.state === 'ok' ? availability.setOfficialCount : null, { hash: false });
  const label = `${c.name} — ${number} — ${percent(c.score)}%`;
  return (
    <button type="button" data-testid={testId} aria-label={`${label}, ${c.setName}, ${LANGUAGE_NAMES[c.language]}`} onClick={() => availability.state !== 'checking' && onSelect(availability)} className="flex w-full flex-col gap-2 rounded-card text-left active:opacity-80">
      <CardArt image={artBase(c.imageUrl)} size="high" lowFirst meta={{ name: c.name, setName: c.setName, localId: c.localId }} alt="" />
      <span className="block px-0.5">
        <span className="block break-words text-small font-semibold" data-testid="scan-tile-label">
          {label}
        </span>
        <span className="block text-caption text-fg-muted">
          {c.setName} · {LANGUAGE_BADGE[c.language]}
        </span>
      </span>
    </button>
  );
}

/** Recognized card not usable from the local catalog: install the language / update / add as custom. */
function MissingOffer({ candidate: c, availability, onSearchManually, onBrowseBySet, stateKey }: PickProps & { candidate: RecognitionCandidate; availability: Availability; stateKey: string }) {
  const install = useCatalogInstall();
  const settings = useSettings();
  const updateSettings = useUpdateSettings();
  const [busy, setBusy] = useState(false);
  const langName = LANGUAGE_NAMES[c.language];
  const langMissing = availability.state === 'lang_missing';
  const customSearch = useMemo(() => ({ name: c.name }) as never, [c.name]);

  const doInstall = async () => {
    setBusy(true);
    try {
      const selected = (settings.data?.languages ?? []) as Language[];
      if (!selected.includes(c.language)) await updateSettings.mutateAsync({ languages: [...selected, c.language] } as never);
      await install.start(c.language);
    } catch {
      /* surfaced by install.error below */
    } finally {
      setBusy(false);
    }
  };
  const pct = install.progress?.compressedBytesTotal ? Math.round((install.progress.compressedBytesDone / install.progress.compressedBytesTotal) * 100) : null;

  return (
    <div className="flex w-full max-w-xs flex-col gap-2 text-center" data-testid="scan-missing" data-reason={availability.state}>
      <Heading stateKey={stateKey} className="sr-only">
        {langMissing ? `${langName} catalog not installed` : 'Card not in catalog'}
      </Heading>
      <Banner tone="warning" testId="scan-missing-message">
        {langMissing ? catalogMissing(langName) : cardMissing()}
      </Banner>
      {install.active && <ProgressBar value={pct} max={pct === null ? null : 100} label={`Downloading the ${langName} catalog`} />}
      {install.error && install.errorLanguage === c.language && <Banner tone="negative">The {langName} catalog couldn’t be installed. Try again from Settings → Catalog.</Banner>}
      {langMissing ? (
        <Button variant="primary" full loading={busy || install.active} data-testid="scan-install-catalog" onClick={() => void doInstall()}>
          {installCatalog(langName)}
        </Button>
      ) : (
        <LinkButton to="/settings/catalog" variant="primary" full data-testid="scan-update-catalog">
          {COPY.updateCatalog}
        </LinkButton>
      )}
      <LinkButton to="/custom-cards/new" search={customSearch} variant="secondary" full data-testid="scan-add-custom">
        {COPY.addCustom}
      </LinkButton>
      <Button variant="secondary" full data-testid="scan-search-manually" onClick={onSearchManually}>
        {COPY.searchManually}
      </Button>
      <Button variant="secondary" full data-testid="scan-browse-sets" onClick={onBrowseBySet}>
        {COPY.browseBySet}
      </Button>
    </div>
  );
}
