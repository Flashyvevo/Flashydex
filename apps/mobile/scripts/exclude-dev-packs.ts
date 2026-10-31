import { rm } from 'node:fs/promises';
import { join, resolve } from 'node:path';
import type { Plugin } from 'vite';

/**
 * D27: `public/dev-packs/` (dev catalog packs + metrics, hundreds of KB to MB) must never ship in a production build.
 * Vite copies `public/` into `outDir` before `writeBundle`; this plugin removes `<outDir>/dev-packs` right after the bundle is
 * written and BEFORE vite-plugin-pwa's `closeBundle` scans the output for its precache manifest, so the service worker never
 * precaches them either. Set FLASHYDEX_KEEP_DEV_PACKS=1 only for a deliberate local preview of the dev packs.
 */
export function excludeDevPacks(options: { keep?: boolean } = {}): Plugin {
  let outDir = 'dist';
  return {
    name: 'flashydex:exclude-dev-packs',
    apply: 'build',
    enforce: 'pre',
    configResolved(config) {
      outDir = resolve(config.root, config.build.outDir);
    },
    async writeBundle(output) {
      if (options.keep ?? process.env.FLASHYDEX_KEEP_DEV_PACKS === '1') return;
      const target = output.dir ? resolve(output.dir) : outDir;
      await rm(join(target, 'dev-packs'), { recursive: true, force: true });
    }
  };
}
