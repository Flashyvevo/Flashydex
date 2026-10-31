export interface SqliteExecutor {
  execute(sql: string, params?: readonly unknown[]): Promise<readonly Record<string, unknown>[]>;
}

export type SupportedPlatform = 'web' | 'ios' | 'android' | 'node';

export interface DownloadProgress {
  receivedBytes: number;
  totalBytes: number | null;
}

export interface DownloadResult {
  bytes: number;
  contentType: string | null;
}

export interface StreamDecodeResult {
  bytes: number;
  sha256: string;
}

/** Platform-only file primitives. Catalog repositories remain platform agnostic. */
export interface PlatformFiles {
  download(url: string, destination: string, onProgress: (progress: DownloadProgress) => void, signal?: AbortSignal): Promise<DownloadResult>;
  decodeZstdToFile(source: string, destination: string, signal?: AbortSignal): Promise<StreamDecodeResult>;
  sha256File(path: string): Promise<string>;
  atomicRename(source: string, destination: string): Promise<void>;
  availableBytes(): Promise<number | null>;
  imageCache: {
    get(key: string): Promise<Blob | null>;
    put(key: string, value: Blob): Promise<void>;
    clear(): Promise<void>;
  };
}
