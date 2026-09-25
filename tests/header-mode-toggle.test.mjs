// The header's Code | Plan mode switch (#mode-toggle).
//
// Two aria-pressed buttons rendered from the instance's `mode` (never
// optimistic — the `status` frame is authoritative), disabled exactly while a
// mode change cannot land: no instance, mid-turn, crashed, exited.
//
// Same harness as tests/header-playbook-enforcement.test.mjs — the real
// index.html into happy-dom and the real installHeader(); clicks go through the
// REAL ws.js send() over tests/fakeSocket.mjs, so the asserted frame is the one
// the button actually puts on the wire.
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
    clear() { instances = []; activeId = null; header.update(); },
  };
}

const WORKER = {
  id: 'inst-1', sessionId: 'sess-1', status: 'idle', mode: 'plan',
  model: 'claude-sonnet-4-6', project: 'demo', title: null, worktree: null,
  autoApprovePlan: false, interrupting: false, debug: false,
};

const opt = (dom, mode) => dom.modeToggle.querySelector(`.qs-mode-opt[data-mode="${mode}"]`);
const pressed = (dom, mode) => opt(dom, mode).getAttribute('aria-pressed');

async function clickSetup() {
  const sent = [];
  installFakeSocket(sent);
  const t = await setup();
  // ws.js is imported WITHOUT a cache-buster so it is the same module instance
  // header.js's `import { send } from './ws.js'` resolved to.
  const { connect } = await import(pathToFileURL(path.join(PUB, 'ws.js')).href);
  connect();
  return { ...t, sent, modeFrames: () => sent.filter(m => m.t === 'mode') };
}

// Invariant: the switch offers exactly the two modes, and its pressed side is
// the instance's mode in both directions.
test("the switch renders the instance's mode", async () => {
  const t = await setup();
  const opts = [...t.dom.modeToggle.querySelectorAll('.qs-mode-opt')];
  assert.equal(opts.length, 2, 'exactly two options');
  assert.deepEqual(opts.map(b => b.dataset.mode).sort(), ['bypassPermissions', 'plan']);

  t.show({ ...WORKER, mode: 'plan' });
  assert.equal(pressed(t.dom, 'plan'), 'true');
  assert.equal(pressed(t.dom, 'bypassPermissions'), 'false');

  t.show({ ...WORKER, mode: 'bypassPermissions' });
  assert.equal(pressed(t.dom, 'plan'), 'false');
  assert.equal(pressed(t.dom, 'bypassPermissions'), 'true');
});

// Invariant: a click on the unpressed side sends one `mode` frame for that
// side's mode, addressed to the active instance with an ack, and the display
// only changes when update() renders the new state.
test('clicking the other side sends one `mode` frame and does not flip optimistically', async () => {
  const t = await clickSetup();
  t.show({ ...WORKER, mode: 'bypassPermissions' });
  opt(t.dom, 'plan').click();
  await new Promise(r => setImmediate(r));

  const frames = t.modeFrames();
  assert.equal(frames.length, 1);
  assert.equal(frames[0].id, WORKER.id);
  assert.equal(frames[0].mode, 'plan');
  assert.ok(frames[0].reqId, 'sent with ack:true');
  assert.equal(pressed(t.dom, 'plan'), 'false', 'no optimistic flip');
  assert.equal(pressed(t.dom, 'bypassPermissions'), 'true');

  t.show({ ...WORKER, mode: 'plan' });
  assert.equal(pressed(t.dom, 'plan'), 'true', 'the next update renders the new state');
});

// Invariant: re-selecting the current mode is not a mode change.
test('clicking the pressed side sends nothing', async () => {
  const t = await clickSetup();
  t.show({ ...WORKER, mode: 'plan' });
  opt(t.dom, 'plan').click();
  await new Promise(r => setImmediate(r));
  assert.deepEqual(t.modeFrames(), []);
});

// Invariant: both buttons are disabled exactly in the states where a mode
// change cannot land, and enabled otherwise; with no instance neither is pressed.
test('disabled in turn / crashed / exited and with no instance; enabled when idle', async (tt) => {
  for (const status of ['turn', 'crashed', 'exited']) {
    await tt.test(`disabled while ${status}`, async () => {
      const t = await setup();
      t.show({ ...WORKER, status });
      assert.equal(opt(t.dom, 'plan').disabled, true);
      assert.equal(opt(t.dom, 'bypassPermissions').disabled, true);
    });
  }
  // Starts from a rendered instance (enabled, one side pressed), so the
  // assertions read update()'s no-instance render rather than the markup's
  // initial attributes: neither button may stay enabled or pressed.
  await tt.test('disabled and unpressed with no instance', async () => {
    const t = await setup();
    t.show({ ...WORKER, status: 'idle', mode: 'plan' });
    assert.equal(opt(t.dom, 'plan').disabled, false, 'precondition: enabled');
    assert.equal(pressed(t.dom, 'plan'), 'true', 'precondition: plan pressed');
    t.clear();
    for (const mode of ['plan', 'bypassPermissions']) {
      assert.equal(opt(t.dom, mode).disabled, true, `${mode} disabled`);
      assert.equal(pressed(t.dom, mode), 'false', `${mode} not pressed`);
    }
  });
  await tt.test('enabled when idle', async () => {
    const t = await setup();
    t.show({ ...WORKER, status: 'idle' });
    assert.equal(opt(t.dom, 'plan').disabled, false);
    assert.equal(opt(t.dom, 'bypassPermissions').disabled, false);
  });
});
