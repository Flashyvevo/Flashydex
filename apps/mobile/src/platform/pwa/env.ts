/** Injectable browser surface so controllers are testable with a mocked navigator (no jsdom globals needed). */
export interface PwaEnv {
  navigator?: {
    userAgent?: string;
    platform?: string;
    maxTouchPoints?: number;
    standalone?: boolean;
    storage?: Partial<Pick<StorageManager, 'persisted' | 'persist' | 'estimate'>>;
    serviceWorker?: {
      controller?: { postMessage(message: unknown, transfer?: Transferable[]): void } | null;
      addEventListener(type: 'controllerchange', l: () => void): void;
      removeEventListener(type: 'controllerchange', l: () => void): void;
      getRegistration(): Promise<{ waiting?: { postMessage(message: unknown): void } | null } | undefined>;
    };
  };
  localStorage?: Pick<Storage, 'getItem' | 'setItem' | 'removeItem'>;
  document?: Pick<Document, 'addEventListener' | 'visibilityState'>;
  window?: {
    addEventListener(type: string, l: (e: Event) => void): void;
    matchMedia?(query: string): { matches: boolean; addEventListener?(type: 'change', l: () => void): void };
  };
  now(): Date;
  reload(): void;
  /** Production build only (import.meta.env.PROD). */
  isProd: boolean;
}

export function createBrowserEnv(): PwaEnv {
  return {
    navigator: typeof navigator === 'undefined' ? undefined : (navigator as PwaEnv['navigator']),
    localStorage: (() => {
      try {
        return typeof localStorage === 'undefined' ? undefined : localStorage;
      } catch {
        return undefined; // storage access denied
      }
    })(),
    document: typeof document === 'undefined' ? undefined : document,
    window: typeof window === 'undefined' ? undefined : (window as unknown as PwaEnv['window']),
    now: () => new Date(),
    reload: () => location.reload(),
    isProd: import.meta.env.PROD
  };
}

export function isStandalone(env: PwaEnv): boolean {
  try {
    if (env.window?.matchMedia?.('(display-mode: standalone)').matches) return true;
  } catch {
    // ignore
  }
  return env.navigator?.standalone === true;
}
