// @ts-check
const { test, expect } = require('@playwright/test');
const path = require('path');
const {
  waitForAppReady,
  openAttributesTab,
  runQueryAndWaitForPivot,
} = require('./helpers/app-bootstrap');

const fixturesDir = path.join(__dirname, '../fixtures/parquet');

/**
 * Upload a parquet file and wait for attribute columns to appear.
 * @param {import('@playwright/test').Page} page
 * @param {string} filePath
 * @param {string} expectedColumn - a column name expected to be visible after load
 */
async function uploadParquetAndWaitForAttributes(page, filePath, expectedColumn) {
  await waitForAppReady(page);
  await page.locator('#uploader').setInputFiles(filePath);
  await expect(page.locator('#attributeUi')).toBeVisible({ timeout: 30000 });
  await expect(
    page.locator(`#attributeUi details[data-column_name="${expectedColumn}"]`)
  ).toBeVisible({ timeout: 30000 });
}

/**
 * Toggle a column onto a query axis.
 */
async function addToAxis(page, columnName, axis) {
  await openAttributesTab(page);
  const toggle = page.locator(
    `#attributeUi details[data-column_name="${columnName}"] summary label.attributeUiAxisButton[data-axis="${axis}"]`
  );
  await expect(toggle).toBeVisible({ timeout: 15000 });
  await toggle.click();
}

/**
 * Disable auto-run if it's on.
 */
async function ensureAutoRunDisabled(page) {
  const autoRun = page.locator('#autoRunQuery');
  await expect(autoRun).toBeAttached({ timeout: 10000 });
  if (await autoRun.isChecked()) {
    await page.locator('label[for="autoRunQuery"]').click();
    await expect(autoRun).not.toBeChecked({ timeout: 10000 });
  }
}

// ---------------------------------------------------------------------------
// alltypes.parquet — multi-type columns
// ---------------------------------------------------------------------------
test.describe('Parquet: alltypes.parquet', () => {
  const fixturePath = path.join(fixturesDir, 'alltypes.parquet');

  test('upload and verify all columns appear in attribute panel', async ({ page }) => {
    await uploadParquetAndWaitForAttributes(page, fixturePath, 'id');

    const expectedColumns = ['id', 'name', 'price', 'quantity', 'is_active', 'trade_date', 'created_at', 'tags'];
    for (const col of expectedColumns) {
      await expect(
        page.locator(`#attributeUi details[data-column_name="${col}"]`)
      ).toBeAttached({ timeout: 10000 });
    }
  });

  test('pivot by name with price measure renders numeric values', async ({ page }) => {
    await uploadParquetAndWaitForAttributes(page, fixturePath, 'name');
    await ensureAutoRunDisabled(page);
    await addToAxis(page, 'name', 'rows');
    await addToAxis(page, 'price', 'cells');
    await runQueryAndWaitForPivot(page);

    await expect(page.locator('#pivotTableUi')).toContainText(/\d/, { timeout: 15000 });
  });
});

// ---------------------------------------------------------------------------
// wide.parquet — 100 columns
// ---------------------------------------------------------------------------
test.describe('Parquet: wide.parquet', () => {
  const fixturePath = path.join(fixturesDir, 'wide.parquet');

  test('upload wide table and verify many columns appear', async ({ page }) => {
    await uploadParquetAndWaitForAttributes(page, fixturePath, 'id');

    // Spot-check a few metric columns
    for (const col of ['metric_000', 'metric_050', 'metric_096']) {
      await expect(
        page.locator(`#attributeUi details[data-column_name="${col}"]`)
      ).toBeAttached({ timeout: 10000 });
    }
  });

  test('pivot with symbol row and metric column renders values', async ({ page }) => {
    await uploadParquetAndWaitForAttributes(page, fixturePath, 'symbol');
    await ensureAutoRunDisabled(page);
    await addToAxis(page, 'symbol', 'rows');
    await addToAxis(page, 'metric_000', 'cells');
    await runQueryAndWaitForPivot(page);

    await expect(page.locator('#pivotTableUi')).toContainText(/\d/, { timeout: 15000 });
  });
});

// ---------------------------------------------------------------------------
// nulls.parquet — null patterns
// ---------------------------------------------------------------------------
test.describe('Parquet: nulls.parquet', () => {
  const fixturePath = path.join(fixturesDir, 'nulls.parquet');

  test('upload and verify columns appear despite nulls', async ({ page }) => {
    await uploadParquetAndWaitForAttributes(page, fixturePath, 'id');

    for (const col of ['id', 'price', 'empty_col', 'symbol', 'quantity', 'is_valid']) {
      await expect(
        page.locator(`#attributeUi details[data-column_name="${col}"]`)
      ).toBeAttached({ timeout: 10000 });
    }
  });

  test('pivot renders without error despite all-null column', async ({ page }) => {
    await uploadParquetAndWaitForAttributes(page, fixturePath, 'symbol');
    await ensureAutoRunDisabled(page);
    await addToAxis(page, 'symbol', 'rows');
    await addToAxis(page, 'price', 'cells');
    await runQueryAndWaitForPivot(page);

    // Should show some data despite nulls
    const pivot = page.locator('#pivotTableUi');
    await expect(pivot).toContainText(/\d/, { timeout: 15000 });
  });
});

// ---------------------------------------------------------------------------
// single_row.parquet — edge case: 1 row
// ---------------------------------------------------------------------------
test.describe('Parquet: single_row.parquet', () => {
  const fixturePath = path.join(fixturesDir, 'single_row.parquet');

  test('upload single row file and verify attribute panel', async ({ page }) => {
    await uploadParquetAndWaitForAttributes(page, fixturePath, 'symbol');
  });

  test('pivot renders with a single data row', async ({ page }) => {
    await uploadParquetAndWaitForAttributes(page, fixturePath, 'symbol');
    await ensureAutoRunDisabled(page);
    await addToAxis(page, 'symbol', 'rows');
    await addToAxis(page, 'price', 'cells');
    await runQueryAndWaitForPivot(page);

    await expect(page.locator('#pivotTableUi')).toContainText('AAPL', { timeout: 15000 });
    await expect(page.locator('#pivotTableUi')).toContainText(/150/, { timeout: 15000 });
  });
});

// ---------------------------------------------------------------------------
// unicode.parquet — special characters
// ---------------------------------------------------------------------------
test.describe('Parquet: unicode.parquet', () => {
  const fixturePath = path.join(fixturesDir, 'unicode.parquet');

  test('upload unicode parquet and verify columns', async ({ page }) => {
    await uploadParquetAndWaitForAttributes(page, fixturePath, 'company');
  });

  test('pivot renders unicode company names without corruption', async ({ page }) => {
    await uploadParquetAndWaitForAttributes(page, fixturePath, 'company');
    await ensureAutoRunDisabled(page);
    await addToAxis(page, 'company', 'rows');
    await addToAxis(page, 'revenue', 'cells');
    await runQueryAndWaitForPivot(page);

    const pivot = page.locator('#pivotTableUi');
    // Check a few representative unicode strings render properly
    await expect(pivot).toContainText('Acme Corp', { timeout: 15000 });
    await expect(pivot).toContainText('Caf', { timeout: 15000 }); // Café Holdings
  });

  test('SQL injection canary string renders as data, not executed', async ({ page }) => {
    await uploadParquetAndWaitForAttributes(page, fixturePath, 'company');
    await ensureAutoRunDisabled(page);
    await addToAxis(page, 'company', 'rows');
    await addToAxis(page, 'revenue', 'cells');
    await runQueryAndWaitForPivot(page);

    // The "DROP TABLE;--" string should appear as text in the pivot
    await expect(page.locator('#pivotTableUi')).toContainText('DROP TABLE', { timeout: 15000 });
  });
});
