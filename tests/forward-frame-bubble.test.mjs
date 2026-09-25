// Tests for the send_prompt({forward}) bubble: a user_echo whose text is a
// forward frame (public/forwardFrame.js's parseForwardFrame recognises it)
// renders the forwarded payload as a collapsed <details class="block
// forward-frame"> — built lazily on first expand into one labelled markdown
// section per forwarded message — and the conductor's instruction below it as
// an ordinary user-text block. Shares mountFoldedText / buildUserText with the
// wake-callback bubble — see wake-callback-bubble.test.mjs for the shared
// lazy-build mechanism, which this file does not re-pin.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { assertNull } from './dom-assert.mjs';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { Window } from 'happy-dom';
import { FORWARD_FRAME_HEADER, buildForwardFrame } from '../public/forwardFrame.js';

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

function stubClipboard() {
  const copied = [];
  const orig = Object.getOwnPropertyDescriptor(globalThis, 'navigator');
  Object.defineProperty(globalThis, 'navigator', {
    value: { clipboard: { writeText: async (t) => { copied.push(t); } } },
    configurable: true,
  });
  const restore = () => {
    if (orig) Object.defineProperty(globalThis, 'navigator', orig);
  };
  return { copied, restore };
}

function expand(details) {
  details.querySelector(':scope > summary').click();
}

let uid = 0;
async function importConversation() {
  uid++;
  const { Conversation } =
    await import(pathToFileURL(path.join(PUB, 'conversation.js')).href + `?uid=${uid}`);
  return Conversation;
}

async function render(text) {
  setupDOM();
  const Conversation = await importConversation();
  const root = document.createElement('div');
  const conv = new Conversation(root, {});
  conv.apply({ kind: 'user_echo', text, userIndex: 0 });
  return root;
}

const MESSAGES = [
  'first message with **x**',
  '--- plan · saved to /tmp/plans/demo.md ---\n# Plan: demo\n\n- step one\n- step two',
  '--- questions ---\n1. Q one\n   - opt\n2. Q two',
];
const INSTRUCTION = 'Please review and respond.';
const FRAME = buildForwardFrame({ messages: MESSAGES, instruction: INSTRUCTION });
const PAYLOAD = MESSAGES.map((m, i) => `--- message ${i + 1}/3 ---\n${m}`).join('\n\n');

test('a forward echo renders a collapsed forward-frame bubble with a message count', async (t) => {
  await t.test('three messages', async () => {
    const root = await render(FRAME);
    const wrap = root.querySelector('.msg.user.forward-frame');
    assert.ok(wrap, 'user bubble carries the forward-frame class');
    const details = wrap.querySelector('details.block.forward-frame');
    assert.ok(details, 'payload renders inside a <details class="block forward-frame">');
    assert.equal(details.open, false, 'details is collapsed by default');
    const summary = details.querySelector('summary');
    assert.ok(summary.querySelector('.forward-badge'), 'forward badge present on summary');
    assert.match(summary.textContent, /📨/);
    assert.match(summary.textContent, /Forwarded worker output · 3 messages/);
  });
  await t.test('one message uses the singular', async () => {
    const root = await render(buildForwardFrame({ messages: ['only'], instruction: 'go' }));
    assert.match(root.querySelector('details.block.forward-frame summary').textContent,
      /Forwarded worker output · 1 message$/);
  });
});

test('the forward body is not built until first expand', async () => {
  const root = await render(FRAME);
  const details = root.querySelector('details.block.forward-frame');
  assert.equal(details.children.length, 1, 'only the summary is present before first expand');
  assertNull(details.querySelector('.forward-section'), 'no section rendered before expand');
  assertNull(details.querySelector('.fold-controls'), 'no fold-controls before expand');
});

test('the instruction stays visible outside the fold as an ordinary user-text block', async () => {
  const root = await render(FRAME);
  const blocks = root.querySelector('.msg.user.forward-frame > .blocks');
  const userText = blocks.querySelector(':scope > .block.text.user-text');
  assert.ok(userText, 'a user-text block is a direct child of .blocks');
  assert.equal(userText.textContent.trim(), INSTRUCTION);
  const details = blocks.querySelector('details.block.forward-frame');
  expand(details);
  assert.ok(!details.textContent.includes(INSTRUCTION), 'the instruction is not inside the fold');
});

test('expanding renders one labelled markdown section per forwarded message', async () => {
  const root = await render(FRAME);
  const details = root.querySelector('details.block.forward-frame');
  expand(details);

  const labels = [...details.querySelectorAll('.forward-section-label')].map((n) => n.textContent);
  assert.deepEqual(labels, ['Message 1/3', 'Message 2/3', 'Message 3/3']);
  const bodies = [...details.querySelectorAll('.forward-section-body')];
  assert.equal(bodies.length, 3);
  assert.equal(bodies[0].querySelector('strong')?.textContent, 'x', 'markdown renders in message 1');
  assert.match(bodies[1].querySelector('h1')?.textContent ?? '', /Plan: demo/, 'plan heading renders');
  assertNull(details.querySelector('hr'), 'no framing line becomes a horizontal rule');
  const ols = bodies[2].querySelectorAll('ol');
  assert.equal(ols.length, 2, 'two question lists');
  assert.equal(ols[1].getAttribute('start'), '2', 'second question numbered from 2');
});

test('an unclosed code fence in one message does not swallow the next', async () => {
  const root = await render(buildForwardFrame({
    messages: ['truncated here:\n```js\nconst a = 1;', 'second message stays prose'],
    instruction: 'go',
  }));
  const details = root.querySelector('details.block.forward-frame');
  expand(details);
  const [first, second] = details.querySelectorAll('.forward-section-body');
  assert.ok(first.querySelector('pre'), 'message 1 opens its code block');
  assertNull(second.querySelector('pre'), 'message 2 has no code block');
  assertNull(second.querySelector('code'), 'message 2 has no inline code');
  assert.equal(second.querySelector('p')?.textContent, 'second message stays prose');
});

test('each copy yields the exact bytes its view shows: the payload in the fold, the instruction on the role row', async () => {
  const { copied, restore } = stubClipboard();
  try {
    const root = await render(FRAME);
    const wrap = root.querySelector('.msg.user.forward-frame');
    const details = wrap.querySelector('details.block.forward-frame');
    expand(details);

    details.querySelector('.user-view-copy').click();
    await Promise.resolve();
    wrap.querySelector('.role .user-view-copy').click();
    await Promise.resolve();
    assert.deepEqual(copied, [PAYLOAD, INSTRUCTION]);
  } finally {
    restore();
  }
});

test('an empty instruction adds no user-text block outside the fold', async () => {
  const root = await render(buildForwardFrame({ messages: ['out'], instruction: '' }));
  const blocks = root.querySelector('.msg.user.forward-frame > .blocks');
  assert.ok(blocks.querySelector('details.block.forward-frame'));
  assertNull(blocks.querySelector(':scope > .block.text'), 'no instruction block');
  assertNull(root.querySelector('.role .user-view-controls'), 'no role-row controls');
});

test('non-frames stay plain user bubbles', async (t) => {
  const firstLine = FORWARD_FRAME_HEADER.slice(0, FORWARD_FRAME_HEADER.indexOf('\n'));
  const cases = {
    'header first line only': `${firstLine}\n--- message 1/1 ---\nout\n--- END FORWARDED WORKER OUTPUT ---\n\ngo`,
    'truncated frame with no footer': `${FORWARD_FRAME_HEADER}\n\nworker output cut short`,
  };
  for (const [label, text] of Object.entries(cases)) {
    await t.test(label, async () => {
      const root = await render(text);
      const wrap = root.querySelector('.msg.user');
      assert.ok(!wrap.classList.contains('forward-frame'), 'no forward-frame class');
      assertNull(wrap.querySelector('details.block.forward-frame'), 'no forward details');
      assert.ok(wrap.querySelector('.user-text'), 'plain user-text body');
    });
  }
});
