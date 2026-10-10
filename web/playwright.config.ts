// End-to-end suite: the real server (fake `claude` CLI, sandboxed state) driven
// through Chromium. Run with `npm run test:e2e` (first time: `npx playwright install chromium`).
import { defineConfig, devices } from '@playwright/test';

const port = Number(process.env.E2E_PORT || 8799);

export default defineConfig({
  testDir: './e2e',
  timeout: 60_000,
  expect: { timeout: 10_000 },
  fullyParallel: false,
  workers: 1,
  reporter: [['list']],
  use: { baseURL: `http://127.0.0.1:${port}`, trace: 'retain-on-failure' },
  webServer: {
    command: 'node e2e/server.mjs',
    cwd: import.meta.dirname,
    // The UI route, not /api/health: the server builds web/dist at boot and
    // answers /next/ with a 503 "building" page until it is done, which keeps
    // Playwright polling instead of running the first spec against that page.
    url: `http://127.0.0.1:${port}/next/`,
    timeout: 120_000,
    reuseExistingServer: false,
  },
  projects: [
    { name: 'desktop', use: { ...devices['Desktop Chrome'], viewport: { width: 1440, height: 900 } } },
    { name: 'phone', use: { ...devices['Pixel 7'] } },
  ],
});
