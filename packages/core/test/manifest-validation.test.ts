import { afterEach, describe, expect, it } from 'vitest';
import { CatalogInstallService } from '../src/services/catalog-install';
import { MANIFEST_MAX_BYTES, compareVersions, isCalendarVersion, parseManifestText, validateManifestSemantics } from '../src/services/manifest-validation';
import { FakeDiskPort } from '../src/testing/fake-install-port';
import { harness, type Harness } from './helpers';

const HA = 'a'.repeat(64);
const HB = 'b'.repeat(64);
const TRUST = ['https://example.test'];
const URL0 = 'https://example.test/manifest.json';
const ctx = (over: Partial<Parameters<typeof validateManifestSemantics>[1]> = {}): Parameters<typeof validateManifestSemantics>[1] => ({
  requestedUrl: URL0, finalUrl: URL0, trustedOrigins: TRUST, allowDevUrls: false, installed: [], ...over
});
const m = (version = '2026.10.31.001', sha = HA) => FakeDiskPort.manifest(['en'], version, sha) as Record<string, any>;
const code = (fn: () => unknown) => { try { fn(); } catch (e) { return (e as { code: string }).code; } return 'NO_ERROR'; };

describe('R09 manifest semantics (central validator)', () => {
  it('accepts an unsigned, well-formed manifest on a trusted origin', () => {
    expect(validateManifestSemantics(m(), ctx()).targetVersion).toBe('2026.10.31.001');
  });

  it('rejects ANY present signature (no keys shipped) with MANIFEST_SIGNATURE_INVALID, even a well-formed one and even garbage', () => {
    const good = { ...m(), signature: { algorithm: 'Ed25519', keyId: 'k1', value: 'A'.repeat(86) + '==' } };
    expect(code(() => validateManifestSemantics(good, ctx()))).toBe('MANIFEST_SIGNATURE_INVALID');
    expect(code(() => validateManifestSemantics({ ...m(), signature: 'trust-me' }, ctx()))).toBe('MANIFEST_SIGNATURE_INVALID');
    expect(code(() => validateManifestSemantics({ ...m(), signature: { algorithm: 'RSA' } }, ctx()))).toBe('MANIFEST_SIGNATURE_INVALID');
  });

  it('rejects a downgrade, and the same version republished with a different sha256; allows same version + same sha and upgrades', () => {
    const installed = [{ language: 'en' as const, version: '2026.11.01.002', sha256: HA, status: 'installed' as const }];
    expect(code(() => validateManifestSemantics(m('2026.11.01.001'), ctx({ installed })))).toBe('MANIFEST_INVALID');
    expect(code(() => validateManifestSemantics(m('2026.11.01.002', HB), ctx({ installed })))).toBe('MANIFEST_INVALID');
    expect(code(() => validateManifestSemantics(m('2026.11.01.002', HA), ctx({ installed })))).toBe('NO_ERROR');
    expect(code(() => validateManifestSemantics(m('2026.11.02.001', HB), ctx({ installed })))).toBe('NO_ERROR');
    // a failed/absent receipt never blocks an install
    expect(code(() => validateManifestSemantics(m('2026.10.01.001'), ctx({ installed: [{ language: 'en', version: '2026.11.01.002', sha256: HA, status: 'failed' }] })))).toBe('NO_ERROR');
  });

  it('rejects calendar-invalid versions and NNN = 000', () => {
    for (const v of ['2026.13.01.001', '2026.02.30.001', '2026.00.10.001', '2026.10.31.000', '2026.10.32.001']) {
      expect(isCalendarVersion(v)).toBe(false);
      expect(code(() => validateManifestSemantics(m(v), ctx()))).toBe('MANIFEST_INVALID');
    }
    expect(isCalendarVersion('2028.02.29.001')).toBe(true); // leap day
    expect(compareVersions('2026.10.31.002', '2026.10.31.010')).toBe(-1);
  });

  it('rejects cross-field count nonsense', () => {
    const bad = (patch: Record<string, number>) => {
      const x = m();
      x.languages.en.counts = { ...x.languages.en.counts, ...patch };
      return code(() => validateManifestSemantics(x, ctx()));
    };
    expect(bad({ sets: 1, unpublishedSets: 2 })).toBe('MANIFEST_INVALID');
    expect(bad({ sets: 2, unpublishedSets: 2, cards: 5 })).toBe('MANIFEST_INVALID');
    expect(bad({ cards: 0, prices: 3 })).toBe('MANIFEST_INVALID');
    expect(bad({ cards: 0, variants: 3 })).toBe('MANIFEST_INVALID');
  });

  it('rejects an untrusted redirect origin, an untrusted pack URL, plain http, and a delta URL off-origin', () => {
    expect(code(() => validateManifestSemantics(m(), ctx({ finalUrl: 'https://evil.test/manifest.json' })))).toBe('MANIFEST_INVALID');
    expect(code(() => validateManifestSemantics(m(), ctx({ requestedUrl: 'https://evil.test/manifest.json' })))).toBe('MANIFEST_INVALID');
    expect(code(() => validateManifestSemantics(FakeDiskPort.manifest(['en'], '2026.10.31.001', HA, 'https://evil.test'), ctx()))).toBe('MANIFEST_INVALID');
    expect(code(() => validateManifestSemantics(m(), ctx({ finalUrl: 'http://example.test/manifest.json' })))).toBe('MANIFEST_INVALID');
    const x = m();
    x.languages.en.setIndexUrl = 'https://cdn.evil.test/set-index-en.json';
    expect(code(() => validateManifestSemantics(x, ctx()))).toBe('MANIFEST_INVALID');
    const y = m();
    y.languages.en.delta = { currentVersion: '2026.10.01.001', targetVersion: '2026.10.31.001', url: 'https://evil.test/d', algorithm: 'x', compressedBytes: 1, uncompressedBytes: 1, sha256: HA, baseSha256: HB };
    expect(code(() => validateManifestSemantics(y, ctx()))).toBe('MANIFEST_INVALID');
  });

  it('dev mode (allowDevUrls) accepts the page origin and relative URLs; production never does', () => {
    const dev = m();
    dev.languages.en.fullPackUrl = '/dev-packs/catalog-en.db.zst';
    delete dev.languages.en.setIndexUrl;
    const devCtx = ctx({ allowDevUrls: true, requestedUrl: 'http://127.0.0.1:3200/manifest.json', finalUrl: 'http://127.0.0.1:3200/manifest.json', trustedOrigins: [] });
    expect(code(() => validateManifestSemantics(dev, devCtx))).toBe('NO_ERROR');
    expect(code(() => validateManifestSemantics(dev, ctx()))).toBe('MANIFEST_INVALID');
  });

  it('text over 256 KiB is rejected before parsing; bad JSON is MANIFEST_INVALID', () => {
    expect(MANIFEST_MAX_BYTES).toBe(256 * 1024);
    expect(code(() => parseManifestText('x'.repeat(MANIFEST_MAX_BYTES + 1)))).toBe('PAYLOAD_TOO_LARGE');
    expect(code(() => parseManifestText('{'))).toBe('MANIFEST_INVALID');
    expect(parseManifestText('{"a":1}')).toEqual({ a: 1 });
    // multi-byte characters count as bytes, not code units
    expect(code(() => parseManifestText('é'.repeat(MANIFEST_MAX_BYTES / 2 + 1)))).toBe('PAYLOAD_TOO_LARGE');
  });
});

describe('R09 through CatalogInstallService', () => {
  let h: Harness;
  afterEach(() => h.cleanup());
  const make = async () => {
    h = await harness();
    const port = new FakeDiskPort(h.t.dir, h.t.env);
    port.manifestJson = m();
    return { port, svc: new CatalogInstallService(h.ctx, port, { trustedOrigins: TRUST }) };
  };

  it('check + install reject a signed manifest, an oversize manifest and an untrusted redirect; nothing is staged', async () => {
    const { port, svc } = await make();
    port.manifestJson = { ...m(), signature: { algorithm: 'Ed25519', keyId: 'k', value: 'A'.repeat(86) + '==' } };
    await expect(svc.checkManifest()).rejects.toMatchObject({ code: 'MANIFEST_SIGNATURE_INVALID' });
    await expect(svc.install('en', () => undefined, new AbortController().signal)).rejects.toMatchObject({ code: 'MANIFEST_SIGNATURE_INVALID' });
    port.manifestJson = 'x'.repeat(MANIFEST_MAX_BYTES + 1);
    await expect(svc.checkManifest()).rejects.toMatchObject({ code: 'PAYLOAD_TOO_LARGE' });
    port.manifestJson = m();
    const redirected = new FakeDiskPort(h.t.dir, h.t.env);
    redirected.manifestJson = m();
    redirected.fetchManifest = async () => ({ text: JSON.stringify(m()), requestedUrl: URL0, finalUrl: 'https://evil.test/manifest.json' });
    await expect(new CatalogInstallService(h.ctx, redirected, { trustedOrigins: TRUST }).checkManifest()).rejects.toMatchObject({ code: 'MANIFEST_INVALID' });
    expect(port.calls.filter((c) => c.startsWith('stage'))).toEqual([]);
  });

  it('refuses a downgrade and same-version-different-hash after a real install; adapter PAYLOAD_TOO_LARGE is mapped; manifestUrl:null = CATALOG_NOT_CONFIGURED', async () => {
    const { port, svc } = await make();
    port.manifestJson = m('2026.11.01.001', HA);
    await svc.install('en', () => undefined, new AbortController().signal);
    port.manifestJson = m('2026.10.31.001', HB);
    await expect(svc.install('en', () => undefined, new AbortController().signal)).rejects.toMatchObject({ code: 'MANIFEST_INVALID' });
    port.manifestJson = m('2026.11.01.001', HB);
    await expect(svc.install('en', () => undefined, new AbortController().signal)).rejects.toMatchObject({ code: 'MANIFEST_INVALID' });
    port.manifestError = Object.assign(new Error('too big'), { code: 'PAYLOAD_TOO_LARGE' });
    await expect(svc.checkManifest()).rejects.toMatchObject({ code: 'PAYLOAD_TOO_LARGE' });
    port.manifestError = null;
    const unconfigured = new CatalogInstallService(h.ctx, port, { manifestUrl: null, trustedOrigins: TRUST });
    await expect(unconfigured.checkManifest()).rejects.toMatchObject({ code: 'CATALOG_NOT_CONFIGURED' });
  });
});
