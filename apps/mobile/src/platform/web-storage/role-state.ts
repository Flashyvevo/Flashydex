/**
 * Pure role-state transitions (WEB-STORAGE §4 "Layout and source of truth"). No IndexedDB, no I/O: every function takes a validated
 * `RoleStateV1` and returns the next state plus the value the `RoleStore` method resolves with. `role-store.ts` runs exactly one of
 * these inside ONE IndexedDB readwrite transaction, so each transition is atomic on disk.
 */
import {
  CATALOG_PATH_RE, USER_PATH_RE, WebStorageError,
  type CatalogCandidate, type ImportIntent, type LanguageRoles, type MigrationMarker, type PoolPath, type RoleStateV1, type UserRole,
  type WebLanguage
} from './contract';

export const LANGUAGES: readonly WebLanguage[] = ['en', 'ja'];

const emptyLanguage = (): LanguageRoles => ({ activeRef: null, previousRef: null, candidates: [] });

export const emptyRoleState = (): RoleStateV1 => ({ schema: 1, user: null, migration: null, languages: { en: emptyLanguage(), ja: emptyLanguage() }, intents: [] });

export const clone = <T>(value: T): T => structuredClone(value);

const corrupt = (why: string): WebStorageError => new WebStorageError('METADATA_CORRUPT', `Role metadata is invalid: ${why}`);
const isObject = (value: unknown): value is Record<string, unknown> => typeof value === 'object' && value !== null && !Array.isArray(value);
const isString = (value: unknown): value is string => typeof value === 'string';

export function languageOfRef(ref: string): WebLanguage | null {
  const match = CATALOG_PATH_RE.exec(ref);
  return match ? (match[1] as WebLanguage) : null;
}

/** A catalog ref must be a valid pool path AND live in the directory of `language`. */
export function assertCatalogRef(language: WebLanguage, ref: unknown): asserts ref is PoolPath {
  if (!isString(ref) || languageOfRef(ref) !== language) throw new WebStorageError('INVALID_PATH', 'Not a catalog path for this language');
}

function parseRef(language: WebLanguage, value: unknown, what: string): PoolPath | null {
  if (value === null) return null;
  if (!isString(value) || languageOfRef(value) !== language) throw corrupt(`${what} is not a ${language} catalog path`);
  return value;
}

function parseCandidate(language: WebLanguage, value: unknown): CatalogCandidate {
  if (!isObject(value)) throw corrupt('candidate is not an object');
  const ref = parseRef(language, value.ref, 'candidate.ref');
  if (ref === null) throw corrupt('candidate.ref is null');
  if (!isString(value.job) || !isString(value.version) || !isString(value.sha256) || !isString(value.createdAt)) throw corrupt('candidate fields');
  if (typeof value.bytes !== 'number' || !Number.isSafeInteger(value.bytes) || value.bytes < 0) throw corrupt('candidate.bytes');
  return { ref, job: value.job, version: value.version, sha256: value.sha256, bytes: value.bytes, createdAt: value.createdAt };
}

function parseLanguage(language: WebLanguage, value: unknown): LanguageRoles {
  if (!isObject(value) || !Array.isArray(value.candidates)) throw corrupt(`languages.${language}`);
  const activeRef = parseRef(language, value.activeRef, 'activeRef');
  const previousRef = parseRef(language, value.previousRef, 'previousRef');
  const candidates = value.candidates.map((candidate) => parseCandidate(language, candidate));
  const refs = [activeRef, previousRef, ...candidates.map((candidate) => candidate.ref)].filter((ref): ref is PoolPath => ref !== null);
  if (new Set(refs).size !== refs.length) throw corrupt(`${language} roles share a ref`);
  return { activeRef, previousRef, candidates };
}

function parseUser(value: unknown): UserRole | null {
  if (value === null) return null;
  if (!isObject(value) || !isString(value.path) || !USER_PATH_RE.test(value.path)) throw corrupt('user.path');
  if (value.origin !== 'fresh' && value.origin !== 'migrated') throw corrupt('user.origin');
  if (!isString(value.createdAt)) throw corrupt('user.createdAt');
  return { path: value.path, origin: value.origin, createdAt: value.createdAt };
}

function parseMigration(value: unknown): MigrationMarker | null {
  if (value === null) return null;
  if (!isObject(value) || value.version !== 1 || value.state !== 'completed' || value.source !== 'jeep-indexeddb') throw corrupt('migration marker');
  if (!isString(value.userPath) || !USER_PATH_RE.test(value.userPath) || !isString(value.at) || !isString(value.legacySha256)) throw corrupt('migration marker fields');
  if (typeof value.legacyBytes !== 'number' || typeof value.legacyRetained !== 'boolean' || !isObject(value.counts)) throw corrupt('migration marker values');
  return value as unknown as MigrationMarker;
}

function parseIntent(value: unknown): ImportIntent {
  if (!isObject(value) || !isString(value.job) || !isString(value.startedAt)) throw corrupt('intent');
  if (value.target !== 'en' && value.target !== 'ja' && value.target !== 'user') throw corrupt('intent.target');
  if (!isString(value.targetRef) || !(CATALOG_PATH_RE.test(value.targetRef) || USER_PATH_RE.test(value.targetRef))) throw corrupt('intent.targetRef');
  if (value.stagingJob !== null && !isString(value.stagingJob)) throw corrupt('intent.stagingJob');
  return { job: value.job, target: value.target, targetRef: value.targetRef, stagingJob: value.stagingJob, startedAt: value.startedAt };
}

/** Validates arbitrary persisted JSON. Unknown schema / any shape violation -> METADATA_CORRUPT (the caller never resets). */
export function parseRoleState(value: unknown): RoleStateV1 {
  if (!isObject(value)) throw corrupt('not an object');
  if (value.schema !== 1) throw corrupt(`unknown schema ${String(value.schema)}`);
  if (!isObject(value.languages) || !Array.isArray(value.intents)) throw corrupt('shape');
  return {
    schema: 1,
    user: parseUser(value.user ?? null),
    migration: parseMigration(value.migration ?? null),
    languages: { en: parseLanguage('en', value.languages.en), ja: parseLanguage('ja', value.languages.ja) },
    intents: value.intents.map(parseIntent)
  };
}

export interface Transition<T> {
  /** `null` = no change (nothing is written). */
  state: RoleStateV1 | null;
  result: T;
}

const busy = (why: string): WebStorageError => new WebStorageError('BUSY', why, { retryable: false });

export function addCandidate(state: RoleStateV1, language: WebLanguage, candidate: CatalogCandidate): Transition<void> {
  assertCatalogRef(language, candidate.ref);
  const parsed = parseCandidate(language, candidate);
  const next = clone(state);
  const roles = next.languages[language];
  if ([roles.activeRef, roles.previousRef, ...roles.candidates.map((c) => c.ref)].includes(parsed.ref)) throw busy('That catalog generation is already registered');
  roles.candidates.push(parsed);
  return { state: next, result: undefined };
}

export function removeCandidate(state: RoleStateV1, language: WebLanguage, ref: PoolPath): Transition<boolean> {
  const roles = state.languages[language];
  if (!roles.candidates.some((candidate) => candidate.ref === ref)) return { state: null, result: false };
  const next = clone(state);
  next.languages[language].candidates = next.languages[language].candidates.filter((candidate) => candidate.ref !== ref);
  return { state: next, result: true };
}

export function activate(state: RoleStateV1, language: WebLanguage, candidateRef: PoolPath, expectedActiveRef: PoolPath | null): Transition<{ activeRef: PoolPath; previousRef: PoolPath | null }> {
  const roles = state.languages[language];
  if (roles.activeRef !== expectedActiveRef) throw busy('The active catalog changed during activation');
  if (!roles.candidates.some((candidate) => candidate.ref === candidateRef)) throw busy('The candidate is not registered');
  const next = clone(state);
  const target = next.languages[language];
  target.previousRef = roles.activeRef;
  target.activeRef = candidateRef;
  target.candidates = target.candidates.filter((candidate) => candidate.ref !== candidateRef);
  return { state: next, result: { activeRef: candidateRef, previousRef: roles.activeRef } };
}

export function restorePrevious(state: RoleStateV1, language: WebLanguage, expectedActiveRef: PoolPath | null): Transition<{ activeRef: PoolPath; displacedRef: PoolPath | null } | null> {
  const roles = state.languages[language];
  if (roles.previousRef === null) return { state: null, result: null };
  if (roles.activeRef !== expectedActiveRef) throw busy('The active catalog changed during restore');
  const next = clone(state);
  const target = next.languages[language];
  target.activeRef = roles.previousRef;
  target.previousRef = null;
  return { state: next, result: { activeRef: roles.previousRef, displacedRef: roles.activeRef } };
}

export function clearPrevious(state: RoleStateV1, language: WebLanguage): Transition<PoolPath | null> {
  const previous = state.languages[language].previousRef;
  if (previous === null) return { state: null, result: null };
  const next = clone(state);
  next.languages[language].previousRef = null;
  return { state: next, result: previous };
}

export function clearLanguage(state: RoleStateV1, language: WebLanguage): Transition<PoolPath[]> {
  const roles = state.languages[language];
  const refs = [roles.activeRef, roles.previousRef, ...roles.candidates.map((candidate) => candidate.ref)].filter((ref): ref is PoolPath => ref !== null);
  if (refs.length === 0) return { state: null, result: [] };
  const next = clone(state);
  next.languages[language] = emptyLanguage();
  return { state: next, result: refs };
}

export function commitUser(state: RoleStateV1, role: UserRole, marker: MigrationMarker | null, options: { replace?: boolean } = {}): Transition<void> {
  const parsed = parseUser(role);
  if (parsed === null) throw new WebStorageError('INVALID_PATH', 'Missing user role');
  if (state.user !== null && state.user.path !== parsed.path && options.replace !== true) throw busy('A different user database is already registered');
  if (marker !== null && marker.userPath !== parsed.path) throw new WebStorageError('INVALID_PATH', 'The migration marker does not match the user path');
  const next = clone(state);
  next.user = parsed;
  if (marker !== null) next.migration = parseMigration(marker);
  return { state: next, result: undefined };
}

export function putIntent(state: RoleStateV1, intent: ImportIntent): Transition<void> {
  const parsed = parseIntent(intent);
  const next = clone(state);
  next.intents = [...next.intents.filter((existing) => existing.job !== parsed.job), parsed];
  return { state: next, result: undefined };
}

export function clearIntent(state: RoleStateV1, job: string): Transition<void> {
  if (!state.intents.some((intent) => intent.job === job)) return { state: null, result: undefined };
  const next = clone(state);
  next.intents = next.intents.filter((intent) => intent.job !== job);
  return { state: next, result: undefined };
}

/** Every ref the roles (and any import intent) still point at. Reconciliation NEVER unlinks a member of this set. */
export function referencedPaths(state: RoleStateV1): Set<PoolPath> {
  const refs = new Set<PoolPath>();
  if (state.user) refs.add(state.user.path);
  if (state.migration) refs.add(state.migration.userPath);
  for (const language of LANGUAGES) {
    const roles = state.languages[language];
    if (roles.activeRef) refs.add(roles.activeRef);
    if (roles.previousRef) refs.add(roles.previousRef);
    for (const candidate of roles.candidates) refs.add(candidate.ref);
  }
  return refs;
}
