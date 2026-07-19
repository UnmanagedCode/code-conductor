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
  assert.equal(ctx.conversationEl.querySelector('.history-sentinel'), null,
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
