// Live-browser regression test for the app-switcher "leave session → default
// view" bug. Skipped by default — opt-in via `RUN_PLAYWRIGHT=1` (needs the
// termux-playwright-harness sibling repo + a system Chromium; see
// debug/README.md). The import of that sibling repo is deferred into the test
// body so this file loads cleanly (and shows as skipped) on machines that
// don't have it cloned.
//
// Root cause (fixed in public/wsRouter.js's popstate handler): picking a
// plugin from #app-switcher-select sets `location.hash = '#plugin/<id>/'`
// (public/appSwitcher.js), which real Chromium dispatches a `popstate` event
// for in addition to `hashchange`. The popstate handler read the *new*
// `#plugin/<id>/` hash, found no `session=` key in it, and — with an active
// session anchored (state.activeId set) — called selectInstance(null),
// clobbering the hash right after appSwitcher.js set it. A second pick then
// worked because state.activeId was already null. The unit-level regression
// test lives in tests/anchor-autoresume.test.mjs; this one proves the fix
// against a real browser end-to-end.
//
// Run with:  RUN_PLAYWRIGHT=1 node tests/run.mjs tests/plugin-switch-browser.test.mjs

import { test } from 'node:test';
import assert from 'node:assert/strict';
import path from 'node:path';
import { promises as fs } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { bootServer, api, waitFor } from './helpers.mjs';
import { FAKE_PLUGIN_DIR } from './plugin-helpers.mjs';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const SCENARIO = path.join(__dirname, 'fixtures', 'scenario-basic.json');

const ENABLED = !!process.env.RUN_PLAYWRIGHT;
const t = ENABLED ? test : test.skip.bind(test);

async function switchToPlugin(page) {
  await page.evaluate(() => { window.__log = []; });
  await page.selectOption('#app-switcher-select', 'fake-plugin');
  await page.waitForTimeout(400);
  return page.evaluate(() => ({
    hash: location.hash,
    selectValue: document.getElementById('app-switcher-select').value,
    pluginViewHidden: document.getElementById('plugin-view')?.hidden,
  }));
}

t('picking a plugin from the app-switcher lands on it (not the placeholder) on the first try, from an active session', async () => {
  const { withPage } = await import('../../termux-playwright-harness/browser.mjs');
  const boot = await bootServer({ scenarioPath: SCENARIO, realProcess: true });
  try {
    await fs.cp(FAKE_PLUGIN_DIR, path.join(boot.projectsRoot, 'fakeplug'), { recursive: true });
    await api(boot.baseUrl, 'POST', '/api/plugins/fake-plugin/enable');
    await api(boot.baseUrl, 'POST', '/api/projects', { name: 'proj' });
    const res = await api(boot.baseUrl, 'POST', '/api/instances', { project: 'proj', temp: false });
    const inst = boot.instances.get(res.body.id);
    await waitFor(() => inst.status === 'idle' && inst.sessionId);

    await withPage(async (page) => {
      await page.goto(boot.baseUrl, { waitUntil: 'load' });
      await page.waitForSelector('.session-row.live', { timeout: 15000 });
      await page.click('.session-row.live');
      await page.waitForTimeout(150);
      assert.match(await page.evaluate(() => location.hash), /^#session=/, 'sanity: viewing the active session');

      const result = await switchToPlugin(page);
      assert.equal(result.hash, '#plugin/fake-plugin/', 'first pick lands on the plugin hash, not cleared');
      assert.equal(result.selectValue, 'fake-plugin', 'switcher reflects the plugin, not Conductor');
      assert.equal(result.pluginViewHidden, false, 'plugin view is visible on the first pick');
    });
  } finally {
    await boot.close();
  }
});
