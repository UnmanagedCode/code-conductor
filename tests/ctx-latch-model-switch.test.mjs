// Card 2026-0028 — a mid-session model switch must DROP the ctx reading.
//
// The header chip renders `N% · used/window`. The numerator is a latched
// `usage` object; the denominator is the server-resolved `contextWindowTokens`
// for the session's current model. A switch moves the denominator without
// changing what the numerator measured, so a retained reading renders the OLD
// model's used-token count against the NEW model's window — known-wrong, not
// merely stale. The rule applied is the prune path's (`_skipUsageSeed`,
// consumed in `Instance.loadHistory`): a known-wrong number is worse than
// none, so drop it and read `ctx —` until the next usage-bearing frame.
//
// Four layers, same shape as tests/ctx-delta-fallback.test.mjs: the server
// latch (S1–S7), the client latch (C1–C3), the rendered chip (D1–D2), the real
// wsRouter (R1), plus one server↔client seam over a real WS (W1).
//
// The idle-wake bound a retained `system/model_changed` implies is pinned in
// tests/idle-drain-settle.test.mjs (I1) — it is a characterization test of a
// documented degradation, not a regression test, so it lives with the hub.

import { test, before, after, beforeEach, afterEach } from 'node:test';
import assert from 'node:assert/strict';
import { promises as fs } from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { WebSocket } from 'ws';
import { Window } from 'happy-dom';
import { Instance } from '../src/instances.ts';
import { UsageTracker, RateLimitTracker } from '../public/usage.js';
import { installWsRouter } from '../public/wsRouter.js';
import { bus } from '../public/ws.js';
import { bootServer, api, waitFor, freshProjectsRoot, rmrf } from './helpers.mjs';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const PUB = path.resolve(__dirname, '..', 'public');
const SCENARIO = path.join(__dirname, 'fixtures', 'scenario-instance.json');

const noop = () => {};
// installWsRouter registers a window 'popstate' listener; the happy-dom tests
// below replace this with a real Window, which also satisfies it.
globalThis.window ??= { addEventListener: noop };

const M1 = 'claude-haiku-4-5';   // 200k window, no launch tag
const M2 = 'claude-sonnet-5';    // 1M window, no launch tag
// The catalog adds `[1m]` to this one — the bare/tagged pair S6 needs.
const TAGGED_BARE = 'claude-sonnet-4-6';
const TAGGED = 'claude-sonnet-4-6[1m]';

// 190k. Over M1's 200k window that is 95%; the SAME numerator over M2's 1M
// window is 19% — deliberately asymmetric so a wrong render is unmistakable.
const OLD_USAGE = {
  input_tokens: 10_000,
  cache_read_input_tokens: 180_000,
  cache_creation_input_tokens: 0,
  output_tokens: 120,
};
// 420k — a real measurement taken ON the new model (42% of 1M).
const NEW_USAGE = {
  input_tokens: 20_000,
  cache_read_input_tokens: 400_000,
  cache_creation_input_tokens: 0,
  output_tokens: 90,
};

const modelChanges = (events) =>
  events.filter(e => e.kind === 'system' && e.subtype === 'model_changed');

// ── server half: a bare Instance driven by synthetic stream-json lines ──────

function msgStartLine({ id = 'msg', model, usage }) {
  const message = { id, role: 'assistant', usage };
  if (model) message.model = model;
  return JSON.stringify({ type: 'stream_event', event: { type: 'message_start', message } });
}
// session_id matches the instance's backing id, so this is a plain re-report
// rather than a `/clear` rotation.
const initLine = (model) =>
  JSON.stringify({ type: 'system', subtype: 'init', session_id: 'sess-1', model });

async function makeInstance({ model = M1, backend } = {}) {
  const cwd = await fs.mkdtemp(path.join(os.tmpdir(), 'cc-ctx-switch-'));
  const inst = new Instance({
    id: 'inst-1', project: 'demo', cwd, mode: 'bypassPermissions',
    effort: 'medium', thinking: 'medium', model,
    ...(backend ? { backend } : {}),
  });
  inst.sessionId = 'sess-1';
  inst.backingSessionId = 'sess-1';
  const events = [];
  inst.on('event', (ev) => events.push(ev));
  return { inst, events, cwd };
}

// S1 — AC2, the `_trackModel` site. The fixture drives `system/init`, NOT
// `message_start`: an init carries no usage, so nothing re-latches and the
// clear is observable on its own.
test('S1: a system/init reporting a different model drops the latched reading', async () => {
  const { inst, events, cwd } = await makeInstance();
  try {
    inst._handleStdoutLine(msgStartLine({ id: 'm1', model: M1, usage: OLD_USAGE }));
    assert.deepEqual(inst.lastContextUsage, OLD_USAGE, 'premise: a reading is latched before the switch');

    inst._handleStdoutLine(initLine(M2));
    assert.equal(inst.model, M2, 'premise: the init is a real switch, not a re-report');
    assert.equal(inst.lastContextUsage, null,
      'the old model\'s used-token count must not survive into the new model\'s window');
    assert.equal(modelChanges(events).length, 1, 'the switch is announced exactly once');
  } finally { await fs.rm(cwd, { recursive: true, force: true }); }
});

// S2 — the ORDERING invariant. `_trackModel` runs BEFORE the per-event loop's
// single `_emitUi(ev)`, so a switch frame that also carries usage re-latches
// the NEW model's own reading in the same line and the chip never flashes
// `ctx —`. A clear placed after the emit would land `null` here.
test('S2: a usage-bearing switch frame re-latches its own reading, and announces first', async () => {
  const { inst, events, cwd } = await makeInstance();
  try {
    inst._handleStdoutLine(msgStartLine({ id: 'm1', model: M1, usage: OLD_USAGE }));
    const mark = events.length;

    inst._handleStdoutLine(msgStartLine({ id: 'm2', model: M2, usage: NEW_USAGE }));
    assert.equal(inst.model, M2, 'premise: the frame is a real switch');
    assert.deepEqual(inst.lastContextUsage, NEW_USAGE,
      'the switch frame\'s own measurement must survive the clear — no `ctx —` flash');

    const kinds = events.slice(mark).map(e => e.kind === 'system' ? `system/${e.subtype}` : e.kind);
    assert.deepEqual(kinds, ['system/model_changed', 'message_start'],
      'the announce must precede the frame that re-latches, so live and snapshot-replay agree');
  } finally { await fs.rm(cwd, { recursive: true, force: true }); }
});

// S3 — `_trackModel`'s ELSE arm is silent adoption (the model was unknown; a
// resume whose model couldn't be recovered). Discovery, not a switch: the
// latch may hold the jsonl seed `loadHistory` just emitted, and clearing it
// would strand every such session on `ctx —`.
test('S3: silent model adoption keeps the jsonl seed and announces nothing', async () => {
  const { inst, events, cwd } = await makeInstance({ model: null });
  try {
    inst._emitUi({ kind: 'message_start', replayed: true, usage: OLD_USAGE });
    assert.deepEqual(inst.lastContextUsage, OLD_USAGE, 'premise: the replay seed is latched');

    inst._trackModel(M1);
    assert.equal(inst.model, M1, 'premise: adoption happened');
    assert.deepEqual(inst.lastContextUsage, OLD_USAGE,
      'adoption is discovery — dropping here strands every resumed session on `ctx —`');
    assert.equal(modelChanges(events).length, 0, 'nothing changed from the user\'s view');
  } finally { await fs.rm(cwd, { recursive: true, force: true }); }
});

// S4 — the substitution-backend early return must keep its other
// responsibilities: neither the announce nor the clear may sit above it.
test('S4: a substitution backend reaches neither the announce nor the clear', async () => {
  const { inst, events, cwd } = await makeInstance({ model: 'gemma4:cloud', backend: 'ollama' });
  try {
    assert.equal(inst.backend, 'ollama', 'premise: the backend registry knows this row');
    inst._emitUi({ kind: 'message_start', usage: OLD_USAGE });

    inst._trackModel('other-id');
    assert.equal(inst.model, 'gemma4:cloud', 'the configured registry key is never replaced');
    assert.deepEqual(inst.lastContextUsage, OLD_USAGE, 'an ignored report must not blank the chip');
    assert.equal(modelChanges(events).length, 0);
  } finally { await fs.rm(cwd, { recursive: true, force: true }); }
});

// S7 — retention. The notice must survive a re-subscribe, which is the whole
// reason it is accepted into the ring (and therefore advances `ring.nextSeq`,
// the idle-wake interaction I1 bounds).
test('S7: the model_changed notice is retained in the ring with a _seq', async () => {
  const { inst, events, cwd } = await makeInstance();
  try {
    inst._handleStdoutLine(initLine(M2));
    const [changed] = modelChanges(events);
    assert.ok(changed, 'premise: the switch was announced');
    assert.equal(typeof changed._seq, 'number', 'a declined event gets no _seq');
    assert.ok(inst.ring.toArray().some(e => e === changed),
      'the notice must be in the ring, or a re-subscribing client never sees it');
  } finally { await fs.rm(cwd, { recursive: true, force: true }); }
});

// ── server half: the setModel site, over a booted server ────────────────────

let ctx, baseUrl, wsUrl, instances, home;

before(async () => {
  ctx = await bootServer({ scenarioPath: SCENARIO });
  ({ baseUrl, wsUrl, instances } = ctx);
});
after(async () => { await ctx.close(); });
beforeEach(async () => { ({ home } = await freshProjectsRoot()); });
afterEach(async () => { await instances.shutdown(); await rmrf(home); });

// The scenario's `system/init` reports `claude-sonnet-4-6`, which canonicalizes
// to what we spawn with — so the spawn itself fires no switch.
async function spawnTagged(project) {
  await api(baseUrl, 'POST', '/api/projects', { name: project });
  const r = await api(baseUrl, 'POST', '/api/instances',
    { project, mode: 'bypassPermissions', model: TAGGED_BARE });
  const inst = instances.get(r.body.id);
  await waitFor(() => inst.status === 'idle' && inst.sessionId);
  assert.equal(inst.model, TAGGED, 'premise: the catalog launch tag is applied server-side');
  const events = [];
  inst.on('event', (ev) => events.push(ev));
  inst._emitUi({ kind: 'message_start', msgId: 'm0', usage: OLD_USAGE });
  assert.deepEqual(inst.lastContextUsage, OLD_USAGE, 'premise: a reading is latched');
  return { id: r.body.id, inst, events };
}

// S5 — AC2, the `setModel` site, plus the emit it does not do today.
test('S5: a UI model switch drops the reading and announces the change', async () => {
  const { inst, events } = await spawnTagged('s5');
  await inst.setModel(M2);
  assert.equal(inst.model, M2, 'premise: the switch went through');
  assert.equal(inst.lastContextUsage, null,
    'the UI switch moves the denominator, so the retained numerator must go');
  const changes = modelChanges(events);
  assert.equal(changes.length, 1, 'exactly one notice');
  assert.deepEqual(changes[0].data, { from: TAGGED, to: M2 });
});

// S6 — the no-op re-select guard. The picker highlights the tier the session
// is already on, so re-selecting it must emit no notice and blank no chip. The
// bare-vs-tagged fixture is what separates a canonical compare from a raw one:
// the client sends `claude-sonnet-4-6`, the session runs `claude-sonnet-4-6[1m]`.
test('S6: re-selecting the running tier changes nothing', async () => {
  const { inst, events } = await spawnTagged('s6');
  await inst.setModel(TAGGED_BARE);
  assert.equal(inst.model, TAGGED);
  assert.deepEqual(inst.lastContextUsage, OLD_USAGE,
    'a raw-string compare false-positives here and blanks a chip nothing invalidated');
  assert.equal(modelChanges(events).length, 0, 'no notice for a non-change');
});

// ── server↔client seam over a real WS ───────────────────────────────────────

async function wsClient(url) {
  const ws = new WebSocket(url);
  const messages = [];
  ws.on('message', (raw) => { try { messages.push(JSON.parse(raw.toString())); } catch { /* non-JSON */ } });
  await new Promise((res, rej) => { ws.once('open', res); ws.once('error', rej); });
  return {
    send: (o) => ws.send(JSON.stringify(o)),
    wait: (pred) => waitFor(() => messages.find(pred), { timeout: 4000 }),
    close: () => new Promise(r => { ws.once('close', r); ws.close(); }),
  };
}

// W1 — the whole chain: the switch reaches an already-subscribed client as a
// frame, and blanks the snapshot FIELD a later subscriber is seeded from.
// Both closes are in `finally`: wsClient.close() resolves on a 'close' event,
// so a skipped close turns a one-line diff into a teardown timeout.
test('W1: a switch reaches a live client and blanks a later joiner\'s snapshot seed', async () => {
  const { id, inst } = await spawnTagged('w1');
  let a = null, b = null;
  try {
    a = await wsClient(wsUrl);
    a.send({ t: 'subscribe', id });
    const snapA = await a.wait(m => m.t === 'snapshot' && m.id === id);
    assert.deepEqual(snapA.lastContextUsage, OLD_USAGE, 'premise: the field carries the reading');

    a.send({ t: 'model', id, model: M2, reqId: 'r1' });
    const changed = await a.wait(m => m.t === 'event'
      && m.ev?.kind === 'system' && m.ev?.subtype === 'model_changed');
    assert.equal(changed.ev.data.to, M2, 'the live client is told which model it is now on');
    await waitFor(() => inst.model === M2);

    b = await wsClient(wsUrl);
    b.send({ t: 'subscribe', id });
    const snapB = await b.wait(m => m.t === 'snapshot' && m.id === id);
    assert.ok(snapB.lastContextUsage == null,
      `a joiner after the switch must not be seeded with the old model's reading, got ${JSON.stringify(snapB.lastContextUsage)}`);
  } finally {
    if (a) await a.close();
    if (b) await b.close();
  }
});

// ── client half: UsageTracker (pure, no DOM) ────────────────────────────────

// C1 — AC1. The second assertion stops a "fix" that drops the reading by
// deleting the clause the model flip lives in.
test('C1: model_changed drops the reading and adopts the new model', () => {
  const t = new UsageTracker();
  t.apply({ kind: 'message_start', model: M1, usage: OLD_USAGE });
  assert.equal(t.currentContextSize(), 190_000, 'premise');

  t.apply({ kind: 'system', subtype: 'model_changed', data: { from: M1, to: M2 } });
  assert.equal(t.currentContextSize(), null,
    'the reading measured the old model — it cannot be rendered against the new window');
  assert.equal(t.effectiveModel(), M2, 'the model flip must survive the drop');
});

// C2 — the drop is `lastUsage = null`, never `reset()`: reset() also blanks
// cum.*, which backs the session-totals popover. Those totals are genuinely
// cumulative session work and a model switch does not invalidate them.
test('C2: the drop leaves the cumulative session totals alone', () => {
  const t = new UsageTracker();
  t.apply({ kind: 'message_start', model: M1, usage: OLD_USAGE });
  t.apply({ kind: 'turn_end', usage: { input_tokens: 5, output_tokens: 7 }, costDelta: 0.5, durationMs: 1000 });
  t.apply({ kind: 'turn_end', usage: { input_tokens: 5, output_tokens: 7 }, costDelta: 0.5, durationMs: 1000 });
  const cum = { ...t.cum };

  t.apply({ kind: 'system', subtype: 'model_changed', data: { from: M1, to: M2 } });
  assert.equal(t.currentContextSize(), null);
  assert.deepEqual(t.cum, cum, 'a switch invalidates the reading, not the session\'s work');
  assert.equal(t.cum.turns, 2);
});

// C3 — the drop is not sticky, and BOTH usage-bearing kinds re-latch (a fix
// that special-cases only message_start leaves the fallback backend blank).
test('C3: the next usage-bearing frame of either kind restores the reading', () => {
  const viaMessageStart = new UsageTracker();
  viaMessageStart.apply({ kind: 'message_start', model: M1, usage: OLD_USAGE });
  viaMessageStart.apply({ kind: 'system', subtype: 'model_changed', data: { from: M1, to: M2 } });
  viaMessageStart.apply({ kind: 'message_start', model: M2, usage: NEW_USAGE });
  assert.equal(viaMessageStart.currentContextSize(), 420_000, 'message_start re-latches');

  const viaContextUsage = new UsageTracker();
  viaContextUsage.apply({ kind: 'message_start', model: M1, usage: OLD_USAGE });
  viaContextUsage.apply({ kind: 'system', subtype: 'model_changed', data: { from: M1, to: M2 } });
  viaContextUsage.apply({ kind: 'context_usage', usage: NEW_USAGE });
  assert.equal(viaContextUsage.currentContextSize(), 420_000, 'the fallback kind re-latches too');
});

// ── the rendered chip (happy-dom + the real installHeader) ──────────────────

async function headerFixture() {
  const html = await fs.readFile(path.join(PUB, 'index.html'), 'utf8');
  const window = new Window({ url: 'http://localhost/' });
  globalThis.window = window;
  globalThis.document = window.document;
  globalThis.HTMLElement = window.HTMLElement;
  globalThis.Element = window.Element;
  globalThis.Node = window.Node;
  window.document.documentElement.innerHTML = html;
  const document = window.document;

  const ids = ['composer-input', 'mode-select', 'kill-btn', 'mute-btn', 'resume-btn',
    'instance-title', 'turn-indicator', 'ti-left', 'ti-dot', 'ti-label', 'ti-ellipsis',
    'ti-interrupt-now', 'ti-usage-slot', 'sync-btn', 'merge-btn', 'debug-btn',
    'summarize-session-btn', 'rename-session-btn', 'change-model-btn', 'change-effort-btn',
    'session-stats-btn',
    'prune-session-btn', 'auto-approve-plan-btn', 'playbook-enforcement-btn',
    'overflow-menu', 'overflow-toggle', 'overflow-panel'];
  const camel = (s) => s.replace(/-([a-z])/g, (_, c) => c.toUpperCase());
  const dom = {};
  for (const id of ids) {
    dom[camel(id)] = document.getElementById(id);
    assert.ok(dom[camel(id)], `dom.${camel(id)} must resolve to a real element from index.html`);
  }

  const { installHeader } = await import(pathToFileURL(path.join(PUB, 'header.js')).href + `?t=ctxswitch`);
  const usageByInstance = new Map();
  const getUsage = (id) => {
    if (!usageByInstance.has(id)) usageByInstance.set(id, new UsageTracker());
    return usageByInstance.get(id);
  };
  let instances_ = [];
  const header = installHeader({
    dom,
    getActiveId: () => 'inst-1',
    getInstances: () => instances_,
    setActiveStatus: noop,
    setActiveMode: noop,
    getUsage,
    globalRLTracker: new RateLimitTracker(),
    getAccountUsage: () => null,
    getAccountUsageStale: () => false,
    composer: { disable() {}, set() {} },
    conversation: { setUserActionsEnabled() {} },
  });
  const chip = () => {
    header.update();
    const el = dom.tiUsageSlot.querySelector('.ih-combined');
    assert.ok(el, 'combined chip must render into the usage slot');
    return el;
  };
  return { getUsage, chip, setInstance: (v) => { instances_ = [{ ...BASE_INSTANCE, ...v }]; } };
}

const BASE_INSTANCE = {
  id: 'inst-1', sessionId: 'sess-1', status: 'idle', mode: 'bypassPermissions',
  model: M1, project: 'demo', title: null, worktree: null, autoApprovePlan: false,
  interrupting: false, debug: false, backend: 'claude', contextWindowTokens: 200_000,
};

// D1 — the headline: no old-numerator/new-denominator render is ever produced.
// The second phase also moves `contextWindowTokens`, which is what the
// `status` broadcast's `{t:'instances'}` → refreshInstances() round-trip lands.
test('D1: the chip reads `ctx —` after a switch, never the old count over the new window', async () => {
  const h = await headerFixture();
  h.setInstance({ model: M1, contextWindowTokens: 200_000 });
  h.getUsage('inst-1').apply({ kind: 'message_start', model: M1, usage: OLD_USAGE });
  assert.match(h.chip().textContent, /^ctx 95% · 190k\/200k/,
    'premise: a full Haiku session');

  h.getUsage('inst-1').apply({ kind: 'system', subtype: 'model_changed', data: { from: M1, to: M2 } });
  h.setInstance({ model: M2, contextWindowTokens: 1_000_000 });
  const after = h.chip();
  assert.match(after.textContent, /^ctx —/,
    `a retained reading renders \`ctx 19% · 190k/1.0M\` here, got ${JSON.stringify(after.textContent)}`);
  assert.ok(after.title.startsWith('Context usage appears after the first turn.'),
    `expected the no-reading tooltip, got ${JSON.stringify(after.title)}`);
});

// D2 — the client-visible symptom of the over-eager fixes S2 catches
// server-side: a switch frame that carried a measurement must not blank.
test('D2: a switch whose frame carried a measurement renders that measurement', async () => {
  const h = await headerFixture();
  h.setInstance({ model: M1, contextWindowTokens: 200_000 });
  h.getUsage('inst-1').apply({ kind: 'message_start', model: M1, usage: OLD_USAGE });
  h.chip();

  // The server's emit order for a usage-bearing switch frame (see S2).
  h.getUsage('inst-1').apply({ kind: 'system', subtype: 'model_changed', data: { from: M1, to: M2 } });
  h.getUsage('inst-1').apply({ kind: 'message_start', model: M2, usage: NEW_USAGE });
  h.setInstance({ model: M2, contextWindowTokens: 1_000_000 });
  const after = h.chip();
  assert.match(after.textContent, /^ctx 42% · 420k\/1\.0M/,
    `expected the new model's own reading, got ${JSON.stringify(after.textContent)}`);
});

// ── the real wsRouter: live/reload parity ───────────────────────────────────

// R1 drives the real installWsRouter with a REAL UsageTracker. Every other
// wsRouter test stubs getUsage without `seedContext`, so nothing exercises the
// snapshot seed line today; this closes that gap and then pins AC4 — the value
// a live client holds after a switch equals the value a reloading one rebuilds.
test('R1: the live drop and the reload drop agree', () => {
  const usage = new UsageTracker();
  let updates = 0;
  installWsRouter({
    state: { activeId: 'inst-A', instances: [{ id: 'inst-A' }] },
    getTracker: () => ({ completedBatches: [], reset: noop, seedActive: noop, apply: noop }),
    getUsage: () => usage,
    globalRLTracker: new RateLimitTracker(),
    conversation: { clear: noop, reset: noop, apply: noop, _replayMode: false },
    headerHandle: { update: () => { updates += 1; } },
    lazyController: { init: noop, reset: noop },
    sessionActions: { resumeSession: async () => {} },
    composer: { prefill: noop },
    sidebar: { setInstances: noop },
    subagentPanel: { setInstances: noop },
    bumpUnread: noop,
    refreshProjects: async () => {},
    refreshInstances: async () => {},
    selectInstance: noop,
    setSidebarStatus: noop,
  });

  bus.dispatchEvent(new CustomEvent('snapshot', {
    detail: { id: 'inst-A', events: [], lastContextUsage: OLD_USAGE },
  }));
  assert.equal(usage.currentContextSize(), 190_000, 'premise: the snapshot seed lands');

  const before = updates;
  bus.dispatchEvent(new CustomEvent('event', {
    detail: { id: 'inst-A', ev: { kind: 'system', subtype: 'model_changed', data: { from: M1, to: M2 } } },
  }));
  const liveValue = usage.currentContextSize();
  assert.ok(updates > before, 'model_changed must stay in the header-refresh list');

  // What the server now sends a reloading client.
  bus.dispatchEvent(new CustomEvent('snapshot', {
    detail: { id: 'inst-A', events: [], lastContextUsage: null },
  }));
  const reloadValue = usage.currentContextSize();
  assert.equal(reloadValue, null, 'a null seed leaves the rebuilt tracker blank');
  assert.equal(liveValue, reloadValue,
    'a live client and a reloading one must not disagree about the reading');
});
