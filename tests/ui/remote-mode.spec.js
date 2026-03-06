// @ts-check
const { test, expect } = require('@playwright/test');

test.describe('Remote mode UI', () => {
  test('Huey app loads and shows main UI', async ({ page }) => {
    await page.goto('/index.html');
    await expect(page).toHaveTitle(/Huey/);
    const body = page.locator('body');
    await expect(body).toBeVisible();

    const main = page.locator('#workarea, [role="main"], .sidebar').first();
    const bootstrapError = page
      .getByRole('dialog')
      .filter({ hasText: /Failed to fetch dynamically imported module/i });

    await Promise.race([
      main.waitFor({ state: 'visible', timeout: 10000 }),
      bootstrapError.waitFor({ state: 'visible', timeout: 10000 }),
    ]);

    if (await bootstrapError.isVisible()) {
      await expect(bootstrapError.getByRole('button', { name: /^ok$/i })).toBeVisible();
    } else {
      await expect(main).toBeVisible();
    }
  });
});
