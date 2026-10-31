import { createFileRoute } from '@tanstack/react-router';
import { useEffect, useState } from 'react';
import { readSqliteVersion } from '../platform/sqlite';

export function FlashyDexHome() {
  const [status, setStatus] = useState('Opening local SQLite…');

  useEffect(() => {
    void readSqliteVersion()
      .then((version) => setStatus(`SQLite ${version}`))
      .catch((error: unknown) => {
        const message = error instanceof Error ? error.message : 'Unknown SQLite error.';
        setStatus(`SQLite unavailable: ${message}`);
      });
  }, []);

  return (
    <main className="min-h-dvh bg-[#101114] px-6 pt-[max(2rem,env(safe-area-inset-top))] text-zinc-100">
      <section className="mx-auto max-w-sm pt-20">
        <p className="text-sm font-medium tracking-[0.2em] text-zinc-500">LOCAL COLLECTION</p>
        <h1 className="mt-3 text-5xl font-semibold tracking-tight">FlashyDex</h1>
        <p aria-live="polite" className="mt-8 rounded-xl border border-zinc-800 bg-zinc-900/60 p-4 text-sm text-zinc-300">
          {status}
        </p>
      </section>
    </main>
  );
}

export const Route = createFileRoute('/')({ component: FlashyDexHome });
