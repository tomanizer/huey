// @ts-check
const { test, expect } = require('@playwright/test');
const path = require('path');
const {
  uploadFixtureAndWaitForAttributes,
  addBasicPivotAxes,
  addSymbolFilterAxis,
  runQueryAndWaitForPivot,
} = require('./helpers/app-bootstrap');

const fixturePath = path.join(__dirname, 'fixtures/test-data.csv');

async function preparePivot(page) {
  await uploadFixtureAndWaitForAttributes(page, fixturePath);
  await addBasicPivotAxes(page);
  await addSymbolFilterAxis(page);
  await runQueryAndWaitForPivot(page);
}

test.describe('Filters', () => {
  test('apply include filter to symbol and update pivot', async ({ page }) => {
    await preparePivot(page);

    await page.evaluate(() => {
      const filterButton = document.querySelector('#queryUi section[data-axis="filters"] li button[id$="-edit-filter-condition"]');
      if (filterButton) {
        filterButton.click();
      }
    });

    const filterDialog = page.locator('#filterDialog');
    await expect(filterDialog).toBeVisible({ timeout: 10000 });

    await page.fill('#filterSearch', 'AAPL');
    await page.click('#addFilterValueButton');

    await expect(page.locator('#filterValueList option')).toHaveAttribute('value', 'AAPL');

    await page.click('#filterDialogOkButton');
    const pivot = await runQueryAndWaitForPivot(page);
    await expect(pivot).toContainText('AAPL');
    await expect(pivot).not.toContainText('GOOG');
  });
});
