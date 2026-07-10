import { defineConfig, devices } from 'playwright/test';

const chromiumExecutable = process.env.PLAYWRIGHT_CHROMIUM_EXECUTABLE_PATH;

export default defineConfig({
  testDir: './test/deployment',
  testMatch: '**/*.spec.ts',
  outputDir: 'test-results/showcase',
  fullyParallel: false,
  workers: 1,
  timeout: 300_000,
  expect: { timeout: 30_000 },
  forbidOnly: Boolean(process.env.CI),
  retries: process.env.CI ? 1 : 0,
  reporter: process.env.CI
    ? [['line'], ['html', { outputFolder: 'test-results/showcase-html-report', open: 'never' }]]
    : [['list'], ['html', { outputFolder: 'test-results/showcase-html-report', open: 'never' }]],
  use: {
    ...devices['Desktop Chrome'],
    baseURL: 'http://127.0.0.1:4399',
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
  webServer: {
    command: 'npm run build:showcase && node scripts/showcase-server.mjs',
    url: 'http://127.0.0.1:4399/healthz',
    env: {
      HOST: '127.0.0.1',
      PORT: '4399',
    },
    reuseExistingServer: false,
    timeout: 600_000,
  },
});
