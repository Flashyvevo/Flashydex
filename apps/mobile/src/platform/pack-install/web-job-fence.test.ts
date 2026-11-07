// @vitest-environment node
import { afterEach, describe, expect, it } from 'vitest';
import { CatalogInstallService, type ProxyCallback } from '@flashydex/core';
import { createTestDatabases, FakeDiskPort, type ProxyFactory, type TestDatabases } from '@flashydex/core/testing';
import { HandoffError, prepareUpdateHandoff, resetHandoffUi, type HandoffDeps } from '../../lib/handoff';
import { createProxyCallback } from '../sqlite-proxy';
import { createJobRegistry, observeJobAdmission, type JobRegistry } from '../web-storage/job-registry';
import { createWriteGate, type WriteGate } from '../web-storage/write-gate';

/**
 * S8-01: the update handoff must not give the writer lock away while an admitted catalog job is alive. REAL core CatalogInstallService +
 * WorkCoordinator over a real SQLite USER file; the write gate and the lease observer sit under it exactly as in createUserDriver().
 * The held `remove` stands in for the role-store IndexedDB work that Sol's reproduction queued behind a fixture transaction.
 */
const V1 = '2026.10.31.001';
const HA = 'a'.repeat(64);
const CFG = { trustedOrigins: ['https://example.test'] };
const noop = () => undefined;
const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));
const code = (p: Promise<unknown>) => p.then(() => 'ok', (e: unknown) => (e as { code?: string }).code ?? String(e));

let cleanups: Array<() => Promise<void>> = [];
afterEach(async () => {
  for (const c of cleanups) await c();
  cleanups = [];
  resetHandoffUi();
});

async function setup() {
  const registry: JobRegistry = createJobRegistry();
  const gate: WriteGate = createWriteGate();
  const proxyFactory: ProxyFactory = (connection) => {
    const base = createProxyCallback(connection) as ProxyCallback;
    return gate.wrap(observeJobAdmission({ label: 'user', proxy: base, close: async () => undefined }, registry)).proxy;
  };
  const t: TestDatabases = await createTestDatabases({ proxyFactory });
  cleanups.push(() => t.cleanup());
  const port = new FakeDiskPort(t.dir, t.env);
  const svc = new CatalogInstallService({ databases: t.databases, env: t.env } as never, port, CFG);
  const events: string[] = [];
  const deps = (extra: Partial<HandoffDeps> = {}): HandoffDeps => ({
    gate,
    listOpenPaths: async () => [],
    closePath: async () => undefined,
    shutdownClient: async () => { events.push('worker-terminated'); },
    releaseWriterLock: () => { events.push('lock-released'); },
    busyReason: () => null,
    setBlocked: () => undefined,
    jobFence: { settle: async (ms) => (await registry.retire(ms)).settled, lift: () => registry.lift() },
    ...extra
  });
  const install = async () => {
    port.manifestJson = FakeDiskPort.manifest(['en'], V1, HA);
    return svc.install('en', noop, new AbortController().signal);
  };
  const receipt = async () => (await t.user.rows("SELECT status FROM installed_catalogs WHERE language = 'en'"))[0]?.[0];
  const leaseRows = async () => Number((await t.user.rows('SELECT count(*) FROM work_admission'))[0]?.[0]);
  const waitAlive = async () => {
    for (let i = 0; i < 200 && registry.active().length === 0; i++) await sleep(10);
    expect(registry.active()).toHaveLength(1);
  };
  return { registry, gate, port, svc, events, deps, install, receipt, leaseRows, waitAlive, t };
}

describe('S8-01 whole-job lifetime fence', () => {
  it('handoff waits for an admitted uninstall whose role IO is held, the uninstall completes its USER receipt under the open gate, THEN the lock is released', async () => {
    const c = await setup();
    await c.install();
    expect(await c.receipt()).toBe('installed');
    let releaseRoleIo!: () => void;
    c.port.hooks.remove = () => new Promise<void>((resolve) => { releaseRoleIo = resolve; });
    const uninstall = c.svc.uninstall({ language: 'en', confirm: true }).then(() => { c.events.push('uninstall-receipt-done'); return 'ok'; }, (e: { code?: string }) => `err:${e.code}`);
    await c.waitAlive();

    const handoff = prepareUpdateHandoff(c.deps()).then(() => 'handed-off');
    await sleep(150);
    expect(c.events).toEqual([]); // not released, worker still up
    expect(c.gate.closed).toBe(false); // the admitted job may still write its receipt
    expect(c.registry.fenced).toBe(true);

    releaseRoleIo();
    expect(await uninstall).toBe('ok'); // NOT err:MAINTENANCE: the receipt transaction was admitted
    expect(await handoff).toBe('handed-off');
    expect(c.events).toEqual(['uninstall-receipt-done', 'worker-terminated', 'lock-released']);
    expect(await c.receipt()).toBe('absent');
    expect(await c.leaseRows()).toBe(0);
    expect(c.gate.closed).toBe(true);
  });

  it('a job admitted after the fence is refused with RETIRED before it writes its lease row', async () => {
    const c = await setup();
    c.registry.fence();
    expect(await code(c.install())).toBe('RETIRED');
    expect(await code(c.svc.uninstall({ language: 'en', confirm: true }))).toBe('RETIRED');
    expect(await c.leaseRows()).toBe(0);
    expect(c.registry.active()).toEqual([]);
    c.registry.lift();
    expect(await c.install()).toMatchObject({ status: 'installed' }); // the refusal left nothing wedged
  });

  it('bounded wait expiry keeps the lock, leaves the app usable and the held job finishes afterwards', async () => {
    const c = await setup();
    await c.install();
    let releaseRoleIo!: () => void;
    c.port.hooks.remove = () => new Promise<void>((resolve) => { releaseRoleIo = resolve; });
    const uninstall = c.svc.uninstall({ language: 'en', confirm: true }).then(() => 'ok', (e: { code?: string }) => `err:${e.code}`);
    await c.waitAlive();

    const error = (await prepareUpdateHandoff(c.deps({ jobSettleMs: 80 })).then(() => null, (e: unknown) => e)) as HandoffError;
    expect(error).toBeInstanceOf(HandoffError);
    expect(error.recoverable).toBe(true);
    expect(error.offerReload).toBe(true);
    expect(error.message).toMatch(/still finishing/i);
    expect(c.events).toEqual([]); // lock NOT released, worker NOT terminated
    expect(c.gate.closed).toBe(false);
    expect(c.registry.fenced).toBe(false); // lifted: Retry / normal use works

    releaseRoleIo();
    expect(await uninstall).toBe('ok');
    expect(await c.receipt()).toBe('absent');
    // Retry now succeeds.
    await prepareUpdateHandoff(c.deps());
    expect(c.events).toEqual(['worker-terminated', 'lock-released']);
  });

  it('an install still before its first durable effect is aborted (cancellable), then awaited; the lock is released afterwards', async () => {
    const c = await setup();
    c.port.manifestJson = FakeDiskPort.manifest(['en'], V1, HA);
    c.port.hold = new Promise<void>(() => undefined); // download that never finishes by itself; honours the abort signal
    const controller = new AbortController();
    const off = c.registry.registerCanceller('install', () => controller.abort());
    const install = c.svc.install('en', noop, controller.signal).then(() => 'ok', (e: { code?: string }) => `err:${e.code}`);
    await c.waitAlive();
    expect(c.registry.active()[0]?.durable).toBe(false);

    await prepareUpdateHandoff(c.deps());
    expect(await install).toBe('err:CANCELLED');
    expect(c.events).toEqual(['worker-terminated', 'lock-released']);
    expect(await c.receipt()).not.toBe('installed');
    expect(await c.leaseRows()).toBe(0);
    off();
  });

  it('an install that already has a durable effect is awaited, never aborted', async () => {
    const c = await setup();
    c.port.manifestJson = FakeDiskPort.manifest(['en'], V1, HA);
    let releaseActivate!: () => void;
    c.port.hooks['activate:start'] = () => new Promise<void>((resolve) => { releaseActivate = resolve; });
    let aborted = false;
    const controller = new AbortController();
    c.registry.registerCanceller('install', () => { aborted = true; controller.abort(); });
    const install = c.svc.install('en', noop, controller.signal).then(() => 'ok', (e: { code?: string }) => `err:${e.code}`);
    await c.waitAlive();
    for (let i = 0; i < 300 && !releaseActivate; i++) await sleep(10);
    c.registry.noteDurable(); // what the port's activate() does at its first role-moving call
    const handoff = prepareUpdateHandoff(c.deps()).then(() => 'handed-off');
    await sleep(100);
    expect(aborted).toBe(false);
    expect(c.events).toEqual([]);
    releaseActivate();
    expect(await install).toBe('ok');
    expect(await handoff).toBe('handed-off');
    expect(await c.receipt()).toBe('installed');
    expect(c.events).toEqual(['worker-terminated', 'lock-released']);
  });

  it('a stand-alone port operation is tracked and refused after the fence, an operation of an admitted job is allowed', async () => {
    const registry = createJobRegistry();
    registry.fence();
    await expect(registry.run('operation', async () => 1)).rejects.toMatchObject({ code: 'RETIRED' });
    registry.lift();
    let release!: () => void;
    const outer = registry.run('operation', () => new Promise<void>((resolve) => { release = resolve; }));
    registry.fence();
    await expect(registry.run('operation', async () => 'cleanup', { durable: true })).resolves.toBe('cleanup'); // a lease/op is alive: part of that job
    const result = registry.retire(1000);
    release();
    await outer;
    expect(await result).toMatchObject({ settled: true, remaining: [] });
  });
});
