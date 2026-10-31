import { describe, expect, it } from 'vitest';
import { DomainError } from '@flashydex/core';
import { describeError } from './errors';
import { retryTransientRead } from './query-retry';

const err = (code: string) => Object.assign(new Error('x'), { code });

describe('retryTransientRead', () => {
  it('retries STALE_READ and MAINTENANCE exactly once', () => {
    expect(retryTransientRead(0, err('STALE_READ'))).toBe(true);
    expect(retryTransientRead(1, err('STALE_READ'))).toBe(false);
    expect(retryTransientRead(0, err('MAINTENANCE'))).toBe(true);
    expect(retryTransientRead(1, err('MAINTENANCE'))).toBe(false);
  });
  it('never retries anything else', () => {
    for (const code of ['HTTP_FAILED', 'NOT_FOUND', 'VALIDATION_ERROR', 'DB_BUSY', 'PERSISTENCE_FAILED']) expect(retryTransientRead(0, err(code))).toBe(false);
    expect(retryTransientRead(0, new Error('The database connection is not open'))).toBe(false);
  });
});

describe('raw driver text is never rendered', () => {
  it('falls back to generic copy for an untyped driver error', () => {
    const copy = describeError(new Error('The database connection is not open'));
    expect(`${copy.title} ${copy.body}`).not.toMatch(/database connection|not open/i);
    expect(copy.detail).toBeNull();
  });
  it('has copy for STALE_READ-style and MAINTENANCE errors', () => {
    expect(describeError(new DomainError('MAINTENANCE', 'raw driver words')).body).not.toMatch(/raw driver/);
    expect(describeError(new DomainError('STALE_READ', 'raw')).title).toBe('The catalog just changed');
  });
});
