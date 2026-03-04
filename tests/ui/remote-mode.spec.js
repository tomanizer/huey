// @ts-check
const { test, expect } = require('@playwright/test');
const { waitForAppReady } = require('./helpers/app-bootstrap');

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
