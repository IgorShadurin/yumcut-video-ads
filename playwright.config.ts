import { defineConfig, devices } from 'playwright/test';

const port = 4173;
const chromiumExecutable = process.env.PLAYWRIGHT_CHROMIUM_EXECUTABLE_PATH;

export default defineConfig({
  testDir: './test/browser',
  testMatch: '**/*.spec.ts',
  outputDir: 'test-results/playwright',
  fullyParallel: false,
  workers: 1,
  timeout: 180_000,
  expect: { timeout: 15_000 },
  forbidOnly: Boolean(process.env.CI),
  retries: process.env.CI ? 1 : 0,
  reporter: process.env.CI
    ? [['line'], ['html', { outputFolder: 'test-results/html-report', open: 'never' }]]
    : [['list'], ['html', { outputFolder: 'test-results/html-report', open: 'never' }]],
  use: {
    baseURL: `http://127.0.0.1:${port}`,
    screenshot: 'only-on-failure',
    trace: 'retain-on-failure',
    video: 'retain-on-failure',
  },
  projects: [
    {
      name: 'chromium',
      testIgnore: '**/mobile-support.spec.ts',
      use: {
        ...devices['Desktop Chrome'],
        ...(chromiumExecutable === undefined ? { channel: 'chromium' as const } : {}),
        launchOptions: {
          args: ['--autoplay-policy=no-user-gesture-required'],
          ...(chromiumExecutable === undefined ? {} : { executablePath: chromiumExecutable }),
        },
      },
    },
    {
      name: 'mobile-chromium',
      testMatch: '**/mobile-support.spec.ts',
      use: {
        ...devices['Pixel 7'],
        ...(chromiumExecutable === undefined ? { channel: 'chromium' as const } : {}),
        launchOptions: {
          args: ['--autoplay-policy=no-user-gesture-required'],
          ...(chromiumExecutable === undefined ? {} : { executablePath: chromiumExecutable }),
        },
      },
    },
  ],
  webServer: {
    command: `npx vite --host 127.0.0.1 --port ${port} --strictPort`,
    url: `http://127.0.0.1:${port}/test/browser/harness/`,
    reuseExistingServer: !process.env.CI,
    timeout: 30_000,
  },
});
