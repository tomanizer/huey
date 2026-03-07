// @ts-check
const { test, expect } = require('@playwright/test');
const path = require('path');
const {
  uploadFixtureAndWaitForAttributes,
  addBasicPivotAxes,
  runQueryAndWaitForPivot,
} = require('./helpers/app-bootstrap');

const fixturePath = path.join(__dirname, 'fixtures/test-data.csv');

async function preparePivot(page) {
  await uploadFixtureAndWaitForAttributes(page, fixturePath);
  await addBasicPivotAxes(page);
  await runQueryAndWaitForPivot(page);
}

test.describe('Export', () => {
  test('open export dialog and trigger export workflow', async ({ page }) => {
    await preparePivot(page);

    await page.evaluate(() => {
      const exportButton = document.getElementById('exportButton');
      if (exportButton) {
        exportButton.click();
      }
    });
    const exportDialog = page.locator('#exportDialog');
    await expect(exportDialog).toBeVisible({ timeout: 20000 });

    await expect(page.locator('#exportParquet')).toBeAttached();
    await expect(page.locator('#exportSqlite')).toBeAttached();
    await expect(page.locator('#exportDuckdb')).toBeAttached();

    // Default is delimited; ensure option is selected for clarity.
    await page.locator('#exportDelimited').check();

    const executeButton = page.locator('#exportDialogExecuteButton');
    await expect(executeButton).toBeVisible({ timeout: 10000 });
    await executeButton.click();
    await expect(exportDialog).toBeAttached();
  });
});
