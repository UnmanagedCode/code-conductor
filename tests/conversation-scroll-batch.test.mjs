// Layout-read budget of the stick-to-bottom snap. Replaying N events in one task
// must force one layout per scroll container (Conversation.batchScroll), while
// the end state — and the live per-event behaviour — stays what a per-event snap
// produces.
//
// happy-dom lays nothing out, so scrollHeight/scrollTop are overridden on the
// element prototype (as tests/sticky-prompt.test.mjs does): scrollHeight counts
// its reads per element and returns 100 * childElementCount, a stand-in that
// grows with every append; scrollTop is a plain per-element store, so no
// happy-dom scroll event can fire and add reads of its own. The read count is
// the forced-layout proxy.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { Window } from 'happy-dom';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const PUB = path.resolve(__dirname, '..', 'public');
const noop = () => {};

const window = new Window({ url: 'http://localhost/' });
globalThis.window = window;
globalThis.document = window.document;
globalThis.HTMLElement = window.HTMLElement;
globalThis.Element = window.Element;
globalThis.Node = window.Node;

const reads = new Map(); // element -> scrollHeight reads
const tops = new WeakMap();
Object.defineProperty(window.HTMLElement.prototype, 'scrollHeight', {
  configurable: true,
  get() { reads.set(this, (reads.get(this) ?? 0) + 1); return 100 * this.childElementCount; },
});
Object.defineProperty(window.HTMLElement.prototype, 'scrollTop', {
  configurable: true,
  get() { return tops.get(this) ?? 0; },
  set(v) { tops.set(this, v); },
});
const bottom = (el) => 100 * el.childElementCount;
const readsOf = (el) => reads.get(el) ?? 0;

const { Conversation } = await import(pathToFileURL(path.join(PUB, 'conversation.js')).href);
const { installWsRouter } = await import(pathToFileURL(path.join(PUB, 'wsRouter.js')).href);
const { bus } = await import(pathToFileURL(path.join(PUB, 'ws.js')).href);

document.body.innerHTML = '<div id="conversation"></div>';
const conversationEl = document.getElementById('conversation');
const conversation = new Conversation(conversationEl, {});
const state = { activeId: 'I', instances: [] };

// ws.js's bus is a module singleton: install the router once for the file.
installWsRouter({
  state,
  getTracker: () => ({ completedBatches: [], reset: noop, seedActive: noop, apply: noop }),
  getUsage: () => ({ reset: noop, apply: noop, seedContext: noop }),
  globalRLTracker: { apply: noop },
  conversation,
  headerHandle: { update: noop },
  lazyController: { init: noop, reset: noop },
  sessionActions: { resumeSession: async () => {} },
  composer: { prefill: noop },
  sidebar: { setInstances: noop },
  subagentPanel: { setInstances: noop },
  refreshProjects: async () => {},
  refreshInstances: async () => {},
  selectInstance: noop,
  setSidebarStatus: noop,
});

let seq = 0;
const raw = () => ({ kind: 'raw', line: `line ${seq}`, _seq: ++seq });

// Raw lines, one text block, an Agent head and child text blocks routed into its
// sub-conversation panel.
function fixture() {
  const evs = [];
  for (let i = 0; i < 20; i++) evs.push(raw());
  for (const t of ['a', 'b', 'c']) evs.push({ kind: 'text_delta', msgId: 'm1', blockIdx: 0, text: t, _seq: ++seq });
  evs.push({ kind: 'text_end', msgId: 'm1', blockIdx: 0, _seq: ++seq });
  evs.push({ kind: 'tool_use', toolUseId: 'A', name: 'Agent', input: {}, parentToolUseId: null, _seq: ++seq });
  for (let i = 0; i < 6; i++) {
    evs.push({ kind: 'text_delta', msgId: `c${i}`, blockIdx: 0, text: 'child', parentToolUseId: 'A', _seq: ++seq });
    evs.push({ kind: 'text_end', msgId: `c${i}`, blockIdx: 0, parentToolUseId: 'A', _seq: ++seq });
  }
  return evs;
}

const replay = (type, events = fixture()) => {
  bus.dispatchEvent(new CustomEvent(type, { detail: { id: 'I', events } }));
  return events;
};

test('a snapshot replay reads each scroll root\'s scrollHeight at most once', () => {
  replay('snapshot');
  // The clear() inside the handler resets stickyBottom; reads were counted from
  // before it, so reset-then-replay once more with a clean counter.
  reads.clear();
  replay('snapshot');
  assert.equal(readsOf(conversationEl), 1);
  assert.ok(conversation.subConvs.get('A'), 'the sub-agent panel was rendered');
  for (const [el, n] of reads) assert.ok(n <= 1, `${el.className || el.tagName} read ${n} times`);
});

test('a reset_snapshot replay reads each scroll root\'s scrollHeight at most once', () => {
  reads.clear();
  replay('reset_snapshot');
  assert.equal(readsOf(conversationEl), 1);
  assert.ok(conversation.subConvs.get('A'), 'the sub-agent panel was rendered');
  for (const [el, n] of reads) assert.ok(n <= 1, `${el.className || el.tagName} read ${n} times`);
});

test('a snapshot replay leaves the transcript at the bottom, synchronously', () => {
  replay('snapshot');
  assert.equal(conversationEl.scrollTop, bottom(conversationEl));
  assert.ok(conversationEl.childElementCount > 0);
  const subBody = conversation.toolBlocks.get('A').subBody;
  assert.ok(subBody.childElementCount > 0, 'the panel holds the child blocks');
  assert.equal(subBody.scrollTop, bottom(subBody));
});

test('live event frames stay stuck to the bottom synchronously', () => {
  replay('snapshot');
  for (let i = 0; i < 3; i++) {
    bus.dispatchEvent(new CustomEvent('event', { detail: { id: 'I', ev: raw() } }));
    assert.equal(conversationEl.scrollTop, bottom(conversationEl), `after live event ${i}`);
  }
});

test('a scrolled-up view stays put across live events', () => {
  replay('snapshot');
  conversation.stickyBottom = false;
  conversationEl.scrollTop = 123;
  reads.clear();
  for (let i = 0; i < 3; i++) bus.dispatchEvent(new CustomEvent('event', { detail: { id: 'I', ev: raw() } }));
  assert.equal(conversationEl.scrollTop, 123);
  assert.equal(readsOf(conversationEl), 0);
  conversation.stickyBottom = true;
});

test('applyEvents renders a page with one scrollHeight read', () => {
  const holder = document.createElement('div');
  const conv = new Conversation(holder, {});
  reads.clear();
  conv.applyEvents(fixture());
  assert.ok(holder.childElementCount > 0);
  assert.ok(readsOf(holder) <= 1, `holder read ${readsOf(holder)} times`);
  for (const [el, n] of reads) assert.ok(n <= 1, `${el.className || el.tagName} read ${n} times`);
});

test('adoptToolBlock replays parked children with one read of the sub panel', () => {
  const holder = document.createElement('div');
  const conv = new Conversation(holder, {});
  for (let i = 0; i < 6; i++) {
    conv.apply({ kind: 'text_delta', msgId: `p${i}`, blockIdx: 0, text: 'kid', parentToolUseId: 'P', _seq: ++seq });
    conv.apply({ kind: 'text_end', msgId: `p${i}`, blockIdx: 0, parentToolUseId: 'P', _seq: ++seq });
  }
  assert.equal(conv.orphanChildEvents.get('P').length, 12, 'children parked');
  const batch = new Conversation(document.createElement('div'), {});
  batch.apply({ kind: 'tool_use', toolUseId: 'P', name: 'Agent', input: {} });
  const block = batch.toolBlocks.get('P');
  reads.clear();
  conv.adoptToolBlock('P', block);
  assert.ok(block.subBody.childElementCount > 0, 'parked children rendered into the panel');
  assert.equal(readsOf(block.subBody), 1);
  assert.equal(block.subBody.scrollTop, bottom(block.subBody));
});

test('batchScroll is re-entrant and releases its hold when the callback throws', async (t) => {
  await t.test('nested batches flush once, at the outermost end', () => {
    const holder = document.createElement('div');
    const conv = new Conversation(holder, {});
    reads.clear();
    conv.batchScroll(() => {
      conv.batchScroll(() => { conv.apply(raw()); conv.apply(raw()); });
      assert.equal(readsOf(holder), 0, 'inner end does not flush');
      conv.apply(raw());
    });
    assert.equal(readsOf(holder), 1);
    assert.equal(holder.scrollTop, bottom(holder));
  });

  await t.test('a throwing callback still flushes and releases the hold', () => {
    const holder = document.createElement('div');
    const conv = new Conversation(holder, {});
    assert.throws(() => conv.batchScroll(() => { conv.apply(raw()); throw new Error('boom'); }), /boom/);
    assert.equal(holder.scrollTop, bottom(holder));
    reads.clear();
    conv.apply(raw());
    assert.equal(readsOf(holder), 1, 'a plain apply snaps synchronously again');
  });
});
