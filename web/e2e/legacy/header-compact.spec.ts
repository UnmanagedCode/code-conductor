// Real-layout check of the old UI's one-row phone header, which happy-dom
// cannot do (it computes no layout): one row at 320/360/390/720px, ellipsis
// engaged on a long title, nothing past the viewport, Sync out of the bar; and
// the desktop chip order and separator at 721/1280px.
//
// No cc: public/ is served on a fixed origin through page.route, from a local
// server mounting what cc mounts for it — legacyPublicTs (the shared public/*.ts
// modules, type-stripped) ahead of express.static. The page is index.html with
// app.js stripped plus a module script running the REAL installHeader() with
// stub deps, so the real stylesheet cascade applies to the real header DOM.

import fs from 'node:fs/promises';
import type { Server } from 'node:http';
import type { AddressInfo } from 'node:net';
import path from 'node:path';
import express from 'express';
import { test, expect, type Page } from '@playwright/test';
import { legacyPublicTs } from '../../../src/legacyPublicTs.ts';
import { REPO_ROOT } from '../harness/boot.ts';

const PUB = path.join(REPO_ROOT, 'public');
const ORIGIN = 'http://cc.test';

let server: Server;
let publicBase = '';
test.beforeAll(async () => {
  const app = express();
  app.use(legacyPublicTs(PUB));
  app.use(express.static(PUB));
  server = await new Promise<Server>((resolve) => { const s = app.listen(0, '127.0.0.1', () => resolve(s)); });
  publicBase = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
});
test.afterAll(async () => { await new Promise((resolve) => server.close(resolve)); });

// Runs in the page: installs the real header and exposes __show(inst).
const HARNESS = `<script type="module">
  const { installHeader } = await import('/header.js');
  const { UsageTracker, RateLimitTracker } = await import('/usage.js');
  const dom = {};
  for (const id of ['composer-input', 'mode-toggle', 'kill-btn', 'mute-btn', 'resume-btn', 'instance-title',
    'turn-indicator', 'ti-left', 'ti-dot', 'ti-label', 'ti-ellipsis', 'ti-interrupt-now', 'ti-usage-slot',
    'sync-btn', 'sync-menu-btn', 'debug-btn', 'summarize-session-btn',
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

type HarnessWindow = { __ready?: boolean; __show(inst: unknown): void };

async function routePublic(page: Page): Promise<void> {
  const indexHtml = (await fs.readFile(path.join(PUB, 'index.html'), 'utf8'))
    .replace(/<script type="module" src="\/app\.js"><\/script>/, HARNESS);
  await page.route(`${ORIGIN}/**`, async (route) => {
    const { pathname } = new URL(route.request().url());
    if (pathname === '/') return route.fulfill({ status: 200, contentType: 'text/html', body: indexHtml });
    return route.fulfill({ response: await route.fetch({ url: publicBase + pathname }) });
  });
}

const LONG_TITLE = 'Refactor the session header into one compact row'.slice(0, 44);
const session = (over: Record<string, unknown> = {}) => ({
  id: 'i1', sessionId: 's1', status: 'turn', displayStatus: 'turn', mode: 'plan', model: 'claude-sonnet-4-6',
  project: 'code-conductor', title: LONG_TITLE, autoApprovePlan: false, interrupting: false, debug: false,
  worktree: { worktreeName: 'mobile-compact-header', baseBranch: 'main' }, ...over,
});

async function open(page: Page, width: number, inst: unknown): Promise<void> {
  await page.setViewportSize({ width, height: 800 });
  await page.goto(`${ORIGIN}/`, { waitUntil: 'load' });
  await page.waitForFunction(() => (window as unknown as HarnessWindow).__ready === true);
  await page.evaluate((i) => (window as unknown as HarnessWindow).__show(i), inst);
}

// Geometry of the header's bar, read in the page.
const measure = (page: Page) => page.evaluate(() => {
  const rect = (el: Element) => el.getBoundingClientRect();
  const shown = (el: Element | null) => !!el && el.getClientRects().length > 0;
  const header = rect(document.getElementById('instance-header')!);
  const controls = [
    ...document.querySelectorAll('#sidebar-toggle, #instance-controls button, #overflow-toggle'),
  ].filter(shown).filter(el => !el.closest('#overflow-panel'));
  const lead = document.querySelector('.ih-line-main > .ih-title, .ih-line-main > .ih-project')!;
  return {
    headerHeight: header.height,
    headerMid: header.top + header.height / 2,
    controls: controls.map(el => ({ id: el.id || (el.textContent ?? '').trim(), mid: rect(el).top + rect(el).height / 2, right: rect(el).right })),
    leadClient: lead.clientWidth, leadScroll: lead.scrollWidth,
    syncInBar: shown(document.getElementById('sync-btn')),
    mergeInDom: !!document.getElementById('merge-btn') || !!document.getElementById('merge-menu-btn'),
    viewport: window.innerWidth,
  };
});

test('narrow: one row, nothing past the viewport, the long title ellipsized, Sync out of the bar', async ({ page }) => {
  await routePublic(page);
  for (const width of [320, 360, 390, 720]) {
    await open(page, width, session());
    const m = await measure(page);
    console.log(`[header-compact] ${width}px: header ${m.headerHeight}px tall, title lead ${m.leadClient}px (content ${m.leadScroll}px)`);
    expect(m.headerHeight, `${width}px: header is one row (${m.headerHeight}px)`).toBeLessThanOrEqual(48);
    for (const c of m.controls) {
      expect(Math.abs(c.mid - m.headerMid), `${width}px: ${c.id} is centred on the row (${c.mid} vs ${m.headerMid})`).toBeLessThanOrEqual(2);
      expect(c.right, `${width}px: ${c.id} ends inside the viewport (${c.right} > ${m.viewport})`).toBeLessThanOrEqual(m.viewport);
    }
    // At 720px the 44-character title fits whole, so only the phone widths must truncate.
    if (width <= 390) expect(m.leadScroll, `${width}px: the long title is truncated (ellipsis engaged)`).toBeGreaterThan(m.leadClient);
    expect(m.syncInBar, `${width}px: Sync is not in the bar`).toBe(false);
    expect(m.mergeInDom, `${width}px: Merge is not in the header at all`).toBe(false);
    // Regression guard on the width budget: Plan mode mid-turn leaves the title
    // readable at 360. Deliberately not asserted at 320, where it is ~6 characters.
    if (width === 360) expect(m.leadClient, `360px: title lead is ${m.leadClient}px, wanted >= 80`).toBeGreaterThanOrEqual(80);
  }
});

test('desktop: chips run title < project < worktree < status; the project chip is "· "-prefixed when titled; Sync is in the bar', async ({ page }) => {
  await routePublic(page);
  for (const width of [721, 1280]) {
    await open(page, width, session({ title: 'My task' }));
    const r = await page.evaluate(() => {
      const q = (s: string) => document.querySelector(`#instance-title ${s}`)!;
      const box = (el: Element) => { const b = el.getBoundingClientRect(); return { left: b.left, right: b.right, top: b.top, bottom: b.bottom }; };
      const shown = (el: Element) => el.getClientRects().length > 0;
      return {
        order: ['.ih-title', '.ih-project', '.ih-worktree', '.ih-status'].map(s => box(q(s))),
        sep: getComputedStyle(q('.ih-project'), '::before').content,
        sync: shown(document.getElementById('sync-btn')!),
      };
    });
    // Each chip follows its predecessor: on the same row to its right, or on a later row.
    for (let i = 1; i < r.order.length; i++) {
      const a = r.order[i - 1];
      const b = r.order[i];
      expect(b.left >= a.right - 1 || b.top >= a.bottom - 1, `${width}px: chip ${i} follows chip ${i - 1}`).toBe(true);
    }
    expect(r.sep, `${width}px: separator on the secondary project chip`).toBe('"· "');
    expect(r.sync, `${width}px: Sync is visible in the bar`).toBe(true);
  }
});
