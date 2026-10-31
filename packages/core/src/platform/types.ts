export interface SqliteExecutor {
  execute(sql: string, params?: readonly unknown[]): Promise<readonly Record<string, unknown>[]>;
}

export type SupportedPlatform = 'web' | 'ios' | 'android' | 'node';
