import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterAll, describe, expect, it } from 'vitest';
import { Fetcher } from '../src/http';
import { assertResumeCompatible, cacheConfigHash, commitImmutableArtifact, gitContentIdentity, hashSetIds, type RunBinding } from '../src/run-guard';
import { failedChecks } from '../src/verify-checks';

const dir = mkdtempSync(join(tmpdir(), 'fdx-guard-'));
afterAll(() => rmSync(dir, { recursive: true, force: true }));

const base: RunBinding = {
  setSelectionHash: hashSetIds(['swsh3', 'sv1']),
  schemaVersion: 1,
  schemaFingerprint: 'a'.repeat(64),
  nodeVersion: 'v22.0.0',
  builderPackageVersion: '0.1.0',
  builderGit: 'a'.repeat(40),
  zstdLibrary: 'zstd-napi@0.0.13',
  apiBase: 'https://api.tcgdex.net/v2'
};

describe('frozen run binding', () => {
  it('accepts an identical binding and set order does not matter', () => {
    expect(() => assertResumeCompatible({ ...base, setSelectionHash: hashSetIds(['sv1', 'swsh3']) }, base)).not.toThrow();
  });
  it('refuses resume when the set selection changed', () => {
    expect(() => assertResumeCompatible(base, { ...base, setSelectionHash: hashSetIds(['sv1']) })).toThrow(/--resume refused[\s\S]*setSelectionHash/);
    expect(hashSetIds(undefined)).not.toBe(hashSetIds(['sv1']));
  });
  it('refuses resume on schema or toolchain mismatch', () => {
    expect(() => assertResumeCompatible(base, { ...base, schemaFingerprint: 'b'.repeat(64) })).toThrow(/schemaFingerprint/);
    expect(() => assertResumeCompatible(base, { ...base, schemaVersion: 2 })).toThrow(/schemaVersion/);
    expect(() => assertResumeCompatible(base, { ...base, nodeVersion: 'v24.0.0' })).toThrow(/nodeVersion/);
    expect(() => assertResumeCompatible(base, { ...base, builderPackageVersion: '0.2.0' })).toThrow(/builderPackageVersion/);
    expect(() => assertResumeCompatible(base, { ...base, zstdLibrary: 'other@1' })).toThrow(/zstdLibrary/);
  });
  it('refuses legacy run metadata with no binding', () => {
    expect(() => assertResumeCompatible(undefined, base)).toThrow(/no binding/);
  });
});

describe('immutable artifacts', () => {
  it('new version writes the file', async () => {
    const part = join(dir, 'new.db.part');
    const final = join(dir, 'new.db');
    writeFileSync(part, 'v1-bytes');
    await expect(commitImmutableArtifact(part, final)).resolves.toBe('written');
    expect(readFileSync(final, 'utf8')).toBe('v1-bytes');
    expect(existsSync(part)).toBe(false);
  });
  it('identical rerun is a no-op', async () => {
    const part = join(dir, 'same.db.part');
    const final = join(dir, 'same.db');
    writeFileSync(final, 'same');
    writeFileSync(part, 'same');
    await expect(commitImmutableArtifact(part, final)).resolves.toBe('noop');
    expect(readFileSync(final, 'utf8')).toBe('same');
    expect(existsSync(part)).toBe(false);
  });
  it('same-version drift throws and leaves the existing artifact intact', async () => {
    const part = join(dir, 'drift.db.part');
    const final = join(dir, 'drift.db');
    writeFileSync(final, 'original');
    writeFileSync(part, 'changed!');
    await expect(commitImmutableArtifact(part, final)).rejects.toThrow(/Immutable artifact drift/);
    expect(readFileSync(final, 'utf8')).toBe('original');
  });
});

describe('verify-pack check gate', () => {
  const good = {
    language: 'en', shaMatches: true, bytesMatch: true, countsMatch: true, compressedShaMatches: true, compressedBytesMatch: true,
    fullPackUrlMatches: true, metaMatches: true, integrity: 'ok', foreignKeyViolations: 0, liveChecks: [{ id: 'a', ok: true }]
  };
  it('passes when every check is true', () => expect(failedChecks([good])).toEqual([]));
  it('reports every false field', () => {
    expect(failedChecks([{ ...good, shaMatches: false }])).toEqual(['en.shaMatches']);
    expect(failedChecks([{ ...good, bytesMatch: false, countsMatch: false }])).toEqual(['en.bytesMatch', 'en.countsMatch']);
    expect(failedChecks([{ ...good, integrity: 'bad' }])).toEqual(['en.integrity']);
    expect(failedChecks([{ ...good, compressedShaMatches: false, compressedBytesMatch: false }])).toEqual(['en.compressedShaMatches', 'en.compressedBytesMatch']);
    expect(failedChecks([{ ...good, fullPackUrlMatches: false, metaMatches: false }])).toEqual(['en.fullPackUrlMatches', 'en.metaMatches']);
    expect(failedChecks([{ ...good, foreignKeyViolations: 2 }])).toEqual(['en.foreignKeyViolations']);
    expect(failedChecks([{ ...good, liveChecks: [{ id: 'x', ok: false }] }])).toEqual(['en.liveChecks[x]']);
    expect(failedChecks([{ ...good, liveChecks: [] }])).toEqual(['en.liveChecks(empty)']);
  });
});

describe('cache validation and discovery revalidation', () => {
  it('does not reuse cache written under another config or url; maxAge 0 revalidates', async () => {
    const file = join(dir, 'cache', 'x.json');
    let calls = 0;
    const fetchImpl = (async () => new Response(JSON.stringify({ n: ++calls }), { status: 200 })) as typeof fetch;
    const mk = (config: string) => new Fetcher({ cacheConfig: config, fetchImpl, maxCacheAgeMs: Number.POSITIVE_INFINITY });
    await mk(cacheConfigHash('en', 'https://a')).getJson('https://x/1', file);
    await mk(cacheConfigHash('en', 'https://a')).getJson('https://x/1', file);
    expect(calls).toBe(1); // reused
    await mk(cacheConfigHash('ja', 'https://a')).getJson('https://x/1', file);
    expect(calls).toBe(2); // different config
    await mk(cacheConfigHash('ja', 'https://a')).getJson('https://x/2', file);
    expect(calls).toBe(3); // different url
    await mk(cacheConfigHash('ja', 'https://a')).getJson('https://x/2', file, 0);
    expect(calls).toBe(4); // new-run discovery revalidation
  });
});

describe('R11 run identity is bound to git content, and details are never reused across runs', () => {
  it('gitContentIdentity: HEAD, plus a dirty marker that changes with the working-tree diff; nogit when git is unavailable', () => {
    const git = (head: string, status: string, diff = '') => (args: string[]) => (args[0] === 'rev-parse' ? head : args[0] === 'status' ? status : diff);
    expect(gitContentIdentity(git('a'.repeat(40), ''))).toBe('a'.repeat(40));
    const dirty1 = gitContentIdentity(git('a'.repeat(40), ' M src/x.ts', 'diff one'));
    const dirty2 = gitContentIdentity(git('a'.repeat(40), ' M src/x.ts', 'diff two'));
    expect(dirty1).toMatch(/^a{40}\+dirty-[0-9a-f]{12}$/);
    expect(dirty1).not.toBe(dirty2);
    expect(gitContentIdentity(() => { throw new Error('no git'); })).toBe('nogit');
  });

  it('a resume is refused when the builder git content changed (even though the package version string is the same)', () => {
    const stored = { ...base, builderGit: 'a'.repeat(40) };
    expect(() => assertResumeCompatible(stored, { ...stored, builderGit: `${'a'.repeat(40)}+dirty-0123456789ab` })).toThrow(/--resume refused[\s\S]*builderGit/);
    expect(() => assertResumeCompatible(stored, stored)).not.toThrow();
  });

  it('cache entries are reused only by the SAME run: a new run (new runId) refetches even inside the 24 h window; the resumed run reuses; legacy entries are not trusted', async () => {
    const file = join(dir, 'cache-run', 'card.json');
    let calls = 0;
    const fetchImpl = (async () => new Response(JSON.stringify({ n: ++calls }), { status: 200 })) as typeof fetch;
    const mk = (runId: string | undefined) => new Fetcher({ cacheConfig: 'cfg', runId, fetchImpl, maxCacheAgeMs: 24 * 3600 * 1000 });
    await mk('run-A').getJson('https://x/card', file);
    expect(calls).toBe(1);
    await mk('run-A').getJson('https://x/card', file); // resume of run A
    expect(calls).toBe(1);
    await mk('run-B').getJson('https://x/card', file); // a NEW run first seeing this card: no 24 h reuse
    expect(calls).toBe(2);
    await mk('run-A').getJson('https://x/card', file); // run B overwrote the entry: run A's older bytes are gone, so A refetches too
    expect(calls).toBe(3);
    writeFileSync(file, JSON.stringify({ fetchedAt: Date.now(), url: 'https://x/card', config: 'cfg', data: { n: 99 } })); // entry from an older builder (no runId)
    await mk('run-C').getJson('https://x/card', file);
    expect(calls).toBe(4);
  });
});
