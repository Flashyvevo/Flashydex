import { expect, test } from '@playwright/test';
import { onboardAndInstall } from './helpers';

interface Manifest {
  languages: Record<string, { targetVersion: string; sha256: string; compressedSha256?: string }>;
}

test('a failed English update is shown on the English row only; the Japanese row is untouched', async ({ page }) => {
  await onboardAndInstall(page);
  await page.route('**/dev-packs/catalog-manifest.json', async (route) => {
    const manifest = (await (await route.fetch()).json()) as Manifest;
    (manifest as unknown as { targetVersion: string }).targetVersion = '2026.11.30.001';
    manifest.languages.en!.targetVersion = '2026.11.30.001'; // newer than installed → "Update"
    manifest.languages.en!.sha256 = '0'.repeat(64); // corrupt pack
    manifest.languages.en!.compressedSha256 = '0'.repeat(64);
    await route.fulfill({ json: manifest });
  });
  await page.goto('/settings/catalog');
  const en = page.getByTestId('catalog-download-en');
  const ja = page.getByTestId('catalog-download-ja');
  await expect(en).toContainText('Update');
  await expect(ja).toHaveText('Download');
  await en.click();
  await expect(en).toHaveText('Retry', { timeout: 60_000 });
  await expect(page.getByTestId('catalog-language-en')).toContainText('Your current catalog is unchanged');
  await expect(ja).toHaveText('Download');
  await expect(page.getByTestId('catalog-language-ja')).not.toContainText('Your current catalog is unchanged');
  await expect(page.getByTestId('catalog-language-ja')).not.toContainText('damaged');
});
