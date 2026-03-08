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
  test('uploading a corrupt parquet file shows an error dialog', async ({ page }) => {
    await waitForAppReady(page);
    await page.locator('#uploader').setInputFiles(invalidParquet);

    // The error dialog should appear within a reasonable timeout
    const errorDialog = page.locator('#errorDialog');
    await expect(errorDialog).toBeVisible({ timeout: 30000 });

    // The dialog should contain a meaningful error title (not empty)
    const title = page.locator('#errorDialogTitle');
    await expect(title).not.toBeEmpty({ timeout: 5000 });

    // App should recover: close the dialog and the upload state is unchanged
    await page.locator('#errorDialogOkButton').click();
    await expect(errorDialog).not.toBeVisible({ timeout: 5000 });
  });
});

// ─── 2. Page reload preserves query state ─────────────────────────────────

test.describe('State persistence across reload', () => {
  test('query axes are restored from URL state after page reload', async ({ page }) => {
    await uploadFixtureAndWaitForAttributes(page, csvFixture);
    await addBasicPivotAxes(page);
    await runQueryAndWaitForPivot(page);

    // Confirm axes are present before reload
    await expect(page.locator('#queryUi section[data-axis="rows"] > ol > li')).toHaveCount(1);
    await expect(page.locator('#queryUi section[data-axis="columns"] > ol > li')).toHaveCount(1);
    await expect(page.locator('#queryUi section[data-axis="cells"] > ol > li')).toHaveCount(1);

    // Wait for URL hash to be written (Routing encodes state in the hash)
    await expect(page).toHaveURL(/#.+/, { timeout: 10000 });

    // Reload — the app reads state from the URL hash on startup
    await page.reload({ waitUntil: 'domcontentloaded' });
    await expect(page.locator('body')).toHaveAttribute('aria-busy', 'false', { timeout: 60000 });

    // Axes should be restored
    await expect(page.locator('#queryUi section[data-axis="rows"] > ol > li')).toHaveCount(1, { timeout: 30000 });
    await expect(page.locator('#queryUi section[data-axis="columns"] > ol > li')).toHaveCount(1, { timeout: 30000 });
    await expect(page.locator('#queryUi section[data-axis="cells"] > ol > li')).toHaveCount(1, { timeout: 30000 });

    // And the pivot result should be visible without re-running the query
    await expect(page.locator('#pivotTableUi .pivotTableUiValueCell').first()).toBeVisible({ timeout: 30000 });
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
    const rowHeaders = pivot.locator('.pivotTableUiRowHeaderCell');
    await expect(rowHeaders.filter({ hasText: '2026' })).toHaveCount(1, { timeout: 10000 });
  });
});

// ─── 4. Vertical scroll loads new rows ────────────────────────────────────

test.describe('Pivot table vertical scroll', () => {
  test('scrolling down in a tall pivot loads rows that were initially off-screen', async ({ page }) => {
    await waitForAppReady(page);
    await page.locator('#uploader').setInputFiles(longParquet);
    await expect(page.locator('#attributeUi')).toBeVisible({ timeout: 60000 });
    await expect(page.locator('#attributeUi details[data-column_name="company"]')).toBeVisible({ timeout: 30000 });

    await openAttributesTab(page);

    // company → rows, revenue → cells
    const companyRowButton = page.locator('#attributeUi details[data-column_name="company"] summary label.attributeUiAxisButton[data-axis="rows"]');
    await expect(companyRowButton).toBeVisible({ timeout: 15000 });
    await companyRowButton.click();

    const revenueCellButton = page.locator('#attributeUi details[data-column_name="revenue"] summary label.attributeUiAxisButton[data-axis="cells"]');
    await expect(revenueCellButton).toBeVisible({ timeout: 15000 });
    await revenueCellButton.click();

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
