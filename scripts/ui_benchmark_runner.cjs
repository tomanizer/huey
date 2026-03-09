const fs = require('node:fs');
const path = require('node:path');
const { spawn } = require('node:child_process');
const { chromium, expect } = require('@playwright/test');

const rootDir = path.resolve(__dirname, '..');
const wideParquet = path.join(rootDir, 'tests/fixtures/parquet/wide.parquet');
const longParquet = path.join(rootDir, 'tests/fixtures/parquet/long.parquet');
const defaultOutputDir = path.join(rootDir, 'artifacts/ui-benchmarks/latest');
const defaultBaselinePath = path.join(rootDir, 'benchmarks/ui/baseline_metrics.json');
const serverUrl = 'http://127.0.0.1:8765';

function parseArgs(argv) {
  const args = {
    outputDir: defaultOutputDir,
    baseline: defaultBaselinePath,
    browser: 'chromium',
  };
  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i];
    switch (arg) {
      case '--output-dir':
        args.outputDir = path.resolve(rootDir, argv[++i]);
        break;
      case '--baseline':
        args.baseline = path.resolve(rootDir, argv[++i]);
        break;
      case '--browser':
        args.browser = argv[++i];
        break;
      default:
        throw new Error(`Unknown argument: ${arg}`);
    }
  }
  return args;
}

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

async function waitForServer(url, timeoutMs) {
  const startedAt = Date.now();
  while (Date.now() - startedAt < timeoutMs) {
    try {
      const response = await fetch(url);
      if (response.ok) {
        return;
      }
    } catch (_error) {
      // server not ready yet
    }
    await sleep(1000);
  }
  throw new Error(`Timed out waiting for benchmark server at ${url}`);
}

function startServer(logPath) {
  const child = spawn('node', ['scripts/playwright-web-server.cjs'], {
    cwd: rootDir,
    env: {
      ...process.env,
      PLAYWRIGHT_WEB_SERVER_LOG_PATH: logPath,
    },
    stdio: ['ignore', 'pipe', 'pipe'],
  });

  child.stdout.on('data', (chunk) => {
    process.stdout.write(chunk);
  });
  child.stderr.on('data', (chunk) => {
    process.stderr.write(chunk);
  });
  return child;
}

async function stopServer(child) {
  if (!child || child.killed) {
    return;
  }
  child.kill('SIGTERM');
  await new Promise((resolve) => {
    child.once('exit', () => resolve());
    setTimeout(resolve, 5000);
  });
}

function classifySql(text) {
  if (text.includes('DESCRIBE SELECT *')) return 'schema';
  if (text.includes('WITH __huey_cells')) return 'cells';
  if (text.includes('SELECT COUNT(*) AS "__huey_count"')) return 'tuple_counts';
  if (text.includes('COUNT(*) OVER ()')) return 'tuples';
  return 'other';
}

function createSqlRecorder(page) {
  const entries = [];
  page.on('console', (message) => {
    const text = message.text();
    if (!text.includes('Executing ')) {
      return;
    }
    const timeMatch = text.match(/: ([0-9.]+) ms$/);
    entries.push({
      text,
      timeMs: timeMatch ? Number.parseFloat(timeMatch[1]) : null,
      kind: classifySql(text),
      recordedAt: Date.now(),
    });
  });
  return {
    mark() {
      return entries.length;
    },
    getSlice(mark) {
      return entries.slice(mark);
    },
  };
}

async function waitForAppReady(page) {
  await page.setViewportSize({ width: 1600, height: 1400 });
  const response = await page.goto('/index.html', { waitUntil: 'domcontentloaded' });
  expect(response && response.ok()).toBe(true);
  await expect(page.locator('body')).toHaveAttribute('aria-busy', 'false', { timeout: 60000 });
  await expect(page.locator('#layout')).toBeVisible({ timeout: 60000 });
  await expect(page.locator('#uploader')).toBeAttached({ timeout: 20000 });
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

async function uploadParquetAndWaitForAttribute(page, fixturePath, expectedColumn) {
  await waitForAppReady(page);
  await page.locator('#uploader').setInputFiles(fixturePath);
  await expect(page.locator('#attributeUi')).toBeVisible({ timeout: 60000 });
  await expect(page.locator(`#attributeUi details[data-column_name="${expectedColumn}"]`)).toBeVisible({ timeout: 60000 });
}

async function uploadParquetOnReadyPageAndWaitForAttribute(page, fixturePath, expectedColumn) {
  await page.locator('#uploader').setInputFiles(fixturePath);
  await expect(page.locator('#attributeUi')).toBeVisible({ timeout: 60000 });
  await expect(page.locator(`#attributeUi details[data-column_name="${expectedColumn}"]`)).toBeVisible({ timeout: 60000 });
}

async function addToAxis(page, columnName, axis) {
  await openAttributesTab(page);
  const toggle = page.locator(
    `#attributeUi details[data-nodetype="column"][data-column_name="${columnName}"] > summary label.attributeUiAxisButton[data-axis="${axis}"]`
  );
  await expect(toggle).toBeVisible({ timeout: 15000 });
  await toggle.click();
}

async function clearAxis(page, axis) {
  const button = page.locator(`#queryUi section[data-axis="${axis}"] button[id$="-clear-axis"]`);
  await expect(button).toBeVisible({ timeout: 15000 });
  await button.evaluate((element) => element.click());
  await expect(page.locator(`#queryUi section[data-axis="${axis}"] > ol > li`)).toHaveCount(0, { timeout: 30000 });
}

async function runQueryAndWaitForPivot(page) {
  const runButton = page.locator('#runQueryButton');
  const pivot = page.locator('#pivotTableUi');
  const needsUpdateBefore = await pivot.getAttribute('data-needs-update');
  if (await runButton.isVisible()) {
    await runButton.evaluate((button) => button.click());
  }
  await expect(pivot).toBeVisible({ timeout: 60000 });
  if (needsUpdateBefore === 'true') {
    await expect(pivot).toHaveAttribute('data-needs-update', 'false', { timeout: 60000 });
  }
  await expect(pivot).toHaveAttribute('aria-busy', 'false', { timeout: 60000 });
  await expect(page.locator('#pivotTableUi .pivotTableUiValueCell').first()).toBeVisible({ timeout: 60000 });
}

async function clearPerformanceMetrics(page) {
  await page.evaluate(() => {
    window.__hueyLastPerformanceMetrics = null;
    window.__hueyPerformanceHistory = [];
  });
}

async function getLastPerformanceMetrics(page) {
  return await page.evaluate(() => {
    return window.__hueyLastPerformanceMetrics || null;
  });
}

async function setupLongPivot(page) {
  await uploadParquetAndWaitForAttribute(page, longParquet, 'symbol');
  await ensureAutoRunDisabled(page);
  await addToAxis(page, 'symbol', 'rows');
  await addToAxis(page, 'price', 'cells');
}

async function runAndRecordPivotScenario(page, recorder, name, extra) {
  await clearPerformanceMetrics(page);
  const mark = recorder.mark();
  const start = Date.now();
  await runQueryAndWaitForPivot(page);
  const metrics = await getLastPerformanceMetrics(page);
  return buildScenarioResult(name, Date.now() - start, recorder.getSlice(mark), metrics, extra);
}

function summarizeSql(entries) {
  const summary = {
    count: entries.length,
    totalTimeMs: 0,
    byKind: {},
  };
  entries.forEach((entry) => {
    if (entry.timeMs) {
      summary.totalTimeMs += entry.timeMs;
    }
    summary.byKind[entry.kind] = (summary.byKind[entry.kind] || 0) + 1;
  });
  summary.totalTimeMs = Math.round(summary.totalTimeMs);
  return summary;
}

function buildScenarioResult(name, wallTimeMs, sqlEntries, uiMetrics, extra) {
  return {
    name,
    wallTimeMs: Math.round(wallTimeMs),
    uiMetrics: uiMetrics || null,
    sql: summarizeSql(sqlEntries),
    extra: extra || {},
  };
}

async function runScenarios(browserType) {
  const browser = await browserType.launch({ headless: true });
  const results = [];

  try {
    {
      const context = await browser.newContext({ baseURL: serverUrl });
      const page = await context.newPage();
      const recorder = createSqlRecorder(page);
      const start = Date.now();
      const mark = recorder.mark();
      await waitForAppReady(page);
      results.push(buildScenarioResult('app_ready', Date.now() - start, recorder.getSlice(mark), null, {}));
      await context.close();
    }

    {
      const context = await browser.newContext({ baseURL: serverUrl });
      const page = await context.newPage();
      const recorder = createSqlRecorder(page);
      const start = Date.now();
      const mark = recorder.mark();
      await uploadParquetAndWaitForAttribute(page, wideParquet, 'id');
      results.push(buildScenarioResult('upload_wide_schema', Date.now() - start, recorder.getSlice(mark), null, {
        fixture: path.relative(rootDir, wideParquet),
      }));

      await page.close();
      const reopenPage = await context.newPage();
      const reopenRecorder = createSqlRecorder(reopenPage);
      const reopenStart = Date.now();
      const reopenMark = reopenRecorder.mark();
      await waitForAppReady(reopenPage);
      await uploadParquetOnReadyPageAndWaitForAttribute(reopenPage, wideParquet, 'id');
      results.push(buildScenarioResult('upload_wide_schema_cached', Date.now() - reopenStart, reopenRecorder.getSlice(reopenMark), null, {
        fixture: path.relative(rootDir, wideParquet),
      }));
      await context.close();
    }

    {
      const context = await browser.newContext({ baseURL: serverUrl });
      const page = await context.newPage();
      const recorder = createSqlRecorder(page);

      await setupLongPivot(page);
      results.push(await runAndRecordPivotScenario(page, recorder, 'long_pivot_first_run', {
        fixture: path.relative(rootDir, longParquet),
      }));

      results.push(await runAndRecordPivotScenario(page, recorder, 'long_pivot_rerun', {
        fixture: path.relative(rootDir, longParquet),
      }));

      const innerContainer = page.locator('#pivotTableUi .pivotTableUiInnerContainer');
      const mark = recorder.mark();
      const start = Date.now();
      await innerContainer.evaluate((element) => {
        element.scrollTop += 2000;
      });
      await page.waitForTimeout(500);
      await expect(page.locator('#pivotTableUi')).toHaveAttribute('aria-busy', 'false', { timeout: 30000 });
      results.push(buildScenarioResult('long_pivot_scroll', Date.now() - start, recorder.getSlice(mark), null, {
        fixture: path.relative(rootDir, longParquet),
      }));

      await clearAxis(page, 'rows');
      await clearAxis(page, 'columns');
      await clearAxis(page, 'cells');
      await addToAxis(page, 'trade_date', 'rows');
      await addToAxis(page, 'symbol', 'columns');
      await addToAxis(page, 'price', 'cells');

      results.push(await runAndRecordPivotScenario(page, recorder, 'long_pivot_second_shape', {
        fixture: path.relative(rootDir, longParquet),
      }));

      await context.close();
    }

    {
      const context = await browser.newContext({ baseURL: serverUrl });
      const page = await context.newPage();
      const recorder = createSqlRecorder(page);

      await setupLongPivot(page);
      results.push(await runAndRecordPivotScenario(page, recorder, 'long_reopen_same_file_first_run', {
        fixture: path.relative(rootDir, longParquet),
      }));

      await context.close();
    }
  }
  finally {
    await browser.close();
  }

  return results;
}

function compareToBaseline(results, baseline) {
  if (!baseline || !Array.isArray(baseline.scenarios)) {
    return null;
  }
  const baselineByName = new Map(baseline.scenarios.map((scenario) => [scenario.name, scenario]));
  return results.map((scenario) => {
    const base = baselineByName.get(scenario.name);
    if (!base) {
      return { name: scenario.name };
    }
    const uiTotal = scenario.uiMetrics && scenario.uiMetrics.totalTimeMs;
    const baseUiTotal = base.uiMetrics && base.uiMetrics.totalTimeMs;
    return {
      name: scenario.name,
      wallTimeMsDelta: scenario.wallTimeMs - base.wallTimeMs,
      sqlTotalTimeMsDelta: scenario.sql.totalTimeMs - base.sql.totalTimeMs,
      uiTotalTimeMsDelta: (typeof uiTotal === 'number' && typeof baseUiTotal === 'number')
        ? uiTotal - baseUiTotal
        : null,
    };
  });
}

function writeCsv(filePath, results, comparison) {
  const comparisonByName = new Map((comparison || []).map((entry) => [entry.name, entry]));
  const lines = [
    [
      'scenario',
      'wall_time_ms',
      'ui_query_ms',
      'ui_render_ms',
      'ui_total_ms',
      'sql_count',
      'sql_total_time_ms',
      'sql_schema_count',
      'sql_tuple_count_queries',
      'sql_tuples_count',
      'sql_cells_count',
      'wall_time_delta_ms',
      'ui_total_delta_ms',
      'sql_total_delta_ms',
    ].join(','),
  ];

  results.forEach((scenario) => {
    const delta = comparisonByName.get(scenario.name) || {};
    lines.push([
      scenario.name,
      scenario.wallTimeMs,
      scenario.uiMetrics ? scenario.uiMetrics.queryTimeMs : '',
      scenario.uiMetrics ? scenario.uiMetrics.renderTimeMs : '',
      scenario.uiMetrics ? scenario.uiMetrics.totalTimeMs : '',
      scenario.sql.count,
      scenario.sql.totalTimeMs,
      scenario.sql.byKind.schema || 0,
      scenario.sql.byKind.tuple_counts || 0,
      scenario.sql.byKind.tuples || 0,
      scenario.sql.byKind.cells || 0,
      delta.wallTimeMsDelta ?? '',
      delta.uiTotalTimeMsDelta ?? '',
      delta.sqlTotalTimeMsDelta ?? '',
    ].join(','));
  });

  fs.writeFileSync(filePath, `${lines.join('\n')}\n`, 'utf8');
}

function writeMarkdown(filePath, results, comparison, baselinePath) {
  const comparisonByName = new Map((comparison || []).map((entry) => [entry.name, entry]));
  const lines = [
    '# UI benchmark summary',
    '',
    `Generated: ${new Date().toISOString()}`,
    '',
    baselinePath ? `Baseline: \`${path.relative(rootDir, baselinePath)}\`` : 'Baseline: none',
    '',
    '| Scenario | Wall (ms) | UI Query | UI Render | UI Total | SQL Count | SQL Total | Schema | Tuple Count Queries | Tuples | Cells | Wall Δ | UI Total Δ | SQL Total Δ |',
    '| --- | ---: | ---: | ---: | ---: | ---: | ---: | ---: | ---: | ---: | ---: | ---: | ---: | ---: |',
  ];

  results.forEach((scenario) => {
    const delta = comparisonByName.get(scenario.name) || {};
    lines.push(
      `| ${scenario.name} | ${scenario.wallTimeMs} | ${scenario.uiMetrics ? scenario.uiMetrics.queryTimeMs : ''} | ${scenario.uiMetrics ? scenario.uiMetrics.renderTimeMs : ''} | ${scenario.uiMetrics ? scenario.uiMetrics.totalTimeMs : ''} | ${scenario.sql.count} | ${scenario.sql.totalTimeMs} | ${scenario.sql.byKind.schema || 0} | ${scenario.sql.byKind.tuple_counts || 0} | ${scenario.sql.byKind.tuples || 0} | ${scenario.sql.byKind.cells || 0} | ${delta.wallTimeMsDelta ?? ''} | ${delta.uiTotalTimeMsDelta ?? ''} | ${delta.sqlTotalTimeMsDelta ?? ''} |`
    );
  });

  fs.writeFileSync(filePath, `${lines.join('\n')}\n`, 'utf8');
}

async function main() {
  const args = parseArgs(process.argv.slice(2));
  fs.mkdirSync(args.outputDir, { recursive: true });
  const webServerLogPath = path.join(args.outputDir, 'webserver.log');

  let baseline = null;
  if (fs.existsSync(args.baseline)) {
    baseline = JSON.parse(fs.readFileSync(args.baseline, 'utf8'));
  }

  const server = startServer(webServerLogPath);
  try {
    await waitForServer(serverUrl, 240000);
    const results = await runScenarios(chromium);
    const comparison = compareToBaseline(results, baseline);
    const report = {
      generatedAt: new Date().toISOString(),
      browser: args.browser,
      baseUrl: serverUrl,
      scenarios: results,
      comparison,
      baselinePath: fs.existsSync(args.baseline) ? path.relative(rootDir, args.baseline) : null,
    };

    const jsonPath = path.join(args.outputDir, 'ui-benchmark-report.json');
    const csvPath = path.join(args.outputDir, 'ui-benchmark-report.csv');
    const mdPath = path.join(args.outputDir, 'ui-benchmark-summary.md');

    fs.writeFileSync(jsonPath, `${JSON.stringify(report, null, 2)}\n`, 'utf8');
    writeCsv(csvPath, results, comparison);
    writeMarkdown(mdPath, results, comparison, report.baselinePath ? args.baseline : null);

    console.log(`UI benchmark report written to ${jsonPath}`);
    console.log(`UI benchmark summary written to ${mdPath}`);
  }
  finally {
    await stopServer(server);
  }
}

main().catch((error) => {
  console.error(error.stack || error);
  process.exit(1);
});
