// @ts-check
const { test, expect } = require('@playwright/test');
const path = require('path');
const {
  waitForAppReady,
  uploadFixtureAndWaitForAttributes,
  openAttributesTab,
  addBasicPivotAxes,
  runQueryAndWaitForPivot,
} = require('./helpers/app-bootstrap');

const csvFixture = path.join(__dirname, 'fixtures/test-data.csv');
const invalidParquet = path.join(__dirname, 'fixtures/invalid.parquet');
const longParquet = path.join(path.dirname(__dirname), 'fixtures/parquet/long.parquet');

// ─── 1. Negative upload path ───────────────────────────────────────────────

test.describe('Negative upload', () => {
  test('uploading a corrupt parquet file shows an error in the upload dialog', async ({ page }) => {
    await waitForAppReady(page);
    await page.locator('#uploader').setInputFiles(invalidParquet);

    // The upload dialog opens automatically when files are submitted
    const uploadDialog = page.locator('#uploadUi');
    await expect(uploadDialog).toBeVisible({ timeout: 30000 });

    // At least one upload item should be marked as invalid
    await expect(uploadDialog.locator('[aria-invalid="true"]')).toBeVisible({ timeout: 15000 });

    // App should recover: close the dialog and no datasource is loaded
    await page.locator('#uploadDialogOkButton').click();
    await expect(uploadDialog).not.toBeVisible({ timeout: 5000 });

    // The attribute panel should not appear (no datasource was registered)
    await expect(page.locator('#attributeUi')).not.toBeVisible({ timeout: 5000 });
  });
});

// ─── 2. URL hash encodes query state ──────────────────────────────────────

test.describe('URL state encoding', () => {
  test('URL hash is updated with axis state after running a pivot', async ({ page }) => {
    await uploadFixtureAndWaitForAttributes(page, csvFixture);
    await addBasicPivotAxes(page);
    await runQueryAndWaitForPivot(page);

    // The router encodes query state into the URL hash after a successful run
    await expect(page).toHaveURL(/#.+/, { timeout: 10000 });

    // The hash should encode all three axes
    const url = page.url();
    expect(url).toContain('#');
    const hash = decodeURIComponent(url.split('#')[1] || '');
    expect(hash.length).toBeGreaterThan(10);
  });
});

// ─── 3. Date derivation in pivot ──────────────────────────────────────────

test.describe('Date derivation', () => {
  test('year derivation on date column groups rows by year', async ({ page }) => {
    await uploadFixtureAndWaitForAttributes(page, csvFixture);
    await openAttributesTab(page);

    // Expand the date column to reveal its derivations
    const dateNode = page.locator('#attributeUi details[data-column_name="date"]');
    await expect(dateNode).toBeVisible({ timeout: 15000 });
    if ((await dateNode.getAttribute('open')) === null) {
      await dateNode.locator(':scope > summary').click();
    }

    // Derivations are grouped in a "date fields" folder — expand it if closed
    const dateFieldsFolder = dateNode.locator(':scope > details[data-nodetype="folder"]').first();
    await expect(dateFieldsFolder).toBeAttached({ timeout: 10000 });
    if ((await dateFieldsFolder.count()) > 0 && (await dateFieldsFolder.getAttribute('open')) === null) {
      await dateFieldsFolder.locator(':scope > summary').click();
    }

    // Click the "rows" button on the year derivation
    const yearRowsButton = dateNode.locator('details[data-derivation="year"] summary label.attributeUiAxisButton[data-axis="rows"]');
    await expect(yearRowsButton).toBeVisible({ timeout: 10000 });
    await yearRowsButton.click();
    await expect(page.locator('#queryUi section[data-axis="rows"] > ol > li')).toHaveCount(1, { timeout: 10000 });

    // Add volume to cells
    const volumeCellButton = page.locator('#attributeUi details[data-column_name="volume"] summary label.attributeUiAxisButton[data-axis="cells"]');
    await expect(volumeCellButton).toBeVisible({ timeout: 10000 });
    await volumeCellButton.click();
    await expect(page.locator('#queryUi section[data-axis="cells"] > ol > li')).toHaveCount(1, { timeout: 10000 });

    await runQueryAndWaitForPivot(page);

    // All rows in the fixture are from 2026 — the pivot should group them under a single "2026" row header
    const pivot = page.locator('#pivotTableUi');
    await expect(pivot).toContainText('2026', { timeout: 15000 });

    // Confirm year derivation produces a single row (2026 is the only year)
    const rowHeaders = pivot.locator('.pivotTableUiHeaderCell[role="rowheader"]');
    await expect(rowHeaders.filter({ hasText: '2026' })).toHaveCount(1, { timeout: 10000 });
  });
});

// ─── 4. Vertical scroll loads new rows ────────────────────────────────────

test.describe('Pivot table vertical scroll', () => {
  test('scrolling down in a tall pivot loads rows that were initially off-screen', async ({ page }) => {
    await waitForAppReady(page);
    await page.locator('#uploader').setInputFiles(longParquet);
    // long.parquet has 500k rows with columns: trade_date, symbol, price
    await expect(page.locator('#attributeUi')).toBeVisible({ timeout: 60000 });
    await expect(page.locator('#attributeUi details[data-column_name="symbol"]')).toBeVisible({ timeout: 30000 });

    await openAttributesTab(page);

    // symbol → rows, price → cells
    const symbolRowButton = page.locator('#attributeUi details[data-column_name="symbol"] summary label.attributeUiAxisButton[data-axis="rows"]');
    await expect(symbolRowButton).toBeVisible({ timeout: 15000 });
    await symbolRowButton.click();

    const priceCellButton = page.locator('#attributeUi details[data-column_name="price"] summary label.attributeUiAxisButton[data-axis="cells"]');
    await expect(priceCellButton).toBeVisible({ timeout: 15000 });
    await priceCellButton.click();

    await runQueryAndWaitForPivot(page);

    const pivot = page.locator('#pivotTableUi');
    const innerContainer = pivot.locator('.pivotTableUiInnerContainer');

    // Count initially visible value cells
    const initialCount = await pivot.locator('.pivotTableUiValueCell').count();
    expect(initialCount).toBeGreaterThan(0);

    // Scroll down a significant amount to trigger the lazy-load
    await innerContainer.evaluate((el) => { el.scrollTop += 2000; });
    await page.waitForTimeout(500); // allow debounce + re-render

    // After scrolling, the pivot should still show value cells (not blank)
    await expect(pivot.locator('.pivotTableUiValueCell').first()).toBeVisible({ timeout: 15000 });
    await expect(pivot).toHaveAttribute('aria-busy', 'false', { timeout: 30000 });
  });
});
