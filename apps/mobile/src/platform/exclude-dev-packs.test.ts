// @vitest-environment node
import { existsSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { excludeDevPacks } from '../../scripts/exclude-dev-packs';

const dirs: string[] = [];
afterEach(() => { while (dirs.length) rmSync(dirs.pop() as string, { recursive: true, force: true }); });

function fakeDist() {
  const dir = mkdtempSync(join(tmpdir(), 'fdx-dist-'));
  dirs.push(dir);
  mkdirSync(join(dir, 'dev-packs'));
  writeFileSync(join(dir, 'dev-packs', 'catalog-manifest.json'), '{}');
  writeFileSync(join(dir, 'index.html'), '<html></html>');
  return dir;
}
const run = async (dir: string, keep?: boolean) => {
  const plugin = excludeDevPacks({ keep }) as unknown as { writeBundle: (this: unknown, o: { dir: string }) => Promise<void> };
  await plugin.writeBundle.call({}, { dir });
};

describe('D27: dev packs are excluded from production builds', () => {
  it('removes <outDir>/dev-packs and keeps the rest of the build', async () => {
    const dir = fakeDist();
    await run(dir);
    expect(existsSync(join(dir, 'dev-packs'))).toBe(false);
    expect(existsSync(join(dir, 'index.html'))).toBe(true);
  });
  it('only applies to `vite build`, runs before the PWA plugin scan, and can be kept explicitly', async () => {
    const plugin = excludeDevPacks();
    expect(plugin.apply).toBe('build');
    expect(plugin.enforce).toBe('pre');
    const dir = fakeDist();
    await run(dir, true);
    expect(existsSync(join(dir, 'dev-packs'))).toBe(true);
  });
});
