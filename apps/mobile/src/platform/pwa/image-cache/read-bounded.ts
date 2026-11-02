/** Result of a counted, capped read of a response body. */
export type BoundedRead = { ok: true; body: Uint8Array } | { ok: false; reason: 'oversized' | 'unreadable' };

/**
 * Reads at most `cap` bytes from `response.body` by COUNTING chunks (Content-Length is ignored: it can be missing or a lie).
 * Stops and cancels the stream the moment the cap is exceeded. The caller must pass a clone when the original goes to the page.
 */
export async function readBounded(response: Response, cap: number): Promise<BoundedRead> {
  const stream = response.body;
  if (!stream) return { ok: true, body: new Uint8Array(0) };
  const reader = stream.getReader();
  const chunks: Uint8Array[] = [];
  let total = 0;
  try {
    for (;;) {
      const { done, value } = await reader.read();
      if (done) break;
      total += value.byteLength;
      if (total > cap) {
        void reader.cancel().catch(() => undefined); // NOT awaited: on a tee'd clone the cancel promise waits for the other branch
        return { ok: false, reason: 'oversized' };
      }
      chunks.push(value);
    }
  } catch {
    return { ok: false, reason: 'unreadable' };
  }
  const body = new Uint8Array(total);
  let offset = 0;
  for (const chunk of chunks) {
    body.set(chunk, offset);
    offset += chunk.byteLength;
  }
  return { ok: true, body };
}
