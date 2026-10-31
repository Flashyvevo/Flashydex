// Catalog install stage mapping (D12) and estimate helpers (UX §10.2, §15.5). UI-only.
import { LANGUAGE_NAMES, formatBytes, formatInt, type Language } from './format';

export type CatalogPhase =
  | 'idle' | 'checking' | 'downloading' | 'downloaded' | 'size_checked' | 'decompressing' | 'verifying' | 'validating'
  | 'prepared' | 'activating' | 'validating_active' | 'committed' | 'installed' | 'cancelled' | 'failed' | 'interrupted' | 'rolling_back';

export type InstallStage = 'downloading' | 'checking' | 'installing' | 'activating' | 'ready' | 'failed' | 'cancelled' | 'idle';

export function stageOf(phase: CatalogPhase): InstallStage {
  switch (phase) {
    case 'checking':
    case 'downloading':
    case 'downloaded':
      return 'downloading';
    case 'size_checked':
    case 'decompressing':
    case 'verifying':
      return 'checking';
    case 'validating':
    case 'prepared':
      return 'installing';
    case 'activating':
    case 'validating_active':
    case 'committed':
    case 'rolling_back':
      return 'activating';
    case 'installed':
      return 'ready';
    case 'failed':
    case 'interrupted':
      return 'failed';
    case 'cancelled':
      return 'cancelled';
    default:
      return 'idle';
  }
}

export const STAGE_LABEL: Record<InstallStage, string> = {
  downloading: 'Downloading',
  checking: 'Checking',
  installing: 'Installing',
  activating: 'Activating',
  ready: 'Ready',
  failed: 'Failed',
  cancelled: 'Stopped',
  idle: ''
};

export type FailureReason = 'network' | 'hash' | 'size' | 'schema' | 'space' | 'other';
export function failureReason(code: string | null | undefined): FailureReason {
  switch (code) {
    case 'HTTP_FAILED':
    case 'PLATFORM_UNAVAILABLE':
      return 'network';
    case 'PACK_HASH_MISMATCH':
      return 'hash';
    case 'PACK_SIZE_MISMATCH':
      return 'size';
    case 'PACK_INVALID':
    case 'APP_UPDATE_REQUIRED':
      return 'schema';
    case 'STORAGE_FULL':
      return 'space';
    default:
      return 'other';
  }
}

export function failureCopy(reason: FailureReason): { text: string; retry: boolean } {
  switch (reason) {
    case 'network':
      return { text: 'Download interrupted.', retry: true };
    case 'hash':
    case 'size':
      return { text: 'The download was damaged and wasn’t installed. Your current catalog is unchanged.', retry: true };
    case 'schema':
      return { text: 'This catalog needs a newer version of FlashyDex. Update the app from the App Store.', retry: false };
    case 'space':
      return { text: 'Not enough space. Free up space in Settings → General → iPhone Storage, then retry.', retry: true };
    default:
      return { text: 'The catalog couldn’t be installed. Your current catalog is unchanged.', retry: true };
  }
}

type Progress = {
  phase: CatalogPhase;
  compressedBytesDone: number;
  compressedBytesTotal: number | null;
  uncompressedBytesDone: number;
  uncompressedBytesTotal: number | null;
};

/** Primary line, bar value and a11y text for a running install. */
export function describeProgress(language: Language, p: Progress): { stage: InstallStage; line: string; value: number | null; max: number | null; valueText: string; percent: number | null } {
  const stage = stageOf(p.phase);
  const name = LANGUAGE_NAMES[language];
  if (stage === 'downloading') {
    const done = p.compressedBytesDone;
    const total = p.compressedBytesTotal;
    const percent = total ? Math.round((done / total) * 100) : null;
    return {
      stage,
      line: total ? `${formatBytes(done)} of ${formatBytes(total)}` : formatBytes(done),
      value: total ? done : null,
      max: total,
      percent,
      valueText: `${name} catalog, downloading${total ? `, ${formatBytes(done)} of ${formatBytes(total)}` : ''}`
    };
  }
  if (stage === 'installing' && p.uncompressedBytesTotal) {
    return { stage, line: '', value: p.uncompressedBytesDone, max: p.uncompressedBytesTotal, percent: null, valueText: `${name} catalog, installing` };
  }
  return { stage, line: '', value: null, max: null, percent: null, valueText: `${name} catalog, ${STAGE_LABEL[stage].toLowerCase()}` };
}

/** "about 1 min on Wi-Fi": bytes ÷ 1–5 MB/s rounded range (UX §15.5). */
export function downloadTimeRange(bytes: number): string {
  const MB = 1024 * 1024;
  const fast = Math.max(1, Math.round(bytes / (5 * MB)));
  const slow = Math.max(1, Math.round(bytes / (1 * MB)));
  const unit = (s: number) => (s >= 90 ? `${Math.round(s / 60)} min` : `${s} s`);
  return fast === slow ? `about ${unit(fast)}` : `about ${unit(fast)}–${unit(slow)}`;
}

export const approxCards = (n: number | null | undefined): string => (n ? `about ${formatInt(Math.round(n / 100) * 100)} cards` : '—');
