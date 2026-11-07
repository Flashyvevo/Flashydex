// Generates the scanner e2e fixtures with NO image libraries: Playwright's Chromium draws to a canvas and encodes JPEG.
//   node e2e/fixtures/scanner/make.mjs            (from apps/mobile; downloads 5 TCGdex references on first run, cached in ./ref)
// Outputs into this directory:
//   ref/<id>.webp   downloaded reference art (cached)
//   <id>__ref.jpg   the reference image, JPEG-encoded, unmodified
//   <id>__rot90.jpg | __rot180.jpg | __glare.jpg | __blur.jpg | __sleeve.jpg   photo-like transforms on a grey table
//   unsupported.jpg a text file renamed .jpg
//   manifest.json   [{ id, name, file, transform }]
import { mkdir, writeFile, readFile, access } from 'node:fs/promises';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { chromium } from '@playwright/test';

const here = dirname(fileURLToPath(import.meta.url));

/** Reference cards (Darkness Ablaze, English). `id` is the catalog card id the service must return. */
export const REFERENCE_CARDS = [
  { id: 'swsh3-19', name: 'Charizard V', url: 'https://assets.tcgdex.net/en/swsh/swsh3/19/high.webp' },
  { id: 'swsh3-20', name: 'Charizard VMAX', url: 'https://assets.tcgdex.net/en/swsh/swsh3/20/high.webp' },
  { id: 'swsh3-136', name: 'Furret', url: 'https://assets.tcgdex.net/en/swsh/swsh3/136/high.webp' },
  { id: 'swsh3-33', name: 'Dedenne', url: 'https://assets.tcgdex.net/en/swsh/swsh3/33/high.webp' },
  { id: 'swsh3-84', name: 'Rillaboom', url: 'https://assets.tcgdex.net/en/swsh/swsh3/84/high.webp' }
];
export const TRANSFORMS = ['rot90', 'rot180', 'glare', 'blur', 'sleeve'];

const exists = (p) => access(p).then(() => true, () => false);

async function download(url, file) {
  if (await exists(file)) return readFile(file);
  const res = await fetch(url);
  if (!res.ok) throw new Error(`download ${url}: HTTP ${res.status}`);
  const buf = Buffer.from(await res.arrayBuffer());
  await writeFile(file, buf);
  return buf;
}

/** Runs inside the page: returns { ref, rot90, ... } as base64 JPEGs. */
async function draw([b64, mime]) {
  const bytes = Uint8Array.from(atob(b64), (c) => c.charCodeAt(0));
  const bmp = await createImageBitmap(new Blob([bytes], { type: mime }));
  const toB64 = async (canvas) => {
    const blob = await new Promise((r) => canvas.toBlob(r, 'image/jpeg', 0.9));
    const u8 = new Uint8Array(await blob.arrayBuffer());
    let s = '';
    for (let i = 0; i < u8.length; i += 0x8000) s += String.fromCharCode(...u8.subarray(i, i + 0x8000));
    return btoa(s);
  };
  const mk = (w, h) => {
    const c = document.createElement('canvas');
    c.width = w;
    c.height = h;
    return [c, c.getContext('2d')];
  };
  const out = {};
  {
    const [c, ctx] = mk(bmp.width, bmp.height);
    ctx.fillStyle = '#fff';
    ctx.fillRect(0, 0, c.width, c.height);
    ctx.drawImage(bmp, 0, 0);
    out.ref = await toB64(c);
  }
  // "table" photo: card inset on grey, slightly smaller than the frame
  const pad = Math.round(bmp.width * 0.12);
  const W = bmp.width + pad * 2;
  const H = bmp.height + pad * 2;
  const table = (fn) => {
    const [c, ctx] = mk(W, H);
    ctx.fillStyle = '#7d7f84';
    ctx.fillRect(0, 0, W, H);
    fn(ctx);
    return c;
  };
  const plain = (ctx) => ctx.drawImage(bmp, pad, pad);
  const rotated = (deg) => {
    const rad = (deg * Math.PI) / 180;
    const swap = deg % 180 !== 0;
    const [c, ctx] = mk(swap ? H : W, swap ? W : H);
    ctx.translate(c.width / 2, c.height / 2);
    ctx.rotate(rad);
    ctx.drawImage(table(plain), -W / 2, -H / 2);
    return c;
  };
  out.rot90 = await toB64(rotated(90));
  out.rot180 = await toB64(rotated(180));
  out.glare = await toB64(
    table((ctx) => {
      plain(ctx);
      const g = ctx.createRadialGradient(W * 0.55, H * 0.35, 10, W * 0.55, H * 0.35, W * 0.45);
      g.addColorStop(0, 'rgba(255,255,255,0.92)');
      g.addColorStop(1, 'rgba(255,255,255,0)');
      ctx.fillStyle = g;
      ctx.fillRect(pad, pad, bmp.width, bmp.height);
    })
  );
  {
    const [c, ctx] = mk(W, H);
    ctx.filter = 'blur(3px)';
    ctx.drawImage(table(plain), 0, 0);
    out.blur = await toB64(c);
  }
  out.sleeve = await toB64(
    table((ctx) => {
      plain(ctx);
      ctx.fillStyle = 'rgba(255,255,255,0.10)'; // haze
      ctx.fillRect(pad, pad, bmp.width, bmp.height);
      const g = ctx.createLinearGradient(pad, pad, pad + bmp.width, pad + bmp.height);
      g.addColorStop(0.25, 'rgba(255,255,255,0)');
      g.addColorStop(0.45, 'rgba(255,255,255,0.45)');
      g.addColorStop(0.55, 'rgba(255,255,255,0.45)');
      g.addColorStop(0.75, 'rgba(255,255,255,0)');
      ctx.fillStyle = g;
      ctx.fillRect(pad, pad, bmp.width, bmp.height);
      ctx.strokeStyle = 'rgba(255,255,255,0.55)'; // sleeve edge, a few px outside the card
      ctx.lineWidth = 8;
      ctx.strokeRect(pad - 10, pad - 10, bmp.width + 20, bmp.height + 20);
    })
  );
  return out;
}

export async function generate(outDir = here) {
  await mkdir(join(outDir, 'ref'), { recursive: true });
  const browser = await chromium.launch();
  const manifest = [];
  try {
    const page = await browser.newPage();
    await page.goto('about:blank');
    for (const card of REFERENCE_CARDS) {
      const buf = await download(card.url, join(outDir, 'ref', `${card.id}.webp`));
      const variants = await page.evaluate(draw, [buf.toString('base64'), 'image/webp']);
      for (const [transform, b64] of Object.entries(variants)) {
        const file = `${card.id}__${transform}.jpg`;
        await writeFile(join(outDir, file), Buffer.from(b64, 'base64'));
        manifest.push({ id: card.id, name: card.name, file, transform });
      }
    }
  } finally {
    await browser.close();
  }
  await writeFile(join(outDir, 'unsupported.jpg'), 'This is a text file renamed .jpg — not an image.\n');
  await writeFile(join(outDir, 'manifest.json'), JSON.stringify(manifest, null, 2));
  return manifest;
}

if (process.argv[1] && fileURLToPath(import.meta.url) === process.argv[1]) {
  const m = await generate();
  console.log(`generated ${m.length} fixtures in ${here}`);
}
