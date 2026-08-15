// DOM-level tests for the viewport auto-fill in the lazy-history controller
// (public/lazyHistory.js → installLazyHistoryController). When the rendered
// tail is shorter than the scroll viewport, the controller should page in
// earlier chunks automatically (via the same loadEarlier path) until the
// container is scrollable or history is exhausted — without hot-looping on a
// fetch error and without pulling anything when already scrollable.
//
// happy-dom does no layout, so clientHeight/scrollHeight are overridden on a
// real conversationEl via Object.defineProperty, and global.fetch is stubbed
// to serve canned pages. Mirrors the happy-dom setup in rendering.test.mjs.

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

  const { Conversation } = await import(pathToFileURL(path.join(PUB, 'conversation.js')).href);
  const { installLazyHistoryController } =
    await import(pathToFileURL(path.join(PUB, 'lazyHistory.js')).href);

  document.body.innerHTML = '<div id="conversation"></div>';
  const conversationEl = document.getElementById('conversation');
  return { window, document, conversationEl, Conversation, installLazyHistoryController };
}

// A minimal replay-shaped page: one archived user echo. nextBefore decreases
// per page so the controller sees forward progress.
function makePages(n, { hasMore = true } = {}) {
  return Array.from({ length: n }, (_, i) => ({
    events: [{ kind: 'user_echo', text: `old${i}`, userIndex: 100 - i, _seq: 900 - i, parentToolUseId: null }],
    nextBefore: 900 - i * 10,
    hasMore,
  }));
}

// fetch stub: serves `pages` in order, bumps scrollHeight (`sh`) by `grow`
// per call so the viewport can eventually become scrollable. Records URLs.
function makeFetch(pages, calls, sh, grow) {
  return async (url) => {
    calls.push(url);
    const page = pages.shift() ?? { events: [], nextBefore: 0, hasMore: false };
    sh.value += grow;
    return { ok: true, status: 200, json: async () => JSON.parse(JSON.stringify(page)) };
  };
}

// Build the controller wired to a conversationEl with overridden layout
// metrics. clientHeight is fixed; scrollHeight is driven by `sh.value`.
function install(ctx, sh, clientHeight = 800) {
  const { conversationEl, Conversation, installLazyHistoryController } = ctx;
  Object.defineProperty(conversationEl, 'clientHeight', { configurable: true, get: () => clientHeight });
  Object.defineProperty(conversationEl, 'scrollHeight', { configurable: true, get: () => sh.value });
  const conversation = new Conversation(conversationEl, {});
  const controller = installLazyHistoryController({
    conversationEl,
    conversation,
    conversationOptions: {},
    getActiveId: () => 'inst1',
    getInstances: () => [{ id: 'inst1', status: 'idle' }],
  });
  return { controller, conversation };
}

const flush = () => new Promise((r) => setTimeout(r, 0));

test('short tail auto-fills until the viewport is scrollable, then stops', async () => {
  const ctx = await setupDOM();
  const calls = [];
  const sh = { value: 100 };                 // starts below the 800 viewport
  globalThis.fetch = makeFetch(makePages(5), calls, sh, 300); // +300/page ⇒ 100→1000
  const { controller } = install(ctx, sh);

  controller.init({ tailStartSeq: 1000 });   // hasMore ⇒ auto-fill kicks in
  await flush();
  await flush();

  // 100→400→700→1000: the third page crosses 800, so exactly 3 fetches.
  assert.equal(calls.length, 3, 'pages in until scrollable, then halts');
  assert.ok(sh.value > ctx.conversationEl.clientHeight, 'viewport is now scrollable');
  // More history remains (pages report hasMore) ⇒ sentinel stays for scroll-up.
  assert.ok(ctx.conversationEl.querySelector('.history-sentinel'), 'sentinel retained');
});

test('short total history terminates without infinite fetching', async () => {
  const ctx = await setupDOM();
  const calls = [];
  const sh = { value: 100 };                                  // never crosses 800
  globalThis.fetch = makeFetch(makePages(1, { hasMore: false }), calls, sh, 300);
  const { controller } = install(ctx, sh);

  controller.init({ tailStartSeq: 1000 });
  await flush();
  await flush();

  assert.equal(calls.length, 1, 'one page, then hasMore:false ends the loop');
  // assertNull, not assert.equal(el, null): on failure, assert's diff-message
  // formatting calls util.inspect on `actual`, and a live happy-dom Element
  // carries a circular ownerDocument -> Window reference (a huge object) that
  // makes that formatting pathologically slow — see B-4 below for the case
  // where this turns an assertion failure into an effective test hang.
  assertNull(ctx.conversationEl.querySelector('.history-sentinel'),
    'sentinel removed once history is exhausted');
});

test('a fetch error stops the loop (no hot-loop) and keeps the sentinel', async () => {
  const ctx = await setupDOM();
  const calls = [];
  const sh = { value: 100 };                 // stays short — only the error guard can stop it
  globalThis.fetch = async (url) => {
    calls.push(url);
    return { ok: false, status: 500, json: async () => ({ error: 'boom' }) };
  };
  const { controller } = install(ctx, sh);

  controller.init({ tailStartSeq: 1000 });
  await flush();
  await flush();

  assert.equal(calls.length, 1, 'no forward progress ⇒ exactly one attempt');
  assert.ok(ctx.conversationEl.querySelector('.history-sentinel'), 'sentinel stays tappable');
});

test('an already-scrollable tail triggers no auto-fill', async () => {
  const ctx = await setupDOM();
  const calls = [];
  const sh = { value: 1000 };                 // already exceeds the 800 viewport
  globalThis.fetch = makeFetch(makePages(5), calls, sh, 300);
  const { controller } = install(ctx, sh);

  controller.init({ tailStartSeq: 1000 });
  await flush();
  await flush();

  assert.equal(calls.length, 0, 'no auto-fetch when the viewport is already scrollable');
  assert.ok(ctx.conversationEl.querySelector('.history-sentinel'), 'manual sentinel still shown');
});

// ── A7: an empty page is not the end of history ─────────────────────────────
// A correct server (post-A3) never hands back an empty backward page while
// hasMore is true, but the client must not treat one as terminal on its own
// (defence-in-depth), must still refuse to hot-loop a pathological server,
// and must recover once a served page appears in the middle of a run.

test('an empty backward page does not end history when the cursor still decreases and hasMore stays true', async () => {
  const ctx = await setupDOM();
  const calls = [];
  const pages = [
    { events: [], nextBefore: 880, hasMore: true },
    { events: [{ kind: 'user_echo', text: 'old', userIndex: 50, _seq: 875, parentToolUseId: null }], nextBefore: 870, hasMore: true },
    { events: [], nextBefore: 0, hasMore: false },
  ];
  const sh = { value: 100 }; // never becomes scrollable on its own — only hasMore governs termination here
  globalThis.fetch = async (url) => {
    calls.push(url);
    const page = pages.shift() ?? { events: [], nextBefore: 0, hasMore: false };
    return { ok: true, status: 200, json: async () => JSON.parse(JSON.stringify(page)) };
  };
  const { controller } = install(ctx, sh);
  controller.init({ tailStartSeq: 900 });
  await flush(); await flush(); await flush(); await flush();

  assert.equal(calls.length, 3, 'pages through the empty page instead of stopping at it');
});

test('a cursor that fails to progress ends history even though the server claims hasMore', async () => {
  const ctx = await setupDOM();
  const calls = [];
  const sh = { value: 100 };
  globalThis.fetch = async (url) => {
    calls.push(url);
    // Pathological: same cursor echoed back forever, hasMore always true.
    return { ok: true, status: 200, json: async () => ({ events: [], nextBefore: 900, hasMore: true }) };
  };
  const { controller } = install(ctx, sh);
  controller.init({ tailStartSeq: 900 });
  await flush(); await flush(); await flush();

  assert.equal(calls.length, 1, 'a stalled cursor makes no second attempt');
  // B-4: compare a boolean, not the raw element. With the strict-decrease
  // check (page.nextBefore < prevBefore) broken, hasMore stays true after
  // this call and the sentinel is never removed — asserting THAT element
  // against `null` directly makes assert's on-failure diff formatting call
  // util.inspect on a live happy-dom Element, whose ownerDocument/defaultView
  // reference the whole (huge) Window object; inspecting that is so slow it
  // reads as a hang (observed: the whole file aborts ~68s later) instead of a
  // clean assertion failure, and T13 below never even runs. Confirmed this
  // is the actual mechanism (not an unbounded await anywhere in this test):
  // reverting the strict-decrease check with THIS assertion form still made
  // every flush() resolve and every debug log print through the assignment
  // right before this comparison, then hung inside the comparison itself.
  assertNull(ctx.conversationEl.querySelector('.history-sentinel'),
    'sentinel is removed once the cursor stalls (call count alone cannot distinguish this from the strict-decrease check being absent)');
});

test('MAX_EMPTY_PAGES caps consecutive empty pages so a pathological server cannot hot-loop', async () => {
  const ctx = await setupDOM();
  const calls = [];
  // 6 strictly-decreasing-cursor empty pages, every one claiming hasMore.
  const pages = Array.from({ length: 6 }, (_, i) => ({ events: [], nextBefore: 900 - (i + 1) * 10, hasMore: true }));
  const sh = { value: 100 };
  globalThis.fetch = async (url) => {
    calls.push(url);
    const page = pages.shift() ?? { events: [], nextBefore: 0, hasMore: false };
    sh.value += 120; // becomes scrollable only after the 6th call (100+6*120=820>800) —
                      // bounds an uncapped run at exactly the fixture length instead of
                      // running on into the synthetic post-fixture default page.
    return { ok: true, status: 200, json: async () => JSON.parse(JSON.stringify(page)) };
  };
  const { controller } = install(ctx, sh);
  controller.init({ tailStartSeq: 900 });
  for (let i = 0; i < 8; i++) await flush();

  assert.equal(calls.length, 3, 'stops after MAX_EMPTY_PAGES consecutive empty pages');
  // Same node-vs-null hang risk as T12 above (B-4) — use assertNull.
  assertNull(ctx.conversationEl.querySelector('.history-sentinel'), 'sentinel removed once capped');
});

test('a served page in the middle of a run resets the empty-page streak', async () => {
  const ctx = await setupDOM();
  const calls = [];
  const pages = [
    { events: [], nextBefore: 890, hasMore: true },
    { events: [], nextBefore: 880, hasMore: true },
    { events: [{ kind: 'user_echo', text: 'old', userIndex: 50, _seq: 875, parentToolUseId: null }], nextBefore: 870, hasMore: true },
    { events: [], nextBefore: 860, hasMore: true },
    { events: [], nextBefore: 850, hasMore: true },
    { events: [], nextBefore: 840, hasMore: true },
  ];
  const sh = { value: 100 };
  globalThis.fetch = async (url) => {
    calls.push(url);
    const page = pages.shift() ?? { events: [], nextBefore: 0, hasMore: false };
    return { ok: true, status: 200, json: async () => JSON.parse(JSON.stringify(page)) };
  };
  const { controller } = install(ctx, sh);
  controller.init({ tailStartSeq: 900 });
  for (let i = 0; i < 10; i++) await flush();

  assert.equal(calls.length, 6,
    'the served 3rd page resets the streak, so two more empty pages are allowed afterward');
});
