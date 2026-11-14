// End-to-end suite: real cc servers (fake `claude` CLI, scratch state) driven
// through Chromium. Run with `npm run test:e2e`; the harness is web/e2e/harness/
// and its doc web/e2e/README.md. Each worker boots its own cc (fixtures.ts), so
// there is no webServer block; globalSetup builds web/dist once per run.
import { defineConfig, devices } from '@playwright/test';

// The specs outside flows/ that android runs as they are. An `*.android.spec.ts`
// override replaces its desktop spec on android; desktop and phone never run one.
// web/src/e2eProjects.test.ts pins the split.
export const ANDROID_SPECS = [
  'bubble-scroll.spec.ts',
  'card-drafts.spec.ts',
  'collapse-state.spec.ts',
  'composer-attach.spec.ts',
  'composer-dictate.spec.ts',
  'composer-drafts.spec.ts',
  'conductors-lens.spec.ts',
  'conversation-bubbles.spec.ts',
  'conversation-machinery.spec.ts',
  'conversation-scroll.spec.ts',
  'dialog-scroll.spec.ts',
  'header-dot.spec.ts',
  'image-zoom.spec.ts',
  'keyboard-focus.spec.ts',
  'page-scroll.spec.ts',
  'paged-call-usage.spec.ts',
  'paged-plan-card.spec.ts',
  'plugin-hidden.spec.ts',
  'plugin-topbar.spec.ts',
  'reduced-motion.spec.ts',
  'session-restore.spec.ts',
  'session-submenus.spec.ts',
  'session-width.spec.ts',
  'settings-overage.spec.ts',
  'sidebar-api-projects.spec.ts',
  'sidebar-chrome.spec.ts',
  'sidebar-lens.spec.ts',
  'sidebar-machine-label.spec.ts',
  'sidebar-scroll.spec.ts',
  'sidebar-strip.spec.ts',
  'sidebar-tiers-flat.spec.ts',
  'sidebar-tiers.spec.ts',
  'speaker-last-line.spec.ts',
  'sw-upgrade.spec.ts',
  'toast-focus.spec.ts',
  'toast-header.spec.ts',
  'touch-fields.spec.ts',
  'transcript-layout.spec.ts',
  'user-bubble-width-nested.spec.ts',
  'user-bubble-width.spec.ts',
  'view-switch.spec.ts',
];

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
      testIgnore: ['live.spec.ts', '**/*.android.spec.ts'],
    },
    {
      name: 'android',
      use: { ...devices['Pixel 7'], permissions: ['notifications'] },
      testMatch: ['harness.spec.ts', 'flows/**/*.spec.ts', '**/*.android.spec.ts', ...ANDROID_SPECS],
    },
  ],
});
