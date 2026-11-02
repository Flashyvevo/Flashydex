import { createFileRoute } from '@tanstack/react-router';
import { useEffect, useState } from 'react';
import { useToast } from '../../../components/overlay';
import { Page } from '../../../components/page';
import { Button, Group } from '../../../components/ui';
import { collectDiagnostics, type Diagnostics } from '../../../lib/diagnostics';
import { formatBytes } from '../../../lib/format';

export const Route = createFileRoute('/_tabs/settings/diagnostics')({ component: DiagnosticsPage });

function scalar(v: unknown): string {
  if (v === null || v === undefined) return '—';
  if (typeof v === 'number') return Number.isInteger(v) && v > 1_000_000 ? `${v.toLocaleString()} (${formatBytes(v)})` : String(v);
  if (typeof v === 'object') return JSON.stringify(v);
  return String(v);
}

function Section({ title, value, testId }: { title: string; value: unknown; testId: string }) {
  const rows: [string, unknown][] = value !== null && typeof value === 'object' && !Array.isArray(value) ? Object.entries(value as Record<string, unknown>) : [['value', value]];
  return (
    <section aria-label={title} data-testid={testId} className="flex flex-col gap-1">
      <h3 className="px-1 pt-4 text-micro uppercase tracking-wide text-fg-muted">{title}</h3>
      <Group>
        {rows.map(([k, v]) => (
          <div key={k} className="grid grid-cols-[minmax(0,2fr)_minmax(0,3fr)] gap-x-3 px-4 py-2 text-small">
            <span className="text-fg-muted">{k}</span>
            <span className="selectable break-all text-right" data-diag-key={k}>{scalar(v)}</span>
          </div>
        ))}
      </Group>
    </section>
  );
}

function DiagnosticsPage() {
  const toast = useToast();
  const [data, setData] = useState<Diagnostics | null>(null);
  const [tick, setTick] = useState(0);
  useEffect(() => {
    let live = true;
    void collectDiagnostics().then((d) => { if (live) setData(d); });
    return () => { live = false; };
  }, [tick]);
  const load = () => setTick((t) => t + 1);

  const copy = async () => {
    if (!data) return;
    const text = JSON.stringify(data, null, 2);
    try {
      await navigator.clipboard.writeText(text);
      toast.show({ message: 'Diagnostics copied' });
    } catch {
      toast.show({ message: 'Couldn’t copy. Select the text instead.', tone: 'negative' });
    }
  };

  const measures = (data?.measures as { name: string; ms: number }[] | undefined) ?? [];
  const rest = data ? Object.entries(data).filter(([k]) => !['measures', 'generatedAt'].includes(k)) : [];
  return (
    <Page title="Diagnostics" back={{ label: 'Import, export & backup', to: '/settings/data' }}>
      <p className="text-caption text-fg-muted">Technical details that help diagnose storage and speed. Nothing here contains your cards, notes or ids.</p>
      <div className="mt-3 flex gap-2">
        <Button variant="primary" onClick={() => void copy()} disabled={!data} data-testid="diag-copy">Copy diagnostics</Button>
        <Button variant="secondary" onClick={load} data-testid="diag-refresh">Refresh</Button>
      </div>
      {!data && <p className="pt-4 text-small text-fg-muted" role="status">Collecting…</p>}
      {rest.map(([k, v]) => <Section key={k} title={k} value={v} testId={`diag-${k}`} />)}
      {data && (
        <section aria-label="Timings" data-testid="diag-measures" className="flex flex-col gap-1">
          <h3 className="px-1 pt-4 text-micro uppercase tracking-wide text-fg-muted">fdx timings (ms)</h3>
          <Group>
            {measures.length === 0 && <div className="px-4 py-2 text-small text-fg-muted">None recorded yet.</div>}
            {measures.map((m, i) => (
              <div key={`${m.name}-${i}`} className="grid grid-cols-[minmax(0,3fr)_minmax(0,1fr)] gap-x-3 px-4 py-2 text-small">
                <span className="break-all text-fg-muted">{m.name}</span>
                <span className="text-right">{m.ms}</span>
              </div>
            ))}
          </Group>
        </section>
      )}
    </Page>
  );
}
