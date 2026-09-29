// Tests for the AskUserQuestion answer bubble: a user_echo carrying the
// server-stamped `questionAnswer` ({toolUseId, questions}) renders through
// public/questionAnswerBubble.js as `.msg.user.question-answer` — one row per
// question. The client renders purely from the stamp; it never sniffs text.
// happy-dom setup mirrors forward-frame-bubble.test.mjs; node identity is
// asserted with assert.ok(a === b) per docs/frontend-testing.md.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { assertNull } from './dom-assert.mjs';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { Window } from 'happy-dom';
import { formatUserQuestionAnswers } from '../public/userQuestionAnswers.js';

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
async function importModules() {
  uid++;
  const { Conversation } =
    await import(pathToFileURL(path.join(PUB, 'conversation.js')).href + `?uid=${uid}`);
  const { renderEventBatch } =
    await import(pathToFileURL(path.join(PUB, 'lazyHistory.js')).href + `?uid=${uid}`);
  return { Conversation, renderEventBatch };
}

const FRUIT = { header: 'Fruit', question: 'Pick a fruit', multiSelect: false,
  options: [{ label: 'Apple' }, { label: 'Banana' }] };
const TOPPINGS = { header: 'Toppings', question: 'Pick toppings', multiSelect: true,
  options: [{ label: 'Nuts' }, { label: 'Cream' }, { label: 'Syrup' }] };
const SIZE = { question: 'Pick a size', options: [{ label: 'S' }, { label: 'L' }] };

const stamped = (questions, answers, extra = {}) => ({
  kind: 'user_echo', userIndex: 4, text: formatUserQuestionAnswers(questions, answers),
  questionAnswer: { toolUseId: 'tu_q', questions }, ...extra,
});

async function render(events, { conversationOptions = {}, replay = false } = {}) {
  setupDOM();
  const { Conversation } = await importModules();
  const root = document.createElement('div');
  const conv = new Conversation(root, conversationOptions);
  if (replay) conv._replayMode = true;
  for (const ev of events) conv.apply(ev);
  return root;
}

const items = (root) => [...root.querySelectorAll('.qa-item')];

test('a stamped echo renders .msg.user.question-answer with data-user-index and rewind/fork kept', async () => {
  const calls = [];
  const ev = stamped([FRUIT], [{ kind: 'option', label: 'Apple' }]);
  const root = await render([ev], {
    conversationOptions: {
      onRewind: (i, t) => calls.push(['rewind', i, t]),
      onFork: (i, t) => calls.push(['fork', i, t]),
    },
  });
  const wrap = root.querySelector('.msg.user.question-answer');
  assert.ok(wrap, 'the bubble is a user message with the answer class');
  assert.equal(wrap.getAttribute('data-user-index'), '4');
  assert.ok(wrap.querySelector('.block.question-answer'), 'the answer block is inside');
  wrap.querySelector('.user-msg-rewind').click();
  wrap.querySelector('.user-msg-fork').click();
  assert.deepEqual(calls, [['rewind', 4, ev.text], ['fork', 4, ev.text]],
    'rewind/fork prefill with the raw event text');
});

test('single option renders a header, the question, one chip and a singular head', async () => {
  const root = await render([stamped([FRUIT], [{ kind: 'option', label: 'Apple' }])]);
  assert.match(root.querySelector('.qa-head').textContent, /Answered$/, 'no count for one question');
  assert.match(root.querySelector('.qa-badge').textContent, /❓/);
  const [item] = items(root);
  assert.equal(item.dataset.kind, 'option');
  assert.equal(item.querySelector('.qa-q-header').textContent, 'Fruit');
  assert.equal(item.querySelector('.qa-q-text').textContent, 'Pick a fruit');
  assert.deepEqual([...item.querySelectorAll('.qa-choice')].map(n => n.textContent), ['Apple']);
  assertNull(root.querySelector('.qa-note'), 'no note without one');
  assertNull(root.querySelector('.user-text'), 'no raw text block when faithful');
});

test('multi-select renders one chip per label; several questions get a counted head', async () => {
  const root = await render([stamped([TOPPINGS, SIZE], [
    { kind: 'multi', labels: ['Nuts', 'Syrup'] }, { kind: 'option', label: 'L' }])]);
  assert.match(root.querySelector('.qa-head').textContent, /Answered · 2 questions$/);
  const [multi, size] = items(root);
  assert.equal(multi.dataset.kind, 'multi');
  assert.deepEqual([...multi.querySelectorAll('.qa-choice')].map(n => n.textContent), ['Nuts', 'Syrup']);
  assert.equal(size.dataset.kind, 'option');
  assertNull(size.querySelector('.qa-q-header'), 'a question without a header renders none');
  assert.equal(size.querySelector('.qa-q-text').textContent, 'Pick a size');
});

test('custom text renders in .qa-custom', async () => {
  const root = await render([stamped([FRUIT], [{ kind: 'custom', text: 'Mango — please' }])]);
  const [item] = items(root);
  assert.equal(item.dataset.kind, 'custom');
  assert.equal(item.querySelector('.qa-custom').textContent, 'Mango — please');
  assertNull(item.querySelector('.qa-choice'), 'no chip for a custom answer');
});

test('option + note renders .qa-note', async () => {
  const root = await render([stamped([FRUIT], [{ kind: 'option', label: 'Banana', note: 'ripe ones only' }])]);
  const [item] = items(root);
  assert.deepEqual([...item.querySelectorAll('.qa-choice')].map(n => n.textContent), ['Banana']);
  assert.equal(item.querySelector('.qa-note').textContent, '— ripe ones only');
});

test('a skipped question renders .qa-skipped', async () => {
  const root = await render([stamped([FRUIT, SIZE], [{ kind: 'none' }, { kind: 'option', label: 'S' }])]);
  const [skipped, answered] = items(root);
  assert.equal(skipped.dataset.kind, 'none');
  assert.equal(skipped.querySelector('.qa-skipped').textContent, 'skipped');
  assertNull(skipped.querySelector('.qa-choice'), 'no chip for a skipped question');
  assert.equal(answered.dataset.kind, 'option');
});

test('an unstamped "My answers:" prompt renders as a plain user bubble even with a question card above it', async () => {
  const questions = [FRUIT, SIZE];
  const text = formatUserQuestionAnswers(questions, [{ kind: 'option', label: 'Apple' }, { kind: 'option', label: 'S' }]);
  const root = await render([
    { kind: 'user_question', toolUseId: 'tu_q', questions },
    { kind: 'tool_result', toolUseId: 'tu_q', content: 'awaiting', isError: true, parentToolUseId: null },
    { kind: 'user_echo', userIndex: 1, text },
  ]);
  assert.ok(root.querySelector('.block.user-question'), 'premise: the card is rendered');
  const wrap = root.querySelector('.msg.user');
  assert.ok(wrap, 'the echo renders as a user bubble');
  assertNull(root.querySelector('.msg.user.question-answer'), 'not classified as an answer');
  assertNull(root.querySelector('.block.question-answer'), 'no answer block');
  assert.ok(wrap.querySelector('.user-text'), 'plain user-text block');
  assert.match(wrap.textContent, /My answers:/);
});

test('stamped text that fails the round-trip falls back to the raw text inside the answer bubble', async () => {
  const questions = [FRUIT, SIZE];
  // A multi-line custom answer: its second line is not a `- <question>: ` line,
  // so re-formatting the parsed answers cannot reproduce the text.
  const text = 'My answers:\n- Pick a fruit: Apple\n- Pick a size: extra\nlarge';
  const root = await render([{
    kind: 'user_echo', userIndex: 0, text,
    questionAnswer: { toolUseId: 'tu_q', questions },
  }]);
  const wrap = root.querySelector('.msg.user.question-answer');
  assert.ok(wrap, 'still an answer bubble');
  assert.match(wrap.querySelector('.qa-head').textContent, /Answered · 2 questions$/);
  assertNull(wrap.querySelector('.qa-list'), 'no structured rows for an unfaithful parse');
  const raw = wrap.querySelector('.block.question-answer > .user-text');
  assert.ok(raw, 'the raw text block is kept visible');
  assert.equal(raw.textContent.replace(/\s+/g, ' ').includes('extra'), true);
  assert.ok(wrap.querySelector('.role .user-view-toggle'), 'the raw/md controls reach the role row');
});

test('replay parity: the same events rendered live and in replay mode produce identical answer blocks', async () => {
  const questions = [FRUIT, TOPPINGS];
  const events = [
    { kind: 'user_question', toolUseId: 'tu_q', questions },
    { kind: 'tool_result', toolUseId: 'tu_q', content: 'awaiting', isError: true, parentToolUseId: null },
    stamped(questions, [{ kind: 'option', label: 'Banana', note: 'ripe' }, { kind: 'multi', labels: ['Nuts', 'Cream'] }]),
  ];
  const live = await render(events);
  const replayed = await render(events, { replay: true });
  const liveHtml = live.querySelector('.block.question-answer')?.outerHTML;
  assert.ok(liveHtml, 'premise: live render produced the block');
  assert.equal(replayed.querySelector('.block.question-answer')?.outerHTML, liveHtml);
});

test('lazy page boundary: renderEventBatch of a lone stamped echo, with no card in the batch, renders the same bubble', async () => {
  const questions = [FRUIT, SIZE];
  const echo = stamped(questions, [{ kind: 'option', label: 'Apple' }, { kind: 'custom', text: 'medium-ish' }]);
  const full = await render([{ kind: 'user_question', toolUseId: 'tu_q', questions }, echo]);
  const { renderEventBatch } = await importModules();
  const batch = renderEventBatch([echo]);
  assertNull(batch.holder.querySelector('.block.user-question'), 'premise: the card is on another page');
  const html = batch.holder.querySelector('.block.question-answer')?.outerHTML;
  assert.ok(html, 'the lone echo renders the answer bubble');
  assert.equal(html, full.querySelector('.block.question-answer').outerHTML);
});
