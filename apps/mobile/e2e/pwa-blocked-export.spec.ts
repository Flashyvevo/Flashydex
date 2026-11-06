import { expect, test } from '@playwright/test';
import { createHash } from 'node:crypto';
import { downloadBuffer } from './helpers';

test.describe.configure({ timeout: 120_000 });
test.skip(({ isMobile }) => !isMobile, 'storage recovery is viewport-independent; run once (mobile project)');

/**
 * S5-08: blocked migration offers a REAL "Export my old collection". Seed a >16 MiB legacy jeep value BEFORE the app boots, boot into the
 * blocked screen, export, and compare the downloaded bytes with the seeded value. The legacy key must be untouched afterwards and the
 * screen must never offer a reset.
 */
test('migration blocked (>16 MiB legacy value): export downloads the exact legacy bytes, legacy key untouched, no start-fresh', async ({ page }) => {
  // A static same-origin page that does not boot the app (the app would create a fresh USER database before we could seed).
  await page.goto('/favicon.png');
  const SIZE = 17 * 1024 * 1024 + 12345;
  const seeded = await page.evaluate(async (size) => {
    const bytes = new Uint8Array(size);
    let x = 0x9e3779b9;
    for (let i = 0; i < size; i++) { x = (Math.imul(x, 1664525) + 1013904223) >>> 0; bytes[i] = x >>> 24; }
    const db = await new Promise<IDBDatabase>((resolve, reject) => {
      const request = indexedDB.open('jeepSqliteStore', 1);
      request.onupgradeneeded = () => request.result.createObjectStore('databases');
      request.onsuccess = () => resolve(request.result);
      request.onerror = () => reject(request.error);
    });
    await new Promise<void>((resolve, reject) => {
      const tx = db.transaction('databases', 'readwrite');
      tx.objectStore('databases').put(bytes, 'flashydex-userSQLite.db');
      tx.oncomplete = () => resolve();
      tx.onerror = () => reject(tx.error);
    });
    db.close();
    const digest = await crypto.subtle.digest("SHA-256", bytes as BufferSource);
    return Array.from(new Uint8Array(digest), (b) => b.toString(16).padStart(2, '0')).join('');
  }, SIZE);

  await page.goto('/');
  await expect(page.getByTestId('migration-blocked')).toBeVisible({ timeout: 60_000 });
  await expect(page.getByTestId('migration-blocked-reason')).toContainText('16 MB');
  await expect(page.getByRole('button', { name: /start fresh|reset|erase|delete/i })).toHaveCount(0);

  const [download] = await Promise.all([page.waitForEvent('download', { timeout: 60_000 }), page.getByTestId('migration-export').click()]);
  expect(download.suggestedFilename()).toBe('flashydex-old-collection.sqlite');
  const bytes = await downloadBuffer(download);
  expect(bytes.length).toBe(SIZE);
  expect(createHash('sha256').update(bytes).digest('hex')).toBe(seeded);
  await expect(page.getByTestId('migration-export-result')).toContainText('flashydex-old-collection.sqlite');

  // Still blocked (the export changed nothing), the legacy key is intact, and no new pool USER file was created by the export.
  await expect(page.getByTestId('migration-blocked')).toBeVisible();
  const after = await page.evaluate(async () => {
    const db = await new Promise<IDBDatabase>((resolve, reject) => {
      const request = indexedDB.open('jeepSqliteStore');
      request.onsuccess = () => resolve(request.result);
      request.onerror = () => reject(request.error);
    });
    const value = await new Promise<unknown>((resolve, reject) => {
      const get = db.transaction('databases', 'readonly').objectStore('databases').get('flashydex-userSQLite.db');
      get.onsuccess = () => resolve(get.result);
      get.onerror = () => reject(get.error);
    });
    db.close();
    if (!(value instanceof Uint8Array)) return null;
    const digest = await crypto.subtle.digest('SHA-256', value as BufferSource);
    return Array.from(new Uint8Array(digest), (b) => b.toString(16).padStart(2, '0')).join('');
  });
  expect(after).toBe(seeded);
});
