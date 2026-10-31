import { CapacitorHttp, type HttpOptions, type HttpResponse } from '@capacitor/core';
import { PlatformError } from '@flashydex/core';

export interface NativeHttpClient { get(options: HttpOptions): Promise<HttpResponse> }

/**
 * Metadata GET through the native HTTP stack (no WebView CORS). Mapping mirrors the fetch path:
 *  - timeoutMs -> connectTimeout + readTimeout; request headers passed through; response header names lowercased
 *  - 204/304 -> body null; non-JSON / unparseable body -> null
 *  - cancellation is best effort: the native call cannot be aborted, so after `signal` aborts (or the timeout fires) the caller
 *    gets HTTP_FAILED immediately and the late native response is discarded.
 */
export async function nativeHttpGet(
  client: NativeHttpClient,
  { url, headers, timeoutMs }: { url: string; headers?: Record<string, string>; timeoutMs: number },
  signal?: AbortSignal
): Promise<{ status: number; headers: Record<string, string>; body: unknown }> {
  if (signal?.aborted) throw new PlatformError('HTTP_FAILED', 'Cancelled');
  let timer: ReturnType<typeof setTimeout> | undefined;
  let onAbort: (() => void) | undefined;
  const stop = new Promise<never>((_, reject) => {
    timer = setTimeout(() => reject(new PlatformError('HTTP_FAILED', 'The request failed')), timeoutMs);
    onAbort = () => reject(new PlatformError('HTTP_FAILED', 'Cancelled'));
    signal?.addEventListener('abort', onAbort, { once: true });
  });
  stop.catch(() => undefined); // never an unhandled rejection when the request wins the race
  try {
    const request = client.get({ url, headers, connectTimeout: timeoutMs, readTimeout: timeoutMs, responseType: 'json' });
    request.catch(() => undefined); // a late failure after abort is discarded
    const response = await Promise.race([request, stop]);
    const out: Record<string, string> = {};
    for (const [key, value] of Object.entries(response.headers ?? {})) out[key.toLowerCase()] = String(value);
    let body: unknown = null;
    if (response.status !== 304 && response.status !== 204) {
      body = response.data ?? null;
      if (typeof body === 'string') {
        try { body = JSON.parse(body) as unknown; } catch { body = null; }
      }
    }
    return { status: response.status, headers: out, body };
  } catch (error) {
    if (error instanceof PlatformError) throw error;
    throw new PlatformError('HTTP_FAILED', signal?.aborted ? 'Cancelled' : 'The request failed');
  } finally {
    clearTimeout(timer);
    if (onAbort) signal?.removeEventListener('abort', onAbort);
  }
}

export const capacitorHttp: NativeHttpClient = CapacitorHttp;
