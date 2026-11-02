import { IMAGE_CACHE_LIMITS, SW_MESSAGES, type ImageCacheController, type ImageCacheStats } from '../web-storage/contract';
import type { AckMessage } from './image-cache/messages';
import type { PwaEnv } from './env';

export interface ImageControllerDeps {
  env?: Pick<PwaEnv, 'navigator'>;
  timeoutMs?: number;
  /** MessageChannel factory (tests inject a fake). */
  createChannel?: () => { port1: MessagePort | FakePort; port2: MessagePort | FakePort };
  newId?: () => string;
}

interface FakePort {
  onmessage: ((e: { data: unknown }) => void) | null;
  close?: () => void;
}

const unenforced = (reason: string, lastError: string | null = null): ImageCacheStats => ({
  enforced: false,
  limitBytes: IMAGE_CACHE_LIMITS.default,
  committedBytes: 0,
  reservedBytes: 0,
  entries: 0,
  lastError,
  reason
});

/** Talks to the SW's byte ledger. No controlling SW (dev, first load, unsupported) -> honest `enforced:false`; never pretends. */
export function createImageCacheController(deps: ImageControllerDeps = {}): ImageCacheController {
  const nav = () => (deps.env ? deps.env.navigator : typeof navigator === 'undefined' ? undefined : (navigator as PwaEnv['navigator']));
  const timeoutMs = deps.timeoutMs ?? 5000;
  const createChannel = deps.createChannel ?? (() => new MessageChannel());
  const newId = deps.newId ?? (() => `${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 10)}`);

  async function ask(type: string, extra: Record<string, unknown> = {}): Promise<ImageCacheStats> {
    const sw = nav()?.serviceWorker;
    if (!sw) return unenforced('unsupported');
    const controller = sw.controller;
    if (!controller) return unenforced('no_service_worker');
    const id = newId();
    const channel = createChannel();
    return new Promise<ImageCacheStats>((resolve) => {
      const done = (stats: ImageCacheStats) => {
        clearTimeout(timer);
        channel.port1.onmessage = null;
        resolve(stats);
      };
      const timer = setTimeout(() => done(unenforced('sw_timeout', 'The service worker did not answer')), timeoutMs);
      channel.port1.onmessage = (event: { data: unknown }) => {
        const ack = event.data as Partial<AckMessage> | null;
        if (!ack || ack.type !== SW_MESSAGES.ack || ack.id !== id) return;
        if (ack.ok && ack.stats) done(ack.stats);
        else done(unenforced('sw_error', ack.error ?? 'failed'));
      };
      try {
        controller.postMessage({ type, v: 1, id, ...extra }, [channel.port2 as MessagePort]);
      } catch (e) {
        done(unenforced('sw_error', e instanceof Error ? e.message : 'postMessage failed'));
      }
    });
  }

  return {
    stats: () => ask(SW_MESSAGES.imageStats),
    clear: () => ask(SW_MESSAGES.imageClear),
    setLimit: (bytes) => ask(SW_MESSAGES.imageSetLimit, { bytes: Math.min(IMAGE_CACHE_LIMITS.max, Math.max(IMAGE_CACHE_LIMITS.min, Math.floor(bytes))) })
  };
}
