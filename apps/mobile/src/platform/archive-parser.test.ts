import { describe, expect, it } from 'vitest';
import { FDX_DEFAULT_LIMITS } from '@flashydex/core';
import { createArchiveParser, type WorkerLike } from './archive-parser';
import { handleArchiveRequest, type ArchiveWorkerRequest, type ArchiveWorkerResponse } from './archive-worker-core';

/** N04: worker client behaviour (handshake, fallback, transfer, cancel, errors) with a fake Worker; the handler itself runs for real. */
const garbage = () => new Uint8Array(64).fill(7);

type Script = { pong?: boolean; startupError?: boolean; crashOnParse?: boolean; hang?: boolean; reply?: (r: ArchiveWorkerRequest) => Promise<ArchiveWorkerResponse> };
function fakeWorker(script: Script = {}) {
  const log: { terminated: number; transferred: number; messages: string[] } = { terminated: 0, transferred: 0, messages: [] };
  const worker: WorkerLike = {
    onmessage: null, onerror: null, onmessageerror: null,
    terminate() { log.terminated += 1; },
    postMessage(message, transfer) {
      log.messages.push(message.type);
      if (transfer?.length) log.transferred += 1;
      queueMicrotask(async () => {
        if (script.startupError && message.type === 'ping') { worker.onerror?.(new Error('boom')); return; }
        if (script.hang && message.type === 'ping') return;
        if (message.type === 'ping') { if (script.pong !== false) worker.onmessage?.({ data: { type: 'pong' } }); else worker.onmessage?.({ data: { type: 'result', parsed: {} as never } }); return; }
        if (script.crashOnParse) { worker.onerror?.(new Error('oom')); return; }
        const response = script.reply ? await script.reply(message) : await handleArchiveRequest(message);
        worker.onmessage?.({ data: response });
      });
    }
  };
  return { worker, log };
}

describe('N04 archive worker client', () => {
  it('runs the real handler in the worker: an invalid file rejects with the same typed BACKUP_INVALID, the buffer is transferred, the worker is terminated', async () => {
    const f = fakeWorker();
    const parse = createArchiveParser({ createWorker: () => f.worker });
    await expect(parse({ bytes: garbage(), limits: { ...FDX_DEFAULT_LIMITS } })).rejects.toMatchObject({ code: 'BACKUP_INVALID' });
    expect(f.log.messages).toEqual(['ping', 'parse']);
    expect(f.log.transferred).toBe(1);
    expect(f.log.terminated).toBe(1);
  });

  it('forwards typed worker errors (SIZE_LIMIT keeps its code and message)', async () => {
    const f = fakeWorker({ reply: async (r) => (r.type === 'parse' ? { type: 'error', code: 'SIZE_LIMIT', message: 'too big' } : { type: 'pong' }) });
    const parse = createArchiveParser({ createWorker: () => f.worker });
    await expect(parse({ bytes: garbage(), limits: { ...FDX_DEFAULT_LIMITS } })).rejects.toMatchObject({ code: 'SIZE_LIMIT', message: 'too big' });
  });

  it('resolves the parsed backup from the worker result', async () => {
    const parsed = { manifest: {}, entities: {}, settings: {}, images: new Map() } as never;
    const f = fakeWorker({ reply: async () => ({ type: 'result', parsed }) });
    const parse = createArchiveParser({ createWorker: () => f.worker });
    await expect(parse({ bytes: garbage(), limits: { ...FDX_DEFAULT_LIMITS } })).resolves.toBe(parsed);
  });

  it('fallback: no Worker available -> parses in-thread (same typed error)', async () => {
    const parse = createArchiveParser({ createWorker: () => null });
    await expect(parse({ bytes: garbage(), limits: { ...FDX_DEFAULT_LIMITS } })).rejects.toMatchObject({ code: 'BACKUP_INVALID' });
  });

  it('fallback: worker constructor throws -> in-thread', async () => {
    const parse = createArchiveParser({ createWorker: () => { throw new Error('CSP blocks workers'); } });
    await expect(parse({ bytes: garbage(), limits: { ...FDX_DEFAULT_LIMITS } })).rejects.toMatchObject({ code: 'BACKUP_INVALID' });
  });

  it('fallback: worker fails at startup -> in-thread with the caller\'s bytes intact (nothing transferred)', async () => {
    const f = fakeWorker({ startupError: true });
    const parse = createArchiveParser({ createWorker: () => f.worker });
    await expect(parse({ bytes: garbage(), limits: { ...FDX_DEFAULT_LIMITS } })).rejects.toMatchObject({ code: 'BACKUP_INVALID' });
    expect(f.log.transferred).toBe(0);
    expect(f.log.terminated).toBe(1);
  });

  it('fallback: no handshake within the timeout -> in-thread, worker terminated', async () => {
    const f = fakeWorker({ hang: true });
    const parse = createArchiveParser({ createWorker: () => f.worker, handshakeMs: 20 });
    await expect(parse({ bytes: garbage(), limits: { ...FDX_DEFAULT_LIMITS } })).rejects.toMatchObject({ code: 'BACKUP_INVALID' });
    expect(f.log.transferred).toBe(0);
    expect(f.log.terminated).toBe(1);
  });

  it('a worker crash after the bytes were handed over is a typed BACKUP_INVALID (no silent re-parse on the UI thread)', async () => {
    const f = fakeWorker({ crashOnParse: true });
    const parse = createArchiveParser({ createWorker: () => f.worker });
    await expect(parse({ bytes: garbage(), limits: { ...FDX_DEFAULT_LIMITS } })).rejects.toMatchObject({ code: 'BACKUP_INVALID', message: expect.stringMatching(/could not be processed/) });
    expect(f.log.terminated).toBe(1);
  });

  it('cancel: aborting while the worker is parsing terminates it at once and rejects CANCELLED', async () => {
    const controller = new AbortController();
    const f = fakeWorker({ reply: () => new Promise<never>(() => undefined) });
    const parse = createArchiveParser({ createWorker: () => f.worker });
    const pending = parse({ bytes: garbage(), limits: { ...FDX_DEFAULT_LIMITS }, signal: controller.signal });
    await new Promise((r) => setTimeout(r, 10));
    controller.abort();
    await expect(pending).rejects.toMatchObject({ code: 'CANCELLED' });
    expect(f.log.terminated).toBe(1);
  });

  it('cancel: an already-aborted signal never creates a worker', async () => {
    let created = 0;
    const controller = new AbortController();
    controller.abort();
    const parse = createArchiveParser({ createWorker: () => { created += 1; return fakeWorker().worker; } });
    await expect(parse({ bytes: garbage(), limits: { ...FDX_DEFAULT_LIMITS }, signal: controller.signal })).rejects.toMatchObject({ code: 'CANCELLED' });
    expect(created).toBe(0);
  });
});
