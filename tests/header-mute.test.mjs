// Tests for the "🔕 Mute" / "🔔 Unmute" ⋮-menu item that replaced the sidebar
// row mute button (2026-0014 relocation): it must sit directly above
// Terminate, reflect the session's current mute state via isSessionMuted(),
// and hide along with the rest of the ⋮ menu when no instance is active.
//
// Same approach as tests/header-change-model.test.mjs: load the real
// index.html into happy-dom so `dom` matches app.js's getElementById wiring,
// then drive the real installHeader() factory with fake instance state.
// notifications.js is imported WITHOUT a cache-busting query string (same as
// header.js's own import), so mutating NotificationState here is visible to
// header.js's isSessionMuted() calls — and is reset in a finally block so it
// can't leak into other tests in this file.

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
    renameSessionBtn: document.getElementById('rename-session-btn'),
    changeModelBtn: document.getElementById('change-model-btn'),
    sessionStatsBtn: document.getElementById('session-stats-btn'),
    pruneSessionBtn: document.getElementById('prune-session-btn'),
    autoApprovePlanBtn: document.getElementById('auto-approve-plan-btn'),
    overflowMenu: document.getElementById('overflow-menu'),
    overflowToggle: document.getElementById('overflow-toggle'),
  };
  for (const [k, v] of Object.entries(dom)) {
    assert.ok(v, `dom.${k} must resolve to a real element from index.html`);
  }

  const { installHeader } = await import(pathToFileURL(path.join(PUB, 'header.js')).href + `?t=${Math.random()}`);
  const { UsageTracker, RateLimitTracker } = await import(pathToFileURL(path.join(PUB, 'usage.js')).href);
  const notifications = await import(pathToFileURL(path.join(PUB, 'notifications.js')).href);

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
    window, document, dom, header, composer, notifications,
    setInstances: (v) => { instances = v; },
    setActiveId: (v) => { activeId = v; },
  };
}

const LIVE_INSTANCE = {
  id: 'inst-1', sessionId: 'sess-1', status: 'idle', mode: 'plan',
  model: 'claude-sonnet-4-6', project: 'demo', title: null, worktree: null,
  autoApprovePlan: false, interrupting: false, debug: false,
};

test('Mute item sits directly above Terminate in DOM order', async () => {
  const { dom } = await setup();
  const items = [...dom.overflowMenu.querySelectorAll('[role="menuitem"]')];
  const muteIdx = items.indexOf(dom.muteBtn);
  const killIdx = items.indexOf(dom.killBtn);
  assert.ok(muteIdx >= 0 && killIdx >= 0, 'both items must be present in the menu');
  assert.equal(killIdx, muteIdx + 1, 'Terminate/Interrupt must immediately follow Mute');
});

test('a live session shows the ⋮ menu with Mute enabled, unmuted by default', async () => {
  const { dom, header, notifications, setInstances, setActiveId } = await setup();
  try {
    setInstances([LIVE_INSTANCE]);
    setActiveId('inst-1');
    header.update();
    assert.equal(dom.overflowMenu.hidden, false);
    assert.equal(dom.muteBtn.hidden, false);
    assert.equal(dom.muteBtn.disabled, false);
    assert.equal(dom.muteBtn.textContent, '🔕 Mute');
    assert.equal(dom.muteBtn.getAttribute('aria-pressed'), 'false');
  } finally {
    notifications.NotificationState.mutedSessions.clear();
  }
});

test('Mute item reflects isSessionMuted() and flips label/aria-pressed on mute/unmute', async () => {
  const { dom, header, notifications, setInstances, setActiveId } = await setup();
  try {
    setInstances([LIVE_INSTANCE]);
    setActiveId('inst-1');
    header.update();

    notifications.muteSession('sess-1', true);
    header.update();
    assert.equal(dom.muteBtn.textContent, '🔔 Unmute');
    assert.equal(dom.muteBtn.getAttribute('aria-pressed'), 'true');

    notifications.muteSession('sess-1', false);
    header.update();
    assert.equal(dom.muteBtn.textContent, '🔕 Mute');
    assert.equal(dom.muteBtn.getAttribute('aria-pressed'), 'false');
  } finally {
    notifications.NotificationState.mutedSessions.clear();
  }
});

test('when the active id has no backing instance, the ⋮ menu (and Mute) is hidden', async () => {
  const { dom, header, setInstances, setActiveId } = await setup();
  setInstances([LIVE_INSTANCE]);
  setActiveId('inst-1');
  header.update();
  assert.equal(dom.muteBtn.hidden, false, 'sanity: visible while live');

  setInstances([]);
  header.update();
  assert.equal(dom.overflowMenu.hidden, true);
});
