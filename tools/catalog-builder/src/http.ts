import { mkdir, readFile, rename, writeFile } from 'node:fs/promises';
import { dirname } from 'node:path';

export class HttpError extends Error {
  constructor(readonly status: number, readonly url: string, message?: string) {
    super(message ?? `HTTP ${status} for ${url}`);
    this.name = 'HttpError';
  }
}

export interface FetcherStats {
  requests: number;
  cacheHits: number;
  retries: number;
  http429: number;
  http404: number;
  bytes: number;
}

export interface FetcherOptions {
  /** Starting (and maximum) concurrency. Default 8. */
  concurrency?: number;
  /** Retries after the first attempt; delays are 1 s, 2 s, 4 s (+ jitter). Default 3. */
  maxRetries?: number;
  /** Cache entries older than this are refetched. `Infinity` = always reuse (resume). Default 24 h. */
  maxCacheAgeMs?: number;
  userAgent?: string;
  fetchImpl?: typeof fetch;
  sleep?: (ms: number) => Promise<void>;
  /** 0..1 jitter source (injectable for tests). */
  random?: () => number;
  now?: () => number;
  onLog?: (message: string) => void;
}

interface CacheEnvelope<T> { fetchedAt: number; url: string; data: T }

const BACKOFF_MS = [1000, 2000, 4000];
const MAX_RETRY_AFTER_MS = 60_000;

/**
 * Plain-fetch HTTP client for the TCGdex crawl: bounded concurrency that halves on 429, exponential backoff
 * with jitter, Retry-After (capped at 60 s), and an on-disk JSON cache so reruns do not refetch.
 */
export class Fetcher {
  readonly stats: FetcherStats = { requests: 0, cacheHits: 0, retries: 0, http429: 0, http404: 0, bytes: 0 };
  private readonly maxConcurrency: number;
  private limit: number;
  private active = 0;
  private waiters: Array<() => void> = [];
  private successStreak = 0;
  private readonly opts: Required<Omit<FetcherOptions, 'concurrency' | 'onLog'>> & { onLog: (m: string) => void };

  constructor(options: FetcherOptions = {}) {
    this.maxConcurrency = options.concurrency ?? 8;
    this.limit = this.maxConcurrency;
    this.opts = {
      maxRetries: options.maxRetries ?? 3,
      maxCacheAgeMs: options.maxCacheAgeMs ?? 24 * 3600 * 1000,
      userAgent: options.userAgent ?? 'FlashyDex-catalog-builder/0.1 (+https://github.com/Flashyvevo/Flashydex)',
      fetchImpl: options.fetchImpl ?? fetch,
      sleep: options.sleep ?? ((ms) => new Promise((resolve) => setTimeout(resolve, ms))),
      random: options.random ?? Math.random,
      now: options.now ?? Date.now,
      onLog: options.onLog ?? (() => undefined)
    };
  }

  get currentConcurrency(): number { return this.limit; }

  private async acquire(): Promise<void> {
    while (this.active >= this.limit) await new Promise<void>((resolve) => this.waiters.push(resolve));
    this.active += 1;
  }

  private release(): void {
    this.active -= 1;
    this.waiters.shift()?.();
  }

  private noteSuccess(): void {
    this.successStreak += 1;
    if (this.limit < this.maxConcurrency && this.successStreak >= 50) {
      this.limit += 1; // recover slowly after a 429
      this.successStreak = 0;
    }
  }

  private note429(): void {
    this.stats.http429 += 1;
    this.successStreak = 0;
    const next = Math.max(1, Math.floor(this.limit / 2));
    if (next !== this.limit) this.opts.onLog(`429 received: concurrency ${this.limit} -> ${next}`);
    this.limit = next;
  }

  private retryDelay(attempt: number, retryAfter: string | null): number {
    let delay = BACKOFF_MS[Math.min(attempt, BACKOFF_MS.length - 1)]!;
    if (retryAfter) {
      const seconds = Number(retryAfter);
      const parsed = Number.isFinite(seconds) ? seconds * 1000 : Date.parse(retryAfter) - this.opts.now();
      if (Number.isFinite(parsed) && parsed > 0) delay = Math.min(parsed, MAX_RETRY_AFTER_MS);
    }
    return delay + Math.floor(this.opts.random() * 250);
  }

  /** One logical request with retries; returns the final Response (non-OK only for allowed statuses). */
  private async request(url: string, method: 'GET' | 'HEAD', acceptStatuses: readonly number[]): Promise<Response> {
    for (let attempt = 0; ; attempt += 1) {
      await this.acquire();
      let response: Response | undefined;
      let failure: unknown;
      try {
        this.stats.requests += 1;
        response = await this.opts.fetchImpl(url, { method, headers: { 'User-Agent': this.opts.userAgent, Accept: 'application/json' } });
      } catch (error) {
        failure = error;
      } finally {
        this.release();
      }
      if (response) {
        if (response.ok || acceptStatuses.includes(response.status)) {
          this.noteSuccess();
          return response;
        }
        if (response.status === 429) this.note429();
        const retryable = response.status === 429 || response.status >= 500;
        if (!retryable) {
          if (response.status === 404) this.stats.http404 += 1;
          throw new HttpError(response.status, url);
        }
        if (attempt >= this.opts.maxRetries) throw new HttpError(response.status, url, `HTTP ${response.status} for ${url} after ${attempt + 1} attempts`);
        this.stats.retries += 1;
        await this.opts.sleep(this.retryDelay(attempt, response.headers.get('retry-after')));
        continue;
      }
      if (attempt >= this.opts.maxRetries) {
        throw new Error(`Network failure for ${url} after ${attempt + 1} attempts: ${failure instanceof Error ? failure.message : String(failure)}`);
      }
      this.stats.retries += 1;
      await this.opts.sleep(this.retryDelay(attempt, null));
    }
  }

  async getJson<T>(url: string, cacheFile?: string): Promise<T> {
    if (cacheFile) {
      try {
        const envelope = JSON.parse(await readFile(cacheFile, 'utf8')) as CacheEnvelope<T>;
        if (this.opts.now() - envelope.fetchedAt <= this.opts.maxCacheAgeMs) {
          this.stats.cacheHits += 1;
          return envelope.data;
        }
      } catch { /* missing or unreadable cache entry: fetch */ }
    }
    const response = await this.request(url, 'GET', []);
    const text = await response.text();
    this.stats.bytes += text.length;
    const data = JSON.parse(text) as T;
    if (cacheFile) {
      await mkdir(dirname(cacheFile), { recursive: true });
      const temp = `${cacheFile}.${process.pid}.tmp`;
      await writeFile(temp, JSON.stringify({ fetchedAt: this.opts.now(), url, data } satisfies CacheEnvelope<T>));
      await rename(temp, cacheFile);
    }
    return data;
  }

  /** HEAD status (200/404/...), retried on 429/5xx. */
  async headStatus(url: string): Promise<number> {
    const response = await this.request(url, 'HEAD', [403, 404, 405]);
    return response.status;
  }
}

/** Bounded worker pool (limits open file handles for cache reads; network concurrency is gated by Fetcher). */
export async function pool<T, R>(items: readonly T[], size: number, mapper: (item: T, index: number) => Promise<R>): Promise<R[]> {
  const results = new Array<R>(items.length);
  let cursor = 0;
  await Promise.all(Array.from({ length: Math.min(size, items.length) }, async () => {
    for (;;) {
      const index = cursor++;
      if (index >= items.length) return;
      results[index] = await mapper(items[index]!, index);
    }
  }));
  return results;
}
