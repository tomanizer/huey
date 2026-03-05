// @ts-check
const { test, expect } = require('@playwright/test');
const path = require('path');
const {
  uploadFixtureAndWaitForAttributes,
  addBasicPivotAxes,
  addSymbolFilterAxis,
  addAggregateMeasure,
  runQueryAndWaitForPivot,
} = require('./helpers/app-bootstrap');

const typedFixturePath = path.join(__dirname, 'fixtures/test-data-types.csv');
const nullsFixturePath = path.join(__dirname, 'fixtures/test-data-nulls.csv');

async function pivotText(page) {
  return page.locator('#pivotTableUi').innerText();
}

test.describe('Data accuracy', () => {
  test('SUM aggregation renders expected grouped totals', async ({ page }) => {
    await uploadFixtureAndWaitForAttributes(page, typedFixturePath);
    await addBasicPivotAxes(page);
    await runQueryAndWaitForPivot(page);

    const text = await pivotText(page);
    await expect(text).toMatch(/\b30\b/);
    await expect(text).toMatch(/\b40\b/);
  });

  test('COUNT aggregation renders expected grouped counts', async ({ page }) => {
    await uploadFixtureAndWaitForAttributes(page, typedFixturePath);
    await addBasicPivotAxes(page);

    await page.locator('#attributeUi details[data-column_name="volume"] summary label.attributeUiAxisButton[data-axis="cells"]').click();
    await addAggregateMeasure(page, 'volume', 'count');
    await runQueryAndWaitForPivot(page);

    const text = await pivotText(page);
    await expect(text).toMatch(/\b2\b/);
  });

  test('AVG aggregation renders expected grouped averages', async ({ page }) => {
    await uploadFixtureAndWaitForAttributes(page, typedFixturePath);
    await addBasicPivotAxes(page);

    await page.locator('#attributeUi details[data-column_name="volume"] summary label.attributeUiAxisButton[data-axis="cells"]').click();
    await addAggregateMeasure(page, 'volume', 'avg');
    await runQueryAndWaitForPivot(page);

    const text = await pivotText(page);
    await expect(text).toMatch(/\b15\b/);
    await expect(text).toMatch(/\b20\b/);
  });

  test('multiple measures render together with expected values', async ({ page }) => {
    await uploadFixtureAndWaitForAttributes(page, typedFixturePath);
    await addBasicPivotAxes(page);
    await addAggregateMeasure(page, 'volume', 'avg');
    await runQueryAndWaitForPivot(page);

    const text = await pivotText(page);
    await expect(text).toMatch(/\b30\b/);
    await expect(text).toMatch(/\b15\b/);
  });

  test('null values are ignored by count(volume) aggregation', async ({ page }) => {
    await uploadFixtureAndWaitForAttributes(page, nullsFixturePath);
    await addBasicPivotAxes(page);

    await page.locator('#attributeUi details[data-column_name="volume"] summary label.attributeUiAxisButton[data-axis="cells"]').click();
    await addAggregateMeasure(page, 'volume', 'count');
    await runQueryAndWaitForPivot(page);

    const text = await pivotText(page);
    await expect(text).toMatch(/\b1\b/);
  });

  test('pivot with include filter shows expected subset totals', async ({ page }) => {
    await uploadFixtureAndWaitForAttributes(page, typedFixturePath);
    await addBasicPivotAxes(page);
    await addSymbolFilterAxis(page);
    await runQueryAndWaitForPivot(page);

    await page.evaluate(() => {
      const filterButton = document.querySelector('#queryUi section[data-axis="filters"] li button[id$="-edit-filter-condition"]');
      if (filterButton) {
        filterButton.click();
      }
    });
    await expect(page.locator('#filterDialog')).toBeVisible({ timeout: 10000 });
    await page.fill('#filterSearch', 'GOOG');
    await page.click('#addFilterValueButton');
    await page.click('#filterDialogOkButton');
    await runQueryAndWaitForPivot(page);

    const text = await pivotText(page);
    await expect(text).toContain('GOOG');
    await expect(text).toMatch(/\b40\b/);
  });
});
