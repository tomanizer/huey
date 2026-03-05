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

async function findPivotRowText(page, label) {
  const text = await page.locator('#pivotTableUi').innerText();
  const rows = text.split('\n').map((line) => line.trim()).filter(Boolean);
  return rows.find((line) => line.includes(label));
}

async function expectPivotRowContainsValues(page, label, values) {
  const rowText = await findPivotRowText(page, label);
  await expect(rowText).toBeTruthy();
  const rowTokens = String(rowText).split(/\s+/).filter(Boolean);
  for (const value of values) {
    await expect(rowTokens).toContain(String(value));
  }
}

test.describe('Data accuracy', () => {
  test('SUM aggregation renders expected grouped totals', async ({ page }) => {
    await uploadFixtureAndWaitForAttributes(page, typedFixturePath);
    await addBasicPivotAxes(page);
    await runQueryAndWaitForPivot(page);

    await expectPivotRowContainsValues(page, 'AAPL', [30]);
    await expectPivotRowContainsValues(page, 'GOOG', [40]);
  });

  test('COUNT aggregation renders expected grouped counts', async ({ page }) => {
    await uploadFixtureAndWaitForAttributes(page, typedFixturePath);
    await addBasicPivotAxes(page);

    await addAggregateMeasure(page, 'volume', 'count');
    await runQueryAndWaitForPivot(page);

    // Order follows column axis date buckets: 2026-01-01 then 2026-01-02.
    await expectPivotRowContainsValues(page, 'AAPL', [2, 1]);
    await expectPivotRowContainsValues(page, 'GOOG', [1, 2]);
  });

  test('AVG aggregation renders expected grouped averages', async ({ page }) => {
    await uploadFixtureAndWaitForAttributes(page, typedFixturePath);
    await addBasicPivotAxes(page);

    await addAggregateMeasure(page, 'volume', 'avg');
    await runQueryAndWaitForPivot(page);

    await expectPivotRowContainsValues(page, 'AAPL', [15, 30]);
    await expectPivotRowContainsValues(page, 'GOOG', [5, 20]);
  });

  test('multiple measures render together with expected values', async ({ page }) => {
    await uploadFixtureAndWaitForAttributes(page, typedFixturePath);
    await addBasicPivotAxes(page);
    await addAggregateMeasure(page, 'volume', 'avg');
    await runQueryAndWaitForPivot(page);

    await expectPivotRowContainsValues(page, 'AAPL', [30, 15]);
    await expectPivotRowContainsValues(page, 'GOOG', [40, 20]);
  });

  test('null values are ignored by count(volume) aggregation', async ({ page }) => {
    await uploadFixtureAndWaitForAttributes(page, nullsFixturePath);
    await addBasicPivotAxes(page);

    await addAggregateMeasure(page, 'volume', 'count');
    await runQueryAndWaitForPivot(page);

    await expectPivotRowContainsValues(page, 'AAPL', [1]);
    await expectPivotRowContainsValues(page, 'GOOG', [1]);
  });

  test('pivot with include filter shows expected subset totals', async ({ page }) => {
    await uploadFixtureAndWaitForAttributes(page, typedFixturePath);
    await addBasicPivotAxes(page);
    await addSymbolFilterAxis(page);
    await runQueryAndWaitForPivot(page);

    const filterButton = page.locator('#queryUi section[data-axis="filters"] li button[id$="-edit-filter-condition"]');
    await expect(filterButton).toBeVisible({ timeout: 10000 });
    await filterButton.click();
    await expect(page.locator('#filterDialog')).toBeVisible({ timeout: 10000 });
    await page.fill('#filterSearch', 'GOOG');
    await page.click('#addFilterValueButton');
    await page.click('#filterDialogOkButton');
    await runQueryAndWaitForPivot(page);

    await expect(page.locator('#pivotTableUi')).toContainText('GOOG');
    await expect(page.locator('#pivotTableUi')).not.toContainText('AAPL');
    await expectPivotRowContainsValues(page, 'GOOG', [40]);
  });
});
