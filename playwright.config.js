import { defineConfig, devices } from '@playwright/test';

export default defineConfig({
  testDir: './tests/e2e',
  // Run each test file in isolation.
  fullyParallel: true,
  // Fail the build on CI if you accidentally left test.only.
  forbidOnly: !!process.env.CI,
  // No retries locally; 1 retry on CI to tolerate transient flakiness.
  retries: process.env.CI ? 1 : 0,
  // Limit parallelism on CI to avoid resource contention.
  workers: process.env.CI ? 2 : undefined,
  reporter: process.env.CI ? [['github'], ['html', { open: 'never' }]] : 'list',

  use: {
    baseURL: 'http://localhost:3000',
    // Capture screenshot / trace only on the first retry to keep CI fast.
    screenshot: 'only-on-failure',
    trace: 'on-first-retry',
    // Use fake mic/camera so tests don't need a real microphone and the
    // permission dialog is auto-accepted.
    launchOptions: {
      args: ['--use-fake-device-for-media-stream', '--use-fake-ui-for-media-stream'],
    },
  },

  projects: [
    {
      name: 'chromium',
      use: { ...devices['Desktop Chrome'] },
    },
  ],

  // Start a static file server before running tests.
  webServer: {
    command: 'npx serve -l 3000 .',
    url: 'http://localhost:3000',
    reuseExistingServer: !process.env.CI,
    timeout: 30_000,
  },
});
