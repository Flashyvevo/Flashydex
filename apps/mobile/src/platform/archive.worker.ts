/// <reference lib="webworker" />
import { handleArchiveRequest, type ArchiveWorkerRequest } from './archive-worker-core';

/** N04: `.fdx` ZIP inflate + JSON parse + schema/domain validation, off the UI thread. One job per worker; the client terminates it afterwards. */
self.onmessage = (event: MessageEvent<ArchiveWorkerRequest>) => {
  void handleArchiveRequest(event.data).then((response) => (self as unknown as Worker).postMessage(response));
};
