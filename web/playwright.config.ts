// End-to-end suite: real cc servers (fake `claude` CLI, scratch state) driven
// through Chromium. Run with `npm run test:e2e`; the harness is web/e2e/harness/
// and its doc web/e2e/README.md. Each worker boots its own cc (fixtures.ts), so
// there is no webServer block; globalSetup builds web/dist once per run.
import { defineConfig, devices } from '@playwright/test';

export default defineConfig({
  testDir: './e2e',
  globalSetup: './e2e/harness/global-setup.ts',
  timeout: 60_000,
  expect: { timeout: 10_000 },
  fullyParallel: false,
  workers: 1,
  reporter: [['list']],
  use: { trace: 'retain-on-failure' },
  projects: [
    {
      name: 'desktop',
      use: { ...devices['Desktop Chrome'], viewport: { width: 1440, height: 900 } },
      testIgnore: ['**/*.android.spec.ts'],
    },
    {
      name: 'phone',
      use: { ...devices['Pixel 7'] },
      testIgnore: ['legacy/**', 'live.spec.ts', '**/*.android.spec.ts'],
    },
    {
      name: 'android',
      use: { ...devices['Pixel 7'], permissions: ['notifications'] },
      testMatch: ['harness.spec.ts', '**/*.android.spec.ts', 'parity/**/*.spec.ts'],
    },
  ],
});
