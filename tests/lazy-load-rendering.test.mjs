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
import { pageInstanceEvents } from '../src/eventArchive.js';

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

test('sub-agent group: head and children in the same batch nest children under the tool block sub-conversation', async () => {
  const { renderEventBatch } = await setupDOM();

  // A complete group: tool_use_start + tool_use (head) followed by sub-agent
  // child events (parentToolUseId set), then a tool_result.
  const batch = [
    { kind: 'user_echo', text: 'run task', userIndex: 0, _seq: 0, parentToolUseId: null },
    { kind: 'tool_use_start', msgId: 'm1', blockIdx: 0, toolUseId: 'tu1', name: 'Task', _seq: 1, parentToolUseId: null },
    { kind: 'tool_use', msgId: 'm1', blockIdx: 0, toolUseId: 'tu1', name: 'Task', input: {}, _seq: 2, parentToolUseId: null },
    { kind: 'text_delta', msgId: 'msub', blockIdx: 0, text: 'sub-agent reply', _seq: 3, parentToolUseId: 'tu1' },
    { kind: 'text_end', msgId: 'msub', blockIdx: 0, _seq: 4, parentToolUseId: 'tu1' },
    { kind: 'tool_result', toolUseId: 'tu1', content: 'done', isError: false, _seq: 5, parentToolUseId: null },
  ];

  const holder = renderEventBatch(batch);

  // The sub-conversation container must be present and visible.
  const subConv = holder.querySelector('.sub-conversation');
  assert.ok(subConv, 'sub-conversation container exists under the tool block');
  assert.ok(!subConv.hasAttribute('hidden'), 'sub-conversation is revealed when children arrive');
  // The sub-agent text must be inside the sub-conversation, not orphaned at
  // the outer assistant level.
  assert.ok(subConv.textContent.includes('sub-agent reply'),
    'sub-agent text is nested in sub-conversation, not orphaned at outer level');
  // The outer assistant wrap must NOT directly contain the orphaned text
  // (i.e., it should only be reachable via .sub-conversation).
  const outerBlocks = holder.querySelector('.msg.assistant > .blocks');
  assert.ok(outerBlocks, 'outer assistant blocks container exists');
  // Walk direct block children — none should contain the sub-agent text
  // without going through a .sub-conversation.
  let foundOrphaned = false;
  for (const child of outerBlocks.children) {
    if (!child.classList.contains('sub-conversation') &&
        child.textContent.includes('sub-agent reply') &&
        !child.querySelector('.sub-conversation')) {
      foundOrphaned = true;
    }
  }
  assert.ok(!foundOrphaned, 'sub-agent text is not directly in outer blocks (not orphaned)');
});

// --- Turn-aligned seams (the split-assistant-bubble regression) ------------

function seq(events) { events.forEach((e, i) => { e._seq = i; }); return events; }

// Three turns; the middle one is far longer than the page limit below, so
// before turn-aligned paging it straddled a lazy seam: two assistant bubbles,
// a thinking block stuck un-finalized, a tool head cut from its result.
function longHistoryRing() {
  const ev = [];
  ev.push({ kind: 'user_echo', text: 'prompt 0', userIndex: 0, parentToolUseId: null });
  ev.push({ kind: 'text_delta', msgId: 'm0', blockIdx: 0, text: 'reply 0', parentToolUseId: null });
  ev.push({ kind: 'text_end', msgId: 'm0', blockIdx: 0, parentToolUseId: null });
  ev.push({ kind: 'user_echo', text: 'prompt 1', userIndex: 1, parentToolUseId: null });
  ev.push({ kind: 'thinking_start', msgId: 'm1', blockIdx: 0, parentToolUseId: null });
  ev.push({ kind: 'thinking_delta', msgId: 'm1', blockIdx: 0, text: 'pondering hard', parentToolUseId: null });
  ev.push({ kind: 'thinking_end', msgId: 'm1', blockIdx: 0, parentToolUseId: null });
  ev.push({ kind: 'tool_use_start', msgId: 'm1', blockIdx: 1, toolUseId: 'tu1', name: 'Bash', parentToolUseId: null });
  ev.push({ kind: 'tool_use', msgId: 'm1', blockIdx: 1, toolUseId: 'tu1', name: 'Bash', input: { command: 'ls' }, parentToolUseId: null });
  ev.push({ kind: 'tool_result', toolUseId: 'tu1', content: 'ok', isError: false, parentToolUseId: null });
  for (let i = 0; i < 10; i++) {
    ev.push({ kind: 'text_delta', msgId: 'm1', blockIdx: 2 + i, text: `part ${i} `, parentToolUseId: null });
    ev.push({ kind: 'text_end', msgId: 'm1', blockIdx: 2 + i, parentToolUseId: null });
  }
  ev.push({ kind: 'user_echo', text: 'prompt 2', userIndex: 2, parentToolUseId: null });
  ev.push({ kind: 'text_delta', msgId: 'm2', blockIdx: 0, text: 'reply 2', parentToolUseId: null });
  ev.push({ kind: 'text_end', msgId: 'm2', blockIdx: 0, parentToolUseId: null });
  return seq(ev);
}

test('a turn straddling the old page window renders as ONE assistant bubble with finalized blocks', async () => {
  const { root, Conversation, renderEventBatch, prependBatch } = await setupDOM();
  const ring = longHistoryRing();
  const tailStart = ring.findIndex(e => e.kind === 'user_echo' && e.text === 'prompt 2');
  // Minimal duck-typed instance: ring-only paging (trimmedBefore 0 ⇒ the
  // archive branch never engages, no fs access).
  const inst = {
    ringSnapshot: () => ring,
    ring: { trimmedBefore: 0 },
    sessionId: null, cwd: null, _userEchoCount: 3,
  };

  // Live tail (turn-aligned, as snapshotTail now guarantees) into the main view…
  const main = new Conversation(root, {});
  for (const e of ring.slice(tailStart)) main.apply(e);
  // …then page backward through the REAL pageInstanceEvents and splice each
  // page above, exactly as wsRouter + lazyHistory do. limit=6 is far smaller
  // than the 27-event middle turn.
  let before = ring[tailStart]._seq;
  for (let guard = 0; guard < 20; guard++) {
    const page = await pageInstanceEvents(inst, { before, limit: 6 });
    if (!page.events.length) break;
    prependBatch(root, renderEventBatch(page.events, {}), null);
    before = page.nextBefore;
    if (!page.hasMore) break;
  }

  // One bubble per turn — the long turn did not split at a lazy seam.
  assert.equal(root.querySelectorAll('.msg.assistant').length, 3, 'one assistant bubble per turn');
  assert.equal(root.querySelectorAll('.msg.user').length, 3);
  const text = root.textContent;
  assert.ok(text.indexOf('prompt 0') < text.indexOf('prompt 1'), 'pages spliced in order');
  assert.ok(text.indexOf('prompt 1') < text.indexOf('prompt 2'));
  // Straddle-sensitive blocks are finalized, not stuck streaming.
  assert.match(root.querySelector('.block.thinking summary').textContent,
    /^thinking \(\d+ chars\)$/, 'thinking block finalized');
  assert.ok(!text.includes('streaming…'), 'no tool stuck streaming');
  assert.ok(root.querySelector('.block.tool .tool-status').textContent.includes('done'),
    'tool result attached within its page');
});

test('a batch cut mid-turn (archive gap case) finalizes its dangling visuals', async () => {
  const { renderEventBatch } = await setupDOM();
  // No thinking_end / text_end / tool_use / tool_result — the finalizing
  // events fell into the gap and will never be applied to this batch.
  const holder = renderEventBatch(seq([
    { kind: 'user_echo', text: 'gap prompt', userIndex: 0, parentToolUseId: null },
    { kind: 'thinking_start', msgId: 'mg', blockIdx: 0, parentToolUseId: null },
    { kind: 'thinking_delta', msgId: 'mg', blockIdx: 0, text: 'cut off mid', parentToolUseId: null },
    { kind: 'system', subtype: 'thinking_tokens', data: { estimated_tokens: 512 }, parentToolUseId: null },
    { kind: 'text_delta', msgId: 'mg', blockIdx: 1, text: 'partial reply', parentToolUseId: null },
    { kind: 'tool_use_start', msgId: 'mg', blockIdx: 2, toolUseId: 'tu_gap', name: 'Bash', parentToolUseId: null },
  ]));
  assert.match(holder.querySelector('.block.thinking summary').textContent,
    /^thinking \(\d+ chars\)$/, 'not stuck at "thinking… N tokens"');
  const txt = [...holder.querySelectorAll('.block.text')]
    .find(n => n.textContent.includes('partial reply'));
  assert.ok(txt.classList.contains('md'), 'partial text markdown-finalized');
  assert.equal(holder.querySelector('.block.tool .tool-status').textContent.trim(),
    '· incomplete', 'input-less tool gets a terminal status');
});

test('finalizeDanglingBlocks is idempotent on already-finalized content', async () => {
  const { root, Conversation } = await setupDOM();
  const conv = new Conversation(root, {});
  for (const e of archivePage()) conv.apply(e); // complete turn: real *_end + tool_result
  conv.finalizeDanglingBlocks();
  const rendered = root.innerHTML;
  conv.finalizeDanglingBlocks();
  assert.equal(root.innerHTML, rendered, 'second pass changes nothing');
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
