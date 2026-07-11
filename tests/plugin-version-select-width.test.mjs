// Live-browser regression test for the Settings → Plugins version-select
// layout bug — skipped by default, opt-in via `RUN_PLAYWRIGHT=1` (needs the
// code-playwright sibling repo + a system Chromium; see
// debug/README.md). The import of that sibling repo is deferred into the
// test body so this file loads cleanly (and shows as skipped) on machines
// that don't have it cloned.
//
// Root cause: `.pl-version` (public/styles.css) set only `font-size: 12px` —
// no `max-width`/`min-width: 0`. As a flex child of `.pl-actions`
// (display:flex; flex-wrap:wrap) it kept the browser default
// `min-width: auto`, so it couldn't shrink below its own content's
// intrinsic width. A plugin whose worktree option text is long enough
// forced the closed <select> box far wider than a plugin with only the
// bare "main" option, wrapping the flex row and reading as "full width"
// with what looked like an oversized focus ring (actually a normal 2px
// outline on an abnormally wide box). Fixed by constraining `.pl-version`'s
// width regardless of option content.
//
// Run with:  RUN_PLAYWRIGHT=1 node tests/run.mjs tests/plugin-version-select-width.test.mjs

import { test } from 'node:test';
import assert from 'node:assert/strict';
import path from 'node:path';
import { promises as fs } from 'node:fs';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { bootServer, api } from './helpers.mjs';
import { FAKE_PLUGIN_DIR } from './plugin-helpers.mjs';

const run = promisify(execFile);

const ENABLED = !!process.env.RUN_PLAYWRIGHT;
const t = ENABLED ? test : test.skip.bind(test);

const MANIFEST = {
  version: '1.0.0', pluginApi: 1,
  backend: { start: 'node server.mjs', healthPath: '/health' },
};

async function git(cwd, ...args) {
  await run('git', ['-C', cwd, ...args]);
}

async function addPlugin(boot, dirName, manifest) {
  const dir = path.join(boot.projectsRoot, dirName);
  await fs.cp(FAKE_PLUGIN_DIR, dir, { recursive: true });
  await fs.writeFile(path.join(dir, 'conductor.plugin.json'), JSON.stringify(manifest, null, 2));
  return dir;
}

t('.pl-version select stays compact regardless of option content (stopped vs ready with long worktree name)', async () => {
  const boot = await bootServer({ realProcess: true });
  try {
    // Plugin A: enabled but never started ("stopped"), no worktrees — its
    // .pl-version will only ever show the bare "main" option.
    await addPlugin(boot, 'shortplug', { ...MANIFEST, id: 'shortplug', name: 'Short Plug' });

    // Plugin B: a git repo with a deliberately long project name, so its
    // auto-generated worktree dir name (`${project}_worktree_${id}`,
    // src/worktrees.js:65-67) produces long <option> text — enabled and
    // started ("ready").
    const longName = 'a-very-long-project-name-for-worktree-testing';
    const dir = await addPlugin(boot, longName, { ...MANIFEST, id: 'longplug', name: 'Long Plug' });
    await git(dir, 'init', '-q');
    await git(dir, 'config', 'user.email', 'test@test');
    await git(dir, 'config', 'user.name', 'test');
    await git(dir, 'add', '-A');
    await git(dir, 'commit', '-q', '-m', 'plugin main');
    const { createWorktree } = await import('../src/worktrees.js');
    await createWorktree(longName);

    // Both plugin projects exist on disk now — rescan once so discovery
    // picks up longplug (created after the host's initial lazy scan).
    await api(boot.baseUrl, 'POST', '/api/plugins/rescan');

    await api(boot.baseUrl, 'POST', '/api/plugins/shortplug/enable');
    await api(boot.baseUrl, 'POST', '/api/plugins/longplug/enable');
    await api(boot.baseUrl, 'POST', '/api/plugins/longplug/start');

    const { withPage } = await import('../../code-playwright/browser.mjs');
    await withPage(async (page) => {
      await page.goto(boot.baseUrl, { waitUntil: 'load' });
      // At mobile widths the sidebar (which hosts #settings-btn) starts
      // collapsed off-canvas behind a toggle (styles.css:1230-1239).
      await page.click('#sidebar-toggle');
      await page.click('#settings-btn');
      await page.selectOption('#settings-group-select', 'plugins');
      await page.waitForSelector('#pl-list .pl-row');
      // Wait for both plugin rows to have rendered their action row.
      await page.waitForFunction(() => document.querySelectorAll('.pl-version').length >= 2);

      const data = await page.evaluate(() => {
        const rows = [...document.querySelectorAll('.pl-row')];
        return rows.map(row => {
          const sel = row.querySelector('.pl-version');
          if (!sel) return null;
          const actions = sel.closest('.pl-actions');
          const cs = getComputedStyle(sel);
          const rect = sel.getBoundingClientRect();
          return {
            name: row.querySelector('.pl-name')?.textContent,
            optionCount: sel.options.length,
            longestOption: Math.max(...[...sel.options].map(o => o.textContent.length)),
            width: rect.width,
            actionsWidth: actions?.getBoundingClientRect().width,
            textOverflow: cs.textOverflow,
            focused: document.activeElement === sel,
          };
        }).filter(Boolean);
      });
      const pageScrollWidth = await page.evaluate(() => document.documentElement.scrollWidth);

      assert.equal(data.length, 2, 'both plugin rows have a version select');
      const short = data.find(d => d.name === 'Short Plug');
      const long = data.find(d => d.name === 'Long Plug');
      assert.ok(short && long, 'found both plugins by name');

      for (const d of [short, long]) {
        assert.ok(!d.focused, `${d.name}'s select isn't focused at capture time`);
        assert.ok(
          d.width <= d.actionsWidth + 1,
          `${d.name}'s select (${d.width}px) doesn't overflow its .pl-actions row (${d.actionsWidth}px)`,
        );
        // Chromium reports `overflow: visible` in computed style for native
        // <select> regardless of the declared value (it handles ellipsis
        // truncation internally) — text-overflow is the property that
        // actually reflects the declared CSS here.
        assert.equal(d.textOverflow, 'ellipsis', `${d.name}'s select truncates with ellipsis`);
      }

      // The regression guard: "Long Plug"'s option text is long enough that,
      // pre-fix, its select rendered ~483px wide (overflowing its 332px-wide
      // .pl-actions row and the whole 390px viewport). This assertion — the
      // page never grows a horizontal scrollbar at a real mobile viewport —
      // is exactly what the bug report observed and fails against the
      // pre-fix CSS.
      assert.ok(long.longestOption - short.longestOption > 15, 'sanity: long plugin really does have longer option text');
      assert.ok(
        pageScrollWidth <= 390 + 1,
        `page never grows a horizontal scrollbar at the 390px mobile viewport (scrollWidth=${pageScrollWidth})`,
      );
    }, { viewport: { width: 390, height: 844 } });
  } finally {
    await boot.close();
  }
});
