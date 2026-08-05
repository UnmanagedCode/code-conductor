// The playbook-enforcement <select> in the controls row.
//
// It governs the CONDUCTOR's own tool calls, so it is meaningless on any other
// session — a visible control that does nothing is worse than an absent one.
// Modelled on #mode-select rather than the autoApprovePlan toggle: three states,
// rendered from state (never optimistic), with the `status` frame authoritative.
//
// Same harness as tests/header-mute.test.mjs — the real index.html into
// happy-dom so `dom` matches app.js's wiring, then the real installHeader()
// driven with fake instance state. This file covers the RENDER side only; the
// `change` listener that forwards to send() lives in app.js and is not reached by
// any test in this repo (it is pure delegation, deliberately — see app.js).

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
    playbookEnforcementSelect: document.getElementById('playbook-enforcement-select'),
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
const CONDUCTOR = { ...WORKER, id: 'inst-2', sessionId: 'sess-2', project: '.conduct', playbookEnforcement: 'off' };

test('the control is hidden for an ordinary session and shown for a conductor', async () => {
  const t = await setup();

  t.show(WORKER);
  assert.equal(t.dom.playbookEnforcementSelect.hidden, true,
    'enforcement is meaningless off a conductor, so the control must not appear');
  assert.equal(t.dom.playbookEnforcementSelect.disabled, true);

  t.show(CONDUCTOR);
  assert.equal(t.dom.playbookEnforcementSelect.hidden, false);
  assert.equal(t.dom.playbookEnforcementSelect.disabled, false);
});

test('the control renders the conductor\'s current level, and re-renders when it changes', async () => {
  const t = await setup();

  t.show({ ...CONDUCTOR, playbookEnforcement: 'enforce' });
  assert.equal(t.dom.playbookEnforcementSelect.value, 'enforce',
    'the current level must be readable without interaction — that is the whole point of the control');

  // A `status` frame changes the mirrored value; update() must follow it rather
  // than keep whatever the user last picked (the control is not optimistic).
  t.show({ ...CONDUCTOR, playbookEnforcement: 'warn' });
  assert.equal(t.dom.playbookEnforcementSelect.value, 'warn');

  // A conductor from before this field existed has no value; default to the safe
  // level rather than rendering blank.
  const legacy = { ...CONDUCTOR };
  delete legacy.playbookEnforcement;
  t.show(legacy);
  assert.equal(t.dom.playbookEnforcementSelect.value, 'off');
});

test('the control offers exactly the three enforcement levels', async () => {
  const t = await setup();
  const values = [...t.dom.playbookEnforcementSelect.querySelectorAll('option')].map(o => o.value);
  assert.deepEqual(values, ['off', 'warn', 'enforce'],
    'the options are the server-side allow-list (PLAYBOOK_ENFORCEMENT_MODES); a fourth would be refused');
});

test('the control is a sibling of #mode-select in the controls row', async () => {
  const t = await setup();
  assert.equal(t.dom.playbookEnforcementSelect.parentElement?.id, 'instance-controls',
    'it belongs beside #mode-select, not in the ⋮ overflow panel where its current value would be hidden');
});

test('a dead conductor cannot have its enforcement changed', async () => {
  const t = await setup();
  for (const status of ['exited', 'crashed']) {
    t.show({ ...CONDUCTOR, status, playbookEnforcement: 'enforce' });
    assert.equal(t.dom.playbookEnforcementSelect.hidden, true, `hidden for a ${status} conductor`);
  }
});
