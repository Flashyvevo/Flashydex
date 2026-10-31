import { CloudOff, Layers } from 'lucide-react';
import { Link } from '@tanstack/react-router';
import { useEffect, useRef, useState, type ReactNode } from 'react';
import {
  CONDITION_LABEL,
  CONDITION_ORDER,
  LANGUAGE_BADGE,
  collectorNumber,
  formatMoney,
  hasJapanese,
  imageUrl,
  rarityTier,
  variantChipText,
  variantLabel,
  type Condition,
  type Currency,
  type Language,
  type RarityTier,
  type Variant
} from '../lib/format';
import { haptic } from '../lib/native';
import { cx } from './ui';

/* ───────── Badges ───────── */

const RARITY_VAR: Record<RarityTier, string> = {
  common: 'var(--ps-rarity-common)',
  uncommon: 'var(--ps-rarity-uncommon)',
  rare: 'var(--ps-rarity-rare)',
  holo: 'var(--ps-rarity-holo)',
  ultra: 'var(--ps-rarity-ultra)',
  illustration: 'var(--ps-rarity-illustration)',
  secret: 'linear-gradient(135deg, var(--ps-rarity-secret), var(--ps-rarity-secret-2))',
  promo: 'var(--ps-rarity-promo)',
  unknown: 'var(--ps-rarity-unknown)'
};

export function RarityLabel({ rarity }: { rarity: string | null | undefined }) {
  if (!rarity) return null;
  return (
    <span className="inline-flex items-center gap-1.5 text-caption text-fg-muted">
      <span aria-hidden className="size-2 rounded-full" style={{ background: RARITY_VAR[rarityTier(rarity)] }} />
      {rarity}
    </span>
  );
}

const COND_CLASS: Record<Condition | 'unknown', string> = {
  NM: 'bg-cond-nm text-on-cond-nm',
  LP: 'bg-cond-lp text-on-cond-lp',
  MP: 'bg-cond-mp text-on-cond-mp',
  HP: 'bg-cond-hp text-on-cond-hp',
  DMG: 'bg-cond-dmg text-on-cond-dmg',
  unknown: 'bg-cond-unknown text-on-cond-unknown'
};

export function ConditionBadge({ condition, plus, label }: { condition: Condition | null; plus?: boolean; label?: string }) {
  if (condition === null && !plus) return null; // unknown condition is omitted, never shown as a bare "?" (UX section 12: "Condition not recorded")
  const key = condition ?? 'unknown';
  const aria = label ?? (plus ? `Mixed conditions, best ${CONDITION_LABEL[key]}` : CONDITION_LABEL[key]);
  return (
    <span role="img" aria-label={aria} className={cx('inline-flex h-5 items-center rounded-xs px-1.5 text-micro', COND_CLASS[key])}>
      {condition}
      {plus ? '+' : ''}
    </span>
  );
}

export type GradeLike = { company: string; companyLabel: string | null; grade: string };
export function GradeBadge({ grade }: { grade: GradeLike }) {
  const company = grade.company === 'other' ? (grade.companyLabel ?? 'Graded') : grade.company;
  const gem = grade.grade === '10' || /^(pristine|black label)$/i.test(grade.grade);
  return (
    <span
      role="img"
      aria-label={`Graded ${company} ${grade.grade}`}
      className={cx('inline-flex h-5 items-center gap-1 rounded-xs bg-grade-bg px-1.5 text-grade-fg', gem && 'ring-[1.5px] ring-grade-gem')}
    >
      <span className="text-micro uppercase opacity-70">{company}</span>
      <span className="text-micro font-extrabold tabular-nums">{grade.grade}</span>
    </span>
  );
}

export function VariantChip({ variant, detail }: { variant: Variant; detail?: string | null }) {
  const text = variantChipText(variant, detail);
  if (!text) return null;
  const foil = variant === 'holo' || variant === 'reverse_holo' || variant === 'first_edition';
  return (
    <span
      role="img"
      aria-label={variantLabel(variant, detail)}
      className={cx('inline-flex h-[18px] items-center rounded-xs bg-variant-bg px-1.5 text-micro text-variant-fg', foil && 'ring-1 ring-variant-foil-b')}
    >
      {text}
    </span>
  );
}

export function QtyBadge({ qty }: { qty: number }) {
  const ref = useRef<HTMLSpanElement>(null);
  const prev = useRef(qty);
  useEffect(() => {
    if (qty > prev.current) ref.current?.animate([{ transform: 'scale(1)' }, { transform: 'scale(1.18)' }, { transform: 'scale(1)' }], { duration: 320, easing: 'cubic-bezier(0.34,1.56,0.64,1)' });
    prev.current = qty;
  }, [qty]);
  if (qty <= 1) return null;
  return (
    <span ref={ref} data-testid="qty-badge" aria-hidden className="inline-flex h-5 items-center rounded-full bg-qty-bg px-2 text-micro font-bold tabular-nums text-qty-fg">
      ×{qty}
    </span>
  );
}

export function LangBadge({ language }: { language: Language }) {
  return (
    <span aria-label={language === 'en' ? 'English' : 'Japanese'} className="inline-flex h-[18px] items-center rounded-xs bg-surface-3 px-1.5 text-micro text-fg-muted">
      {LANGUAGE_BADGE[language]}
    </span>
  );
}

export function CustomChip() {
  return <span className="inline-flex h-[18px] items-center rounded-xs bg-surface-3 px-1.5 text-micro text-fg-muted">Custom</span>;
}

/** Price text. `cents === null` renders NOTHING (tiles/rows). Card Details uses <NoPrice/> separately. */
export function Price({ cents, currency, className }: { cents: number | null | undefined; currency: Currency; className?: string }) {
  const text = formatMoney(cents, currency);
  if (text === null) return null;
  return (
    <span data-testid="price" className={cx('tabular-nums', className)}>
      {text}
    </span>
  );
}

/* ───────── Card art ───────── */

export type ArtMeta = { name: string; setName?: string | null; localId?: string | null; rarity?: string | null };

export function CardArt({
  image,
  size,
  meta,
  priority,
  className,
  rounded = true,
  alt
}: {
  /** Base image URL as stored in the catalog (suffix is added here). */
  image: string | null | undefined;
  size: 'low' | 'high';
  meta: ArtMeta;
  priority?: boolean;
  className?: string;
  rounded?: boolean;
  alt?: string;
}) {
  const src = imageUrl(image, size);
  const [state, setState] = useState<'loading' | 'loaded' | 'error'>('loading');
  const [attempt, setAttempt] = useState(0);
  const [retried, setRetried] = useState(false);
  // Reset load state when the source changes — derived during render, no effect.
  const [seenSrc, setSeenSrc] = useState(src);
  if (seenSrc !== src) {
    setSeenSrc(src);
    setState('loading');
    setRetried(false);
  }
  useEffect(() => {
    if (state !== 'error' || retried) return;
    const onOnline = () => {
      setRetried(true);
      setState('loading');
      setAttempt((a) => a + 1);
    };
    window.addEventListener('online', onOnline);
    return () => window.removeEventListener('online', onOnline);
  }, [state, retried]);

  const showPlaceholder = !src || state === 'error';
  const tier = rarityTier(meta.rarity);
  return (
    <div
      className={cx('relative aspect-card w-full overflow-hidden bg-skeleton shadow-card', rounded && 'rounded-card', className)}
      data-testid="card-art"
      data-art-state={!src ? 'no-image' : state}
    >
      {src && !showPlaceholder && (
        <>
          {state === 'loading' && <div aria-hidden className="shimmer absolute inset-0" />}
          <img
            key={attempt}
            src={src}
            alt={alt ?? ''}
            width={size === 'low' ? 245 : 600}
            height={size === 'low' ? 337 : 825}
            loading={priority ? 'eager' : 'lazy'}
            decoding="async"
            // @ts-expect-error fetchpriority is valid HTML; React 19 types lag
            fetchpriority={priority ? 'high' : undefined}
            draggable={false}
            onLoad={() => setState('loaded')}
            onError={() => setState('error')}
            className={cx('absolute inset-0 size-full object-cover transition-opacity duration-(--ps-dur-fade)', state === 'loaded' ? 'opacity-100' : 'opacity-0')}
          />
        </>
      )}
      {showPlaceholder && <ArtPlaceholder meta={meta} tier={tier} unavailable={!!src} />}
    </div>
  );
}

function ArtPlaceholder({ meta, tier, unavailable }: { meta: ArtMeta; tier: RarityTier; unavailable: boolean }) {
  const sub = [meta.setName, meta.localId ? `#${meta.localId}` : null].filter(Boolean).join(' · ');
  return (
    <div role="img" aria-label={`${unavailable ? 'Image not loaded' : 'No catalog image'}: ${meta.name}`} className="absolute inset-0 flex flex-col items-center justify-center gap-1 border border-dashed border-art-empty-border bg-art-empty p-2 text-center">
      <div aria-hidden className="absolute inset-x-0 top-0 h-0.5" style={{ background: RARITY_VAR[tier] }} />
      <Layers size={18} className="text-fg-subtle" aria-hidden />
      <span lang={hasJapanese(meta.name) ? 'ja' : undefined} className="line-clamp-3 break-words text-caption font-semibold leading-tight">
        {meta.name}
      </span>
      {sub && <span className="line-clamp-2 break-words text-micro font-normal text-fg-muted">{sub}</span>}
      {unavailable && <CloudOff size={16} className="absolute bottom-1.5 right-1.5 text-fg-subtle" aria-hidden />}
      <span className="sr-only">{unavailable ? 'Image not loaded' : 'No catalog image'}</span>
    </div>
  );
}

/* ───────── Condition / group summaries ───────── */

export function bestCondition(conditions: { condition: Condition | null; qty: number }[]): { condition: Condition | null; mixed: boolean } {
  const distinct = new Set(conditions.map((c) => c.condition));
  if (distinct.size <= 1) return { condition: conditions[0]?.condition ?? null, mixed: false };
  let best: Condition | null = null;
  for (const c of CONDITION_ORDER) {
    if (distinct.has(c)) {
      best = c;
      break;
    }
  }
  return { condition: best, mixed: true };
}

/* ───────── Card tile ───────── */

export type TileLink = { to: string; params?: Record<string, string>; search?: Record<string, unknown> };

export function CardTile({
  link,
  name,
  image,
  meta,
  metaLine,
  qty = 1,
  variant,
  variantDetail,
  conditions,
  grade,
  hasGraded,
  priceCents,
  currency,
  language,
  showLang,
  custom,
  ariaLabel,
  onLongPress,
  missing,
  dim,
  overlay,
  testId = 'card-tile'
}: {
  link: TileLink;
  name: string;
  image: string | null | undefined;
  meta: ArtMeta;
  metaLine?: string | null;
  qty?: number;
  variant?: Variant;
  variantDetail?: string | null;
  conditions?: { condition: Condition | null; qty: number }[];
  grade?: GradeLike | null;
  hasGraded?: boolean;
  priceCents?: number | null;
  currency?: Currency;
  language?: Language;
  showLang?: boolean;
  custom?: boolean;
  ariaLabel: string;
  onLongPress?: () => void;
  missing?: boolean;
  dim?: boolean;
  overlay?: ReactNode;
  testId?: string;
}) {
  const press = useRef<ReturnType<typeof setTimeout> | undefined>(undefined);
  const longPressed = useRef(false);
  const cond = conditions && conditions.length > 0 ? bestCondition(conditions) : null;
  return (
    <div className="relative min-w-0" data-testid={`${testId}-wrap`}>
      <Link
        to={link.to as never}
        params={link.params as never}
        search={link.search as never}
        data-testid={testId}
        aria-label={ariaLabel}
        draggable={false}
        onClick={(e) => {
          if (longPressed.current) {
            e.preventDefault();
            longPressed.current = false;
          }
        }}
        onContextMenu={(e) => onLongPress && e.preventDefault()}
        onPointerDown={() => {
          if (!onLongPress) return;
          longPressed.current = false;
          press.current = setTimeout(() => {
            longPressed.current = true;
            haptic('longpress');
            onLongPress();
          }, 500);
        }}
        onPointerUp={() => clearTimeout(press.current)}
        onPointerLeave={() => clearTimeout(press.current)}
        onPointerCancel={() => clearTimeout(press.current)}
        className="block min-w-0 transition-transform duration-(--ps-dur-move-fast) active:scale-(--ps-press-scale)"
      >
        <div className={cx('relative', missing && 'rounded-card outline-1 outline-dashed outline-border-strong')}>
          <div className={cx('transition-[opacity,filter] duration-(--ps-dur-fade-slow)', dim && 'opacity-35 grayscale')}>
            <CardArt image={image} size="low" meta={meta} />
          </div>
          <div className="pointer-events-none absolute inset-x-1.5 top-1.5 flex items-start justify-between gap-1">
            <QtyBadge qty={qty} />
            <span className="ml-auto flex items-center gap-1">
              {custom && <CustomChip />}
              {variant && <VariantChip variant={variant} detail={variantDetail} />}
            </span>
          </div>
          <div className="pointer-events-none absolute bottom-1.5 left-1.5 flex items-center gap-1">
            {grade ? <GradeBadge grade={grade} /> : cond ? <ConditionBadge condition={cond.condition} plus={cond.mixed} /> : null}
            {hasGraded && !grade && <span aria-label="includes graded copies" className="size-1.5 rounded-full bg-bg" />}
          </div>
          {showLang && language && (
            <div className="pointer-events-none absolute bottom-1.5 right-1.5">
              <LangBadge language={language} />
            </div>
          )}
        </div>
        <div className="mt-1.5 min-w-0 px-0.5">
          <div lang={hasJapanese(name) ? 'ja' : undefined} className="truncate text-caption font-semibold">
            {name}
          </div>
          <div className="flex items-baseline justify-between gap-1 text-micro font-normal text-fg-muted">
            <span className="min-w-0 truncate">{metaLine}</span>
            {currency && <Price cents={priceCents} currency={currency} className="shrink-0 text-caption text-fg" />}
          </div>
        </div>
      </Link>
      {overlay}
    </div>
  );
}

/* ───────── Compact row ───────── */

export function CardRow({
  link,
  onClick,
  name,
  image,
  meta,
  line2,
  qty,
  priceCents,
  currency,
  badges,
  trailing,
  ariaLabel,
  testId = 'card-row'
}: {
  link?: TileLink;
  onClick?: () => void;
  name: string;
  image: string | null | undefined;
  meta: ArtMeta;
  line2: ReactNode;
  qty?: number;
  priceCents?: number | null;
  currency?: Currency;
  badges?: ReactNode;
  trailing?: ReactNode;
  ariaLabel?: string;
  testId?: string;
}) {
  const content = (
    <>
      <div className="w-10 shrink-0">
        <CardArt image={image} size="low" meta={meta} className="shadow-none" />
      </div>
      <div className="min-w-0 flex-1">
        <div className="flex items-baseline justify-between gap-2">
          <span lang={hasJapanese(name) ? 'ja' : undefined} className="truncate text-body font-medium">
            {name}
          </span>
          <span className="flex shrink-0 items-baseline gap-2 text-small">
            {qty && qty > 1 ? <span className="tabular-nums text-fg-muted">×{qty}</span> : null}
            {currency && <Price cents={priceCents} currency={currency} />}
          </span>
        </div>
        <div className="flex items-center justify-between gap-2 text-caption text-fg-muted">
          <span className="min-w-0 truncate">{line2}</span>
          {badges && <span className="flex shrink-0 items-center gap-1.5">{badges}</span>}
        </div>
        {trailing}
      </div>
    </>
  );
  const cls = 'flex min-h-16 w-full items-center gap-3 px-4 py-2 text-left active:bg-surface-3';
  if (link) {
    return (
      <Link to={link.to as never} params={link.params as never} search={link.search as never} data-testid={testId} aria-label={ariaLabel} className={cls}>
        {content}
      </Link>
    );
  }
  return (
    <button type="button" data-testid={testId} aria-label={ariaLabel} onClick={onClick} className={cls}>
      {content}
    </button>
  );
}

export { collectorNumber };
