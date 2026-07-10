// Live-browser regression test for the main-bar (#instance-header) not
// clearing when navigating away from a session view. Skipped by default —
// opt-in via `RUN_PLAYWRIGHT=1` (needs the termux-playwright-harness sibling
// repo + a system Chromium; see debug/README.md). The import of that sibling
// repo is deferred into the test body so this file loads cleanly (and shows
// as skipped) on machines that don't have it cloned.
//
// Root cause (fixed in public/styles.css): #main.settings-open /
// #main.plugin-open (and the review/commits/costs-open siblings) already
// force-hide #conversation, #subagent-panel, #task-panel, #turn-indicator,
// #composer, and #instance-controls while that full-page view is open, but
// all 5 blocks omitted #instance-title — the element header.js builds the
// custom-title/project/worktree/status chips into. Since none of these view
// transitions call headerHandle.update() or clear state.activeId (by design,
// so closeSettings()/onExitToConductor() can restore the session anchor
// afterward), the stale chip row stayed visible. Real Chromium is required
// here (not happy-dom) because hash-driven view switches depend on the real
// hashchange/CSS cascade this project's tests otherwise can't observe.
//
// Run with:  RUN_PLAYWRIGHT=1 node tests/run.mjs tests/main-bar-reset-browser.test.mjs

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

async function titleDisplay(page) {
  return page.evaluate(() => getComputedStyle(document.getElementById('instance-title')).display);
}

t('main bar clears the session title/chips when navigating to Settings or a plugin view, and restores them on return', async () => {
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
      assert.equal(await titleDisplay(page), 'flex', 'sanity: title chips visible while a session is active');

      // → Settings
      await page.click('#settings-btn');
      await page.waitForTimeout(150);
      assert.equal(await page.evaluate(() => location.hash), '#settings');
      assert.equal(await titleDisplay(page), 'none', 'title/chips must be hidden while Settings is open');

      // ← back to the session
      await page.click('#settings-btn');
      await page.waitForTimeout(150);
      assert.match(await page.evaluate(() => location.hash), /^#session=/, 'closing Settings returns to the session');
      assert.equal(await titleDisplay(page), 'flex', 'title/chips reappear after closing Settings');

      // → plugin view
      await page.selectOption('#app-switcher-select', 'fake-plugin');
      await page.waitForTimeout(400);
      assert.equal(await page.evaluate(() => location.hash), '#plugin/fake-plugin/');
      assert.equal(await titleDisplay(page), 'none', 'title/chips must be hidden while a plugin view is open');

      // ← back to the session via the app switcher
      await page.selectOption('#app-switcher-select', 'conductor');
      await page.waitForTimeout(150);
      assert.match(await page.evaluate(() => location.hash), /^#session=/, 'exiting the plugin view returns to the session');
      assert.equal(await titleDisplay(page), 'flex', 'title/chips reappear after leaving the plugin view');
    });
  } finally {
    await boot.close();
  }
});
