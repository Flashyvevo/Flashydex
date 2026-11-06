import { beforeEach, describe, expect, it, vi } from 'vitest';
import { createWriteGate } from '../platform/web-storage/write-gate';
import { getHandoffUi, HandoffError, prepareUpdateHandoff, runUpdateHandoff, dismissHandoffFailure, resetHandoffUi, type HandoffDeps } from './handoff';

function fakeDriver(log: string[] = []) {
  return {
    label: 'fake',
    proxy: vi.fn(async (sql: string) => {
      log.push(sql);
      await new Promise((r) => setTimeout(r, 5));
      return { rows: [] };
    }),
    afterCommit: vi.fn(async () => {
      log.push('<flush>');
    }),
    close: vi.fn(async () => undefined)
  };
}

function deps(over: Partial<HandoffDeps> = {}) {
  const calls: string[] = [];
  const gate = createWriteGate();
  const d: HandoffDeps = {
    gate: {
      close: () => { calls.push('gate.close'); gate.close(); },
      open: () => { calls.push('gate.open'); gate.open(); },
      drain: (ms) => gate.drain(ms)
    },
    listOpenPaths: async () => ['/user/u-1.db', '/catalog-en/g-1.db'],
    closePath: async (p, o) => { calls.push(`closePath:${p}:${o.drain}`); },
    shutdownClient: async () => { calls.push('shutdown'); },
    releaseWriterLock: () => { calls.push('release'); },
    busyReason: () => null,
    setBlocked: (on) => { calls.push(`blocked:${on}`); },
    ...over
  };
  return { d, gate, calls };
}

describe('write gate', () => {
  it('lets an admitted transaction finish, rejects new transactions and writes, keeps reads', async () => {
    const gate = createWriteGate();
    const driver = gate.wrap(fakeDriver());
    await driver.proxy('BEGIN IMMEDIATE', [], 'run');
    gate.close();
    await expect(driver.proxy('SELECT 1', [], 'values')).resolves.toBeTruthy();
    await expect(driver.proxy('INSERT INTO t VALUES (1)', [], 'run')).resolves.toBeTruthy(); // inside the admitted tx
    const other = gate.wrap(fakeDriver());
    await expect(other.proxy('BEGIN IMMEDIATE', [], 'run')).rejects.toMatchObject({ code: 'MAINTENANCE' });
    await expect(other.proxy('UPDATE t SET a = 1', [], 'run')).rejects.toMatchObject({ code: 'MAINTENANCE' });
    expect(gate.pending()).toBe(1);
    const drained = gate.drain(1000);
    await driver.proxy('COMMIT', [], 'run');
    await driver.afterCommit!();
    await expect(drained).resolves.toBe(true);
    await expect(driver.proxy('BEGIN IMMEDIATE', [], 'run')).rejects.toMatchObject({ code: 'MAINTENANCE' });
    gate.open();
    await expect(driver.proxy('BEGIN IMMEDIATE', [], 'run')).resolves.toBeTruthy();
  });

  it('drain times out while a transaction stays open', async () => {
    const gate = createWriteGate();
    const driver = gate.wrap(fakeDriver());
    await driver.proxy('BEGIN IMMEDIATE', [], 'run');
    gate.close();
    await expect(gate.drain(20)).resolves.toBe(false);
  });

  it('a failed COMMIT still ends the transaction (core rolls back)', async () => {
    const gate = createWriteGate();
    const raw = fakeDriver();
    const driver = gate.wrap(raw);
    await driver.proxy('BEGIN IMMEDIATE', [], 'run');
    raw.proxy.mockRejectedValueOnce(new Error('io'));
    await expect(driver.proxy('COMMIT', [], 'run')).rejects.toThrow('io');
    expect(gate.pending()).toBe(0);
  });
});

describe('prepareUpdateHandoff', () => {
  it('closes gate, drains, closes every path with drain:true, shuts the client down, then releases the lock, in that order', async () => {
    const { d, calls } = deps();
    await prepareUpdateHandoff(d);
    expect(calls).toEqual(['blocked:true', 'gate.close', 'closePath:/user/u-1.db:true', 'closePath:/catalog-en/g-1.db:true', 'shutdown', 'release']);
  });

  it('waits for an open transaction before closing any path', async () => {
    const { d, gate, calls } = deps();
    const driver = gate.wrap(fakeDriver());
    await driver.proxy('BEGIN IMMEDIATE', [], 'run');
    const prep = prepareUpdateHandoff(d);
    await new Promise((r) => setTimeout(r, 30));
    expect(calls.some((c) => c.startsWith('closePath'))).toBe(false);
    await driver.proxy('INSERT INTO t VALUES (1)', [], 'run');
    await driver.proxy('COMMIT', [], 'run');
    await driver.afterCommit!();
    await prep;
    expect(calls.filter((c) => c.startsWith('closePath'))).toHaveLength(2);
  });

  it('refuses when a job is running: nothing is blocked or closed', async () => {
    const { d, calls } = deps({ busyReason: () => 'A catalog download is running.' });
    await expect(prepareUpdateHandoff(d)).rejects.toMatchObject({ recoverable: true, offerReload: false });
    expect(calls).toEqual([]);
  });

  it('drain timeout reopens the gate and unblocks (app stays usable) with a Reload offer', async () => {
    const { d, gate, calls } = deps({ drainTimeoutMs: 20 });
    const driver = gate.wrap(fakeDriver());
    await driver.proxy('BEGIN IMMEDIATE', [], 'run');
    await expect(prepareUpdateHandoff(d)).rejects.toMatchObject({ recoverable: true, offerReload: true });
    expect(calls).toContain('gate.open');
    expect(calls.at(-1)).toBe('blocked:false');
    expect(calls.some((c) => c.startsWith('closePath'))).toBe(false);
    expect(gate.closed).toBe(false);
  });

  it('a job that appears while draining aborts the handoff and reopens the gate', async () => {
    let n = 0;
    const { d, calls } = deps({ busyReason: () => (++n >= 2 ? 'A restore is running.' : null) });
    await expect(prepareUpdateHandoff(d)).rejects.toBeInstanceOf(HandoffError);
    expect(calls).toContain('gate.open');
  });

  it('a stuck closePath surfaces a non-recoverable error with Reload (never waits forever)', async () => {
    const { d } = deps({ closeTimeoutMs: 20, closePath: () => new Promise(() => undefined) });
    await expect(prepareUpdateHandoff(d)).rejects.toMatchObject({ recoverable: false, offerReload: true });
  });
});

describe('runUpdateHandoff', () => {
  beforeEach(() => {
    // reset module state between tests: a recoverable failure is dismissible, the rest is replaced by the next run
    resetHandoffUi();
  });

  it('happy path: prepare, then activate; no failure shown', async () => {
    const { d } = deps();
    const activate = vi.fn(async (prepare: () => Promise<void>) => { await prepare(); });
    await runUpdateHandoff(d, activate, () => null);
    expect(activate).toHaveBeenCalledTimes(1);
    expect(getHandoffUi().phase).toBe('saving'); // the controller reloads; the overlay stays up
  });

  it('busy: failure is recoverable, "Restart later" returns the UI to idle', async () => {
    const { d } = deps({ busyReason: () => 'A catalog download is running.' });
    // applyUpdate swallows prepare failures (records its own error) and resolves
    await runUpdateHandoff(d, async (prepare) => { await prepare().catch(() => undefined); }, () => 'x');
    expect(getHandoffUi()).toMatchObject({ phase: 'failed', failure: { recoverable: true } });
    expect(getHandoffUi().failure?.message).toMatch(/download is running/);
    resetHandoffUi();
    expect(getHandoffUi().phase).toBe('idle');
  });

  it('no waiting worker / activation timeout (applyUpdate resolves normally with an error): failure with Reload, UI stays blocked behind it', async () => {
    const { d, calls } = deps();
    await runUpdateHandoff(d, async (prepare) => { await prepare(); }, () => 'No update is waiting');
    expect(getHandoffUi()).toMatchObject({ phase: 'failed', failure: { recoverable: false, offerReload: true } });
    expect(calls.at(-1)).toBe('blocked:true');
    dismissHandoffFailure(); // not dismissible: storage is closed
    expect(getHandoffUi().phase).toBe('failed');
  });
});

describe('write gate: COMMIT -> afterCommit gap', () => {
  it('stays pending between a landed COMMIT and its durable barrier, so a close cannot slip in between', async () => {
    const gate = createWriteGate();
    const driver = gate.wrap(fakeDriver());
    await driver.proxy('BEGIN IMMEDIATE', [], 'run');
    await driver.proxy('COMMIT', [], 'run');
    expect(gate.pending()).toBe(1);
    await driver.afterCommit!();
    expect(gate.pending()).toBe(0);
  });
});
