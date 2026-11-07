import type { Page } from '@playwright/test';

export type Scene = 'good' | 'glare' | 'blur' | 'dark' | 'blank' | 'denied' | 'missing';

declare global {
  interface Window {
    __fdxScene: Scene;
    __fdxFakeCamera: () => Promise<MediaStream>;
    __fdxTracks: MediaStreamTrack[];
    __fdxOpens: number;
  }
}

/**
 * Installs `window.__fdxFakeCamera` (honoured by dev builds only): a canvas.captureStream() that draws a synthetic "card" —
 * a deterministic block texture (sharp, mid-brightness, no highlights). `window.__fdxScene` can be switched at any time:
 * glare = white ellipse over the centre, blur = the texture blurred, dark = near-black, blank = 0×0 canvas (iOS standalone
 * bug), denied/missing = getUserMedia rejects with NotAllowedError / NotFoundError.
 */
export async function installFakeCamera(page: Page, initial: Scene = 'good'): Promise<void> {
  await page.addInitScript((first) => {
    window.__fdxScene = first;
    window.__fdxTracks = [];
    window.__fdxOpens = 0;
    window.__fdxFakeCamera = async () => {
      window.__fdxOpens += 1;
      const scene = window.__fdxScene;
      if (scene === 'denied') throw new DOMException('Permission denied', 'NotAllowedError');
      if (scene === 'missing') throw new DOMException('Requested device not found', 'NotFoundError');
      const canvas = document.createElement('canvas');
      canvas.width = scene === 'blank' ? 0 : 640;
      canvas.height = scene === 'blank' ? 0 : 480;
      const ctx = canvas.getContext('2d')!;
      let seed = 7;
      const rnd = () => (seed = (seed * 1664525 + 1013904223) >>> 0) / 4294967296;
      const cells: number[] = [];
      for (let i = 0; i < 54 * 40; i++) cells.push(Math.round(55 + rnd() * 115));
      let frame = 0;
      const off = document.createElement('canvas');
      off.width = 640;
      off.height = 480;
      const octx = off.getContext('2d')!;
      const texture = () => {
        for (let y = 0; y < 40; y++) for (let x = 0; x < 54; x++) {
          const v = cells[y * 54 + x]!;
          octx.fillStyle = `rgb(${v},${Math.round(v * 0.9)},${Math.round(v * 0.8)})`;
          octx.fillRect(x * 12, y * 12, 12, 12);
        }
      };
      const draw = () => {
        frame++;
        const s = window.__fdxScene;
        if (canvas.width === 0) return;
        texture();
        ctx.fillStyle = '#6e6458';
        ctx.fillRect(0, 0, 640, 480);
        ctx.filter = s === 'blur' ? 'blur(16px)' : 'none';
        ctx.drawImage(off, 0, 0);
        ctx.filter = 'none';
        if (s === 'dark') {
          ctx.fillStyle = 'rgba(0,0,0,0.93)';
          ctx.fillRect(0, 0, 640, 480);
        }
        if (s === 'glare') {
          ctx.fillStyle = '#fff';
          ctx.beginPath();
          ctx.ellipse(320, 240, 110, 90, 0, 0, Math.PI * 2);
          ctx.fill();
        }
        ctx.fillStyle = frame % 2 ? '#222' : '#333'; // keeps the stream emitting frames
        ctx.fillRect(0, 0, 2, 2);
      };
      draw();
      const timer = setInterval(draw, 66);
      const stream = canvas.captureStream(15);
      for (const t of stream.getTracks()) {
        window.__fdxTracks.push(t);
        t.addEventListener('ended', () => clearInterval(timer));
        const stop = t.stop.bind(t);
        t.stop = () => {
          clearInterval(timer);
          stop();
        };
      }
      return stream;
    };
  }, initial);
}

export const setScene = (page: Page, scene: Scene) => page.evaluate((s) => void (window.__fdxScene = s), scene);
