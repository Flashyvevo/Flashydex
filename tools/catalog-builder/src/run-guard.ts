import { createHash } from 'node:crypto';
import { rename, rm } from 'node:fs/promises';
import { sha256File } from './zstd';

/** Everything that must be identical between an original run and its `--resume`. */
export interface RunBinding {
  setSelectionHash: string;
  schemaVersion: number | string;
  schemaFingerprint: string;
  nodeVersion: string;
  builderPackageVersion: string;
  /** Git content identity of the builder (HEAD + dirty marker, see `gitContentIdentity`), not a hand-edited version string. */
  builderGit: string;
  zstdLibrary: string;
  apiBase: string;
}

/** Paths whose content defines what the builder produces (relative to the repo root): the builder itself and the code its output depends on. */
export const BUILDER_PATHS = ['tools/catalog-builder', 'packages/core/src/catalog', 'packages/core/src/db', 'packages/schemas/src'] as const;

/**
 * R11: identity of the code that produced a run. `HEAD` alone when the builder-relevant tree is clean; `HEAD+dirty-<hash of the diff>` when it
 * is not, so two runs from different uncommitted edits never share an identity. `git` is injected (and runs at the repo root) for tests; any
 * git failure yields `nogit`.
 */
export function gitContentIdentity(git: (args: string[]) => string): string {
  try {
    const head = git(['rev-parse', 'HEAD']).trim();
    const dirty = git(['status', '--porcelain', '--', ...BUILDER_PATHS]).trim();
    if (!head) return 'nogit';
    if (!dirty) return head;
    const diff = git(['diff', 'HEAD', '--', ...BUILDER_PATHS]);
    return `${head}+dirty-${createHash('sha256').update(diff, 'utf8').update('\n').update(dirty, 'utf8').digest('hex').slice(0, 12)}`;
  } catch {
    return 'nogit';
  }
}

export function hashSetIds(ids: readonly string[] | undefined): string {
  const canonical = ids?.length ? [...new Set(ids)].sort().join('\n') : '*ALL*';
  return createHash('sha256').update(canonical, 'utf8').digest('hex');
}

/** Cache config hash: language + API base, so cached responses are never reused across languages/endpoints. */
export function cacheConfigHash(language: string, apiBase: string): string {
  return createHash('sha256').update(`${language}\n${apiBase}`, 'utf8').digest('hex').slice(0, 16);
}

export function bindingMismatches(stored: Partial<RunBinding> | undefined, current: RunBinding): string[] {
  if (!stored) return ['run metadata has no binding (written by an older builder)'];
  const problems: string[] = [];
  for (const key of Object.keys(current) as Array<keyof RunBinding>) {
    if (stored[key] !== current[key]) problems.push(`${key}: stored ${String(stored[key])} != current ${String(current[key])}`);
  }
  return problems;
}

export function assertResumeCompatible(stored: Partial<RunBinding> | undefined, current: RunBinding): void {
  const problems = bindingMismatches(stored, current);
  if (problems.length) {
    throw new Error(`--resume refused: stored run metadata does not match the current selection/schema/toolchain:\n- ${problems.join('\n- ')}\nStart a fresh run (without --resume) or restore the original inputs.`);
  }
}

export type CommitResult = 'written' | 'noop';

/**
 * Move a freshly built `.part` file into place WITHOUT deleting an existing artifact first.
 * - no existing file: write (new version);
 * - identical bytes (sha256 + length): no-op, existing file untouched;
 * - different bytes for the same version: throw, existing file untouched.
 */
export async function commitImmutableArtifact(partPath: string, finalPath: string): Promise<CommitResult> {
  let existing: { sha256: string; bytes: number } | null = null;
  try { existing = await sha256File(finalPath); } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error;
  }
  if (!existing) {
    await rename(partPath, finalPath);
    return 'written';
  }
  const fresh = await sha256File(partPath);
  await rm(partPath, { force: true });
  if (fresh.sha256 === existing.sha256 && fresh.bytes === existing.bytes) return 'noop';
  throw new Error(`Immutable artifact drift: ${finalPath} already exists for this version with sha256 ${existing.sha256} (${existing.bytes} bytes) but the rebuild produced ${fresh.sha256} (${fresh.bytes} bytes). Use a new --version; existing file left untouched.`);
}
