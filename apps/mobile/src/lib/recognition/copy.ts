import type { RecognitionFailure } from './client';

/** All user-facing scanner copy lives here (owner-binding strings are marked). */
export const COPY = {
  analyzing: 'Analyzing card…', // binding
  preparing: 'Preparing photo…',
  uploading: 'Analyzing card…',
  possibilities: 'We found a few possibilities', // binding
  tapToContinue: 'Tap a card to continue.',
  notIdentified: "We couldn't confidently identify this card.", // binding
  noCardHint: 'Make sure the whole card is in the frame, on a plain background.',
  confirmAdd: 'Confirm & Add', // binding
  wrongCard: 'Wrong card', // binding
  tryAnotherPhoto: 'Try another photo', // binding
  searchManually: 'Search manually', // binding
  browseBySet: 'Browse by set', // binding
  takePhoto: 'Take Photo',
  choosePhoto: 'Choose Photo',
  searchManuallyTitle: 'Search Manually',
  browseBySetTitle: 'Browse by Set',
  scanAnother: 'Scan Another', // binding
  addedToCollection: 'Added to collection',
  viewCard: 'View Card', // binding
  cancel: 'Cancel',
  tryAgain: 'Try again',
  diagnostics: 'Scanner diagnostics',
  addCustom: 'Add as custom card',
  updateCatalog: 'Update catalog',
  heicHelp: 'This photo format couldn’t be read. Choose a JPEG, or switch Camera → Formats → Most Compatible.',
  unreadable: 'This photo couldn’t be read. Try another photo.',
  otherPossibilities: 'Other possibilities',
  backToPossibilities: 'Back to possibilities'
} as const;

export const added = (name: string): string => `Added ${name}`;
export const installCatalog = (languageName: string): string => `Install ${languageName} catalog`;
export const catalogMissing = (languageName: string): string => `This looks like a ${languageName} card, but the ${languageName} catalog isn’t installed.`;
export const cardMissing = (): string => 'This card isn’t in your catalog yet — check for a newer catalog in Settings.';

export type FailureCopy = { title: string; body: string; canRetry: boolean; showDiagnostics: boolean };

/** failure → message. Every failure ALSO always shows Search manually + Browse by set (rendered by the flow, not listed here). */
export function failureCopy(f: RecognitionFailure): FailureCopy {
  switch (f.kind) {
    case 'offline':
      return { title: 'Scanner offline', body: 'The card scanner is offline right now. You can still search or browse.', canRetry: true, showDiagnostics: true };
    case 'timeout':
      return { title: 'That took too long', body: 'The scanner didn’t answer in time. Try again, or search instead.', canRetry: true, showDiagnostics: true };
    case 'cancelled':
      return { title: 'Cancelled', body: 'Scan cancelled.', canRetry: true, showDiagnostics: false };
    case 'rate_limited':
      return {
        title: 'Slow down a moment',
        body: f.retryAfterS !== null ? `Too many scans in a row. Try again in ${f.retryAfterS} second${f.retryAfterS === 1 ? '' : 's'}.` : 'Too many scans in a row. Try again in a few seconds.',
        canRetry: true,
        showDiagnostics: false
      };
    case 'busy':
      return { title: 'Scanner is busy', body: 'The scanner is busy — try again in a moment.', canRetry: true, showDiagnostics: false };
    case 'index_unavailable':
      return { title: 'Scanner is warming up', body: 'The scanner’s card index isn’t ready yet. Try again in a minute, or search instead.', canRetry: true, showDiagnostics: true };
    case 'model_unavailable':
      return { title: 'Scanner unavailable', body: 'The scanner’s recognition model isn’t available right now. You can still search or browse.', canRetry: false, showDiagnostics: true };
    case 'too_large':
      return { title: 'Photo too large', body: 'That photo is too large to send. Try another photo.', canRetry: false, showDiagnostics: false };
    case 'unsupported_image':
      return { title: 'Photo couldn’t be read', body: f.heic ? COPY.heicHelp : f.detail === 'unreadable' ? COPY.unreadable : 'The scanner couldn’t read that photo. Try taking it again.', canRetry: false, showDiagnostics: false };
    case 'bad_response':
      return { title: 'Scanner gave an unexpected answer', body: 'Something went wrong on the scanner’s side. Try again, or search instead.', canRetry: true, showDiagnostics: true };
    case 'unknown':
      return { title: 'Scanner error', body: 'The scanner couldn’t process that photo. Try again, or search instead.', canRetry: f.retryable, showDiagnostics: true };
  }
}
