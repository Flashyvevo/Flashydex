import { useNavigate, useRouter } from '@tanstack/react-router';
import { ChevronLeft } from 'lucide-react';
import { useEffect, useRef, type ReactNode } from 'react';
import { useUpdateSettings } from '../data';
import { useToast } from './overlay';
import { canGoBack } from './page';
import { cx } from './ui';

/** Shared layout of every first-run step (UX §15.2): back, 4 dots, Skip (not on step 1), content, sticky footer. */
export function OnboardingShell({
  step,
  title,
  body,
  children,
  footer,
  hero
}: {
  step: 1 | 2 | 3 | 4;
  title: string;
  body?: string;
  children?: ReactNode;
  footer: ReactNode;
  hero?: ReactNode;
}) {
  const router = useRouter();
  const navigate = useNavigate();
  const update = useUpdateSettings();
  const toast = useToast();
  const h1 = useRef<HTMLHeadingElement>(null);
  useEffect(() => {
    h1.current?.focus({ preventScroll: true });
    document.title = `${title} · FlashyDex`;
  }, [title]);

  const skip = async () => {
    try {
      await update.mutateAsync({ onboardingCompleted: true, disclaimerAcknowledged: true });
      void navigate({ to: '/', replace: true });
    } catch {
      toast.show({ message: 'Couldn’t save that choice. Try again.', tone: 'negative' });
    }
  };

  return (
    <div className="flex min-h-dvh flex-col bg-bg">
      <header className="flex items-center justify-between" style={{ paddingTop: 'var(--ps-safe-top)', paddingLeft: 'max(4px, var(--ps-safe-left))', paddingRight: 'max(4px, var(--ps-safe-right))' }}>
        <div className="flex h-(--ps-topbar-h) items-center">
          {step > 1 ? (
            <button type="button" aria-label="Back" onClick={() => (canGoBack() ? router.history.back() : void navigate({ to: '/welcome', replace: true }))} className="inline-flex size-(--ps-tap) items-center justify-center text-chrome-accent">
              <ChevronLeft size={28} aria-hidden />
            </button>
          ) : (
            <span className="size-(--ps-tap)" />
          )}
        </div>
        <div role="img" aria-label={`Step ${step} of 4`} className="flex items-center gap-2">
          {[1, 2, 3, 4].map((n) => (
            <span key={n} aria-hidden className={cx('size-2 rounded-full', n === step ? 'bg-accent' : 'bg-surface-3')} />
          ))}
        </div>
        {step > 1 ? (
          <button type="button" data-testid="welcome-skip" onClick={() => void skip()} disabled={update.isPending} className="inline-flex min-h-(--ps-tap) min-w-(--ps-tap) items-center justify-center px-3 text-body text-accent-fg">
            Skip
          </button>
        ) : (
          <span className="size-(--ps-tap)" />
        )}
      </header>
      <main className="mx-auto flex w-full max-w-md flex-1 flex-col gap-4 pb-6 pt-4" style={{ paddingLeft: 'var(--ps-page-left)', paddingRight: 'var(--ps-page-right)' }}>
        {hero}
        <h1 ref={h1} tabIndex={-1} className="text-h1 font-bold outline-none">
          {title}
        </h1>
        {body && <p className="max-w-[34ch] text-body text-fg-muted">{body}</p>}
        {children}
      </main>
      <div className="sticky bottom-0 border-t border-border bg-bg" style={{ paddingBottom: 'max(var(--ps-safe-bottom), 12px)' }}>
        <div className="mx-auto flex max-w-md flex-col gap-2 pt-3" style={{ paddingLeft: 'var(--ps-page-left)', paddingRight: 'var(--ps-page-right)' }}>
          {footer}
        </div>
      </div>
    </div>
  );
}

/** FlashyDex mark: two overlapping 63:88 card silhouettes + a diagonal yellow→amber streak (no Poké Ball/bolt). */
export function Mark({ size = 96 }: { size?: number }) {
  return (
    <svg width={size} height={size} viewBox="0 0 96 96" role="img" aria-label="FlashyDex" className="shrink-0">
      <defs>
        <linearGradient id="fdstreak" x1="0" y1="0" x2="1" y2="1">
          <stop offset="0" stopColor="#ffe45c" />
          <stop offset="1" stopColor="#ffa500" />
        </linearGradient>
      </defs>
      <rect x="14" y="14" width="46" height="64" rx="4" fill="#9aa3b8" transform="rotate(-8 37 46)" />
      <rect x="34" y="18" width="46" height="64" rx="4" fill="#f2f4f8" transform="rotate(6 57 50)" />
      <path d="M44 74 L70 22 L77 25 L51 77 Z" fill="url(#fdstreak)" opacity="0.95" />
    </svg>
  );
}
