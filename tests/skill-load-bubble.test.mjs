// Tests for the dedicated skill-loading bubble: a user_echo carrying
// `skillLoad: {skill}` (stamped by parser.ts's attachSkillLoad once it has
// correlated an isSynthetic content-injection message with a preceding
// Skill tool_use) renders as a collapsed <details class="block skill">
// named after the invoked skill. The expanded body renders as markdown,
// built lazily on first expand, with a raw/md toggle and a source copy
// (sharing buildUserText via foldedText.js's mountFoldedText — see
// wake-callback-bubble.test.mjs for the same mechanism on wake bubbles).
// A plain isSynthetic message with no skillLoad tag renders unaffected.

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

const SKILL_TEXT = 'Base directory for this skill: /x/skills/demo\n\n# Demo Skill\n\n**Use** it:\n\n- one\n- two\n';

test('a skillLoad-tagged user_echo renders a collapsed skill-loading bubble', async () => {
  setupDOM();
  const Conversation = await importConversation();
  const root = document.createElement('div');
  const conv = new Conversation(root, {});

  conv.apply({ kind: 'user_echo', text: SKILL_TEXT, skillLoad: { skill: 'keybindings-help' }, userIndex: 0 });

  const details = root.querySelector('details.block.skill');
  assert.ok(details, 'renders inside a <details class="block skill">');
  assert.equal(details.open, false, 'collapsed by default');

  const summary = details.querySelector('summary');
  assert.ok(summary, 'summary present');
  assert.match(summary.textContent, /Loading skill: keybindings-help/);

  expand(details);
  const body = details.querySelector(':scope > .user-text');
  assert.ok(body, 'full content is in an expandable markdown body');
  assert.ok(body.textContent.includes('Demo Skill'), 'body carries the raw content');
});

test('an isSynthetic message with no skillLoad tag renders as plain text, not a skill bubble', async () => {
  setupDOM();
  const Conversation = await importConversation();
  const root = document.createElement('div');
  const conv = new Conversation(root, {});

  // e.g. Stop-hook feedback or compaction-continuation text — also
  // isSynthetic on the CLI side, but parser.ts only stamps skillLoad when it
  // actually correlated with a Skill tool_use.
  conv.apply({ kind: 'user_echo', text: 'Stop hook feedback:\n[do the thing]', userIndex: 0 });

  assertNull(root.querySelector('details.block.skill'), 'no skill bubble rendered');
  const wrap = root.querySelector('.msg.user');
  assert.ok(wrap.textContent.includes('Stop hook feedback'), 'plain text still rendered');
});

test('a plain user_echo is unaffected (no skill bubble)', async () => {
  setupDOM();
  const Conversation = await importConversation();
  const root = document.createElement('div');
  const conv = new Conversation(root, {});

  conv.apply({ kind: 'user_echo', text: 'hello there', userIndex: 0 });

  assertNull(root.querySelector('details.block.skill'), 'a normal prompt is not tagged as a skill load');
  const wrap = root.querySelector('.msg.user');
  assert.ok(wrap.textContent.includes('hello there'), 'plain text still rendered');
});

// --- markdown-fold tests (card 2026-0481) ---

test('no render before first expand: details has one child; no body/controls', async () => {
  setupDOM();
  const Conversation = await importConversation();
  const root = document.createElement('div');
  const conv = new Conversation(root, {});
  conv.apply({ kind: 'user_echo', text: SKILL_TEXT, skillLoad: { skill: 'demo' }, userIndex: 0 });

  const details = root.querySelector('details.block.skill');
  assert.equal(details.children.length, 1, 'only the summary is present before first expand');
  assertNull(details.querySelector('.user-text'), 'no rendered body before expand');
  assertNull(details.querySelector('.fold-controls'), 'no fold-controls before expand');
  assertNull(details.querySelector('.user-view-controls'), 'no view controls before expand');
});

test('render on expand, reused afterwards (build-once, same node across collapse/reopen)', async () => {
  setupDOM();
  const Conversation = await importConversation();
  const root = document.createElement('div');
  const conv = new Conversation(root, {});
  conv.apply({ kind: 'user_echo', text: SKILL_TEXT, skillLoad: { skill: 'demo' }, userIndex: 0 });

  const details = root.querySelector('details.block.skill');
  expand(details);
  const bodies1 = details.querySelectorAll(':scope > .user-text');
  assert.equal(bodies1.length, 1, 'exactly one body after expand');
  const bodyNode = bodies1[0];

  collapse(details);
  expand(details);
  assert.equal(details.querySelectorAll(':scope > .user-text').length, 1, 'still one body');
  assert.equal(details.querySelector(':scope > .user-text'), bodyNode, 'same node reused');
});

test('rendered as markdown with no metadata split (skill bubbles have no .wake-meta)', async () => {
  setupDOM();
  const Conversation = await importConversation();
  const root = document.createElement('div');
  const conv = new Conversation(root, {});
  conv.apply({ kind: 'user_echo', text: SKILL_TEXT, skillLoad: { skill: 'demo' }, userIndex: 0 });

  const details = root.querySelector('details.block.skill');
  expand(details);
  const body = details.querySelector(':scope > .user-text');

  assertNull(body.querySelector('.wake-meta'), 'no metadata line split for skill bubbles');
  const firstP = body.querySelector('p');
  assert.ok(firstP, 'first line is an ordinary paragraph');
  assert.match(firstP.textContent, /Base directory for this skill/);

  assert.ok(body.querySelector('h1'), 'heading renders');
  assert.match(body.querySelector('h1').textContent, /Demo Skill/);
  assert.ok(body.querySelector('strong'), 'bold renders');
  assert.equal(body.querySelectorAll('li').length, 2, 'list renders');
});

test('raw/md toggle: raw is the exact source text with no element children', async () => {
  setupDOM();
  const Conversation = await importConversation();
  const root = document.createElement('div');
  const conv = new Conversation(root, {});
  conv.apply({ kind: 'user_echo', text: SKILL_TEXT, skillLoad: { skill: 'demo' }, userIndex: 0 });

  const details = root.querySelector('details.block.skill');
  expand(details);
  const body = details.querySelector(':scope > .user-text');
  const toggle = details.querySelector('.user-view-toggle');

  toggle.click();
  assert.equal(body.dataset.view, 'raw');
  assert.equal(body.children.length, 0, 'raw view has no element children');
  assert.equal(body.textContent, SKILL_TEXT, 'raw view is the exact injected text');

  toggle.click();
  assert.equal(body.dataset.view, 'rendered');
  assert.ok(body.querySelector('h1'), 'md re-renders');
});

test('copy returns the exact raw text', async () => {
  setupDOM();
  const { copied, restore } = stubClipboard();
  try {
    const Conversation = await importConversation();
    const root = document.createElement('div');
    const conv = new Conversation(root, {});
    conv.apply({ kind: 'user_echo', text: SKILL_TEXT, skillLoad: { skill: 'demo' }, userIndex: 0 });

    const details = root.querySelector('details.block.skill');
    expand(details);
    const copyBtn = details.querySelector('.user-view-copy');
    const toggle = details.querySelector('.user-view-toggle');

    copyBtn.click();
    await Promise.resolve();
    assert.equal(copied[0], SKILL_TEXT, 'copy in rendered view returns the exact text');

    toggle.click(); // -> raw
    copyBtn.click();
    await Promise.resolve();
    assert.equal(copied[1], SKILL_TEXT, 'copy in raw view returns the exact text too');
  } finally {
    restore();
  }
});

test('controls survive segment retirement and running turns; clicks are contained and do not collapse', async () => {
  setupDOM();
  const Conversation = await importConversation();
  const root = document.createElement('div');
  const conv = new Conversation(root, { onRewind() {}, onFork() {} });
  conv.segmentId = 'A';
  conv.setCurrentSegment('A');
  conv.apply({ kind: 'user_echo', text: SKILL_TEXT, skillLoad: { skill: 'demo' }, userIndex: 0 });

  const details = root.querySelector('details.block.skill');
  expand(details);

  conv.setCurrentSegment('B'); // retires segment A
  assertNull(root.querySelector('.user-msg-actions'), 'rewind/fork removed on retirement');
  assert.ok(details.querySelector('.user-view-controls'), 'view controls survive retirement');

  conv.setUserActionsEnabled(false);
  for (const btn of details.querySelectorAll('.user-view-btn')) {
    assert.equal(btn.disabled, false, 'view buttons stay enabled during a running turn');
  }

  const wrap = root.querySelector('.msg.user');
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
