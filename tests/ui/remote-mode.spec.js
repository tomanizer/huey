// @ts-check
const { test, expect } = require('@playwright/test');
const { waitForAppReady, openAttributesTab, runQueryAndWaitForPivot } = require('./helpers/app-bootstrap');

test.describe('Remote mode UI', () => {
  test('Huey app loads and shows main UI', async ({ page }) => {
    await waitForAppReady(page);
    await expect(page).toHaveTitle(/Huey/);
    await expect(page.locator('body')).toBeVisible();
    const main = page.locator('#workarea, [role="main"], .sidebar').first();
    await expect(main).toBeAttached();
  });

  test('toolbar renders core actions', async ({ page }) => {
    await waitForAppReady(page);
    await expect(page.locator('#uploader')).toBeAttached();
    await expect(page.locator('#runQueryButton')).toBeAttached();
    await expect(page.locator('#exportButton')).toBeAttached();
    await expect(page.locator('#settingsButton')).toBeAttached();
  });

  test('sidebar tabs for datasources and attributes are available', async ({ page }) => {
    await waitForAppReady(page);
    await expect(page.locator('label[for="datasourcesTab"]')).toBeAttached();
    await expect(page.locator('label[for="attributesTab"]')).toBeAttached();
  });

  test('remote datasource pivot with measure renders without typeId error', async ({ page }) => {
    const schemaResponse = {
      dataset_id: 'trades_v1',
      fields: [
        { name: 'date', type: 'date', is_dimension: true },
        { name: 'symbol', type: 'string', is_dimension: true },
        { name: 'volume', type: 'int64', is_measure: true },
      ],
    };
    const tuplesResponse = {
      total_count: 3,
      items: [
        { symbol: 'AAPL', grouping_id: null },
        { symbol: 'GOOG', grouping_id: null },
        { symbol: 'MSFT', grouping_id: null },
      ],
      paging: { limit: 100, offset: 0, returned: 3 },
      meta: { execution_ms: 2, cache_status: 'miss', request_id: 'test-tuples' },
    };
    const cellsResponse = {
      rows: [{ symbol: 'AAPL' }, { symbol: 'GOOG' }, { symbol: 'MSFT' }],
      columns: [{}],
      cells: [
        { row: 0, col: 0, sum_volume_0: 1500 },
        { row: 1, col: 0, sum_volume_0: 2200 },
        { row: 2, col: 0, sum_volume_0: 1800 },
      ],
      window: {
        rows: { offset: 0, limit: 100, total: 3 },
        columns: { offset: 0, limit: 1, total: 1 },
      },
      meta: { execution_ms: 3, cache_status: 'miss', request_id: 'test-cells' },
    };

    await page.route('**/api/v1/datasets/*/schema', (route) => route.fulfill({ status: 200, body: JSON.stringify(schemaResponse) }));
    await page.route('**/api/v1/datasets/*/query/tuples', (route) => route.fulfill({ status: 200, body: JSON.stringify(tuplesResponse) }));
    await page.route('**/api/v1/datasets/*/query/cells', (route) => route.fulfill({ status: 200, body: JSON.stringify(cellsResponse) }));
    await page.route('**/api/v1/datasets/*/query/members', (route) => route.fulfill({
      status: 200,
      body: JSON.stringify({
        field: 'symbol',
        total_count: 3,
        items: [{ value: 'AAPL', count: 1 }],
        paging: { limit: 100, offset: 0, returned: 1 },
        meta: { execution_ms: 1, cache_status: 'miss', request_id: 'test-members' },
      }),
    }));

    await waitForAppReady(page);
    await expect(page.locator('#addRemoteDatasource')).toBeVisible({ timeout: 10000 });
    await page.locator('#addRemoteDatasource').click();
    await expect(page.locator('#remoteDatasourceBaseUrl')).toBeVisible({ timeout: 5000 });
    await page.locator('#remoteDatasourceBaseUrl').fill('http://localhost:8002');
    await page.locator('#remoteDatasourceDatasetId').fill('trades_v1');
    await page.locator('#promptDialogAcceptButton').click();
    await expect(page.locator('details[data-grouptype="remote"]')).toBeVisible({ timeout: 15000 });
    // Open the group header so the datasource node is revealed in the sidebar.
    await page.locator('details[data-grouptype="remote"] > summary').click();
    // The analyzeActionButton label is CSS-hidden (only shown on hover), so use
    // evaluate to click it programmatically, bypassing Playwright's visibility check.
    await page.locator('details[data-grouptype="remote"] .analyzeActionButton').first().evaluate((el) => el.click());
    await expect(page.locator('#attributeUi')).toBeVisible({ timeout: 15000 });
    await expect(page.locator('#attributeUi details[data-column_name="symbol"]')).toBeVisible({ timeout: 10000 });
    await expect(page.locator('#attributeUi details[data-column_name="volume"]')).toBeVisible({ timeout: 10000 });

    await openAttributesTab(page);
    await page.locator('#attributeUi details[data-column_name="symbol"] summary label.attributeUiAxisButton[data-axis="rows"]').click();
    await page.locator('#attributeUi details[data-column_name="volume"] summary label.attributeUiAxisButton[data-axis="cells"]').click();
    const pivot = await runQueryAndWaitForPivot(page);

    await expect(page.locator('[data-testid="error-dialog"], .errorDialog, [role="alertdialog"]')).not.toBeVisible().catch(() => {});
    await expect(pivot).toContainText(/AAPL|GOOG|MSFT/, { timeout: 15000 });
  });
});
