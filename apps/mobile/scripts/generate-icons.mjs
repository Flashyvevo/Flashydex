// Generates PWA/favicon/apple-touch icons from the owner's brand icon
// (apps/mobile/src/assets/brand/app-icon.png). Runs on postinstall; idempotent.
import { mkdir, access } from 'node:fs/promises';
import { resolve } from 'node:path';
import sharp from 'sharp';

const root = resolve('apps/mobile');
const source = resolve(root, 'src/assets/brand/app-icon.png');
const publicDir = resolve(root, 'public');
const iconDirectory = resolve(publicDir, 'icons');
const BG = { r: 10, g: 12, b: 10, alpha: 1 };
const CLEAR = { r: 0, g: 0, b: 0, alpha: 0 };

try {
  await access(source);
} catch {
  console.warn('[icons] brand icon missing at', source, '- skipping icon generation');
  process.exit(0);
}
await mkdir(iconDirectory, { recursive: true });

/** Fit the mark into a square; pad = fraction of each edge kept clear (maskable safe zone). */
async function square(size, { pad = 0, background = CLEAR, out }) {
  const inner = Math.round(size * (1 - 2 * pad));
  const mark = await sharp(source).resize(inner, inner, { fit: 'contain', background: CLEAR }).png().toBuffer();
  await sharp({ create: { width: size, height: size, channels: 4, background } })
    .composite([{ input: mark, gravity: 'centre' }])
    .png()
    .toFile(out);
}

for (const size of [192, 512]) {
  await square(size, { out: resolve(iconDirectory, `icon-${size}.png`) });
  await square(size, { pad: 0.12, background: BG, out: resolve(iconDirectory, `maskable-${size}.png`) });
}
await square(180, { background: BG, out: resolve(publicDir, 'apple-touch-icon.png') }); // iOS ignores alpha
await square(64, { out: resolve(publicDir, 'favicon.png') });
await square(32, { out: resolve(publicDir, 'favicon-32.png') });
console.log('Generated FlashyDex icons from the brand mark.');
