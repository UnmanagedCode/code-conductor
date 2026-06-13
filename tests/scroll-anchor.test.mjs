// Regression tests for the scroll-position jump in the lazy conversation
// history loader (public/lazyHistory.js) and session-switch scroll reset
// (public/conversation.js).
//
// Two bugs caused the scroll to "snap back" when a new history page loaded:
//
//  Bug 1 — prependBatch double-compensation (lazyHistory.js):
//    The old code used `root.scrollTop += delta`.  Chrome's CSS scroll
//    anchoring (overflow-anchor:auto, the default) fires when scrollHeight is
//    read after a DOM mutation, advancing scrollTop by the batch height before
//    our += sees it.  The += then adds the delta a second time → scrollTop
//    overshoots → browser clamps to maxScrollTop (the bottom) → stickyBottom
//    flips true → next live event keeps user at the bottom — "snapping back"
//    to where they were before they started scrolling through history.
//    Fixed by saving prevScrollTop before the mutation loop and using absolute
//    assignment: `root.scrollTop = prevScrollTop + delta`.
//
//  Bug 2 — stickyBottom not reset in clear() (conversation.js):
//    If the user had scrolled up in session A (stickyBottom=false) and then
//    switched to session B, clear() wiped the DOM but left stickyBottom=false.
//    The snapshot replay ran _maybeScroll() with stickyBottom=false → no snap
//    to bottom → scrollTop stayed at 0.  The sentinel insertion by lazyInit()
//    then triggered an immediate loadEarlier() (scrollTop < 200 threshold),
//    prepending old content the user never asked for — "an earlier offset".
//    Fixed by resetting stickyBottom=true inside clear().

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
  const { prependBatch } = await import(pathToFileURL(path.join(PUB, 'lazyHistory.js')).href);

  document.body.innerHTML = '<div id="root"></div>';
  const root = document.getElementById('root');
  return { window, document, root, Conversation, prependBatch };
}

// Helper: plain-object scroll container with controllable scrollHeight.
// `afterInsertHeight` is the scrollHeight that will be returned after the
// first insertBefore call fires, simulating content being added.
function makeScrollMock({ initScrollTop, initHeight, afterInsertHeight }) {
  let scrollTop = initScrollTop;
  let insertionHappened = false;
  const mock = {
    get scrollTop() { return scrollTop; },
    set scrollTop(v) { scrollTop = v; },
    get scrollHeight() {
      return insertionHappened ? afterInsertHeight : initHeight;
    },
    get firstChild() { return null; },
    insertBefore(_node, _ref) { insertionHappened = true; },
  };
  return mock;
}

// Helper: holder with exactly `n` synthetic children that deplete as they are
// moved out by the while-loop in prependBatch.
function makeHolder(n) {
  let remaining = n;
  return {
    get firstChild() { return remaining-- > 0 ? {} : null; },
  };
}

// ─── Bug 1: prependBatch scroll compensation ──────────────────────────────────

test('prependBatch advances scrollTop by the inserted batch height', async () => {
  const { prependBatch } = await setupDOM();

  const INIT_HEIGHT = 800;
  const BATCH_HEIGHT = 3000;
  const root = makeScrollMock({
    initScrollTop: 150,
    initHeight: INIT_HEIGHT,
    afterInsertHeight: INIT_HEIGHT + BATCH_HEIGHT,
  });

  prependBatch(root, makeHolder(1), null);

  assert.equal(root.scrollTop, 150 + BATCH_HEIGHT,
    'scrollTop should be prevScrollTop + batchHeight');
});

test('prependBatch: absolute = avoids double-compensation under CSS scroll anchoring', async () => {
  // Simulates a browser where reading scrollHeight after a DOM mutation
  // triggers CSS scroll anchoring, which advances scrollTop by the height
  // delta before our assignment reads it.  The old += code added the delta
  // twice; the fixed code saves prevScrollTop before the loop.
  const { prependBatch } = await setupDOM();

  const INIT_HEIGHT = 500;
  const BATCH_HEIGHT = 2000;
  let scrollTopValue = 100;
  let insertionHappened = false;

  const root = {
    get scrollTop() { return scrollTopValue; },
    set scrollTop(v) { scrollTopValue = v; },
    get scrollHeight() {
      if (insertionHappened) {
        insertionHappened = false;
        // Simulate Chrome scroll-anchoring: fires during the forced layout
        // triggered by reading scrollHeight after the DOM mutation, advancing
        // scrollTop by the height delta to keep the anchor element in place.
        scrollTopValue += BATCH_HEIGHT;
        return INIT_HEIGHT + BATCH_HEIGHT;
      }
      return INIT_HEIGHT;
    },
    get firstChild() { return null; },
    insertBefore(_n, _r) { insertionHappened = true; },
  };

  prependBatch(root, makeHolder(1), null);

  // Fixed code: prevScrollTop(100) + delta(2000) = 2100
  // Buggy += code: Chrome sets scrollTop to 2100, then += 2000 → 4100
  assert.equal(scrollTopValue, 2100,
    'absolute assignment uses saved prevScrollTop — not the anchoring-adjusted value');
});

test('prependBatch leaves scrollTop unchanged when holder is empty', async () => {
  const { prependBatch } = await setupDOM();

  const root = makeScrollMock({ initScrollTop: 500, initHeight: 1000, afterInsertHeight: 1000 });
  prependBatch(root, makeHolder(0), null);

  assert.equal(root.scrollTop, 500, 'no content inserted — scrollTop unchanged');
});

test('prependBatch inserts batch after sentinel, before live content', async () => {
  const { document, root, prependBatch } = await setupDOM();

  const sentinel = document.createElement('div');
  sentinel.className = 'history-sentinel';
  root.appendChild(sentinel);

  const live = document.createElement('div');
  live.textContent = 'live message';
  root.appendChild(live);

  const holder = document.createElement('div');
  const archived = document.createElement('div');
  archived.textContent = 'archived message';
  holder.appendChild(archived);

  prependBatch(root, holder, sentinel);

  const texts = [...root.querySelectorAll('div')]
    .map(n => n.textContent.trim()).filter(Boolean);
  assert.ok(texts.indexOf('archived message') < texts.indexOf('live message'),
    'archived content sits above live content');
  assert.equal(root.children[0].className, 'history-sentinel',
    'sentinel remains the first child');
});

// ─── Bug 2: Conversation.clear() must reset stickyBottom ─────────────────────

test('Conversation starts with stickyBottom true', async () => {
  const { root, Conversation } = await setupDOM();
  const conv = new Conversation(root, {});
  assert.equal(conv.stickyBottom, true,
    'newly constructed Conversation must auto-scroll to bottom');
});

test('Conversation.clear resets stickyBottom to true', async () => {
  const { root, Conversation } = await setupDOM();
  const conv = new Conversation(root, {});

  // Simulate user having scrolled up in a previous session
  conv.stickyBottom = false;
  assert.equal(conv.stickyBottom, false, 'precondition: was scrolled up');

  conv.clear();

  assert.equal(conv.stickyBottom, true,
    'clear() must reset stickyBottom so the new session starts at the bottom');
});

test('Conversation.clear resets stickyBottom when it was already true', async () => {
  const { root, Conversation } = await setupDOM();
  const conv = new Conversation(root, {});
  // Already true by default — verify clear() keeps it true
  conv.clear();
  assert.equal(conv.stickyBottom, true, 'stickyBottom stays true after clear()');
});

test('Conversation.reset (alias for clear) also resets stickyBottom', async () => {
  const { root, Conversation } = await setupDOM();
  const conv = new Conversation(root, {});
  conv.stickyBottom = false;
  conv.reset(); // reset() delegates to clear()
  assert.equal(conv.stickyBottom, true,
    'reset() inherits the stickyBottom fix via clear()');
});
