// The playbook-enforcement toggle in the ⋮ session menu.
//
// It governs the CONDUCTOR's own tool calls, so it is meaningless on any other
// session — a visible control that does nothing is worse than an absent one.
// Modelled on #mute-btn: a menu item carrying two states in aria-pressed + its
// label, rendered from state (never optimistic) with the `status` frame
// authoritative — unlike #auto-approve-plan-btn, which flips optimistically.
//
// Same harness as tests/header-mute.test.mjs — the real index.html into
// happy-dom so `dom` matches app.js's wiring, then the real installHeader()
// driven with fake instance state.
//
// The click listener is covered too, through the REAL ws.js send(): a fake
// WebSocket global is installed and connect() called, so the frame the button
// actually puts on the wire is what gets asserted. Nothing here re-implements the
// flip — a test that recomputed the expected level would pass against a handler
// that had the same bug.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { promises as fs } from 'node:fs';
import { Window } from 'happy-dom';
import { installFakeSocket } from './fakeSocket.mjs';

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
  });

  return {
    dom, header, window,
    show(inst) { instances = [inst]; activeId = inst.id; header.update(); },
  };
}

const WORKER = {
  id: 'inst-1', sessionId: 'sess-1', status: 'idle', mode: 'plan',
  model: 'claude-sonnet-4-6', project: 'demo', title: null, worktree: null,
  autoApprovePlan: false, interrupting: false, debug: false,
};
// The reserved conductor project — must track CONDUCT_PROJECT_NAME (src/conduct.ts).
const CONDUCTOR = { ...WORKER, id: 'inst-2', sessionId: 'sess-2', project: '.conduct', playbookEnforcement: 'enforce' };

test('the control is hidden for an ordinary session and shown for a conductor', async () => {
  const t = await setup();

  t.show(WORKER);
  assert.equal(t.dom.playbookEnforcementBtn.hidden, true,
    'enforcement is meaningless off a conductor, so the control must not appear');
  assert.equal(t.dom.playbookEnforcementBtn.disabled, true);

  t.show(CONDUCTOR);
  assert.equal(t.dom.playbookEnforcementBtn.hidden, false);
  assert.equal(t.dom.playbookEnforcementBtn.disabled, false);
});

test('the toggle renders the conductor\'s current level, and re-renders when it changes', async () => {
  const t = await setup();

  t.show({ ...CONDUCTOR, playbookEnforcement: 'enforce' });
  assert.equal(t.dom.playbookEnforcementBtn.getAttribute('aria-pressed'), 'true',
    'enforce is the ON position — readable without interaction, which is the point of the control');
  assert.match(t.dom.playbookEnforcementBtn.textContent, /Enforce Playbooks/);

  // A `status` frame changes the mirrored value; update() must follow it rather
  // than keep whatever the user last tapped (the toggle is not optimistic).
  t.show({ ...CONDUCTOR, playbookEnforcement: 'warn' });
  assert.equal(t.dom.playbookEnforcementBtn.getAttribute('aria-pressed'), 'false',
    'warn is the OFF position: illegal moves are recorded but allowed');

  t.show({ ...CONDUCTOR, playbookEnforcement: 'enforce' });
  assert.equal(t.dom.playbookEnforcementBtn.getAttribute('aria-pressed'), 'true',
    'and back — the label tracks the server, in both directions');
});

test('a level this client does not know renders as ON', async () => {
  const t = await setup();
  // Only 'warn' turns the toggle off. A missing or unrecognised value therefore
  // reads as enforcing, which is the safe direction for a control whose OFF
  // position stops illegal moves being refused. ('off' is retired server-side and
  // normalized to 'warn' before it can reach a frame — see normalizePlaybookEnforcement.)
  const legacy = { ...CONDUCTOR };
  delete legacy.playbookEnforcement;
  t.show(legacy);
  assert.equal(t.dom.playbookEnforcementBtn.getAttribute('aria-pressed'), 'true');
});

test('the toggle sits in the ⋮ panel directly below Prune', async () => {
  const t = await setup();
  assert.equal(t.dom.playbookEnforcementBtn.parentElement?.id, 'overflow-panel',
    'it belongs in the ⋮ session menu, not the controls row');
  assert.equal(t.dom.playbookEnforcementBtn.previousElementSibling?.id, 'prune-session-btn',
    'placed immediately below Prune');
  assert.equal(t.dom.playbookEnforcementBtn.getAttribute('role'), 'menuitem');
});

test('the retired <select> is gone from index.html', async () => {
  const t = await setup();
  // assert.ok on a boolean, NOT assert.equal(node, null): handing a happy-dom
  // node to assert's diff serializer makes it recurse the DOM and the runner dies
  // with SIGKILL, so a future re-add would crash the suite instead of naming a
  // failure.
  assert.ok(!document.getElementById('playbook-enforcement-select'),
    'the three-level dropdown was replaced, not duplicated — two controls would fight over one field');
});

test('a dead conductor cannot have its enforcement changed', async () => {
  const t = await setup();
  for (const status of ['exited', 'crashed']) {
    t.show({ ...CONDUCTOR, status, playbookEnforcement: 'enforce' });
    assert.equal(t.dom.playbookEnforcementBtn.hidden, true, `hidden for a ${status} conductor`);
  }
});

// ── the click: what actually goes on the wire ──────────────────────────────

async function clickSetup() {
  const sent = [];
  installFakeSocket(sent);
  const t = await setup();
  // ws.js is imported WITHOUT a cache-buster so it is the same module instance
  // header.js's `import { send } from './ws.js'` resolved to.
  const { connect } = await import(pathToFileURL(path.join(PUB, 'ws.js')).href);
  connect();
  return { ...t, sent, enforcementFrames: () => sent.filter(m => m.t === 'playbook_enforcement') };
}

test('clicking the toggle sends the OPPOSITE level, in both directions', async () => {
  const t = await clickSetup();

  // ON -> off. The level sent must be the one NOT currently in effect: sending the
  // displayed level would be a silent no-op server-side (setPlaybookEnforcement
  // returns early on an equal mode), so the toggle would appear inert.
  t.show({ ...CONDUCTOR, playbookEnforcement: 'enforce' });
  t.dom.playbookEnforcementBtn.click();
  await new Promise(r => setImmediate(r));
  assert.deepEqual(t.enforcementFrames().map(m => m.mode), ['warn'],
    'an enforcing conductor must be sent warn');

  // off -> ON.
  t.show({ ...CONDUCTOR, playbookEnforcement: 'warn' });
  t.dom.playbookEnforcementBtn.click();
  await new Promise(r => setImmediate(r));
  assert.deepEqual(t.enforcementFrames().map(m => m.mode), ['warn', 'enforce'],
    'a warn conductor must be sent enforce');
});

test('the frame targets the active instance and asks for an ack', async () => {
  const t = await clickSetup();
  t.show({ ...CONDUCTOR, playbookEnforcement: 'warn' });
  t.dom.playbookEnforcementBtn.click();
  await new Promise(r => setImmediate(r));

  const [frame] = t.enforcementFrames();
  assert.equal(frame.id, CONDUCTOR.id, 'the flip must address the session being viewed');
  assert.ok(frame.reqId, 'sent with ack:true, so a rejected flip surfaces instead of failing silently');
});

test('a click with no active instance sends nothing AND throws nothing', async () => {
  // The ⋮ menu is hidden in this state, but a stale-clickable button was a real
  // bug for the sibling Change-model item (see tests/header-change-model.test.mjs).
  //
  // Asserting only "no frame sent" would NOT pin the guard: without
  // `if (!currentInst) return` the handler dereferences null and rejects, which
  // also sends no frame. So the error has to be asserted on too — and it does not
  // surface as a process unhandledRejection, because happy-dom catches an async
  // listener's rejection and re-dispatches it as a window 'error' event, leaving
  // the runner at exit 0. Removing the guard must fail this test.
  const t = await clickSetup();
  const escaped = [];
  const onError = (e) => escaped.push(e.message ?? String(e));
  const onRejection = (e) => escaped.push(e instanceof Error ? e.message : String(e));
  t.window.addEventListener('error', onError);
  process.on('unhandledRejection', onRejection);
  try {
    t.header.update();
    t.dom.playbookEnforcementBtn.click();
    // A macrotask turn, not setImmediate: the rejection is only observable once
    // the microtask queue has drained.
    await new Promise(r => setTimeout(r, 20));
    assert.deepEqual(t.enforcementFrames(), [], 'no flip is sent with nothing selected');
    assert.deepEqual(escaped, [], 'the click must return early, not crash on a null instance');
  } finally {
    t.window.removeEventListener('error', onError);
    process.off('unhandledRejection', onRejection);
  }
});
