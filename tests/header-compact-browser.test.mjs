// Real-layout check of the one-row phone header, which happy-dom cannot do (it
// computes no layout): one row at 320/360/390/720px, ellipsis engaged on a long
// title, nothing past the viewport, Sync/Merge out of the bar; and the desktop
// chip order and separator at 721/1280px. Skipped by default — opt-in via
// `RUN_PLAYWRIGHT=1` (needs the code-playwright plugin + a system Chromium; see
// harness/playwright/README.md). NOT part of `npm test`.
//
// No server: public/ is served from disk through page.route on a fixed origin.
// The page is index.html with app.js stripped plus a module script running the
// REAL installHeader() with stub deps, so the real stylesheet cascade applies
// to the real header DOM.
//
// Run with:  RUN_PLAYWRIGHT=1 node tests/run.mjs tests/header-compact-browser.test.mjs

import { test } from 'node:test';
import assert from 'node:assert/strict';
import path from 'node:path';
import { promises as fs } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { importCodePlaywright } from '../harness/playwright/paths.mjs';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const PUB = path.resolve(__dirname, '..', 'public');
const ORIGIN = 'http://cc.test';

const ENABLED = !!process.env.RUN_PLAYWRIGHT;
const t = ENABLED ? test : test.skip.bind(test);

const MIME = { '.js': 'text/javascript', '.css': 'text/css', '.html': 'text/html', '.svg': 'image/svg+xml' };

// Runs in the page: installs the real header and exposes __show(inst).
const HARNESS = `<script type="module">
  const { installHeader } = await import('/header.js');
  const { UsageTracker, RateLimitTracker } = await import('/usage.js');
  const dom = {};
  for (const id of ['composer-input', 'mode-toggle', 'kill-btn', 'mute-btn', 'resume-btn', 'instance-title',
    'turn-indicator', 'ti-left', 'ti-dot', 'ti-label', 'ti-ellipsis', 'ti-interrupt-now', 'ti-usage-slot',
    'sync-btn', 'merge-btn', 'sync-menu-btn', 'merge-menu-btn', 'debug-btn', 'summarize-session-btn',
    'rename-session-btn', 'change-model-btn', 'change-effort-btn', 'session-stats-btn', 'prune-session-btn',
    'auto-approve-plan-btn', 'playbook-enforcement-btn', 'overflow-menu', 'overflow-toggle', 'overflow-panel']) {
    dom[id.replace(/-(\\w)/g, (_, c) => c.toUpperCase())] = document.getElementById(id);
  }
  let inst = null;
  const usage = new Map();
  const header = installHeader({
    dom, getActiveId: () => inst?.id, getInstances: () => (inst ? [inst] : []),
    setActiveStatus() {}, setActiveMode() {},
    getUsage: (id) => { if (!usage.has(id)) usage.set(id, new UsageTracker()); return usage.get(id); },
    globalRLTracker: new RateLimitTracker(), getAccountUsage: () => null, getAccountUsageStale: () => false,
    composer: { disable() {}, set() {} }, conversation: { setUserActionsEnabled() {}, setCallUsageVisible() {} },
    sessionActions: {},
  });
  window.__show = (i) => { inst = i; header.update(); };
  window.__ready = true;
</script>`;

async function routePublic(page) {
  const indexHtml = (await fs.readFile(path.join(PUB, 'index.html'), 'utf8'))
    .replace(/<script type="module" src="\/app\.js"><\/script>/, HARNESS);
  await page.route(`${ORIGIN}/**`, async (route) => {
    const { pathname } = new URL(route.request().url());
    if (pathname === '/') return route.fulfill({ status: 200, contentType: MIME['.html'], body: indexHtml });
    try {
      const body = await fs.readFile(path.join(PUB, pathname));
      return route.fulfill({ status: 200, contentType: MIME[path.extname(pathname)] ?? 'application/octet-stream', body });
    } catch {
      return route.fulfill({ status: 404, body: '' });
    }
  });
}

const LONG_TITLE = 'Refactor the session header into one compact row'.slice(0, 44);
const session = (over = {}) => ({
  id: 'i1', sessionId: 's1', status: 'turn', displayStatus: 'turn', mode: 'plan', model: 'claude-sonnet-4-6',
  project: 'code-conductor', title: LONG_TITLE, autoApprovePlan: false, interrupting: false, debug: false,
  worktree: { worktreeName: 'mobile-compact-header', baseBranch: 'main' }, ...over,
});

async function open(page, width, inst) {
  await page.setViewportSize({ width, height: 800 });
  await page.goto(`${ORIGIN}/`, { waitUntil: 'load' });
  await page.waitForFunction(() => window.__ready === true);
  await page.evaluate((i) => window.__show(i), inst);
}

// Geometry of the header's bar, read in the page.
const measure = (page) => page.evaluate(() => {
  const rect = (el) => el.getBoundingClientRect();
  const shown = (el) => !!el && el.getClientRects().length > 0;
  const header = rect(document.getElementById('instance-header'));
  const controls = [
    ...document.querySelectorAll('#sidebar-toggle, #instance-controls button, #overflow-toggle'),
  ].filter(shown).filter(el => !el.closest('#overflow-panel'));
  const lead = document.querySelector('.ih-line-main > .ih-title, .ih-line-main > .ih-project');
  return {
    headerHeight: header.height,
    headerMid: header.top + header.height / 2,
    controls: controls.map(el => ({ id: el.id || el.textContent.trim(), mid: rect(el).top + rect(el).height / 2, right: rect(el).right })),
    leadClient: lead.clientWidth, leadScroll: lead.scrollWidth,
    syncInBar: shown(document.getElementById('sync-btn')),
    mergeInBar: shown(document.getElementById('merge-btn')),
    viewport: window.innerWidth,
  };
});

t('narrow: one row, nothing past the viewport, the long title ellipsized, Sync/Merge out of the bar', async () => {
  const { withPage } = await importCodePlaywright();
  await withPage(async (page) => {
    await routePublic(page);
    for (const width of [320, 360, 390, 720]) {
      await open(page, width, session());
      const m = await measure(page);
      console.log(`[header-compact] ${width}px: header ${m.headerHeight}px tall, title lead ${m.leadClient}px (content ${m.leadScroll}px)`);
      assert.ok(m.headerHeight <= 48, `${width}px: header is one row (${m.headerHeight}px)`);
      for (const c of m.controls) {
        assert.ok(Math.abs(c.mid - m.headerMid) <= 2, `${width}px: ${c.id} is centred on the row (${c.mid} vs ${m.headerMid})`);
        assert.ok(c.right <= m.viewport, `${width}px: ${c.id} ends inside the viewport (${c.right} > ${m.viewport})`);
      }
      // At 720px the 44-character title fits whole, so only the phone widths must truncate.
      if (width <= 390) assert.ok(m.leadScroll > m.leadClient, `${width}px: the long title is truncated (ellipsis engaged)`);
      assert.equal(m.syncInBar, false, `${width}px: Sync is not in the bar`);
      assert.equal(m.mergeInBar, false, `${width}px: Merge is not in the bar`);
      // Regression guard on the width budget: Plan mode mid-turn leaves the title
      // readable at 360. Deliberately not asserted at 320, where it is ~6 characters.
      if (width === 360) assert.ok(m.leadClient >= 80, `360px: title lead is ${m.leadClient}px, wanted >= 80`);
    }
  });
});

t('desktop: chips run title < project < worktree < status; the project chip is "· "-prefixed when titled; Sync/Merge are in the bar', async () => {
  const { withPage } = await importCodePlaywright();
  await withPage(async (page) => {
    await routePublic(page);
    for (const width of [721, 1280]) {
      await open(page, width, session({ title: 'My task' }));
      const r = await page.evaluate(() => {
        const q = (s) => document.querySelector(`#instance-title ${s}`);
        const box = (el) => { const b = el.getBoundingClientRect(); return { left: b.left, right: b.right, top: b.top, bottom: b.bottom }; };
        const shown = (el) => el.getClientRects().length > 0;
        return {
          order: ['.ih-title', '.ih-project', '.ih-worktree', '.ih-status'].map(s => box(q(s))),
          sep: getComputedStyle(q('.ih-project'), '::before').content,
          sync: shown(document.getElementById('sync-btn')),
          merge: shown(document.getElementById('merge-btn')),
        };
      });
      // Each chip follows its predecessor: on the same row to its right, or on a later row.
      for (let i = 1; i < r.order.length; i++) {
        const a = r.order[i - 1];
        const b = r.order[i];
        assert.ok(b.left >= a.right - 1 || b.top >= a.bottom - 1, `${width}px: chip ${i} follows chip ${i - 1}`);
      }
      assert.equal(r.sep, '"· "', `${width}px: separator on the secondary project chip`);
      assert.ok(r.sync && r.merge, `${width}px: Sync and Merge are visible in the bar`);
    }
  });
});
