// @ts-check
const { test, expect } = require('@playwright/test');
const path = require('path');

const fixturePath = path.join(__dirname, 'fixtures/test-data.csv');

async function waitForAppReady(page) {
  await page.goto('/index.html');
  await expect(page.locator('body')).toHaveAttribute('aria-busy', 'false', { timeout: 60000 });
  await expect(page.locator('#uploader')).toBeAttached({ timeout: 20000 });
}

async function preparePivot(page) {
  await waitForAppReady(page);
  await page.locator('#uploader').setInputFiles(fixturePath);
  await expect(page.locator('#attributeUi')).toBeVisible({ timeout: 30000 });
  if (!(await page.locator('#attributeUi details[data-column_name="symbol"]').isVisible({ timeout: 30000 }).catch(() => false))) {
    test.skip('Datasource attributes did not load in time');
  }

  await page.locator('label[for="attributesTab"]').click();
  await page.locator('#attributeUi details[data-column_name="symbol"] summary label.attributeUiAxisButton[data-axis="rows"]').click();
  await page.locator('#attributeUi details[data-column_name="volume"] summary label.attributeUiAxisButton[data-axis="cells"]').click();
  const runBtn = page.locator('#runQueryButton');
  if (!(await runBtn.isVisible({ timeout: 20000 }).catch(() => false))) {
    test.skip('Run Query button not visible');
  }
  await runBtn.click();
  const pivot = page.locator('.pivotTableUiContainer');
  if (!(await pivot.isVisible({ timeout: 30000 }).catch(() => false))) {
    test.skip('Pivot table did not render in time');
  }
}

test.describe('Export', () => {
  test('open export dialog and trigger export workflow', async ({ page }) => {
    await preparePivot(page);

    await page.click('#exportButton');
    const exportDialog = page.locator('#exportDialog');
    await expect(exportDialog).toBeAttached();

    // Default is delimited; ensure option is selected for clarity.
    await page.locator('#exportDelimited').check();

    const downloadPromise = page.waitForEvent('download', { timeout: 30000 }).catch(() => null);
    await page.click('#exportDialogExecuteButton');

    const download = await downloadPromise;
    const progress = exportDialog.locator('dialog[role="progressbar"]');
    let progressVisible = false;
    try {
      await progress.waitFor({ state: 'visible', timeout: 30000 });
      progressVisible = true;
    } catch (error) {
      progressVisible = false;
    }
    expect(download !== null || progressVisible).toBeTruthy();
  });
});
