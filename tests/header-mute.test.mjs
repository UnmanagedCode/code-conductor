// Tests for the "🔕 Mute" / "🔔 Unmute" ⋮-menu item that replaced the sidebar
// row mute button (2026-0014 relocation): it must sit directly above
// Terminate, reflect the session's current mute state via isSessionMuted(),
// and hide along with the rest of the ⋮ menu when no instance is active.
//
// Also owns the ⋮ menu's open-state-across-update() pins (2026-0241): an open
// panel must survive update() (called on every message_start etc.) instead of
// being closed unconditionally, while still (a) refreshing its items live,
// (b) closing when it stops being menu-eligible, (c) closing when the active
// session changes under it, and (d) still closing via every deliberate path
// (outside click, Escape, toggle re-click, item click).
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
    modeToggle: document.getElementById('mode-toggle'),
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
  const notifications = await import(pathToFileURL(path.join(PUB, 'notifications.js')).href);

  let instances = [];
  let activeId = null;
  const usageByInstance = new Map();
  const composer = { disable() { this.disabled = true; }, set(s) { this.disabled = false; Object.assign(this, s); } };
  const conversation = { setUserActionsEnabled() {} };
  const calls = { openSummary: 0, openStats: 0, openPrune: 0 };
  const sessionActions = {
    applySessionTitle: async () => {},
    syncWorktree: async () => {},
    mergeWorktree: async () => {},
    respawnActive: async () => {},
  };
  const openSummary = () => { calls.openSummary += 1; };
  const openStats = () => { calls.openStats += 1; };
  const openPrune = () => { calls.openPrune += 1; };

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
    sessionActions,
    openSummary,
    openStats,
    openPrune,
  });

  return {
    window, document, dom, header, composer, notifications, calls,
    setInstances: (v) => { instances = v; },
    setActiveId: (v) => { activeId = v; },
  };
}

const click = (node, win) =>
  node.dispatchEvent(new win.MouseEvent('click', { bubbles: true, cancelable: true }));
const pointerdown = (node, win) =>
  node.dispatchEvent(new win.Event('pointerdown', { bubbles: true, cancelable: true }));
const keydown = (node, win, key) =>
  node.dispatchEvent(new win.KeyboardEvent('keydown', { key, bubbles: true, cancelable: true }));

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

const OTHER_INSTANCE = {
  id: 'inst-2', sessionId: 'sess-2', status: 'idle', mode: 'plan',
  model: 'claude-sonnet-4-6', project: 'demo', title: null, worktree: null,
  autoApprovePlan: false, interrupting: false, debug: false,
};

test('T1: an open ⋮ panel survives update() driven by message_start-style events', async () => {
  const { window, dom, header, setInstances, setActiveId } = await setup();
  setInstances([LIVE_INSTANCE]);
  setActiveId('inst-1');
  header.update();

  click(dom.overflowToggle, window);
  assert.equal(dom.overflowPanel.hidden, false, 'sanity: menu opens on toggle click');
  assert.equal(dom.overflowToggle.getAttribute('aria-expanded'), 'true');

  for (let i = 0; i < 3; i += 1) {
    header.update();
    assert.equal(dom.overflowPanel.hidden, false, `panel must stay open after update() #${i + 1}`);
    assert.equal(dom.overflowToggle.getAttribute('aria-expanded'), 'true');
  }
});

test('T2: items keep refreshing live while the ⋮ panel stays open', async () => {
  const { window, dom, header, notifications, setInstances, setActiveId } = await setup();
  try {
    setInstances([LIVE_INSTANCE]);
    setActiveId('inst-1');
    header.update();
    click(dom.overflowToggle, window);
    assert.equal(dom.overflowPanel.hidden, false);
    assert.equal(dom.pruneSessionBtn.disabled, false);
    assert.equal(
      dom.pruneSessionBtn.title,
      "Shrink this session's context by stubbing out old tool payloads and thinking "
        + '— mechanical, no LLM pass, no token cost',
    );

    setInstances([{ ...LIVE_INSTANCE, status: 'turn' }]);
    header.update();
    assert.equal(dom.overflowPanel.hidden, false, 'panel must still be open across a status-changing update()');
    assert.equal(dom.pruneSessionBtn.disabled, true);
    assert.equal(dom.pruneSessionBtn.title, 'Prune is only available between turns');
    assert.equal(dom.killBtn.textContent, '⏸ Interrupt');

    notifications.muteSession('sess-1', true);
    header.update();
    assert.equal(dom.overflowPanel.hidden, false, 'panel must still be open after a mute-driven update()');
    assert.equal(dom.muteBtn.textContent, '🔔 Unmute');
    assert.equal(dom.muteBtn.getAttribute('aria-pressed'), 'true');
  } finally {
    notifications.NotificationState.mutedSessions.clear();
  }
});

test('T3: the ⋮ menu closes when the session stops being menu-eligible', async () => {
  const { window, dom, header, setInstances, setActiveId } = await setup();
  setActiveId('inst-1');

  // (a) instance transitions to a non-menu-eligible status ('exited').
  setInstances([LIVE_INSTANCE]);
  header.update();
  click(dom.overflowToggle, window);
  assert.equal(dom.overflowPanel.hidden, false, 'sanity: open');
  setInstances([{ ...LIVE_INSTANCE, status: 'exited' }]);
  header.update();
  assert.equal(dom.overflowMenu.hidden, true);
  assert.equal(dom.overflowPanel.hidden, true);
  assert.equal(dom.overflowToggle.getAttribute('aria-expanded'), 'false');

  // (b) the active instance disappears from state entirely.
  setInstances([LIVE_INSTANCE]);
  header.update();
  click(dom.overflowToggle, window);
  assert.equal(dom.overflowPanel.hidden, false, 'sanity: open again');
  setInstances([]);
  header.update();
  assert.equal(dom.overflowMenu.hidden, true);
  assert.equal(dom.overflowPanel.hidden, true);
  assert.equal(dom.overflowToggle.getAttribute('aria-expanded'), 'false');

  // Re-open probe: the controller must have been disarmed by the close above,
  // not merely hidden — otherwise toggleOverflow's "already armed" branch
  // would take the close path and the panel would never reopen.
  setInstances([LIVE_INSTANCE]);
  header.update();
  click(dom.overflowToggle, window);
  assert.equal(dom.overflowPanel.hidden, false, 'menu must be able to reopen after the forced close');
});

test('T4: switching the active session under an open menu closes it', async () => {
  const { window, dom, header, setInstances, setActiveId } = await setup();
  setInstances([LIVE_INSTANCE, OTHER_INSTANCE]);
  setActiveId('inst-1');
  header.update();
  click(dom.overflowToggle, window);
  assert.equal(dom.overflowPanel.hidden, false, 'sanity: open on inst-1');

  // Programmatic switch — no pointer event, mirroring popstate / a
  // notification click, which the outside-pointerdown dismiss can't catch.
  setActiveId('inst-2');
  header.update();
  assert.equal(dom.overflowPanel.hidden, true, 'menu must close when the active session changed under it');
  assert.equal(dom.overflowToggle.getAttribute('aria-expanded'), 'false');

  // Re-open probe (disarm check, same reasoning as T3).
  click(dom.overflowToggle, window);
  assert.equal(dom.overflowPanel.hidden, false, 'menu must be able to reopen on the new active session');

  header.update();
  assert.equal(dom.overflowPanel.hidden, false, 'reopened panel must survive a further update() on the same session');
});

test('T5: the deliberate close paths still close the ⋮ menu', async () => {
  const { window, document, dom, header, calls, setInstances, setActiveId } = await setup();
  setInstances([LIVE_INSTANCE]);
  setActiveId('inst-1');
  header.update();

  // (a) outside pointerdown dismisses.
  click(dom.overflowToggle, window);
  assert.equal(dom.overflowPanel.hidden, false, 'sanity: open');
  pointerdown(document.getElementById('conversation'), window);
  assert.equal(dom.overflowPanel.hidden, true);
  assert.equal(dom.overflowToggle.getAttribute('aria-expanded'), 'false');

  // (b) pointerdown INSIDE the panel must not close it out from under a click.
  click(dom.overflowToggle, window);
  assert.equal(dom.overflowPanel.hidden, false, 'sanity: open');
  pointerdown(dom.overflowPanel, window);
  assert.equal(dom.overflowPanel.hidden, false, 'a pointerdown inside the panel must not dismiss it');

  // (c) Escape dismisses; any other key does not.
  keydown(document, window, 'a');
  assert.equal(dom.overflowPanel.hidden, false, 'a non-Escape key must not dismiss');
  keydown(document, window, 'Escape');
  assert.equal(dom.overflowPanel.hidden, true);

  // (d) clicking an item closes the menu and invokes its handler.
  click(dom.overflowToggle, window);
  assert.equal(dom.overflowPanel.hidden, false, 'sanity: open');
  assert.equal(calls.openSummary, 0);
  click(dom.summarizeSessionBtn, window);
  assert.equal(dom.overflowPanel.hidden, true);
  assert.equal(calls.openSummary, 1);

  // (e) re-clicking the toggle while open closes it.
  click(dom.overflowToggle, window);
  assert.equal(dom.overflowPanel.hidden, false, 'sanity: open');
  click(dom.overflowToggle, window);
  assert.equal(dom.overflowPanel.hidden, true);
});
