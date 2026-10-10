// The old UI's Settings → Plugins version select stays compact whatever its
// options say.
//
// `.pl-version` (public/styles.css) is a flex child of `.pl-actions`
// (display:flex; flex-wrap:wrap). With the browser default `min-width: auto`
// and no width constraint it cannot shrink below its own content's intrinsic
// width, so a plugin whose worktree option text is long forces the closed
// <select> box far wider than a plugin with only the bare "main" option —
// wrapping the flex row and reading as "full width", with what looks like an
// oversized focus ring (a normal 2px outline on an abnormally wide box).
// `.pl-version`'s width is therefore constrained regardless of option content.

import { execFile } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import { promisify } from 'node:util';
import { test, expect, type Cc } from '../harness/fixtures.ts';
import { api, mcpCall } from '../harness/api.ts';
import { REPO_ROOT } from '../harness/boot.ts';

const run = promisify(execFile);
const FAKE_PLUGIN = path.join(REPO_ROOT, 'tests', 'fixtures', 'fake-plugin');

test.use({ ccOptions: { server: 'plugin-version-select-width' }, viewport: { width: 390, height: 844 } });

const MANIFEST = {
  version: '1.0.0', pluginApi: 1,
  backend: { start: 'node server.mjs', healthPath: '/health' },
};

async function git(cc: Cc, cwd: string, ...args: string[]): Promise<void> {
  await run('git', ['-C', cwd, ...args], {
    env: { ...process.env, GIT_CONFIG_GLOBAL: cc.dirs.gitconfig, GIT_CONFIG_NOSYSTEM: '1' },
  });
}

/** Copies the fixture plugin to `<projects>/<dirName>` with `manifest` as its conductor.plugin.json. */
function addPlugin(cc: Cc, dirName: string, manifest: Record<string, unknown>): string {
  const dir = path.join(cc.dirs.projects, dirName);
  fs.cpSync(FAKE_PLUGIN, dir, { recursive: true });
  fs.writeFileSync(path.join(dir, 'conductor.plugin.json'), JSON.stringify(manifest, null, 2));
  return dir;
}

async function adopt(cc: Cc, name: string, dir: string): Promise<void> {
  const r = await api(cc, 'POST', '/api/projects/external', { name, path: dir });
  expect(r.body?.ok, `adopt ${name}: ${JSON.stringify(r.body)}`).toBe(true);
}

test('.pl-version select stays compact regardless of option content (stopped vs ready with long worktree name)', async ({ page, cc }) => {
  // Plugin A: enabled but never started ("stopped"), no worktrees — its
  // .pl-version only ever shows the bare "main" option.
  await adopt(cc, 'shortplug', addPlugin(cc, 'shortplug', { ...MANIFEST, id: 'shortplug', name: 'Short Plug' }));

  // Plugin B: a git repo with a worktree under a deliberately long name, so
  // its "worktree <name>" <option> (versionSelect in public/pluginManager.js)
  // has long text — enabled and started ("ready"). The worktree name is the
  // slug createWorktree (src/worktrees.ts) makes of the requested `name`.
  const longName = 'a-very-long-project-name-for-worktree-testing';
  const longWorktree = 'a-very-long-worktree-name-for-width-testing';
  const dir = addPlugin(cc, longName, { ...MANIFEST, id: 'longplug', name: 'Long Plug' });
  await git(cc, dir, 'init', '-q');
  await git(cc, dir, 'config', 'user.email', 'test@test');
  await git(cc, dir, 'config', 'user.name', 'test');
  await git(cc, dir, 'add', '-A');
  await git(cc, dir, 'commit', '-q', '-m', 'plugin main');
  await adopt(cc, longName, dir);
  const wt = await mcpCall(cc, 'create_worktree', { project: longName, name: longWorktree });
  expect(!!wt && !wt.isError, `create_worktree ${longName}: ${JSON.stringify(wt)}`).toBe(true);

  // Both plugin projects are registered now — rescan once so discovery picks
  // them up (they were created after the host's boot-time scan).
  await api(cc, 'POST', '/api/plugins/rescan');

  await api(cc, 'POST', '/api/plugins/shortplug/enable');
  await api(cc, 'POST', '/api/plugins/longplug/enable');
  await api(cc, 'POST', '/api/plugins/longplug/start');

  await page.goto('/legacy/', { waitUntil: 'load' });
  // At mobile widths the sidebar (which hosts #settings-btn) starts collapsed
  // off-canvas behind #sidebar-toggle.
  await page.locator('#sidebar-toggle').click();
  await page.locator('#settings-btn').click();
  await page.locator('#settings-group-select').selectOption('plugins');
  await page.locator('#pl-list .pl-row').first().waitFor();
  // Wait for both plugin rows to have rendered their action row.
  await page.waitForFunction(() => document.querySelectorAll('.pl-version').length >= 2);

  const data = await page.evaluate(() => {
    const rows = [...document.querySelectorAll('.pl-row')];
    return rows.map(row => {
      const sel = row.querySelector<HTMLSelectElement>('.pl-version');
      if (!sel) return null;
      const actions = sel.closest('.pl-actions');
      const cs = getComputedStyle(sel);
      const rect = sel.getBoundingClientRect();
      return {
        name: row.querySelector('.pl-name')?.textContent,
        optionCount: sel.options.length,
        longestOption: Math.max(...[...sel.options].map(o => (o.textContent ?? '').length)),
        width: rect.width,
        actionsWidth: actions?.getBoundingClientRect().width,
        textOverflow: cs.textOverflow,
        focused: document.activeElement === sel,
      };
    }).filter(d => d !== null);
  });
  const pageScrollWidth = await page.evaluate(() => document.documentElement.scrollWidth);

  expect(data.length, 'both plugin rows have a version select').toBe(2);
  const short = data.find(d => d.name === 'Short Plug');
  const long = data.find(d => d.name === 'Long Plug');
  expect(short && long, 'found both plugins by name').toBeTruthy();

  for (const d of [short!, long!]) {
    expect(d.focused, `${d.name}'s select isn't focused at capture time`).toBe(false);
    expect(
      d.width,
      `${d.name}'s select (${d.width}px) doesn't overflow its .pl-actions row (${d.actionsWidth}px)`,
    ).toBeLessThanOrEqual((d.actionsWidth ?? NaN) + 1);
    // Chromium reports `overflow: visible` in computed style for native
    // <select> regardless of the declared value (it handles ellipsis
    // truncation internally) — text-overflow is the property that actually
    // reflects the declared CSS here.
    expect(d.textOverflow, `${d.name}'s select truncates with ellipsis`).toBe('ellipsis');
  }

  // The regression guard: "Long Plug"'s option text is long enough that,
  // without the width constraint, its select renders ~483px wide (overflowing
  // its 332px-wide .pl-actions row and the whole 390px viewport). The page
  // never growing a horizontal scrollbar at a real mobile viewport is exactly
  // what the bug report observed.
  expect(long!.longestOption - short!.longestOption, 'sanity: long plugin really does have longer option text').toBeGreaterThan(15);
  expect(
    pageScrollWidth,
    `page never grows a horizontal scrollbar at the 390px mobile viewport (scrollWidth=${pageScrollWidth})`,
  ).toBeLessThanOrEqual(390 + 1);
});
