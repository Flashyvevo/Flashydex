import type { HttpOptions, HttpResponse } from '@capacitor/core';
import { describe, expect, it, vi } from 'vitest';
import { nativeHttpGet, type NativeHttpClient } from './native-http';

const client = (impl: (o: HttpOptions) => Promise<Partial<HttpResponse>>): NativeHttpClient & { get: ReturnType<typeof vi.fn> } => ({
  get: vi.fn(async (o: HttpOptions) => ({ status: 200, url: o.url, headers: {}, data: null, ...(await impl(o)) }) as HttpResponse)
});

describe('nativeHttpGet', () => {
  it('maps timeout and headers, lowercases response headers and returns the JSON body', async () => {
    const c = client(async () => ({ status: 200, headers: { ETag: '"a"', 'Content-Type': 'application/json' }, data: { ok: true } }));
    const r = await nativeHttpGet(c, { url: 'https://x.test/m.json', headers: { 'If-None-Match': '"a"' }, timeoutMs: 1234 });
    expect(c.get).toHaveBeenCalledWith({ url: 'https://x.test/m.json', headers: { 'If-None-Match': '"a"' }, connectTimeout: 1234, readTimeout: 1234, responseType: 'json' });
    expect(r).toEqual({ status: 200, headers: { etag: '"a"', 'content-type': 'application/json' }, body: { ok: true } });
  });

  it('304 and 204 carry no body even if the plugin returns data', async () => {
    for (const status of [304, 204]) {
      const r = await nativeHttpGet(client(async () => ({ status, data: { stale: 1 } })), { url: 'https://x.test/', timeoutMs: 1000 });
      expect(r.body).toBeNull();
      expect(r.status).toBe(status);
    }
  });

  it('parses a string body, and maps an unparseable one to null', async () => {
    expect((await nativeHttpGet(client(async () => ({ data: '{"a":1}' })), { url: 'https://x.test/', timeoutMs: 1000 })).body).toEqual({ a: 1 });
    expect((await nativeHttpGet(client(async () => ({ data: '<html>' })), { url: 'https://x.test/', timeoutMs: 1000 })).body).toBeNull();
  });

  it('maps a plugin failure to HTTP_FAILED', async () => {
    const c: NativeHttpClient = { get: () => Promise.reject(new Error('offline')) };
    await expect(nativeHttpGet(c, { url: 'https://x.test/', timeoutMs: 1000 })).rejects.toMatchObject({ code: 'HTTP_FAILED' });
  });

  it('abort rejects immediately as Cancelled and the late native response is discarded', async () => {
    let resolveLate!: (r: HttpResponse) => void;
    const c: NativeHttpClient = { get: () => new Promise<HttpResponse>((res) => { resolveLate = res; }) };
    const controller = new AbortController();
    const pending = nativeHttpGet(c, { url: 'https://x.test/', timeoutMs: 60_000 }, controller.signal);
    controller.abort();
    await expect(pending).rejects.toMatchObject({ code: 'HTTP_FAILED', message: 'Cancelled' });
    resolveLate({ status: 200, url: '', headers: {}, data: {} }); // must not throw or surface anywhere
    await Promise.resolve();
    await expect(nativeHttpGet(c, { url: 'https://x.test/', timeoutMs: 1000 }, controller.signal)).rejects.toMatchObject({ message: 'Cancelled' });
  });

  it('times out when the native call hangs', async () => {
    vi.useFakeTimers();
    try {
      const c: NativeHttpClient = { get: () => new Promise<HttpResponse>(() => undefined) };
      const pending = nativeHttpGet(c, { url: 'https://x.test/', timeoutMs: 500 });
      const assertion = expect(pending).rejects.toMatchObject({ code: 'HTTP_FAILED' });
      await vi.advanceTimersByTimeAsync(600);
      await assertion;
    } finally {
      vi.useRealTimers();
    }
  });
});
