import { Link, useNavigate, useRouter } from '@tanstack/react-router';
import { ChevronLeft, Plus, X, ArrowLeft } from 'lucide-react';
import { useEffect, useRef, useState, type ReactNode } from 'react';
import { IconButton, cx } from './ui';

export type BackTarget = { label: string; to: string; search?: Record<string, unknown> };

/** True when the in-app history has a previous in-app entry. */
export function canGoBack(): boolean {
  const idx = (window.history.state as { __TSR_index?: number } | null)?.__TSR_index;
  return typeof idx === 'number' && idx > 0;
}

/** Close a modal / pop a pushed screen: history.back() when possible, otherwise go to `fallback`. */
export function useCloseOrBack(fallback: string = '/') {
  const router = useRouter();
  const navigate = useNavigate();
  return () => {
    if (canGoBack()) router.history.back();
    else void navigate({ to: fallback as never, replace: true });
  };
}

type PageProps = {
  title: string;
  /** Tab roots show a large title in the content and reveal the bar title on scroll. */
  large?: boolean;
  back?: BackTarget;
  actions?: ReactNode;
  /** Show the "Add a card" plus button. */
  add?: boolean;
  children: ReactNode;
  className?: string;
  /** Remove the max-width/gutters (for full-bleed layouts). */
  bleed?: boolean;
  /** Sticky block rendered under the top bar (search/filter rows). */
  sticky?: ReactNode;
  titleSuffix?: ReactNode;
  subtitle?: ReactNode;
};

export function Page({ title, large, back, actions, add, children, className, bleed, sticky, titleSuffix, subtitle }: PageProps) {
  const router = useRouter();
  const navigate = useNavigate();
  const h1Ref = useRef<HTMLHeadingElement>(null);
  const [h1Visible, setH1Visible] = useState(true);
  const [scrolled, setScrolled] = useState(false);

  useEffect(() => {
    document.title = `${title} · FlashyDex`;
  }, [title]);

  useEffect(() => {
    const el = h1Ref.current;
    if (!large || !el) return;
    const io = new IntersectionObserver(([e]) => e && setH1Visible(e.isIntersecting), { rootMargin: '-60px 0px 0px 0px' });
    io.observe(el);
    return () => io.disconnect();
  }, [large]);

  useEffect(() => {
    const on = () => setScrolled(window.scrollY > 4);
    on();
    window.addEventListener('scroll', on, { passive: true });
    return () => window.removeEventListener('scroll', on);
  }, []);

  // Route changes move focus to the new page's H1 (a11y §13).
  useEffect(() => {
    h1Ref.current?.focus({ preventScroll: true });
  }, [title]);

  const barTitleVisible = !large || !h1Visible;
  const goBack = () => {
    if (!back) return;
    if (canGoBack()) router.history.back();
    else void navigate({ to: back.to as never, search: back.search as never, replace: true });
  };

  return (
    <div className={cx('lg:pl-(--ps-sidebar-w)')}>
      <header
        className={cx('fixed inset-x-0 top-0 border-b bg-chrome lg:left-(--ps-sidebar-w)', scrolled ? 'border-chrome-border' : 'border-transparent')}
        style={{
          zIndex: 'var(--ps-z-nav)',
          paddingTop: 'var(--ps-safe-top)',
          backdropFilter: 'var(--ps-chrome-backdrop)',
          WebkitBackdropFilter: 'var(--ps-chrome-backdrop)'
        }}
      >
        <div className="relative flex h-(--ps-topbar-h) items-center justify-between" style={{ paddingLeft: 'max(4px, var(--ps-safe-left))', paddingRight: 'max(4px, var(--ps-safe-right))' }}>
          <div className="flex min-w-0 items-center">
            {back ? (
              <button type="button" onClick={goBack} aria-label={`Back to ${back.label}`} className="inline-flex min-h-(--ps-tap) items-center gap-0.5 pr-3 text-body text-chrome-accent">
                <ChevronLeft size={26} aria-hidden />
                <span className="max-w-[28vw] truncate">{back.label}</span>
              </button>
            ) : null}
          </div>
          <div aria-hidden className={cx('pointer-events-none absolute inset-x-16 truncate text-center text-bar-title font-semibold transition-opacity duration-(--ps-dur-fade-fast)', barTitleVisible ? 'opacity-100' : 'opacity-0')}>
            {title}
          </div>
          <div className="flex shrink-0 items-center">
            {actions}
            {add && (
              <Link to="/add" aria-label="Add a card" data-testid="add-button" className="inline-flex size-(--ps-tap) items-center justify-center rounded-full text-chrome-accent active:bg-surface-3">
                <Plus size={26} aria-hidden />
              </Link>
            )}
          </div>
        </div>
      </header>
      <main
        className={cx('min-h-dvh', className)}
        style={{ paddingTop: 'var(--ps-topbar-total)', paddingBottom: 'var(--ps-content-pad-bottom)' }}
      >
        <div className={cx(!bleed && 'page-pad mx-auto w-full max-w-(--ps-page-max)')}>
          <div className="pb-2 pt-3">
            <div className="flex items-end justify-between gap-3">
              <h1
                ref={h1Ref}
                tabIndex={-1}
                className={cx('min-w-0 break-words text-h1 font-bold outline-none', !large && 'sr-only')}
              >
                {title}
              </h1>
              {large && titleSuffix}
            </div>
            {subtitle}
          </div>
          {sticky && (
            <div className="sticky z-(--ps-z-sticky) -mx-4 bg-bg px-4 pb-2 lg:mx-0 lg:px-0" style={{ top: 'var(--ps-topbar-total)' }}>
              {sticky}
            </div>
          )}
          {children}
        </div>
      </main>
    </div>
  );
}

/** Modal screen chrome: ✕ top-left, title, no tab bar. */
export function ModalPage({
  title,
  onClose,
  trailing,
  children,
  footer,
  noFooterPad
}: {
  title: string;
  onClose: () => void;
  trailing?: ReactNode;
  children: ReactNode;
  footer?: ReactNode;
  noFooterPad?: boolean;
}) {
  useEffect(() => {
    document.title = `${title} · FlashyDex`;
  }, [title]);
  const h1 = useRef<HTMLHeadingElement>(null);
  useEffect(() => {
    h1.current?.focus({ preventScroll: true });
  }, []);
  return (
    <div className="min-h-dvh bg-bg">
      <header
        className="fixed inset-x-0 top-0 border-b border-chrome-border bg-chrome"
        style={{ zIndex: 'var(--ps-z-nav)', paddingTop: 'var(--ps-safe-top)', backdropFilter: 'var(--ps-chrome-backdrop)', WebkitBackdropFilter: 'var(--ps-chrome-backdrop)' }}
      >
        <div className="relative flex h-(--ps-topbar-h) items-center justify-between" style={{ paddingLeft: 'max(4px, var(--ps-safe-left))', paddingRight: 'max(4px, var(--ps-safe-right))' }}>
          <IconButton label="Close" icon={X} onClick={onClose} data-testid="modal-close" />
          <h1 ref={h1} tabIndex={-1} className="pointer-events-none absolute inset-x-16 truncate text-center text-bar-title font-semibold outline-none">
            {title}
          </h1>
          <div className="flex items-center">{trailing}</div>
        </div>
      </header>
      <main
        className="mx-auto w-full max-w-2xl"
        style={{
          paddingTop: 'calc(var(--ps-topbar-total) + 12px)',
          paddingBottom: noFooterPad ? 'var(--ps-safe-bottom)' : footer ? 'calc(96px + var(--ps-safe-bottom))' : 'calc(24px + var(--ps-safe-bottom))',
          paddingLeft: 'var(--ps-page-left)',
          paddingRight: 'var(--ps-page-right)'
        }}
      >
        {children}
      </main>
      {footer && (
        <div className="fixed inset-x-0 bottom-0 border-t border-border bg-bg" style={{ zIndex: 'var(--ps-z-nav)', paddingBottom: 'max(var(--ps-sheet-pad-bottom), 12px)' }}>
          <div className="mx-auto flex max-w-2xl flex-col gap-2 pt-3" style={{ paddingLeft: 'var(--ps-page-left)', paddingRight: 'var(--ps-page-right)' }}>
            {footer}
          </div>
        </div>
      )}
    </div>
  );
}

export { ArrowLeft };
