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

// ── Card 2026-0245: the four independent, sticky collapse surfaces ──────────
// A sub-agent balloon owns four collapsible surfaces: the balloon itself, its
// `tool_args`, the sub-agent's own turn transcript, and its `tool_result`.
// Each must default sensibly and, once the user toggles it, survive every
// later streamed sub-agent event. The state IS the <details open> attribute —
// nothing in the render path may write it back.

// Helpers: the four surfaces of the Agent block whose toolUseId is `id`.
function surfaces(conversation, id) {
  const block = conversation.toolBlocks.get(id);
  assert.ok(block, `tool block ${id} exists`);
  return {
    balloon: block.node,
    argsDetails: block.node.querySelector('details.block.tool-args'),
    subDetails: block.node.querySelector('.sub-conversation'),
    resultDetails: block.node.querySelector('details.block.tool-result'),
  };
}

test('T1: the balloon stays collapsed when the sub-agent\'s first event arrives', async () => {
  const { conversationEl, Conversation } = await setupDOM();
  const conversation = new Conversation(conversationEl, {});

  conversation.apply({ kind: 'tool_use', toolUseId: 'A', name: 'Agent', input: {}, parentToolUseId: null });
  conversation.apply({ kind: 'text_delta', msgId: 'm1', blockIdx: 0, text: 'first token', parentToolUseId: 'A' });

  const { balloon, subDetails } = surfaces(conversation, 'A');
  assert.ok(!balloon.hasAttribute('open'), 'balloon must NOT be force-opened by the first child event');
  // The reveal itself must still happen — otherwise a mutant could "pass" the
  // line above by disabling revealSubRoot wholesale.
  assert.ok(!subDetails.hasAttribute('hidden'), 'the sub-conversation is revealed');
  assert.ok(subDetails.textContent.includes('first token'), 'the child text actually rendered');
});

test('T2: a manual collapse of the balloon survives later sub-agent events', async () => {
  const { conversationEl, Conversation } = await setupDOM();
  const conversation = new Conversation(conversationEl, {});

  conversation.apply({ kind: 'tool_use', toolUseId: 'A', name: 'Agent', input: {}, parentToolUseId: null });
  conversation.apply({ kind: 'text_delta', msgId: 'm1', blockIdx: 0, text: 'one', parentToolUseId: 'A' });
  const { balloon } = surfaces(conversation, 'A');

  balloon.open = true;
  conversation.apply({ kind: 'text_delta', msgId: 'm1', blockIdx: 0, text: ' two', parentToolUseId: 'A' });
  assert.equal(balloon.open, true, 'a user-opened balloon must not be force-closed by a child event');

  balloon.open = false;
  conversation.apply({
    kind: 'assistant_message', msgId: 'm2', parentToolUseId: 'A',
    message: { id: 'm2', content: [{ type: 'text', text: 'three' }] },
  });
  assert.equal(balloon.open, false, 'a user-collapsed balloon must survive the next child event');
  const { subDetails } = surfaces(conversation, 'A');
  assert.ok(subDetails.textContent.includes('three'), 'the later event still rendered into the sub-conversation');
});

test('T3: the sub-agent turn section is its own sticky toggle', async () => {
  const { conversationEl, Conversation } = await setupDOM();
  const conversation = new Conversation(conversationEl, {});

  conversation.apply({ kind: 'tool_use', toolUseId: 'A', name: 'Agent', input: {}, parentToolUseId: null });
  conversation.apply({ kind: 'text_delta', msgId: 'm1', blockIdx: 0, text: 'alpha', parentToolUseId: 'A' });

  const { subDetails } = surfaces(conversation, 'A');
  assert.equal(subDetails.tagName, 'DETAILS', 'the turn section is a <details>, i.e. collapsible on its own');
  const sum = [...subDetails.children].find((c) => c.tagName === 'SUMMARY');
  assert.ok(sum, 'the turn section has its own direct-child <summary> toggle');
  assert.equal(subDetails.open, true, 'the turn section is open by default');

  subDetails.open = false;
  conversation.apply({ kind: 'text_delta', msgId: 'm1', blockIdx: 0, text: ' beta', parentToolUseId: 'A' });
  assert.equal(subDetails.open, false, 'a user-collapsed turn section survives the next child event');
  assert.ok(subDetails.textContent.includes('beta'), 'the new text still landed inside the turn section');
});

test('T4: the four collapse surfaces are independent and all sticky', async () => {
  const { conversationEl, Conversation } = await setupDOM();
  const conversation = new Conversation(conversationEl, {});

  conversation.apply({ kind: 'tool_use_start', msgId: 'm0', blockIdx: 0, toolUseId: 'A', name: 'Agent', parentToolUseId: null });
  conversation.apply({
    kind: 'tool_use', msgId: 'm0', blockIdx: 0, toolUseId: 'A', name: 'Agent',
    input: { description: 'search', prompt: 'go' }, parentToolUseId: null,
  });
  conversation.apply({ kind: 'text_delta', msgId: 'm1', blockIdx: 0, text: 'child one', parentToolUseId: 'A' });
  conversation.apply({ kind: 'tool_result', toolUseId: 'A', content: 'done', isError: false, parentToolUseId: null });

  const { balloon, argsDetails, subDetails, resultDetails } = surfaces(conversation, 'A');
  const nodes = [['balloon', balloon], ['tool_args', argsDetails], ['turn section', subDetails], ['tool_result', resultDetails]];
  for (const [label, n] of nodes) {
    assert.ok(n, `${label} surface exists`);
    // All four must be real <details> — an independence claim is empty if one
    // of them is a plain <div> whose `.open` is just an inert JS property.
    assert.equal(n.tagName, 'DETAILS', `${label} is an independently collapsible <details>`);
  }
  assert.equal(new Set(nodes.map(([, n]) => n)).size, 4, 'all four surfaces are distinct nodes');

  for (const [, n] of nodes) n.open = true;

  subDetails.open = false;
  assert.equal(balloon.open, true, 'collapsing the turn section leaves the balloon open');
  assert.equal(argsDetails.open, true, 'collapsing the turn section leaves tool_args open');
  assert.equal(resultDetails.open, true, 'collapsing the turn section leaves tool_result open');

  subDetails.open = true;
  argsDetails.open = false;
  assert.equal(balloon.open, true, 'collapsing tool_args leaves the balloon open');
  assert.equal(subDetails.open, true, 'collapsing tool_args leaves the turn section open');
  assert.equal(resultDetails.open, true, 'collapsing tool_args leaves tool_result open');

  // All four states must survive a further live sub-agent event — including a
  // balloon the user has collapsed after the result already attached.
  balloon.open = false;
  conversation.apply({ kind: 'text_delta', msgId: 'm3', blockIdx: 0, text: 'child two', parentToolUseId: 'A' });
  assert.equal(balloon.open, false, 'a collapsed balloon stays collapsed through a later child event');
  assert.equal(argsDetails.open, false, 'tool_args state unchanged by a later child event');
  assert.equal(subDetails.open, true, 'turn-section state unchanged by a later child event');
  assert.equal(resultDetails.open, true, 'tool_result state unchanged by a later child event');
  assert.ok(subDetails.textContent.includes('child two'), 'the later child event still rendered');
});
