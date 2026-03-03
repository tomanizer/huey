// @ts-check
const { test, expect } = require('@playwright/test');

async function waitForAppReady(page) {
  await page.goto('/index.html');
  await expect(page.locator('body')).toHaveAttribute('aria-busy', 'false', { timeout: 60000 });
}

test.describe('Error handling', () => {
  test('renders error dialog for thrown errors', async ({ page }) => {
    await waitForAppReady(page);

    await page.evaluate(() => {
      // @ts-ignore
      window.showErrorDialog(new Error('Simulated failure for testing'));
    });

    const dialog = page.locator('#errorDialog');
    await expect(dialog).toBeVisible({ timeout: 5000 });
    await expect(dialog.locator('#errorDialogTitle')).toContainText(/Simulated failure/);

    await page.click('#errorDialogOkButton');
    await expect(dialog).not.toBeVisible();
  });
});
