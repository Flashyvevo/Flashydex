import { ChevronRight, CloudOff, Loader2, Search, X, Check, Minus as MinusIcon, Plus as PlusIcon, type LucideIcon } from 'lucide-react';
import {
  forwardRef,
  useId,
  type ButtonHTMLAttributes,
  type InputHTMLAttributes,
  type ReactNode,
  type SelectHTMLAttributes,
  type TextareaHTMLAttributes
} from 'react';
import { Link, type LinkProps } from '@tanstack/react-router';
import { describeError } from '../lib/errors';
import { haptic } from '../lib/native';

export const cx = (...parts: (string | false | null | undefined)[]): string => parts.filter(Boolean).join(' ');

/* ───────── Buttons ───────── */

type ButtonVariant = 'primary' | 'secondary' | 'ghost' | 'danger' | 'danger-outline' | 'text';
const BUTTON_STYLES: Record<ButtonVariant, string> = {
  primary: 'bg-accent text-on-accent font-semibold active:bg-accent-pressed',
  secondary: 'bg-surface-3 text-fg font-semibold active:bg-border',
  ghost: 'text-accent-fg font-semibold active:bg-accent-soft',
  text: 'text-accent-fg font-semibold active:opacity-70',
  danger: 'bg-danger text-on-danger font-semibold',
  'danger-outline': 'border border-negative text-negative font-semibold active:bg-negative-soft'
};

export type ButtonProps = ButtonHTMLAttributes<HTMLButtonElement> & {
  variant?: ButtonVariant;
  loading?: boolean;
  full?: boolean;
  icon?: LucideIcon;
  /** Keeps the button focusable but inert (aria-disabled), reason shown by `describedBy`. */
  softDisabled?: boolean;
};

export const Button = forwardRef<HTMLButtonElement, ButtonProps>(function Button(
  { variant = 'secondary', loading, full, icon: Icon, softDisabled, className, children, disabled, onClick, ...rest },
  ref
) {
  const isDisabled = disabled || loading;
  return (
    <button
      ref={ref}
      type="button"
      {...rest}
      disabled={isDisabled && !softDisabled}
      aria-disabled={isDisabled || softDisabled || undefined}
      onClick={(e) => {
        if (isDisabled || softDisabled) {
          e.preventDefault();
          return;
        }
        onClick?.(e);
      }}
      className={cx(
        'inline-flex min-h-(--ps-tap-lg) items-center justify-center gap-2 rounded-lg px-5 py-2 text-body transition-[transform,opacity,background-color] duration-(--ps-dur-move-fast) ease-standard active:scale-(--ps-press-scale)',
        variant === 'text' && 'min-h-(--ps-tap) px-3',
        BUTTON_STYLES[variant],
        (isDisabled || softDisabled) && 'opacity-45',
        full && 'w-full',
        className
      )}
    >
      {loading ? <Loader2 size={18} className="fd-spin" aria-hidden /> : Icon ? <Icon size={18} aria-hidden /> : null}
      {children}
    </button>
  );
});

export function IconButton({
  label,
  icon: Icon,
  className,
  size = 22,
  ...rest
}: { label: string; icon: LucideIcon; size?: number } & ButtonHTMLAttributes<HTMLButtonElement>) {
  return (
    <button
      type="button"
      aria-label={label}
      {...rest}
      className={cx('inline-flex size-(--ps-tap) shrink-0 items-center justify-center rounded-full text-fg active:bg-surface-3 disabled:opacity-40', className)}
    >
      <Icon size={size} aria-hidden />
    </button>
  );
}

type LinkButtonProps = LinkProps & { variant?: ButtonVariant; full?: boolean; className?: string; children: ReactNode; icon?: LucideIcon };
export function LinkButton({ variant = 'secondary', full, className, children, icon: Icon, ...rest }: LinkButtonProps) {
  return (
    <Link
      {...(rest as LinkProps)}
      className={cx(
        'inline-flex min-h-(--ps-tap-lg) items-center justify-center gap-2 rounded-lg px-5 py-2 text-body active:scale-(--ps-press-scale)',
        variant === 'text' && 'min-h-(--ps-tap) px-3',
        BUTTON_STYLES[variant],
        full && 'w-full',
        className
      )}
    >
      {Icon ? <Icon size={18} aria-hidden /> : null}
      {children}
    </Link>
  );
}

/* ───────── Form controls ───────── */

export type Option<T extends string> = { value: T; label: string; aria?: string; disabled?: boolean };

export function ChipGroup<T extends string>({
  label,
  value,
  options,
  onChange,
  testIdPrefix,
  hideLabel,
  className
}: {
  label: string;
  value: T | null;
  options: Option<T>[];
  onChange: (v: T) => void;
  testIdPrefix?: string;
  hideLabel?: boolean;
  className?: string;
}) {
  const id = useId();
  return (
    <div role="radiogroup" aria-labelledby={id} className={className}>
      <div id={id} className={hideLabel ? 'sr-only' : 'mb-1 text-caption font-semibold text-fg-muted'}>
        {label}
      </div>
      <div className="flex flex-wrap gap-x-2 gap-y-1">
        {options.map((o) => {
          const selected = o.value === value;
          return (
            <button
              key={o.value}
              type="button"
              role="radio"
              aria-checked={selected}
              aria-label={o.aria}
              disabled={o.disabled}
              data-testid={testIdPrefix ? `${testIdPrefix}-${o.value}` : undefined}
              onClick={() => {
                if (!selected) haptic('select');
                onChange(o.value);
              }}
              className="inline-flex min-h-(--ps-tap) items-center py-1 disabled:opacity-40"
            >
              <span
                className={cx(
                  'inline-flex h-9 items-center gap-1 rounded-full border px-3.5 text-small font-semibold transition-colors',
                  selected ? 'border-accent bg-accent text-on-accent' : 'border-border-strong bg-surface-2 text-fg'
                )}
              >
                {selected && <Check size={14} aria-hidden />}
                {o.label}
              </span>
            </button>
          );
        })}
      </div>
    </div>
  );
}

export function Switch({
  checked,
  onChange,
  label,
  description,
  disabled,
  testId
}: {
  checked: boolean;
  onChange: (v: boolean) => void;
  label: string;
  description?: string;
  disabled?: boolean;
  testId?: string;
}) {
  return (
    <button
      type="button"
      role="switch"
      aria-checked={checked}
      disabled={disabled}
      data-testid={testId}
      onClick={() => {
        haptic('select');
        onChange(!checked);
      }}
      className="flex min-h-(--ps-tap-lg) w-full items-center justify-between gap-4 py-2 text-left disabled:opacity-45"
    >
      <span className="min-w-0">
        <span className="block text-body">{label}</span>
        {description && <span className="block text-caption text-fg-muted">{description}</span>}
      </span>
      <span
        aria-hidden
        className={cx('relative inline-block h-[31px] w-[51px] shrink-0 rounded-full transition-colors', checked ? 'bg-accent' : 'bg-surface-3')}
      >
        <span
          className={cx(
            'absolute top-[2px] size-[27px] rounded-full bg-white shadow-1 transition-transform duration-(--ps-dur-move-fast)',
            checked ? 'translate-x-[22px]' : 'translate-x-[2px]'
          )}
        />
      </span>
    </button>
  );
}

export function Stepper({
  value,
  onChange,
  min = 1,
  max = 100,
  label = 'Quantity',
  testId
}: {
  value: number;
  onChange: (v: number) => void;
  min?: number;
  max?: number;
  label?: string;
  testId?: string;
}) {
  const clamp = (n: number) => Math.min(max, Math.max(min, n));
  return (
    <div className="inline-flex items-center gap-1" role="group" aria-label={label}>
      <IconButton
        label={`Decrease ${label.toLowerCase()}`}
        icon={MinusIcon}
        disabled={value <= min}
        className="bg-surface-3"
        onClick={() => {
          haptic('select');
          onChange(clamp(value - 1));
        }}
      />
      <input
        data-testid={testId}
        aria-label={label}
        inputMode="numeric"
        pattern="[0-9]*"
        autoComplete="off"
        value={value}
        onChange={(e) => {
          const n = parseInt(e.target.value.replace(/\D/g, ''), 10);
          onChange(Number.isFinite(n) ? clamp(n) : min);
        }}
        className="h-(--ps-tap) w-14 rounded-md bg-surface-2 text-center text-body tabular-nums"
      />
      <IconButton
        label={`Increase ${label.toLowerCase()}`}
        icon={PlusIcon}
        disabled={value >= max}
        className="bg-surface-3"
        onClick={() => {
          haptic('select');
          onChange(clamp(value + 1));
        }}
      />
    </div>
  );
}
export function SegmentedControl<T extends string>({
  label,
  value,
  options,
  onChange,
  className,
  tabs = false
}: {
  label: string;
  value: T;
  options: { value: T; label: ReactNode; aria: string; testId?: string }[];
  onChange: (v: T) => void;
  className?: string;
  /** Render as a WAI-ARIA tablist (`role=tab` + `aria-selected`) instead of a radio group. */
  tabs?: boolean;
}) {
  return (
    <div role={tabs ? "tablist" : "radiogroup"} aria-label={label} className={cx('inline-flex rounded-lg bg-surface-3 p-0.5', className)}>
      {options.map((o) => {
        const on = o.value === value;
        return (
          <button
            key={o.value}
            type="button"
            role={tabs ? "tab" : "radio"}
            {...(tabs ? { "aria-selected": on } : { "aria-checked": on })}
            aria-label={o.aria}
            data-testid={o.testId}
            onClick={() => {
              if (!on) haptic('select');
              onChange(o.value);
            }}
            className={cx(
              'inline-flex min-h-(--ps-tap) min-w-(--ps-tap) flex-1 items-center justify-center gap-1 rounded-md px-3 text-small font-semibold transition-colors',
              on ? 'bg-fg text-bg shadow-1' : 'text-fg-muted'
            )}
          >
            {o.label}
          </button>
        );
      })}
    </div>
  );
}

export function Field({
  label,
  hint,
  error,
  children,
  htmlFor
}: {
  label: string;
  hint?: string;
  error?: string | null;
  children: ReactNode;
  htmlFor?: string;
}) {
  return (
    <div className="flex flex-col gap-1">
      <label htmlFor={htmlFor} className="text-caption font-semibold text-fg-muted">
        {label}
      </label>
      {children}
      {hint && !error && <p className="text-caption text-fg-subtle">{hint}</p>}
      {error && (
        <p role="alert" className="text-caption text-negative">
          {error}
        </p>
      )}
    </div>
  );
}

const INPUT_CLASS =
  'h-(--ps-tap-lg) w-full min-w-0 rounded-md border border-border-input bg-surface-2 px-3 text-body placeholder:text-fg-subtle focus:border-accent';

export const TextInput = forwardRef<HTMLInputElement, InputHTMLAttributes<HTMLInputElement> & { invalid?: boolean }>(function TextInput(
  { className, invalid, ...rest },
  ref
) {
  return <input ref={ref} autoComplete="off" autoCapitalize="off" spellCheck={false} aria-invalid={invalid || undefined} {...rest} className={cx(INPUT_CLASS, invalid && 'border-negative', className)} />;
});

export const TextArea = forwardRef<HTMLTextAreaElement, TextareaHTMLAttributes<HTMLTextAreaElement>>(function TextArea({ className, ...rest }, ref) {
  return <textarea ref={ref} rows={3} {...rest} className={cx(INPUT_CLASS, 'h-auto min-h-24 py-2 leading-snug', className)} />;
});

export function NativeSelect({
  label,
  value,
  onChange,
  options,
  testId,
  disabled
}: {
  label: string;
  value: string;
  onChange: (v: string) => void;
  options: { value: string; label: string }[];
  testId?: string;
  disabled?: boolean;
}) {
  const id = useId();
  const current = options.find((o) => o.value === value);
  return (
    <div className="relative flex min-h-(--ps-tap-lg) items-center justify-between gap-3 rounded-md border border-border-input bg-surface-2 px-3">
      <label htmlFor={id} className="text-small font-semibold text-fg-muted">
        {label}
      </label>
      <span className="flex min-w-0 items-center gap-1 text-body">
        <span className="truncate">{current?.label ?? '—'}</span>
        <ChevronRight size={16} className="shrink-0 rotate-90 text-fg-subtle" aria-hidden />
      </span>
      <select
        id={id}
        data-testid={testId}
        disabled={disabled}
        value={value}
        onChange={(e) => onChange(e.target.value)}
        className="absolute inset-0 size-full cursor-pointer opacity-0"
      >
        {options.map((o) => (
          <option key={o.value} value={o.value}>
            {o.label}
          </option>
        ))}
      </select>
    </div>
  );
}

export function SelectField(props: SelectHTMLAttributes<HTMLSelectElement> & { label: string }) {
  const { label, children, className, ...rest } = props;
  const id = useId();
  return (
    <Field label={label} htmlFor={id}>
      <select id={id} {...rest} className={cx(INPUT_CLASS, className)}>
        {children}
      </select>
    </Field>
  );
}

export function SearchField({
  value,
  onChange,
  placeholder = 'Search',
  label = 'Search',
  autoFocus,
  inputRef,
  testId = 'search-input',
  onEnter,
  enterKeyHint = 'search'
}: {
  value: string;
  onChange: (v: string) => void;
  placeholder?: string;
  label?: string;
  autoFocus?: boolean;
  inputRef?: React.Ref<HTMLInputElement>;
  testId?: string;
  onEnter?: () => void;
  enterKeyHint?: 'search' | 'done' | 'next';
}) {
  return (
    <div className="relative flex h-(--ps-tap) items-center rounded-md bg-surface-2">
      <Search size={18} className="pointer-events-none absolute left-3 text-fg-subtle" aria-hidden />
      <input
        ref={inputRef}
        data-testid={testId}
        type="search"
        aria-label={label}
        placeholder={placeholder}
        value={value}
        autoFocus={autoFocus}
        enterKeyHint={enterKeyHint}
        autoCapitalize="off"
        autoCorrect="off"
        spellCheck={false}
        autoComplete="off"
        onChange={(e) => onChange(e.target.value)}
        onKeyDown={(e) => e.key === 'Enter' && onEnter?.()}
        className="size-full rounded-md bg-transparent pl-10 pr-11 text-body placeholder:text-fg-subtle"
      />
      {value && (
        <button type="button" aria-label="Clear search" onClick={() => onChange('')} className="absolute right-0 inline-flex size-(--ps-tap) items-center justify-center text-fg-subtle">
          <X size={18} aria-hidden />
        </button>
      )}
    </div>
  );
}

/* ───────── Feedback & structure ───────── */

export function Skeleton({ className }: { className?: string }) {
  return <div aria-hidden className={cx('shimmer rounded-md', className)} />;
}

export function Spinner({ size = 18 }: { size?: number }) {
  return <Loader2 size={size} className="fd-spin" aria-hidden />;
}

export function EmptyState({
  icon: Icon,
  title,
  body,
  action,
  secondary,
  testId
}: {
  icon: LucideIcon;
  title: string;
  body?: ReactNode;
  action?: ReactNode;
  secondary?: ReactNode;
  testId?: string;
}) {
  return (
    <div data-testid={testId} className="mx-auto flex max-w-sm flex-col items-center gap-3 px-6 py-12 text-center">
      <Icon size={64} strokeWidth={1.25} className="text-fg-subtle" aria-hidden />
      <h2 className="text-h3 font-semibold">{title}</h2>
      {body && <p className="max-w-[34ch] text-body text-fg-muted">{body}</p>}
      {action && <div className="mt-2 w-full">{action}</div>}
      {secondary}
    </div>
  );
}

export function ErrorState({ error, onRetry, title, body }: { error: unknown; onRetry?: () => void; title?: string; body?: string }) {
  const copy = describeError(error);
  return (
    <div role="alert" className="mx-auto flex max-w-sm flex-col items-center gap-3 px-6 py-12 text-center">
      <div className="flex size-16 items-center justify-center rounded-full bg-negative-soft text-negative" aria-hidden>
        <X size={32} />
      </div>
      <h2 className="text-h3 font-semibold">{title ?? copy.title}</h2>
      <p className="max-w-[34ch] text-body text-fg-muted">{body ?? copy.body}</p>
      {onRetry && (
        <Button variant="primary" onClick={onRetry}>
          Try again
        </Button>
      )}
      {copy.code && (
        <details className="text-caption text-fg-subtle">
          <summary className="inline-flex min-h-(--ps-tap) cursor-pointer items-center">Details</summary>
          <code className="selectable">{copy.code}</code>
        </details>
      )}
    </div>
  );
}

export function Banner({ tone = 'info', children, action, testId }: { tone?: 'info' | 'warning' | 'negative' | 'positive'; children: ReactNode; action?: ReactNode; testId?: string }) {
  const tones = {
    info: 'bg-info-soft text-fg',
    warning: 'bg-warning-soft text-fg',
    negative: 'bg-negative-soft text-fg',
    positive: 'bg-positive-soft text-fg'
  } as const;
  return (
    <div data-testid={testId} role={tone === 'negative' ? 'alert' : 'status'} className={cx('flex flex-wrap items-center justify-between gap-x-3 gap-y-1 rounded-lg px-4 py-3 text-small', tones[tone])}>
      <div className="min-w-0 flex-1 basis-48">{children}</div>
      {action}
    </div>
  );
}

export function OfflineChip() {
  return (
    <span className="inline-flex items-center gap-1 rounded-full bg-warning-soft px-2 py-0.5 text-micro text-warning">
      <CloudOff size={12} aria-hidden /> Offline
    </span>
  );
}

export function StatTile({ label, value, sub, to, search }: { label: string; value: ReactNode; sub?: ReactNode; to?: string; search?: Record<string, unknown> }) {
  const inner = (
    <>
      <div className="flex items-center justify-between text-caption text-fg-muted">
        <span>{label}</span>
        {to && <ChevronRight size={14} aria-hidden />}
      </div>
      <div className="mt-1 text-h2 font-semibold tabular-nums">{value}</div>
      {sub && <div className="mt-0.5 text-caption text-fg-muted">{sub}</div>}
    </>
  );
  const cls = 'block min-w-0 rounded-lg bg-surface p-4';
  if (to) {
    return (
      <Link to={to as never} search={search as never} className={cx(cls, 'active:scale-(--ps-press-scale)')}>
        {inner}
      </Link>
    );
  }
  return <div className={cls}>{inner}</div>;
}

export function SectionTitle({ children, action }: { children: ReactNode; action?: ReactNode }) {
  return (
    <div className="flex items-center justify-between gap-3">
      <h2 className="text-h2 font-semibold">{children}</h2>
      {action}
    </div>
  );
}

export function SectionCaption({ children, tone }: { children: ReactNode; tone?: 'negative' }) {
  return <div className={cx('px-1 pb-1 pt-5 text-micro uppercase tracking-wide', tone === 'negative' ? 'text-negative' : 'text-fg-muted')}>{children}</div>;
}

/** Grouped settings-style list. */
export function Group({ children, className }: { children: ReactNode; className?: string }) {
  return <div className={cx('divide-y divide-border overflow-hidden rounded-lg bg-surface', className)}>{children}</div>;
}

export function NavRow({
  to,
  search,
  label,
  value,
  onClick,
  tone,
  testId,
  description
}: {
  to?: string;
  search?: Record<string, unknown>;
  label: string;
  value?: ReactNode;
  onClick?: () => void;
  tone?: 'negative';
  testId?: string;
  description?: string;
}) {
  const body = (
    <>
      <span className="min-w-0 flex-1">
        <span className={cx('block text-body', tone === 'negative' && 'text-negative')}>{label}</span>
        {description && <span className="block text-caption text-fg-muted">{description}</span>}
      </span>
      {value !== undefined && <span className="shrink-0 text-small text-fg-muted">{value}</span>}
      <ChevronRight size={18} className="shrink-0 text-fg-subtle" aria-hidden />
    </>
  );
  const cls = 'flex min-h-(--ps-tap-lg) w-full items-center gap-3 px-4 py-2 text-left active:bg-surface-3';
  if (to) {
    return (
      <Link to={to as never} search={search as never} data-testid={testId} className={cls}>
        {body}
      </Link>
    );
  }
  return (
    <button type="button" data-testid={testId} onClick={onClick} className={cls}>
      {body}
    </button>
  );
}

export function ProgressBar({
  value,
  max,
  label,
  valueText,
  testId
}: {
  value: number | null;
  max: number | null;
  label: string;
  valueText?: string;
  testId?: string;
}) {
  const determinate = value !== null && max !== null && max > 0;
  const pct = determinate ? Math.min(100, Math.max(0, (value / max) * 100)) : 0;
  return (
    <div
      role="progressbar"
      data-testid={testId}
      aria-label={label}
      aria-valuemin={0}
      aria-valuemax={determinate ? max : undefined}
      aria-valuenow={determinate ? value : undefined}
      aria-valuetext={valueText}
      className="h-1 w-full overflow-hidden rounded-full bg-surface-3"
    >
      {determinate ? (
        <div className="h-full rounded-full bg-accent transition-[width] duration-(--ps-dur-move)" style={{ width: `${pct}%` }} />
      ) : (
        <div className="shimmer h-full w-full rounded-full" />
      )}
    </div>
  );
}
