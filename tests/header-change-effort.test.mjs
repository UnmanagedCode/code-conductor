// The "⚡ Change effort" ⋮-menu item and its level picker.
//
// Effort is chosen at spawn (`--effort`) and was frozen for the process's life;
// this item repoints a LIVE session by sending `/effort <level>` (the control
// protocol has no `set_effort` subtype). Two things that follow from the
// mechanism are pinned here because nothing else would catch them regressing:
//   - it is IDLE-ONLY, like 🪒 Prune — mid-turn the CLI folds the line into the
//     running turn's input instead of running it as a local slash command;
//   - it refuses NO backend, unlike 🧠 Change model — no endpoint is repointed.
//
// Same harness as tests/header-playbook-enforcement.test.mjs: the real
// index.html into happy-dom so `dom` matches app.js's wiring, the real
// installHeader() driven with fake instance state, and the real ws.js send()
// behind a fake WebSocket so the assertions read the frame that actually goes
// on the wire.
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

// The SAME module instance header.js's `import … from './models.js'` resolves
// to (a relative specifier drops the importer's cache-buster query), so the
// catalog these getters see is the one the popover renders from.
const models = await import(pathToFileURL(path.join(PUB, 'models.js')).href);

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
    dom, header, window, document,
    show(inst) { instances = [inst]; activeId = inst.id; header.update(); },
    clear() { instances = []; header.update(); },
    // The picker is appended to <body>, not into the ⋮ panel.
    popover: () => document.querySelector('.ih-usage-popover[aria-label="Change effort"]'),
    levelButtons: () => [...(document.querySelector('.ih-usage-popover[aria-label="Change effort"]')
      ?.querySelectorAll('.qs-model') ?? [])],
  };
}

const LIVE = {
  id: 'inst-1', sessionId: 'sess-1', status: 'idle', mode: 'plan',
  model: 'claude-sonnet-4-6', effort: 'high', project: 'demo', title: null, worktree: null,
  autoApprovePlan: false, interrupting: false, debug: false,
};

test('the item sits in the ⋮ panel directly below Change model', async () => {
  const t = await setup();
  assert.equal(t.dom.changeEffortBtn.parentElement?.id, 'overflow-panel',
    'it belongs in the ⋮ session menu, not the controls row');
  assert.equal(t.dom.changeEffortBtn.previousElementSibling?.id, 'change-model-btn',
    'placed immediately below Change model — the sibling control it mirrors');
  assert.equal(t.dom.changeEffortBtn.getAttribute('role'), 'menuitem');
});

test('the label is static — it never leaks the current level', async () => {
  // The current level shows in ONE place: the popover's .qs-selected highlight.
  // Same deliberate convention as 🧠 Change model.
  for (const effort of [...models.getEffortLevels(), null]) {
    const t = await setup();
    t.show({ ...LIVE, effort });
    assert.equal(t.dom.changeEffortBtn.textContent, '⚡ Change effort',
      `label must be static for effort=${effort}`);
  }
});

test('the item is enabled only between turns', async () => {
  const t = await setup();

  t.show({ ...LIVE, status: 'idle' });
  assert.equal(t.dom.changeEffortBtn.hidden, false);
  assert.equal(t.dom.changeEffortBtn.disabled, false, 'idle is the one state it works in');
  assert.equal(t.dom.changeEffortBtn.title, 'Change how hard this session reasons, without restarting');

  // `turn` and `spawning` are both inside canMenu, so a `!canMenu` gate (what
  // Change model uses) would leave the item live in exactly the states where
  // the CLI would fold the `/effort` line into a turn's input.
  for (const status of ['turn', 'spawning']) {
    t.show({ ...LIVE, status });
    assert.equal(t.dom.changeEffortBtn.hidden, false, `still visible while ${status}`);
    assert.equal(t.dom.changeEffortBtn.disabled, true, `must be disabled while ${status}`);
    assert.equal(t.dom.changeEffortBtn.title, 'Effort can only be changed between turns');
  }

  // No sessionId yet ⇒ nothing to repoint.
  t.show({ ...LIVE, sessionId: null });
  assert.equal(t.dom.changeEffortBtn.disabled, true);
});

test('when the active id has no backing instance, the ⋮ menu is hidden — not left stale-clickable', async () => {
  // The container is the mechanism (same as the sibling item — see
  // tests/header-change-model.test.mjs): the "no instance selected" branch
  // returns before touching the per-item flags, so hiding #overflow-menu is
  // what makes the item unreachable. The click guard is covered separately below.
  const t = await setup();
  t.show(LIVE);
  assert.equal(t.dom.overflowMenu.hidden, false, 'sanity: menu is visible while live');
  assert.equal(t.dom.changeEffortBtn.hidden, false);

  t.clear();
  assert.equal(t.dom.overflowMenu.hidden, true,
    'the ⋮ menu (and therefore Change effort) must hide once the active instance disappears from state');
});

test('clicking the item renders one popover holding the server level catalog, in order', async () => {
  const t = await setup();
  t.show(LIVE);
  assertNull(t.popover(), 'no picker before the click');

  t.dom.changeEffortBtn.click();
  assert.equal(t.document.querySelectorAll('.ih-usage-popover').length, 1, 'exactly one picker');
  assert.deepEqual(t.levelButtons().map(b => b.textContent), [...models.getEffortLevels()],
    'the picker renders the catalog verbatim, in catalog order (low → high) — never a restated list');
  assert.deepEqual(t.levelButtons().map(b => b.dataset.effort), [...models.getEffortLevels()]);
});

test('the picker adopts the level catalog the server ships, not its own fallback', async () => {
  // Pins that loadModelVersions() feeds `efforts` into models.js: a deliberately
  // TRUNCATED payload must shrink the picker. Without the wiring the picker keeps
  // rendering the pre-fetch fallback and this reads five buttons.
  const before = [...models.getEffortLevels()];
  const realFetch = globalThis.fetch;
  globalThis.fetch = async (url) => {
    assert.match(String(url), /\/api\/settings\/models/);
    return { ok: true, json: async () => ({ efforts: ['low', 'max'] }) };
  };
  try {
    await models.loadModelVersions();
    const t = await setup();
    t.show(LIVE);
    t.dom.changeEffortBtn.click();
    assert.deepEqual(t.levelButtons().map(b => b.textContent), ['low', 'max']);
  } finally {
    globalThis.fetch = realFetch;
    models.setEffortLevels(before); // module state is shared by every test in this file
  }
});

test('exactly one level is highlighted: the one the session is running at', async () => {
  const t = await setup();
  for (const effort of models.getEffortLevels()) {
    t.show({ ...LIVE, effort });
    t.dom.changeEffortBtn.click();
    const selected = t.levelButtons().filter(b => b.classList.contains('qs-selected'));
    assert.deepEqual(selected.map(b => b.dataset.effort), [effort],
      `only ${effort} may carry .qs-selected`);
    t.dom.changeEffortBtn.click(); // toggle shut before the next round
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
  return { ...t, sent, effortFrames: () => sent.filter(m => m.t === 'effort') };
}

test('picking a level sends one effort frame and dismisses both the picker and the menu', async () => {
  const t = await clickSetup();
  t.show({ ...LIVE, effort: 'high' });
  // Open the ⋮ panel first — the real path to the item, and the only state in
  // which "the menu is dismissed" is an assertion rather than a tautology.
  t.dom.overflowToggle.click();
  assert.equal(t.dom.overflowPanel.hidden, false, 'sanity: the ⋮ panel is open');

  t.dom.changeEffortBtn.click();
  t.levelButtons().find(b => b.dataset.effort === 'max').click();
  await new Promise(r => setImmediate(r));

  assert.deepEqual(t.effortFrames(), [{ t: 'effort', id: LIVE.id, effort: 'max', reqId: t.effortFrames()[0]?.reqId }],
    'a dedicated `effort` frame — NOT a `prompt` carrying the text "/effort max", which would bypass '
    + 'the server-side level validation and the idle-only refusal');
  assert.ok(t.effortFrames()[0].reqId, 'sent with ack:true, so a refused change surfaces instead of failing silently');
  assertNull(t.popover(), 'the picker closes on a successful pick');
  assert.equal(t.dom.overflowPanel.hidden, true, 'and the ⋮ panel it was opened from does not stay behind it');
});

test('a click with no active instance sends nothing AND throws nothing', async () => {
  // Asserting only "no frame sent" would NOT pin the guard: without
  // `if (currentInst)` the handler dereferences null and rejects, which also
  // sends no frame. happy-dom re-dispatches an async listener's rejection as a
  // window 'error' event, so that is what must be watched.
  const t = await clickSetup();
  const escaped = [];
  const onError = (e) => escaped.push(e.message ?? String(e));
  const onRejection = (e) => escaped.push(e instanceof Error ? e.message : String(e));
  t.window.addEventListener('error', onError);
  process.on('unhandledRejection', onRejection);
  try {
    t.header.update();
    t.dom.changeEffortBtn.click();
    await new Promise(r => setTimeout(r, 20));
    assert.deepEqual(t.effortFrames(), [], 'nothing is sent with no session selected');
    assert.deepEqual(escaped, [], 'the click must return early, not crash on a null instance');
    assertNull(t.popover(), 'and no picker is opened');
  } finally {
    t.window.removeEventListener('error', onError);
    process.off('unhandledRejection', onRejection);
  }
});

test('no level is refused on a substitution backend, and no backend note is shown', async () => {
  // Unlike 🧠 Change model, `/effort` repoints no endpoint: it is a local slash
  // command handled by the same inner CLI every backend runs, and `--effort` is
  // already passed unconditionally at launch. Pasting the model picker's
  // `blocked` logic in here would refuse something that works.
  const t = await clickSetup();
  t.show({ ...LIVE, backend: 'ollama', model: 'llama3:8b' });
  t.dom.changeEffortBtn.click();

  const btns = t.levelButtons();
  assert.equal(btns.length, models.getEffortLevels().length);
  assert.deepEqual(btns.map(b => b.disabled), btns.map(() => false), 'every level stays clickable');
  assertNull(t.popover().querySelector('.ih-usage-popover-note'),
    'no "kill and respawn" note — there is nothing to refuse');

  btns.find(b => b.dataset.effort === 'low').click();
  await new Promise(r => setImmediate(r));
  assert.deepEqual(t.effortFrames().map(m => m.effort), ['low'],
    'and the pick really goes on the wire for a non-Claude backend');
});
