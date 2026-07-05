// Tests for the dedicated skill-loading bubble: a user_echo carrying
// `skillLoad: {skill}` (stamped by parser.js's attachSkillLoad once it has
// correlated an isSynthetic content-injection message with a preceding
// Skill tool_use) renders as a collapsed <details class="block skill">
// named after the invoked skill, with the raw SKILL.md content in an
// expandable body. A plain isSynthetic message with no skillLoad tag (e.g.
// Stop-hook feedback, compaction continuation) must render unaffected.

import { test } from 'node:test';
import assert from 'node:assert/strict';
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

let uid = 0;
async function importConversation() {
  uid++;
  const { Conversation } =
    await import(pathToFileURL(path.join(PUB, 'conversation.js')).href + `?uid=${uid}`);
  return Conversation;
}

const SKILL_TEXT = '# Keybindings Skill\n\nCreate or modify `~/.claude/keybindings.json`... full reference text.';

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

  const body = details.querySelector('pre.block.text');
  assert.ok(body, 'full content is in an expandable <pre> body');
  assert.ok(body.textContent.includes('full reference text'), 'body carries the raw SKILL.md content');
});

test('an isSynthetic message with no skillLoad tag renders as plain text, not a skill bubble', async () => {
  setupDOM();
  const Conversation = await importConversation();
  const root = document.createElement('div');
  const conv = new Conversation(root, {});

  // e.g. Stop-hook feedback or compaction-continuation text — also
  // isSynthetic on the CLI side, but parser.js only stamps skillLoad when it
  // actually correlated with a Skill tool_use.
  conv.apply({ kind: 'user_echo', text: 'Stop hook feedback:\n[do the thing]', userIndex: 0 });

  assert.equal(root.querySelector('details.block.skill'), null, 'no skill bubble rendered');
  const wrap = root.querySelector('.msg.user');
  assert.ok(wrap.textContent.includes('Stop hook feedback'), 'plain text still rendered');
});

test('a plain user_echo is unaffected (no skill bubble)', async () => {
  setupDOM();
  const Conversation = await importConversation();
  const root = document.createElement('div');
  const conv = new Conversation(root, {});

  conv.apply({ kind: 'user_echo', text: 'hello there', userIndex: 0 });

  assert.equal(root.querySelector('details.block.skill'), null, 'a normal prompt is not tagged as a skill load');
  const wrap = root.querySelector('.msg.user');
  assert.ok(wrap.textContent.includes('hello there'), 'plain text still rendered');
});
