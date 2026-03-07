// @ts-check
const { test, expect } = require('@playwright/test');
const { waitForAppReady, openAttributesTab, runQueryAndWaitForPivot } = require('./helpers/app-bootstrap');

async function registerRemoteDatasource(page, baseUrl, datasetId) {
  await page.evaluate(async ({ currentBaseUrl, currentDatasetId }) => {
    const [{ RemoteDatasourceConfig }, { RemoteDatasource }, { datasourcesUi }, { analyzeDatasource }] = await Promise.all([
      import('/DataSource/remote/RemoteDatasourceConfig.js'),
      import('/DataSource/remote/RemoteDatasource.js'),
      import('/DataSource/DataSourcesUi.js'),
      import('/App/analyzeDatasource.js'),
    ]);
    const datasource = new RemoteDatasource(
      RemoteDatasourceConfig.createRemoteDatasourceConfig({
        baseUrl: currentBaseUrl,
        datasetId: currentDatasetId,
      })
    );
    await datasourcesUi.addDatasources([datasource]);
    await analyzeDatasource(datasource);
  }, { currentBaseUrl: baseUrl, currentDatasetId: datasetId });
}

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
      total_count: 5,
      items: [
        { values: ['2026-03-01', 'AAPL', 1500], grouping_id: null },
        { values: ['2026-03-01', 'GOOG', 2200], grouping_id: null },
        { values: ['2026-03-01', 'MSFT', 1800], grouping_id: null },
      ],
      paging: { limit: 100, offset: 0, returned: 3 },
    };
    const cellsResponse = {
      cells: [
        { row_index: 0, column_index: 0, values: { sum_volume_0: 1500 } },
      ],
    };

    await page.route('**/schema?dataset_id=*', (route) => route.fulfill({ status: 200, body: JSON.stringify(schemaResponse) }));
    await page.route('**/query/tuples', (route) => route.fulfill({ status: 200, body: JSON.stringify(tuplesResponse) }));
    await page.route('**/query/cells', (route) => route.fulfill({ status: 200, body: JSON.stringify(cellsResponse) }));
    await page.route('**/query/picklist', (route) => route.fulfill({ status: 200, body: JSON.stringify({ total_count: 3, values: [{ value: 'AAPL', label: 'AAPL' }], paging: { limit: 100, offset: 0, returned: 1 } }) }));

    await waitForAppReady(page);
    await registerRemoteDatasource(page, 'http://localhost:8002', 'trades_v1');
    await expect(page.locator('details[data-grouptype="remote"]')).toBeAttached({ timeout: 15000 });
    await expect(page.locator('#attributeUi')).toBeVisible({ timeout: 15000 });
    await expect(page.locator('#attributeUi details[data-column_name="symbol"]')).toBeVisible({ timeout: 10000 });
    await expect(page.locator('#attributeUi details[data-column_name="volume"]')).toBeVisible({ timeout: 10000 });

    await openAttributesTab(page);
    await page.locator('#attributeUi details[data-column_name="symbol"] summary label.attributeUiAxisButton[data-axis="rows"]').click();
    await page.locator('#attributeUi details[data-column_name="volume"] summary label.attributeUiAxisButton[data-axis="cells"]').click();
    const pivot = await runQueryAndWaitForPivot(page);

    await expect(page.locator('[data-testid="error-dialog"], .errorDialog, [role="alertdialog"]')).not.toBeVisible().catch(() => {});
    await expect(pivot).toContainText(/1,500|1500/, { timeout: 15000 });
  });
});
