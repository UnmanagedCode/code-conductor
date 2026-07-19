// Tests for the "🧠 Change model" ⋮-menu button:
//   (1) its label is always static — no "(Family)" suffix (the popover's own
//       .qs-selected highlight is the only place current-family state shows).
//   (2) the header's "no instance selected" render branch actually hides the
//       ⋮ overflow menu instead of leaving a previously-live-rendered
//       Change-model/Rename/Debug button stale-clickable — the bug that made
//       clicking it silently do nothing once `currentInst` desynced from a
//       real live instance.
//
// Loads the real index.html into happy-dom (same approach as
// tests/static.test.mjs / tests/settings-toggle.test.mjs) so the `dom` object
// built here matches app.js's getElementById wiring exactly, then drives the
// real installHeader() factory with fake instance state.

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
    getAccountUsage: () => null,
    getAccountUsageStale: () => false,
    composer,
    conversation,
    closeOverflow: () => {},
  });

  return {
    window, document, dom, header, composer,
    setInstances: (v) => { instances = v; },
    setActiveId: (v) => { activeId = v; },
  };
}

const LIVE_INSTANCE = {
  id: 'inst-1', sessionId: 'sess-1', status: 'idle', mode: 'plan',
  model: 'claude-sonnet-4-6', project: 'demo', title: null, worktree: null,
  autoApprovePlan: false, interrupting: false, debug: false,
};

test('Change-model button label is always static, regardless of the instance model family', async () => {
  for (const model of ['claude-sonnet-4-6', 'claude-opus-4-8', 'claude-haiku-4-5-20251001', null]) {
    const { dom, header, setInstances, setActiveId } = await setup();
    setInstances([{ ...LIVE_INSTANCE, model }]);
    setActiveId('inst-1');
    header.update();
    assert.equal(dom.changeModelBtn.textContent, '🧠 Change model', `label must be static for model=${model}`);
  }
});

test('a live session shows the ⋮ menu with Change-model enabled', async () => {
  const { dom, header, setInstances, setActiveId } = await setup();
  setInstances([LIVE_INSTANCE]);
  setActiveId('inst-1');
  header.update();
  assert.equal(dom.overflowMenu.hidden, false);
  assert.equal(dom.changeModelBtn.hidden, false);
  assert.equal(dom.changeModelBtn.disabled, false);
});

test('when the active id has no backing instance, the ⋮ menu is hidden — not left stale-clickable', async () => {
  const { dom, header, setInstances, setActiveId } = await setup();
  // First render: a real live instance — the ⋮ menu becomes visible/enabled.
  setInstances([LIVE_INSTANCE]);
  setActiveId('inst-1');
  header.update();
  assert.equal(dom.overflowMenu.hidden, false, 'sanity: menu is visible while live');

  // Second render: state.instances no longer contains the active id (the
  // exact desync a stale/out-of-order refreshInstances() response used to
  // produce even though the server-side Instance was still fully live).
  setInstances([]);
  header.update();
  assert.equal(dom.overflowMenu.hidden, true,
    'the ⋮ menu (and therefore Change-model) must hide once the active instance disappears from state — ' +
    'previously it stayed visibly enabled from the prior render and clicking it silently no-opped');
});

test('reselecting a live instance after a no-instance render re-enables the menu', async () => {
  const { dom, header, setInstances, setActiveId } = await setup();
  setInstances([LIVE_INSTANCE]);
  setActiveId('inst-1');
  header.update();

  setInstances([]);
  header.update();
  assert.equal(dom.overflowMenu.hidden, true);

  setInstances([LIVE_INSTANCE]);
  header.update();
  assert.equal(dom.overflowMenu.hidden, false);
  assert.equal(dom.changeModelBtn.disabled, false);
});
