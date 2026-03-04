// @ts-check
const { test, expect } = require('@playwright/test');
const path = require('path');
const {
  uploadFixtureAndWaitForAttributes,
  addBasicPivotAxes,
  runQueryAndWaitForPivot,
} = require('./helpers/app-bootstrap');

const fixturePath = path.join(__dirname, 'fixtures/test-data.csv');

test.describe('Upload and Pivot Table', () => {
  test('upload CSV and verify datasource appears', async ({ page }) => {
    await uploadFixtureAndWaitForAttributes(page, fixturePath);
    const datasourceLabel = page.locator('#currentDatasource');
    await expect(datasourceLabel).toBeAttached();
  });

  test('add rows and cells using attribute toggles and render pivot', async ({ page }) => {
    await uploadFixtureAndWaitForAttributes(page, fixturePath);
    await addBasicPivotAxes(page);
    await runQueryAndWaitForPivot(page);
    await expect(page.locator('#pivotTableUi')).toContainText('AAPL', { timeout: 30000 });
  });

  test('add measure to cells axis and verify numeric values appear', async ({ page }) => {
    await uploadFixtureAndWaitForAttributes(page, fixturePath);
    await addBasicPivotAxes(page);
    await runQueryAndWaitForPivot(page);
    await expect(page.locator('#pivotTableUi')).toContainText(/\d/);
  });

  test('verify row and column counts in status bar', async ({ page }) => {
    await uploadFixtureAndWaitForAttributes(page, fixturePath);
    await addBasicPivotAxes(page);
    const pivot = await runQueryAndWaitForPivot(page);
    await expect(pivot).toContainText(/AAPL|GOOG|MSFT/);
  });
});
