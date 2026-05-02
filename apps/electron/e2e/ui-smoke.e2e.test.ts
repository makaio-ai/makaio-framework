import { expect, test } from '@playwright/test';

test.describe('electron renderer', () => {
  test('loads and renders the app shell', async ({ page }) => {
    await page.goto('/');
    // Framework-only Electron renders the framework shell when no host
    // browser contribution is present.
    const appRoot = page.locator('[data-component="FrameworkShell"]');
    await expect(appRoot).toBeVisible({ timeout: 15_000 });
  });

  test('connects to bus and receives boot progress', async ({ page }) => {
    const consoleMessages: string[] = [];
    page.on('console', (msg) => consoleMessages.push(msg.text()));

    await page.goto('/');
    const appRoot = page.locator('[data-component="FrameworkShell"]');
    await expect(appRoot).toBeVisible({ timeout: 15_000 });

    // Bus messages arrive asynchronously — poll until [state] appears rather
    // than checking synchronously after page load.
    await expect
      .poll(() => consoleMessages.some((m) => m.includes('[state]')), {
        timeout: 15_000,
      })
      .toBe(true);
  });
});
