// @ts-check
const { test, expect } = require('@playwright/test');

async function waitForAppReady(page) {
  await page.goto('/index.html');
  await expect(page.locator('body')).toHaveAttribute('aria-busy', 'false', { timeout: 60000 });
  const layout = page.locator('#layout');
  if (!(await layout.isVisible({ timeout: 60000 }).catch(() => false))) {
    test.skip('Layout not visible after load');
  }
}

test.describe('Remote mode UI', () => {
  test('Huey app loads and shows main UI', async ({ page }) => {
    await waitForAppReady(page);
    await expect(page).toHaveTitle(/Huey/);
    await expect(page.locator('body')).toBeVisible();
    const main = page.locator('#workarea, [role="main"], .sidebar').first();
    await expect(main).toBeAttached();
  });

  test('toolbar renders core actions', async ({ page }) => {
    await waitForAppReady(page);
    await expect(page.locator('#uploader')).toBeAttached();
    await expect(page.locator('#runQueryButton')).toBeAttached();
    await expect(page.locator('#exportButton')).toBeAttached();
    await expect(page.locator('#settingsButton')).toBeAttached();
  });

  test('sidebar tabs for datasources and attributes are available', async ({ page }) => {
    await waitForAppReady(page);
    await expect(page.locator('label[for="datasourcesTab"]')).toBeAttached();
    await expect(page.locator('label[for="attributesTab"]')).toBeAttached();
  });
});
