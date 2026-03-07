// @ts-check
const { test, expect } = require('@playwright/test');
const path = require('path');
const {
  uploadFixtureAndWaitForAttributes,
  addBasicPivotAxes,
  addFilterAxis,
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

async function openFilterDialog(page) {
  const filterDialog = page.locator('#filterDialog');
  if (await filterDialog.isVisible().catch(() => false)) {
    return filterDialog;
  }
  const filterButton = page.locator('#queryUi section[data-axis="filters"] li button[id$="-edit-filter-condition"]');
  await expect(filterButton).toBeVisible({ timeout: 10000 });
  await filterButton.click();
  await expect(filterDialog).toBeVisible({ timeout: 10000 });
  return filterDialog;
}

test.describe('Filters', () => {
  test('apply include filter to symbol and update pivot', async ({ page }) => {
    await preparePivot(page);

    const filterDialog = await openFilterDialog(page);

    await page.fill('#filterSearch', 'AAPL');
    await page.locator('#filterSearch').press('Enter');

    await expect(page.locator('#filterValueList option')).toHaveAttribute('value', 'AAPL');

    await page.click('#filterDialogOkButton');
    await expect(filterDialog).not.toBeVisible({ timeout: 10000 });
    const pivot = await runQueryAndWaitForPivot(page);
    await expect(pivot).toContainText('AAPL');
    await expect(pivot).not.toContainText('GOOG');
    await expect(page.locator('#queryUi section[data-axis="filters"] > ol > li')).toHaveAttribute('data-filtertype', 'in');
    await expect(filterDialog).not.toBeVisible();
  });

  test('apply exclude filter type on symbol', async ({ page }) => {
    await preparePivot(page);
    await openFilterDialog(page);
    await page.selectOption('#filterType', 'notin');
    await page.fill('#filterSearch', 'AAPL');
    await page.locator('#filterSearch').press('Enter');
    await page.click('#filterDialogOkButton');
    await expect(page.locator('#filterDialog')).not.toBeVisible({ timeout: 10000 });

    await runQueryAndWaitForPivot(page);
    await expect(page.locator('#queryUi section[data-axis="filters"] > ol > li')).toHaveAttribute('data-filtertype', 'notin');
    await expect(page.locator('#queryUi section[data-axis="filters"] > ol > li ol li')).toContainText('AAPL');
  });

  test('apply between filter on date column', async ({ page }) => {
    await uploadFixtureAndWaitForAttributes(page, fixturePath);
    await addBasicPivotAxes(page);
    await addFilterAxis(page, 'date');
    await runQueryAndWaitForPivot(page);

    await openFilterDialog(page);
    await page.selectOption('#filterType', 'between');
    await page.fill('#filterSearch', '2026-01-01');
    await page.locator('#filterSearch').press('Enter');
    await page.fill('#filterSearch', '2026-01-02');
    await page.locator('#filterSearch').press('Enter');
    await page.click('#filterDialogOkButton');
    await expect(page.locator('#filterDialog')).not.toBeVisible({ timeout: 10000 });

    await runQueryAndWaitForPivot(page);
    await expect(page.locator('#queryUi section[data-axis="filters"] > ol > li')).toHaveAttribute('data-filtertype', 'between');
    const filterValues = page.locator('#queryUi section[data-axis="filters"] > ol > li ol');
    await expect(filterValues).toContainText('2026-01-01');
    await expect(filterValues).toContainText('2026-01-02');
  });

  test('clear all filter values', async ({ page }) => {
    await preparePivot(page);
    await openFilterDialog(page);
    await page.fill('#filterSearch', 'AAPL');
    await page.locator('#filterSearch').press('Enter');
    await expect(page.locator('#filterValueList option')).toHaveCount(1);
    await page.click('#filterDialogClearButton');
    await expect(page.locator('#filterValueList option')).toHaveCount(0);
    await page.click('#filterDialogOkButton');
    await expect(page.locator('#filterDialog')).not.toBeVisible({ timeout: 10000 });
    await runQueryAndWaitForPivot(page);
    await expect(page.locator('#queryUi section[data-axis="filters"] > ol > li ol li')).toHaveCount(0);
  });

  test('filter persists across repeated query runs', async ({ page }) => {
    await preparePivot(page);
    await openFilterDialog(page);
    await page.fill('#filterSearch', 'AAPL');
    await page.locator('#filterSearch').press('Enter');
    await page.click('#filterDialogOkButton');
    await expect(page.locator('#filterDialog')).not.toBeVisible({ timeout: 10000 });

    await runQueryAndWaitForPivot(page);
    await runQueryAndWaitForPivot(page);
    await expect(page.locator('#queryUi section[data-axis="filters"] > ol > li')).toHaveAttribute('data-filtertype', 'in');
    await expect(page.locator('#queryUi section[data-axis="filters"] > ol > li ol li')).toContainText('AAPL');
  });
});
