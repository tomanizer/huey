// @ts-check
const { test, expect } = require('@playwright/test');
const { waitForAppReady } = require('./helpers/app-bootstrap');

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

  test('shows validation error for empty remote dataset prompt', async ({ page }) => {
    await waitForAppReady(page);

    await page.click('#addRemoteDatasource');
    await expect(page.locator('#remoteDatasourceBaseUrl')).toBeVisible({ timeout: 10000 });
    await page.click('#promptDialogAcceptButton');

    const dialog = page.locator('#errorDialog');
    await expect(dialog).toBeVisible({ timeout: 5000 });
    await expect(dialog.locator('#errorDialogTitle')).toContainText(/Invalid input/);
  });

  test('supports long error descriptions and closes with Escape', async ({ page }) => {
    await waitForAppReady(page);
    const longDescription = Array.from({ length: 40 }, (_, index) => `Error line ${index + 1}`).join('\n');

    await page.evaluate((description) => {
      // @ts-ignore
      window.showErrorDialog({
        title: 'Long error details',
        description,
      });
    }, longDescription);

    const dialog = page.locator('#errorDialog');
    await expect(dialog).toBeVisible({ timeout: 5000 });
    await expect(dialog.locator('#errorDialogDescription')).toContainText('Error line 1');
    await expect(dialog.locator('#errorDialogDescription')).toContainText('Error line 40');

    await page.keyboard.press('Escape');
    await expect(dialog).not.toBeVisible();
  });

  test('latest error message replaces previous error content', async ({ page }) => {
    await waitForAppReady(page);

    await page.evaluate(() => {
      // @ts-ignore
      window.showErrorDialog(new Error('First message'));
      // @ts-ignore
      window.showErrorDialog(new Error('Second message'));
    });

    const dialog = page.locator('#errorDialog');
    await expect(dialog).toBeVisible({ timeout: 5000 });
    await expect(dialog.locator('#errorDialogTitle')).toContainText(/Second message/);
    await expect(dialog.locator('#errorDialogTitle')).not.toContainText(/First message/);
    await expect(dialog.locator('#errorDialogDescription')).not.toContainText(/First message/);
  });
});
