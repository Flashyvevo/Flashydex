import { SW_MESSAGES, type ImageCacheStats } from '../../web-storage/contract';
import type { ImageEngine } from './engine';

export interface AckMessage {
  type: typeof SW_MESSAGES.ack;
  v: 1;
  id: string;
  ok: boolean;
  stats?: ImageCacheStats;
  error?: string;
}

export interface ImageRequestMessage {
  type: typeof SW_MESSAGES.imageStats | typeof SW_MESSAGES.imageClear | typeof SW_MESSAGES.imageSetLimit;
  v: 1;
  id: string;
  /** imageSetLimit only. */
  bytes?: number;
}

const IMAGE_TYPES: readonly string[] = [SW_MESSAGES.imageStats, SW_MESSAGES.imageClear, SW_MESSAGES.imageSetLimit];

export function isImageMessage(data: unknown): boolean {
  return typeof data === 'object' && data !== null && IMAGE_TYPES.includes((data as { type?: unknown }).type as string);
}

/** Versioned request -> ACK. Returns null when `data` is not an image-cache message. Never throws. */
export async function handleImageMessage(engine: ImageEngine, data: unknown): Promise<AckMessage | null> {
  if (!isImageMessage(data)) return null;
  const msg = data as Partial<ImageRequestMessage>;
  const id = typeof msg.id === 'string' ? msg.id : '';
  const nack = (error: string): AckMessage => ({ type: SW_MESSAGES.ack, v: 1, id, ok: false, error });
  if (msg.v !== 1 || id === '') return nack('bad_request');
  try {
    if (msg.type === SW_MESSAGES.imageStats) return { type: SW_MESSAGES.ack, v: 1, id, ok: true, stats: await engine.stats() };
    if (msg.type === SW_MESSAGES.imageClear) return { type: SW_MESSAGES.ack, v: 1, id, ok: true, stats: await engine.clear() };
    if (typeof msg.bytes !== 'number' || !Number.isFinite(msg.bytes)) return nack('bad_request');
    return { type: SW_MESSAGES.ack, v: 1, id, ok: true, stats: await engine.setLimit(msg.bytes) };
  } catch (error) {
    return nack(error instanceof Error ? error.message : 'failed');
  }
}
