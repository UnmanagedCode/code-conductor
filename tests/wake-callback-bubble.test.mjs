// Tests for the special idle-subscription wake-callback bubble: a user_echo
// tagged with WAKE_CALLBACK_MARKER renders as a collapsed <details> whose
// summary (worker finished + what to do) stays visible and whose body holds the
// folded get_recent_messages payload. The marker sentinels never render.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { Window } from 'happy-dom';
import { buildWakeStub, markPlainStub, WAKE_CALLBACK_MARKER } from '../public/wakeCallback.js';

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

let uid = 0;
async function importConversation() {
  uid++;
  const { Conversation } =
    await import(pathToFileURL(path.join(PUB, 'conversation.js')).href + `?uid=${uid}`);
  return Conversation;
}

const PAYLOAD = '{"sessionId":"abc12345"}\n\nFirst worker output line.';
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

  // Orchestrator badge lives on the summary line.
  assert.ok(summary.querySelector('.wake-badge'), 'orchestrator badge present on summary');

  // The folded payload is in the (collapsed) body, not the summary.
  const body = details.querySelector('.block.text');
  assert.ok(body.textContent.includes('First worker output line.'),
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

  // No collapsible <details> — plain stubs have nothing to fold.
  assert.equal(wrap.querySelector('details.block.wake'), null, 'no <details> for a body-less stub');

  const plain = wrap.querySelector('.block.wake.plain');
  assert.ok(plain, 'renders a body-less .block.wake.plain summary line');
  assert.match(plain.textContent, /finished its turn/);
  assert.ok(plain.textContent.includes('abc12345'), 'plain line names the worker');

  // Badge is present on the plain line too.
  assert.ok(plain.querySelector('.wake-badge'), 'orchestrator badge present on plain line');

  // Marker sentinel never renders.
  assert.ok(!wrap.textContent.includes(WAKE_CALLBACK_MARKER),
    'the wake-callback marker is stripped from display');
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

  assert.equal(root.querySelector('.msg.user.wake-callback'), null,
    'a normal prompt is not tagged as a wake callback');
  assert.equal(root.querySelector('details.block.wake'), null, 'no wake details block');
  const wrap = root.querySelector('.msg.user');
  assert.ok(wrap.textContent.includes('hello there'), 'plain text still rendered');
});
