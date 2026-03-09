// @ts-check
const { test, expect } = require('@playwright/test');
const path = require('path');
const fs = require('fs');
const {
  waitForAppReady,
  openAttributesTab,
  addAggregateMeasure,
  runQueryAndWaitForPivot,
} = require('./helpers/app-bootstrap');

// ─── URL constants ────────────────────────────────────────────────────────────

const PROMPTS_CSV_URL =
  'https://huggingface.co/datasets/fka/prompts.chat/raw/b42151a2dc563a0ea3f76b275f3ffeae07f35d9a/prompts.csv';

const LOAN_RISKS_URL =
  'https://github.com/databricks/LearningSparkV2/raw/refs/heads/master/databricks-datasets/learning-spark-v2/loans/loan-risks.snappy.parquet';

// Stable fake origin — never reaches the real network.
const FAKE_CDN = 'https://cdn.example.test/data';

// ─── Shared helpers ───────────────────────────────────────────────────────────

/**
 * Install a page.route() interceptor that fulfils every request for `url`
 * (HEAD, OPTIONS, GET, byte-range GET) with the contents of a local file.
 * This lets DuckDB WASM's HTTP-range-request protocol work without any
 * real outbound network traffic.
 *
 * @param {import('@playwright/test').Page} page
 * @param {string} url          Exact URL to intercept.
 * @param {string} fixturePath  Absolute path to the local file to serve.
 * @param {string} contentType  MIME type to advertise in Content-Type.
 */
async function routeLocalFile(page, url, fixturePath, contentType) {
  const content = fs.readFileSync(fixturePath); // Buffer — works for binary and text
  const total = content.length;
  const corsHeaders = { 'access-control-allow-origin': '*' };

  await page.route(url, async (route) => {
    const method = route.request().method();

    if (method === 'OPTIONS') {
      await route.fulfill({
        status: 204,
        headers: {
          ...corsHeaders,
          'access-control-allow-methods': 'GET, HEAD, OPTIONS',
          'access-control-allow-headers': '*',
        },
      });
      return;
    }

    if (method === 'HEAD') {
      await route.fulfill({
        status: 200,
        headers: {
          ...corsHeaders,
          'content-type': contentType,
          'content-length': String(total),
          'accept-ranges': 'bytes',
        },
        body: Buffer.alloc(0),
      });
      return;
    }

    // Byte-range GET — DuckDB WASM uses this to stream large files efficiently.
    const rangeHeader = route.request().headers()['range'];
    if (rangeHeader) {
      const match = rangeHeader.match(/bytes=(\d+)-(\d+)?/);
      if (match) {
        const start = parseInt(match[1], 10);
        const end =
          match[2] !== undefined
            ? Math.min(parseInt(match[2], 10), total - 1)
            : total - 1;
        const slice = content.slice(start, end + 1);
        await route.fulfill({
          status: 206,
          headers: {
            ...corsHeaders,
            'content-type': contentType,
            'content-range': `bytes ${start}-${end}/${total}`,
            'content-length': String(slice.length),
          },
          body: slice,
        });
        return;
      }
    }

    // Full GET.
    await route.fulfill({
      status: 200,
      headers: {
        ...corsHeaders,
        'content-type': contentType,
        'content-length': String(total),
        'accept-ranges': 'bytes',
      },
      body: content,
    });
  });
}

/**
 * Open the "Data from URL" prompt, enter a URL, and submit.
 */
async function loadFromUrl(page, url) {
  await page.locator('#loadFromUrl').click();
  await expect(page.locator('#promptUi')).toBeVisible({ timeout: 10000 });
  await page.locator('#loadFromUrlInput').fill(url);
  await page.locator('#promptDialogAcceptButton').click();
  await expect(page.locator('#promptUi')).not.toBeVisible({ timeout: 10000 });
}

/**
 * Assert that every column in `columnNames` is visible in the attribute panel.
 * @param {import('@playwright/test').Page} page
 * @param {string[]} columnNames
 * @param {number} [timeout=30000]
 */
async function assertColumnsVisible(page, columnNames, timeout = 30000) {
  for (const col of columnNames) {
    await expect(
      page.locator(`#attributeUi details[data-column_name="${col}"]`)
    ).toBeVisible({ timeout });
  }
}

/**
 * Click a column's single-click axis toggle in the attribute panel summary row.
 * Works for rows, columns, and filters axes.
 * For cells use addAggregateMeasure() instead.
 */
async function addToAxis(page, columnName, axis) {
  await openAttributesTab(page);
  const toggle = page.locator(
    `#attributeUi details[data-column_name="${columnName}"] summary label.attributeUiAxisButton[data-axis="${axis}"]`
  );
  await expect(toggle).toBeVisible({ timeout: 15000 });
  await toggle.click();
}

// ─── 1. CSV via HTTPS — prompts.chat dataset ──────────────────────────────────
//
// The real HuggingFace URL is intercepted and served from a local fixture
// (tests/fixtures/prompts-chat.csv).  The fixture is a representative 10-row
// subset of the actual public dataset with the same column layout:
//   act (VARCHAR), prompt (VARCHAR), for_devs (BOOLEAN), type (VARCHAR), contributor (VARCHAR)
//
// Dataset: https://huggingface.co/datasets/fka/prompts.chat

test.describe('Load from URL — CSV (prompts.chat)', () => {
  const fixturePath = path.join(__dirname, '../fixtures/prompts-chat.csv');

  test.beforeEach(async ({ page }) => {
    await routeLocalFile(page, PROMPTS_CSV_URL, fixturePath, 'text/csv; charset=utf-8');
    await waitForAppReady(page);
    await loadFromUrl(page, PROMPTS_CSV_URL);
    await expect(
      page.locator('#attributeUi details[data-column_name="act"]')
    ).toBeVisible({ timeout: 30000 });
  });

  test('all five columns appear in the attribute panel', async ({ page }) => {
    await assertColumnsVisible(page, ['act', 'prompt', 'for_devs', 'type', 'contributor'], 10000);
  });

  test('pivot by prompt type shows TEXT and STRUCTURED categories', async ({ page }) => {
    await addToAxis(page, 'type', 'rows');
    await addAggregateMeasure(page, 'act', 'count');
    const pivot = await runQueryAndWaitForPivot(page);
    await expect(pivot).toContainText('TEXT');
    await expect(pivot).toContainText('STRUCTURED');
  });

  test('pivot by for_devs shows true and false rows', async ({ page }) => {
    await addToAxis(page, 'for_devs', 'rows');
    await addAggregateMeasure(page, 'act', 'count');
    const pivot = await runQueryAndWaitForPivot(page);
    // DuckDB renders BOOLEAN column values as lowercase true / false.
    await expect(pivot).toContainText('true');
    await expect(pivot).toContainText('false');
  });

  test('cross-tab: type on columns, for_devs on rows produces numeric cells', async ({ page }) => {
    await addToAxis(page, 'type', 'columns');
    await addToAxis(page, 'for_devs', 'rows');
    await addAggregateMeasure(page, 'act', 'count');
    const pivot = await runQueryAndWaitForPivot(page);
    await expect(pivot).toContainText('TEXT');
    await expect(pivot).toContainText('STRUCTURED');
    await expect(
      page.locator('#pivotTableUi .pivotTableUiValueCell').first()
    ).toBeVisible({ timeout: 30000 });
  });
});

// ─── 2. Parquet via HTTPS — Databricks loan-risks.snappy.parquet ─────────────
//
// The test intercepts the real GitHub URL and fulfils it locally with
// tests/fixtures/parquet/alltypes.parquet.  This validates the complete
// "load .parquet from HTTPS URL" code path (HEAD → content-type detection →
// DuckDB HTTP read) without requiring a live network connection.
//
// To test with the actual loan-risks schema, download the file from:
//   https://github.com/databricks/LearningSparkV2/raw/refs/heads/master/
//     databricks-datasets/learning-spark-v2/loans/loan-risks.snappy.parquet
// save it to tests/fixtures/parquet/loan-risks.snappy.parquet, and update
// fixturePath below.

test.describe('Load from URL — Parquet (loan-risks, served locally via page.route)', () => {
  const fixturePath = path.join(__dirname, '../fixtures/parquet/alltypes.parquet');

  test.beforeEach(async ({ page }) => {
    await routeLocalFile(
      page,
      LOAN_RISKS_URL,
      fixturePath,
      'application/vnd.apache.parquet'
    );
    await waitForAppReady(page);
    await loadFromUrl(page, LOAN_RISKS_URL);
    await expect(
      page.locator('#attributeUi details[data-column_name="id"]')
    ).toBeVisible({ timeout: 30000 });
  });

  test('datasource loads and all columns are visible', async ({ page }) => {
    await assertColumnsVisible(page, ['id', 'name', 'price', 'quantity', 'is_active', 'trade_date', 'created_at', 'tags'], 10000);
  });

  test('pivot numeric column on cells by date on rows renders values', async ({ page }) => {
    await addToAxis(page, 'trade_date', 'rows');
    await addAggregateMeasure(page, 'price', 'sum');
    const pivot = await runQueryAndWaitForPivot(page);
    await expect(pivot).toContainText(/\d/);
    await expect(
      page.locator('#pivotTableUi .pivotTableUiValueCell').first()
    ).toBeVisible({ timeout: 30000 });
  });
});

// ─── 3. Parquet local fixtures via page.route() ───────────────────────────────
//
// Two tests that each intercept a stable fake HTTPS URL and fulfil it with
// one of the committed parquet fixtures.  No network access is needed.

test.describe('Load from URL — Parquet (local fixtures via page.route)', () => {

  test('alltypes.parquet: all 8 columns detected and pivot renders ticker symbols', async ({ page }) => {
    const fixturePath = path.join(__dirname, '../fixtures/parquet/alltypes.parquet');
    const fakeUrl = `${FAKE_CDN}/alltypes.parquet`;

    await routeLocalFile(page, fakeUrl, fixturePath, 'application/vnd.apache.parquet');
    await waitForAppReady(page);
    await loadFromUrl(page, fakeUrl);

    await assertColumnsVisible(page, ['id', 'name', 'price', 'quantity', 'is_active', 'trade_date', 'created_at', 'tags']);

    await addToAxis(page, 'name', 'rows');
    await addAggregateMeasure(page, 'price', 'sum');
    const pivot = await runQueryAndWaitForPivot(page);
    // The name column contains stock ticker symbols from the fixture generator.
    await expect(pivot).toContainText(/AAPL|GOOG|MSFT|AMZN|TSLA/);
  });

  test('nulls.parquet: nullable columns load without error and null rows appear in pivot', async ({ page }) => {
    const fixturePath = path.join(__dirname, '../fixtures/parquet/nulls.parquet');
    const fakeUrl = `${FAKE_CDN}/nulls.parquet`;

    await routeLocalFile(page, fakeUrl, fixturePath, 'application/vnd.apache.parquet');
    await waitForAppReady(page);
    await loadFromUrl(page, fakeUrl);

    await assertColumnsVisible(page, ['id', 'price', 'empty_col', 'symbol', 'quantity', 'is_valid']);

    // symbol has a null in the first row — the pivot must still render without crashing.
    await addToAxis(page, 'symbol', 'rows');
    await addAggregateMeasure(page, 'price', 'sum');
    const pivot = await runQueryAndWaitForPivot(page);
    await expect(
      page.locator('#pivotTableUi .pivotTableUiValueCell').first()
    ).toBeVisible({ timeout: 30000 });
    await expect(pivot).toContainText(/AAPL|GOOG|MSFT|AMZN|TSLA/);
  });
});
