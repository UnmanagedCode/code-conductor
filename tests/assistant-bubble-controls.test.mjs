// Tests for the raw/md + copy controls on assistant bubbles: what copy yields
// (text blocks' source in stream order + the closing plan card's body), what
// raw flips, that the controls are live mid-stream, and that they behave the
// same live, in a snapshot replay, in a lazy page and across a page seam.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { assertNull } from './dom-assert.mjs';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { Window } from 'happy-dom';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const PUB = path.resolve(__dirname, '..', 'public');

globalThis.AudioContext = class {
  constructor() { this.currentTime = 0; this.destination = {}; }
  resume() { return Promise.resolve(); }
  createBufferSource() { return { connect() {}, start() {}, onended: null, buffer: null }; }
  decodeAudioData() { return Promise.resolve({ duration: 0.1 }); }
};
globalThis.fetch = async () => ({
  ok: true,
  body: { getReader: () => ({ read: async () => ({ done: true, value: undefined }) }) },
});

const { setTtsAvailable } = await import(pathToFileURL(path.join(PUB, 'tts.js')).href);

function setupDOM() {
  const win = new Window({ url: 'http://localhost/' });
  globalThis.window = win;
  globalThis.document = win.document;
  globalThis.HTMLElement = win.HTMLElement;
  globalThis.Element = win.Element;
  globalThis.Node = win.Node;
  globalThis.MutationObserver = win.MutationObserver;
  return win;
}

// Stubs navigator.clipboard.writeText, recording every call into `copied`.
// `reject` makes every write fail. Returns restore() for the original.
function stubClipboard({ reject = false } = {}) {
  const copied = [];
  const orig = Object.getOwnPropertyDescriptor(globalThis, 'navigator');
  Object.defineProperty(globalThis, 'navigator', {
    value: {
      clipboard: {
        writeText: async (t) => {
          copied.push(t);
          if (reject) throw new Error('denied');
        },
      },
    },
    configurable: true,
  });
  const restore = () => {
    if (orig) Object.defineProperty(globalThis, 'navigator', orig);
  };
  return { copied, restore };
}

let uid = 0;
async function importConversation() {
  uid++;
  const { Conversation } =
    await import(pathToFileURL(path.join(PUB, 'conversation.js')).href + `?uid=${uid}`);
  return Conversation;
}

async function importLazy() {
  return import(pathToFileURL(path.join(PUB, 'lazyHistory.js')).href);
}

const flush = () => new Promise(resolve => setTimeout(resolve, 0));

let seqCounter = 0;
const ev = (e) => ({ _seq: ++seqCounter, parentToolUseId: null, ...e });
const text = (msgId, blockIdx, t) => [
  ev({ kind: 'text_delta', msgId, blockIdx, text: t }),
  ev({ kind: 'text_end', msgId, blockIdx }),
];
const thinking = (msgId, blockIdx, t) => [
  ev({ kind: 'thinking_start', msgId, blockIdx }),
  ev({ kind: 'thinking_delta', msgId, blockIdx, text: t }),
  ev({ kind: 'thinking_end', msgId, blockIdx }),
];
const bash = (msgId, blockIdx, id, command, output) => [
  ev({ kind: 'tool_use_start', msgId, blockIdx, toolUseId: id, name: 'Bash' }),
  ev({ kind: 'tool_use', msgId, blockIdx, toolUseId: id, name: 'Bash', input: { command } }),
  ev({ kind: 'tool_result', toolUseId: id, content: output, isError: false }),
];

function fresh(Conversation) {
  const root = document.createElement('div');
  const conv = new Conversation(root, {});
  return { root, conv };
}

// The outermost assistant bubbles of a root (not sub-agent bubbles nested in one).
const bubbles = (root) => [...root.querySelectorAll(':scope > .msg.assistant')];
const ownTextBlocks = (wrap) => [...wrap.querySelectorAll(':scope > .blocks > .block.text')];
const btn = (wrap, which) => wrap.querySelector(`:scope > .role .user-view-${which}`);

async function copyOf(wrap) {
  const { copied, restore } = stubClipboard();
  try {
    btn(wrap, 'copy').click();
    await flush();
    return copied.at(-1);
  } finally {
    restore();
  }
}

test('copy yields every text block\'s source in stream order, joined by a blank line, excluding thinking and tools', async () => {
  setupDOM();
  const Conversation = await importConversation();
  const { root, conv } = fresh(Conversation);
  conv.applyEvents([
    ...text('m1', 0, 'A with **bold**'),
    ...thinking('m1', 1, 'SECRET-THOUGHT'),
    ...bash('m1', 2, 'tu1', 'echo CMD-MARKER', 'OUTPUT-MARKER'),
    ...text('m1', 3, 'B\n\n```js\nconst x = 1;\n```'),
    ...text('m2', 0, 'C'),
  ]);
  const [wrap] = bubbles(root);
  assert.equal(bubbles(root).length, 1, 'one bubble');
  assert.equal(wrap.querySelectorAll('.user-view-controls').length, 1, 'exactly one control pair');
  assert.ok(wrap.querySelector(':scope > .role > .user-view-controls'), 'in the role row');

  const got = await copyOf(wrap);
  assert.equal(got, 'A with **bold**\n\nB\n\n```js\nconst x = 1;\n```\n\nC');
  for (const leaked of ['SECRET-THOUGHT', 'CMD-MARKER', 'OUTPUT-MARKER']) {
    assert.ok(!got.includes(leaked), `${leaked} is not in the copy`);
  }
});

test('copy appends the body of the plan card that closes the bubble; the card stays a root-level sibling', async () => {
  setupDOM();
  const Conversation = await importConversation();
  const { root, conv } = fresh(Conversation);
  conv.applyEvents([
    ...text('m1', 0, 'intro'),
    ev({ kind: 'tool_use_start', msgId: 'm1', blockIdx: 1, toolUseId: 'plan1', name: 'ExitPlanMode' }),
    ev({ kind: 'tool_use', msgId: 'm1', blockIdx: 1, toolUseId: 'plan1', name: 'ExitPlanMode', input: { plan: '# The plan' } }),
    ev({ kind: 'plan_request', toolUseId: 'plan1', plan: '# The plan' }),
    ...text('m2', 0, 'after the card'),
  ]);
  const [first, second] = bubbles(root);
  assert.equal(bubbles(root).length, 2, 'the card closes the first bubble');
  assert.ok(first.nextElementSibling.classList.contains('plan-request'), 'card stays the wrap\'s next sibling');
  assert.equal(await copyOf(first), 'intro\n\n# The plan');
  assert.equal(await copyOf(second), 'after the card', 'the next bubble does not include the plan');

  // A null or blank plan attaches nothing.
  const { root: root2, conv: conv2 } = fresh(Conversation);
  conv2.applyEvents([
    ...text('m1', 0, 'only text'),
    ev({ kind: 'plan_request', toolUseId: 'p1', plan: null }),
    ...text('m2', 0, 'next'),
    ev({ kind: 'plan_request', toolUseId: 'p2', plan: '   \n' }),
  ]);
  const [a, b] = bubbles(root2);
  assert.equal(await copyOf(a), 'only text');
  assert.equal(await copyOf(b), 'next');
});

test('a plan card with no assistant bubble before it is in no copy', async () => {
  setupDOM();
  const Conversation = await importConversation();
  const { root, conv } = fresh(Conversation);
  conv.applyEvents([
    ev({ kind: 'user_echo', text: 'go', userIndex: 0 }),
    ev({ kind: 'plan_request', toolUseId: 'p1', plan: 'ORPHAN-PLAN' }),
    ...text('m1', 0, 'X'),
  ]);
  const wraps = bubbles(root);
  assert.equal(wraps.length, 1, 'only the later text opens a bubble');
  assert.equal(wraps[0].querySelectorAll('.user-view-controls').length, 1);
  assert.equal(await copyOf(wraps[0]), 'X');
});

test('blank text blocks contribute nothing to copy', async () => {
  setupDOM();
  const Conversation = await importConversation();
  const { root, conv } = fresh(Conversation);
  conv.applyEvents([
    ...text('m1', 0, 'A'),
    ...text('m1', 1, ''),
    ...text('m1', 2, ' \n\t '),
    ...text('m1', 3, 'B'),
  ]);
  const [wrap] = bubbles(root);
  assert.equal(ownTextBlocks(wrap).length, 4, 'the blank blocks are in the bubble');
  assert.equal(await copyOf(wrap), 'A\n\nB');

  // A sub-agent's reconciled empty text block is blank the same way.
  const { root: root2, conv: conv2 } = fresh(Conversation);
  conv2.applyEvents([
    ev({ kind: 'tool_use_start', msgId: 'm1', blockIdx: 0, toolUseId: 'tuA', name: 'Agent' }),
    ev({ kind: 'tool_use', msgId: 'm1', blockIdx: 0, toolUseId: 'tuA', name: 'Agent', input: { description: 'sub' } }),
    ev({
      kind: 'assistant_message', msgId: 'ms', parentToolUseId: 'tuA',
      message: { content: [{ type: 'text', text: 'S1' }, { type: 'text', text: '' }, { type: 'text', text: 'S2' }] },
    }),
  ]);
  const sub = root2.querySelector('.sub-conversation-body .msg.assistant');
  assert.equal(ownTextBlocks(sub).length, 3, 'the empty sub-agent block is in the bubble');
  assert.equal(await copyOf(sub), 'S1\n\nS2');
});

test('a bubble of only tool blocks, closed by a plan card, gains controls and copies the plan', async () => {
  setupDOM();
  const Conversation = await importConversation();
  const { root, conv } = fresh(Conversation);
  conv.applyEvents([
    ev({ kind: 'tool_use_start', msgId: 'm1', blockIdx: 0, toolUseId: 'plan1', name: 'ExitPlanMode' }),
    ev({ kind: 'tool_use', msgId: 'm1', blockIdx: 0, toolUseId: 'plan1', name: 'ExitPlanMode', input: { plan: '# Only a plan' } }),
    ev({ kind: 'plan_request', toolUseId: 'plan1', plan: '# Only a plan' }),
  ]);
  const wraps = bubbles(root);
  assert.equal(wraps.length, 1);
  assert.equal(ownTextBlocks(wraps[0]).length, 0, 'the bubble holds no text block');
  assert.equal(wraps[0].querySelectorAll(':scope > .role > .user-view-controls').length, 1);
  assert.equal(await copyOf(wraps[0]), '# Only a plan');
});

test('question cards and sub-agent output are excluded; a sub-agent bubble has its own controls', async () => {
  setupDOM();
  const Conversation = await importConversation();
  const { root, conv } = fresh(Conversation);
  conv.applyEvents([
    ...text('m1', 0, 'A'),
    ev({ kind: 'tool_use_start', msgId: 'm1', blockIdx: 1, toolUseId: 'tuA', name: 'Agent' }),
    ev({ kind: 'tool_use', msgId: 'm1', blockIdx: 1, toolUseId: 'tuA', name: 'Agent', input: { description: 'sub' } }),
    ev({
      kind: 'assistant_message', msgId: 'ms', parentToolUseId: 'tuA',
      message: { content: [{ type: 'text', text: 'S' }] },
    }),
    ...text('m1', 2, 'B'),
    ev({
      kind: 'user_question', toolUseId: 'q1',
      questions: [{ question: 'QUESTION-MARKER?', header: 'h', options: [{ label: 'x', description: 'y' }, { label: 'z', description: 'w' }] }],
    }),
  ]);
  const [outer] = bubbles(root);
  assert.equal(await copyOf(outer), 'A\n\nB');

  const sub = outer.querySelector('.sub-conversation-body .msg.assistant');
  assert.ok(sub, 'sub-agent bubble rendered');
  assert.ok(sub.querySelector(':scope > .role > .user-view-controls'), 'sub-agent bubble has its own controls');
  assert.equal(await copyOf(sub), 'S');
});

test('raw flips every text block in the bubble together, including one that arrives later', async () => {
  setupDOM();
  const Conversation = await importConversation();
  const { root, conv } = fresh(Conversation);
  conv.applyEvents([
    ...text('m1', 0, 'one **b1**'),
    ...bash('m1', 1, 'tu1', 'ls', 'out'),
    ...text('m1', 2, 'two **b2**'),
  ]);
  const [wrap] = bubbles(root);
  const toggle = btn(wrap, 'toggle');
  assert.equal(toggle.textContent, 'raw');
  assert.equal(toggle.title, 'Show raw text');

  const expectView = (view, sources) => {
    const blocks = ownTextBlocks(wrap);
    assert.equal(blocks.length, sources.length);
    blocks.forEach((b, i) => {
      assert.equal(b.dataset.view, view);
      if (view === 'raw') {
        assert.ok(!b.classList.contains('md'), 'raw drops .md');
        assert.equal(b.textContent, sources[i]);
        assertNull(b.querySelector('strong'), 'no rendered markup in raw');
      } else {
        assert.ok(b.classList.contains('md'), 'rendered has .md');
        assert.ok(b.querySelector('strong'), 'rendered markup present');
      }
    });
  };

  toggle.click();
  assert.equal(toggle.textContent, 'md');
  assert.equal(toggle.title, 'Show rendered markdown');
  expectView('raw', ['one **b1**', 'two **b2**']);

  // A block streaming in while the bubble is raw shows raw deltas, then finalizes raw.
  conv.applyEvents([...text('m1', 3, 'three **b3**')]);
  expectView('raw', ['one **b1**', 'two **b2**', 'three **b3**']);

  toggle.click();
  assert.equal(toggle.textContent, 'raw');
  assert.equal(toggle.title, 'Show raw text');
  expectView('rendered', ['one **b1**', 'two **b2**', 'three **b3**']);
});

test('raw leaves thinking, tool and action-group nodes untouched', async () => {
  setupDOM();
  const Conversation = await importConversation();
  const { root, conv } = fresh(Conversation);
  conv.applyEvents([
    ...text('m1', 0, 'lead **x**'),
    ...thinking('m1', 1, 'pondering'),
    ...bash('m1', 2, 'tu1', 'ls -la', 'total 0'),
    ...text('m1', 3, 'tail'),
  ]);
  const [wrap] = bubbles(root);
  const group = wrap.querySelector(':scope > .blocks > .action-group');
  assert.ok(group, 'action group present');
  const before = group.outerHTML;
  btn(wrap, 'toggle').click();
  assert.equal(group.outerHTML, before, 'unchanged after switching to raw');
  btn(wrap, 'toggle').click();
  assert.equal(group.outerHTML, before, 'unchanged after switching back');
});

test('controls are live mid-stream: copy yields the text streamed so far, and a block streaming in a raw bubble finalizes raw', async () => {
  setupDOM();
  const Conversation = await importConversation();
  const { root, conv } = fresh(Conversation);
  conv.apply(ev({ kind: 'text_delta', msgId: 'm1', blockIdx: 0, text: 'par' }));
  conv.apply(ev({ kind: 'text_delta', msgId: 'm1', blockIdx: 0, text: 'tial **x**' }));
  const [wrap] = bubbles(root);
  assert.ok(btn(wrap, 'copy'), 'controls exist before text_end');
  assert.equal(await copyOf(wrap), 'partial **x**');

  btn(wrap, 'toggle').click();
  conv.apply(ev({ kind: 'text_end', msgId: 'm1', blockIdx: 0 }));
  const [block] = ownTextBlocks(wrap);
  assert.equal(block.dataset.view, 'raw');
  assert.equal(block.textContent, 'partial **x**');
  assert.ok(!block.classList.contains('md'));
});

test('the 🔊 button survives a view switch', async () => {
  setupDOM();
  setTtsAvailable(true);
  try {
    const Conversation = await importConversation();
    const { root, conv } = fresh(Conversation);
    conv.applyEvents([...text('m1', 0, 'speak **me**')]);
    const [wrap] = bubbles(root);
    const [block] = ownTextBlocks(wrap);
    assert.equal(block.querySelectorAll('.tts-speak').length, 1, 'button after finalize');
    btn(wrap, 'toggle').click();
    assert.equal(block.querySelectorAll('.tts-speak').length, 1, 'button after switching to raw');
    btn(wrap, 'toggle').click();
    assert.equal(block.querySelectorAll('.tts-speak').length, 1, 'button after switching back');
  } finally {
    setTtsAvailable(false);
  }
});

test('assistant controls survive segment retirement and stay enabled during a running turn', async () => {
  setupDOM();
  const Conversation = await importConversation();
  const root = document.createElement('div');
  const conv = new Conversation(root, { onRewind() {}, onFork() {} });
  conv.segmentId = 'A';
  conv.setCurrentSegment('A');
  conv.applyEvents([
    ev({ kind: 'user_echo', text: 'hi', userIndex: 0 }),
    ...text('m1', 0, 'reply'),
  ]);
  const [wrap] = bubbles(root);
  assert.ok(btn(wrap, 'toggle'));

  conv.setCurrentSegment('B'); // retires segment A
  conv.setUserActionsEnabled(false);
  assert.ok(btn(wrap, 'toggle') && btn(wrap, 'copy'), 'controls survive retirement');
  // Found by structure, not by the .user-view-btn class: a control classed
  // `user-msg-action` would be disabled by setUserActionsEnabled and must not
  // vanish from this loop.
  const viewButtons = [...wrap.querySelectorAll(':scope > .role > .user-view-controls > button')];
  assert.equal(viewButtons.length, 2, 'toggle and copy are both found');
  for (const b of viewButtons) {
    assert.equal(b.disabled, false, 'view buttons stay enabled during a running turn');
  }

  let bubbled = 0;
  wrap.addEventListener('click', () => { bubbled++; });
  const { restore } = stubClipboard();
  try {
    btn(wrap, 'toggle').click();
    btn(wrap, 'copy').click();
    await flush();
  } finally {
    restore();
  }
  assert.equal(bubbled, 0, 'clicks do not propagate to the bubble');
});

test('copy flashes copied, and failed when the clipboard rejects', async () => {
  setupDOM();
  const Conversation = await importConversation();
  const { root, conv } = fresh(Conversation);
  conv.applyEvents([...text('m1', 0, 'hello')]);
  const [wrap] = bubbles(root);
  const copy = btn(wrap, 'copy');

  let stub = stubClipboard();
  try {
    copy.click();
    await flush();
    assert.equal(copy.textContent, 'copied');
    assert.ok(copy.classList.contains('copied'));
  } finally {
    stub.restore();
  }

  stub = stubClipboard({ reject: true });
  try {
    copy.click();
    await flush();
    assert.equal(copy.textContent, 'failed');
    assert.ok(copy.classList.contains('failed'));
    assert.ok(!copy.classList.contains('copied'), 'the failed flash replaces the copied class');
  } finally {
    stub.restore();
  }
});

// One event list, three render paths.
const parityEvents = () => [
  ...text('m1', 0, 'first **a**'),
  ...thinking('m1', 1, 'hmm'),
  ...bash('m1', 2, 'tu1', 'ls', 'out'),
  ...text('m1', 3, 'second **b**'),
  ev({ kind: 'plan_request', toolUseId: 'pl1', plan: 'the plan' }),
];

test('snapshot replay and a lazy page render the same controls, copy and toggle as the live stream', async () => {
  setupDOM();
  const Conversation = await importConversation();
  const { renderEventBatch } = await importLazy();

  const live = fresh(Conversation);
  for (const e of parityEvents()) live.conv.apply(e);

  const replay = fresh(Conversation);
  replay.conv.applyEvents(parityEvents());

  const batch = renderEventBatch(parityEvents());
  const lazyRoot = batch.holder;

  const expected = 'first **a**\n\nsecond **b**\n\nthe plan';
  for (const [name, root] of [['live', live.root], ['replay', replay.root], ['lazy page', lazyRoot]]) {
    const [wrap] = bubbles(root);
    assert.equal(wrap.querySelectorAll('.user-view-controls').length, 1, `${name}: one control pair`);
    assert.equal(await copyOf(wrap), expected, `${name}: copy`);
    btn(wrap, 'toggle').click();
    const blocks = ownTextBlocks(wrap);
    assert.equal(blocks.length, 2, `${name}: two text blocks`);
    for (const b of blocks) {
      assert.equal(b.dataset.view, 'raw', `${name}: block flipped`);
      assertNull(b.querySelector('strong'), `${name}: no rendered markup`);
    }
  }
});

test('a bubble split across two lazy pages copies and toggles as one', async (t) => {
  setupDOM();
  const Conversation = await importConversation();
  const { renderEventBatch, spliceBatchAbove } = await importLazy();

  const splice = (lowerEvents, upperEvents, { rawFirst = false } = {}) => {
    const { root, conv } = fresh(Conversation);
    conv.applyEvents(lowerEvents);
    assert.ok(conv.leadingAssistantWrap, 'lower half is a leading wrap');
    if (rawFirst) btn(bubbles(root)[0], 'toggle').click();
    const batch = renderEventBatch(upperEvents);
    spliceBatchAbove({ root, batch, conversation: conv, oldestLeadingWrap: conv.leadingAssistantWrap });
    return root;
  };
  const upper = () => [
    ev({ kind: 'user_echo', text: 'prompt', userIndex: 0 }),
    ...text('mU', 0, 'A **a**'),
    ...bash('mU', 1, 'tuU', 'ls', 'out'),
    ...text('mU', 2, 'B'),
  ];

  const root = splice(
    [...text('mL', 0, 'C'), ...bash('mL', 1, 'tuL', 'pwd', 'out'), ...text('mL', 2, 'D **d**')],
    upper(),
    { rawFirst: true },
  );
  const wraps = bubbles(root);
  assert.equal(wraps.length, 1, 'one merged bubble');
  assert.equal(wraps[0].querySelectorAll('.user-view-controls').length, 1, 'one control pair');
  assert.equal(await copyOf(wraps[0]), 'A **a**\n\nB\n\nC\n\nD **d**');
  const blocks = ownTextBlocks(wraps[0]);
  assert.equal(blocks.length, 4);
  for (const b of blocks) assert.equal(b.dataset.view, 'raw', 'moved blocks take the lower half\'s raw view');
  btn(wraps[0], 'toggle').click();
  for (const b of ownTextBlocks(wraps[0])) {
    assert.equal(b.dataset.view, 'rendered');
    assert.ok(b.classList.contains('md'));
  }

  await t.test('a tool-only lower half gains controls on merge', async () => {
    const root2 = splice(
      bash('mL', 0, 'tuL2', 'pwd', 'out'),
      [
        ev({ kind: 'user_echo', text: 'prompt', userIndex: 0 }),
        ...text('mU', 0, 'A'),
        ...bash('mU', 1, 'tuU2', 'ls', 'out'),
        ...text('mU', 2, 'B'),
      ],
    );
    const merged = bubbles(root2);
    assert.equal(merged.length, 1, 'one merged bubble');
    assert.equal(merged[0].querySelectorAll('.user-view-controls').length, 1);
    assert.equal(await copyOf(merged[0]), 'A\n\nB');
  });
});
