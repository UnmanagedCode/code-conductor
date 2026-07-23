// DOM-level tests for the lazy-loaded older-history path (public/
// lazyHistory.js): a fetched page of archived events is rendered through a
// fresh Conversation instance (the standard block-rendering pipeline — no
// parallel renderer) on a detached node, then spliced above the live
// conversation via spliceBatchAbove — which also merges seam-adjacent
// assistant bubbles (quiescent pages can start/end mid-turn) and adopts
// parked sub-agent events. Mirrors the happy-dom setup in rendering.test.mjs.

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
  const { renderEventBatch, prependBatch, spliceBatchAbove } =
    await import(pathToFileURL(path.join(PUB, 'lazyHistory.js')).href);

  document.body.innerHTML = '<div id="root"></div>';
  const root = document.getElementById('root');
  return { window, document, root, Conversation, renderEventBatch, prependBatch, spliceBatchAbove };
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
  const batch = renderEventBatch(archivePage());

  assert.equal(batch.holder.querySelector('.empty'), null, 'no placeholder transplanted');
  const userMsg = batch.holder.querySelector('.msg.user');
  assert.ok(userMsg, 'user bubble rendered');
  assert.ok(userMsg.textContent.includes('old prompt'));
  const assistant = batch.holder.querySelector('.msg.assistant');
  assert.ok(assistant, 'assistant wrap rendered');
  assert.ok(assistant.querySelector('.block.tool-use, .tool-use, [class*="tool"]'),
    'tool block rendered through the standard path');
  assert.ok(assistant.textContent.includes('archived reply'));
  // Merge metadata: this page begins on a turn boundary (leadingWrap null)
  // and ends with an open assistant segment (trailingOpenWrap set).
  assert.equal(batch.leadingWrap, null, 'page starting at an echo has no leading wrap');
  assert.ok(batch.trailingOpenWrap, 'page ending mid-segment exposes its open wrap');
  assert.ok(batch.toolBlocks.has('tuOld'), 'batch tool blocks exposed for adoption');
});

test('archive bubbles use the server-stamped userIndex for rewind/fork', async () => {
  const { renderEventBatch } = await setupDOM();
  const clicks = [];
  const batch = renderEventBatch(archivePage(), {
    onRewind: (i) => clicks.push(['rewind', i]),
    onFork: (i) => clicks.push(['fork', i]),
  });
  const bubble = batch.holder.querySelector('.msg.user');
  assert.equal(bubble.getAttribute('data-user-index'), '3', 'absolute stamp, not a local count');
  bubble.querySelector('.user-msg-rewind').click();
  bubble.querySelector('.user-msg-fork').click();
  assert.deepEqual(clicks, [['rewind', 3], ['fork', 3]]);
});

test('an echo without userIndex renders, but offers no rewind/fork buttons', async () => {
  const { renderEventBatch } = await setupDOM();
  const batch = renderEventBatch(
    [{ kind: 'user_echo', text: 'orphan echo', _seq: 20, parentToolUseId: null }],
    { onRewind: () => {}, onFork: () => {} },
  );
  const bubble = batch.holder.querySelector('.msg.user');
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

  const batch = renderEventBatch(archivePage());
  prependBatch(root, batch.holder, sentinel);

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
  const batch = renderEventBatch([
    { kind: 'user_echo', text: 'run task', userIndex: 0, _seq: 0, parentToolUseId: null },
    { kind: 'tool_use_start', msgId: 'm1', blockIdx: 0, toolUseId: 'tu1', name: 'Agent', _seq: 1, parentToolUseId: null },
    { kind: 'tool_use', msgId: 'm1', blockIdx: 0, toolUseId: 'tu1', name: 'Agent', input: {}, _seq: 2, parentToolUseId: null },
    { kind: 'text_delta', msgId: 'msub', blockIdx: 0, text: 'sub-agent reply', _seq: 3, parentToolUseId: 'tu1' },
    { kind: 'text_end', msgId: 'msub', blockIdx: 0, _seq: 4, parentToolUseId: 'tu1' },
    { kind: 'tool_result', toolUseId: 'tu1', content: 'done', isError: false, _seq: 5, parentToolUseId: null },
  ]);
  const holder = batch.holder;

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

// --- Quiescent seams + bubble merge (the split-assistant-bubble defect) -----

function seq(events) { events.forEach((e, i) => { e._seq = i; }); return events; }

// Three turns; the middle one is far longer than the page limit below, so its
// quiescent-aligned pages start/end mid-turn — the seam bubbles must merge
// back into ONE assistant bubble per turn.
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

// Page backward through the REAL pageInstanceEvents and splice each page
// above, exactly as wsRouter + lazyHistory do — including the merge chain.
async function pageBackAndSplice({ root, main, inst, fromSeq, renderEventBatch, spliceBatchAbove, limit = 6 }) {
  let oldestLeadingWrap = main.leadingAssistantWrap ?? null;
  let before = fromSeq;
  for (let guard = 0; guard < 30; guard++) {
    const page = await pageInstanceEvents(inst, { before, limit });
    if (!page.events.length) break;
    const batch = renderEventBatch(page.events, {});
    oldestLeadingWrap = spliceBatchAbove({
      root, batch, anchorNode: null, conversation: main, oldestLeadingWrap,
    });
    before = page.nextBefore;
    if (!page.hasMore) break;
  }
}

test('a turn straddling quiescent page seams merges back into ONE assistant bubble, blocks in order', async () => {
  const { root, Conversation, renderEventBatch, spliceBatchAbove } = await setupDOM();
  const ring = longHistoryRing();
  const tailStart = ring.findIndex(e => e.kind === 'user_echo' && e.text === 'prompt 2');
  // Minimal duck-typed instance: ring-only paging (trimmedBefore 0 ⇒ the
  // archive branch never engages, no fs access).
  const inst = {
    ringSnapshot: () => ring,
    ring: { trimmedBefore: 0 },
    sessionId: null, cwd: null, _userEchoCount: 3,
  };

  const main = new Conversation(root, {});
  for (const e of ring.slice(tailStart)) main.apply(e);
  await pageBackAndSplice({
    root, main, inst, fromSeq: ring[tailStart]._seq, renderEventBatch, spliceBatchAbove,
  });

  // One bubble per turn — the long turn's mid-turn seams merged away.
  assert.equal(root.querySelectorAll('.msg.assistant').length, 3, 'one assistant bubble per turn');
  assert.equal(root.querySelectorAll('.msg.user').length, 3);
  const text = root.textContent;
  assert.ok(text.indexOf('prompt 0') < text.indexOf('prompt 1'), 'pages spliced in order');
  assert.ok(text.indexOf('prompt 1') < text.indexOf('prompt 2'));
  // Merged bubble preserves chronological block order: thinking → tool →
  // text parts 0..9.
  const turn1 = [...root.querySelectorAll('.msg.assistant')]
    .find(n => n.textContent.includes('pondering hard'));
  const t1 = turn1.textContent;
  assert.ok(t1.indexOf('pondering hard') < t1.indexOf('ls'), 'thinking before tool');
  for (let i = 0; i < 9; i++) {
    assert.ok(t1.indexOf(`part ${i} `) < t1.indexOf(`part ${i + 1} `), `part ${i} before part ${i + 1}`);
  }
  // Every block finalized — nothing stuck streaming at a seam.
  assert.match(root.querySelector('.block.thinking summary').textContent,
    /^thinking \(\d+ chars\)$/, 'thinking block finalized');
  assert.ok(!text.includes('streaming…'), 'no tool stuck streaming');
  assert.ok(root.querySelector('.block.tool .tool-status').textContent.includes('done'),
    'tool result attached within its page');
});

test('no merge across a turn boundary — adjacent turns keep separate bubbles', async () => {
  const { root, Conversation, renderEventBatch, spliceBatchAbove } = await setupDOM();
  const main = new Conversation(root, {});
  // Live chunk starts at an echo → no leading wrap → no merge target.
  main.apply({ kind: 'user_echo', text: 'turn B', userIndex: 1, _seq: 10, parentToolUseId: null });
  main.apply({ kind: 'text_delta', msgId: 'mB', blockIdx: 0, text: 'reply B', _seq: 11, parentToolUseId: null });
  assert.equal(main.leadingAssistantWrap, null);

  // The page above ends with an open assistant segment (turn_end does not
  // close it) — still must NOT merge across the boundary.
  const batch = renderEventBatch(seq([
    { kind: 'user_echo', text: 'turn A', userIndex: 0, parentToolUseId: null },
    { kind: 'text_delta', msgId: 'mA', blockIdx: 0, text: 'reply A', parentToolUseId: null },
    { kind: 'text_end', msgId: 'mA', blockIdx: 0, parentToolUseId: null },
    { kind: 'turn_end', subtype: 'success', parentToolUseId: null },
  ]));
  spliceBatchAbove({ root, batch, conversation: main, oldestLeadingWrap: main.leadingAssistantWrap });

  assert.equal(root.querySelectorAll('.msg.assistant').length, 2, 'two turns, two bubbles');
  const text = root.textContent;
  assert.ok(text.indexOf('reply A') < text.indexOf('turn B'));
});

test('history_gap renders a divider and blocks merging across the gap', async () => {
  const { root, Conversation, renderEventBatch, spliceBatchAbove } = await setupDOM();
  const main = new Conversation(root, {});
  // The below chunk BEGINS with the gap marker (page carrying the ring head):
  // the divider closes the segment before any wrap → no merge target.
  main.apply({ kind: 'history_gap' });
  main.apply({ kind: 'text_delta', msgId: 'mR', blockIdx: 5, text: 'surviving tail of turn', _seq: 50, parentToolUseId: null });
  main.apply({ kind: 'text_end', msgId: 'mR', blockIdx: 5, _seq: 51, parentToolUseId: null });

  const divider = root.querySelector('.history-divider.history-gap');
  assert.ok(divider, 'gap divider rendered');
  assert.ok(divider.textContent.includes('earlier messages unavailable'));
  assert.equal(main.leadingAssistantWrap, null, 'gap is a merge barrier');

  // The chunk above (the same turn's surviving head, ending mid-turn) must
  // NOT glue onto content across genuinely missing events.
  const batch = renderEventBatch(seq([
    { kind: 'user_echo', text: 'giant prompt', userIndex: 0, parentToolUseId: null },
    { kind: 'text_delta', msgId: 'mA', blockIdx: 0, text: 'turn head', parentToolUseId: null },
    { kind: 'text_end', msgId: 'mA', blockIdx: 0, parentToolUseId: null },
  ]));
  spliceBatchAbove({ root, batch, conversation: main, oldestLeadingWrap: main.leadingAssistantWrap });
  assert.equal(root.querySelectorAll('.msg.assistant').length, 2,
    'separate bubbles on either side of the gap');
  const text = root.textContent;
  assert.ok(text.indexOf('turn head') < text.indexOf('earlier messages unavailable'));
  assert.ok(text.indexOf('earlier messages unavailable') < text.indexOf('surviving tail'));
});

test('a batch with genuinely dangling content (interrupted turn / trim plain-cut) finalizes its visuals', async () => {
  const { renderEventBatch } = await setupDOM();
  // No thinking_end / text_end / tool_result — the finalizing events never
  // existed (hard interrupt) or were evicted (plain-cut last resort).
  const batch = renderEventBatch(seq([
    { kind: 'user_echo', text: 'gap prompt', userIndex: 0, parentToolUseId: null },
    { kind: 'thinking_start', msgId: 'mg', blockIdx: 0, parentToolUseId: null },
    { kind: 'thinking_delta', msgId: 'mg', blockIdx: 0, text: 'cut off mid', parentToolUseId: null },
    { kind: 'system', subtype: 'thinking_tokens', data: { estimated_tokens: 512 }, parentToolUseId: null },
    { kind: 'text_delta', msgId: 'mg', blockIdx: 1, text: 'partial reply', parentToolUseId: null },
    { kind: 'tool_use_start', msgId: 'mg', blockIdx: 2, toolUseId: 'tu_gap', name: 'Bash', parentToolUseId: null },
  ]));
  const holder = batch.holder;
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

  const batch = renderEventBatch(
    [{ kind: 'user_echo', text: 'old prompt', userIndex: 0, _seq: 1, parentToolUseId: null }]);
  prependBatch(root, batch.holder, null);

  const text = root.textContent;
  assert.ok(text.indexOf('old prompt') < text.indexOf('newer prompt'));
});

// --- Live sub-agent orphans: park, adopt on prepend, continue natively ------

// Live child events arrive as finals-only envelopes (whole assistant_message
// per content-block part + tool_result), interleaved with the outer stream.
function parkedChildParts() {
  return [
    { kind: 'assistant_message', msgId: 'cm1', _seq: 100, parentToolUseId: 'T',
      message: { id: 'cm1', content: [{ type: 'text', text: 'nested part one' }] } },
    { kind: 'assistant_message', msgId: 'cm1', _seq: 102, parentToolUseId: 'T',
      message: { id: 'cm1', content: [{ type: 'tool_use', id: 'ct1', name: 'Bash', input: { command: 'pwd' } }] } },
    { kind: 'tool_result', toolUseId: 'ct1', content: '/root', isError: false, _seq: 104, parentToolUseId: 'T' },
  ];
}

test('live child events with an unknown parent are parked, never leaked to the outer level', async () => {
  const { root, Conversation } = await setupDOM();
  const main = new Conversation(root, {});
  main.apply({ kind: 'user_echo', text: 'tail prompt', userIndex: 5, _seq: 90, parentToolUseId: null });
  for (const ev of parkedChildParts()) main.apply(ev);
  // A child user_echo is the historical leak — must also park, not render.
  main.apply({ kind: 'user_echo', text: 'child wake', _seq: 106, parentToolUseId: 'T' });

  assert.equal(root.querySelectorAll('.msg.user').length, 1, 'no fake outer user bubble');
  assert.ok(!root.textContent.includes('nested part one'), 'child content not rendered at outer level');
  assert.ok(!root.textContent.includes('/root'), 'no floating child tool_result');
  assert.equal(main.orphanChildEvents.get('T').length, 4, 'all four child events parked in order');
});

test('adopt-on-prepend reconstructs interleaved nested block parts whole, then updates natively', async () => {
  const { root, Conversation, renderEventBatch, spliceBatchAbove } = await setupDOM();
  const main = new Conversation(root, {});
  // Tail: an unrelated turn, plus live child parts for the below-tail head T
  // arriving interleaved with outer live events.
  main.apply({ kind: 'user_echo', text: 'tail prompt', userIndex: 5, _seq: 90, parentToolUseId: null });
  const parts = parkedChildParts();
  main.apply({ kind: 'text_delta', msgId: 'mT', blockIdx: 0, text: 'outer tail reply ', _seq: 95, parentToolUseId: null });
  main.apply(parts[0]);
  main.apply({ kind: 'text_delta', msgId: 'mT', blockIdx: 0, text: 'continues', _seq: 101, parentToolUseId: null });
  main.apply(parts[1]);
  main.apply({ kind: 'text_end', msgId: 'mT', blockIdx: 0, _seq: 103, parentToolUseId: null });
  main.apply(parts[2]);

  // The lazy page brings the Agent head's turn in.
  const batch = renderEventBatch(seq([
    { kind: 'user_echo', text: 'task prompt', userIndex: 4, parentToolUseId: null },
    { kind: 'tool_use_start', msgId: 'mH', blockIdx: 0, toolUseId: 'T', name: 'Agent', parentToolUseId: null },
    { kind: 'tool_use', msgId: 'mH', blockIdx: 0, toolUseId: 'T', name: 'Agent', input: { description: 'bg' }, parentToolUseId: null },
    { kind: 'tool_result', toolUseId: 'T', content: 'running in background', isError: false, parentToolUseId: null },
    { kind: 'turn_end', subtype: 'success', parentToolUseId: null },
  ]));
  spliceBatchAbove({ root, batch, conversation: main, oldestLeadingWrap: main.leadingAssistantWrap });

  // Parked events replayed in arrival order into the parent's nested panel.
  assert.equal(main.orphanChildEvents.size, 0, 'parking drained on adoption');
  const subConv = root.querySelector('.sub-conversation');
  assert.ok(subConv && !subConv.hasAttribute('hidden'), 'nested panel revealed on adoption');
  assert.ok(subConv.textContent.includes('nested part one'), 'nested text part rendered whole');
  assert.ok(subConv.textContent.includes('pwd'), 'nested tool part rendered');
  const subTool = subConv.querySelector('.block.tool .tool-status');
  assert.ok(subTool.textContent.includes('done'),
    `nested tool resolved by its parked result (got "${subTool.textContent}")`);
  const sc = subConv.textContent;
  assert.ok(sc.indexOf('nested part one') < sc.indexOf('pwd'), 'nested parts in arrival order');

  // Incremental continuation: a further live child part routes natively into
  // the SAME nested panel — no re-park, no second sub-conversation.
  main.apply({ kind: 'assistant_message', msgId: 'cm2', _seq: 108, parentToolUseId: 'T',
    message: { id: 'cm2', content: [{ type: 'text', text: 'post-adopt part' }] } });
  assert.equal(main.orphanChildEvents.size, 0, 'no re-parking after adoption');
  // Exactly one REVEALED nested panel (every tool block owns a hidden one).
  assert.equal([...root.querySelectorAll('.sub-conversation')]
    .filter(n => !n.hasAttribute('hidden')).length, 1);
  assert.ok(subConv.textContent.includes('post-adopt part'), 'new part appended incrementally');
});

test('adopt-on-prepend renders a parked event under a non-Task head as ordinary top-level content, not nested', async () => {
  // Same production bug shape as the live case, but via the lazy-load path:
  // a mistagged tool_result (parentToolUseId equal to its OWN toolUseId)
  // arrives live before its own tool_use head has been paged in, so it parks
  // as an orphan awaiting toolUseId 'B'. When the lazy page later brings that
  // head in, it turns out to be a plain Bash block, not a Task — the parked
  // event must render as the Bash call's own result, not get nested into a
  // sub-agent panel (or silently dropped).
  const { root, Conversation, renderEventBatch, spliceBatchAbove } = await setupDOM();
  const main = new Conversation(root, {});
  main.apply({ kind: 'user_echo', text: 'tail prompt', userIndex: 5, _seq: 90, parentToolUseId: null });
  main.apply({
    kind: 'tool_result', toolUseId: 'B', content: '# tests 45\n# pass 45\n# fail 0', isError: false,
    _seq: 95, parentToolUseId: 'B',
  });
  assert.equal(main.orphanChildEvents.get('B').length, 1, 'parked awaiting the Bash head');

  const batch = renderEventBatch(seq([
    { kind: 'user_echo', text: 'earlier prompt', userIndex: 4, parentToolUseId: null },
    { kind: 'tool_use_start', msgId: 'mH', blockIdx: 0, toolUseId: 'B', name: 'Bash', parentToolUseId: null },
    { kind: 'tool_use', msgId: 'mH', blockIdx: 0, toolUseId: 'B', name: 'Bash', input: { command: 'npm test' }, parentToolUseId: null },
  ]));
  spliceBatchAbove({ root, batch, conversation: main, oldestLeadingWrap: main.leadingAssistantWrap });

  assert.equal(main.orphanChildEvents.size, 0, 'parking drained on adoption');
  const revealed = [...root.querySelectorAll('.sub-conversation')].filter((n) => !n.hasAttribute('hidden'));
  assert.equal(revealed.length, 0, 'a Bash head is never a valid sub-agent host');
  const bashBlock = main.toolBlocks.get('B');
  assert.ok(bashBlock, 'Bash block adopted');
  const attached = bashBlock.node.querySelector('.block.tool-result');
  assert.ok(attached, 'tool_result attaches under the Bash block itself, not dropped or nested');
  assert.match(attached.textContent, /# pass 45/);
});
