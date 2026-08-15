// DOM-level tests for A2: routing a depth-2+ sub-agent's events into the
// correctly-nested sub-Conversation. _routeChildEvent (public/conversation.js)
// only ever looked up ITS OWN toolBlocks map — a depth-2 child's head is
// materialized inside the depth-1 sub-Conversation (by _reconcileAssistantMessage,
// gated on isSub), so the outer conversation must delegate a failed lookup to
// its own subConvs before parking the event as genuinely headless.
//
// happy-dom harness copied from tests/lazy-autoload.test.mjs:21-36.

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
  document.body.innerHTML = '<div id="conversation"></div>';
  const conversationEl = document.getElementById('conversation');
  return { conversationEl, Conversation };
}

test('a depth-2 sub-agent child is routed into the nested sub-conversation, not parked', async () => {
  const { conversationEl, Conversation } = await setupDOM();
  const conversation = new Conversation(conversationEl, {});

  // Depth-1: outer Agent tool_use head.
  conversation.apply({ kind: 'tool_use', toolUseId: 'A', name: 'Agent', input: {}, parentToolUseId: null });
  // Depth-2 head: a forwarded sub-agent envelope (parentToolUseId: 'A') whose
  // own content carries a nested Agent tool_use — this is what
  // _reconcileAssistantMessage materializes as a tool block INSIDE the
  // depth-1 sub-Conversation (A1's server-side fix supplies the matching
  // live `tool_use` event; the client-level reconcile path is what actually
  // creates the block either way).
  conversation.apply({
    kind: 'assistant_message', msgId: 'msg_sub', parentToolUseId: 'A',
    message: { id: 'msg_sub', content: [{ type: 'tool_use', id: 'B', name: 'Agent', input: {} }] },
  });
  // Depth-3 content: a text block belonging to B.
  conversation.apply({ kind: 'text_delta', msgId: 'msg_deep', blockIdx: 0, text: 'deep', parentToolUseId: 'B' });
  conversation.apply({ kind: 'text_end', msgId: 'msg_deep', blockIdx: 0, parentToolUseId: 'B' });

  assert.equal(conversation.orphanChildEvents.size, 0, 'nothing parked at the outer level');
  const subA = conversation.subConvs.get('A');
  assert.ok(subA, 'depth-1 sub-conversation exists');
  const subB = subA.subConvs.get('B');
  assert.ok(subB, 'depth-2 sub-conversation exists, nested inside the depth-1 one');
  assert.ok(conversationEl.textContent.includes('deep'), 'the depth-2 child text actually renders');
});

test('a truly headless child (no ancestor at any depth) is still parked, not swallowed by the recursion', async () => {
  const { conversationEl, Conversation } = await setupDOM();
  const conversation = new Conversation(conversationEl, {});

  conversation.apply({ kind: 'text_delta', msgId: 'msg_z', blockIdx: 0, text: 'ghost', parentToolUseId: 'ZZZ' });

  assert.ok(conversation.orphanChildEvents.has('ZZZ'), 'unresolvable parent id is parked');
  assert.ok(!conversationEl.textContent.includes('ghost'), 'a parked event does not render');
});
