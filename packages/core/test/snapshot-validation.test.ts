import { afterEach, describe, expect, it } from 'vitest';
import { ValidationError } from '../src/errors';
import { copyOf, harness, installCatalog, ownedCount, type Harness } from './helpers';

let h: Harness;
afterEach(() => h.cleanup());

describe('owned snapshot validation (C1)', () => {
  it('a malformed catalog row is a ValidationError and nothing is stored', async () => {
    h = await harness();
    await installCatalog(h, 'en', {
      sets: [{ id: 's1', name: 'Set One' }],
      cards: [
        { id: 's1-001', setId: 's1', localId: '001', name: 'Good Mon', imageUrl: 'https://assets.example.test/s1/001' },
        { id: 's1-002', setId: 's1', localId: '002', name: 'Bad Image Mon', imageUrl: 'undefined' },
        { id: 's1-003', setId: 's1', localId: '003', name: 'Script Mon', imageUrl: 'javascript:alert(1)' }
      ]
    });
    const error = await h.collection.add(copyOf('s1-002')).then(() => null, (e: unknown) => e);
    expect(error).toBeInstanceOf(ValidationError);
    expect((error as ValidationError).code).toBe('VALIDATION_ERROR');
    await expect(h.collection.add(copyOf('s1-003'))).rejects.toBeInstanceOf(ValidationError);
    expect(await ownedCount(h)).toBe(0);
    expect((await h.collection.add(copyOf('s1-001'))).imageUrl).toBe('https://assets.example.test/s1/001');
    expect(await ownedCount(h)).toBe(1);
  });
});
