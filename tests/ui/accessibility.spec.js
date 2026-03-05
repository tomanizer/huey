// @ts-check
const { test, expect } = require('@playwright/test');
const { waitForAppReady } = require('./helpers/app-bootstrap');

test.describe('Accessibility and keyboard', () => {
  test('keyboard can open settings dialog and escape returns focus', async ({ page }) => {
    await waitForAppReady(page);
    const settingsButton = page.locator('#settingsButton');
    await settingsButton.focus();
    await page.keyboard.press('Enter');
    await expect(page.locator('#settingsDialog')).toBeVisible({ timeout: 10000 });
    await page.keyboard.press('Escape');
    await expect(page.locator('#settingsDialog')).not.toBeVisible();
    await expect(settingsButton).toBeFocused();
  });

  test('interactive dialogs expose required aria relationships', async ({ page }) => {
    await waitForAppReady(page);

    await page.evaluate(() => {
      // @ts-ignore
      window.showErrorDialog(new Error('Accessibility check'));
    });

    const dialog = page.locator('#errorDialog');
    await expect(dialog).toBeVisible({ timeout: 5000 });
    await expect(dialog).toHaveAttribute('aria-labelledby', 'errorDialogTitle');
    await expect(dialog).toHaveAttribute('aria-describedby', 'errorDialogDescription');
    await expect(page.locator('#errorDialogTitle')).toContainText('Accessibility check');
  });
});
