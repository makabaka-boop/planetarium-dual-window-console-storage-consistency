import { defineConfig, devices } from '@playwright/test';

// BASE_URL is injected by the one-shot `verify` container (http://web:...),
// and defaults to the local Vite dev server for `npm run e2e`.
export default defineConfig({
  testDir: './e2e',
  timeout: 30_000,
  fullyParallel: false,
  workers: 1,
  retries: 0,
  reporter: [['list']],
  use: {
    baseURL: process.env.BASE_URL ?? 'http://127.0.0.1:5173',
    trace: 'on-first-retry'
  },
  projects: [
    {
      name: 'chromium',
      use: { ...devices['Desktop Chrome'] }
    }
  ],
  webServer: process.env.BASE_URL
    ? undefined
    : {
        command: 'npm run dev -- --port 5173',
        url: 'http://127.0.0.1:5173/console',
        timeout: 30_000,
        reuseExistingServer: !process.env.CI
      }
});
