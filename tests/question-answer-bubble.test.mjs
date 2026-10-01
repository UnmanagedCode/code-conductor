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
import { formatUserQuestionAnswers, parseUserQuestionAnswers } from '../public/userQuestionAnswers.js';

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

async function render(events, { conversationOptions = {} } = {}) {
  setupDOM();
  const { Conversation } = await importModules();
  const root = document.createElement('div');
  const conv = new Conversation(root, conversationOptions);
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

test('batch parity: the same events rendered live and through renderEventBatch produce identical answer blocks', async () => {
  const questions = [FRUIT, TOPPINGS];
  const events = [
    { kind: 'user_question', toolUseId: 'tu_q', questions },
    { kind: 'tool_result', toolUseId: 'tu_q', content: 'awaiting', isError: true, parentToolUseId: null },
    stamped(questions, [{ kind: 'option', label: 'Banana', note: 'ripe' }, { kind: 'multi', labels: ['Nuts', 'Cream'] }]),
  ];
  const live = await render(events);
  const { renderEventBatch } = await importModules();
  const batch = renderEventBatch(events);
  const liveHtml = live.querySelector('.block.question-answer')?.outerHTML;
  assert.ok(liveHtml, 'premise: live render produced the block');
  assert.equal(batch.holder.querySelector('.block.question-answer')?.outerHTML, liveHtml);
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

// --- The answered state of the question CARD follows the server stamp ---------

const CARD = { kind: 'user_question', toolUseId: 'tu_q', questions: [FRUIT] };
const CARD_RESULT = { kind: 'tool_result', toolUseId: 'tu_q', content: 'awaiting', isError: true, parentToolUseId: null };
const TURN_END = { kind: 'turn_end' };
// The answer: Banana (not the first option) with a note, so the pick and the
// note are read from the stamp text rather than defaulted.
const bananaEcho = (toolUseId = 'tu_q') => {
  const ev = stamped([FRUIT], [{ kind: 'option', label: 'Banana', note: 'ripe ones only' }]);
  ev.questionAnswer = { toolUseId, questions: [FRUIT] };
  return ev;
};

// Every facet of "answered, showing the pick, controls off" as its own assert.
function assertCardLocked(card, label) {
  assert.ok(card, `${label}: the card rendered`);
  assert.ok(card.classList.contains('answered'), `${label}: .answered`);
  const opts = [...card.querySelectorAll('button.uq-opt')];
  assert.equal(opts.length, 2, `${label}: premise — two options`);
  const banana = opts.find(b => b.dataset.label === 'Banana');
  assert.ok(banana.classList.contains('picked'), `${label}: Banana is picked`);
  assert.ok(!opts.find(b => b.dataset.label === 'Apple').classList.contains('picked'), `${label}: Apple is not picked`);
  for (const b of opts) assert.equal(b.disabled, true, `${label}: option ${b.dataset.label} disabled`);
  const custom = [...card.querySelectorAll('.uq-custom-input')];
  assert.ok(custom.length > 0, `${label}: premise — a custom input exists`);
  for (const i of custom) assert.equal(i.disabled, true, `${label}: custom input disabled`);
  assert.equal(custom[0].value, 'ripe ones only', `${label}: the note is shown`);
  assert.equal(card.querySelector('.uq-submit').disabled, true, `${label}: Send disabled`);
  assert.equal(card.querySelector('.uq-status').textContent, 'answered', `${label}: the status line says answered`);
}

function assertCardOpen(card, label) {
  assert.ok(card, `${label}: the card rendered`);
  assert.ok(!card.classList.contains('answered'), `${label}: not .answered`);
  for (const b of card.querySelectorAll('button.uq-opt')) {
    assert.equal(b.disabled, false, `${label}: option ${b.dataset.label} enabled`);
    assert.ok(!b.classList.contains('picked'), `${label}: option ${b.dataset.label} not picked`);
  }
  for (const i of card.querySelectorAll('.uq-custom-input')) assert.equal(i.disabled, false, `${label}: custom input enabled`);
}

async function freshConversation(options = {}) {
  setupDOM();
  const { Conversation, renderEventBatch } = await importModules();
  const root = document.createElement('div');
  return { conv: new Conversation(root, options), root, renderEventBatch };
}

test('live: a stamped answer echo locks its card that this tab never submitted', async () => {
  const { conv, root } = await freshConversation();
  for (const ev of [CARD, CARD_RESULT, TURN_END, bananaEcho()]) conv.apply(ev);
  assertCardLocked(root.querySelector('.block.user-question'), 'live');
});

test('live after a snapshot: a stamped echo arriving after the replayed card locks it', async () => {
  const { conv, root } = await freshConversation();
  conv.applyEvents([CARD, CARD_RESULT, TURN_END]); // the snapshot's replay
  assertCardOpen(root.querySelector('.block.user-question'), 'premise: unanswered after the snapshot');
  conv.apply(bananaEcho()); // the echo arrives as a live event
  assertCardLocked(root.querySelector('.block.user-question'), 'after snapshot');
});

test('reload: card and stamped echo in one batch lock the card', async () => {
  const { renderEventBatch } = await freshConversation();
  const batch = renderEventBatch([CARD, CARD_RESULT, TURN_END, bananaEcho()]);
  assertCardLocked(batch.holder.querySelector('.block.user-question'), 'one batch');
});

test('reload: a card on an older lazy page locks from an answer stamped in the tail', async () => {
  const { conv, renderEventBatch } = await freshConversation();
  conv.apply(bananaEcho()); // the tail page holds only the echo
  const batch = renderEventBatch([CARD, CARD_RESULT, TURN_END], {}, { answeredQuestions: conv.answeredQuestions });
  assertCardLocked(batch.holder.querySelector('.block.user-question'), 'older page');
});

test('reload: an answer stamped on page N locks the card on page N+1 through the shared map', async () => {
  const { conv, renderEventBatch } = await freshConversation();
  const answeredQuestions = conv.answeredQuestions;
  const pageN = renderEventBatch([TURN_END, bananaEcho()], {}, { answeredQuestions });
  assertNull(pageN.holder.querySelector('.block.user-question'), 'premise: the card is on the next page down');
  const pageN1 = renderEventBatch([CARD, CARD_RESULT], {}, { answeredQuestions });
  assertCardLocked(pageN1.holder.querySelector('.block.user-question'), 'page N+1');
});

const unstampedEcho = () => ({
  kind: 'user_echo', userIndex: 4,
  text: formatUserQuestionAnswers([FRUIT], [{ kind: 'option', label: 'Banana', note: 'ripe ones only' }]),
});

test('an unstamped answer-shaped echo does not lock the card live', async () => {
  const { conv, root } = await freshConversation();
  for (const ev of [CARD, CARD_RESULT, TURN_END, unstampedEcho()]) conv.apply(ev);
  assertCardOpen(root.querySelector('.block.user-question'), 'live');
});

test('an unstamped answer-shaped echo does not lock the card in a batch', async () => {
  const { renderEventBatch } = await freshConversation();
  const batch = renderEventBatch([CARD, CARD_RESULT, TURN_END, unstampedEcho()]);
  assertCardOpen(batch.holder.querySelector('.block.user-question'), 'batch');
});

// The state a locked card must hold whatever the user does to it.
function assertStillLocked(card, label) {
  assert.ok(card.classList.contains('answered'), `${label}: .answered`);
  assert.equal(card.querySelector('.uq-submit').disabled, true, `${label}: Send disabled`);
  for (const b of card.querySelectorAll('button.uq-opt')) assert.equal(b.disabled, true, `${label}: option ${b.dataset.label} disabled`);
  for (const i of card.querySelectorAll('.uq-custom-input')) assert.equal(i.disabled, true, `${label}: custom input disabled`);
}

test('a stamped custom-only answer is shown in the locked card\'s text field', async () => {
  const { conv, root } = await freshConversation();
  for (const ev of [CARD, CARD_RESULT, TURN_END,
    stamped([FRUIT], [{ kind: 'custom', text: 'Mango — please' }])]) conv.apply(ev);
  const card = root.querySelector('.block.user-question');
  assertStillLocked(card, 'custom answer');
  assert.equal(card.querySelector('.uq-custom-input').value, 'Mango — please', 'the custom text is shown whole');
  assert.equal(card.querySelectorAll('button.uq-opt.picked').length, 0, 'no option is picked');
  assert.ok(card.querySelector('.uq-custom-input').classList.contains('active'), 'the field carries its custom-answer state');
});

test('tab switching on a stamped-locked two-question card shows each pane\'s pick, note and text and keeps the card locked', async () => {
  const questions = [FRUIT, SIZE];
  const card = { kind: 'user_question', toolUseId: 'tu_q', questions };
  const { conv, root } = await freshConversation();
  for (const ev of [card, CARD_RESULT, TURN_END,
    stamped(questions, [{ kind: 'option', label: 'Banana', note: 'ripe' }, { kind: 'custom', text: 'medium-ish' }])]) conv.apply(ev);
  const el = root.querySelector('.block.user-question');
  const pane = (idx) => el.querySelector(`.uq-pane[data-idx="${idx}"]`);
  const picked = (idx) => [...pane(idx).querySelectorAll('button.uq-opt.picked')].map(b => b.dataset.label);
  const status = el.querySelector('.uq-status').textContent;
  assert.equal(status, 'answered', 'a stamp-locked card\'s status line says answered');
  assertStillLocked(el, 'before any tab click');
  assert.deepEqual(picked(0), ['Banana'], 'the active pane shows question 1\'s pick');
  assert.equal(pane(0).querySelector('.uq-custom-input').value, 'ripe', 'and its note');

  el.querySelectorAll('.uq-tab')[1].click();
  assertStillLocked(el, 'on the second tab');
  assert.deepEqual(picked(1), [], 'question 2 was a custom answer: nothing picked');
  assert.equal(pane(1).querySelector('.uq-custom-input').value, 'medium-ish', 'its text is shown');
  assert.equal(el.querySelector('.uq-status').textContent, status, 'the status line is untouched by a tab click');

  el.querySelectorAll('.uq-tab')[0].click();
  assertStillLocked(el, 'back on the first tab');
  assert.deepEqual(picked(0), ['Banana'], 'the first pane still shows its pick');
  assert.equal(pane(0).querySelector('.uq-custom-input').value, 'ripe', 'and its note');
  assert.equal(el.querySelector('.uq-status').textContent, status, 'the status line is still untouched');
});

test('a card submitted in this tab stays fully disabled through a tab click', async () => {
  const questions = [FRUIT, SIZE];
  const card = { kind: 'user_question', toolUseId: 'tu_q', questions };
  const sent = [];
  const { conv, root } = await freshConversation({ onUserQuestionSubmit: (s) => sent.push(s) });
  for (const ev of [card, CARD_RESULT]) conv.apply(ev);
  const el = root.querySelector('.block.user-question');
  el.querySelector('.uq-pane[data-idx="0"] button.uq-opt[data-label="Banana"]').click();
  el.querySelectorAll('.uq-tab')[1].click();
  el.querySelector('.uq-pane[data-idx="1"] button.uq-opt[data-label="L"]').click();
  el.querySelector('.uq-submit').click();
  assert.equal(sent.length, 1, 'premise: the submit went out');
  const status = el.querySelector('.uq-status').textContent;
  assertStillLocked(el, 'after submit');
  el.querySelectorAll('.uq-tab')[0].click();
  assertStillLocked(el, 'after a tab click');
  assert.equal(el.querySelector('.uq-status').textContent, status, 'the sending status line is untouched');
});

test('a card this tab submitted reads answered, not sending…, once its stamped echo arrives', async () => {
  const sent = [];
  const { conv, root } = await freshConversation({ onUserQuestionSubmit: (s) => sent.push(s) });
  for (const ev of [CARD, CARD_RESULT]) conv.apply(ev);
  const card = root.querySelector('.block.user-question');
  card.querySelector('button.uq-opt[data-label="Banana"]').click();
  card.querySelector('.uq-submit').click();
  assert.equal(sent.length, 1, 'premise: the submit went out');
  assert.equal(card.querySelector('.uq-status').textContent, 'sending…', 'premise: in flight until the echo');
  conv.apply(bananaEcho());
  assert.equal(card.querySelector('.uq-status').textContent, 'answered', 'the stamped echo settles the status line');
  assertStillLocked(card, 'after the stamped echo');
});

test('a card already rendered on a lazy page locks when its stamped answer arrives live', async () => {
  const { conv, renderEventBatch } = await freshConversation();
  const batch = renderEventBatch([CARD, CARD_RESULT, TURN_END], {}, {
    answeredQuestions: conv.answeredQuestions, userQuestionBlocks: conv.userQuestionBlocks,
  });
  assertCardOpen(batch.holder.querySelector('.block.user-question'), 'premise: unanswered on its page');
  conv.apply(bananaEcho());
  assertCardLocked(batch.holder.querySelector('.block.user-question'), 'lazy-page card, answer live');
});

test('a stamp naming an earlier card locks it and leaves the later, still-open card alone', async () => {
  const cardB = { kind: 'user_question', toolUseId: 'tu_b', questions: [FRUIT] };
  const { conv, root } = await freshConversation();
  for (const ev of [CARD, CARD_RESULT, cardB, { ...CARD_RESULT, toolUseId: 'tu_b' }, bananaEcho('tu_q')]) conv.apply(ev);
  const [a, b] = root.querySelectorAll('.block.user-question');
  assertCardLocked(a, 'earlier card A, named by the stamp');
  assertCardOpen(b, 'later card B, not named');
});

test('a stamp for card B leaves card A open', async () => {
  const cardB = { kind: 'user_question', toolUseId: 'tu_b', questions: [FRUIT] };
  const { conv, root } = await freshConversation();
  for (const ev of [CARD, CARD_RESULT, cardB, { ...CARD_RESULT, toolUseId: 'tu_b' }, bananaEcho('tu_b')]) conv.apply(ev);
  const [a, b] = root.querySelectorAll('.block.user-question');
  assertCardOpen(a, 'card A');
  assertCardLocked(b, 'card B');
});

test('a stamp naming a toolUseId absent from the registry leaves a registered card open', async () => {
  const { conv, root } = await freshConversation();
  const cardA = { ...CARD, toolUseId: 'tu_a' };
  for (const ev of [cardA, { ...CARD_RESULT, toolUseId: 'tu_a' }, bananaEcho('tu_absent')]) conv.apply(ev);
  assertCardOpen(root.querySelector('.block.user-question'), 'card A, not named');
  assert.equal(conv.answeredQuestions.has('tu_absent'), true, 'the answer is recorded under the id the stamp names');
  assert.equal(conv.answeredQuestions.has('tu_a'), false, 'and not under the registered card\'s id');
});

test('a stamp for a card that never renders in this view locks nothing and clears with the conversation', async () => {
  const { conv, root } = await freshConversation();
  conv.apply(bananaEcho('tu_gone'));
  assert.equal(conv.answeredQuestions.has('tu_gone'), true, 'premise: the stamp is recorded');
  conv.clear();
  assert.equal(conv.answeredQuestions.size, 0, 'clear() forgets recorded answers');
  for (const ev of [CARD, CARD_RESULT]) conv.apply(ev);
  assertCardOpen(root.querySelector('.block.user-question'), 'after clear');
});

// --- Hard-case answers: exact rows on replay, exact picks on the locked card ---

const opts = (...labels) => labels.map(label => ({ label }));
const DASH = { question: 'Is "x" ok?', options: opts('Fast — risky', 'Slow — safe') };
const PREFIXED = { question: 'Sure?', options: opts('Yes', 'Yes — sure') };
const COMMA = { question: 'Pick types', multiSelect: true, options: opts('Lists, tuples', 'Dicts') };
const SAME = { question: 'Same?', options: opts('Yes', 'No') };
const QUOTE = { question: 'Greet', options: opts('say "hi"', 'wave') };

const HARD_CASES = {
  'case 1: a label holding " — ", with a note': [[DASH], [{ kind: 'option', label: 'Slow — safe', note: 'thanks' }]],
  'case 2: a label that begins with another label': [[PREFIXED], [{ kind: 'option', label: 'Yes — sure' }]],
  'case 3: an Other answer that begins with "<label> — "': [[PREFIXED], [{ kind: 'custom', text: 'Yes — maybe' }]],
  'case 4: a multiSelect label holding ", "': [[COMMA], [{ kind: 'multi', labels: ['Lists, tuples', 'Dicts'] }]],
  'case 5: two questions with identical text': [[SAME, SAME],
    [{ kind: 'option', label: 'No', note: 'second' }, { kind: 'option', label: 'Yes' }]],
  'case 6: a multi-line note and multi-line custom text in a two-question card': [[FRUIT, SAME],
    [{ kind: 'option', label: 'Apple', note: 'line one\nline two' }, { kind: 'custom', text: 'extra\nlarge' }]],
  'a label holding a quote': [[QUOTE], [{ kind: 'option', label: 'say "hi"' }]],
};

function assertRows(root, questions, answers) {
  const rows = items(root);
  assert.equal(rows.length, questions.length, 'one row per question');
  answers.forEach((a, i) => {
    const row = rows[i];
    assert.equal(row.dataset.kind, a.kind, `row ${i}: kind`);
    const labels = a.kind === 'option' ? [a.label] : a.kind === 'multi' ? a.labels : [];
    assert.deepEqual([...row.querySelectorAll('.qa-choice')].map(n => n.textContent), labels, `row ${i}: chips`);
    if (a.kind === 'custom') assert.equal(row.querySelector('.qa-custom').textContent, a.text, `row ${i}: custom text`);
    else assertNull(row.querySelector('.qa-custom'), `row ${i}: no custom text`);
    if (a.note) assert.equal(row.querySelector('.qa-note').textContent, `— ${a.note}`, `row ${i}: note`);
    else assertNull(row.querySelector('.qa-note'), `row ${i}: no note`);
  });
  assertNull(root.querySelector('.user-text'), 'no raw text fallback');
}

function assertCardPicks(card, questions, answers) {
  assert.ok(card.classList.contains('answered'), 'the card is locked');
  answers.forEach((a, i) => {
    if (questions.length > 1) card.querySelectorAll('.uq-tab')[i].click();
    const pane = card.querySelector(`.uq-pane[data-idx="${i}"]`);
    const want = a.kind === 'option' ? [a.label] : a.kind === 'multi' ? a.labels : [];
    const picked = [...pane.querySelectorAll('button.uq-opt.picked')].map(b => b.dataset.label);
    assert.deepEqual(picked, questions[i].options.map(o => o.label).filter(l => want.includes(l)), `pane ${i}: picks`);
    const input = pane.querySelector('.uq-custom-input');
    assert.equal(input.disabled, true, `pane ${i}: field disabled`);
    const draft = a.kind === 'custom' ? a.text : (a.note ?? '');
    // A text <input> strips line breaks from its value (HTML value sanitization).
    assert.equal(input.value, draft.replace(/[\r\n]/g, ''), `pane ${i}: field text`);
  });
}

test('replay: hard-case answers render their exact rows and lock the card', async (t) => {
  for (const [name, [questions, answers]] of Object.entries(HARD_CASES)) {
    await t.test(name, async () => {
      const { renderEventBatch } = await freshConversation();
      const batch = renderEventBatch([
        { kind: 'user_question', toolUseId: 'tu_q', questions }, CARD_RESULT, TURN_END,
        stamped(questions, answers),
      ]);
      assertRows(batch.holder, questions, answers);
      assertCardPicks(batch.holder.querySelector('.block.user-question'), questions, answers);
    });
  }
});

const OLD_FORMAT = {
  'old single-question form': [[FRUIT], 'Answer to "Pick a fruit": Banana — ripe ones only'],
  'old multi-question form': [[FRUIT, SIZE], 'My answers:\n- Pick a fruit: Apple\n- Pick a size: L'],
};

test('an old-format answer renders raw inside the answer bubble and locks the card with no pick', async (t) => {
  for (const [name, [questions, text]] of Object.entries(OLD_FORMAT)) {
    await t.test(name, async () => {
      const { conv, root } = await freshConversation();
      for (const ev of [
        { kind: 'user_question', toolUseId: 'tu_q', questions }, CARD_RESULT, TURN_END,
        { kind: 'user_echo', userIndex: 0, text, questionAnswer: { toolUseId: 'tu_q', questions } },
      ]) conv.apply(ev);
      const wrap = root.querySelector('.msg.user.question-answer');
      assert.ok(wrap, 'still an answer bubble');
      assert.match(wrap.querySelector('.qa-head').textContent, /Answered/);
      assertNull(wrap.querySelector('.qa-list'), 'no structured rows for an unparseable answer');
      const raw = wrap.querySelector('.block.question-answer > .user-text');
      assert.ok(raw, 'the raw text block is kept visible');
      assert.ok(raw.textContent.includes('Apple') || raw.textContent.includes('Banana'), 'the raw text is shown');
      assert.ok(wrap.querySelector('.role .user-view-toggle'), 'the raw/md controls reach the role row');
      const card = root.querySelector('.block.user-question');
      assertStillLocked(card, name);
      assert.equal(card.querySelectorAll('button.uq-opt.picked').length, 0, 'no option is picked');
      for (const i of card.querySelectorAll('.uq-custom-input')) assert.equal(i.value, '', 'no field text');
    });
  }
});

// Text the strict parse accepts but the formatter would never emit: the bubble
// and the card must agree on it, as they do on an old-format answer.
const NON_CANONICAL = {
  'untrimmed custom text': 'Answer to "Pick a fruit": (own answer) " Mango "',
  'a JSON-escape spelling of a label': 'Answer to "Pick a fruit": "\\u0041pple"',
  'an untrimmed note': 'Answer to "Pick a fruit": "Banana" (note: " ripe ")',
};

function assertRawBubble(root) {
  const wrap = root.querySelector('.msg.user.question-answer');
  assert.ok(wrap, 'an answer bubble');
  assertNull(wrap.querySelector('.qa-list'), 'no structured rows for a non-canonical answer');
  assert.ok(wrap.querySelector('.block.question-answer > .user-text'), 'the raw text block is shown');
}

function assertLockedNoPick(card, label) {
  assertStillLocked(card, label);
  assert.equal(card.querySelectorAll('button.uq-opt.picked').length, 0, `${label}: no option is picked`);
  for (const i of card.querySelectorAll('.uq-custom-input')) assert.equal(i.value, '', `${label}: no field text`);
}

test('a non-canonical answer the strict parse accepts renders raw and locks the card with no pick', async (t) => {
  for (const [name, text] of Object.entries(NON_CANONICAL)) {
    const echo = { kind: 'user_echo', userIndex: 0, text, questionAnswer: { toolUseId: 'tu_q', questions: [FRUIT] } };
    await t.test(`${name}: premise — the strict parse accepts it`, () => {
      assert.notDeepEqual(parseUserQuestionAnswers([FRUIT], text), [{ kind: 'none' }]);
    });
    await t.test(`${name}: live, the echo after the card`, async () => {
      const { conv, root } = await freshConversation();
      for (const ev of [CARD, CARD_RESULT, TURN_END, echo]) conv.apply(ev);
      assertRawBubble(root);
      assertLockedNoPick(root.querySelector('.block.user-question'), 'live');
    });
    await t.test(`${name}: the card born after its answer was seen`, async () => {
      const { conv, root, renderEventBatch } = await freshConversation();
      conv.apply(echo);
      assertRawBubble(root);
      const batch = renderEventBatch([CARD, CARD_RESULT], {}, { answeredQuestions: conv.answeredQuestions });
      assertLockedNoPick(batch.holder.querySelector('.block.user-question'), 'older page');
    });
  }
});

// `question: false` is a card that renders (el() skips a false child) whose
// question text is not a string.
test('a card whose question text is not a string: the older-page path locks it without throwing', async (t) => {
  const questions = [{ question: false, options: opts('Apple', 'Banana') }];
  const card = { kind: 'user_question', toolUseId: 'tu_q', questions };
  const stampedEcho = (text) => ({ kind: 'user_echo', userIndex: 0, text, questionAnswer: { toolUseId: 'tu_q', questions } });
  await t.test('a foreign answer text locks it with no pick', async () => {
    const { conv, root, renderEventBatch } = await freshConversation();
    conv.apply(stampedEcho('Answer to "": Banana'));
    assertRawBubble(root);
    const batch = renderEventBatch([card, CARD_RESULT], {}, { answeredQuestions: conv.answeredQuestions });
    assertLockedNoPick(batch.holder.querySelector('.block.user-question'), 'foreign text');
  });
  await t.test('the formatter\'s own text locks it with its pick, as its bubble rows show', async () => {
    const { conv, root, renderEventBatch } = await freshConversation();
    const answers = [{ kind: 'option', label: 'Banana', note: 'ripe' }];
    conv.apply(stampedEcho(formatUserQuestionAnswers(questions, answers)));
    assertRows(root, questions, answers);
    const batch = renderEventBatch([card, CARD_RESULT], {}, { answeredQuestions: conv.answeredQuestions });
    const cardEl = batch.holder.querySelector('.block.user-question');
    assertStillLocked(cardEl, 'canonical text');
    assertCardPicks(cardEl, questions, answers);
  });
});
