import { defineConfig, devices } from 'playwright/test';

const chromiumExecutable = process.env.PLAYWRIGHT_CHROMIUM_EXECUTABLE_PATH;

export default defineConfig({
  testDir: './test/demos',
  testMatch: '**/*.spec.ts',
  outputDir: 'test-results/demos',
  fullyParallel: false,
  workers: 1,
  timeout: 300_000,
  expect: { timeout: 20_000 },
  forbidOnly: Boolean(process.env.CI),
  retries: process.env.CI ? 1 : 0,
  reporter: process.env.CI
    ? [['line'], ['html', { outputFolder: 'test-results/demo-html-report', open: 'never' }]]
    : [['list'], ['html', { outputFolder: 'test-results/demo-html-report', open: 'never' }]],
  use: {
    ...devices['Desktop Chrome'],
    ...(chromiumExecutable === undefined ? { channel: 'chromium' as const } : {}),
    launchOptions: {
      args: ['--autoplay-policy=no-user-gesture-required'],
      ...(chromiumExecutable === undefined ? {} : { executablePath: chromiumExecutable }),
    },
    screenshot: 'only-on-failure',
    trace: 'retain-on-failure',
    video: 'retain-on-failure',
  },
  projects: [{ name: 'chromium' }],
  webServer: [
    {
      command: 'node scripts/start-demo-server.mjs vanilla 4191',
      url: 'http://127.0.0.1:4191/',
      reuseExistingServer: false,
      timeout: 120_000,
    },
    {
      command: 'node scripts/start-demo-server.mjs react 4192',
      url: 'http://127.0.0.1:4192/',
      reuseExistingServer: false,
      timeout: 120_000,
    },
    {
      command: 'node scripts/start-demo-server.mjs next 4193',
      url: 'http://127.0.0.1:4193/',
      reuseExistingServer: false,
      timeout: 180_000,
    },
  ],
});
