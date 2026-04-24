import { defineConfig, devices } from '@playwright/test';
import * as path from 'path';

/**
 * Playwright configuration for the Self-Healing Framework.
 *
 * - `workers: 1` ensures our storage/reporter singletons stay consistent
 *   across the two sample tests which intentionally share state
 *   (seed run -> heal run).
 * - A local `http-server` is booted to serve the `mock-ui/` fixtures.
 */
const MOCK_UI_PORT = Number(process.env.MOCK_UI_PORT ?? 5555);

export default defineConfig({
  testDir: './tests',
  timeout: 30_000,
  expect: { timeout: 5_000 },
  fullyParallel: false,
  forbidOnly: !!process.env.CI,
  retries: 0,
  workers: 1,
  reporter: [
    ['list'],
    ['html', { outputFolder: 'playwright-report', open: 'never' }],
  ],
  use: {
    actionTimeout: 4_000,
    baseURL: `http://127.0.0.1:${MOCK_UI_PORT}`,
    trace: 'retain-on-failure',
    screenshot: 'only-on-failure',
  },
  projects: [
    {
      name: 'chromium',
      use: { ...devices['Desktop Chrome'] },
    },
  ],
  webServer: {
    command: `npx http-server ${path.resolve(__dirname, 'mock-ui')} -p ${MOCK_UI_PORT} -c-1 --silent`,
    port: MOCK_UI_PORT,
    reuseExistingServer: !process.env.CI,
    timeout: 30_000,
  },
});
