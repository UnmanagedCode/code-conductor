// Picking a plugin from the old UI's app switcher while a session is anchored
// lands on the plugin on the first try.
//
// Picking a plugin from #app-switcher-select sets `location.hash =
// '#plugin/<id>/'` (public/appSwitcher.js), which real Chromium dispatches a
// `popstate` event for in addition to `hashchange`. public/wsRouter.js's
// popstate handler must not read that `#plugin/<id>/` hash as "no session" and
// call selectInstance(null) with an active session anchored (state.activeId
// set): that clobbers the hash right after appSwitcher.js set it, and only a
// second pick — with state.activeId already null — lands. The unit-level
// regression test lives in tests/anchor-autoresume.test.mjs; this one proves
// the behavior against a real browser end-to-end.

import fs from 'node:fs';
import path from 'node:path';
import type { Page } from '@playwright/test';
import { test, expect, type Cc } from '../harness/fixtures.ts';
import { api } from '../harness/api.ts';
import { REPO_ROOT } from '../harness/boot.ts';

const SCENARIO = path.join(REPO_ROOT, 'tests', 'fixtures', 'scenario-basic.json');
const FAKE_PLUGIN = path.join(REPO_ROOT, 'tests', 'fixtures', 'fake-plugin');

test.use({ ccOptions: { server: 'plugin-switch', scenario: SCENARIO }, viewport: { width: 1280, height: 800 } });

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

async function switchToPlugin(page: Page) {
  await page.evaluate(() => { (window as unknown as { __log: unknown[] }).__log = []; });
  await page.locator('#app-switcher-select').selectOption('fake-plugin');
  await page.waitForTimeout(400);
  return page.evaluate(() => ({
    hash: location.hash,
    selectValue: (document.getElementById('app-switcher-select') as HTMLSelectElement).value,
    pluginViewHidden: document.getElementById('plugin-view')?.hidden,
  }));
}

test('picking a plugin from the app-switcher lands on it (not the placeholder) on the first try, from an active session', async ({ page, cc }) => {
  await installFakePlugin(cc, 'fakeplug');
  await spawnIdle(cc, 'proj');

  await page.goto('/legacy/', { waitUntil: 'load' });
  // A fresh profile opens the Conductors lens; session rows are in Projects.
  await page.getByRole('group', { name: 'sidebar lens' }).getByRole('button', { name: 'Projects' }).click();
  const row = page.locator('.session-row.live').first();
  await row.waitFor({ timeout: 15_000 });
  await row.click();
  await page.waitForTimeout(150);
  expect(await page.evaluate(() => location.hash), 'sanity: viewing the active session').toMatch(/^#session=/);

  const result = await switchToPlugin(page);
  expect(result.hash, 'first pick lands on the plugin hash, not cleared').toBe('#plugin/fake-plugin/');
  expect(result.selectValue, 'switcher reflects the plugin, not Conductor').toBe('fake-plugin');
  expect(result.pluginViewHidden, 'plugin view is visible on the first pick').toBe(false);
});
