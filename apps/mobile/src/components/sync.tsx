import { Link, useLocation } from '@tanstack/react-router';
import { CheckCircle2, CloudOff, AlertCircle, Pause } from 'lucide-react';
import { useEffect, useRef, useState, type ReactNode } from 'react';
import { useActiveSync, useCatalogInstall, useCatalogStatus, useSettings, useResumeSync } from '../data';
import { describeProgress, failureCopy, failureReason, stageOf, STAGE_LABEL } from '../lib/catalog';
import { LANGUAGE_BADGE, LANGUAGE_NAMES, formatInt, type Language } from '../lib/format';
import { useNetwork } from '../lib/native';
import { Button, ProgressBar, cx } from './ui';

/* ───────── ProgressCard (catalog work card) ───────── */

export function ProgressCard({
  title,
  line,
  stageLine,
  value,
  max,
  valueText,
  actions,
  tone,
  testId = 'catalog-progress',
  children
}: {
  title: string;
  line?: string;
  stageLine?: string;
  value: number | null;
  max: number | null;
  valueText: string;
  actions?: ReactNode;
  tone?: 'warning' | 'negative';
  testId?: string;
  children?: ReactNode;
}) {
  return (
    <section data-testid={testId} aria-label={title} className="rounded-lg bg-surface p-4">
      <h2 className="text-body font-semibold">{title}</h2>
      <div className="mt-3">
        <ProgressBar value={value} max={max} label={title} valueText={valueText} />
      </div>
      {line && <p className="mt-2 text-small tabular-nums">{line}</p>}
      {stageLine && <p className={cx('text-caption', tone === 'warning' ? 'text-warning' : tone === 'negative' ? 'text-negative' : 'text-fg-muted')}>{stageLine}</p>}
      {children}
      {actions && <div className="mt-3 flex flex-wrap gap-2">{actions}</div>}
    </section>
  );
}

/* ───────── Combined "catalog work" state for the pill ───────── */

type PillState =
  | { kind: 'running'; label: string; sr: string; percent: number | null; start: string }
  | { kind: 'waiting'; label: string; sr: string }
  | { kind: 'paused'; label: string; sr: string; resume: () => void }
  | { kind: 'done'; label: string; sr: string }
  | { kind: 'failed'; label: string; sr: string; resume?: () => void };

export function useSyncPillState(): PillState | null {
  const install = useCatalogInstall();
  const sync = useActiveSync();
  const net = useNetwork();
  const resume = useResumeSync();
  const cancelledWhileOffline = useRef(false);
  const [done, setDone] = useState<string | null>(null);
  const wasActive = useRef(false);

  const progress = install.progress;

  useEffect(() => {
    if (wasActive.current && !install.active && progress?.phase === 'installed') {
      const name = LANGUAGE_NAMES[progress.language];
      const show = setTimeout(() => setDone(`${name} catalog ready`), 0);
      const t = setTimeout(() => setDone(null), 3000);
      return () => {
        clearTimeout(show);
        clearTimeout(t);
      };
    }
    wasActive.current = install.active;
    return undefined;
  }, [install.active, progress]);

  const run = sync.data ?? null;
  void cancelledWhileOffline;

  // A finished price/card update shows a short "done" pill (the latest run stays `completed` afterwards, so detect the transition).
  const [syncDone, setSyncDone] = useState<string | null>(null);
  const prevRunStatus = useRef<string | null>(null);
  const runStatus = run?.status ?? null;
  const runMode = run?.mode ?? null;
  useEffect(() => {
    const was = prevRunStatus.current;
    prevRunStatus.current = runStatus;
    if ((was === 'running' || was === 'queued') && runStatus === 'completed') {
      const label = runMode === 'prices_only' ? 'Prices updated' : 'Cards updated';
      setTimeout(() => setSyncDone(label), 0);
      setTimeout(() => setSyncDone(null), 3000);
    }
  }, [runStatus, runMode]);
  const doneLabel = done ?? syncDone;

  if (install.active && progress) {
    const d = describeProgress(progress.language, progress);
    const name = LANGUAGE_NAMES[progress.language];
    if (!net.online) return { kind: 'waiting', label: 'Waiting for connection', sr: `Catalog download, ${name}, waiting for connection. Opens catalog settings.` };
    if (d.stage === 'downloading') {
      const pct = d.percent;
      return { kind: 'running', start: 'Catalog download started', percent: pct, label: `Downloading ${name}${pct !== null ? ` · ${pct} %` : '…'}`, sr: `Catalog download, ${name}${pct !== null ? `, ${pct} percent` : ''}. Opens catalog settings.` };
    }
    return { kind: 'running', start: 'Catalog download started', percent: null, label: `${STAGE_LABEL[d.stage]} ${name}…`, sr: `Catalog ${STAGE_LABEL[d.stage].toLowerCase()}, ${name}. Opens catalog settings.` };
  }
  if (run && (run.status === 'running' || run.status === 'queued' || run.status === 'cancel_requested')) {
    const total = run.cardsTotal;
    const pct = total ? Math.round((run.cardsDone / total) * 100) : null;
    const what = run.mode === 'prices_only' ? 'Updating prices' : 'Downloading cards';
    if (!net.online) return { kind: 'waiting', label: 'Waiting for connection', sr: `${what}, waiting for connection. Opens catalog settings.` };
    return { kind: 'running', start: run.mode === 'prices_only' ? 'Updating prices' : 'Card download started', percent: pct, label: `${what}${pct !== null ? ` · ${pct} %` : '…'}`, sr: `${what}${pct !== null ? `, ${pct} percent` : ''}. Opens catalog settings.` };
  }
  if (run && (run.status === 'interrupted' || run.status === 'cancelled')) {
    return { kind: 'paused', label: 'Download paused · Resume', sr: 'Download paused. Resume.', resume: () => resume.mutate({ id: run.id }) };
  }
  if (doneLabel) return { kind: 'done', label: doneLabel, sr: doneLabel };
  if (progress && (progress.phase === 'failed' || progress.phase === 'interrupted') && stageOf(progress.phase) === 'failed') {
    return { kind: 'failed', label: 'Download failed · Details', sr: 'Download failed. Opens catalog settings.' };
  }
  // E4: a run that ended with a failed set is resumable (never shown as done): failed + Resume.
  if (run && run.status === 'failed') return { kind: 'failed', label: 'Download failed · Resume', sr: 'Download failed. Resume.', resume: () => resume.mutate({ id: run.id }) };
  return null;
}

export function SyncPill({ inline }: { inline?: boolean }) {
  const state = useSyncPillState();
  const { pathname } = useLocation();
  const [prevKey, setPrevKey] = useState<string | null>(null);
  const [announce, setAnnounce] = useState('');

  // One polite announcement each at start, completion and failure (not percentages). Derived during render (no effect).
  const key = state ? state.kind : null;
  if (key !== prevKey) {
    setPrevKey(key);
    if (state?.kind === 'running') setAnnounce(state.start);
    else if (key === 'done') setAnnounce(state?.label ?? 'Catalog ready');
    else if (key === 'failed') setAnnounce('Download failed');
  }

  const hidden = !state || pathname === '/settings/catalog' || pathname === '/add' || pathname.startsWith('/welcome') || pathname === '/custom-cards/new';
  useEffect(() => {
    const el = document.documentElement;
    const show = !hidden && !inline;
    el.classList.toggle('has-sync-pill', show);
    return () => el.classList.remove('has-sync-pill');
  }, [hidden, inline]);
  const live = <div role="status" aria-live="polite" className="sr-only">{announce}</div>;
  if (hidden || !state) return live;

  const tone = state.kind === 'failed' ? 'text-negative' : state.kind === 'waiting' ? 'text-warning' : state.kind === 'done' ? 'text-positive' : 'text-fg';
  const icon =
    state.kind === 'running' ? (
      <Ring percent={state.percent} />
    ) : state.kind === 'waiting' ? (
      <CloudOff size={16} aria-hidden />
    ) : state.kind === 'paused' ? (
      <Pause size={16} aria-hidden />
    ) : state.kind === 'done' ? (
      <CheckCircle2 size={16} aria-hidden />
    ) : (
      <AlertCircle size={16} aria-hidden />
    );
  const cls = cx('inline-flex h-(--ps-syncpill-h) min-h-(--ps-syncpill-h) max-w-full items-center gap-2 rounded-full bg-surface-3 px-3 text-small shadow-2', tone);
  const body = (
    <>
      {icon}
      <span className="truncate tabular-nums">{state.label}</span>
    </>
  );
  const pill =
    state.kind === 'paused' || (state.kind === 'failed' && state.resume) ? (
      <button type="button" data-testid="sync-pill" aria-label={state.sr} onClick={state.resume} className={cls}>
        {body}
      </button>
    ) : (
      <Link to="/settings/catalog" data-testid="sync-pill" aria-label={state.sr} className={cls}>
        {body}
      </Link>
    );
  if (inline) return <div className="min-h-(--ps-tap) flex items-center">{pill}{live}</div>;
  return (
    <>
      {live}
      <div
        className="pointer-events-none fixed inset-x-0 flex justify-center px-4 lg:hidden"
        style={{ bottom: 'calc(var(--ps-tabbar-total) + 8px)', zIndex: 'var(--ps-z-syncpill)' }}
      >
        <div className="pointer-events-auto flex max-w-full items-center">{pill}</div>
      </div>
    </>
  );
}

function Ring({ percent }: { percent: number | null }) {
  const r = 6;
  const c = 2 * Math.PI * r;
  return (
    <svg width="16" height="16" viewBox="0 0 16 16" aria-hidden className={percent === null ? 'fd-spin' : undefined}>
      <circle cx="8" cy="8" r={r} fill="none" stroke="var(--ps-border-strong)" strokeWidth="2" />
      <circle
        cx="8"
        cy="8"
        r={r}
        fill="none"
        stroke="var(--ps-accent)"
        strokeWidth="2"
        strokeLinecap="round"
        strokeDasharray={c}
        strokeDashoffset={percent === null ? c * 0.7 : c * (1 - percent / 100)}
        transform="rotate(-90 8 8)"
      />
    </svg>
  );
}

/* ───────── Sidebar footer: catalog status per language ───────── */

export function SidebarCatalogStatus() {
  return (
    <Link to="/settings/catalog" className="flex flex-col gap-0.5 rounded-md px-2 py-1 text-caption text-fg-muted">
      <LangStatus language="en" />
      <LangStatus language="ja" />
    </Link>
  );
}

function LangStatus({ language }: { language: Language }) {
  const status = useCatalogStatus(language);
  const settings = useSettings();
  const install = useCatalogInstall();
  const wanted = settings.data?.languages.includes(language) ?? true;
  const code = LANGUAGE_BADGE[language];
  const installed = status.data?.installed;
  if (install.active && install.progress?.language === language) {
    const d = describeProgress(language, install.progress);
    return <span>{code} · {d.percent !== null ? `${d.percent} %` : STAGE_LABEL[d.stage]}</span>;
  }
  if (installed?.status === 'installed') return <span>{code} catalog ✓{installed.version ? ` v${installed.version}` : ''}</span>;
  return <span>{wanted ? `${code} catalog —` : `${code} not downloaded`}</span>;
}

/* ───────── Shared install copy helpers ───────── */

export function installErrorLine(code: string | null | undefined): { text: string; retry: boolean } {
  return failureCopy(failureReason(code));
}

export { Button, formatInt };
