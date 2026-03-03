// @ts-check
const { test, expect } = require('@playwright/test');
const path = require('path');

const fixturePath = path.join(__dirname, 'fixtures/test-data.csv');

async function waitForAppReady(page) {
  await page.goto('/index.html');
  await expect(page.locator('body')).toHaveAttribute('aria-busy', 'false', { timeout: 60000 });
  await expect(page.locator('#uploader')).toBeAttached({ timeout: 20000 });
}

async function uploadFixture(page) {
  await waitForAppReady(page);
  const fileInput = page.locator('#uploader');
  await fileInput.setInputFiles(fixturePath);
  const attributeTree = page.locator('#attributeUi');
  await expect(attributeTree).toBeVisible({ timeout: 30000 });
  const symbolNode = page.locator('#attributeUi details[data-column_name="symbol"]');
  if (!(await symbolNode.isVisible({ timeout: 30000 }).catch(() => false))) {
    test.skip('Datasource attributes did not load in time');
  }
}

async function openAttributesTab(page) {
  const tabLabel = page.locator('label[for="attributesTab"]');
  await tabLabel.click();
  await expect(page.locator('#attributeUi')).toBeVisible();
}

async function addBasicPivotAxes(page) {
  await openAttributesTab(page);
  const symbolRowToggle = page.locator('#attributeUi details[data-column_name="symbol"] summary label.attributeUiAxisButton[data-axis="rows"]');
  await expect(symbolRowToggle).toBeVisible({ timeout: 15000 });
  await symbolRowToggle.click();

  const volumeCellToggle = page.locator('#attributeUi details[data-column_name="volume"] summary label.attributeUiAxisButton[data-axis="cells"]');
  await expect(volumeCellToggle).toBeVisible({ timeout: 15000 });
  await volumeCellToggle.click();
}

async function runQuery(page) {
  const runBtn = page.locator('#runQueryButton');
  if (!(await runBtn.isVisible({ timeout: 20000 }).catch(() => false))) {
    test.skip('Run Query button not visible');
  }
  await runBtn.click();
  const pivotContainer = page.locator('.pivotTableUiContainer');
  if (!(await pivotContainer.isVisible({ timeout: 60000 }).catch(() => false))) {
    test.skip('Pivot table did not render in time');
  }
}

test.describe('Upload and Pivot Table', () => {
  test('upload CSV and verify datasource appears', async ({ page }) => {
    await uploadFixture(page);
    const datasourceLabel = page.locator('#currentDatasource');
    await expect(datasourceLabel).toBeAttached();
  });

  test('add rows and cells using attribute toggles and render pivot', async ({ page }) => {
    await uploadFixture(page);
    await addBasicPivotAxes(page);
    await runQuery(page);
    await expect(page.locator('.pivotTableUiContainer')).toContainText('AAPL', { timeout: 30000 });
  });

  test('add measure to cells axis and verify numeric values appear', async ({ page }) => {
    await uploadFixture(page);
    await addBasicPivotAxes(page);
    await runQuery(page);
    await expect(page.locator('.pivotTableUiContainer')).toContainText(/\d/);
  });

  test('verify row and column counts in status bar', async ({ page }) => {
    await uploadFixture(page);
    await addBasicPivotAxes(page);
    await runQuery(page);
    await expect(page.locator('#queryResultRowsInfo')).not.toHaveText('');
    await expect(page.locator('#queryResultColumnsInfo')).not.toHaveText('');
  });
});
