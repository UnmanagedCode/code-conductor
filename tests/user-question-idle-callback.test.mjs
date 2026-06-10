// Regression tests for the bug where an idle-callback user_echo arriving
// while an AskUserQuestion card was still open would lock the card.
//
// Root cause: _pendingAnswerUQId was set when the AskUserQuestion tool_result
// arrived, and the first user_echo to follow — even one from an unrelated
// source like an idle callback — would call markAnswered(), locking the card.
//
// Fix: markAnswered() is only called from _renderUserEcho when either
//   (a) _replayMode is true (snapshot replay — the echo IS the answer), or
//   (b) the card has already been submitted by the user (qBlock.submitted).

import { test } from 'node:test';
import assert from 'node:assert/strict';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { Window } from 'happy-dom';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const PUB = path.resolve(__dirname, '..', 'public');

// Stub AudioContext + fetch before any block/conversation import.
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

// Unique import URLs so each test gets a fresh module instance.
let uid = 0;
async function importConversation() {
  uid++;
  const { Conversation } =
    await import(pathToFileURL(path.join(PUB, 'conversation.js')).href + `?uid=${uid}`);
  return Conversation;
}

// A minimal user_question event.
const Q_TOOL_USE_ID = 'tu_q1';
const QUESTIONS = [{ question: 'Pick a fruit', options: [{ label: 'Apple' }, { label: 'Banana' }] }];
const UQ_EVENT = {
  kind: 'user_question',
  toolUseId: Q_TOOL_USE_ID,
  questions: QUESTIONS,
};
// The tool_result that the PreToolUse hook generates (is_error).
const TOOL_RESULT_EVENT = {
  kind: 'tool_result',
  toolUseId: Q_TOOL_USE_ID,
  content: 'AskUserQuestion: denied by hook',
  isError: true,
};
// A formatted answer text (what the user would have submitted).
const ANSWER_TEXT = 'Answer to "Pick a fruit": Apple';
// An unrelated prompt text — simulates an idle-callback injected by subscribe_to_idle.
const IDLE_CB_TEXT = 'Worker `abc` finished its turn. Call get_recent_messages to inspect the result.';

test('live mode: idle-callback user_echo does NOT lock an unanswered question card', async () => {
  setupDOM();
  const Conversation = await importConversation();
  const root = document.createElement('div');
  const conv = new Conversation(root, {});

  // Render the question card.
  conv.apply(UQ_EVENT);
  // The tool_result sets _pendingAnswerUQId.
  conv.apply(TOOL_RESULT_EVENT);

  const qBlock = conv.userQuestionBlocks.get(Q_TOOL_USE_ID);
  assert.ok(qBlock, 'question block exists');
  assert.equal(qBlock.submitted, false, 'card is not submitted before the echo');

  // Simulate the idle-callback echo arriving before the user answers.
  // _replayMode is false (live mode default).
  assert.equal(conv._replayMode, false, '_replayMode starts false');
  conv.apply({ kind: 'user_echo', text: IDLE_CB_TEXT });

  assert.equal(qBlock.submitted, false, 'card must remain unsubmitted after idle-callback echo');
  assert.equal(qBlock.submitBtn.disabled, true, 'submit button stays disabled (no answer selected)');
  // Option buttons should not be disabled by the idle echo.
  const optBtns = [...qBlock.panes.querySelectorAll('button.uq-opt')];
  assert.ok(optBtns.length > 0, 'option buttons exist');
  for (const btn of optBtns) {
    assert.equal(btn.disabled, false, `option button "${btn.dataset.label}" must remain enabled`);
  }
  // Custom input should remain enabled.
  const inputs = [...qBlock.panes.querySelectorAll('.uq-custom-input')];
  for (const input of inputs) {
    assert.equal(input.disabled, false, 'custom input must remain enabled');
  }
});

test('replay mode: user_echo after tool_result DOES lock the card (snapshot replay)', async () => {
  setupDOM();
  const Conversation = await importConversation();
  const root = document.createElement('div');
  const conv = new Conversation(root, {});

  // Simulate what the snapshot handler does: set _replayMode = true around the loop.
  conv._replayMode = true;
  conv.apply(UQ_EVENT);
  conv.apply(TOOL_RESULT_EVENT);
  conv.apply({ kind: 'user_echo', text: ANSWER_TEXT });
  conv._replayMode = false;

  const qBlock = conv.userQuestionBlocks.get(Q_TOOL_USE_ID);
  assert.ok(qBlock, 'question block exists');
  assert.equal(qBlock.submitted, true, 'card must be locked after replay echo');
  assert.equal(qBlock.submitBtn.disabled, true, 'submit button disabled');
  // Selected option should be highlighted.
  const applePick = [...qBlock.panes.querySelectorAll('button.uq-opt')]
    .find(b => b.dataset.label === 'Apple');
  assert.ok(applePick?.classList.contains('picked'), 'Apple option is marked as picked');
});

test('live mode: user submits card, then echo arrives — card stays locked (normal live flow)', async () => {
  setupDOM();
  const Conversation = await importConversation();
  const root = document.createElement('div');

  let submittedPayload = null;
  const conv = new Conversation(root, {
    onUserQuestionSubmit: (p) => { submittedPayload = p; },
  });

  conv.apply(UQ_EVENT);
  conv.apply(TOOL_RESULT_EVENT);

  const qBlock = conv.userQuestionBlocks.get(Q_TOOL_USE_ID);
  assert.ok(qBlock, 'question block exists');

  // Simulate the user picking an option and submitting.
  qBlock._pickOption(0, 'Banana');
  qBlock._submit();
  assert.equal(qBlock.submitted, true, 'card locked after user submit');
  assert.ok(submittedPayload, 'onSubmit was called');

  // Now the echo arrives (server echoes the user prompt).
  conv.apply({ kind: 'user_echo', text: 'Answer to "Pick a fruit": Banana' });

  // Card remains locked (markAnswered no-ops because submitted=true).
  assert.equal(qBlock.submitted, true, 'card stays locked after echo');
  assert.equal(qBlock.submitBtn.disabled, true, 'submit button stays disabled');
});
