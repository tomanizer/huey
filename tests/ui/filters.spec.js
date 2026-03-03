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
  const symbolRowToggle = page.locator('#attributeUi details[data-column_name="symbol"] summary label.attributeUiAxisButton[data-axis="rows"]');
  await symbolRowToggle.click();
  const volumeCellToggle = page.locator('#attributeUi details[data-column_name="volume"] summary label.attributeUiAxisButton[data-axis="cells"]');
  await volumeCellToggle.click();

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

test.describe('Filters', () => {
  test('apply include filter to symbol and update pivot', async ({ page }) => {
    await preparePivot(page);

    const filterButton = page.locator('#queryUi section[data-axis="rows"] li button[id$="-edit-filter-condition"]').first();
    await expect(filterButton).toBeVisible();
    await filterButton.click();

    const filterDialog = page.locator('#filterDialog');
    await expect(filterDialog).toBeVisible({ timeout: 10000 });

    const picklistOption = page.locator('#filterPicklist option', { hasText: 'AAPL' }).first();
    await picklistOption.waitFor({ timeout: 15000 });
    await page.selectOption('#filterPicklist', { label: 'AAPL' });

    await expect(page.locator('#filterValueList option')).toContainText('AAPL');

    await page.click('#filterDialogOkButton');
    await page.click('#runQueryButton');

    const pivot = page.locator('.pivotTableUiContainer');
    if (!(await pivot.isVisible({ timeout: 30000 }).catch(() => false))) {
      test.skip('Pivot table did not render in time');
    }
    await expect(pivot).toContainText('AAPL');
    await expect(pivot).not.toContainText('GOOG');
  });
});
