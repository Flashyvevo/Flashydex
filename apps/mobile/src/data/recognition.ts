import { useEffect, useState } from 'react';
import { identify, langHint, type RecognitionFailure, type RecognitionResponse } from '../lib/recognition/client';
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

/** Runs prepare → identify for `file`. Cancelled on unmount/file change. `retry()` re-runs the same photo. Never throws. */
export function useScan(file: File | null): { state: ScanState; retry: () => void } {
  const hint = useLangHint();
  const [attempt, setAttempt] = useState(0);
  const [state, setState] = useState<ScanState>({ phase: 'analyzing', step: 'preparing' });

  useEffect(() => {
    if (!file || hint === null) return;
    const ctl = new AbortController();
    const t0 = performance.now();
    void (async () => {
      try {
        const prepared = await prepareImage(file);
        if (ctl.signal.aborted) return;
        setState({ phase: 'analyzing', step: 'uploading' });
        const result = await identify(prepared.blob, { lang: hint, maxCandidates: 3, signal: ctl.signal });
        if (ctl.signal.aborted) return;
        const totalMs = performance.now() - t0;
        if (result.ok) {
          recordScan({ prepareMs: prepared.ms, uploadMs: result.timing.uploadMs, networkMs: result.timing.networkMs, serverMs: result.timing.serverMs, totalMs, originalBytes: prepared.originalBytes, uploadBytes: prepared.bytes, width: prepared.width, height: prepared.height, status: result.response.status });
          setState({ phase: 'done', response: result.response, width: prepared.width, height: prepared.height, bytes: prepared.bytes, originalBytes: prepared.originalBytes });
        } else {
          recordScan({ prepareMs: prepared.ms, uploadMs: null, networkMs: null, serverMs: null, totalMs, originalBytes: prepared.originalBytes, uploadBytes: prepared.bytes, width: prepared.width, height: prepared.height, status: `failed:${result.failure.kind}` });
          setState({ phase: 'failed', failure: result.failure });
        }
      } catch (error) {
        if (ctl.signal.aborted) return;
        if (error instanceof PrepareError) setState({ phase: 'failed', failure: { kind: 'unsupported_image', heic: error.heic, detail: 'unreadable', reason: error.reason } });
        else setState({ phase: 'failed', failure: { kind: 'unknown', status: 0, code: null, retryable: true } });
      }
    })();
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
