// @vitest-environment node
import { describe, expect, it, vi } from 'vitest';
import type { PwaEnv } from './env';
import { createStorageProtection, PROTECTION_STORAGE_KEY } from './protection';
import { createInstallController, detectPlatform, INSTALL_DISMISSED_KEY } from './install';
import { createUpdateController } from './update';
import { createImageCacheController } from './image-controller';
import { PROTECTION_COPY } from './copy';

function memoryStorage(initial: Record<string, string> = {}) {
  const m = new Map(Object.entries(initial));
  return { getItem: (k: string) => m.get(k) ?? null, setItem: (k: string, v: string) => void m.set(k, v), removeItem: (k: string) => void m.delete(k), m };
}

function makeEnv(input: Partial<Omit<PwaEnv, 'now'>> & { standalone?: boolean; now?: Date } = {}): PwaEnv & { fire(type: string, e?: Event): void } {
  const { standalone, now, ...rest } = input;
  const over = { standalone };
  const listeners = new Map<string, ((e: Event) => void)[]>();
  const docListeners = new Map<string, (() => void)[]>();
  const env = {
    navigator: { userAgent: 'Mozilla/5.0 (X11; Linux x86_64) Chrome/120', platform: 'Linux x86_64', maxTouchPoints: 0 },
    localStorage: memoryStorage(),
    document: {
      visibilityState: 'visible',
      addEventListener: (t: string, l: () => void) => docListeners.set(t, [...(docListeners.get(t) ?? []), l])
    } as unknown as PwaEnv['document'],
    window: {
      addEventListener: (t: string, l: (e: Event) => void) => listeners.set(t, [...(listeners.get(t) ?? []), l]),
      matchMedia: () => ({ matches: over.standalone === true })
    },
    now: () => now ?? new Date('2026-10-31T12:00:00Z'),
    reload: vi.fn(),
    isProd: true,
    ...rest,
    fire(type: string, e: Event = new Event(type)) {
      for (const l of listeners.get(type) ?? []) l(e);
    },
    fireDoc(type: string) {
      for (const l of docListeners.get(type) ?? []) l();
    }
  };
  return env as unknown as PwaEnv & { fire(type: string, e?: Event): void; fireDoc(type: string): void };
}

describe('storageProtection', () => {
  const nav = (storage: Record<string, unknown> | undefined) => ({ userAgent: 'x', storage }) as PwaEnv['navigator'];

  it('check(): persisted true -> granted with usage/quota; never calls persist()', async () => {
    const persist = vi.fn();
    const env = makeEnv({ navigator: nav({ persisted: async () => true, persist, estimate: async () => ({ usage: 5, quota: 50 }) }) });
    const s = await createStorageProtection(env).check();
    expect(s).toMatchObject({ persist: 'granted', usageBytes: 5, quotaBytes: 50, requested: false });
    expect(s.checkedAt).toBe('2026-10-31T12:00:00.000Z');
    expect(persist).not.toHaveBeenCalled();
  });

  it('persisted false -> best-effort; rejection -> check-failed; missing API -> unavailable', async () => {
    expect((await createStorageProtection(makeEnv({ navigator: nav({ persisted: async () => false }) })).check()).persist).toBe('best-effort');
    expect((await createStorageProtection(makeEnv({ navigator: nav({ persisted: async () => Promise.reject(new Error('x')) }) })).check()).persist).toBe('check-failed');
    const missing = await createStorageProtection(makeEnv({ navigator: nav(undefined) })).check();
    expect(missing).toMatchObject({ persist: 'unavailable', usageBytes: null, quotaBytes: null });
  });

  it('estimate rejection alone does not flip the persist state', async () => {
    const s = await createStorageProtection(makeEnv({ navigator: nav({ persisted: async () => true, estimate: async () => Promise.reject(new Error('x')) }) })).check();
    expect(s).toMatchObject({ persist: 'granted', usageBytes: null });
  });

  it('request(): persisted false -> persist() -> re-check reports the real outcome (denied stays best-effort)', async () => {
    const persist = vi.fn(async () => false);
    const env = makeEnv({ navigator: nav({ persisted: async () => false, persist }) });
    const s = await createStorageProtection(env).request();
    expect(persist).toHaveBeenCalledTimes(1);
    expect(s).toMatchObject({ persist: 'best-effort', requested: true });
  });

  it('request(): grant is only reported after persisted() says so', async () => {
    let granted = false;
    const env = makeEnv({ navigator: nav({ persisted: async () => granted, persist: async () => ((granted = true), true) }) });
    expect((await createStorageProtection(env).request()).persist).toBe('granted');
  });

  it('request(): already persisted -> no persist() call; persist() rejection -> check-failed; missing persist -> unavailable', async () => {
    const persist = vi.fn();
    expect((await createStorageProtection(makeEnv({ navigator: nav({ persisted: async () => true, persist }) })).request()).persist).toBe('granted');
    expect(persist).not.toHaveBeenCalled();
    const rej = await createStorageProtection(makeEnv({ navigator: nav({ persisted: async () => false, persist: async () => Promise.reject(new Error('no')) }) })).request();
    expect(rej).toMatchObject({ persist: 'check-failed', requested: true });
    expect((await createStorageProtection(makeEnv({ navigator: nav({ persisted: async () => false }) })).request()).persist).toBe('unavailable');
    expect((await createStorageProtection(makeEnv({ navigator: nav(undefined) })).request()).requested).toBe(true);
  });

  it('persists the last snapshot + requested flag and notifies subscribers', async () => {
    const ls = memoryStorage();
    const env = makeEnv({ localStorage: ls, navigator: nav({ persisted: async () => false, persist: async () => false }) });
    const a = createStorageProtection(env);
    const seen: string[] = [];
    const off = a.subscribe((s) => seen.push(s.persist));
    await a.request();
    expect(seen.length).toBeGreaterThan(0);
    off();
    expect(JSON.parse(ls.m.get(PROTECTION_STORAGE_KEY)!).snapshot.requested).toBe(true);
    const b = createStorageProtection(makeEnv({ localStorage: ls, navigator: nav({}) }));
    expect(b.getSnapshot()).toMatchObject({ requested: true, persist: 'best-effort' });
  });

  it('ignores corrupt stored state', () => {
    const ls = memoryStorage({ [PROTECTION_STORAGE_KEY]: '{not json' });
    expect(createStorageProtection(makeEnv({ localStorage: ls, navigator: nav({}) })).getSnapshot().checkedAt).toBeNull();
  });

  it('rechecks on visibilitychange only when standalone', async () => {
    const persisted = vi.fn(async () => true);
    const standalone = makeEnv({ standalone: true, navigator: nav({ persisted }) });
    createStorageProtection(standalone).subscribe(() => undefined);
    (standalone as unknown as { fireDoc(t: string): void }).fireDoc('visibilitychange');
    await new Promise((r) => setTimeout(r, 5));
    expect(persisted).toHaveBeenCalledTimes(1);
    const tab = makeEnv({ standalone: false, navigator: nav({ persisted }) });
    createStorageProtection(tab).subscribe(() => undefined);
    (tab as unknown as { fireDoc(t: string): void }).fireDoc('visibilitychange');
    await new Promise((r) => setTimeout(r, 5));
    expect(persisted).toHaveBeenCalledTimes(1);
  });

  it('copy names seven days of Safari use, backups, private mode, and never claims a prompt was accepted', () => {
    const text = [PROTECTION_COPY.intro, ...PROTECTION_COPY.bullets].join(' ');
    expect(text).toMatch(/seven days of Safari use/i);
    expect(text).toMatch(/backup/i);
    expect(text).toMatch(/private browsing/i);
    expect(text).not.toMatch(/accepted/i);
  });
});

describe('installController', () => {
  const IOS = 'Mozilla/5.0 (iPhone; CPU iPhone OS 17_0 like Mac OS X) AppleWebKit/605.1.15 Safari/604.1';
  const ANDROID = 'Mozilla/5.0 (Linux; Android 14; Pixel 8) Chrome/120 Mobile Safari/537.36';

  it('detects platforms incl. iPadOS desktop UA with touch', () => {
    expect(detectPlatform({ userAgent: IOS })).toBe('ios');
    expect(detectPlatform({ userAgent: 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) Safari', platform: 'MacIntel', maxTouchPoints: 5 })).toBe('ios');
    expect(detectPlatform({ userAgent: 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) Safari', platform: 'MacIntel', maxTouchPoints: 0 })).toBe('desktop');
    expect(detectPlatform({ userAgent: ANDROID })).toBe('android');
    expect(detectPlatform({ userAgent: 'Windows NT 10' })).toBe('desktop');
    expect(detectPlatform({ userAgent: 'weird' })).toBe('other');
  });

  it('iOS: banner shown (instructions), never canPrompt; hidden when standalone via matchMedia or navigator.standalone', () => {
    const ios = createInstallController(makeEnv({ navigator: { userAgent: IOS } }));
    expect(ios.getState()).toMatchObject({ platform: 'ios', canPrompt: false, showBanner: true, standalone: false });
    expect(createInstallController(makeEnv({ standalone: true, navigator: { userAgent: IOS } })).getState()).toMatchObject({ standalone: true, showBanner: false });
    expect(createInstallController(makeEnv({ navigator: { userAgent: IOS, standalone: true } })).getState()).toMatchObject({ standalone: true, showBanner: false });
  });

  it('captures beforeinstallprompt (preventDefault) -> canPrompt; prompt accepted/dismissed; single use', async () => {
    const env = makeEnv({ navigator: { userAgent: ANDROID } });
    const c = createInstallController(env);
    c.start();
    c.start(); // idempotent
    const states: boolean[] = [];
    c.subscribe((s) => states.push(s.canPrompt));
    expect(await c.prompt()).toBe('unavailable');
    const ev = Object.assign(new Event('beforeinstallprompt', { cancelable: true }), { prompt: vi.fn(async () => undefined), userChoice: Promise.resolve({ outcome: 'dismissed' as const }) });
    env.fire('beforeinstallprompt', ev);
    expect(ev.defaultPrevented).toBe(true);
    expect(c.getState()).toMatchObject({ canPrompt: true, showBanner: true });
    expect(await c.prompt()).toBe('dismissed');
    expect(ev.prompt).toHaveBeenCalledTimes(1);
    expect(c.getState()).toMatchObject({ canPrompt: false, showBanner: false });
    expect(c.getState().dismissedAt).toBe('2026-10-31T12:00:00.000Z');
    expect(await c.prompt()).toBe('unavailable');
  });

  it('android without a captured event still shows menu instructions; appinstalled hides it', () => {
    const env = makeEnv({ navigator: { userAgent: ANDROID } });
    const c = createInstallController(env);
    c.start();
    expect(c.getState()).toMatchObject({ canPrompt: false, showBanner: true });
    env.fire('appinstalled');
    expect(c.getState()).toMatchObject({ standalone: true, showBanner: false });
  });

  it('desktop shows a banner only with a captured prompt', () => {
    const env = makeEnv({ navigator: { userAgent: 'X11; Linux x86_64' } });
    const c = createInstallController(env);
    c.start();
    expect(c.getState().showBanner).toBe(false);
    env.fire('beforeinstallprompt', Object.assign(new Event('beforeinstallprompt'), { prompt: async () => undefined, userChoice: Promise.resolve({ outcome: 'accepted' as const }) }));
    expect(c.getState().showBanner).toBe(true);
  });

  it('dismissal snoozes for 14 days with a stored timestamp', () => {
    const ls = memoryStorage();
    const t0 = new Date('2026-10-31T12:00:00Z');
    const c0 = createInstallController(makeEnv({ localStorage: ls, now: t0, navigator: { userAgent: IOS } }));
    c0.dismiss();
    expect(ls.m.get(INSTALL_DISMISSED_KEY)).toBe(t0.toISOString());
    expect(c0.getState().showBanner).toBe(false);
    const day13 = new Date(t0.getTime() + 13 * 86_400_000);
    expect(createInstallController(makeEnv({ localStorage: ls, now: day13, navigator: { userAgent: IOS } })).getState().showBanner).toBe(false);
    const day15 = new Date(t0.getTime() + 15 * 86_400_000);
    expect(createInstallController(makeEnv({ localStorage: ls, now: day15, navigator: { userAgent: IOS } })).getState().showBanner).toBe(true);
  });
});

describe('updateController', () => {
  function swEnv(opts: { isProd?: boolean; waiting?: boolean; controller?: boolean } = {}) {
    const listeners: (() => void)[] = [];
    const waiting = { postMessage: vi.fn() };
    const env = makeEnv({ isProd: opts.isProd ?? true });
    (env as { navigator: unknown }).navigator = {
      userAgent: 'x',
      serviceWorker: {
        controller: opts.controller === false ? null : {},
        addEventListener: (_t: string, l: () => void) => listeners.push(l),
        removeEventListener: (_t: string, l: () => void) => void listeners.splice(listeners.indexOf(l), 1),
        getRegistration: async () => ({ waiting: opts.waiting === false ? null : waiting })
      }
    };
    return { env, waiting, listeners, controllerchange: () => [...listeners].forEach((l) => l()) };
  }
  function registerStub() {
    const handlers: Record<string, (...a: unknown[]) => void> = {};
    const registerSW = vi.fn((o: Record<string, (...a: unknown[]) => void>) => {
      Object.assign(handlers, o);
      return async () => undefined;
    });
    return { registerSW, handlers, load: async () => ({ registerSW: registerSW as never }) };
  }

  it('dev: never loads the virtual module, registered stays false', async () => {
    const { env } = swEnv({ isProd: false });
    const load = vi.fn();
    const c = createUpdateController({ env, loadRegister: load as never });
    c.register();
    await Promise.resolve();
    expect(load).not.toHaveBeenCalled();
    expect(c.getState()).toMatchObject({ registered: false, needRefresh: false });
  });

  it('prod: registers with immediate:true; callbacks drive state', async () => {
    const { env } = swEnv();
    const stub = registerStub();
    const c = createUpdateController({ env, loadRegister: stub.load });
    c.register();
    c.register(); // idempotent
    await vi.waitFor(() => expect(stub.registerSW).toHaveBeenCalledTimes(1));
    expect(stub.registerSW.mock.calls[0]![0]).toMatchObject({ immediate: true });
    stub.handlers.onRegisteredSW!('/sw.js', { waiting: null });
    stub.handlers.onOfflineReady!();
    stub.handlers.onNeedRefresh!();
    expect(c.getState()).toMatchObject({ registered: true, offlineReady: true, needRefresh: true });
    stub.handlers.onRegisterError!(new Error('boom'));
    expect(c.getState().error).toBe('boom');
    c.later();
    expect(c.getState().needRefresh).toBe(false);
  });

  it('apply: prepare first, then skip-waiting message, then exactly one reload', async () => {
    const { env, waiting, controllerchange } = swEnv();
    const order: string[] = [];
    waiting.postMessage.mockImplementation(() => order.push('post'));
    const stub = registerStub();
    const c = createUpdateController({ env, loadRegister: stub.load });
    c.register();
    await vi.waitFor(() => expect(stub.registerSW).toHaveBeenCalled());
    stub.handlers.onRegisteredSW!('/sw.js', { waiting });
    const done = c.applyUpdate(async () => void order.push('prepare'));
    await vi.waitFor(() => expect(waiting.postMessage).toHaveBeenCalled());
    expect(order).toEqual(['prepare', 'post']);
    expect(waiting.postMessage).toHaveBeenCalledWith({ type: 'SKIP_WAITING' });
    expect(c.getState().applying).toBe(true);
    expect(env.reload).not.toHaveBeenCalled();
    controllerchange();
    controllerchange();
    await done;
    expect(env.reload).toHaveBeenCalledTimes(1);
  });

  it('prepare throws: nothing activates, error is set, no reload', async () => {
    const { env, waiting, controllerchange } = swEnv();
    const c = createUpdateController({ env, loadRegister: registerStub().load });
    await c.applyUpdate(async () => Promise.reject(new Error('unsaved edits')));
    expect(waiting.postMessage).not.toHaveBeenCalled();
    controllerchange();
    expect(env.reload).not.toHaveBeenCalled();
    expect(c.getState()).toMatchObject({ applying: false, error: 'unsaved edits' });
  });

  it('no waiting worker: reports an error, does not reload', async () => {
    const { env } = swEnv({ waiting: false });
    const c = createUpdateController({ env, loadRegister: registerStub().load });
    await c.applyUpdate(async () => undefined);
    expect(c.getState()).toMatchObject({ applying: false, error: 'No update is waiting' });
    expect(env.reload).not.toHaveBeenCalled();
  });

  it('activation timeout leaves the app usable with an error', async () => {
    const { env } = swEnv();
    const c = createUpdateController({ env, loadRegister: registerStub().load, activationTimeoutMs: 10 });
    await c.applyUpdate(async () => undefined);
    expect(c.getState()).toMatchObject({ applying: false, error: 'The update did not activate' });
    expect(env.reload).not.toHaveBeenCalled();
  });

  it('a controllerchange caused by ANOTHER tab reloads this one once; first-install claim does not', async () => {
    const claimed = swEnv({ controller: false });
    const s1 = registerStub();
    createUpdateController({ env: claimed.env, loadRegister: s1.load }).register();
    await vi.waitFor(() => expect(s1.registerSW).toHaveBeenCalled());
    claimed.controllerchange();
    expect(claimed.env.reload).not.toHaveBeenCalled();

    const other = swEnv();
    const s2 = registerStub();
    createUpdateController({ env: other.env, loadRegister: s2.load }).register();
    await vi.waitFor(() => expect(s2.registerSW).toHaveBeenCalled());
    other.controllerchange();
    other.controllerchange();
    expect(other.env.reload).toHaveBeenCalledTimes(1);
  });
});

describe('imageCache controller', () => {
  function fakeChannel() {
    const port1 = { onmessage: null as ((e: { data: unknown }) => void) | null };
    return { port1, port2: {} as never };
  }
  it('no SW controller -> enforced:false / no_service_worker (clear is not faked either)', async () => {
    const c = createImageCacheController({ env: { navigator: { serviceWorker: { controller: null } } as never } });
    expect(await c.stats()).toMatchObject({ enforced: false, reason: 'no_service_worker' });
    expect(await c.clear()).toMatchObject({ enforced: false, reason: 'no_service_worker' });
    const unsupported = createImageCacheController({ env: { navigator: {} as never } });
    expect((await unsupported.stats()).reason).toBe('unsupported');
  });

  it('posts a versioned request with a MessagePort and resolves from the ACK', async () => {
    const channel = fakeChannel();
    const post = vi.fn((msg: { id: string }) => {
      channel.port1.onmessage?.({ data: { type: 'fdx:ack', v: 1, id: msg.id, ok: true, stats: { enforced: true, limitBytes: 150_000_000, committedBytes: 1, reservedBytes: 0, entries: 1, lastError: null, reason: null } } });
    });
    const c = createImageCacheController({ env: { navigator: { serviceWorker: { controller: { postMessage: post } } } as never }, createChannel: () => channel, newId: () => 'id1' });
    const s = await c.setLimit(1);
    expect(post.mock.calls[0]![0]).toEqual({ type: 'fdx:image-cache:set-limit', v: 1, id: 'id1', bytes: 150_000_000 }); // clamped client-side too
    expect(s.enforced).toBe(true);
  });

  it('ignores ACKs with another id; times out honestly; reports nack', async () => {
    const channel = fakeChannel();
    const c = createImageCacheController({
      env: { navigator: { serviceWorker: { controller: { postMessage: () => channel.port1.onmessage?.({ data: { type: 'fdx:ack', v: 1, id: 'other', ok: true } }) } } } as never },
      createChannel: () => channel,
      newId: () => 'mine',
      timeoutMs: 20
    });
    expect(await c.stats()).toMatchObject({ enforced: false, reason: 'sw_timeout' });
    const nack = createImageCacheController({
      env: { navigator: { serviceWorker: { controller: { postMessage: (m: { id: string }) => channel.port1.onmessage?.({ data: { type: 'fdx:ack', v: 1, id: m.id, ok: false, error: 'bad_request' } }) } } } as never },
      createChannel: () => channel
    });
    expect(await nack.stats()).toMatchObject({ enforced: false, reason: 'sw_error', lastError: 'bad_request' });
  });
});
