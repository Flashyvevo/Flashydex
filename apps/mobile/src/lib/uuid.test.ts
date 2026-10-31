import { describe, expect, it } from 'vitest';
import { uuidV4 } from './uuid';

describe('uuidV4', () => {
  it('produces RFC4122 v4 ids with and without crypto.randomUUID (insecure LAN origin)', () => {
    const re = /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/;
    expect(uuidV4()).toMatch(re);
    const orig = globalThis.crypto.randomUUID;
    Object.defineProperty(globalThis.crypto, 'randomUUID', { value: undefined, configurable: true });
    try {
      const a = uuidV4();
      const b = uuidV4();
      expect(a).toMatch(re);
      expect(b).toMatch(re);
      expect(a).not.toBe(b);
    } finally {
      Object.defineProperty(globalThis.crypto, 'randomUUID', { value: orig, configurable: true });
    }
  });
});
