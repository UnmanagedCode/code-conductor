// DOM-level tests for the lazy-loaded older-history path (public/
// lazyHistory.js): a fetched page of archived events is rendered through a
// fresh Conversation instance (the standard block-rendering pipeline — no
// parallel renderer) on a detached node, then transplanted above the live
// conversation. Mirrors the happy-dom setup in rendering.test.mjs.

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
  const { renderEventBatch, prependBatch } = await import(pathToFileURL(path.join(PUB, 'lazyHistory.js')).href);

  document.body.innerHTML = '<div id="root"></div>';
  const root = document.getElementById('root');
  return { window, document, root, Conversation, renderEventBatch, prependBatch };
}

// A replay-shaped page: one full turn (prompt → tool call → result → text).
function archivePage() {
  return [
    { kind: 'user_echo', text: 'old prompt', userIndex: 3, _seq: 10, parentToolUseId: null },
    { kind: 'tool_use_start', msgId: 'mOld', blockIdx: 0, toolUseId: 'tuOld', name: 'Bash', _seq: 11, parentToolUseId: null },
    { kind: 'tool_use', msgId: 'mOld', blockIdx: 0, toolUseId: 'tuOld', name: 'Bash', input: { command: 'ls' }, _seq: 12, parentToolUseId: null },
    { kind: 'tool_result', toolUseId: 'tuOld', content: 'file.txt', isError: false, _seq: 13, parentToolUseId: null },
    { kind: 'text_delta', msgId: 'mOld', blockIdx: 1, text: 'archived reply', _seq: 14, parentToolUseId: null },
    { kind: 'text_end', msgId: 'mOld', blockIdx: 1, _seq: 15, parentToolUseId: null },
  ];
}

test('renderEventBatch renders standard blocks and strips the empty placeholder', async () => {
  const { renderEventBatch } = await setupDOM();
  const holder = renderEventBatch(archivePage());

  assert.equal(holder.querySelector('.empty'), null, 'no placeholder transplanted');
  const userMsg = holder.querySelector('.msg.user');
  assert.ok(userMsg, 'user bubble rendered');
  assert.ok(userMsg.textContent.includes('old prompt'));
  const assistant = holder.querySelector('.msg.assistant');
  assert.ok(assistant, 'assistant wrap rendered');
  assert.ok(assistant.querySelector('.block.tool-use, .tool-use, [class*="tool"]'),
    'tool block rendered through the standard path');
  assert.ok(assistant.textContent.includes('archived reply'));
});

test('archive bubbles use the server-stamped userIndex for rewind/fork', async () => {
  const { renderEventBatch } = await setupDOM();
  const clicks = [];
  const holder = renderEventBatch(archivePage(), {
    onRewind: (i) => clicks.push(['rewind', i]),
    onFork: (i) => clicks.push(['fork', i]),
  });
  const bubble = holder.querySelector('.msg.user');
  assert.equal(bubble.getAttribute('data-user-index'), '3', 'absolute stamp, not a local count');
  bubble.querySelector('.user-msg-rewind').click();
  bubble.querySelector('.user-msg-fork').click();
  assert.deepEqual(clicks, [['rewind', 3], ['fork', 3]]);
});

test('an echo without userIndex renders, but offers no rewind/fork buttons', async () => {
  const { renderEventBatch } = await setupDOM();
  const holder = renderEventBatch(
    [{ kind: 'user_echo', text: 'orphan echo', _seq: 20, parentToolUseId: null }],
    { onRewind: () => {}, onFork: () => {} },
  );
  const bubble = holder.querySelector('.msg.user');
  assert.ok(bubble, 'bubble still renders');
  assert.equal(bubble.getAttribute('data-user-index'), null);
  assert.equal(bubble.querySelector('.user-msg-actions'), null, 'no unanchored rewind buttons');
});

test('onAssistantText is force-nulled — archive replay never triggers TTS', async () => {
  const { renderEventBatch } = await setupDOM();
  let spoken = 0;
  renderEventBatch(archivePage(), { onAssistantText: () => { spoken += 1; } });
  assert.equal(spoken, 0, 'text_end in a batch must not auto-speak');
});

test('prependBatch splices the batch after the sentinel, above newer content', async () => {
  const { document, root, Conversation, renderEventBatch, prependBatch } = await setupDOM();

  // Live conversation with a sentinel pinned on top and one newer turn.
  const main = new Conversation(root, {});
  main.apply({ kind: 'user_echo', text: 'newer prompt', userIndex: 4, _seq: 30, parentToolUseId: null });
  main.apply({ kind: 'text_delta', msgId: 'mNew', blockIdx: 0, text: 'newer reply', _seq: 31, parentToolUseId: null });
  const sentinel = document.createElement('div');
  sentinel.className = 'history-sentinel';
  root.insertBefore(sentinel, root.firstChild);

  const holder = renderEventBatch(archivePage());
  prependBatch(root, holder, sentinel);

  const order = [...root.children].map(n => n.className.split(' ')[0]);
  assert.equal(order[0], 'history-sentinel', 'sentinel stays on top');
  // Old content sits between the sentinel and the newer content.
  const text = root.textContent;
  assert.ok(text.indexOf('old prompt') < text.indexOf('newer prompt'),
    'archived turn rendered above the live turn');
  assert.ok(text.indexOf('archived reply') < text.indexOf('newer reply'));
  // The live conversation's own bubbles are untouched.
  const bubbles = [...root.querySelectorAll('.msg.user')].map(n => n.getAttribute('data-user-index'));
  assert.deepEqual(bubbles, ['3', '4']);
});

test('prependBatch falls back to the top when no sentinel is given', async () => {
  const { root, Conversation, renderEventBatch, prependBatch } = await setupDOM();
  const main = new Conversation(root, {});
  main.apply({ kind: 'user_echo', text: 'newer prompt', userIndex: 1, _seq: 5, parentToolUseId: null });

  const holder = renderEventBatch(
    [{ kind: 'user_echo', text: 'old prompt', userIndex: 0, _seq: 1, parentToolUseId: null }]);
  prependBatch(root, holder, null);

  const text = root.textContent;
  assert.ok(text.indexOf('old prompt') < text.indexOf('newer prompt'));
});
