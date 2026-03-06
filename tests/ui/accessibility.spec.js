// @ts-check
const { test, expect } = require('@playwright/test');
const path = require('path');
const {
  waitForAppReady,
  uploadFixtureAndWaitForAttributes,
  addBasicPivotAxes,
  addFilterAxis,
  runQueryAndWaitForPivot,
} = require('./helpers/app-bootstrap');

const fixturePath = path.join(__dirname, 'fixtures/test-data.csv');

test.describe('Accessibility', () => {
  test('keyboard can open settings dialog and escape returns focus', async ({ page }) => {
    await waitForAppReady(page);
    const settingsButton = page.locator('#settingsButton');
    await settingsButton.focus();
    await page.keyboard.press('Enter');
    await expect(page.locator('#settingsDialog')).toBeVisible({ timeout: 10000 });
    await page.keyboard.press('Escape');
    await expect(page.locator('#settingsDialog')).not.toBeVisible();
    await expect(settingsButton).toBeFocused();
  });

  test('interactive dialogs expose required aria relationships', async ({ page }) => {
    await waitForAppReady(page);

    await page.evaluate(async () => {
      const { showErrorDialog } = await import('/ErrorDialog/ErrorDialog.js');
      showErrorDialog(new Error('Accessibility check'));
    });

    const dialog = page.locator('#errorDialog');
    await expect(dialog).toBeVisible({ timeout: 5000 });
    await expect(dialog).toHaveAttribute('aria-labelledby', 'errorDialogTitle');
    await expect(dialog).toHaveAttribute('aria-describedby', 'errorDialogDescription');
    await expect(page.locator('#errorDialogTitle')).toContainText('Accessibility check');
  });

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

  test('key layout regions expose stable test ids and axis regions', async ({ page }) => {
    await waitForAppReady(page);

    await expect(page.getByTestId('app-layout')).toBeVisible();
    await expect(page.getByTestId('sidebar')).toBeVisible();
    await expect(page.getByTestId('workarea')).toBeVisible();

    await expect(page.getByTestId('filters-axis')).toHaveAttribute('role', 'region');
    await expect(page.getByTestId('rows-axis')).toHaveAttribute('aria-label', 'Rows axis');
    await expect(page.getByTestId('columns-axis')).toHaveAttribute('aria-label', 'Columns axis');
    await expect(page.getByTestId('cells-axis')).toHaveAttribute('aria-label', 'Cells axis');
  });

  test('menu trigger buttons expose popup semantics', async ({ page }) => {
    await uploadFixtureAndWaitForAttributes(page, fixturePath);
    await addBasicPivotAxes(page);
    await runQueryAndWaitForPivot(page);

    const datasourceMenuButton = page.locator('#currentDatasourceMenuButton');
    await expect(datasourceMenuButton).toHaveAttribute('aria-haspopup', 'menu');
    await expect(datasourceMenuButton).toHaveAttribute('aria-expanded', 'false');

    const valueCell = page.locator('#pivotTableUi .pivotTableUiValueCell').first();
    await valueCell.click({ button: 'right' });
    await expect(page.locator('#pivotTableContextMenu')).toBeVisible();

    const copySubmenuButton = page.locator('#copySubmenuActivate');
    await expect(copySubmenuButton).toHaveAttribute('aria-haspopup', 'menu');
    await expect(copySubmenuButton).toHaveAttribute('aria-expanded', 'false');
    await copySubmenuButton.click();
    await expect(copySubmenuButton).toHaveAttribute('aria-expanded', 'true');
    await page.keyboard.press('Escape');
  });

  test('filter option lists expose aria-selected state', async ({ page }) => {
    await uploadFixtureAndWaitForAttributes(page, fixturePath);
    await addFilterAxis(page, 'symbol');

    const editFilterButton = page.getByTestId('edit-filter-condition-button').first();
    await editFilterButton.click();
    await expect(page.locator('#filterDialog')).toBeVisible({ timeout: 15000 });

    const picklistOption = page.locator('#filterPicklist option').first();
    await expect(picklistOption).toHaveAttribute('aria-selected', 'false');
    await picklistOption.click();
    await expect(picklistOption).toHaveAttribute('aria-selected', 'true');
  });
});
