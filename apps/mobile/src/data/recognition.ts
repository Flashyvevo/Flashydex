import { useCallback, useEffect, useRef, useState } from 'react';
import { identify, langHint, type RecognitionFailure, type RecognitionResponse } from '../lib/recognition/client';
import type { CoachLead } from '../lib/recognition/copy';
import { dominantRejection, emptyRejections, type Rejection, type RejectionCounts } from '../lib/recognition/frame-quality';
import { attemptAllowed, isNoMatch, MAX_FAILED_ATTEMPTS } from '../lib/recognition/retry';
import { prepareImage, PrepareError } from '../lib/recognition/prepare';
import { recordScan } from '../lib/recognition/timing';
import { useCatalogCard } from './catalog-hooks';
import { useCatalogStatus } from './install-hooks';
import type { Language } from '../lib/format';

/** `en` / `ja` / `any` from the installed catalogs; `null` until both statuses are known (errors resolve to `any`). */
export function useLangHint(): 'en' | 'ja' | 'any' | null {
  const en = useCatalogStatus('en');
  const ja = useCatalogStatus('ja');
  const settled = (q: { isSuccess: boolean; isError: boolean }) => q.isSuccess || q.isError;
  if (!settled(en) || !settled(ja)) return null;
  return langHint(en.data?.installed.status === 'installed', ja.data?.installed.status === 'installed');
}

export type ScanState =
  | { phase: 'analyzing'; step: 'preparing' | 'uploading' }
  | { phase: 'done'; response: RecognitionResponse; width: number; height: number; bytes: number; originalBytes: number }
  | { phase: 'failed'; failure: RecognitionFailure };

type Settled = Exclude<ScanState, { phase: 'analyzing' }>;

/** prepare → identify for one photo. Returns null when aborted. Never throws. `onStep` reports preparing → uploading. */
async function runScan(file: File, hint: 'en' | 'ja' | 'any', signal: AbortSignal, onStep?: (step: 'uploading') => void): Promise<Settled | null> {
  const t0 = performance.now();
  try {
    const prepared = await prepareImage(file);
    if (signal.aborted) return null;
    onStep?.('uploading');
    const result = await identify(prepared.blob, { lang: hint, maxCandidates: 3, signal });
    if (signal.aborted) return null;
    const totalMs = performance.now() - t0;
    if (result.ok) {
      recordScan({ prepareMs: prepared.ms, uploadMs: result.timing.uploadMs, networkMs: result.timing.networkMs, serverMs: result.timing.serverMs, totalMs, originalBytes: prepared.originalBytes, uploadBytes: prepared.bytes, width: prepared.width, height: prepared.height, status: result.response.status });
      return { phase: 'done', response: result.response, width: prepared.width, height: prepared.height, bytes: prepared.bytes, originalBytes: prepared.originalBytes };
    }
    recordScan({ prepareMs: prepared.ms, uploadMs: null, networkMs: null, serverMs: null, totalMs, originalBytes: prepared.originalBytes, uploadBytes: prepared.bytes, width: prepared.width, height: prepared.height, status: `failed:${result.failure.kind}` });
    return { phase: 'failed', failure: result.failure };
  } catch (error) {
    if (signal.aborted) return null;
    if (error instanceof PrepareError) return { phase: 'failed', failure: { kind: 'unsupported_image', heic: error.heic, detail: 'unreadable', reason: error.reason } };
    return { phase: 'failed', failure: { kind: 'unknown', status: 0, code: null, retryable: true } };
  }
}

/** Runs prepare → identify for `file`. Cancelled on unmount/file change. `retry()` re-runs the same photo. Never throws. */
export function useScan(file: File | null): { state: ScanState; retry: () => void } {
  const hint = useLangHint();
  const [attempt, setAttempt] = useState(0);
  const [state, setState] = useState<ScanState>({ phase: 'analyzing', step: 'preparing' });

  useEffect(() => {
    if (!file || hint === null) return;
    const ctl = new AbortController();
    void runScan(file, hint, ctl.signal, (step) => setState({ phase: 'analyzing', step })).then((settled) => settled && setState(settled));
    return () => ctl.abort();
  }, [file, hint, attempt]);

  return {
    state,
    retry: () => {
      setState({ phase: 'analyzing', step: 'preparing' });
      setAttempt((a) => a + 1);
    }
  };
}

export type LivePhase = 'live' | 'analyzing' | 'result' | 'error' | 'coach';
export type LiveSession = {
  phase: LivePhase;
  /** A frame came back no_match/no_card and the viewfinder is still live ("Didn't catch it — trying again"). */
  retrying: boolean;
  /** The settled result/error of the last submitted frame (result/error phases). */
  outcome: Settled | null;
  file: File | null;
  /** What the coach should lead with (from the dominant rejected-quality reason). */
  lead: CoachLead;
  /** Synchronous gate for the auto-capture loop and the shutter (not in flight, ≥ 1.5 s gap, ≤ 3 per 10 s, hint known). */
  canSubmit: () => boolean;
  submit: (file: File) => void;
  /** One rejected viewfinder sample (feeds the coach's lead line). */
  reject: (reason: Rejection) => void;
  /** Scan Another / Keep Scanning / Try another: back to the live phase with fresh attempt counters. */
  reset: () => void;
};

/**
 * One live scan session. Frames that come back no_match/no_card do NOT show the no-match screen: the viewfinder stays live and
 * up to 3 attempts are made (see lib/recognition/retry.ts); the third failure → `coach`. Network/5xx/429 failures are errors,
 * not attempts: they show the normal error screen and are not counted.
 */
export function useLiveSession(): LiveSession {
  const hint = useLangHint();
  const hintRef = useRef(hint);
  useEffect(() => {
    hintRef.current = hint;
  });
  const [phase, setPhase] = useState<LivePhase>('live');
  const [retrying, setRetrying] = useState(false);
  const [outcome, setOutcome] = useState<Settled | null>(null);
  const [file, setFile] = useState<File | null>(null);
  const [lead, setLead] = useState<CoachLead>('dark-surface');
  const starts = useRef<number[]>([]);
  const inFlight = useRef(false);
  const failed = useRef(0);
  const rejections = useRef<RejectionCounts>(emptyRejections());
  const ctl = useRef<AbortController | null>(null);

  useEffect(() => () => ctl.current?.abort(), []);

  const canSubmit = useCallback(() => hintRef.current !== null && attemptAllowed(starts.current, performance.now(), inFlight.current), []);

  const submit = useCallback((photo: File) => {
    const lang = hintRef.current;
    if (lang === null || inFlight.current) return;
    const at = performance.now();
    inFlight.current = true;
    starts.current.push(at);
    const c = new AbortController();
    ctl.current = c;
    setFile(photo);
    setRetrying(false);
    setPhase('analyzing');
    void runScan(photo, lang, c.signal).then((settled) => {
      if (!settled || c.signal.aborted) return;
      inFlight.current = false;
      if (settled.phase === 'failed') {
        starts.current = starts.current.filter((t) => t !== at); // errors are not attempts
        setOutcome(settled);
        setPhase('error');
      } else if (isNoMatch(settled.response.status)) {
        failed.current += 1;
        if (failed.current >= MAX_FAILED_ATTEMPTS) {
          const dominant = dominantRejection(rejections.current);
          setLead(dominant === 'glare' ? 'glare' : dominant === 'dark' ? 'light' : 'dark-surface');
          setPhase('coach');
        } else {
          setRetrying(true);
          setPhase('live');
        }
      } else {
        failed.current = 0;
        setOutcome(settled);
        setPhase('result');
      }
    });
  }, []);

  const reject = useCallback((reason: Rejection) => {
    rejections.current[reason] += 1;
  }, []);

  const reset = useCallback(() => {
    ctl.current?.abort();
    inFlight.current = false;
    starts.current = [];
    failed.current = 0;
    rejections.current = emptyRejections();
    setRetrying(false);
    setOutcome(null);
    setFile(null);
    setPhase('live');
  }, []);

  return { phase, retrying, outcome, file, lead, canSubmit, submit, reject, reset };
}

export type Availability =
  | { state: 'checking' }
  | { state: 'lang_missing' }
  | { state: 'card_missing' }
  | { state: 'ok'; setOfficialCount: number | null };

/** Is the recognized card usable from the INSTALLED local catalog? (language installed → card id present) */
export function useCandidateAvailability(c: { language: Language; cardId: string } | undefined): Availability {
  const status = useCatalogStatus(c?.language ?? 'en');
  const installed = status.data?.installed.status === 'installed';
  const card = useCatalogCard(c && installed ? { language: c.language, cardId: c.cardId } : undefined);
  if (!c) return { state: 'checking' };
  if (status.isPending) return { state: 'checking' };
  if (!installed) return { state: 'lang_missing' };
  if (card.isError) return { state: 'card_missing' };
  if (card.isPending || card.isPlaceholderData || (card.data && card.data.id !== c.cardId)) return { state: 'checking' };
  return { state: 'ok', setOfficialCount: (card.data?.setOfficialCount as number | null | undefined) ?? null };
}
