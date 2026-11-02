/**
 * User-facing copy for the PWA/storage UI. Plain, short, no third-party trademarks. Shell-f renders these verbatim.
 * Claims are deliberately exact (WEB-STORAGE §2 "Quota, Safari ITP and protection UX"): a button tap is never described as an accepted
 * browser prompt, and persistent storage is never described as a guarantee.
 */
export const PROTECTION_COPY = {
  title: 'Protect your collection',
  intro: 'Your collection lives only on this device, in this browser. FlashyDex has no account and no cloud copy.',
  bullets: [
    'Export a backup regularly and keep it somewhere outside this browser. Nothing stored here is a backup.',
    'Safari can delete a website\'s data after seven days of Safari use without opening that site, when cross-site tracking prevention is on. Adding FlashyDex to your Home Screen and opening it from its icon is the recommended protection.',
    '"Protect" asks the browser to keep this site\'s data. The browser may grant or refuse silently, and may not show anything on screen.',
    'Private browsing windows are temporary. Data there is erased when the window closes.',
    'Clearing site data, uninstalling the app or losing the device also removes it.'
  ],
  protectButton: 'Protect my data',
  exportButton: 'Export backup',
  dismissButton: 'Not now'
} as const;

/** Honest status line per `PersistState`. Never says a prompt was accepted. */
export const PERSIST_STATUS_COPY = {
  granted: 'Protected: the browser reports this site\'s storage as persistent.',
  'best-effort': 'Not protected: the browser may clear this data when the device is low on space.',
  unavailable: 'This browser cannot report or request storage protection. Export backups regularly.',
  'check-failed': 'Could not check storage protection. Try again, and export a backup.'
} as const;

export const PROTECT_RESULT_COPY = {
  granted: 'The browser reports your data as protected.',
  notGranted: 'The browser did not grant protection. It may do so later. Keep your backups current.',
  unavailable: 'This browser cannot request protection.',
  failed: 'The request failed. Nothing changed.'
} as const;

export const INSTALL_COPY = {
  title: 'Install FlashyDex',
  why: 'Installed, FlashyDex opens like an app, works offline and is better protected from Safari clearing its data.',
  ios: {
    heading: 'Add to your Home Screen',
    steps: ['Tap the Share button in Safari.', 'Choose "Add to Home Screen".', 'Open FlashyDex from its new icon.']
  },
  android: {
    heading: 'Install from your browser',
    installButton: 'Install',
    menuSteps: ['Open your browser menu.', 'Choose "Install app" or "Add to Home screen".', 'Open FlashyDex from its icon.']
  },
  desktop: { heading: 'Install from your browser', installButton: 'Install', menuSteps: ['Use the install icon in the address bar, or the browser menu.'] },
  dismissButton: 'Not now',
  snoozeNote: 'We will not ask again for 14 days.'
} as const;

export const UPDATE_COPY = {
  title: 'Update ready',
  body: 'A new version is ready.',
  restartButton: 'Restart when finished',
  laterButton: 'Later',
  applying: 'Finishing up, then restarting\u2026',
  failed: 'The update could not start. Your data is untouched.'
} as const;

export const IMAGE_CACHE_COPY = {
  title: 'Offline card art',
  body: 'Card images you view are kept on this device so they show offline. This is a size limit on stored images, not a reservation of space. Clearing it never removes cards you own.',
  clearButton: 'Clear card art',
  notEnforced: 'Offline card art limit is not active yet. It starts after the app is installed and reloaded.'
} as const;
