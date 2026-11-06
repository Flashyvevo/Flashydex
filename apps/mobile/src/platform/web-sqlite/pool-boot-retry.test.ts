// @vitest-environment node
import { describe, expect, it } from 'vitest';
import { WebStorageError } from '../web-storage/contract';
import { isTransientPoolOpenError, POOL_OPEN_ATTEMPTS, POOL_OPEN_DELAY_MS, withPoolOpenRetry } from './pool-boot-retry';

const domException = (name: string) => Object.assign(new Error(name), { name });
const noSleep = (log: number[] = []) => async (ms: number) => { log.push(ms); };

describe('boot pool-open retry policy', () => {
  it('defaults are 10 attempts x 300 ms', () => {
    expect([POOL_OPEN_ATTEMPTS, POOL_OPEN_DELAY_MS]).toEqual([10, 300]);
  });

  it('classifies: handle-still-held and unclassified open failures are transient; quota, capacity and engine errors are not', () => {
    expect(isTransientPoolOpenError(domException('NoModificationAllowedError'))).toBe(true);
    expect(isTransientPoolOpenError(domException('InvalidStateError'))).toBe(true);
    expect(isTransientPoolOpenError(new Error('Access Handles cannot be created'))).toBe(true);
    expect(isTransientPoolOpenError(new WebStorageError('INIT_FAILED', 'x'))).toBe(true);
    expect(isTransientPoolOpenError(domException('QuotaExceededError'))).toBe(false);
    expect(isTransientPoolOpenError(new WebStorageError('CAPACITY', 'x'))).toBe(false);
    expect(isTransientPoolOpenError(new WebStorageError('QUOTA', 'x'))).toBe(false);
    expect(isTransientPoolOpenError(Object.assign(new Error('file is not a database'), { name: 'SQLite3Error', resultCode: 26 }))).toBe(false);
  });

  it('succeeds on a later attempt after transient failures, sleeping 300 ms between tries', async () => {
    const sleeps: number[] = [];
    let calls = 0;
    const result = await withPoolOpenRetry(async () => {
      calls += 1;
      if (calls < 4) throw domException('NoModificationAllowedError');
      return 'pool';
    }, { sleep: noSleep(sleeps) });
    expect(result).toBe('pool');
    expect(calls).toBe(4);
    expect(sleeps).toEqual([300, 300, 300]);
  });

  it('gives up after exactly 10 attempts and rethrows the last error', async () => {
    let calls = 0;
    const sleeps: number[] = [];
    const error = await withPoolOpenRetry(async () => { calls += 1; throw domException(`InvalidStateError`); }, { sleep: noSleep(sleeps) }).catch((e: unknown) => e);
    expect(calls).toBe(10);
    expect(sleeps).toHaveLength(9);
    expect((error as Error).name).toBe('InvalidStateError');
  });

  it('never retries quota, capacity or corruption: one attempt, immediate throw', async () => {
    for (const failure of [domException('QuotaExceededError'), new WebStorageError('CAPACITY', 'x'), Object.assign(new Error('malformed'), { name: 'SQLite3Error', resultCode: 11 })]) {
      let calls = 0;
      await expect(withPoolOpenRetry(async () => { calls += 1; throw failure; }, { sleep: noSleep() })).rejects.toBe(failure);
      expect(calls).toBe(1);
    }
  });

  it('a success on the first try never sleeps; onRetry sees each failed attempt number', async () => {
    const sleeps: number[] = [];
    expect(await withPoolOpenRetry(async () => 1, { sleep: noSleep(sleeps) })).toBe(1);
    expect(sleeps).toEqual([]);
    const seen: number[] = [];
    let calls = 0;
    await withPoolOpenRetry(async () => { calls += 1; if (calls < 3) throw new Error('busy'); return 1; }, { sleep: noSleep(), onRetry: (n) => seen.push(n) });
    expect(seen).toEqual([1, 2]);
  });
});
