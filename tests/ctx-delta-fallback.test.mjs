// Card 2026-0195 — the ctx chip's `message_delta.usage` fallback, end to end.
//
// A backend whose gateway reports {input_tokens:0, output_tokens:0} on EVERY
// message_start latched nothing (card 2026-0185 floors an all-zero block to
// null), so a fresh session read `ctx —` for its whole life. The real prompt
// size rides the same stream on message_delta.usage, which the parser used to
// discard unconditionally.
//
// tests/parser.test.mjs (T1–T6) pins the parser's arming state machine. This
// file pins the four consumers downstream of it: the server latch, the client
// latch, the rendered chip, and the wsRouter refresh — plus one full-spawn
// scenario run through all of them.
//
// The two invariants the plan flags as traps, pinned here rather than left to
// convention: the delta reading must NOT enter cross-turn cache-miss
// bookkeeping (T8), and turn_end.usage must NEVER become a context reading —
// it is a per-turn SUM, the `ctx 743%` bug (T9 server, T10 client).

import { test } from 'node:test';
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
import { bootServer, api, waitFor } from './helpers.mjs';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const PUB = path.resolve(__dirname, '..', 'public');
const MODEL = 'deepseek-v4-flash';

// The real prompt size such a backend puts on message_delta: 60k over a 200k
// window ⇒ 30%.
const DELTA_USAGE = {
  input_tokens: 12_000,
  cache_read_input_tokens: 40_000,
  cache_creation_input_tokens: 8_000,
  output_tokens: 110,
};
// The per-turn SUM shape that must never reach the reading.
const HUGE_TURN_USAGE = { input_tokens: 900, output_tokens: 4000, cache_read_input_tokens: 7_400_000 };

// ── server half: Instance driven by synthetic stream-json lines ─────────────
// Same no-subprocess pattern as tests/cache-miss-detection.test.mjs.

function msgStartLine({ id = 'msg', model = MODEL, usage = { input_tokens: 0, output_tokens: 0 } } = {}) {
  return JSON.stringify({
    type: 'stream_event',
    event: { type: 'message_start', message: { id, role: 'assistant', model, usage } },
  });
}
function msgDeltaLine(usage) {
  return JSON.stringify({
    type: 'stream_event',
    event: { type: 'message_delta', delta: { stop_reason: 'end_turn', stop_sequence: null }, usage },
  });
}
function resultLine({ usage = { input_tokens: 0, output_tokens: 0 } } = {}) {
  return JSON.stringify({
    type: 'result', subtype: 'success', stop_reason: 'end_turn',
    duration_ms: 10, total_cost_usd: 0.0001, is_error: false, usage,
  });
}

async function makeInstance() {
  const cwd = await fs.mkdtemp(path.join(os.tmpdir(), 'cc-ctx-delta-'));
  const inst = new Instance({
    id: 'inst-1', project: 'demo', cwd, mode: 'bypassPermissions',
    effort: 'medium', thinking: 'medium', model: MODEL,
  });
  inst.sessionId = 'sess-1';
  const events = [];
  inst.on('event', (ev) => events.push(ev));
  return { inst, events, cwd };
}

// T7 — criterion 1, server half: the latch clause in _emitUi.
test('T7: a zero-sum message_start followed by a real message_delta latches lastContextUsage', async () => {
  const { inst, cwd } = await makeInstance();
  try {
    inst._handleStdoutLine(msgStartLine({ id: 'm1' }));
    assert.equal(inst.lastContextUsage, null, 'the all-zero block alone latches nothing');
    inst._handleStdoutLine(msgDeltaLine(DELTA_USAGE));
    assert.deepEqual(inst.lastContextUsage, DELTA_USAGE,
      'the delta reading must reach the server latch, or a re-subscribe still shows `ctx —`');
  } finally { await fs.rm(cwd, { recursive: true, force: true }); }
});

// T8 — the idle→turn flip survives (never `return []` on a zero-sum
// message_start), AND the delta's cache numbers stay out of cache-miss
// bookkeeping. This is what kills the "reuse kind:'message_start'" design.
test('T8: the turn flip survives and the delta never enters cache-miss bookkeeping', async () => {
  const { inst, events, cwd } = await makeInstance();
  try {
    inst._handleStdoutLine(msgStartLine({ id: 'm1' }));
    assert.equal(inst.status, 'turn', 'the zero-sum message_start still flips idle→turn');
    inst._handleStdoutLine(msgDeltaLine(DELTA_USAGE));
    inst._handleStdoutLine(resultLine());
    const te = events.filter(e => e.kind === 'turn_end').at(-1);
    assert.equal(te.firstReqCacheRead, 0, 'the delta\'s cache_read must not be counted as a request prefix');
    assert.equal(te.firstReqCacheCreation, 0);
    assert.equal(te.cacheMiss, false, 'a fabricated creation>read verdict would flag a spurious miss');

    // The double-count is only OBSERVABLE a turn later: a delta counted as a
    // request would latch its 48k as this turn's last prefix P, and turn 2's
    // genuine 0/0 read would then look like a full eviction of it.
    inst._handleStdoutLine(msgStartLine({ id: 'm2' }));
    inst._handleStdoutLine(msgDeltaLine(DELTA_USAGE));
    inst._handleStdoutLine(resultLine());
    assert.equal(events.filter(e => e.kind === 'system' && e.subtype === 'cache_miss').length, 0,
      'no turn may see a spurious cross-turn eviction — the delta is not a request');
    assert.equal(events.filter(e => e.kind === 'turn_end').at(-1).cacheMiss, false);
  } finally { await fs.rm(cwd, { recursive: true, force: true }); }
});

// T9 — criterion 4, server half.
test('T9: a usage-bearing turn_end never overwrites a delta-sourced reading', async () => {
  const { inst, cwd } = await makeInstance();
  try {
    inst._handleStdoutLine(msgStartLine({ id: 'm1' }));
    inst._handleStdoutLine(msgDeltaLine(DELTA_USAGE));
    inst._handleStdoutLine(resultLine({ usage: HUGE_TURN_USAGE }));
    assert.deepEqual(inst.lastContextUsage, DELTA_USAGE,
      'turn_end.usage is a per-turn SUM — latching it is the ctx 743% bug');
  } finally { await fs.rm(cwd, { recursive: true, force: true }); }
});

// ── client half: UsageTracker ───────────────────────────────────────────────

// T10 — criterion 4, client half: the clause latches the reading, and a
// following per-turn SUM does not clobber it.
//
// It does NOT pin the clause's placement relative to the cum.* accumulator:
// that accumulator is itself `if (ev.kind === 'turn_end')`-guarded, so no
// context_usage reaches it wherever this clause sits. The two cum.* assertions
// below are documentation of that, not a mutation pin — they cannot fail.
test('T10: UsageTracker latches context_usage as the reading, and turn_end does not clobber it', () => {
  const t = new UsageTracker();
  t.apply({ kind: 'context_usage', usage: DELTA_USAGE });
  assert.equal(t.currentContextSize(), 60_000);
  assert.equal(t.cum.turns, 0, 'context_usage is not a turn');
  assert.equal(t.cum.inputTokens, 0, 'context_usage must not fall through into the cum accumulator');

  t.apply({ kind: 'turn_end', usage: HUGE_TURN_USAGE });
  assert.equal(t.currentContextSize(), 60_000, 'turn_end must not clobber the reading');
  assert.equal(t.cum.turns, 1, 'turn_end still accumulates, as before');
});

// T11 — the `&& ev.usage` guard: a null block must leave a good reading alone.
test('T11: a null-usage context_usage leaves an existing reading intact', () => {
  const t = new UsageTracker();
  t.apply({ kind: 'message_start', usage: { input_tokens: 46_398 } });
  t.apply({ kind: 'context_usage', usage: null });
  assert.equal(t.currentContextSize(), 46_398);
});

// ── the rendered chip (happy-dom + the real installHeader) ──────────────────
// Same harness as tests/header-ctx-chip.test.mjs, extended to apply a SEQUENCE
// of usage events (the fallback needs two).

async function setupHeader() {
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
    'summarize-session-btn', 'rename-session-btn', 'change-model-btn', 'session-stats-btn',
    'prune-session-btn', 'auto-approve-plan-btn', 'playbook-enforcement-btn',
    'overflow-menu', 'overflow-toggle', 'overflow-panel'];
  const camel = (s) => s.replace(/-([a-z])/g, (_, c) => c.toUpperCase());
  const dom = {};
  for (const id of ids) {
    dom[camel(id)] = document.getElementById(id);
    assert.ok(dom[camel(id)], `dom.${camel(id)} must resolve to a real element from index.html`);
  }
  dom.composerInput = document.getElementById('composer-input');
  dom.tiUsageSlot = document.getElementById('ti-usage-slot');

  const { installHeader } = await import(pathToFileURL(path.join(PUB, 'header.js')).href + `?t=ctxdelta`);
  const usageByInstance = new Map();
  const getUsage = (id) => {
    if (!usageByInstance.has(id)) usageByInstance.set(id, new UsageTracker());
    return usageByInstance.get(id);
  };
  let instances = [];
  const header = installHeader({
    dom,
    getActiveId: () => 'inst-1',
    getInstances: () => instances,
    setActiveStatus: () => {},
    setActiveMode: () => {},
    getUsage,
    globalRLTracker: new RateLimitTracker(),
    getAccountUsage: () => null,
    getAccountUsageStale: () => false,
    composer: { disable() {}, set() {} },
    conversation: { setUserActionsEnabled() {} },
  });
  return { dom, header, getUsage, setInstances: (v) => { instances = v; } };
}

const BASE_INSTANCE = {
  id: 'inst-1', sessionId: 'sess-1', status: 'idle', mode: 'bypassPermissions',
  model: MODEL, project: 'demo', title: null, worktree: null, autoApprovePlan: false,
  interrupting: false, debug: false, backend: 'opencode-go', contextWindowTokens: 200_000,
};

async function renderChip(instance, usageEvents) {
  const h = await setupHeader();
  h.setInstances([{ ...BASE_INSTANCE, ...instance }]);
  for (const ev of usageEvents) h.getUsage('inst-1').apply(ev);
  h.header.update();
  const chip = h.dom.tiUsageSlot.querySelector('.ih-combined');
  assert.ok(chip, 'combined chip must render into the usage slot');
  return chip;
}

// T12 — criterion 3: with no reading at all, the chip stays `ctx —`. Any `?? 0`
// default would fabricate `ctx 0% · 0/200k`.
test('T12: null blocks from both sources leave the chip at `ctx —`', async () => {
  const chip = await renderChip({}, [
    { kind: 'message_start', usage: null },
    { kind: 'context_usage', usage: null },
  ]);
  assert.match(chip.textContent, /^ctx —/, `expected \`ctx —\`, got ${JSON.stringify(chip.textContent)}`);
  assert.ok(chip.title.startsWith('Context usage appears after the first turn.'),
    `expected the no-reading tooltip, got ${JSON.stringify(chip.title)}`);
});

// T13 — criteria 1 + 5 through the real renderer: the fallback reading, and the
// window denominator still resolved from the instance's server-tagged model.
test('T13: the delta reading renders a real percentage against the instance window', async () => {
  const chip = await renderChip({}, [
    { kind: 'message_start', usage: null },
    { kind: 'context_usage', usage: DELTA_USAGE },
  ]);
  assert.match(chip.textContent, /^ctx 30% · 60k\/200k/,
    `expected \`ctx 30% · 60k/200k\`, got ${JSON.stringify(chip.textContent)}`);
  assert.ok(chip.title.includes('Context: 60,000/200,000 tokens'),
    `expected the used/window tooltip, got ${JSON.stringify(chip.title)}`);
});

// ── wsRouter: the chip must refresh on the new kind ─────────────────────────

// T14 — without context_usage in the refresh list the number lands in the
// tracker but the chip lags until the next turn_end.
test('T14: a live context_usage frame refreshes the header chip', () => {
  const noop = () => {};
  globalThis.window ??= { addEventListener: noop };
  let updates = 0;
  installWsRouter({
    state: { activeId: 'inst-A', instances: [] },
    getTracker: () => ({ completedBatches: [], reset: noop, seedActive: noop, apply: noop }),
    getUsage: () => ({ reset: noop, apply: noop }),
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
  const before = updates;
  bus.dispatchEvent(new CustomEvent('event', {
    detail: { id: 'inst-A', ev: { kind: 'context_usage', msgId: 'm1', usage: DELTA_USAGE } },
  }));
  assert.ok(updates > before, 'context_usage must be in the header-refresh list');
});

// ── T15: the whole server chain through a real spawn ───────────────────────
// parser gate → _emitUi latch → wsHub snapshot field, over a scenario whose
// message_start is all-zero and whose message_delta carries the real numbers.

// Prompts go over the WS, not REST (see tests/ws.test.mjs).
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

test('T15: a zero-usage-backend spawn reports the delta reading on the WS snapshot', async () => {
  const ctx = await bootServer({ scenarioPath: path.join(__dirname, 'fixtures', 'scenario-zero-usage-delta.json') });
  const { baseUrl, wsUrl, instances, close } = ctx;
  let driver = null, joiner = null;
  try {
    await api(baseUrl, 'POST', '/api/projects', { name: 'a' });
    const created = await api(baseUrl, 'POST', '/api/instances', { project: 'a', mode: 'bypassPermissions' });
    const id = created.body.id;
    await waitFor(() => instances.get(id).status === 'idle' && instances.get(id).sessionId);

    driver = await wsClient(wsUrl);
    driver.send({ t: 'subscribe', id });
    await driver.wait(m => m.t === 'snapshot' && m.id === id);
    driver.send({ t: 'prompt', id, text: 'go' });
    await driver.wait(m => m.t === 'event' && m.ev?.kind === 'turn_end');

    // The live frame reaches an already-subscribed client…
    const live = await driver.wait(m => m.t === 'event' && m.ev?.kind === 'context_usage');
    assert.deepEqual(live.ev.usage, DELTA_USAGE);

    // …and a client joining afterwards is seeded from the snapshot FIELD.
    joiner = await wsClient(wsUrl);
    joiner.send({ t: 'subscribe', id });
    const snap = await joiner.wait(m => m.t === 'snapshot' && m.id === id);
    assert.deepEqual(snap.lastContextUsage, DELTA_USAGE,
      'the delta reading must survive the whole chain to the snapshot field');
    assert.ok(!snap.events.some(e => e.kind === 'context_usage'),
      'context_usage is declined by EventLog.push — it is a field, not history');
  } finally {
    if (driver) await driver.close();
    if (joiner) await joiner.close();
    await close();
  }
});
