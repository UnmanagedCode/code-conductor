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
import { installFakeSocket } from './fakeSocket.mjs';
import { assertNull } from './dom-assert.mjs';

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
  globalThis.location = window.location;
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
    syncMenuBtn: document.getElementById('sync-menu-btn'),
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
  const usageByInstance = new Map();
  const composer = { disable() { this.disabled = true; }, set(s) { this.disabled = false; Object.assign(this, s); } };
  const conversation = { setUserActionsEnabled() {}, setCallUsageVisible() {} };

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

// ── the click: what actually goes on the wire (card 2026-0486) ─────────────
//
// Picking a tier in the popover must send ONLY the tier name — never a
// resolved model/backend — so the server (not a stale client cache) is what
// decides which model the switch lands on. Same harness shape as
// tests/header-change-effort.test.mjs's clickSetup.

async function clickSetup() {
  const sent = [];
  installFakeSocket(sent);
  const t = await setup();
  const { connect } = await import(pathToFileURL(path.join(PUB, 'ws.js')).href);
  connect();
  return { ...t, sent, modelFrames: () => sent.filter(m => m.t === 'model') };
}

test('picking a tier sends only {id, tier} — no model, no backend key', async () => {
  const t = await clickSetup();
  t.setInstances([LIVE_INSTANCE]);
  t.setActiveId('inst-1');
  t.header.update();

  t.dom.changeModelBtn.click();
  const popover = t.document.querySelector('.ih-usage-popover[aria-label="Change model"]');
  assert.ok(popover, 'the popover opens');
  const btn = popover.querySelector('.qs-model[data-tier="fast"]');
  assert.ok(btn, 'the popover offers a fast tier button');
  btn.click();
  await new Promise(r => setImmediate(r));

  assert.equal(t.modelFrames().length, 1);
  const frame = t.modelFrames()[0];
  assert.deepEqual(Object.keys(frame).sort(), ['id', 'reqId', 't', 'tier'].sort(),
    'exactly {t, id, tier, reqId} — no model/backend key survives the rewrite');
  assert.equal(frame.tier, 'fast');
  assert.equal(frame.id, LIVE_INSTANCE.id);
});

// ── restart switching on a substitution backend ─────────────────────────────
//
// The picker groups tiers by backend (the session's own first). On a
// substitution session its own backend's tiers restart the session (↻) and are
// disabled while anything runs; every other backend is disabled. The tier
// bindings come from public/models.js's cache — the SAME module instance
// header.js imports — set here and restored after each test.

const models = await import(pathToFileURL(path.join(PUB, 'models.js')).href);
const TIERS = ['fast', 'balanced', 'powerful', 'frontier'];
const SUB_BINDINGS = {
  fast: { backend: 'ollama', model: 'alpha:cloud' },
  balanced: { backend: 'ollama', model: 'beta:cloud' },
  powerful: { backend: 'claude', model: 'claude-opus-4-8' },
  frontier: { backend: 'claude', model: 'claude-fable-5-1' },
};
const SUB_INSTANCE = {
  ...LIVE_INSTANCE, mode: 'bypassPermissions', backend: 'ollama', model: 'alpha:cloud', displayStatus: 'idle',
};

async function withBindings(fn) {
  const saved = Object.fromEntries(TIERS.map(t => [t, models.getActiveTierBackend(t)]));
  models.setActiveTierBackend(SUB_BINDINGS);
  try { return await fn(); } finally { models.setActiveTierBackend(saved); }
}

function openModelPicker(t) {
  t.dom.changeModelBtn.click();
  const popover = t.document.querySelector('.ih-usage-popover[aria-label="Change model"]');
  assert.ok(popover, 'the popover opens');
  return popover;
}
const entry = (popover, tier) => popover.querySelector(`.qs-model[data-tier="${tier}"]`);

test('the picker groups tiers by backend, the session\'s own first', () => withBindings(async () => {
  const t = await clickSetup();
  t.setInstances([SUB_INSTANCE]);
  t.setActiveId('inst-1');
  t.header.update();
  const popover = openModelPicker(t);
  assert.deepEqual([...popover.querySelectorAll('.qs-backend-group')].map(n => n.textContent), ['Ollama', 'Claude']);
  const rows = [...popover.querySelectorAll('.quick-spawn-models')];
  assert.deepEqual(rows.map(r => [...r.querySelectorAll('.qs-model')].map(b => b.dataset.tier)),
    [['fast', 'balanced'], ['powerful', 'frontier']]);
}));

test('a substitution session: its own backend\'s tiers restart (↻, footnote), other backends are disabled', () => withBindings(async () => {
  const t = await clickSetup();
  t.setInstances([SUB_INSTANCE]);
  t.setActiveId('inst-1');
  t.header.update();
  const popover = openModelPicker(t);
  for (const tier of ['fast', 'balanced']) {
    const b = entry(popover, tier);
    assert.equal(b.disabled, false, tier);
    assert.equal(b.querySelector('.qs-restart-badge')?.textContent, '↻', `${tier} carries the restart badge`);
  }
  assert.ok(entry(popover, 'fast').classList.contains('qs-selected'), 'the running model is highlighted (exact id)');
  assert.ok(!entry(popover, 'balanced').classList.contains('qs-selected'));
  for (const tier of ['powerful', 'frontier']) {
    const b = entry(popover, tier);
    assert.equal(b.disabled, true, tier);
    assert.match(b.title, /^On Claude — a different backend needs a new session or a fork$/);
    assertNull(b.querySelector('.qs-restart-badge'), `${tier} has no restart badge`);
  }
  const notes = [...popover.querySelectorAll('.ih-usage-popover-note')].map(n => n.textContent);
  assert.deepEqual(notes, ['↻ restarts the session · conversation is kept']);
}));

test('an identity session: Claude tiers switch live with no badge or footnote, other backends are disabled', () => withBindings(async () => {
  const t = await clickSetup();
  t.setInstances([{ ...LIVE_INSTANCE, model: 'claude-opus-4-8', displayStatus: 'idle' }]);
  t.setActiveId('inst-1');
  t.header.update();
  const popover = openModelPicker(t);
  for (const tier of ['powerful', 'frontier']) {
    assert.equal(entry(popover, tier).disabled, false, `${tier}: a live switch is offered between turns`);
    assert.equal(entry(popover, tier).dataset.kind, 'live');
  }
  for (const tier of ['fast', 'balanced']) {
    assert.equal(entry(popover, tier).disabled, true);
    assert.match(entry(popover, tier).title, /^On Ollama — /);
  }
  assertNull(popover.querySelector('.qs-restart-badge'), 'no restart badge on an identity session');
  assertNull(popover.querySelector('.ih-usage-popover-note'), 'no footnote on an identity session');
  assertNull(popover.querySelector('.qs-model[data-model]'), 'an identity session is offered no model entries');
  assert.ok(entry(popover, 'powerful').classList.contains('qs-selected'));
}));

test('an identity session mid-turn: its live Claude tier entries are disabled until the turn ends', () => withBindings(async () => {
  const t = await clickSetup();
  const idle = { ...LIVE_INSTANCE, model: 'claude-opus-4-8', displayStatus: 'idle' };
  t.setInstances([idle]);
  t.setActiveId('inst-1');
  t.header.update();
  const popover = openModelPicker(t);
  t.setInstances([{ ...idle, status: 'turn', displayStatus: 'turn' }]);
  t.header.update();
  assert.ok(popover.isConnected, 'the open picker stays open and greys in place');
  for (const tier of ['powerful', 'frontier']) {
    assert.equal(entry(popover, tier).disabled, true, tier);
    assert.equal(entry(popover, tier).title, 'Model can only be changed between turns', tier);
  }
  t.setInstances([idle]);
  t.header.update();
  for (const tier of ['powerful', 'frontier']) {
    assert.equal(entry(popover, tier).disabled, false, `${tier} re-enables at turn end`);
  }
}));

test('modelEntryState: a live entry is enabled between turns and disabled during one', async () => {
  const { modelEntryState } = await import(pathToFileURL(path.join(PUB, 'header.js')).href);
  const binding = { backend: 'claude', model: 'claude-opus-4-8' };
  const idle = modelEntryState({ ...LIVE_INSTANCE, status: 'idle' }, binding);
  assert.deepEqual({ kind: idle.kind, disabled: idle.disabled }, { kind: 'live', disabled: false });
  const turn = modelEntryState({ ...LIVE_INSTANCE, status: 'turn' }, binding);
  assert.deepEqual(turn, { kind: 'live', disabled: true, title: 'Model can only be changed between turns' });
});

test('Change model is disabled during a turn and re-enabled at turn end, on every backend', async (t) => {
  for (const [name, inst] of [['a Claude session', LIVE_INSTANCE], ['an Ollama session', SUB_INSTANCE]]) {
    await t.test(name, async () => {
      const h = await setup();
      h.setInstances([{ ...inst, status: 'turn', displayStatus: 'turn' }]);
      h.setActiveId('inst-1');
      h.header.update();
      assert.equal(h.dom.changeModelBtn.hidden, false, 'still listed in the menu');
      assert.equal(h.dom.changeModelBtn.disabled, true);
      assert.equal(h.dom.changeModelBtn.title, 'Model can only be changed between turns');
      assert.equal(h.dom.changeEffortBtn.disabled, true, 'the same predicate gates Change effort');
      h.setInstances([{ ...inst, status: 'idle', displayStatus: 'idle' }]);
      h.header.update();
      assert.equal(h.dom.changeModelBtn.disabled, false);
      assert.equal(h.dom.changeModelBtn.title, 'Switch this session to another model');
      assert.equal(h.dom.changeEffortBtn.disabled, false);
    });
  }
});

test('restart entries are disabled while busy: a turn, a running subagent, or a switch in flight', async () => {
  const { modelEntryState, RESTART_BUSY_TITLE } = await import(pathToFileURL(path.join(PUB, 'header.js')).href);
  const binding = SUB_BINDINGS.balanced;
  assert.deepEqual(modelEntryState(SUB_INSTANCE, binding).disabled, false, 'premise: idle is enabled');
  for (const busy of [{ status: 'turn', displayStatus: 'turn' }, { displayStatus: 'running' }, { modelSwitch: { from: 'a', to: 'b' } }]) {
    const s = modelEntryState({ ...SUB_INSTANCE, ...busy }, binding);
    assert.equal(s.kind, 'restart', JSON.stringify(busy));
    assert.equal(s.disabled, true, JSON.stringify(busy));
    assert.equal(s.title, RESTART_BUSY_TITLE, JSON.stringify(busy));
  }
  await withBindings(async () => {
    const t = await clickSetup();
    t.setInstances([SUB_INSTANCE]);
    t.setActiveId('inst-1');
    t.header.update();
    const popover = openModelPicker(t);
    t.setInstances([{ ...SUB_INSTANCE, status: 'turn', displayStatus: 'turn' }]);
    t.header.update();
    const b = entry(popover, 'balanced');
    assert.equal(b.disabled, true);
    assert.equal(b.title, RESTART_BUSY_TITLE);
  });
});

test('an open picker re-enables its restart entries when the session goes idle', () => withBindings(async () => {
  const t = await clickSetup();
  t.setInstances([SUB_INSTANCE]);
  t.setActiveId('inst-1');
  t.header.update();
  const popover = openModelPicker(t);
  t.setInstances([{ ...SUB_INSTANCE, status: 'turn', displayStatus: 'turn' }]);
  t.header.update();
  assert.equal(entry(popover, 'balanced').disabled, true, 'premise: disabled mid-turn');
  t.setInstances([SUB_INSTANCE]);
  t.header.update();
  assert.ok(popover.isConnected, 'the picker stayed open across the re-render');
  assert.equal(entry(popover, 'balanced').disabled, false);
}));

test('a restart click sends exactly {t, id, tier, reqId} and closes the picker on the ack', () => withBindings(async () => {
  const t = await clickSetup();
  t.setInstances([SUB_INSTANCE]);
  t.setActiveId('inst-1');
  t.header.update();
  entry(openModelPicker(t), 'balanced').click();
  await new Promise(r => setImmediate(r));
  assert.equal(t.modelFrames().length, 1);
  const frame = t.modelFrames()[0];
  assert.deepEqual(Object.keys(frame).sort(), ['id', 'reqId', 't', 'tier']);
  assert.equal(frame.tier, 'balanced');
  assertNull(t.document.querySelector('.ih-usage-popover[aria-label="Change model"]'), 'the picker closed on the ack');
}));

test('a refused restart is shown inside the open picker — no alert()', () => withBindings(async () => {
  const sent = [];
  installFakeSocket(sent, { ack: (m) => (m.t === 'model' ? { ok: false, error: 'cannot switch model during a running turn' } : { ok: true }) });
  const t = await setup();
  const { connect } = await import(pathToFileURL(path.join(PUB, 'ws.js')).href);
  connect();
  const alerts = [];
  const prevAlert = globalThis.alert;
  globalThis.alert = (m) => alerts.push(m);
  try {
    t.setInstances([SUB_INSTANCE]);
    t.setActiveId('inst-1');
    t.header.update();
    const popover = openModelPicker(t);
    entry(popover, 'balanced').click();
    await new Promise(r => setImmediate(r));
    assert.ok(popover.isConnected, 'the picker stays open');
    const warn = popover.querySelector('.ih-usage-popover-note.warn');
    assert.ok(warn, 'the refusal is rendered inline');
    assert.match(warn.textContent, /cannot switch model during a running turn/);
    assert.deepEqual(alerts, []);
    // It survives the next re-render of the same session.
    t.header.update();
    assert.match(popover.querySelector('.ih-usage-popover-note.warn')?.textContent ?? '', /running turn/);
  } finally { globalThis.alert = prevAlert; }
}));

test('a switch in flight shows the restarting chip, blocks sending, and keeps the old model in the usage popover', async () => {
  const t = await setup();
  const switching = { ...SUB_INSTANCE, status: 'exited', displayStatus: 'exited', model: 'beta:cloud',
    modelSwitch: { from: 'alpha:cloud', to: 'beta:cloud' } };
  t.setInstances([switching]);
  t.setActiveId('inst-1');
  t.header.update();
  const chip = t.dom.instanceTitle.querySelector('.ih-status');
  assert.ok(chip.classList.contains('ih-status-restarting'), 'not the transient `exited`');
  assert.equal(chip.textContent, 'Restarting · switching model alpha:cloud → beta:cloud');
  assert.equal(t.dom.instanceTitle.querySelectorAll('.ih-status').length, 1);
  assert.equal(t.dom.resumeBtn.hidden, true, 'no Resume offered for the switch\'s own exit');
  assert.equal(t.dom.changeModelBtn.disabled, true);
  assert.equal(t.dom.changeEffortBtn.disabled, true);

  t.setInstances([{ ...switching, status: 'idle', displayStatus: 'idle' }]);
  t.header.update();
  assert.equal(t.composer.canSend, false, 'the grace window does not reopen Send');
  t.dom.tiUsageSlot.querySelector('.ih-combined').click();
  const meta = t.document.querySelector('.ih-usage-popover[aria-label="Usage details"] .ih-usage-meta');
  assert.ok(meta.textContent.startsWith('alpha:cloud'), `the unconfirmed target is not shown yet: ${meta.textContent}`);
});

test('a failed switch shows a failure chip carrying the cause as its tooltip', async () => {
  const t = await setup();
  const failure = { from: 'alpha:cloud', to: 'beta:cloud', error: "Error: model 'beta:cloud' not found" };
  t.setInstances([{ ...SUB_INSTANCE, modelSwitchFailure: failure }]);
  t.setActiveId('inst-1');
  t.header.update();
  const chip = t.dom.instanceTitle.querySelector('.ih-status-switch-failed');
  assert.ok(chip);
  assert.equal(chip.textContent, 'Switch to beta:cloud failed');
  assert.equal(chip.title, failure.error);
  assert.equal(t.composer.canSend, true, 'the session is back on its old model and usable');

  t.setInstances([{ ...SUB_INSTANCE, modelSwitchFailure: failure, modelSwitch: { from: 'alpha:cloud', to: 'beta:cloud' } }]);
  t.header.update();
  assertNull(t.dom.instanceTitle.querySelector('.ih-status-switch-failed'), 'a new switch in flight replaces it');
});

test('a stale refusal note clears once the picker\'s entry states change', () => withBindings(async () => {
  const sent = [];
  installFakeSocket(sent, { ack: (m) => (m.t === 'model' ? { ok: false, error: 'cannot switch model during a running turn' } : { ok: true }) });
  const t = await setup();
  const { connect } = await import(pathToFileURL(path.join(PUB, 'ws.js')).href);
  connect();
  t.setInstances([SUB_INSTANCE]);
  t.setActiveId('inst-1');
  t.header.update();
  const popover = openModelPicker(t);
  entry(popover, 'balanced').click();
  await new Promise(r => setImmediate(r));
  assert.ok(popover.querySelector('.ih-usage-popover-note.warn'), 'premise: the refusal is shown');
  t.setInstances([{ ...SUB_INSTANCE, status: 'turn', displayStatus: 'turn' }]);
  t.header.update();
  assertNull(popover.querySelector('.ih-usage-popover-note.warn'), 'the note went with the state it described');
  t.setInstances([SUB_INSTANCE]);
  t.header.update();
  assertNull(popover.querySelector('.ih-usage-popover-note.warn'), 'and does not come back');
}));

test('a re-render with unchanged entry states keeps the very same buttons (a click in progress is not detached)', () => withBindings(async () => {
  const t = await clickSetup();
  t.setInstances([SUB_INSTANCE]);
  t.setActiveId('inst-1');
  t.header.update();
  const popover = openModelPicker(t);
  const before = entry(popover, 'balanced');
  // A status update that moves nothing the picker shows (e.g. a title change).
  t.setInstances([{ ...SUB_INSTANCE, title: 'renamed' }]);
  t.header.update();
  assert.ok(entry(popover, 'balanced') === before, 'not rebuilt');
  assert.ok(before.isConnected);
  // A real state change does rebuild.
  t.setInstances([{ ...SUB_INSTANCE, status: 'turn', displayStatus: 'turn' }]);
  t.header.update();
  assert.ok(entry(popover, 'balanced') !== before, 'rebuilt on a state change');
  assert.equal(entry(popover, 'balanced').disabled, true);
}));

test('mid-switch the usage popover names the confirmed model with no window clause', async () => {
  const t = await setup();
  const meta = () => {
    t.dom.tiUsageSlot.querySelector('.ih-combined').click();
    return t.document.querySelector('.ih-usage-popover[aria-label="Usage details"] .ih-usage-meta').textContent;
  };
  t.setInstances([{ ...SUB_INSTANCE, model: 'beta:cloud', contextWindowTokens: 300_000,
    modelSwitch: { from: 'alpha:cloud', to: 'beta:cloud' } }]);
  t.setActiveId('inst-1');
  t.header.update();
  assert.equal(meta(), 'alpha:cloud', 'the new model\'s window is not paired with the old model\'s name');
  t.setInstances([{ ...SUB_INSTANCE, model: 'beta:cloud', contextWindowTokens: 300_000 }]);
  t.header.update();
  assert.equal(meta(), 'beta:cloud · 300k context', 'control: settled, the window clause is back');
});

// ── a substitution session's registered models ───────────────────────────────
//
// A non-Claude session is offered every model registered on its own backend
// (public/models.js's backendModels cache, shipped by the server), after the
// tiers bound there. The motivating install: every tier on Claude, and Ollama
// sessions spawned from a role bound straight to a curated preset.

const ALL_CLAUDE = {
  fast: { backend: 'claude', model: 'claude-haiku-4-5-20251001' },
  balanced: { backend: 'claude', model: 'claude-sonnet-4-6' },
  powerful: { backend: 'claude', model: 'claude-opus-4-8' },
  frontier: { backend: 'claude', model: 'claude-fable-5-1' },
};
const OLLAMA_MODELS = [
  { model: 'deepseek-v4.1-flash:cloud', label: 'DeepSeek V4.1 Flash' },
  { model: 'glm-5.3:cloud', label: 'GLM-5.3' },
  { model: 'glm-5.3-flash:cloud', label: 'GLM-5.3 Flash' },
];
const ROLE_INSTANCE = { ...SUB_INSTANCE, model: 'deepseek-v4.1-flash:cloud' };

async function withRegistry(bindings, backendModels, fn) {
  const savedTiers = Object.fromEntries(TIERS.map(t => [t, models.getActiveTierBackend(t)]));
  const ids = Object.keys(backendModels);
  const savedModels = Object.fromEntries(ids.map(id => [id, models.getBackendModels(id)]));
  models.setActiveTierBackend(bindings);
  models.setBackendModels(backendModels);
  try { return await fn(); } finally {
    models.setActiveTierBackend(savedTiers);
    models.setBackendModels(savedModels);
  }
}
const modelEntry = (popover, model) => popover.querySelector(`.qs-model[data-model="${model}"]`);

test('an Ollama role session with every tier on Claude is offered its backend\'s registered models', () => withRegistry(ALL_CLAUDE, { ollama: OLLAMA_MODELS }, async () => {
  const t = await clickSetup();
  t.setInstances([ROLE_INSTANCE]);
  t.setActiveId('inst-1');
  t.header.update();
  const popover = openModelPicker(t);
  assert.deepEqual([...popover.querySelectorAll('.qs-backend-group')].map(n => n.textContent), ['Ollama', 'Claude']);
  const [own, other] = [...popover.querySelectorAll('.quick-spawn-models')];
  assert.deepEqual([...own.querySelectorAll('.qs-model')].map(b => b.dataset.model), OLLAMA_MODELS.map(m => m.model));
  for (const { model, label } of OLLAMA_MODELS) {
    const b = modelEntry(popover, model);
    assert.equal(b.disabled, false, model);
    assert.equal(b.dataset.kind, 'restart', model);
    assert.equal(b.firstChild.textContent, label, `${model} is labelled from the registry`);
    assert.equal(b.querySelector('.qs-restart-badge')?.textContent, '↻', model);
    assert.equal(b.dataset.tier, undefined, `${model} is not a tier entry`);
  }
  assert.ok(modelEntry(popover, 'deepseek-v4.1-flash:cloud').classList.contains('qs-selected'), 'the running model is highlighted');
  assert.ok(!modelEntry(popover, 'glm-5.3-flash:cloud').classList.contains('qs-selected'));
  for (const tier of TIERS) {
    const b = other.querySelector(`.qs-model[data-tier="${tier}"]`);
    assert.equal(b.disabled, true, tier);
    assert.match(b.title, /^On Claude — /);
  }
  assert.deepEqual([...popover.querySelectorAll('.ih-usage-popover-note')].map(n => n.textContent),
    ['↻ restarts the session · conversation is kept']);

  modelEntry(popover, 'glm-5.3-flash:cloud').click();
  await new Promise(r => setImmediate(r));
  assert.equal(t.modelFrames().length, 1);
  const frame = t.modelFrames()[0];
  assert.deepEqual(Object.keys(frame).sort(), ['id', 'model', 'reqId', 't'], 'exactly {t, id, model, reqId}: no tier, no backend');
  assert.equal(frame.model, 'glm-5.3-flash:cloud');
  assert.equal(frame.id, ROLE_INSTANCE.id);
  assertNull(t.document.querySelector('.ih-usage-popover[aria-label="Change model"]'), 'the picker closed on the ack');
}));

test('a registered model that an offered tier on the session\'s backend binds is listed once, as the tier', () => withRegistry(SUB_BINDINGS,
  { ollama: [{ model: 'alpha:cloud', label: 'Alpha' }, { model: 'gamma:cloud', label: 'Gamma' }] }, async () => {
    const t = await clickSetup();
    t.setInstances([SUB_INSTANCE]);
    t.setActiveId('inst-1');
    t.header.update();
    const popover = openModelPicker(t);
    const own = popover.querySelector('.quick-spawn-models');
    assert.deepEqual([...own.querySelectorAll('.qs-model')].map(b => b.dataset.tier ?? b.dataset.model),
      ['fast', 'balanced', 'gamma:cloud'], 'alpha:cloud is the fast tier, not a second entry');
    assertNull(modelEntry(popover, 'alpha:cloud'));
  }));

test('registered-model entries are disabled with the restart-busy title while a turn runs', () => withRegistry(ALL_CLAUDE, { ollama: OLLAMA_MODELS }, async () => {
  const { RESTART_BUSY_TITLE } = await import(pathToFileURL(path.join(PUB, 'header.js')).href);
  const t = await clickSetup();
  t.setInstances([ROLE_INSTANCE]);
  t.setActiveId('inst-1');
  t.header.update();
  const popover = openModelPicker(t);
  t.setInstances([{ ...ROLE_INSTANCE, status: 'turn', displayStatus: 'turn' }]);
  t.header.update();
  for (const { model } of OLLAMA_MODELS) {
    assert.equal(modelEntry(popover, model).disabled, true, model);
    assert.equal(modelEntry(popover, model).title, RESTART_BUSY_TITLE, model);
  }
}));

test('a substitution session with nothing else registered on its backend says so', async (t) => {
  const NOTE = 'No other model is registered on Ollama — add one in Settings → Models';
  await t.test('nothing registered at all', () => withRegistry(ALL_CLAUDE, { ollama: [] }, async () => {
    const h = await clickSetup();
    h.setInstances([ROLE_INSTANCE]);
    h.setActiveId('inst-1');
    h.header.update();
    const popover = openModelPicker(h);
    assert.ok([...popover.querySelectorAll('.ih-usage-popover-note')].some(n => n.textContent === NOTE));
    assert.equal(popover.querySelectorAll('.qs-model:not([disabled])').length, 0, 'no enabled entry');
  }));
  await t.test('only the running model registered', () => withRegistry(ALL_CLAUDE, { ollama: OLLAMA_MODELS.slice(0, 1) }, async () => {
    const h = await clickSetup();
    h.setInstances([ROLE_INSTANCE]);
    h.setActiveId('inst-1');
    h.header.update();
    const popover = openModelPicker(h);
    assert.ok([...popover.querySelectorAll('.ih-usage-popover-note')].some(n => n.textContent === NOTE));
    const enabled = [...popover.querySelectorAll('.qs-model:not([disabled])')];
    assert.deepEqual(enabled.map(b => b.dataset.model), ['deepseek-v4.1-flash:cloud'], 'only the running model itself');
  }));
  await t.test('control: another model registered', () => withRegistry(ALL_CLAUDE, { ollama: OLLAMA_MODELS }, async () => {
    const h = await clickSetup();
    h.setInstances([ROLE_INSTANCE]);
    h.setActiveId('inst-1');
    h.header.update();
    const popover = openModelPicker(h);
    assert.ok(![...popover.querySelectorAll('.ih-usage-popover-note')].some(n => n.textContent === NOTE));
  }));
});

// The registered-model list follows the server: seeded by the boot fetch, and
// replaced by every Settings → Models response (public/app.js's onModelsChange
// hands that payload to the same applyModelsPayload).

test('a models payload replaces the picker\'s registered models: an added model appears, a removed one goes', () => withRegistry(ALL_CLAUDE, { ollama: OLLAMA_MODELS.slice(0, 1) }, async () => {
  const NOTE = 'No other model is registered on Ollama — add one in Settings → Models';
  const t = await clickSetup();
  t.setInstances([ROLE_INSTANCE]);
  t.setActiveId('inst-1');
  t.header.update();
  const read = () => {
    const popover = openModelPicker(t);
    const shown = {
      models: [...popover.querySelectorAll('.qs-model[data-model]')].map(b => b.dataset.model),
      note: [...popover.querySelectorAll('.ih-usage-popover-note')].some(n => n.textContent === NOTE),
    };
    t.dom.changeModelBtn.click(); // toggles the picker closed
    return shown;
  };
  assert.deepEqual(read(), { models: ['deepseek-v4.1-flash:cloud'], note: true }, 'premise: only the running model');
  const spawnTier = models.getActiveDefaultSpawnTier();
  models.applyModelsPayload({ backendModels: { ollama: OLLAMA_MODELS }, defaultSpawnTier: spawnTier });
  assert.deepEqual(read(), { models: OLLAMA_MODELS.map(m => m.model), note: false }, 'the added models are offered at once');
  models.applyModelsPayload({ backendModels: { ollama: OLLAMA_MODELS.slice(0, 2) }, defaultSpawnTier: spawnTier });
  assert.deepEqual(read().models, OLLAMA_MODELS.slice(0, 2).map(m => m.model), 'a removed model is no longer offered');
}));

test('the boot fetch seeds the registered models from the payload', () => withRegistry(ALL_CLAUDE, { ollama: [] }, async () => {
  const realFetch = globalThis.fetch;
  globalThis.fetch = async (url) => {
    assert.match(String(url), /\/api\/settings\/models/);
    return { ok: true, json: async () => ({ backendModels: { ollama: OLLAMA_MODELS }, defaultSpawnTier: models.getActiveDefaultSpawnTier() }) };
  };
  try {
    await models.loadModelVersions();
  } finally { globalThis.fetch = realFetch; }
  assert.deepEqual(models.getBackendModels('ollama'), OLLAMA_MODELS);
}));
