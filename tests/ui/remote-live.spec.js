// @ts-check
const { test, expect } = require('@playwright/test');
const {
  openAttributesTab,
  addFilterAxis,
  runQueryAndWaitForPivot,
} = require('./helpers/app-bootstrap');

const liveRemoteBaseUrl = process.env.PLAYWRIGHT_REMOTE_BASE_URL || 'http://127.0.0.1:8002';

async function waitForRemoteAppReady(page) {
  await page.goto('/index.html');
  await expect(page.locator('body')).toHaveAttribute('aria-busy', 'false', { timeout: 60000 });
  await expect(page.locator('#layout')).toBeAttached({ timeout: 60000 });
  await expect(page.locator('#addRemoteDatasource')).toBeAttached({ timeout: 30000 });
}

async function registerAndAnalyzeRemoteDatasource(page, datasetId) {
  const schemaResponsePromise = page.waitForResponse((response) => {
    return response.url().includes(`/schema?dataset_id=${encodeURIComponent(datasetId)}`)
      && response.status() === 200;
  });
  await page.evaluate(async ({ baseUrl, datasetId: currentDatasetId }) => {
    const [{ RemoteDatasourceConfig }, { RemoteDatasource }, { datasourcesUi }, { analyzeDatasource }] = await Promise.all([
      import('/DataSource/remote/RemoteDatasourceConfig.js'),
      import('/DataSource/remote/RemoteDatasource.js'),
      import('/DataSource/DataSourcesUi.js'),
      import('/App/analyzeDatasource.js'),
    ]);
    const datasource = new RemoteDatasource(
      RemoteDatasourceConfig.createRemoteDatasourceConfig({
        baseUrl,
        datasetId: currentDatasetId,
      })
    );
    await datasourcesUi.addDatasources([datasource]);
    await analyzeDatasource(datasource);
  }, { baseUrl: liveRemoteBaseUrl, datasetId });
  await schemaResponsePromise;
  await expect(page.locator('details[data-grouptype="remote"]')).toBeAttached({ timeout: 15000 });
  await expect(page.locator('#attributeUi')).toBeVisible({ timeout: 15000 });
}

async function openFilterDialog(page) {
  const picklistResponsePromise = page.waitForResponse((response) => {
    return response.url().includes('/query/picklist') && response.status() === 200;
  });
  const filterButton = page.locator('#queryUi section[data-axis="filters"] li button[id$="-edit-filter-condition"]');
  await expect(filterButton).toBeAttached({ timeout: 10000 });
  await page.evaluate(() => {
    document.querySelector('#queryUi section[data-axis="filters"] li button[id$="-edit-filter-condition"]')?.click();
  });
  await expect(page.locator('#filterDialog')).toBeVisible({ timeout: 10000 });
  await picklistResponsePromise;
}

test.describe('Remote mode live backend', () => {
  test.skip(process.env.PLAYWRIGHT_REMOTE_LIVE !== '1', 'Live remote backend suite requires PLAYWRIGHT_REMOTE_LIVE=1');

  test('registers datasource and uses live schema, tuples, cells, and picklist endpoints', async ({ page }) => {
    await waitForRemoteAppReady(page);
    await registerAndAnalyzeRemoteDatasource(page, 'trades_v1');

    await expect(page.locator('#attributeUi details[data-column_name="symbol"]')).toBeVisible({ timeout: 10000 });
    await expect(page.locator('#attributeUi details[data-column_name="volume"]')).toBeVisible({ timeout: 10000 });

    await openAttributesTab(page);
    await page.locator('#attributeUi details[data-column_name="symbol"] summary label.attributeUiAxisButton[data-axis="rows"]').click();
    await page.locator('#attributeUi details[data-column_name="volume"] summary label.attributeUiAxisButton[data-axis="cells"]').click();
    await addFilterAxis(page, 'symbol');

    const tuplesResponsePromise = page.waitForResponse((response) => {
      return response.url().includes('/query/tuples') && response.status() === 200;
    });
    const cellsResponsePromise = page.waitForResponse((response) => {
      return response.url().includes('/query/cells') && response.status() === 200;
    });
    const pivot = await runQueryAndWaitForPivot(page);
    const [tuplesResponse, cellsResponse] = await Promise.all([tuplesResponsePromise, cellsResponsePromise]);

    await expect(pivot).toContainText(/AAPL|GOOG|MSFT|AMZN|TSLA/, { timeout: 15000 });
    await expect(page.locator('#errorDialog')).not.toBeVisible().catch(() => {});

    const tuplesBody = await tuplesResponse.json();
    expect(tuplesBody.total_count).toBeGreaterThan(0);
    expect(tuplesBody.items.length).toBeGreaterThan(0);

    const cellsBody = await cellsResponse.json();
    expect(cellsBody.cells.length).toBeGreaterThan(0);

    await openFilterDialog(page);
    await expect(page.locator('#filterSearchStatus')).toContainText('5 values found');
    await expect(page.locator('#filterPicklist option')).toHaveCount(5);
  });

  test('shows live backend 409 query errors from a schema-only datasource', async ({ page }) => {
    await waitForRemoteAppReady(page);
    await registerAndAnalyzeRemoteDatasource(page, 'trades_unavailable_v1');

    await openAttributesTab(page);
    await page.locator('#attributeUi details[data-column_name="symbol"] summary label.attributeUiAxisButton[data-axis="rows"]').click();
    await page.locator('#attributeUi details[data-column_name="volume"] summary label.attributeUiAxisButton[data-axis="cells"]').click();

    const conflictResponsePromise = page.waitForResponse((response) => {
      return response.url().includes('/query/') && response.status() === 409;
    });
    await page.evaluate(() => {
      document.getElementById('runQueryButton')?.click();
    });
    const conflictResponse = await conflictResponsePromise;
    const conflictBody = await conflictResponse.json();

    expect(conflictBody.code).toBe('DATASET_UNAVAILABLE');
    expect(conflictBody.details.dataset_id).toBe('trades_unavailable_v1');

    const errorDialog = page.locator('#errorDialog');
    await expect(errorDialog).toBeVisible({ timeout: 15000 });
    await expect(errorDialog.locator('#errorDialogTitle')).toContainText('Dataset is configured but not available for querying');
  });

  test('returns live 422 validation envelopes for malformed requests', async ({ request }) => {
    const response = await request.post(`${liveRemoteBaseUrl}/query/tuples`, {
      data: {
        dataset_id: 'trades_v1',
        date_range: { type: 'single', date: 'not-a-date' },
        query: { fields: [{ field: 'symbol' }] },
      },
    });

    expect(response.status()).toBe(422);
    const body = await response.json();
    expect(body.code).toBe('VALIDATION_ERROR');
    expect(body.message).toBe('Request validation failed');
    expect(body.details.errors).toEqual(expect.arrayContaining([
      expect.objectContaining({
        loc: expect.arrayContaining(['date']),
      }),
    ]));
  });
});
