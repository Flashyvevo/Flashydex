import { mkdir } from 'node:fs/promises';
import { resolve } from 'node:path';
import sharp from 'sharp';

const mark = `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 512 512">
  <rect width="512" height="512" rx="112" fill="#101114"/>
  <path d="M100 346 256 82l156 264H100Z" fill="#6ee7b7"/>
  <path d="m256 82 156 264H256V82Z" fill="#38bdf8" opacity=".9"/>
  <path d="M174 370h164" stroke="#f8fafc" stroke-width="24" stroke-linecap="round"/>
</svg>`;
const iconDirectory = resolve('apps/mobile/public/icons');
await mkdir(iconDirectory, { recursive: true });
for (const size of [192, 512]) {
  await sharp(Buffer.from(mark)).resize(size, size).png().toFile(resolve(iconDirectory, `icon-${size}.png`));
}
console.log('Generated abstract FlashyDex PWA icons.');
