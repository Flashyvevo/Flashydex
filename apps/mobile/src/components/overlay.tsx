import { useBlocker } from '@tanstack/react-router';
import { X } from 'lucide-react';
import {
  createContext,
  useCallback,
  useContext,
  useEffect,
  useId,
  useMemo,
  useRef,
  useState,
  type ReactNode
} from 'react';
import { createPortal } from 'react-dom';
import { useIsWide } from '../lib/hooks';
import { useReportDirty } from '../lib/handoff';
import { Button, cx } from './ui';

/* ───────── Inert background + focus management ───────── */

let openOverlays = 0;
function setBackgroundInert(on: boolean) {
  const root = document.getElementById('root');
  if (!root) return;
  openOverlays += on ? 1 : -1;
  if (openOverlays > 0) root.setAttribute('inert', '');
  else root.removeAttribute('inert');
}

function useOverlayLifecycle(open: boolean, titleRef: React.RefObject<HTMLElement | null>) {
  useEffect(() => {
    if (!open) return;
    const invoker = document.activeElement as HTMLElement | null;
    setBackgroundInert(true);
    const t = setTimeout(() => titleRef.current?.focus(), 30);
    return () => {
      clearTimeout(t);
      setBackgroundInert(false);
      invoker?.focus?.();
    };
  }, [open, titleRef]);
}

/* ───────── Dialog (alert-style) ───────── */

export function Dialog({
  open,
  title,
  children,
  actions,
  onDismiss,
  testId
}: {
  open: boolean;
  title: string;
  children?: ReactNode;
  actions: ReactNode;
  onDismiss?: () => void;
  testId?: string;
}) {
  const titleRef = useRef<HTMLHeadingElement>(null);
  const titleId = useId();
  useOverlayLifecycle(open, titleRef);
  useEffect(() => {
    if (!open || !onDismiss) return;
    const onKey = (e: KeyboardEvent) => e.key === 'Escape' && onDismiss();
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [open, onDismiss]);
  if (!open) return null;
  return createPortal(
    <div className="fixed inset-0 flex items-center justify-center p-6" style={{ zIndex: 'var(--ps-z-toast)' }}>
      <div aria-hidden className="absolute inset-0 bg-overlay" style={{ animation: 'fd-fade-in var(--ps-dur-fade) both' }} onClick={onDismiss} />
      <div
        role="alertdialog"
        aria-modal="true"
        aria-labelledby={titleId}
        data-testid={testId}
        className="selectable relative flex max-h-full w-full max-w-80 flex-col gap-3 overflow-y-auto rounded-xl bg-surface-2 p-5 shadow-3"
        style={{ animation: 'fd-pop var(--ps-dur-move) var(--ps-ease-spring) both' }}
      >
        <h2 id={titleId} ref={titleRef} tabIndex={-1} className="text-h3 font-semibold outline-none">
          {title}
        </h2>
        {children && <div className="text-body text-fg-muted">{children}</div>}
        <div className="mt-1 flex flex-col gap-2">{actions}</div>
      </div>
    </div>,
    document.body
  );
}

export function ConfirmDialog({
  open,
  title,
  body,
  confirmLabel,
  cancelLabel = 'Cancel',
  destructive,
  busy,
  onConfirm,
  onCancel,
  confirmDisabled,
  testId
}: {
  open: boolean;
  title: string;
  body?: ReactNode;
  confirmLabel: string;
  cancelLabel?: string;
  destructive?: boolean;
  busy?: boolean;
  confirmDisabled?: boolean;
  onConfirm: () => void;
  onCancel: () => void;
  testId?: string;
}) {
  return (
    <Dialog
      open={open}
      title={title}
      testId={testId}
      onDismiss={busy ? undefined : onCancel}
      actions={
        <>
          <Button variant={destructive ? 'danger' : 'primary'} loading={busy} disabled={confirmDisabled} onClick={onConfirm} data-testid="dialog-confirm">
            {confirmLabel}
          </Button>
          <Button variant="secondary" onClick={onCancel} disabled={busy} data-testid="dialog-cancel">
            {cancelLabel}
          </Button>
        </>
      }
    >
      {body}
    </Dialog>
  );
}

/* ───────── Bottom sheet / side panel ───────── */

export type SheetProps = {
  open: boolean;
  title: string;
  /** Called when the user asks to close (Cancel, ✕, scrim, drag, Escape). Parent usually does history.back(). */
  onClose: () => void;
  leading?: string;
  trailing?: ReactNode;
  footer?: ReactNode;
  children: ReactNode;
  /** Unsaved changes: dismiss gestures ask "Discard changes?" first (also on browser/Android back). */
  dirty?: boolean;
  discardTitle?: string;
  /** Wide screens: `panel` = 480px right-side panel, default = centred dialog. */
  wide?: 'dialog' | 'panel';
  large?: boolean;
  testId?: string;
  titleHidden?: boolean;
};

export function BottomSheet(props: SheetProps) {
  const { open } = props;
  if (!open) return null;
  return <SheetInner {...props} />;
}

function SheetInner({ title, onClose, leading = 'Cancel', trailing, footer, children, dirty, discardTitle = 'Discard changes?', wide = 'dialog', large, testId, titleHidden }: SheetProps) {
  const isWide = useIsWide();
  const titleRef = useRef<HTMLHeadingElement>(null);
  const titleId = useId();
  const panelRef = useRef<HTMLDivElement>(null);
  const [askDiscard, setAskDiscard] = useState(false);
  const [dragY, setDragY] = useState(0);
  const drag = useRef<{ startY: number; t: number; active: boolean; crossed: boolean } | null>(null);
  const [dragging, setDragging] = useState(false);
  useOverlayLifecycle(true, titleRef);
  useReportDirty(!!dirty); // update handoff asks before discarding an open dirty form (W13)
  useEffect(() => {
    askDiscardOverride.current = false;
    return () => {
      askDiscardOverride.current = false;
    };
  }, []);
  // Back / edge-swipe while dirty → confirm instead of silently losing edits.
  const blocker = useBlocker({ shouldBlockFn: () => !!dirty && !askDiscardOverride.current, withResolver: true, enableBeforeUnload: false });
  const blocked = blocker.status === 'blocked';
  const [prevBlocked, setPrevBlocked] = useState(false);
  if (blocked !== prevBlocked) {
    setPrevBlocked(blocked);
    if (blocked) setAskDiscard(true);
  }

  const requestClose = useCallback(() => {
    if (dirty) setAskDiscard(true);
    else onClose();
  }, [dirty, onClose]);

  useEffect(() => {
    const onKey = (e: KeyboardEvent) => e.key === 'Escape' && !askDiscard && requestClose();
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [requestClose, askDiscard]);

  const onPointerDown = (e: React.PointerEvent) => {
    if (isWide) return;
    drag.current = { startY: e.clientY, t: performance.now(), active: true, crossed: false };
    setDragging(true);
    (e.currentTarget as HTMLElement).setPointerCapture(e.pointerId);
  };
  const onPointerMove = (e: React.PointerEvent) => {
    const d = drag.current;
    if (!d?.active) return;
    const dy = Math.max(0, e.clientY - d.startY);
    setDragY(dy);
    d.crossed = dy > 120;
  };
  const onPointerUp = (e: React.PointerEvent) => {
    const d = drag.current;
    drag.current = null;
    setDragging(false);
    if (!d) return;
    const dy = Math.max(0, e.clientY - d.startY);
    const velocity = dy / Math.max(1, performance.now() - d.t);
    setDragY(0);
    if (dy > 120 || (dy > 24 && velocity > 0.5)) requestClose();
  };

  const confirmDiscard = () => {
    askDiscardOverride.current = true;
    setAskDiscard(false);
    if (blocker.status === 'blocked') blocker.proceed();
    else onClose();
  };
  const keepEditing = () => {
    setAskDiscard(false);
    if (blocker.status === 'blocked') blocker.reset();
  };

  const asPanel = isWide && wide === 'panel';
  return createPortal(
    <div className="fixed inset-0" style={{ zIndex: 'var(--ps-z-sheet)' }}>
      <div aria-hidden className="absolute inset-0 bg-overlay" style={{ animation: 'fd-fade-in var(--ps-dur-fade) both' }} onClick={requestClose} />
      <div
        ref={panelRef}
        role="dialog"
        aria-modal="true"
        aria-labelledby={titleId}
        data-testid={testId}
        className={cx(
          'absolute flex flex-col bg-surface-2 shadow-3',
          isWide
            ? asPanel
              ? 'inset-y-0 right-0 w-[480px] max-w-full'
              : 'left-1/2 top-1/2 max-h-[85dvh] w-[560px] max-w-[calc(100%-32px)] -translate-x-1/2 -translate-y-1/2 rounded-xl'
            : 'inset-x-0 bottom-0 rounded-t-sheet',
          !isWide && (large ? 'h-(--ps-sheet-max-h)' : 'max-h-(--ps-sheet-max-h)')
        )}
        style={
          isWide
            ? { animation: 'fd-fade-in var(--ps-dur-fade) both' }
            : {
                transform: dragY ? `translateY(${dragY}px)` : undefined,
                transition: dragging ? 'none' : 'transform var(--ps-dur-move) var(--ps-ease-sheet)',
                animation: dragY ? undefined : 'fd-sheet-in var(--ps-dur-move-slow) var(--ps-ease-sheet) both'
              }
        }
      >
        <div className="touch-none" onPointerDown={onPointerDown} onPointerMove={onPointerMove} onPointerUp={onPointerUp} onPointerCancel={onPointerUp}>
          {!isWide && <div aria-hidden className="mx-auto mt-1.5 h-(--ps-sheet-handle-h) w-(--ps-sheet-handle-w) rounded-full bg-sheet-handle" />}
          <div className="grid min-h-(--ps-tap) grid-cols-[1fr_auto_1fr] items-center px-2">
            <div className="justify-self-start">
              <button type="button" onClick={requestClose} data-testid="sheet-cancel" className="inline-flex min-h-(--ps-tap) items-center px-3 text-body text-accent-fg">
                {leading}
              </button>
            </div>
            <h2 id={titleId} ref={titleRef} tabIndex={-1} className={cx('max-w-[55vw] truncate text-body font-semibold outline-none', titleHidden && 'sr-only')}>
              {title}
            </h2>
            <div className="justify-self-end">{trailing}</div>
          </div>
        </div>
        <div className="min-h-0 flex-1 overflow-y-auto overscroll-contain px-4 pb-4">{children}</div>
        {footer && (
          <div className="border-t border-border px-4 pt-3" style={{ paddingBottom: 'max(var(--ps-sheet-pad-bottom), 12px)' }}>
            {footer}
          </div>
        )}
      </div>
      <Dialog
        open={askDiscard}
        title={discardTitle}
        onDismiss={keepEditing}
        testId="discard-dialog"
        actions={
          <>
            <Button variant="primary" onClick={keepEditing} data-testid="discard-keep">
              Keep editing
            </Button>
            <Button variant="danger-outline" onClick={confirmDiscard} data-testid="discard-confirm">
              Discard
            </Button>
          </>
        }
      />
    </div>,
    document.body
  );
}
// Module-level flag so a confirmed discard is allowed through the blocker.
const askDiscardOverride = { current: false };
/** Call right before closing a dirty sheet programmatically (after a successful save/add). */
export function bypassSheetGuard(): void {
  askDiscardOverride.current = true;
}

export function SheetCloseButton({ onClick, label = 'Close' }: { onClick: () => void; label?: string }) {
  return (
    <button type="button" aria-label={label} onClick={onClick} className="inline-flex size-(--ps-tap) items-center justify-center rounded-full text-fg">
      <X size={22} aria-hidden />
    </button>
  );
}

/* ───────── Toasts ───────── */

type ToastInput = { message: string; action?: { label: string; onClick: () => void }; tone?: 'default' | 'negative' };
type ToastState = ToastInput & { id: number };
type ToastApi = { show: (t: ToastInput) => void; dismiss: () => void };
const ToastContext = createContext<ToastApi | null>(null);

export function useToast(): ToastApi {
  const ctx = useContext(ToastContext);
  if (!ctx) throw new Error('useToast outside ToastProvider');
  return ctx;
}

export function ToastProvider({ children }: { children: ReactNode }) {
  const [toast, setToast] = useState<ToastState | null>(null);
  const seq = useRef(0);
  const timer = useRef<ReturnType<typeof setTimeout> | undefined>(undefined);
  const touch = useRef<number | null>(null);

  const dismiss = useCallback(() => {
    clearTimeout(timer.current);
    setToast(null);
  }, []);
  const show = useCallback((t: ToastInput) => {
    clearTimeout(timer.current);
    const id = ++seq.current;
    setToast({ ...t, id });
    timer.current = setTimeout(() => setToast((cur) => (cur?.id === id ? null : cur)), t.action ? 8000 : 4000);
  }, []);
  const api = useMemo(() => ({ show, dismiss }), [show, dismiss]);

  return (
    <ToastContext.Provider value={api}>
      {children}
      {createPortal(
        <div
          className="pointer-events-none fixed inset-x-0 flex justify-center px-4 lg:justify-end"
          style={{ bottom: 'var(--ps-toast-bottom)', zIndex: 'var(--ps-z-toast)' }}
        >
          {toast && (
            <div
              key={toast.id}
              role="status"
              data-testid="toast"
              onTouchStart={(e) => (touch.current = e.touches[0]?.clientY ?? null)}
              onTouchEnd={(e) => {
                if (touch.current !== null && (e.changedTouches[0]?.clientY ?? 0) - touch.current > 30) dismiss();
                touch.current = null;
              }}
              className={cx(
                'pointer-events-auto flex min-h-(--ps-tap) max-w-md items-center gap-3 rounded-lg px-4 py-1 text-small shadow-3',
                toast.tone === 'negative' ? 'bg-negative text-bg' : 'bg-fg text-bg'
              )}
              style={{ animation: 'fd-sheet-in var(--ps-dur-move) var(--ps-ease-decelerate) both' }}
            >
              <span className="min-w-0 flex-1">{toast.message}</span>
              {toast.action && (
                <button
                  type="button"
                  data-testid="toast-action"
                  onClick={() => {
                    toast.action?.onClick();
                    dismiss();
                  }}
                  className="inline-flex min-h-(--ps-tap) items-center font-semibold underline"
                >
                  {toast.action.label}
                </button>
              )}
            </div>
          )}
        </div>,
        document.body
      )}
    </ToastContext.Provider>
  );
}
