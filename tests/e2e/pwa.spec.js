import { test, expect } from '@playwright/test';

test.describe('PWA support', () => {
  test('exposes a web app manifest', async ({ page }) => {
    await page.goto('/');

    await expect(page.locator('link[rel="manifest"]')).toHaveAttribute('href', 'manifest.webmanifest');

    const manifest = await page.evaluate(async () => {
      const response = await fetch('/manifest.webmanifest');
      return response.json();
    });

    expect(manifest.name).toBe('TottiLooper');
    expect(manifest.display).toBe('standalone');
    expect(manifest.icons).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ src: 'icons/icon-192.png', sizes: '192x192' }),
        expect.objectContaining({ src: 'icons/icon-512.png', sizes: '512x512' }),
      ]),
    );
  });

  test('registers a service worker and serves cached assets offline', async ({ page, context }) => {
    await page.goto('/');

    await expect.poll(async () => page.evaluate(async () => {
      if (!('serviceWorker' in navigator)) {
        return false;
      }

      const registration = await navigator.serviceWorker.ready;
      return registration.active?.scriptURL.endsWith('/service-worker.js') ?? false;
    })).toBe(true);

    await expect.poll(async () => page.evaluate(() => navigator.serviceWorker.controller !== null)).toBe(true);

    await context.setOffline(true);

    const offlineAssets = await page.evaluate(async () => {
      const [documentResponse, scriptResponse] = await Promise.all([
        fetch('/index.html'),
        fetch('/src/app.js'),
      ]);

      return {
        documentOk: documentResponse.ok,
        scriptOk: scriptResponse.ok,
        documentHtml: await documentResponse.text(),
        scriptSource: await scriptResponse.text(),
      };
    });

    expect(offlineAssets.documentOk).toBe(true);
    expect(offlineAssets.scriptOk).toBe(true);
    expect(offlineAssets.documentHtml).toContain('TottiLooper');
    expect(offlineAssets.scriptSource).toContain("navigator.serviceWorker.register('/service-worker.js')");
  });
});
