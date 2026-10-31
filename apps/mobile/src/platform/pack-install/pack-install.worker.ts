/// <reference lib="webworker" />
import { Decompress } from 'fzstd';
import { createSHA256 } from 'hash-wasm';

type StartMessage = { type: 'start'; url: string };
type CancelMessage = { type: 'cancel' };
type Incoming = StartMessage | CancelMessage;

let controller: AbortController | undefined;

function post(message: Record<string, unknown>, transfer?: Transferable[]): void {
  self.postMessage(message, transfer ?? []);
}

self.addEventListener('message', (event: MessageEvent<Incoming>) => {
  if (event.data.type === 'cancel') controller?.abort();
  if (event.data.type === 'start') void install(event.data.url);
});

async function install(url: string): Promise<void> {
  controller = new AbortController();
  try {
    const response = await fetch(url, { signal: controller.signal });
    if (!response.ok || !response.body) throw new Error(`Pack download failed: ${response.status} ${response.statusText}`);
    const totalBytes = Number(response.headers.get('content-length')) || null;
    const hasher = await createSHA256();
    hasher.init();
    let compressedBytes = 0;
    let uncompressedBytes = 0;
    const decoder = new Decompress((chunk, final) => {
      hasher.update(chunk);
      uncompressedBytes += chunk.byteLength;
      post({ type: 'chunk', chunk: chunk.buffer, final, uncompressedBytes }, [chunk.buffer]);
    });
    const reader = response.body.getReader();
    while (true) {
      const { done, value } = await reader.read();
      if (done) break;
      if (!value) continue;
      compressedBytes += value.byteLength;
      decoder.push(value, false);
      post({ type: 'progress', receivedBytes: compressedBytes, totalBytes });
    }
    decoder.push(new Uint8Array(), true);
    post({ type: 'complete', bytes: uncompressedBytes, sha256: hasher.digest('hex'), compressedBytes });
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    post({ type: controller?.signal.aborted ? 'aborted' : 'error', message });
  } finally {
    controller = undefined;
  }
}
