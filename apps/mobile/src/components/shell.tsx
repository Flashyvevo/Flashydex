import { Link, useLocation, useNavigate } from '@tanstack/react-router';
import { Home, LayoutGrid, Layers, ScanLine, Settings as SettingsIcon, Plus, type LucideIcon } from 'lucide-react';
import { useEffect, useState } from 'react';
import { useIsWide } from '../lib/hooks';
import { BottomSheet } from './overlay';
import { LinkButton, Button, cx } from './ui';
import { SidebarCatalogStatus, SyncPill } from './sync';

/** Keeps `--ps-keyboard-inset` current and reports whether the on-screen keyboard is open. */
export function useKeyboardInset(): boolean {
  const [open, setOpen] = useState(false);
  useEffect(() => {
    const vv = window.visualViewport;
    if (!vv) return;
    const update = () => {
      const inset = Math.max(0, window.innerHeight - vv.height - vv.offsetTop);
      document.documentElement.style.setProperty('--ps-keyboard-inset', `${Math.round(inset)}px`);
      setOpen(inset > 120);
    };
    update();
    vv.addEventListener('resize', update);
    vv.addEventListener('scroll', update);
    return () => {
      vv.removeEventListener('resize', update);
      vv.removeEventListener('scroll', update);
    };
  }, []);
  return open;
}

type TabDef = { to: '/' | '/collection' | '/sets' | '/settings'; label: string; icon: LucideIcon; testId: string; match: (p: string) => boolean };
const TABS: TabDef[] = [
  { to: '/', label: 'Home', icon: Home, testId: 'tab-home', match: (p) => p === '/' },
  { to: '/collection', label: 'Collection', icon: LayoutGrid, testId: 'tab-collection', match: (p) => p.startsWith('/collection') || p.startsWith('/cards/') || p.startsWith('/custom-cards') },
  { to: '/sets', label: 'Sets', icon: Layers, testId: 'tab-sets', match: (p) => p.startsWith('/sets') },
  { to: '/settings', label: 'Settings', icon: SettingsIcon, testId: 'tab-settings', match: (p) => p.startsWith('/settings') }
];

function useTabTap() {
  const navigate = useNavigate();
  const { pathname } = useLocation();
  return (tab: TabDef) => (e: React.MouseEvent) => {
    e.preventDefault();
    if (pathname === tab.to) {
      window.scrollTo({ top: 0, behavior: matchMedia('(prefers-reduced-motion: reduce)').matches ? 'auto' : 'smooth' });
      return;
    }
    void navigate({ to: tab.to, replace: true });
  };
}

export function ScanSheet({ open, onClose }: { open: boolean; onClose: () => void }) {
  const navigate = useNavigate();
  return (
    <BottomSheet open={open} title="Scanner" titleHidden leading="Close" onClose={onClose} testId="scan-sheet">
      <div className="flex flex-col items-center gap-3 pb-2 pt-4 text-center">
        <ScanLine size={56} strokeWidth={1.25} className="text-fg-subtle" aria-hidden />
        <h3 className="text-h3 font-semibold">Camera scanning is coming</h3>
        <p className="max-w-[34ch] text-body text-fg-muted">Scanning arrives in a later update. For now, find cards by name or number — it takes a few seconds.</p>
        <Button
          variant="primary"
          full
          data-testid="scan-sheet-add"
          onClick={() => {
            onClose();
            void navigate({ to: '/add' });
          }}
        >
          Add a card by search
        </Button>
        <Button variant="text" onClick={onClose}>
          Close
        </Button>
      </div>
    </BottomSheet>
  );
}

export function TabBar({ hidden }: { hidden: boolean }) {
  const { pathname } = useLocation();
  const tap = useTabTap();
  const [scanOpen, setScanOpen] = useState(false);
  if (hidden) return null;
  const [home, collection, sets, settings] = TABS as [TabDef, TabDef, TabDef, TabDef];
  const item = (t: TabDef) => {
    const active = t.match(pathname);
    return (
      <Link
        key={t.to}
        to={t.to}
        data-testid={t.testId}
        aria-current={active ? 'page' : undefined}
        onClick={tap(t)}
        className={cx('relative flex min-h-(--ps-tap-lg) flex-1 flex-col items-center justify-center gap-0.5', active ? 'text-chrome-accent' : 'text-fg-muted')}
      >
        <span aria-hidden className={cx('absolute top-0 h-(--ps-tab-indicator-h) w-(--ps-tab-indicator-w) rounded-b-full bg-tab-indicator', !active && 'hidden')} />
        <t.icon size={24} aria-hidden strokeWidth={active ? 2.4 : 2} />
        <span className="text-tab font-semibold">{t.label}</span>
      </Link>
    );
  };
  return (
    <>
      <nav
        aria-label="Tabs"
        data-testid="tab-bar"
        className="fixed inset-x-0 bottom-0 border-t border-chrome-border bg-chrome lg:hidden"
        style={{
          zIndex: 'var(--ps-z-nav)',
          paddingBottom: 'var(--ps-safe-bottom)',
          paddingLeft: 'var(--ps-safe-left)',
          paddingRight: 'var(--ps-safe-right)',
          backdropFilter: 'var(--ps-chrome-backdrop)',
          WebkitBackdropFilter: 'var(--ps-chrome-backdrop)'
        }}
      >
        <div className="flex h-(--ps-tabbar-h) items-stretch">
          {item(home)}
          {item(collection)}
          <div className="relative flex min-h-(--ps-tap-lg) flex-1 flex-col items-center justify-center">
            <button
              type="button"
              data-testid="tab-scan"
              aria-disabled="true"
              aria-label="Scan, coming in a later update"
              onClick={() => setScanOpen(true)}
              className="absolute left-1/2 flex size-(--ps-scan-fab) -translate-x-1/2 items-center justify-center rounded-full bg-surface-3 text-fg-disabled shadow-scan"
              style={{ top: 'calc(var(--ps-scan-raise) * -1)' }}
            >
              <ScanLine size={26} aria-hidden />
            </button>
            <span aria-hidden data-testid="tab-scan-label" className="absolute inset-x-0 bottom-0.5 text-center text-tab font-semibold leading-none text-fg-subtle">
              Soon
            </span>
          </div>
          {item(sets)}
          {item(settings)}
        </div>
      </nav>
      <ScanSheet open={scanOpen} onClose={() => setScanOpen(false)} />
    </>
  );
}

export function Sidebar() {
  const { pathname } = useLocation();
  const tap = useTabTap();
  const [scanOpen, setScanOpen] = useState(false);
  const wide = useIsWide();
  if (!wide) return null;
  return (
    <aside
      className="fixed inset-y-0 left-0 flex w-(--ps-sidebar-w) flex-col gap-1 border-r border-border bg-surface p-3"
      style={{ zIndex: 'var(--ps-z-nav)', paddingLeft: 'max(12px, var(--ps-safe-left))' }}
    >
      <div className="px-2 pb-2 pt-3 text-h3 font-bold">FlashyDex</div>
      <LinkButton to="/add" variant="primary" icon={Plus} full data-testid="sidebar-add">
        Add card
      </LinkButton>
      <nav aria-label="Main" className="mt-3 flex flex-col gap-1">
        {TABS.map((t) => {
          const active = t.match(pathname);
          return (
            <Link
              key={t.to}
              to={t.to}
              onClick={tap(t)}
              data-testid={`side-${t.testId}`}
              aria-current={active ? 'page' : undefined}
              className={cx('flex min-h-(--ps-tap) items-center gap-3 rounded-md px-3 text-body font-medium', active ? 'bg-accent-soft text-accent-fg' : 'text-fg-muted')}
            >
              <t.icon size={20} aria-hidden />
              {t.label === 'Home' ? 'Dashboard' : t.label}
            </Link>
          );
        })}
        <button
          type="button"
          aria-disabled="true"
          aria-label="Scan, coming in a later update"
          onClick={() => setScanOpen(true)}
          className="flex min-h-(--ps-tap) items-center gap-3 rounded-md px-3 text-body font-medium text-fg-disabled"
        >
          <ScanLine size={20} aria-hidden />
          <span className="flex-1 text-left">Scan</span>
          <span className="text-micro text-fg-subtle">Soon</span>
        </button>
      </nav>
      <div className="mt-auto flex flex-col gap-2 border-t border-border pt-3">
        <SidebarCatalogStatus />
        <SyncPill inline />
      </div>
      <ScanSheet open={scanOpen} onClose={() => setScanOpen(false)} />
    </aside>
  );
}
