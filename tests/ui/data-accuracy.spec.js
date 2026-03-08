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

async function findVisiblePivotRow(page, label) {
  const rowLocator = page.locator('#pivotTableUi .pivotTableUiTableBody .pivotTableUiRow').filter({
    has: page.locator('.pivotTableUiHeaderCell[role="rowheader"]', { hasText: label })
  }).first();
  if (await rowLocator.count()) {
    return rowLocator;
  }

  const scroller = page.locator('#pivotTableUi .pivotTableUiInnerContainer');
  const maxScrollTop = await scroller.evaluate((element) => {
    return Math.max(0, element.scrollHeight - element.clientHeight);
  });
  for (let attempt = 0; attempt <= 10; attempt++) {
    const nextScrollTop = Math.round((maxScrollTop / 10) * attempt);
    await scroller.evaluate((element, scrollTop) => {
      element.scrollTop = scrollTop;
      element.dispatchEvent(new Event('scroll'));
    }, nextScrollTop);
    await page.waitForTimeout(150);
    if (await rowLocator.count()) {
      return rowLocator;
    }
  }
  return rowLocator;
}

async function expectPivotRowContainsValues(page, label, values) {
  const row = await findVisiblePivotRow(page, label);
  await expect(row).toBeVisible({ timeout: 15000 });
  const rowTexts = await row.locator('.pivotTableUiValueCell').allInnerTexts();
  const rowTokens = rowTexts.map((token) => token.replace(/,/g, '').trim()).filter(Boolean);
  for (const value of values) {
    const expectedToken = String(value).replace(/,/g, '');
    const hasMatch = rowTokens.some((token) => {
      if (token === expectedToken) {
        return true;
      }
      const tokenNumber = Number.parseFloat(token);
      const expectedNumber = Number.parseFloat(expectedToken);
      return Number.isFinite(tokenNumber) && Number.isFinite(expectedNumber) && tokenNumber === expectedNumber;
    });
    await expect(hasMatch).toBe(true);
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

    const filterDialog = page.locator('#filterDialog');
    const filterButton = page.locator('#queryUi section[data-axis="filters"] li button[id$="-edit-filter-condition"]');
    if (!(await filterDialog.isVisible().catch(() => false))) {
      await expect(filterButton).toBeVisible({ timeout: 10000 });
      await filterButton.click();
      await expect(filterDialog).toBeVisible({ timeout: 10000 });
    }
    await page.locator('#filterSearch').fill('GOOG');
    await page.locator('#filterSearch').press('Enter');
    await expect(page.locator('#filterValueList option')).toHaveAttribute('value', 'GOOG');
    await page.locator('#filterDialogOkButton').click();
    await expect(page.locator('#filterDialog')).not.toBeVisible({ timeout: 10000 });
    // Wait for the filter to commit to the query model before triggering the run
    await expect(page.locator('#pivotTableUi')).toHaveAttribute('data-needs-update', 'true', { timeout: 5000 });
    await runQueryAndWaitForPivot(page);

    await expect(page.locator('#pivotTableUi')).toContainText('GOOG');
    await expect(page.locator('#pivotTableUi')).not.toContainText('AAPL');
    await expectPivotRowContainsValues(page, 'GOOG', [40]);
  });
});
