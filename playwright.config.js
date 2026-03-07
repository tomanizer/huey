// @ts-check
const { defineConfig, devices } = require('@playwright/test');

const localProjects = [
  { name: 'chromium', use: { ...devices['Desktop Chrome'] } },
  { name: 'firefox', use: { ...devices['Desktop Firefox'] } },
  { name: 'webkit', use: { ...devices['Desktop Safari'] } },
];

const requestedProjectNames = process.env.PLAYWRIGHT_PROJECTS
  ? process.env.PLAYWRIGHT_PROJECTS.split(',').map((project) => project.trim()).filter(Boolean)
  : null;
const defaultProjects = process.env.CI ? ['chromium'] : localProjects.map((project) => project.name);
const selectedProjectNames = requestedProjectNames && requestedProjectNames.length ? requestedProjectNames : defaultProjects;
const selectedProjects = localProjects.filter((project) => selectedProjectNames.includes(project.name));
const liveRemoteEnabled = process.env.PLAYWRIGHT_REMOTE_LIVE === '1';
const liveRemoteBaseUrl = process.env.PLAYWRIGHT_REMOTE_BASE_URL || 'http://127.0.0.1:8002';
const liveRemoteUrl = new URL(liveRemoteBaseUrl);
const liveRemotePort = liveRemoteUrl.port || '8002';
const frontendServer = {
  command: 'npm run dev -- --host 127.0.0.1 --port 8765 --strictPort',
  url: 'http://127.0.0.1:8765',
  reuseExistingServer: !process.env.CI,
  timeout: 120000,
};
const liveRemoteServer = {
  command: 'mkdir -p /tmp/huey-playwright-exports && '
    + 'QUERYSERVICE_CORS_ORIGINS=\'["http://127.0.0.1:8765"]\' '
    + 'QUERYSERVICE_SEED_SAMPLE_DATA=true '
    + 'QUERYSERVICE_EXECUTION_MODE=sample_table '
    + 'QUERYSERVICE_DATASETS_CONFIG_PATH=tests/ui/fixtures/queryservice-live-datasets.yaml '
    + 'QUERYSERVICE_EXPORT_OUTPUT_DIR=/tmp/huey-playwright-exports '
    + 'QUERYSERVICE_EXPORT_DB_PATH=/tmp/huey-playwright-exports/jobs.db '
    + `python -m uvicorn server.main:app --host ${liveRemoteUrl.hostname} --port ${liveRemotePort}`,
  url: `${liveRemoteBaseUrl}/health/liveness`,
  reuseExistingServer: !process.env.CI,
  timeout: 120000,
};

if (!selectedProjects.length) {
  throw new Error(
    `No valid Playwright projects selected from PLAYWRIGHT_PROJECTS=${process.env.PLAYWRIGHT_PROJECTS}. `
    + `Available projects: ${localProjects.map((project) => project.name).join(', ')}`
  );
}

module.exports = defineConfig({
  testDir: 'tests/ui',
  outputDir: 'test-results/playwright-output',
  timeout: 120000,
  fullyParallel: true,
  forbidOnly: !!process.env.CI,
  retries: process.env.CI ? 1 : 0,
  workers: 1,
  reporter: process.env.CI
    ? [
        ['list'],
        ['junit', { outputFile: 'playwright-results/junit.xml' }],
        ['html', { outputFolder: 'playwright-results/report', open: 'never' }],
      ]
    : 'list',
  outputDir: 'playwright-results/test-results',
  expect: {
    timeout: 10000,
  },
  use: {
    baseURL: 'http://127.0.0.1:8765',
    trace: 'on-first-retry',
  },
  projects: selectedProjects,
  webServer: liveRemoteEnabled ? [liveRemoteServer, frontendServer] : frontendServer,
});
