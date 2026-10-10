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

import path from 'node:path';
import type { Page } from '@playwright/test';
import { test, expect, type Cc } from '../harness/fixtures.ts';
import { api, installFakePlugin } from '../harness/api.ts';
import { REPO_ROOT } from '../harness/boot.ts';

const SCENARIO = path.join(REPO_ROOT, 'tests', 'fixtures', 'scenario-basic.json');

test.use({ ccOptions: { server: 'plugin-switch', scenario: SCENARIO }, viewport: { width: 1280, height: 800 } });

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
