// @ts-check
const { expect } = require('@playwright/test');

async function openApp(page) {
  await page.setViewportSize({ width: 1600, height: 1400 });
  const response = await page.goto('/index.html', { waitUntil: 'domcontentloaded' });
  expect(response, 'Expected the Huey app entrypoint to respond.').not.toBeNull();
  expect(response && response.ok(), 'Expected the Huey app entrypoint to load successfully.').toBe(true);
}

async function waitForAppReady(page) {
  await openApp(page);
  await expect(page.locator('body')).toHaveAttribute('aria-busy', 'false', { timeout: 60000 });
  await expect(page.locator('#layout')).toBeVisible({ timeout: 60000 });
  await expect(page.locator('#uploader')).toBeAttached({ timeout: 20000 });
  // Autorun may be enabled by persisted settings, in which case the manual
  // run button remains in the DOM but is intentionally hidden.
  await expect(page.locator('#runQueryButton')).toBeAttached({ timeout: 30000 });
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
  await addFilterAxis(page, 'symbol');
}

async function addFilterAxis(page, columnName) {
  await openAttributesTab(page);
  const filterToggle = page.locator(`#attributeUi details[data-column_name="${columnName}"] summary label.attributeUiAxisButton[data-axis="filters"]`);
  await expect(filterToggle).toBeVisible({ timeout: 15000 });
  await filterToggle.click();
  await expect(page.locator('#queryUi section[data-axis="filters"] > ol > li')).toHaveCount(1, { timeout: 30000 });
  const filterDialog = page.locator('#filterDialog');
  if (await filterDialog.isVisible().catch(() => false)) {
    await page.locator('#filterDialogCancelButton').click();
    await expect(filterDialog).not.toBeVisible({ timeout: 10000 });
  }
}

async function addAggregateMeasure(page, columnName, aggregator) {
  await openAttributesTab(page);
  const columnNode = page.locator(`#attributeUi details[data-column_name="${columnName}"]`).first();
  await expect(columnNode).toBeVisible({ timeout: 15000 });
  const columnSummary = columnNode.locator(':scope > summary');
  await expect(columnSummary).toBeVisible({ timeout: 15000 });
  if ((await columnNode.getAttribute('open')) === null) {
    await columnSummary.click();
  }

  const checkedMeasureInputs = columnNode.locator('label.attributeUiAxisButton[data-axis="cells"] > input[type="checkbox"]:checked');
  const checkedCount = await checkedMeasureInputs.count();
  const activeAggregators = [];
  for (let i = 0; i < checkedCount; i++) {
    const activeAggregator = await checkedMeasureInputs.nth(i).getAttribute('data-aggregator');
    activeAggregators.push(activeAggregator);
  }

  for (const activeAggregator of activeAggregators) {
    if (activeAggregator !== aggregator) {
      const checkedLabel = columnNode.locator(`label.attributeUiAxisButton[data-axis="cells"]:has(> input[type="checkbox"][data-aggregator="${activeAggregator}"])`).first();
      await expect(checkedLabel).toBeVisible({ timeout: 15000 });
      await checkedLabel.click();
    }
  }

  const measureLabel = columnNode.locator(`label.attributeUiAxisButton[data-axis="cells"]:has(> input[type="checkbox"][data-aggregator="${aggregator}"])`).first();
  const measureInput = measureLabel.locator(`input[type="checkbox"][data-aggregator="${aggregator}"]`).first();
  await expect(measureInput).toBeAttached({ timeout: 15000 });
  if (!(await measureInput.isChecked())) {
    await measureLabel.evaluate((label) => {
      label.click();
    });
  }
}

async function runQueryAndWaitForPivot(page) {
  const runButton = page.locator('#runQueryButton');
  await expect(runButton).toBeAttached({ timeout: 15000 });
  if (await runButton.isVisible()) {
    await runButton.evaluate((button) => {
      button.click();
    });
  } else {
    const autoRun = page.locator('#autoRunQuery');
    await expect(autoRun).toBeChecked({ timeout: 5000 });
  }

  const pivot = page.locator('#pivotTableUi');
  await expect(pivot).toBeVisible({ timeout: 60000 });
  await expect(pivot).toHaveAttribute('aria-busy', 'false', { timeout: 60000 });
  await expect(page.locator('#pivotTableUi .pivotTableUiValueCell').first()).toBeVisible({ timeout: 60000 });
  return pivot;
}

async function triggerUnhandledRejection(page, reason) {
  let payload;
  if (typeof reason === 'string') {
    payload = { type: 'string', value: reason };
  } else if (reason instanceof Error) {
    payload = { type: 'error', message: reason.message, name: reason.name || 'Error' };
  } else if (reason && typeof reason === 'object' && 'message' in reason) {
    payload = {
      type: 'error',
      message: String(reason.message),
      name: typeof reason.name === 'string' ? reason.name : 'Error',
    };
  } else {
    payload = { type: 'string', value: String(reason) };
  }

  await page.evaluate((rejection) => {
    let rejectionReason;
    if (rejection.type === 'error') {
      rejectionReason = new Error(rejection.message);
      rejectionReason.name = rejection.name;
    } else {
      rejectionReason = rejection.value;
    }
    const event = typeof PromiseRejectionEvent === 'function'
      ? new PromiseRejectionEvent('unhandledrejection', {
          cancelable: true,
          promise: Promise.resolve(),
          reason: rejectionReason,
        })
      : Object.assign(new Event('unhandledrejection', { cancelable: true }), {
          promise: Promise.resolve(),
          reason: rejectionReason,
        });
    window.dispatchEvent(event);
  }, payload);
}

module.exports = {
  waitForAppReady,
  uploadFixtureAndWaitForAttributes,
  openAttributesTab,
  addBasicPivotAxes,
  addFilterAxis,
  addSymbolFilterAxis,
  addAggregateMeasure,
  runQueryAndWaitForPivot,
  triggerUnhandledRejection,
};
