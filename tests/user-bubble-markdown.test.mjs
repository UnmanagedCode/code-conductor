// Tests for rendering user bubbles as markdown: GFM rendering, preserved
// line breaks, HTML shown as literal text, the raw/rendered toggle, the
// source copy, survival across segment retirement / busy turns, and the
// wake/skill/plain paths staying unaffected.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { assertNull } from './dom-assert.mjs';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { Window } from 'happy-dom';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const PUB = path.resolve(__dirname, '..', 'public');
const STYLES = path.resolve(__dirname, '..', 'public', 'styles.css');

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

// Stubs navigator.clipboard.writeText, recording every call into `copied`.
// Returns a restore() to put the original descriptor back.
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

let uid = 0;
async function importConversation() {
  uid++;
  const { Conversation } =
    await import(pathToFileURL(path.join(PUB, 'conversation.js')).href + `?uid=${uid}`);
  return Conversation;
}

function userTextBody(root) {
  return root.querySelector('.msg.user .block.text.user-text');
}

test('GFM constructs render inside the user bubble', async () => {
  setupDOM();
  const Conversation = await importConversation();
  const root = document.createElement('div');
  const conv = new Conversation(root, {});
  const src = [
    '```js',
    'const x = 1;',
    '```',
    '',
    'Some `inline code` and a list:',
    '',
    '- one',
    '- two',
    '',
    '[link](https://example.com)',
    '',
    '**bold**',
    '',
    '| A | B |',
    '| --- | --- |',
    '| 1 | 2 |',
  ].join('\n');
  conv.apply({ kind: 'user_echo', text: src, userIndex: 0 });

  const body = userTextBody(root);
  assert.ok(body, 'rendered markdown body present');
  assert.ok(body.querySelector('pre > code'), 'fenced code renders');
  assert.ok(body.querySelector('code'), 'inline code renders');
  assert.equal(body.querySelectorAll('ul li').length, 2, 'list renders');
  const a = body.querySelector('a[href="https://example.com"]');
  assert.ok(a, 'link renders with href');
  assert.ok(body.querySelector('strong'), 'bold renders');
  assert.ok(body.querySelector('table'), 'table renders');
});

test('single newlines are kept as line breaks via pre-wrap, not collapsed', async () => {
  setupDOM();
  const Conversation = await importConversation();
  const root = document.createElement('div');
  const conv = new Conversation(root, {});
  const src = 'line one\nline two\nline three';
  conv.apply({ kind: 'user_echo', text: src, userIndex: 0 });

  const body = userTextBody(root);
  assert.ok(body, 'body present');
  assert.ok(body.classList.contains('block'));
  assert.ok(body.classList.contains('text'));
  const ps = body.querySelectorAll('p');
  assert.equal(ps.length, 1, 'one paragraph carries all three lines');
  assert.equal(ps[0].textContent, src);

  const css = await import('node:fs/promises').then(fs => fs.readFile(STYLES, 'utf8'));
  const rule = css.match(/\.block\.text\s*\{[^}]*\}/);
  assert.ok(rule, '.block.text rule present in styles.css');
  assert.match(rule[0], /white-space:\s*pre-wrap/, '.block.text keeps pre-wrap so single newlines show as line breaks');
});

test('HTML-looking text renders literally, never as real elements', async () => {
  setupDOM();
  const Conversation = await importConversation();
  const root = document.createElement('div');
  const conv = new Conversation(root, {});
  const src = '<pasted_content id="1">\n<b>x</b><script>alert(1)</script>\n</pasted_content>';
  conv.apply({ kind: 'user_echo', text: src, userIndex: 0 });

  const body = userTextBody(root);
  assertNull(body.querySelector('b'), 'no real <b> element created from tag-like text');
  assertNull(body.querySelector('script'), 'no real <script> element created from tag-like text');
  assert.ok(body.textContent.includes('<pasted_content id="1">'), 'pasted_content tag shown literally');
  assert.ok(body.textContent.includes('<script>'), 'script tag shown literally');
});

test('the raw/md toggle switches between rendered and literal source', async () => {
  setupDOM();
  const Conversation = await importConversation();
  const root = document.createElement('div');
  const conv = new Conversation(root, {});
  const src = '**bold** and\n\n# a heading';
  conv.apply({ kind: 'user_echo', text: src, userIndex: 0 });

  const body = userTextBody(root);
  const toggle = root.querySelector('.user-view-toggle');
  assert.ok(toggle, 'toggle button present');
  assert.ok(body.querySelector('strong'), 'starts rendered');
  assert.equal(toggle.textContent, 'raw', 'label names the view a click switches to');
  assert.equal(toggle.title, 'Show raw text');
  assert.equal(toggle.hasAttribute('aria-pressed'), false,
    'no aria-pressed — the label names the target view, not the current state, so "pressed" would contradict it');

  toggle.click();
  assert.equal(body.dataset.view, 'raw');
  assert.equal(body.classList.contains('md'), false);
  assert.equal(body.children.length, 0, 'raw view has no element children');
  assert.equal(body.textContent, src);
  assert.equal(toggle.textContent, 'md', 'label now names rendered, the next click target');
  assert.equal(toggle.title, 'Show rendered markdown');
  assert.equal(toggle.hasAttribute('aria-pressed'), false);

  toggle.click();
  assert.equal(body.dataset.view, 'rendered');
  assert.ok(body.classList.contains('md'));
  assert.ok(body.querySelector('strong'), 'back to rendered');
  assert.ok(body.querySelector('h1'), 'heading re-renders');
  assert.equal(toggle.textContent, 'raw');
  assert.equal(toggle.title, 'Show raw text');
  assert.equal(toggle.hasAttribute('aria-pressed'), false);
});

test('clicks on the toggle and copy buttons never propagate out of the button', async () => {
  setupDOM();
  const { restore } = stubClipboard();
  try {
    const Conversation = await importConversation();
    const root = document.createElement('div');
    const conv = new Conversation(root, {});
    conv.apply({ kind: 'user_echo', text: '**bold**', userIndex: 0 });

    const bubble = root.querySelector('.msg.user');
    const toggle = root.querySelector('.user-view-toggle');
    const copyBtn = root.querySelector('.user-view-copy');

    let bubbleClicks = 0;
    let documentClicks = 0;
    bubble.addEventListener('click', () => { bubbleClicks++; });
    document.addEventListener('click', () => { documentClicks++; });

    toggle.click(); // -> raw
    copyBtn.click(); // copy while raw
    toggle.click(); // -> rendered
    copyBtn.click(); // copy while rendered

    assert.equal(bubbleClicks, 0, 'no click reached the enclosing .msg.user bubble');
    assert.equal(documentClicks, 0, 'no click reached document');
  } finally {
    restore();
  }
});

test('copy always yields the exact raw source, in both views', async () => {
  setupDOM();
  const { copied, restore } = stubClipboard();
  try {
    const Conversation = await importConversation();
    const root = document.createElement('div');
    const conv = new Conversation(root, {});
    const src = '**bold**\n\n```\nfenced\n```';
    conv.apply({ kind: 'user_echo', text: src, userIndex: 0 });

    const copyBtn = root.querySelector('.user-view-copy');
    const toggle = root.querySelector('.user-view-toggle');
    copyBtn.click();
    await Promise.resolve();
    assert.equal(copied[0], src, 'copies the raw source while rendered');

    toggle.click(); // switch to raw
    copyBtn.click();
    await Promise.resolve();
    assert.equal(copied[1], src, 'copies the same raw source while in raw view');
  } finally {
    restore();
  }
});

test('copy strips the <transcribed> marker, matching what the toggle shows', async () => {
  setupDOM();
  const { copied, restore } = stubClipboard();
  try {
    const Conversation = await importConversation();
    const root = document.createElement('div');
    const conv = new Conversation(root, {});
    conv.apply({ kind: 'user_echo', text: '<transcribed>\n**hi**', userIndex: 0 });

    const copyBtn = root.querySelector('.user-view-copy');
    copyBtn.click();
    await Promise.resolve();
    assert.equal(copied[0], '**hi**', 'copy excludes the <transcribed> marker');
  } finally {
    restore();
  }
});

test('controls survive segment retirement and stay enabled during a running turn', async () => {
  setupDOM();
  const Conversation = await importConversation();
  const root = document.createElement('div');
  const conv = new Conversation(root, { onRewind() {}, onFork() {} });
  conv.segmentId = 'A';
  conv.setCurrentSegment('A');
  conv.apply({ kind: 'user_echo', text: 'hello world', userIndex: 0 });

  assert.ok(root.querySelector('.user-msg-actions'), 'rewind/fork present in current segment');
  assert.ok(root.querySelector('.user-view-controls'), 'view controls present');

  conv.setCurrentSegment('B'); // retires segment A
  assertNull(root.querySelector('.user-msg-actions'), 'rewind/fork removed on retirement');
  assert.ok(root.querySelector('.user-view-controls'), 'view controls survive retirement');

  conv.setUserActionsEnabled(false);
  for (const btn of root.querySelectorAll('.user-view-btn')) {
    assert.equal(btn.disabled, false, 'view buttons stay enabled during a running turn');
  }
});

test('wake-callback and skill-load bubbles build no markdown body or controls while collapsed', async () => {
  setupDOM();
  const { buildWakeStub } = await import(pathToFileURL(path.join(PUB, 'wakeCallback.js')).href);
  const Conversation = await importConversation();
  const root = document.createElement('div');
  const conv = new Conversation(root, {});

  const stub = buildWakeStub({ targetSessionId: 'abc12345', payloadText: '{"sessionId":"abc12345"}\n\nline' });
  conv.apply({ kind: 'user_echo', text: stub, userIndex: 0 });
  const wakeWrap = root.querySelector('.msg.user.wake-callback');
  assertNull(wakeWrap.querySelector('.user-view-controls'), 'no view controls on a wake bubble');
  assertNull(wakeWrap.querySelector('.user-text'), 'no markdown body on a wake bubble');

  conv.apply({ kind: 'user_echo', text: '# skill md', skillLoad: { skill: 'demo' }, userIndex: 1 });
  const skillWrap = [...root.querySelectorAll('.msg.user')].find(w => w.querySelector('details.block.skill'));
  assert.ok(skillWrap, 'skill bubble rendered');
  assertNull(skillWrap.querySelector('.user-view-controls'), 'no view controls on a skill bubble');
  assertNull(skillWrap.querySelector('.user-text'), 'no markdown body on a skill bubble');

  conv.apply({ kind: 'user_echo', text: 'plain', userIndex: 2 });
  const plainWraps = [...root.querySelectorAll('.msg.user')];
  const plainWrap = plainWraps[plainWraps.length - 1];
  assert.equal(plainWrap.querySelector('.block.text').textContent, 'plain');
});

test('headings render subdued inside a user bubble (CSS pin)', async () => {
  const css = await import('node:fs/promises').then(fs => fs.readFile(STYLES, 'utf8'));
  const rule = css.match(/\.msg\.user \.user-text\.md h1[^{]*\{[^}]*\}/);
  assert.ok(rule, 'a .msg.user scoped h1 rule exists for .user-text.md');
  assert.match(rule[0], /font-size:\s*1em/, 'user-bubble h1 does not blow up in size');
});

test('a forward-frame-shaped payload reads sensibly: no stray <hr>, plan heading present, second question list starts at 2', async () => {
  setupDOM();
  const Conversation = await importConversation();
  const root = document.createElement('div');
  const conv = new Conversation(root, {});
  const src = [
    '--- FORWARDED WORKER OUTPUT (verbatim · context only) ---',
    '--- message 1/1 ---',
    '--- plan · saved to /home/node/.claude/plans/demo.md ---',
    '# Plan: demo',
    '',
    '- step one',
    '- step two',
    '',
    '--- questions ---',
    '1. Q one',
    '   - opt',
    '2. Q two',
    '--- END FORWARDED WORKER OUTPUT ---',
    '',
    'Please review and respond.',
  ].join('\n');
  conv.apply({ kind: 'user_echo', text: src, userIndex: 0 });

  const body = userTextBody(root);
  assertNull(body.querySelector('hr'), 'no framing line becomes a horizontal rule');
  const h1 = body.querySelector('h1');
  assert.ok(h1, 'plan heading present');
  assert.match(h1.textContent, /Plan: demo/);
  const ols = body.querySelectorAll('ol');
  assert.equal(ols.length, 2, 'two question lists');
  assert.equal(ols[1].getAttribute('start'), '2', 'second question numbered from 2');
  assert.ok(body.textContent.includes('Please review and respond.'), 'footer guidance text present');
});
