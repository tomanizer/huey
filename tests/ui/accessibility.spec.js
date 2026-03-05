// @ts-check
const { test, expect } = require('@playwright/test');
const path = require('path');
const {
  waitForAppReady,
  uploadFixtureAndWaitForAttributes,
  addBasicPivotAxes,
  runQueryAndWaitForPivot,
} = require('./helpers/app-bootstrap');

const fixturePath = path.join(__dirname, 'fixtures/test-data.csv');

test.describe('Accessibility', () => {
  test('dialog and filter controls expose ARIA metadata', async ({ page }) => {
    await waitForAppReady(page);

    const allDialogsAreModal = await page.evaluate(() => {
      return Array.from(document.querySelectorAll('dialog')).every((dialog) => {
        return dialog.getAttribute('aria-modal') === 'true';
      });
    });
    expect(allDialogsAreModal).toBe(true);

    await expect(page.locator('#filterPicklist')).toHaveAttribute('role', 'listbox');
    await expect(page.locator('#filterValueList')).toHaveAttribute('role', 'listbox');
    await expect(page.locator('#toFilterValueList')).toHaveAttribute('role', 'listbox');

    const progress = page.locator('#uploadItemTemplate progress');
    await expect(progress).toHaveAttribute('aria-valuemin', '0');
    await expect(progress).toHaveAttribute('aria-valuemax', '100');
    await expect(progress).toHaveAttribute('aria-valuenow', '0');
  });

  test('pivot grid roles and context menu keyboard support work', async ({ page }) => {
    await uploadFixtureAndWaitForAttributes(page, fixturePath);
    await addBasicPivotAxes(page);
    await runQueryAndWaitForPivot(page);

    await expect(page.locator('#pivotTableUi .pivotTableUiTable')).toHaveAttribute('role', 'grid');
    await expect(page.locator('#pivotTableUi .pivotTableUiTable [role="columnheader"]').first()).toBeVisible();
    await expect(page.locator('#pivotTableUi .pivotTableUiTable [role="rowheader"]').first()).toBeVisible();
    await expect(page.locator('#pivotTableUi .pivotTableUiTable [role="gridcell"]').first()).toBeVisible();

    const valueCell = page.locator('#pivotTableUi .pivotTableUiValueCell').first();
    await valueCell.click({ button: 'right' });
    await expect(page.locator('#pivotTableContextMenu')).toBeVisible();

    await expect.poll(async () => page.evaluate(() => document.activeElement?.id)).toBe('pivotTableContextMenuItemCopyCell');
    await page.keyboard.press('ArrowDown');
    await expect.poll(async () => page.evaluate(() => document.activeElement?.id)).toBe('pivotTableContextMenuItemCopyColumn');

    await page.keyboard.press('Escape');
    await expect(page.locator('#pivotTableContextMenu')).toBeHidden();
    await expect.poll(async () => {
      return page.evaluate(() => Boolean(document.activeElement?.closest('.pivotTableUiCell')));
    }).toBe(true);
  });
});
