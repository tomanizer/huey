// @ts-check
const { defineConfig, devices } = require('@playwright/test');

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
  projects: [
    { name: 'chromium', use: { ...devices['Desktop Chrome'] } },
    { name: 'firefox', use: { ...devices['Desktop Firefox'] } },
    { name: 'webkit', use: { ...devices['Desktop Safari'] } },
  ],
  webServer: {
    command: 'npx vite --host 127.0.0.1 --port 8765',
    url: 'http://127.0.0.1:8765',
    reuseExistingServer: !process.env.CI,
    timeout: 120000,
  },
});
