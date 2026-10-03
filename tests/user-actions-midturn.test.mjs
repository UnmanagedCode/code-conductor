// The user-bubble actions are enabled per action (public/conversation.js):
// ⑂ fork works mid-turn, ↶ rewind only between turns. `userActionsForStatus` is
// the one mapping from an instance status; `setUserActionsEnabled` applies it to
// the bubbles already rendered and to those rendered afterwards.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { Window } from 'happy-dom';
import { assertNull } from './dom-assert.mjs';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const PUB = path.resolve(__dirname, '..', 'public');

function setupWindow() {
  const window = new Window({ url: 'http://localhost/' });
  globalThis.window = window;
  globalThis.document = window.document;
  globalThis.HTMLElement = window.HTMLElement;
  globalThis.Element = window.Element;
  globalThis.Node = window.Node;
  globalThis.localStorage = window.localStorage;
  return window;
}

let seq = 1;
const echo = (text, userIndex) => ({ kind: 'user_echo', text, userIndex, _seq: seq++, parentToolUseId: null });

async function mount(opts = {}) {
  setupWindow();
  const mod = await import(pathToFileURL(path.join(PUB, 'conversation.js')).href);
  document.body.innerHTML = '<div id="root"></div>';
  const conv = new mod.Conversation(document.getElementById('root'), { onRewind: () => {}, onFork: () => {}, ...opts });
  return { ...mod, conv, root: document.getElementById('root') };
}

// [rewind disabled, fork disabled] for every bubble's buttons.
const states = (root) => [...root.querySelectorAll('.msg.user')].map(b => [
  b.querySelector('.user-msg-rewind').disabled, b.querySelector('.user-msg-fork').disabled,
]);

const EXPECTED = {
  idle: { rewind: true, fork: true },
  turn: { rewind: false, fork: true },
  spawning: { rewind: false, fork: false },
  exited: { rewind: false, fork: false },
  crashed: { rewind: false, fork: false },
};

test('userActionsForStatus', async (t) => {
  const { userActionsForStatus } = await mount();
  for (const [status, expected] of Object.entries(EXPECTED)) {
    await t.test(status, () => assert.deepEqual(userActionsForStatus(status), expected));
  }
  await t.test('no instance', () => assert.deepEqual(userActionsForStatus(undefined), { rewind: false, fork: false }));
});

test('setUserActionsEnabled applies each action separately, to existing and later bubbles', async (t) => {
  for (const status of ['turn', 'idle', 'spawning']) {
    await t.test(status, async () => {
      const { conv, root, userActionsForStatus } = await mount();
      const { rewind, fork } = EXPECTED[status];
      conv.apply(echo('before', 0));
      conv.setUserActionsEnabled(userActionsForStatus(status));
      conv.apply(echo('after', 1));
      assert.deepEqual(states(root), [[!rewind, !fork], [!rewind, !fork]],
        'the bubble rendered before the call and the one rendered after share the split');
    });
  }
});

test('a status change re-enables what the previous one disabled, per action', async () => {
  const { conv, root, userActionsForStatus } = await mount();
  conv.apply(echo('one', 0));
  conv.setUserActionsEnabled(userActionsForStatus('spawning'));
  assert.deepEqual(states(root), [[true, true]], 'precondition: both disabled');
  conv.setUserActionsEnabled(userActionsForStatus('turn'));
  assert.deepEqual(states(root), [[true, false]], 'turn: fork comes back, rewind stays off');
  conv.setUserActionsEnabled(userActionsForStatus('idle'));
  assert.deepEqual(states(root), [[false, false]], 'idle: rewind comes back too');
});

test('a non-current-segment bubble still has no actions mid-turn', async () => {
  const { conv, root, userActionsForStatus } = await mount({ segmentId: 'A', currentSegmentId: 'A' });
  conv.apply(echo('old segment', 0));
  conv.setCurrentSegment('B');
  conv.setUserActionsEnabled(userActionsForStatus('turn'));
  assertNull(root.querySelector('.user-msg-actions'), 'enabling fork mid-turn restores no removed affordance');
});

test('a sub-conversation stays without enabled actions whatever is asked', async () => {
  const { conv, root } = await mount({ isSub: true });
  conv.setUserActionsEnabled({ rewind: true, fork: true });
  conv.apply(echo('sub', 0));
  assertNull(root.querySelector('.user-msg-actions'), 'sub-agent transcripts render no rewind/fork');
  assert.equal(conv._rewindEnabled || conv._forkEnabled, false);
});

test('the header applies the active instance\'s status to the conversation', async (t) => {
  setupWindow();
  const { Conversation } = await import(pathToFileURL(path.join(PUB, 'conversation.js')).href);
  const { setupHeader, session } = await import('./headerCompactHarness.mjs');
  let root = null;
  let conv = null;
  const h = await setupHeader({
    conversation: (document) => {
      root = document.createElement('div');
      document.body.appendChild(root);
      conv = new Conversation(root, { onRewind: () => {}, onFork: () => {} });
      return conv;
    },
  });
  conv.apply(echo('rendered', 0));
  for (const status of ['turn', 'idle', 'spawning']) {
    await t.test(status, () => {
      const { rewind, fork } = EXPECTED[status];
      h.show(session(status));
      assert.deepEqual(states(root), [[!rewind, !fork]]);
    });
  }
});

test('a lazy-history page spliced mid-turn gets fork enabled and rewind disabled', async (t) => {
  for (const status of ['turn', 'idle']) {
    await t.test(status, async () => {
      setupWindow();
      const { Conversation } = await import(pathToFileURL(path.join(PUB, 'conversation.js')).href);
      const { installLazyHistoryController } = await import(pathToFileURL(path.join(PUB, 'lazyHistory.js')).href);
      document.body.innerHTML = '<div id="conversation"></div>';
      const conversationEl = document.getElementById('conversation');
      Object.defineProperty(conversationEl, 'clientHeight', { configurable: true, get: () => 800 });
      Object.defineProperty(conversationEl, 'scrollHeight', { configurable: true, get: () => 0 });
      const page = { events: [echo('older', 0)], hasMore: false, segment: 'D', pageSegment: 'D', currentSegmentId: 'D', nextBefore: null };
      globalThis.fetch = async () => ({ ok: true, status: 200, json: async () => JSON.parse(JSON.stringify(page)) });
      const options = { onRewind: () => {}, onFork: () => {} };
      const conversation = new Conversation(conversationEl, options);
      const controller = installLazyHistoryController({
        conversationEl, conversation, conversationOptions: options,
        getActiveId: () => 'inst1', getInstances: () => [{ id: 'inst1', status }],
      });
      controller.init({ tailStartSeq: 900 });
      await waitUntil(() => conversationEl.querySelector('.msg.user'));
      const { rewind, fork } = EXPECTED[status];
      assert.deepEqual(states(conversationEl), [[!rewind, !fork]]);
    });
  }
});

async function waitUntil(predicate) {
  for (let i = 0; i < 50 && !predicate(); i++) await new Promise(r => setTimeout(r, 0));
  assert.ok(predicate(), 'condition reached');
}
