// The main bar (#instance-header) clears when the old UI navigates away from a
// session view.
//
// #main.settings-open / #main.plugin-open (and the review/commits/costs-open
// siblings) force-hide #conversation, #subagent-panel, #task-panel,
// #turn-indicator, #composer and #instance-controls while that full-page view
// is open, and must hide #instance-title too — the element header.js builds
// the custom-title/project/worktree/status chips into. None of these view
// transitions call headerHandle.update() or clear state.activeId (by design,
// so closeSettings()/onExitToConductor() can restore the session anchor
// afterward), so without that rule the stale chip row stays visible. Real
// Chromium is required (not happy-dom) because hash-driven view switches
// depend on the real hashchange/CSS cascade.

import fs from 'node:fs';
import path from 'node:path';
import type { Page } from '@playwright/test';
import { test, expect, type Cc } from '../harness/fixtures.ts';
import { api } from '../harness/api.ts';
import { REPO_ROOT } from '../harness/boot.ts';

const SCENARIO = path.join(REPO_ROOT, 'tests', 'fixtures', 'scenario-basic.json');
const FAKE_PLUGIN = path.join(REPO_ROOT, 'tests', 'fixtures', 'fake-plugin');

test.use({ ccOptions: { server: 'main-bar-reset', scenario: SCENARIO }, viewport: { width: 1280, height: 800 } });

/** Copies the fixture plugin under the projects root, adopts it as project `name`, rescans and enables it. */
async function installFakePlugin(cc: Cc, name: string): Promise<void> {
  const dir = path.join(cc.dirs.projects, name);
  fs.cpSync(FAKE_PLUGIN, dir, { recursive: true });
  const adopt = await api(cc, 'POST', '/api/projects/external', { name, path: dir });
  expect(adopt.body?.ok, `adopt ${name}: ${JSON.stringify(adopt.body)}`).toBe(true);
  await api(cc, 'POST', '/api/plugins/rescan');
  const enable = await api(cc, 'POST', '/api/plugins/fake-plugin/enable');
  expect(enable.status, `enable fake-plugin: ${JSON.stringify(enable.body)}`).toBeLessThan(300);
}

async function spawnIdle(cc: Cc, project: string): Promise<void> {
  await api(cc, 'POST', '/api/projects', { name: project });
  const res = await api(cc, 'POST', '/api/instances', { project, temp: false });
  expect(res.status, `POST /api/instances: ${JSON.stringify(res.body)}`).toBeLessThan(300);
  await expect.poll(async () => {
    const row = (await api(cc, 'GET', '/api/instances')).body.find((r: { id: string }) => r.id === res.body.id);
    return row?.status === 'idle' && !!row.sessionId;
  }, { timeout: 10_000 }).toBe(true);
}

const titleDisplay = (page: Page) =>
  page.evaluate(() => getComputedStyle(document.getElementById('instance-title')!).display);
const hash = (page: Page) => page.evaluate(() => location.hash);

test('main bar clears the session title/chips when navigating to Settings or a plugin view, and restores them on return', async ({ page, cc }) => {
  await installFakePlugin(cc, 'fakeplug');
  await spawnIdle(cc, 'proj');

  await page.goto('/legacy/', { waitUntil: 'load' });
  // A fresh profile opens the Conductors lens; session rows are in Projects.
  await page.getByRole('group', { name: 'sidebar lens' }).getByRole('button', { name: 'Projects' }).click();
  const row = page.locator('.session-row.live').first();
  await row.waitFor({ timeout: 15_000 });
  await row.click();
  await page.waitForTimeout(150);
  expect(await hash(page), 'sanity: viewing the active session').toMatch(/^#session=/);
  expect(await titleDisplay(page), 'sanity: title chips visible while a session is active').toBe('flex');

  // → Settings
  await page.locator('#settings-btn').click();
  await page.waitForTimeout(150);
  expect(await hash(page)).toBe('#settings');
  expect(await titleDisplay(page), 'title/chips must be hidden while Settings is open').toBe('none');

  // ← back to the session
  await page.locator('#settings-btn').click();
  await page.waitForTimeout(150);
  expect(await hash(page), 'closing Settings returns to the session').toMatch(/^#session=/);
  expect(await titleDisplay(page), 'title/chips reappear after closing Settings').toBe('flex');

  // → plugin view
  await page.locator('#app-switcher-select').selectOption('fake-plugin');
  await page.waitForTimeout(400);
  expect(await hash(page)).toBe('#plugin/fake-plugin/');
  expect(await titleDisplay(page), 'title/chips must be hidden while a plugin view is open').toBe('none');

  // ← back to the session via the app switcher
  await page.locator('#app-switcher-select').selectOption('conductor');
  await page.waitForTimeout(150);
  expect(await hash(page), 'exiting the plugin view returns to the session').toMatch(/^#session=/);
  expect(await titleDisplay(page), 'title/chips reappear after leaving the plugin view').toBe('flex');
});
