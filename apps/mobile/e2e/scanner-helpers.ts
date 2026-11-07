import { expect, type Page, type Route } from '@playwright/test';

export const VIEWPORTS = [
  { width: 375, height: 812 },
  { width: 390, height: 844 },
  { width: 430, height: 932 }
] as const;

/** A real JPEG drawn by the page itself (no image deps in Node): flat colour + big label so decode/resize/encode are exercised. */
export async function makeJpeg(page: Page, opts: { width?: number; height?: number; label?: string; color?: string } = {}): Promise<Buffer> {
  const b64 = await page.evaluate(async ({ width, height, label, color }) => {
    const c = document.createElement('canvas');
    c.width = width;
    c.height = height;
    const ctx = c.getContext('2d')!;
    ctx.fillStyle = color;
    ctx.fillRect(0, 0, width, height);
    ctx.fillStyle = '#fff';
    ctx.font = `${Math.round(width / 6)}px sans-serif`;
    ctx.fillText(label, 20, height / 2);
    const blob: Blob = await new Promise((resolve) => c.toBlob((b) => resolve(b!), 'image/jpeg', 0.9));
    const bytes = new Uint8Array(await blob.arrayBuffer());
    let s = '';
    for (const byte of bytes) s += String.fromCharCode(byte);
    return btoa(s);
  }, { width: opts.width ?? 630, height: opts.height ?? 880, label: opts.label ?? 'CARD', color: opts.color ?? '#357' });
  return Buffer.from(b64, 'base64');
}

export const JPEG_FILE = (buffer: Buffer) => ({ name: 'card.jpg', mimeType: 'image/jpeg', buffer });

/** 1×1 PNG: card art is not under test; keeps the suite offline-safe and deterministic. */
const PNG_1PX = Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNkYPhfDwAChwGA60e6kgAAAABJRU5ErkJggg==', 'base64');
export async function mockCardArt(page: Page): Promise<void> {
  await page.route('https://assets.tcgdex.net/**', (route) => route.fulfill({ status: 200, contentType: 'image/png', body: PNG_1PX }));
}

export type Cand = { language?: 'en' | 'ja'; cardId: string; localId: string; name: string; setId?: string; setName?: string; score?: number; variantHints?: Record<string, number> };
const cand = (c: Cand) => ({
  language: c.language ?? 'en',
  cardId: c.cardId,
  localId: c.localId,
  name: c.name,
  setId: c.setId ?? c.cardId.split('-')[0],
  setName: c.setName ?? 'Darkness Ablaze',
  imageUrl: `https://assets.tcgdex.net/${c.language ?? 'en'}/swsh/swsh3/${c.localId}/low.webp`,
  score: c.score ?? 0.95,
  signals: { hash: 0.9, embed: 0.9, ocr: null, symbol: null },
  variantHints: c.variantHints ?? {}
});
export const recognition = (status: 'match' | 'candidates' | 'no_card' | 'no_match', candidates: Cand[] = [], confidence = 0.9) => ({
  status,
  confidence,
  candidates: candidates.map(cand),
  timingMs: { total: 123.4 },
  indexVersion: 'test-1'
});

export const CHARIZARD_V: Cand = { cardId: 'swsh3-19', localId: '19', name: 'Charizard V', score: 0.92 };
export const FURRET: Cand = { cardId: 'swsh3-136', localId: '136', name: 'Furret', score: 0.81 };
export const VMAX: Cand = { cardId: 'swsh3-20', localId: '20', name: 'Charizard VMAX', score: 0.68 };

export type Responder = { next: (() => Promise<unknown> | unknown) | null; calls: number; lastBody: Buffer | null; lastHeaders: Record<string, string> };
export type MockReply = { status?: number; json: unknown; headers?: Record<string, string>; delayMs?: number } | 'abort' | 'hang';

/** Routes `/api/identify`; set `responder.reply` before each scan. */
export async function mockIdentify(page: Page): Promise<{ reply: MockReply; calls: number; lastBody: Buffer | null; lastHeaders: Record<string, string> }> {
  const state = { reply: { json: recognition('no_match') } as MockReply, calls: 0, lastBody: null as Buffer | null, lastHeaders: {} as Record<string, string> };
  await page.route('**/api/identify', async (route: Route) => {
    state.calls++;
    state.lastBody = route.request().postDataBuffer();
    state.lastHeaders = route.request().headers();
    const r = state.reply;
    if (r === 'abort') return route.abort('connectionrefused');
    if (r === 'hang') return; // never answers; the client times out or the user cancels
    if (r.delayMs) await new Promise((res) => setTimeout(res, r.delayMs));
    return route.fulfill({ status: r.status ?? 200, contentType: 'application/json', headers: r.headers ?? {}, body: JSON.stringify(r.json) });
  });
  return state;
}

export async function mockHealth(page: Page, ok: boolean): Promise<void> {
  await page.route('**/api/recognizer/health', (route) => (ok ? route.fulfill({ status: 200, contentType: 'application/json', body: JSON.stringify({ ok: true, indexCounts: { en: 1 }, version: 'test', latencyMs: 1 }) }) : route.fulfill({ status: 502, contentType: 'application/json', body: JSON.stringify({ error: { code: 'RECOGNIZER_OFFLINE', message: 'offline', retryable: true } }) })));
}

export const errorJson = (code: string, retryable = true) => ({ error: { code, message: code, retryable } });

export async function assertNoOverflow(page: Page): Promise<void> {
  const m = await page.evaluate(() => ({ scrollWidth: document.documentElement.scrollWidth, innerWidth: window.innerWidth }));
  expect(m.scrollWidth, `horizontal overflow: scrollWidth ${m.scrollWidth} > innerWidth ${m.innerWidth}`).toBeLessThanOrEqual(m.innerWidth);
}

/** Every visible button/link inside <main> must be ≥ 44 px tall (UX.md tap-target rule). */
export async function assertTapTargets(page: Page, scope = 'main'): Promise<void> {
  const small = await page.evaluate((sel) => {
    const out: string[] = [];
    for (const el of document.querySelectorAll(`${sel} button, ${sel} a, ${sel} [role=button]`)) {
      const r = (el as HTMLElement).getBoundingClientRect();
      if (r.width === 0 || r.height === 0) continue;
      if (getComputedStyle(el).visibility === 'hidden') continue;
      if (r.height < 43.5) out.push(`${(el.getAttribute('data-testid') ?? el.textContent ?? '').trim().slice(0, 30)} ${Math.round(r.width)}x${Math.round(r.height)}`);
    }
    return out;
  }, scope);
  expect(small, 'tap targets under 44 px').toEqual([]);
}

/** Submit a photo from whichever capture surface is showing: the landing page input, or "Try another photo" (file chooser from the Take Photo input). */
export async function submitPhoto(page: Page, buffer: Buffer): Promise<void> {
  // Right after a navigation neither surface may be rendered yet; isVisible() does not wait, so wait for one of them first.
  await page.getByTestId('scan-capture').or(page.getByTestId('scan-try-another')).first().waitFor({ state: 'visible' });
  if (await page.getByTestId('scan-capture').isVisible()) {
    await page.getByTestId('scan-choose-input').setInputFiles(JPEG_FILE(buffer));
    return;
  }
  const [chooser] = await Promise.all([page.waitForEvent('filechooser'), page.getByTestId('scan-try-another').click()]);
  await chooser.setFiles(JPEG_FILE(buffer));
}

export async function rect(page: Page, testId: string, nth = 0) {
  const box = await page.getByTestId(testId).nth(nth).boundingBox();
  if (!box) throw new Error(`no box for ${testId}[${nth}]`);
  return box;
}
