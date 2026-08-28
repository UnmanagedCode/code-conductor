// Tests for two independent things rendered inside the combined chip's usage
// popover (buildCombinedPopover in header.js):
//
// 1. The conditional "7-day Fable" line — the account-wide /api/usage
//    payload now carries a top-level `limits` array; a Fable-scoped entry
//    looks like { kind: 'weekly_scoped', percent, resets_at, scope: { model:
//    { display_name: 'Fable' } } }. The line must render ONLY when such an
//    entry is present — no placeholder row for subscriptions without Fable
//    access.
// 2. The "Cost" row: for a claude-backed session it renders the accumulated
//    `$${cost}` figure as before; for an ollama-backed session it must NOT
//    show that figure — the CLI's total_cost_usd is Anthropic list pricing
//    applied to a free local backend, meaningless here (see
//    src/costTracking.ts's matching costs.jsonl fix) — so it renders the
//    popover's own "value unavailable" em-dash instead.
//
// Same happy-dom + installHeader() harness as tests/header-change-model.test.mjs,
// extended with a settable getAccountUsage (for the Fable cases) and a
// getUsageTracker accessor (for the Cost cases).

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
    muteBtn: document.getElementById('mute-btn'),
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
    summarizeSessionBtn: document.getElementById('summarize-session-btn'),
    renameSessionBtn: document.getElementById('rename-session-btn'),
    changeModelBtn: document.getElementById('change-model-btn'),
    changeEffortBtn: document.getElementById('change-effort-btn'),
    sessionStatsBtn: document.getElementById('session-stats-btn'),
    pruneSessionBtn: document.getElementById('prune-session-btn'),
    autoApprovePlanBtn: document.getElementById('auto-approve-plan-btn'),
    playbookEnforcementBtn: document.getElementById('playbook-enforcement-btn'),
    overflowMenu: document.getElementById('overflow-menu'),
    overflowToggle: document.getElementById('overflow-toggle'),
    overflowPanel: document.getElementById('overflow-panel'),
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
  });

  return {
    window, document, dom, header, composer,
    setInstances: (v) => { instances = v; },
    setActiveId: (v) => { activeId = v; },
    setAccountUsage: (v) => { accountUsage = v; },
    getUsageTracker: (id) => {
      if (!usageByInstance.has(id)) usageByInstance.set(id, new UsageTracker());
      return usageByInstance.get(id);
    },
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
  chip.dispatchEvent(new document.defaultView.MouseEvent('click', { bubbles: true }));
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
  const fableRow = rows.find(r => r.key === '7-day Fable');
  assert.ok(fableRow, 'a "7-day Fable" row must be present');
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
  chip.dispatchEvent(new document.defaultView.MouseEvent('click', { bubbles: true }));
  const popover = document.querySelector('.ih-usage-popover');
  assert.ok(popover, 'popover must still open');
  assert.ok(!popover.textContent.includes('Fable'), 'no Fable text anywhere when account usage is null');
});

test('usage popover suppresses the Cost row for an ollama-backed session', async () => {
  const { dom, document, header, setInstances, setActiveId, getUsageTracker } = await setup();
  setInstances([{ ...LIVE_INSTANCE, backend: 'ollama' }]);
  setActiveId('inst-1');
  getUsageTracker('inst-1').apply({
    kind: 'turn_end',
    usage: { input_tokens: 100, output_tokens: 50, cache_creation_input_tokens: 0, cache_read_input_tokens: 0 },
    costDelta: 0.05,
  });
  header.update();

  const rows = openPopoverRows(dom, document);
  const costRow = rows.find(r => r.key === 'Cost');
  assert.ok(costRow, 'Cost row should be rendered once turns > 0');
  assert.equal(costRow.value, '—', 'ollama session must not show the Anthropic-priced cost figure');
});

test('usage popover still shows the accumulated cost for a claude-backed session', async () => {
  const { dom, document, header, setInstances, setActiveId, getUsageTracker } = await setup();
  setInstances([{ ...LIVE_INSTANCE, backend: 'claude' }]);
  setActiveId('inst-1');
  getUsageTracker('inst-1').apply({
    kind: 'turn_end',
    usage: { input_tokens: 100, output_tokens: 50, cache_creation_input_tokens: 0, cache_read_input_tokens: 0 },
    costDelta: 0.05,
  });
  header.update();

  const rows = openPopoverRows(dom, document);
  const costRow = rows.find(r => r.key === 'Cost');
  assert.ok(costRow, 'Cost row should be rendered once turns > 0');
  assert.equal(costRow.value, '$0.0500', 'claude session cost rendering is unchanged');
});

// ── usage-limits bucket-row pin ─────────────────────────────────────────────
// Characterization pin ahead of collapsing the three copies of the rate-limit
// bucket key list (app.js, header.js, usage.js) onto one exported list, and
// header.js's private OAUTH_BUCKET_LABELS onto usage.js's RL_WINDOW_LABEL.
//
// Pins what must survive that: one row per KNOWN bucket actually present in
// the payload, in tightest-window-first order, each labelled from the
// long-form map — usage.js's RL_WINDOW_LABEL, now the only one.
//
// Committed one commit earlier with header.js's parenthesised labels
// ('7-day (Sonnet)'), and retargeted here in the same commit as the map
// merge, so the intended user-visible rewording shows up in that diff rather
// than as a silent fix.

test('usage limits: one row per present bucket, tightest window first', async () => {
  const { dom, document, header, setInstances, setActiveId, setAccountUsage } = await setup();
  setInstances([LIVE_INSTANCE]);
  setActiveId('inst-1');
  setAccountUsage({
    five_hour:        { utilization: 10, resets_at: '2026-07-23T08:49:59+00:00' },
    seven_day:        { utilization: 40, resets_at: '2026-07-26T00:59:59+00:00' },
    seven_day_sonnet: { utilization: 55, resets_at: '2026-07-26T00:59:59+00:00' },
    seven_day_opus:   { utilization: 70, resets_at: '2026-07-26T00:59:59+00:00' },
  });
  header.update();

  const rows = openPopoverRows(dom, document);
  assert.deepEqual(rows.map(r => r.key),
    ['5-hour', '7-day', '7-day Sonnet', '7-day Opus'],
    'every known bucket renders once, tightest window first');
  assert.deepEqual(rows.map(r => r.value.replace(/resets .*/, 'resets …')),
    ['10% · resets …', '40% · resets …', '55% · resets …', '70% · resets …']);
});

test('usage limits: an absent bucket gets no placeholder row', async () => {
  const { dom, document, header, setInstances, setActiveId, setAccountUsage } = await setup();
  setInstances([LIVE_INSTANCE]);
  setActiveId('inst-1');
  setAccountUsage({
    seven_day_opus: { utilization: 70, resets_at: '2026-07-26T00:59:59+00:00' },
  });
  header.update();

  const rows = openPopoverRows(dom, document);
  assert.equal(rows.length, 1, 'exactly one row for the one bucket present');
  assert.equal(rows[0].key, '7-day Opus');
  assert.match(rows[0].value, /^70% · resets /);
});
