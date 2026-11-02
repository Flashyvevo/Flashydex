import { afterEach, describe, expect, it, vi } from 'vitest';
import { DEFAULT_TRUSTED_ORIGINS, trustedOrigins } from './catalog-config';

afterEach(() => vi.unstubAllEnvs());

describe('catalog trusted origins', () => {
  it('production default is exactly the Netlify packs origin (GitHub is archive only)', () => {
    expect([...DEFAULT_TRUSTED_ORIGINS]).toEqual(['https://flashydex-catalog-packs.netlify.app']);
    expect(DEFAULT_TRUSTED_ORIGINS.join(',')).not.toMatch(/github/);
  });

  it('keeps the env override and the DEV page origin', () => {
    vi.stubEnv('FLASHYDEX_TRUSTED_ORIGINS', 'https://packs.example.com/x, http://insecure.example.com');
    const origins = trustedOrigins();
    expect(origins).toContain('https://packs.example.com');
    expect(origins).toContain(window.location.origin); // vitest runs with DEV=true
    expect(origins).not.toContain('http://insecure.example.com/');
  });
});
