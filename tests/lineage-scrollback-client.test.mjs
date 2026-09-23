// The web client's side of lineage scroll-back (public/lazyHistory.js,
// public/conversation.js): it follows the lineage route's (segment, nextBefore)
// cursor, renders its `segment_seam` dividers, and offers rewind/fork only on a
// bubble whose provenance is the server's current segment.
//
// happy-dom does no layout, so clientHeight/scrollHeight are overridden and
// global.fetch serves canned pages — the setup of tests/lazy-autoload.test.mjs.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { assertNull } from './dom-assert.mjs';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { Window } from 'happy-dom';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const PUB = path.resolve(__dirname, '..', 'public');

async function setupDOM() {
  const window = new Window({ url: 'http://localhost/' });
  globalThis.window = window;
  globalThis.document = window.document;
  globalThis.HTMLElement = window.HTMLElement;
  globalThis.Element = window.Element;
  globalThis.Node = window.Node;
  const conv = await import(pathToFileURL(path.join(PUB, 'conversation.js')).href);
  const lazy = await import(pathToFileURL(path.join(PUB, 'lazyHistory.js')).href);
  document.body.innerHTML = '<div id="conversation"></div>';
  return { conversationEl: document.getElementById('conversation'), ...conv, ...lazy };
}

const OPTIONS = { onRewind: () => {}, onFork: () => {} };
const flush = () => new Promise((r) => setTimeout(r, 0));
const settle = async () => { for (let i = 0; i < 6; i++) await flush(); };

// fetch stub serving `pages` in order; records each request's path + params.
function stubFetch(pages) {
  const calls = [];
  globalThis.fetch = async (url) => {
    const u = new URL(url, 'http://localhost');
    calls.push({ path: u.pathname, params: Object.fromEntries(u.searchParams) });
    const page = pages.shift() ?? { events: [], hasMore: false, segment: null, nextBefore: null };
    return { ok: true, status: 200, json: async () => JSON.parse(JSON.stringify(page)) };
  };
  return calls;
}

// A controller on the live conversation. `scrollHeight` below the viewport
// makes the controller auto-fill until history is exhausted.
function install(dom, { scrollHeight = 0 } = {}) {
  const { conversationEl, Conversation, installLazyHistoryController } = dom;
  Object.defineProperty(conversationEl, 'clientHeight', { configurable: true, get: () => 800 });
  Object.defineProperty(conversationEl, 'scrollHeight', { configurable: true, get: () => scrollHeight });
  const conversation = new Conversation(conversationEl, OPTIONS);
  const controller = installLazyHistoryController({
    conversationEl, conversation, conversationOptions: OPTIONS,
    getActiveId: () => 'inst1', getInstances: () => [{ id: 'inst1', status: 'idle' }],
  });
  return { conversation, controller };
}

let seq = 1000;
const echo = (text, extra = {}) => ({ kind: 'user_echo', text, userIndex: seq % 97, _seq: seq--, parentToolUseId: null, ...extra });
const seam = (segmentId) => ({ kind: 'segment_seam', segmentId });
const gap = () => ({ kind: 'history_gap' });
const page = (events, extra) => ({ events, hasMore: true, segment: null, nextBefore: null, pageSegment: null, currentSegmentId: 'D', ...extra });

function assertLineageRoute(calls) {
  assert.ok(calls.length > 0, 'a request was made');
  for (const c of calls) assert.equal(c.path, '/api/instances/inst1/lineage-events', 'the lineage route');
}

// The conversation's top-level children as tokens: `‖S` divider, `⋯` gap,
// the bubble text for a user message.
function tokens(root) {
  const out = [];
  for (const node of root.children) {
    if (node.classList.contains('segment-seam')) out.push(`‖${node.getAttribute('data-segment-id')}`);
    else if (node.classList.contains('history-gap')) out.push('⋯');
    else if (node.classList.contains('user')) out.push(node.querySelector('.block.text')?.textContent ?? '');
  }
  return out;
}
const hasActions = (bubble) => bubble.querySelector('.user-msg-actions') !== null;
const bubbleByText = (root, text) => [...root.querySelectorAll('.msg.user')].find(b => b.querySelector('.block.text')?.textContent === text);

test('C1 follows the lineage cursor across segment changes, including one whose number is not lower', async () => {
  const dom = await setupDOM();
  const calls = stubFetch([
    page([echo('d old')], { segment: 'C', nextBefore: null }),
    page([echo('c new')], { segment: 'C', nextBefore: 950 }),
    page([echo('c old')], { segment: 'C', nextBefore: 940, hasMore: false }),
  ]);
  const { controller } = install(dom);
  controller.init({ tailStartSeq: 900 });
  await settle();
  assertLineageRoute(calls);
  assert.deepEqual(calls.map(c => c.params), [
    { limit: '200', before: '900' },
    { limit: '200', segment: 'C' },
    { limit: '200', before: '950', segment: 'C' },
  ]);
  assert.deepEqual(tokens(dom.conversationEl), ['c old', 'c new', 'd old']);
});

test('C2 the progress guard: a revisited segment, or a stalled same-segment cursor, ends history', async (t) => {
  await t.test('revisited segment', async () => {
    const dom = await setupDOM();
    const calls = stubFetch([
      page([echo('d old')], { segment: 'C', nextBefore: null }),
      page([echo('c')], { segment: null, nextBefore: 800 }),
      page([echo('never')], { segment: null, nextBefore: 700 }),
    ]);
    const { controller } = install(dom);
    controller.init({ tailStartSeq: 900 });
    await settle();
    assertLineageRoute(calls);
    assert.equal(calls.length, 2, 'the page moving back to a visited segment ends the walk');
    assertNull(dom.conversationEl.querySelector('.history-sentinel'), 'history is exhausted');
  });
  await t.test('stalled cursor', async () => {
    const dom = await setupDOM();
    const calls = stubFetch([
      page([echo('c1')], { segment: 'C', nextBefore: 500 }),
      page([echo('c2')], { segment: 'C', nextBefore: 500 }),
      page([echo('never')], { segment: 'C', nextBefore: 400 }),
    ]);
    const { controller } = install(dom);
    controller.init({ tailStartSeq: 900 });
    await settle();
    assertLineageRoute(calls);
    assert.equal(calls.length, 2, 'a same-segment cursor that does not decrease ends the walk');
  });
});

test('C3 a segment_seam renders the "context renewed" divider and is a merge barrier', async () => {
  const dom = await setupDOM();
  const { conversation } = install(dom);
  conversation.apply({ kind: 'text_delta', msgId: 'm1', blockIdx: 0, text: 'before', _seq: 1 });
  conversation.apply({ kind: 'text_end', msgId: 'm1', blockIdx: 0, _seq: 2 });
  conversation.apply(seam('C'));
  conversation.apply({ kind: 'text_delta', msgId: 'm2', blockIdx: 0, text: 'after', _seq: 3 });
  const dividers = dom.conversationEl.querySelectorAll('.segment-seam');
  assert.equal(dividers.length, 1);
  const d = dividers[0];
  assert.ok(d.classList.contains('history-divider'));
  assert.equal(d.getAttribute('data-segment-id'), 'C');
  assert.equal(d.textContent, '── context renewed ──');
  const wraps = [...dom.conversationEl.querySelectorAll('.msg.assistant')];
  assert.equal(wraps.length, 2, 'the two assistant messages do not merge across the divider');
  assert.ok(wraps[0].nextElementSibling === d, 'the divider sits between them');
});

test('C4 a renew/prune/renew walk renders the server\'s dividers in order and adds none of its own', async () => {
  const dom = await setupDOM();
  const calls = stubFetch([
    page([seam('D'), echo('d first')], { segment: 'C', nextBefore: null, pageSegment: 'D' }),
    page([seam('C'), echo('c first')], { segment: 'A', nextBefore: null, pageSegment: 'C' }),
    page([echo('a first')], { hasMore: false, segment: 'A', nextBefore: 0, pageSegment: 'A' }),
  ]);
  const { controller, conversation } = install(dom);
  conversation.apply(echo('d tail'));
  controller.init({ tailStartSeq: 900 });
  await settle();
  assertLineageRoute(calls);
  assert.deepEqual(tokens(dom.conversationEl), ['a first', '‖C', 'c first', '‖D', 'd first', 'd tail']);
});

test('C5 a gap page continues into the older segment', async () => {
  const dom = await setupDOM();
  const calls = stubFetch([
    page([seam('C'), gap()], { segment: 'A', nextBefore: null }),
    page([echo('a first')], { hasMore: false, segment: 'A', nextBefore: 0, pageSegment: 'A' }),
  ]);
  const { controller } = install(dom);
  controller.init({ tailStartSeq: 900 });
  await settle();
  assertLineageRoute(calls);
  assert.equal(calls.length, 2);
  assert.deepEqual(tokens(dom.conversationEl), ['a first', '‖C', '⋯']);
});

test('C6 rewind/fork follow provenance: only the current segment\'s bubbles offer them', async () => {
  const dom = await setupDOM();
  const { conversation } = install(dom);
  assert.equal(typeof conversation.setCurrentSegment, 'function');
  const { renderEventBatch, spliceBatchAbove, conversationEl } = dom;

  const older = renderEventBatch([echo('a msg')], OPTIONS, { segmentId: 'A', currentSegmentId: () => 'D' });
  assertNull(older.holder.querySelector('.user-msg-actions'), 'an earlier segment\'s bubble has none');
  const current = renderEventBatch([echo('d msg')], OPTIONS, { segmentId: 'D', currentSegmentId: () => 'D' });
  assert.ok(current.holder.querySelector('.user-msg-actions') !== null, 'the current segment\'s bubble has them');

  const split = renderEventBatch([echo('c msg'), seam('D'), echo('d msg 2')], OPTIONS, { segmentId: 'C', currentSegmentId: () => 'D' });
  const [cBubble, dBubble] = split.holder.querySelectorAll('.msg.user');
  assert.ok(!hasActions(cBubble), 'split within a page: the bubble above the divider has none');
  assert.ok(hasActions(dBubble), 'the one below it has them');

  conversation.setCurrentSegment('D');
  conversation.segmentId = 'D';
  conversation.apply(echo('d live'));
  spliceBatchAbove({ root: conversationEl, batch: current, conversation });
  assert.equal(conversationEl.querySelectorAll('.user-msg-actions').length, 2, 'precondition: two current bubbles');
  conversation.setCurrentSegment('E');
  assert.equal(conversationEl.querySelectorAll('.user-msg-actions').length, 0, 'a new current strips every older bubble, spliced ones included');
  conversation.setUserActionsEnabled(true);
  assert.equal(conversationEl.querySelectorAll('.user-msg-actions').length, 0, 'and re-enabling restores none');
});

test('C7 a divider repeated across responses collapses, keeping the upper one', async () => {
  const dom = await setupDOM();
  const calls = stubFetch([
    page([echo('b old'), seam('C'), echo('c older')], { hasMore: false, segment: null, nextBefore: 0 }),
  ]);
  const { controller, conversation } = install(dom);
  conversation.apply(seam('C'));
  conversation.apply(echo('c tail'));
  controller.init({ tailStartSeq: 900 });
  await settle();
  assertLineageRoute(calls);
  assert.deepEqual(tokens(dom.conversationEl), ['b old', '‖C', 'c older', 'c tail']);
});

test('C8 the silent probe: a tail with no older ring content still asks the lineage route once', async (t) => {
  await t.test('an older page is spliced and the sentinel armed', async () => {
    const dom = await setupDOM();
    const calls = stubFetch([page([seam('D')], { segment: 'C', nextBefore: null })]);
    const { controller } = install(dom, { scrollHeight: 5000 });
    controller.init({ tailStartSeq: 0 });
    assertNull(dom.conversationEl.querySelector('.history-sentinel'), 'no sentinel while probing');
    await settle();
    assertLineageRoute(calls);
    assert.equal(calls.length, 1);
    assert.deepEqual(calls[0].params, { limit: '200', before: '0' });
    assert.deepEqual(tokens(dom.conversationEl), ['‖D']);
    assert.ok(dom.conversationEl.querySelector('.history-sentinel') !== null, 'the sentinel is armed');
  });
  await t.test('an empty terminal response renders nothing and asks nothing more', async () => {
    const dom = await setupDOM();
    const calls = stubFetch([{ events: [], hasMore: false, segment: null, nextBefore: 0 }]);
    const { controller } = install(dom);
    controller.init({ tailStartSeq: 0 });
    await settle();
    assertLineageRoute(calls);
    assert.equal(calls.length, 1);
    assert.deepEqual(tokens(dom.conversationEl), []);
    assertNull(dom.conversationEl.querySelector('.history-sentinel'), 'no sentinel');
  });
});

test('C9 snapshot replay: bubbles above the tail\'s divider are an earlier segment\'s', async () => {
  const dom = await setupDOM();
  const { conversation } = install(dom);
  assert.equal(typeof conversation.setCurrentSegment, 'function');
  conversation.clear();
  conversation.setCurrentSegment('B');
  conversation.segmentId = 'A';
  for (const ev of [echo('a tail'), seam('B'), echo('b tail')]) conversation.apply(ev);
  assert.ok(!hasActions(bubbleByText(dom.conversationEl, 'a tail')), 'above the divider: none');
  assert.ok(hasActions(bubbleByText(dom.conversationEl, 'b tail')), 'below it: offered');
});

test('C10 a segment frame with no divider moves current: every existing bubble loses rewind/fork', async () => {
  const dom = await setupDOM();
  const { conversation } = install(dom);
  assert.equal(typeof conversation.setCurrentSegment, 'function');
  conversation.setCurrentSegment('B');
  conversation.segmentId = 'B';
  conversation.apply(echo('b one'));
  assert.ok(hasActions(bubbleByText(dom.conversationEl, 'b one')), 'precondition: a current bubble offers them');
  // The `segment` frame's lines (public/wsRouter.js).
  conversation.segmentId = 'C';
  conversation.setCurrentSegment('C');
  assert.ok(!hasActions(bubbleByText(dom.conversationEl, 'b one')), 'the superseded bubble loses them');
  conversation.apply(echo('c one'));
  assert.ok(hasActions(bubbleByText(dom.conversationEl, 'c one')), 'the next live echo has them');
});
