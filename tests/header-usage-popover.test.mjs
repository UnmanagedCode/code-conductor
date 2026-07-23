// Tests for the conditional "7-day (Fable)" line in the combined chip's usage
// popover (buildCombinedPopover in header.js). The account-wide /api/usage
// payload now carries a top-level `limits` array; a Fable-scoped entry looks
// like { kind: 'weekly_scoped', percent, resets_at, scope: { model: { display_name: 'Fable' } } }.
// The line must render ONLY when such an entry is present — no placeholder
// row for subscriptions without Fable access.
//
// Same happy-dom + installHeader() harness as tests/header-change-model.test.mjs,
// extended with a settable getAccountUsage so each test can supply its own
// /api/usage-shaped fixture.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { promises as fs } from 'node:fs';
import { Window } from 'happy-dom';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const PUB = path.resolve(__dirname, '..', 'public');
const INDEX_HTML = path.resolve(__dirname, '..', 'public', 'index.html');

async function setup() {
  const html = await fs.readFile(INDEX_HTML, 'utf8');
  const window = new Window({ url: 'http://localhost/' });
  globalThis.window = window;
  globalThis.document = window.document;
  globalThis.HTMLElement = window.HTMLElement;
  globalThis.Element = window.Element;
  globalThis.Node = window.Node;
  window.document.documentElement.innerHTML = html;
  const document = window.document;

  const dom = {
    composerInput: document.getElementById('composer-input'),
    modeSelect: document.getElementById('mode-select'),
    killBtn: document.getElementById('kill-btn'),
    resumeBtn: document.getElementById('resume-btn'),
    instanceTitle: document.getElementById('instance-title'),
    turnIndicator: document.getElementById('turn-indicator'),
    tiLeft: document.getElementById('ti-left'),
    tiDot: document.getElementById('ti-dot'),
    tiLabel: document.getElementById('ti-label'),
    tiEllipsis: document.getElementById('ti-ellipsis'),
    tiInterruptNow: document.getElementById('ti-interrupt-now'),
    tiUsageSlot: document.getElementById('ti-usage-slot'),
    syncBtn: document.getElementById('sync-btn'),
    mergeBtn: document.getElementById('merge-btn'),
    debugBtn: document.getElementById('debug-btn'),
    renameSessionBtn: document.getElementById('rename-session-btn'),
    changeModelBtn: document.getElementById('change-model-btn'),
    sessionStatsBtn: document.getElementById('session-stats-btn'),
    autoApprovePlanBtn: document.getElementById('auto-approve-plan-btn'),
    overflowMenu: document.getElementById('overflow-menu'),
    overflowToggle: document.getElementById('overflow-toggle'),
  };
  for (const [k, v] of Object.entries(dom)) {
    assert.ok(v, `dom.${k} must resolve to a real element from index.html`);
  }

  const { installHeader } = await import(pathToFileURL(path.join(PUB, 'header.js')).href + `?t=${Math.random()}`);
  const { UsageTracker, RateLimitTracker } = await import(pathToFileURL(path.join(PUB, 'usage.js')).href);

  let instances = [];
  let activeId = null;
  let accountUsage = null;
  const usageByInstance = new Map();
  const composer = { disable() { this.disabled = true; }, set(s) { this.disabled = false; Object.assign(this, s); } };
  const conversation = { setUserActionsEnabled() {} };

  const header = installHeader({
    dom,
    getActiveId: () => activeId,
    getInstances: () => instances,
    setActiveStatus: () => {},
    setActiveMode: () => {},
    getUsage: (id) => {
      if (!usageByInstance.has(id)) usageByInstance.set(id, new UsageTracker());
      return usageByInstance.get(id);
    },
    globalRLTracker: new RateLimitTracker(),
    getAccountUsage: () => accountUsage,
    getAccountUsageStale: () => false,
    composer,
    conversation,
    closeOverflow: () => {},
  });

  return {
    window, document, dom, header, composer,
    setInstances: (v) => { instances = v; },
    setActiveId: (v) => { activeId = v; },
    setAccountUsage: (v) => { accountUsage = v; },
  };
}

const LIVE_INSTANCE = {
  id: 'inst-1', sessionId: 'sess-1', status: 'idle', mode: 'plan',
  model: 'claude-sonnet-4-6', project: 'demo', title: null, worktree: null,
  autoApprovePlan: false, interrupting: false, debug: false,
};

// Opens the combined chip's popover and returns its row key/value pairs.
function openPopoverRows(dom, document) {
  const chip = dom.tiUsageSlot.querySelector('.ih-combined');
  assert.ok(chip, 'combined chip must be rendered');
  chip.dispatchEvent(new window.MouseEvent('click', { bubbles: true }));
  const popover = document.querySelector('.ih-usage-popover');
  assert.ok(popover, 'popover must open on chip click');
  return [...popover.querySelectorAll('.ih-usage-row')].map(r => ({
    key: r.querySelector('.ih-usage-k').textContent,
    value: r.querySelector('.ih-usage-v').textContent,
  }));
}

test('Fable line renders when a Fable-scoped limit is present', async () => {
  const { dom, document, header, setInstances, setActiveId, setAccountUsage } = await setup();
  setInstances([LIVE_INSTANCE]);
  setActiveId('inst-1');
  setAccountUsage({
    five_hour: { utilization: 10, resets_at: '2026-07-23T08:49:59+00:00' },
    seven_day: { utilization: 40, resets_at: '2026-07-26T00:59:59+00:00' },
    limits: [
      { kind: 'session', group: 'session', percent: 10, severity: 'normal',
        resets_at: '2026-07-23T08:49:59+00:00', scope: null, is_active: false },
      { kind: 'weekly_all', group: 'weekly', percent: 40, severity: 'normal',
        resets_at: '2026-07-26T00:59:59+00:00', scope: null, is_active: true },
      { kind: 'weekly_scoped', group: 'weekly', percent: 12, severity: 'normal',
        resets_at: '2026-07-26T01:00:00+00:00',
        scope: { model: { id: null, display_name: 'Fable' }, surface: null }, is_active: false },
    ],
  });
  header.update();

  const rows = openPopoverRows(dom, document);
  const fableRow = rows.find(r => r.key === '7-day (Fable)');
  assert.ok(fableRow, 'a "7-day (Fable)" row must be present');
  assert.match(fableRow.value, /^12% · resets /);
});

test('Fable line does not render when limits has no Fable-scoped entry', async () => {
  const { dom, document, header, setInstances, setActiveId, setAccountUsage } = await setup();
  setInstances([LIVE_INSTANCE]);
  setActiveId('inst-1');
  setAccountUsage({
    five_hour: { utilization: 10, resets_at: '2026-07-23T08:49:59+00:00' },
    limits: [
      { kind: 'session', group: 'session', percent: 10, severity: 'normal',
        resets_at: '2026-07-23T08:49:59+00:00', scope: null, is_active: false },
      { kind: 'weekly_all', group: 'weekly', percent: 40, severity: 'normal',
        resets_at: '2026-07-26T00:59:59+00:00', scope: null, is_active: true },
    ],
  });
  header.update();

  const rows = openPopoverRows(dom, document);
  assert.ok(!rows.some(r => r.key.includes('Fable')), 'no row should mention Fable');
});

test('Fable line does not render when the response has no limits key (legacy shape)', async () => {
  const { dom, document, header, setInstances, setActiveId, setAccountUsage } = await setup();
  setInstances([LIVE_INSTANCE]);
  setActiveId('inst-1');
  setAccountUsage({
    five_hour: { utilization: 10, resets_at: '2026-07-23T08:49:59+00:00' },
    seven_day: { utilization: 40, resets_at: '2026-07-26T00:59:59+00:00' },
  });
  header.update();

  const rows = openPopoverRows(dom, document);
  assert.ok(!rows.some(r => r.key.includes('Fable')), 'no row should mention Fable when limits is absent');
});

test('Fable line does not render when account usage is entirely unavailable', async () => {
  const { dom, document, header, setInstances, setActiveId, setAccountUsage } = await setup();
  setInstances([LIVE_INSTANCE]);
  setActiveId('inst-1');
  setAccountUsage(null);
  header.update();

  const chip = dom.tiUsageSlot.querySelector('.ih-combined');
  chip.dispatchEvent(new window.MouseEvent('click', { bubbles: true }));
  const popover = document.querySelector('.ih-usage-popover');
  assert.ok(popover, 'popover must still open');
  assert.ok(!popover.textContent.includes('Fable'), 'no Fable text anywhere when account usage is null');
});
