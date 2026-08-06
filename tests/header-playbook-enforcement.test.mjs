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
// driven with fake instance state. This file covers the RENDER side only; the
// `click` listener that forwards to send() lives in app.js.
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
    playbookEnforcementBtn: document.getElementById('playbook-enforcement-btn'),
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
    dom, header,
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
  assert.equal(document.getElementById('playbook-enforcement-select'), null,
    'the three-level dropdown was replaced, not duplicated — two controls would fight over one field');
});

test('a dead conductor cannot have its enforcement changed', async () => {
  const t = await setup();
  for (const status of ['exited', 'crashed']) {
    t.show({ ...CONDUCTOR, status, playbookEnforcement: 'enforce' });
    assert.equal(t.dom.playbookEnforcementBtn.hidden, true, `hidden for a ${status} conductor`);
  }
});
