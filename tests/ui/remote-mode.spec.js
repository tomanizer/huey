// @ts-check
const { test, expect } = require('@playwright/test');

test.describe('Remote mode UI', () => {
  test('Huey app loads and shows main UI', async ({ page }) => {
    await page.goto('/index.html');
    await expect(page).toHaveTitle(/Huey/);
    // Toolbar / main app area is present
    await expect(page.locator('body')).toBeVisible();
    // Datasources or work area
    const main = page.locator('#workarea, [role="main"], .sidebar').first();
    await expect(main).toBeVisible({ timeout: 10000 });
  });
});
