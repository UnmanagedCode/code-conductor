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
import { buildWakeStub } from '../public/wakeCallback.js';

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

test('replay mode: an interleaved wake stub does NOT consume the answer slot; the later real answer echo still locks the card', async () => {
  setupDOM();
  const Conversation = await importConversation();
  const root = document.createElement('div');
  const conv = new Conversation(root, {});

  // Snapshot replay: a wake-callback stub (another worker finished before the
  // user answered) lands between the tool_result and the real answer echo.
  const wakeStub = buildWakeStub({
    targetSessionId: 'abc12345',
    payloadText: '{"sessionId":"abc12345","messages":[]}\nsome recent output',
  });

  conv._replayMode = true;
  conv.apply(UQ_EVENT);
  conv.apply(TOOL_RESULT_EVENT);

  const qBlock = conv.userQuestionBlocks.get(Q_TOOL_USE_ID);
  assert.ok(qBlock, 'question block exists');

  // Interleaved non-answer echo: must NOT lock the card and must leave the slot armed.
  conv.apply({ kind: 'user_echo', text: wakeStub });
  assert.equal(qBlock.submitted, false, 'card must stay unlocked after the interleaved wake stub');
  assert.equal(conv._pendingAnswerUQId, Q_TOOL_USE_ID, 'answer slot stays armed for the real answer');

  // The real answer echo arrives later — the still-armed slot now applies it.
  conv.apply({ kind: 'user_echo', text: ANSWER_TEXT });
  conv._replayMode = false;

  assert.equal(qBlock.submitted, true, 'card locks on the real answer echo');
  assert.equal(conv._pendingAnswerUQId, null, 'slot consumed only on the matching answer');
  const applePick = [...qBlock.panes.querySelectorAll('button.uq-opt')]
    .find(b => b.dataset.label === 'Apple');
  assert.ok(applePick?.classList.contains('picked'), 'Apple option is marked as picked');
});

test('replay mode: a MID-TURN answer replayed from disk still locks the card with the right option', async () => {
  // Card answers are now sent unconditionally, so a mid-turn answer is the
  // normal case and Instance.prompt prepends MID_TURN_NOTE. The note rides as
  // its OWN content block and consolidateUserContent strips it, which is the
  // only reason isUserQuestionAnswerText's startsWith still matches. Fold the
  // note into the text instead and every mid-turn answer silently unpairs from
  // its card — this test goes through the real replay path to prove it doesn't.
  const { replayPersistedLine } = await import('../src/transcript.ts');
  const { MID_TURN_NOTE } = await import('../src/instances.ts');

  const evs = replayPersistedLine({
    type: 'user',
    message: {
      role: 'user',
      content: [
        { type: 'text', text: MID_TURN_NOTE },
        { type: 'text', text: ANSWER_TEXT },
      ],
    },
  });
  const echo = evs.find(e => e.kind === 'user_echo');
  assert.ok(echo, 'replay emitted a user_echo');
  assert.equal(echo.text, ANSWER_TEXT, 'the note was stripped before the echo');

  setupDOM();
  const Conversation = await importConversation();
  const root = document.createElement('div');
  const conv = new Conversation(root, {});

  conv._replayMode = true;
  conv.apply(UQ_EVENT);
  conv.apply(TOOL_RESULT_EVENT);
  conv.apply(echo);
  conv._replayMode = false;

  const qBlock = conv.userQuestionBlocks.get(Q_TOOL_USE_ID);
  assert.equal(qBlock.submitted, true, 'card locks on the replayed mid-turn answer');
  const applePick = [...qBlock.panes.querySelectorAll('button.uq-opt')]
    .find(b => b.dataset.label === 'Apple');
  assert.ok(applePick?.classList.contains('picked'), 'Apple is recovered as the picked option');
});

test('markSendFailed re-opens a card whose answer never reached the CLI', async () => {
  // With the idle gate gone the send is fire-and-forget over a socket that can
  // be down (or aimed at a killed instance). _submit() locks the card and shows
  // 'sending…' BEFORE the send, so a failure must un-lock it — otherwise the
  // card asserts a delivery that never happened.
  setupDOM();
  const Conversation = await importConversation();
  const root = document.createElement('div');
  const conv = new Conversation(root, { onUserQuestionSubmit: () => {} });

  conv.apply(UQ_EVENT);
  conv.apply(TOOL_RESULT_EVENT);
  const qBlock = conv.userQuestionBlocks.get(Q_TOOL_USE_ID);

  qBlock._pickOption(0, 'Apple');
  qBlock._submit();
  assert.equal(qBlock.submitted, true, 'precondition: card locked on submit');
  assert.equal(qBlock.statusNode.textContent, 'sending…');

  qBlock.markSendFailed('not connected');

  assert.equal(qBlock.submitted, false, 'card is re-opened');
  assert.ok(!qBlock.node.classList.contains('answered'), 'answered styling dropped');
  assert.match(qBlock.statusNode.textContent, /couldn't send — not connected/);
  for (const btn of qBlock.panes.querySelectorAll('button.uq-opt')) {
    assert.equal(btn.disabled, false, `option "${btn.dataset.label}" is selectable again`);
  }
  for (const input of qBlock.panes.querySelectorAll('.uq-custom-input')) {
    assert.equal(input.disabled, false, 'custom input is editable again');
  }
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
