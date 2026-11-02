import { describe, expect, it } from 'vitest';
import { WebStorageError, type CatalogCandidate, type MigrationMarker, type UserRole } from './contract';
import { createMemoryStateCell, createRoleStoreFromCell } from './role-store';
import { emptyRoleState, referencedPaths } from './role-state';

const ref = (lang: 'en' | 'ja', id: string) => `/catalog-${lang}/g-${id}.db`;
const candidate = (lang: 'en' | 'ja', id: string): CatalogCandidate => ({ ref: ref(lang, id), job: id, version: `v-${id}`, sha256: 'a'.repeat(64), bytes: 10, createdAt: '2026-10-31T00:00:00.000Z' });
const codeOf = async (promise: Promise<unknown>): Promise<string | undefined> => promise.then(() => undefined, (error: unknown) => (error as WebStorageError).code);

describe('role store transitions', () => {
  it('starts empty and registers candidates', async () => {
    const store = createRoleStoreFromCell(createMemoryStateCell());
    expect((await store.load()).languages.en).toEqual({ activeRef: null, previousRef: null, candidates: [] });
    await store.addCandidate('en', candidate('en', 'aaaaaa'));
    expect((await store.language('en')).candidates).toHaveLength(1);
    expect(await codeOf(store.addCandidate('en', candidate('en', 'aaaaaa')))).toBe('BUSY');
    expect(await codeOf(store.addCandidate('ja', candidate('en', 'bbbbbb')))).toBe('INVALID_PATH');
  });

  it('activate: previous = old active, candidate consumed; first install has no previous', async () => {
    const store = createRoleStoreFromCell(createMemoryStateCell());
    await store.addCandidate('en', candidate('en', 'aaaaaa'));
    expect(await store.activate('en', ref('en', 'aaaaaa'), null)).toEqual({ activeRef: ref('en', 'aaaaaa'), previousRef: null });
    expect((await store.language('en')).candidates).toEqual([]);
    await store.addCandidate('en', candidate('en', 'bbbbbb'));
    expect(await store.activate('en', ref('en', 'bbbbbb'), ref('en', 'aaaaaa'))).toEqual({ activeRef: ref('en', 'bbbbbb'), previousRef: ref('en', 'aaaaaa') });
    expect(await store.language('en')).toMatchObject({ activeRef: ref('en', 'bbbbbb'), previousRef: ref('en', 'aaaaaa') });
  });

  it('activate with a mismatching expected active or an unknown candidate throws BUSY and changes nothing', async () => {
    const cell = createMemoryStateCell();
    const store = createRoleStoreFromCell(cell);
    await store.addCandidate('en', candidate('en', 'aaaaaa'));
    const before = cell.raw();
    expect(await codeOf(store.activate('en', ref('en', 'aaaaaa'), ref('en', 'zzzzzz')))).toBe('BUSY');
    expect(await codeOf(store.activate('en', ref('en', 'cccccc'), null))).toBe('BUSY');
    expect(cell.raw()).toEqual(before);
  });

  it('removeCandidate is membership-checked: a promoted active/previous ref returns false and is untouched', async () => {
    const store = createRoleStoreFromCell(createMemoryStateCell());
    await store.addCandidate('en', candidate('en', 'aaaaaa'));
    await store.activate('en', ref('en', 'aaaaaa'), null);
    await store.addCandidate('en', candidate('en', 'bbbbbb'));
    await store.activate('en', ref('en', 'bbbbbb'), ref('en', 'aaaaaa'));
    expect(await store.removeCandidate('en', ref('en', 'bbbbbb'))).toBe(false);
    expect(await store.removeCandidate('en', ref('en', 'aaaaaa'))).toBe(false);
    expect(await store.removeCandidate('en', ref('en', 'dddddd'))).toBe(false);
    expect(await store.language('en')).toMatchObject({ activeRef: ref('en', 'bbbbbb'), previousRef: ref('en', 'aaaaaa') });
    await store.addCandidate('en', candidate('en', 'eeeeee'));
    expect(await store.removeCandidate('en', ref('en', 'eeeeee'))).toBe(true);
    expect(await store.removeCandidate('en', ref('en', 'eeeeee'))).toBe(false); // idempotent
  });

  it('restorePrevious swaps back and reports the displaced ref; none -> null; expected-active mismatch -> BUSY', async () => {
    const store = createRoleStoreFromCell(createMemoryStateCell());
    expect(await store.restorePrevious('en', null)).toBeNull();
    await store.addCandidate('en', candidate('en', 'aaaaaa'));
    await store.activate('en', ref('en', 'aaaaaa'), null);
    await store.addCandidate('en', candidate('en', 'bbbbbb'));
    await store.activate('en', ref('en', 'bbbbbb'), ref('en', 'aaaaaa'));
    expect(await codeOf(store.restorePrevious('en', ref('en', 'aaaaaa')))).toBe('BUSY');
    expect(await store.restorePrevious('en', ref('en', 'bbbbbb'))).toEqual({ activeRef: ref('en', 'aaaaaa'), displacedRef: ref('en', 'bbbbbb') });
    expect(await store.language('en')).toMatchObject({ activeRef: ref('en', 'aaaaaa'), previousRef: null });
  });

  it('clearPrevious / clearLanguage return what was referenced; other language untouched', async () => {
    const store = createRoleStoreFromCell(createMemoryStateCell());
    await store.addCandidate('en', candidate('en', 'aaaaaa'));
    await store.activate('en', ref('en', 'aaaaaa'), null);
    await store.addCandidate('en', candidate('en', 'bbbbbb'));
    await store.activate('en', ref('en', 'bbbbbb'), ref('en', 'aaaaaa'));
    await store.addCandidate('en', candidate('en', 'cccccc'));
    await store.addCandidate('ja', candidate('ja', 'jjjjjj'));
    expect(await store.clearPrevious('en')).toBe(ref('en', 'aaaaaa'));
    expect(await store.clearPrevious('en')).toBeNull();
    expect((await store.clearLanguage('en')).sort()).toEqual([ref('en', 'bbbbbb'), ref('en', 'cccccc')]);
    expect(await store.clearLanguage('en')).toEqual([]);
    expect((await store.language('ja')).candidates).toHaveLength(1);
  });

  it('user commit is one call, refuses a different path without replace', async () => {
    const store = createRoleStoreFromCell(createMemoryStateCell());
    const role: UserRole = { path: '/user/u-abcdef.db', origin: 'fresh', createdAt: 'now' };
    await store.commitUser(role, null);
    await store.commitUser(role, null); // same path: fine
    expect(await codeOf(store.commitUser({ ...role, path: '/user/u-ghijkl.db' }, null))).toBe('BUSY');
    const marker: MigrationMarker = { version: 1, state: 'completed', source: 'jeep-indexeddb', userPath: '/user/m-abcdef.db', at: 'now', legacyBytes: 5, legacySha256: 'x', counts: { owned_cards: 2 }, legacyRetained: true };
    await store.commitUser({ ...role, path: '/user/m-abcdef.db', origin: 'migrated' }, marker, { replace: true });
    expect(await store.user()).toMatchObject({ path: '/user/m-abcdef.db', origin: 'migrated' });
    expect((await store.migration())?.counts).toEqual({ owned_cards: 2 });
  });

  it('intents are put/listed/cleared', async () => {
    const store = createRoleStoreFromCell(createMemoryStateCell());
    const intent = { job: 'job1', target: 'en' as const, targetRef: ref('en', 'aaaaaa'), stagingJob: 'job1', startedAt: 'now' };
    await store.putIntent(intent);
    await store.putIntent(intent);
    expect(await store.listIntents()).toEqual([intent]);
    await store.clearIntent('job1');
    await store.clearIntent('job1');
    expect(await store.listIntents()).toEqual([]);
  });

  it('corrupt / unknown-schema metadata -> METADATA_CORRUPT on read and on mutation, record untouched', async () => {
    for (const bad of [{ schema: 2 }, 'garbage', { ...emptyRoleState(), languages: { en: { activeRef: '/user/u-abcdef.db', previousRef: null, candidates: [] }, ja: emptyRoleState().languages.ja } }]) {
      const cell = createMemoryStateCell(bad);
      const store = createRoleStoreFromCell(cell);
      expect(await codeOf(store.load())).toBe('METADATA_CORRUPT');
      expect(await codeOf(store.addCandidate('en', candidate('en', 'aaaaaa')))).toBe('METADATA_CORRUPT');
      expect(cell.raw()).toEqual(bad);
    }
  });

  it('referencedPaths covers user, active, previous, candidates', async () => {
    const store = createRoleStoreFromCell(createMemoryStateCell());
    await store.commitUser({ path: '/user/u-abcdef.db', origin: 'fresh', createdAt: 'now' }, null);
    await store.addCandidate('en', candidate('en', 'aaaaaa'));
    await store.activate('en', ref('en', 'aaaaaa'), null);
    await store.addCandidate('en', candidate('en', 'bbbbbb'));
    expect([...referencedPaths(await store.load())].sort()).toEqual(['/user/u-abcdef.db', ref('en', 'aaaaaa'), ref('en', 'bbbbbb')].sort());
  });
});
