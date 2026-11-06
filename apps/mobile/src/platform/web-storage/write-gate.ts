import { MaintenanceError, type SqlDriver } from '@flashydex/core';

/**
 * Update-handoff write gate (WEB-STORAGE §7, W13, Sol S5-04). Wraps every SqlDriver the app hands to core (user + catalog), so it sits
 * UNDER every service mutation, not only the overlay UI. While closed:
 *  - a new transaction (`BEGIN`) or a write statement outside an admitted transaction rejects with MAINTENANCE (nothing reaches SQLite);
 *  - an ALREADY admitted transaction runs to its COMMIT/ROLLBACK (never stranded half-open);
 *  - reads and PRAGMA keep working.
 * `drain()` resolves once no admitted transaction and no in-flight driver call (incl. the post-commit flush barrier) is left.
 */
export interface WriteGate {
  wrap(driver: SqlDriver): SqlDriver;
  close(): void;
  open(): void;
  readonly closed: boolean;
  /** Number of admitted-but-unfinished transactions + in-flight driver calls. */
  pending(): number;
  /** true = drained, false = still pending after `timeoutMs`. */
  drain(timeoutMs: number): Promise<boolean>;
}

/** Safety net: a COMMIT whose afterCommit never arrives (core always calls it right away) stops holding the drain after this long. */
const FLUSH_WAIT_MS = 2000;
/** How long the gate must stay idle before a drain counts as finished (covers the read-back a service does after its COMMIT). */
const DRAIN_QUIET_MS = 40;

type Verb = 'begin' | 'end' | 'write' | 'other';

function classify(sql: string): Verb {
  const head = sql.replace(/^(?:\s+|--[^\n]*\n|\/\*[\s\S]*?\*\/)+/, '').slice(0, 24).toUpperCase();
  if (head.startsWith('BEGIN')) return 'begin';
  if (head.startsWith('COMMIT') || head.startsWith('END') || (head.startsWith('ROLLBACK') && !/^ROLLBACK\s+(TRANSACTION\s+)?TO\b/.test(head))) return 'end';
  if (/^(INSERT|UPDATE|DELETE|REPLACE|CREATE|DROP|ALTER|VACUUM|REINDEX)\b/.test(head)) return 'write';
  return 'other';
}

export function createWriteGate(): WriteGate {
  let closed = false;
  let inflight = 0;
  const open = new Set<object>(); // drivers with an admitted, unfinished transaction
  const flushing = new Set<object>(); // drivers whose COMMIT landed and whose post-commit durable barrier (afterCommit) has not run yet
  const waiters = new Set<() => void>();
  const pendingCount = () => inflight + open.size + flushing.size;
  const settle = () => {
    if (pendingCount() === 0) for (const w of [...waiters]) w();
  };

  return {
    get closed() {
      return closed;
    },
    close() {
      closed = true;
    },
    open() {
      closed = false;
    },
    pending: pendingCount,
    async drain(timeoutMs) {
      // Quiet = nothing pending for DRAIN_QUIET_MS in a row. A service call is several driver calls (BEGIN..COMMIT, flush, then often a
      // read-back); the gate cannot see call boundaries, so it waits for the chain to go quiet instead of closing between two steps.
      const deadline = Date.now() + timeoutMs;
      const untilIdle = (): Promise<boolean> => {
        if (pendingCount() === 0) return Promise.resolve(true);
        return new Promise<boolean>((resolve) => {
          const done = (value: boolean) => {
            clearTimeout(timer);
            waiters.delete(onSettled);
            resolve(value);
          };
          const onSettled = () => done(true);
          const timer = setTimeout(() => done(pendingCount() === 0), Math.max(0, deadline - Date.now()));
          waiters.add(onSettled);
        });
      };
      for (;;) {
        if (!(await untilIdle())) return false;
        await new Promise((r) => setTimeout(r, DRAIN_QUIET_MS));
        if (pendingCount() === 0) return true;
        if (Date.now() >= deadline) return false;
      }
    },
    wrap(driver) {
      const token = {};
      const track = async <T>(fn: () => Promise<T>): Promise<T> => {
        inflight++;
        try {
          return await fn();
        } finally {
          inflight--;
          settle();
        }
      };
      return {
        label: driver.label,
        proxy: (sql, params, method) => {
          const verb = classify(sql);
          if (closed && !open.has(token) && (verb === 'begin' || verb === 'write')) return Promise.reject(new MaintenanceError());
          return track(async () => {
            if (verb === 'begin') {
              const result = await driver.proxy(sql, params, method);
              open.add(token);
              return result;
            }
            if (verb === 'end') {
              const isCommit = /^\s*(COMMIT|END)/i.test(sql);
              try {
                const result = await driver.proxy(sql, params, method);
                if (isCommit && driver.afterCommit) {
                  // core calls afterCommit right after a successful COMMIT: keep the drain open across that gap
                  flushing.add(token);
                  setTimeout(() => { if (flushing.delete(token)) settle(); }, FLUSH_WAIT_MS);
                }
                return result;
              } finally {
                open.delete(token); // COMMIT/ROLLBACK settled either way: core never leaves the owner open (it ROLLBACKs on COMMIT failure)
              }
            }
            return driver.proxy(sql, params, method);
          });
        },
        afterCommit: driver.afterCommit
          ? () => {
              flushing.delete(token);
              return track(() => driver.afterCommit!());
            }
          : undefined,
        reopen: driver.reopen
          ? async () => {
              open.delete(token); // a reopened connection has no transaction
              flushing.delete(token);
              await driver.reopen!();
              settle();
            }
          : undefined,
        close: () => {
          open.delete(token);
          flushing.delete(token);
          const result = driver.close();
          settle();
          return result;
        }
      };
    }
  };
}

/** The one gate for this page's drivers. */
export const writeGate: WriteGate = createWriteGate();
