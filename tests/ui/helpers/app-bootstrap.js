// @ts-check
const { expect } = require('@playwright/test');

async function openApp(page) {
  await page.goto('/index.html');
}

async function waitForAppReady(page) {
  await openApp(page);
  await expect(page.locator('body')).toHaveAttribute('aria-busy', 'false', { timeout: 60000 });
  await expect(page.locator('#layout')).toBeVisible({ timeout: 60000 });
  await expect(page.locator('#uploader')).toBeAttached({ timeout: 20000 });
}

async function uploadFixtureAndWaitForAttributes(page, fixturePath) {
  await waitForAppReady(page);
  await page.locator('#uploader').setInputFiles(fixturePath);
  await expect(page.locator('#attributeUi')).toBeVisible({ timeout: 30000 });
  await expect(page.locator('#attributeUi details[data-column_name="symbol"]')).toBeVisible({ timeout: 30000 });
  await expect(page.locator('#attributeUi details[data-column_name="volume"]')).toBeVisible({ timeout: 30000 });
}

async function openAttributesTab(page) {
  await page.locator('label[for="attributesTab"]').click();
  await expect(page.locator('#attributeUi')).toBeVisible({ timeout: 15000 });
}

async function ensureAutoRunDisabled(page) {
  const autoRun = page.locator('#autoRunQuery');
  await expect(autoRun).toBeAttached({ timeout: 10000 });
  if (await autoRun.isChecked()) {
    await page.locator('label[for="autoRunQuery"]').click();
    await expect(autoRun).not.toBeChecked({ timeout: 10000 });
  }
}

async function addBasicPivotAxes(page) {
  await ensureAutoRunDisabled(page);
  await openAttributesTab(page);
  const symbolRowToggle = page.locator('#attributeUi details[data-column_name="symbol"] summary label.attributeUiAxisButton[data-axis="rows"]');
  await expect(symbolRowToggle).toBeVisible({ timeout: 15000 });
  await symbolRowToggle.click();

  const dateColumnToggle = page.locator('#attributeUi details[data-column_name="date"] summary label.attributeUiAxisButton[data-axis="columns"]');
  await expect(dateColumnToggle).toBeVisible({ timeout: 15000 });
  await dateColumnToggle.click();

  const volumeCellToggle = page.locator('#attributeUi details[data-column_name="volume"] summary label.attributeUiAxisButton[data-axis="cells"]');
  await expect(volumeCellToggle).toBeVisible({ timeout: 15000 });
  await volumeCellToggle.click();

  await expect(page.locator('#queryUi section[data-axis="rows"] > ol > li')).toHaveCount(1, { timeout: 30000 });
  await expect(page.locator('#queryUi section[data-axis="columns"] > ol > li')).toHaveCount(1, { timeout: 30000 });
  await expect(page.locator('#queryUi section[data-axis="cells"] > ol > li')).toHaveCount(1, { timeout: 30000 });
}

async function addSymbolFilterAxis(page) {
  await openAttributesTab(page);
  const symbolFilterToggle = page.locator('#attributeUi details[data-column_name="symbol"] summary label.attributeUiAxisButton[data-axis="filters"]');
  await expect(symbolFilterToggle).toBeVisible({ timeout: 15000 });
  await symbolFilterToggle.click();
  await expect(page.locator('#queryUi section[data-axis="filters"] > ol > li')).toHaveCount(1, { timeout: 30000 });
}

async function runQueryAndWaitForPivot(page) {
  await page.evaluate(() => {
    if (window.pivotTableUi && typeof window.pivotTableUi.updatePivotTableUi === 'function') {
      window.pivotTableUi.updatePivotTableUi();
    }
  });

  const pivot = page.locator('#pivotTableUi');
  await expect(pivot).toBeVisible({ timeout: 60000 });
  await expect(pivot).toHaveAttribute('aria-busy', 'false', { timeout: 60000 });
  await expect(page.locator('#queryResultRowsInfo')).not.toHaveText('', { timeout: 60000 });
  return pivot;
}

module.exports = {
  waitForAppReady,
  uploadFixtureAndWaitForAttributes,
  openAttributesTab,
  addBasicPivotAxes,
  addSymbolFilterAxis,
  runQueryAndWaitForPivot,
};
