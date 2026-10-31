import { useNavigate, useRouter } from '@tanstack/react-router';
import { ChevronLeft } from 'lucide-react';
import { useEffect, useRef, type ReactNode } from 'react';
import { useUpdateSettings } from '../data';
import { useToast } from './overlay';
import { canGoBack } from './page';
import { cx } from './ui';
import appIcon from '../assets/brand/app-icon.png';
import logo from '../assets/brand/logo-1200.png';

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


/** FlashyDex app icon (owner-supplied brand mark, transparent background). */
export function Mark({ size = 96 }: { size?: number }) {
  return <img src={appIcon} width={size} height={size} alt="FlashyDex" className="shrink-0 select-none" draggable={false} decoding="async" />;
}

/** FlashyDex wordmark logo (icon + "FlashyDex"), for the welcome hero and About. */
export function Logo({ width = 260 }: { width?: number }) {
  return <img src={logo} width={width} alt="FlashyDex" className="h-auto max-w-full select-none" draggable={false} decoding="async" style={{ width }} />;
}
