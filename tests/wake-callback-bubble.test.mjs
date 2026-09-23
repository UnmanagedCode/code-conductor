// Tests for the special idle-wake callback bubble: a user_echo
// tagged with WAKE_CALLBACK_MARKER renders as a collapsed <details> whose
// summary (worker finished + what to do) stays visible and whose body holds the
// folded get_recent_messages payload. The marker sentinels never render.
//
// The expanded body renders as markdown, built lazily on first expand: line 1
// (the compact-JSON metadata block) is a muted, never-markdown line, and the
// rest renders as markdown with a raw/md toggle and a source copy, sharing
// buildUserText with the plain user-bubble body (see foldedText.js).

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { assertNull } from './dom-assert.mjs';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { Window } from 'happy-dom';
import { buildWakeStub, markPlainStub, WAKE_CALLBACK_MARKER } from '../public/wakeCallback.js';
import { flattenPayload } from '../src/mcp/content.ts';

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
function collapse(details) {
  if (details.open) details.querySelector(':scope > summary').click();
}

let uid = 0;
async function importConversation() {
  uid++;
  const { Conversation } =
    await import(pathToFileURL(path.join(PUB, 'conversation.js')).href + `?uid=${uid}`);
  return Conversation;
}

const META = {
  sessionId: 'abc12345',
  messages: [
    { index: 0, msgId: 'msg_01', hasToolUse: false, textChars: 20, textTruncated: false },
    { index: 1, msgId: 'msg_02', hasToolUse: true, textChars: 5, textTruncated: false },
  ],
  source: 'live',
  omittedToolOnly: 0,
  retained: { count: 2 },
  hint: 'call get_recent_messages with a snake_case_word if **not bold** enough context remains',
};
const BODY1 = '--- message 1/2 · msg_01 · 20 chars ---\n**bold** prose\n\n- item a\n- item b';
const BODY2 = '--- message 2/2 · msg_02 · 5 chars ---\ntext\n--- plan ---\n# Plan: x\n--- questions ---\n1. Q (multiSelect: false)\n   - opt\n  ';
const PAYLOAD = flattenPayload(META, [BODY1, BODY2]);
const STUB = buildWakeStub({ targetSessionId: 'abc12345', payloadText: PAYLOAD });

test('wake-callback echo renders a collapsed <details> bubble', async () => {
  setupDOM();
  const Conversation = await importConversation();
  const root = document.createElement('div');
  const conv = new Conversation(root, {});

  conv.apply({ kind: 'user_echo', text: STUB, userIndex: 0 });

  const wrap = root.querySelector('.msg.user.wake-callback');
  assert.ok(wrap, 'user bubble carries the wake-callback class');

  const details = wrap.querySelector('details.block.wake');
  assert.ok(details, 'wake payload renders inside a <details class="block wake">');
  assert.equal(details.open, false, 'details is collapsed by default');

  const summary = details.querySelector('summary');
  assert.ok(summary, 'summary present');
  assert.match(summary.textContent, /finished its turn/);
  assert.ok(summary.textContent.includes('abc12345'), 'summary names the worker');

  assert.ok(summary.querySelector('.wake-badge'), 'orchestrator badge present on summary');

  expand(details);
  const body = details.querySelector('.block.text');
  assert.ok(body.textContent.includes('bold prose'),
    'folded payload appears in the body');
});

test('a body-less (plain) marked stub renders the bubble with no collapsible body', async () => {
  setupDOM();
  const Conversation = await importConversation();
  const root = document.createElement('div');
  const conv = new Conversation(root, {});

  const PLAIN = markPlainStub(
    'Worker `abc12345` finished its turn. ' +
    'Call `mcp__code-conductor__get_recent_messages({sessionId:"abc12345"})` to inspect the result.');
  conv.apply({ kind: 'user_echo', text: PLAIN, userIndex: 0 });

  const wrap = root.querySelector('.msg.user.wake-callback');
  assert.ok(wrap, 'plain stub still carries the wake-callback class');

  assertNull(wrap.querySelector('details.block.wake'), 'no <details> for a body-less stub');

  const plain = wrap.querySelector('.block.wake.plain');
  assert.ok(plain, 'renders a body-less .block.wake.plain summary line');
  assert.match(plain.textContent, /finished its turn/);
  assert.ok(plain.textContent.includes('abc12345'), 'plain line names the worker');

  assert.ok(plain.querySelector('.wake-badge'), 'orchestrator badge present on plain line');

  assert.ok(!wrap.textContent.includes(WAKE_CALLBACK_MARKER),
    'the wake-callback marker is stripped from display');
  assertNull(wrap.querySelector('.user-view-controls'), 'plain stub gets no view controls');
  assertNull(wrap.querySelector('.user-text'), 'plain stub gets no markdown body');
});

test('marker sentinels never appear in the rendered text', async () => {
  setupDOM();
  const Conversation = await importConversation();
  const root = document.createElement('div');
  const conv = new Conversation(root, {});

  conv.apply({ kind: 'user_echo', text: STUB, userIndex: 0 });

  const wrap = root.querySelector('.msg.user.wake-callback');
  assert.ok(!wrap.textContent.includes(WAKE_CALLBACK_MARKER),
    'the wake-callback marker is stripped from display');
  assert.ok(!wrap.textContent.includes('[[cc:wake-body]]'),
    'the body separator is stripped from display');
});

test('a plain user_echo is unaffected (no wake bubble)', async () => {
  setupDOM();
  const Conversation = await importConversation();
  const root = document.createElement('div');
  const conv = new Conversation(root, {});

  conv.apply({ kind: 'user_echo', text: 'hello there', userIndex: 0 });

  assertNull(root.querySelector('.msg.user.wake-callback'),
    'a normal prompt is not tagged as a wake callback');
  assertNull(root.querySelector('details.block.wake'), 'no wake details block');
  const wrap = root.querySelector('.msg.user');
  assert.ok(wrap.textContent.includes('hello there'), 'plain text still rendered');
});

// --- markdown-fold tests (card 2026-0481) ---

test('no render before first expand: collapsed bubble does no markdown work and gets no controls', async () => {
  setupDOM();
  const Conversation = await importConversation();
  const root = document.createElement('div');
  const conv = new Conversation(root, {});
  conv.apply({ kind: 'user_echo', text: STUB, userIndex: 0 });

  const wrap = root.querySelector('.msg.user.wake-callback');
  const details = wrap.querySelector('details.block.wake');
  assert.equal(details.children.length, 1, 'only the summary is present before first expand');
  assertNull(wrap.querySelector('.user-text'), 'no rendered body before expand');
  assertNull(wrap.querySelector('.user-view-controls'), 'no controls before expand');
  assertNull(wrap.querySelector('.fold-controls'), 'no fold-controls before expand');
  assertNull(wrap.querySelector('.wake-meta'), 'no meta line before expand');
  assertNull(root.querySelector('.role .user-view-controls'), 'role row carries no view controls');
});

test('a toggle event landing while closed builds nothing (happy-dom dispatches toggle sync; real browsers can coalesce it while closed)', async () => {
  setupDOM();
  const Conversation = await importConversation();
  const root = document.createElement('div');
  const conv = new Conversation(root, {});
  conv.apply({ kind: 'user_echo', text: STUB, userIndex: 0 });

  const details = root.querySelector('details.block.wake');
  details.dispatchEvent(new window.Event('toggle'));
  assert.equal(details.children.length, 1, 'dispatching toggle while closed builds nothing');
});

test('render appears on expand and is reused afterwards (build-once, preserved view state)', async () => {
  setupDOM();
  const Conversation = await importConversation();
  const root = document.createElement('div');
  const conv = new Conversation(root, {});
  conv.apply({ kind: 'user_echo', text: STUB, userIndex: 0 });

  const details = root.querySelector('details.block.wake');
  expand(details);
  const bodies1 = details.querySelectorAll(':scope > .user-text');
  const controls1 = details.querySelectorAll(':scope > .fold-controls');
  assert.equal(bodies1.length, 1, 'exactly one body after expand');
  assert.equal(controls1.length, 1, 'exactly one controls row after expand');
  const children = [...details.children];
  assert.ok(children.indexOf(controls1[0]) < children.indexOf(bodies1[0]),
    'controls come before the body');

  const bodyNode = bodies1[0];
  collapse(details);
  expand(details);
  assert.equal(details.querySelectorAll(':scope > .user-text').length, 1, 'still one body');
  assert.equal(details.querySelectorAll(':scope > .fold-controls').length, 1, 'still one controls row');
  assert.equal(details.querySelector(':scope > .user-text'), bodyNode, 'same body node reused');

  const toggle = details.querySelector('.user-view-toggle');
  toggle.click(); // switch to raw
  collapse(details);
  expand(details);
  assert.equal(bodyNode.dataset.view, 'raw', 'view state (raw) persists across collapse/expand');
  assert.equal(details.querySelector(':scope > .user-text'), bodyNode, 'same node still reused');
});

test('spy-count laziness (unit): mountFoldedText does no markdown work while collapsed', async () => {
  setupDOM();
  const { mountFoldedText } = await import(pathToFileURL(path.join(PUB, 'foldedText.js')).href + `?uid=${++uid}`);
  const { renderWakeBodyInto } = await import(pathToFileURL(path.join(PUB, 'foldedText.js')).href + `?uid=${uid}`);

  let calls = 0;
  const spy = (root, text) => { calls++; return renderWakeBodyInto(root, text); };

  const details = document.createElement('details');
  const summary = document.createElement('summary');
  details.appendChild(summary);

  mountFoldedText(details, PAYLOAD, { renderInto: spy });
  assert.equal(calls, 0, 'no markdown work at mount time');

  expand(details);
  assert.equal(calls, 1, 'one render on first open');

  collapse(details);
  expand(details);
  assert.equal(calls, 1, 'no re-render on reopen (same view)');

  const toggle = details.querySelector('.user-view-toggle');
  toggle.click(); // -> raw
  toggle.click(); // -> md, re-renders
  assert.equal(calls, 2, 'toggling back to md re-renders once more');
});

test('metadata line is a muted line, never markdown', async () => {
  setupDOM();
  const Conversation = await importConversation();
  const root = document.createElement('div');
  const conv = new Conversation(root, {});
  conv.apply({ kind: 'user_echo', text: STUB, userIndex: 0 });

  const details = root.querySelector('details.block.wake');
  expand(details);
  const body = details.querySelector(':scope > .user-text');

  const metaLine = body.firstElementChild;
  assert.ok(metaLine, 'body has a first element child');
  assert.ok(metaLine.classList.contains('wake-meta'), 'first child is .wake-meta');
  assert.equal(metaLine.textContent, PAYLOAD.split('\n')[0], 'meta line textContent is exactly line 1');
  assert.equal(metaLine.children.length, 0, 'meta line has no child elements (no em/strong from snake_case/**)');

  for (const p of body.querySelectorAll('p')) {
    assert.ok(!p.textContent.startsWith('{"sessionId"'), 'no <p> begins with the metadata JSON');
  }

  assert.ok(body.querySelector('strong'), 'prose after the meta line is rendered markdown (strong)');
  assert.equal(body.querySelectorAll('li').length >= 2, true, 'prose list renders');
});

test('framing lines stay paragraphs (wake path goes through the shared renderer)', async () => {
  setupDOM();
  const Conversation = await importConversation();
  const root = document.createElement('div');
  const conv = new Conversation(root, {});
  conv.apply({ kind: 'user_echo', text: STUB, userIndex: 0 });

  const details = root.querySelector('details.block.wake');
  expand(details);
  const body = details.querySelector(':scope > .user-text');

  assertNull(body.querySelector('hr'), 'no framing line becomes a horizontal rule');
  const h1 = body.querySelector('h1');
  assert.ok(h1, 'plan heading present');
  assert.match(h1.textContent, /Plan: x/);

  const paragraphs = [...body.querySelectorAll('p')];
  assert.ok(paragraphs.some(p => p.textContent.includes('message 1/2 · msg_01')),
    'message framing line 1 renders as a paragraph');
  assert.ok(paragraphs.some(p => p.textContent.includes('--- plan ---')),
    '--- plan --- framing line renders as a paragraph');
  assert.ok(paragraphs.some(p => p.textContent.includes('--- questions ---')),
    '--- questions --- framing line renders as a paragraph');
});

test('raw/md toggle: raw shows the whole body literally including the meta line; md restores meta treatment', async () => {
  setupDOM();
  const Conversation = await importConversation();
  const root = document.createElement('div');
  const conv = new Conversation(root, {});
  conv.apply({ kind: 'user_echo', text: STUB, userIndex: 0 });

  const details = root.querySelector('details.block.wake');
  expand(details);
  const body = details.querySelector(':scope > .user-text');
  const toggle = details.querySelector('.user-view-toggle');

  toggle.click();
  assert.equal(body.dataset.view, 'raw');
  assert.equal(body.children.length, 0, 'raw view has no element children');
  assert.equal(body.textContent, PAYLOAD, 'raw view is the exact payload, meta line included');
  assert.equal(toggle.textContent, 'md');

  toggle.click();
  assert.equal(body.dataset.view, 'rendered');
  const metaLine = body.firstElementChild;
  assert.ok(metaLine.classList.contains('wake-meta'), '.wake-meta is first child again');
  assert.ok(body.querySelector('strong'), 'strong is back');
  assert.equal(toggle.textContent, 'raw');
});

test('copy returns the exact raw body in both views', async () => {
  setupDOM();
  const { copied, restore } = stubClipboard();
  try {
    const Conversation = await importConversation();
    const root = document.createElement('div');
    const conv = new Conversation(root, {});
    conv.apply({ kind: 'user_echo', text: STUB, userIndex: 0 });

    const details = root.querySelector('details.block.wake');
    expand(details);
    const copyBtn = details.querySelector('.user-view-copy');
    const toggle = details.querySelector('.user-view-toggle');

    copyBtn.click();
    await Promise.resolve();
    assert.equal(copied[0], PAYLOAD, 'copy in rendered view returns the exact payload');
    assert.ok(!copied[0].includes('[[cc:'), 'copy excludes cc markers');
    assert.ok(!copied[0].includes('finished its turn'), 'copy excludes the summary line');

    toggle.click(); // -> raw
    copyBtn.click();
    await Promise.resolve();
    assert.equal(copied[1], PAYLOAD, 'copy in raw view returns the exact payload too');
  } finally {
    restore();
  }
});

test('controls survive segment retirement and running turns; clicks stay contained', async () => {
  setupDOM();
  const Conversation = await importConversation();
  const root = document.createElement('div');
  const conv = new Conversation(root, { onRewind() {}, onFork() {} });
  conv.segmentId = 'A';
  conv.setCurrentSegment('A');
  conv.apply({ kind: 'user_echo', text: STUB, userIndex: 0 });

  const details = root.querySelector('details.block.wake');
  expand(details);

  conv.setCurrentSegment('B'); // retires segment A
  assertNull(root.querySelector('.user-msg-actions'), 'rewind/fork removed on retirement');
  assert.ok(details.querySelector('.user-view-controls'), 'view controls survive retirement');

  conv.setUserActionsEnabled(false);
  for (const btn of details.querySelectorAll('.user-view-btn')) {
    assert.equal(btn.disabled, false, 'view buttons stay enabled during a running turn');
  }

  const wrap = root.querySelector('.msg.user.wake-callback');
  let wrapClicks = 0;
  let documentClicks = 0;
  wrap.addEventListener('click', () => { wrapClicks++; });
  document.addEventListener('click', () => { documentClicks++; });

  const toggle = details.querySelector('.user-view-toggle');
  const copyBtn = details.querySelector('.user-view-copy');
  toggle.click();
  copyBtn.click();

  assert.equal(wrapClicks, 0, 'no click reached the wrap');
  assert.equal(documentClicks, 0, 'no click reached document');
  assert.equal(details.open, true, 'clicking controls keeps the details open');
});

test('plain stub unchanged: no view controls or markdown body', async () => {
  setupDOM();
  const Conversation = await importConversation();
  const root = document.createElement('div');
  const conv = new Conversation(root, {});

  const PLAIN = markPlainStub('Worker `abc12345` finished its turn.');
  conv.apply({ kind: 'user_echo', text: PLAIN, userIndex: 0 });

  const wrap = root.querySelector('.msg.user.wake-callback');
  assertNull(wrap.querySelector('.user-view-controls'), 'no view controls on a plain stub');
  assertNull(wrap.querySelector('.user-text'), 'no markdown body on a plain stub');
});

test('CSS pins: .wake-meta rule and fold-box font-family drop', async () => {
  const css = await import('node:fs/promises').then(fs => fs.readFile(STYLES, 'utf8'));

  const metaRule = css.match(/\.wake-meta\s*\{[^}]*\}/);
  assert.ok(metaRule, '.wake-meta rule present');
  assert.match(metaRule[0], /monospace/, '.wake-meta is monospace');
  assert.match(metaRule[0], /var\(--muted\)/, '.wake-meta uses the muted color token');

  const foldRule = css.match(/\.block\.wake\s*>\s*\.block\.text[^{]*\{[^}]*\}/);
  assert.ok(foldRule, 'fold-box rule for .block.wake > .block.text present');
  assert.ok(!/font-family/.test(foldRule[0]), 'fold-box rule no longer forces a font-family');
});
