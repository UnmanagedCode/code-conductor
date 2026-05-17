// DOM-level tests for the parser → conversation rendering pipeline. These
// reproduce real-claude streaming sequences (a Bash tool call, an
// AskUserQuestion tool call) and assert what actually lands in the rendered
// DOM. Without these, the parser tests pass green while the user-facing UI
// is broken.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { Window } from 'happy-dom';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const PUB = path.resolve(__dirname, '..', 'public');

async function setupDOM() {
  const window = new Window({ url: 'http://localhost/' });
  // Make the browser-globals accessible to the modules we're about to import.
  globalThis.window = window;
  globalThis.document = window.document;
  globalThis.HTMLElement = window.HTMLElement;
  globalThis.Element = window.Element;
  globalThis.Node = window.Node;

  const { Parser } = await import(pathToFileURL(path.resolve(__dirname, '..', 'src', 'parser.js')).href);
  const { Conversation } = await import(pathToFileURL(path.join(PUB, 'conversation.js')).href);

  // Fresh root each time we ask for a setup.
  document.body.innerHTML = '<div id="root"></div>';
  const root = document.getElementById('root');
  return { window, document, root, Parser, Conversation };
}

function feed(parser, conversation, lines) {
  for (const line of lines) {
    const obj = typeof line === 'string' ? JSON.parse(line) : line;
    const events = parser.handleObject(obj);
    for (const ev of events) conversation.apply(ev);
  }
}

// Reproduces the on-the-wire shape real claude emits for a Bash tool call.
function bashToolCallStream() {
  const msgId = 'msg_test_bash';
  return [
    { type: 'stream_event', event: { type: 'message_start', message: { id: msgId, role: 'assistant' } } },
    { type: 'stream_event', event: { type: 'content_block_start', index: 0, content_block: { type: 'tool_use', id: 'tu_bash', name: 'Bash', input: {} } } },
    { type: 'stream_event', event: { type: 'content_block_delta', index: 0, delta: { type: 'input_json_delta', partial_json: '{"command":"' } } },
    { type: 'stream_event', event: { type: 'content_block_delta', index: 0, delta: { type: 'input_json_delta', partial_json: 'ls -la","description":"List files"}' } } },
    { type: 'stream_event', event: { type: 'content_block_stop', index: 0 } },
    { type: 'stream_event', event: { type: 'message_stop' } },
    { type: 'user', message: { role: 'user', content: [{ type: 'tool_result', tool_use_id: 'tu_bash', content: 'total 22\nfile1\nfile2\n', is_error: false }] } },
  ];
}

test('DOM: a Bash tool call renders a tool block with the command visible', async () => {
  const { document, root, Parser, Conversation } = await setupDOM();
  const conversation = new Conversation(root);
  feed(new Parser(), conversation, bashToolCallStream());

  // There should be exactly one .block.tool inside the conversation.
  const toolBlocks = root.querySelectorAll('.block.tool');
  assert.equal(toolBlocks.length, 1, 'expected exactly one tool block');
  const tool = toolBlocks[0];

  // The summary must be present and contain the command.
  const summary = tool.querySelector('summary');
  assert.ok(summary, 'tool block must have a <summary>');
  const summaryText = summary.textContent;
  assert.match(summaryText, /Bash/, `summary should mention tool name (got: ${summaryText})`);
  assert.match(summaryText, /ls -la/, `summary should mention the command (got: ${summaryText})`);

  // The tool block body should also contain the command (in the diff/JSON view).
  const body = tool.querySelector('.tool-body');
  assert.ok(body, 'tool block must have a .tool-body');
  assert.match(body.textContent, /ls -la/, 'body should contain the command');

  // Tool block is collapsed by default — the smart summary shows the
  // command and clicking the disclosure caret expands the body. The body
  // text is still in the DOM (hidden by the closed <details>) so the
  // markup test below still passes.
  assert.equal(tool.hasAttribute('open') || tool.open, false, 'tool block should be collapsed by default');

  // The matching tool_result should be attached UNDER the tool_use block.
  const result = tool.querySelector('.block.tool-result');
  assert.ok(result, 'tool_result must be attached under the tool_use block');
  assert.match(result.textContent, /file1/);
});

function askUserQuestionStream() {
  const msgId = 'msg_q';
  const input = {
    questions: [
      {
        question: 'Which fruit?',
        header: 'Fruit',
        multiSelect: false,
        options: [
          { label: 'Apple', description: 'crispy' },
          { label: 'Banana' },
        ],
      },
    ],
  };
  const inputStr = JSON.stringify(input);
  return [
    { type: 'stream_event', event: { type: 'message_start', message: { id: msgId, role: 'assistant' } } },
    { type: 'stream_event', event: { type: 'content_block_start', index: 0, content_block: { type: 'tool_use', id: 'tu_q', name: 'AskUserQuestion', input: {} } } },
    { type: 'stream_event', event: { type: 'content_block_delta', index: 0, delta: { type: 'input_json_delta', partial_json: inputStr } } },
    { type: 'stream_event', event: { type: 'content_block_stop', index: 0 } },
  ];
}

test('DOM: AskUserQuestion renders options + custom input + submit button (single question)', async () => {
  const { document, root, Parser, Conversation } = await setupDOM();
  const submissions = [];
  const conversation = new Conversation(root, {
    onUserQuestionSubmit: (s) => submissions.push(s),
  });
  feed(new Parser(), conversation, askUserQuestionStream());

  const cards = root.querySelectorAll('.block.user-question');
  assert.equal(cards.length, 1, 'expected exactly one user-question card');
  const card = cards[0];

  assert.match(card.textContent, /Which fruit\?/, 'question text must be visible');

  // Two options + the always-present custom input.
  const buttons = card.querySelectorAll('button.uq-opt');
  assert.equal(buttons.length, 2);
  assert.ok(card.querySelector('.uq-custom-input'), 'custom input must always be present');

  // Tabs are hidden when there's only one question.
  const tabs = card.querySelectorAll('.uq-tab');
  assert.equal(tabs.length, 0, 'no tab strip for a single question');

  // Submit button starts disabled.
  const submit = card.querySelector('.uq-submit');
  assert.ok(submit);
  assert.ok(submit.disabled, 'submit disabled until an answer is provided');

  // Picking an option enables submit but does NOT fire onSubmit yet.
  buttons[0].click();
  assert.equal(submissions.length, 0, 'option click must not submit immediately');
  assert.ok(buttons[0].classList.contains('picked'), 'picked option is highlighted');
  assert.equal(submit.disabled, false, 'submit enabled once an answer is filled');

  // Tap submit → callback fires once with the consolidated answers.
  submit.click();
  assert.equal(submissions.length, 1, 'submit click fires onUserQuestionSubmit once');
  assert.equal(submissions[0].toolUseId, 'tu_q');
  assert.equal(submissions[0].answers.length, 1);
  assert.deepEqual(submissions[0].answers[0], { kind: 'option', label: 'Apple' });
  assert.ok(card.classList.contains('answered'));
});

test('DOM: typing spaces in the custom answer input is preserved (regression)', async () => {
  // Regression: _setCustom previously trimmed the stored text, then
  // _render wrote it back into input.value — swallowing every space the
  // user typed.
  const { document, root, Parser, Conversation } = await setupDOM();
  const submissions = [];
  const conversation = new Conversation(root, {
    onUserQuestionSubmit: (s) => submissions.push(s),
  });
  feed(new Parser(), conversation, askUserQuestionStream());

  const card = root.querySelector('.block.user-question');
  const input = card.querySelector('.uq-custom-input');

  // Simulate the user typing "hello there friend" character by character.
  // After every keystroke we re-read input.value to make sure nothing got
  // stripped behind our back.
  const target = 'hello there friend';
  for (let i = 1; i <= target.length; i++) {
    const next = target.slice(0, i);
    input.value = next;
    input.dispatchEvent(new window.Event('input'));
    assert.equal(input.value, next, `after keystroke ${i} input.value must still equal "${next}", got "${input.value}"`);
  }

  // Final submission carries the exact spaced text (trimmed only for output).
  const submit = card.querySelector('.uq-submit');
  assert.equal(submit.disabled, false);
  submit.click();
  assert.equal(submissions.length, 1);
  assert.deepEqual(submissions[0].answers[0], { kind: 'custom', text: 'hello there friend' });
});

test('DOM: whitespace-only custom answer does not enable the submit button', async () => {
  const { document, root, Parser, Conversation } = await setupDOM();
  const conversation = new Conversation(root, { onUserQuestionSubmit: () => {} });
  feed(new Parser(), conversation, askUserQuestionStream());
  const card = root.querySelector('.block.user-question');
  const input = card.querySelector('.uq-custom-input');
  const submit = card.querySelector('.uq-submit');

  input.value = '   ';
  input.dispatchEvent(new window.Event('input'));
  assert.equal(input.value, '   ', 'whitespace input is preserved in the field');
  assert.equal(submit.disabled, true, 'submit stays disabled for whitespace-only answer');
});

test('DOM: custom typed answer overrides option selection', async () => {
  const { document, root, Parser, Conversation } = await setupDOM();
  const submissions = [];
  const conversation = new Conversation(root, {
    onUserQuestionSubmit: (s) => submissions.push(s),
  });
  feed(new Parser(), conversation, askUserQuestionStream());

  const card = root.querySelector('.block.user-question');
  const input = card.querySelector('.uq-custom-input');
  const submit = card.querySelector('.uq-submit');

  // Type a custom answer.
  input.value = 'Mango';
  input.dispatchEvent(new window.Event('input'));
  assert.equal(submit.disabled, false);
  assert.ok(input.classList.contains('active'), 'custom input highlighted when active');

  submit.click();
  assert.deepEqual(submissions[0].answers[0], { kind: 'custom', text: 'Mango' });
});

test('DOM: multiple questions render a tab strip; submit requires all answered; consolidated submission', async () => {
  const { document, root, Parser, Conversation } = await setupDOM();
  const submissions = [];
  const conversation = new Conversation(root, {
    onUserQuestionSubmit: (s) => submissions.push(s),
  });

  // Stream a multi-question AskUserQuestion (two questions).
  const inputObj = {
    questions: [
      { question: 'Pick a fruit', header: 'Fruit', multiSelect: false, options: [{ label: 'Apple' }, { label: 'Banana' }] },
      { question: 'Pick an animal', header: 'Animal', multiSelect: false, options: [{ label: 'Cat' }, { label: 'Dog' }] },
    ],
  };
  const stream = [
    { type: 'stream_event', event: { type: 'message_start', message: { id: 'm', role: 'assistant' } } },
    { type: 'stream_event', event: { type: 'content_block_start', index: 0, content_block: { type: 'tool_use', id: 'tu_multi', name: 'AskUserQuestion', input: {} } } },
    { type: 'stream_event', event: { type: 'content_block_delta', index: 0, delta: { type: 'input_json_delta', partial_json: JSON.stringify(inputObj) } } },
    { type: 'stream_event', event: { type: 'content_block_stop', index: 0 } },
  ];
  feed(new Parser(), conversation, stream);

  const card = root.querySelector('.block.user-question');
  const tabs = card.querySelectorAll('.uq-tab');
  assert.equal(tabs.length, 2, 'tab strip renders one tab per question');
  assert.ok(tabs[0].classList.contains('active'), 'first tab is active by default');

  // Submit is disabled until BOTH questions are answered.
  const submit = card.querySelector('.uq-submit');
  assert.ok(submit.disabled);

  // Answer Q1.
  const panes = card.querySelectorAll('.uq-pane');
  assert.equal(panes.length, 2);
  panes[0].querySelectorAll('button.uq-opt')[0].click();
  assert.ok(submit.disabled, 'still disabled — only one of two answered');
  assert.ok(tabs[0].classList.contains('answered'));

  // Switch to Q2 via the tab.
  tabs[1].click();
  assert.ok(tabs[1].classList.contains('active'));
  // Only the active pane should be visible.
  assert.notEqual(panes[1].style.display, 'none', 'q2 pane visible after tab click');
  assert.equal(panes[0].style.display, 'none', 'q1 pane hidden when q2 active');

  // Answer Q2 via custom input.
  const q2input = panes[1].querySelector('.uq-custom-input');
  q2input.value = 'Penguin';
  q2input.dispatchEvent(new window.Event('input'));

  assert.equal(submit.disabled, false, 'both answered now');
  submit.click();

  assert.equal(submissions.length, 1);
  const s = submissions[0];
  assert.equal(s.toolUseId, 'tu_multi');
  assert.equal(s.answers.length, 2);
  assert.deepEqual(s.answers[0], { kind: 'option', label: 'Apple' });
  assert.deepEqual(s.answers[1], { kind: 'custom', text: 'Penguin' });
});

test('formatUserQuestionAnswers: single-question short form, multi-question bulleted form, multi-select join', async () => {
  const { formatUserQuestionAnswers } = await import(
    new URL('../public/blocks.js', import.meta.url).href
  );
  assert.equal(
    formatUserQuestionAnswers([{ question: 'Pick a fruit' }], [{ kind: 'option', label: 'Apple' }]),
    'Answer to "Pick a fruit": Apple',
  );
  const multi = formatUserQuestionAnswers(
    [{ question: 'Pick a fruit' }, { question: 'Pick animal' }],
    [{ kind: 'option', label: 'Apple' }, { kind: 'custom', text: 'Penguin' }],
  );
  assert.match(multi, /My answers:/);
  assert.match(multi, /- Pick a fruit: Apple/);
  assert.match(multi, /- Pick animal: Penguin/);
  assert.match(
    formatUserQuestionAnswers([{ question: 'Pick features' }], [{ kind: 'multi', labels: ['Auth', 'Search'] }]),
    /Auth, Search/,
  );
});

test('DOM: noisy system events (status, rate_limit_event:allowed) are dropped from the conversation', async () => {
  const { document, root, Parser, Conversation } = await setupDOM();
  const conv = new Conversation(root);
  const p = new Parser();
  const events = [
    { type: 'system', subtype: 'status', status: 'requesting', uuid: 'u1', session_id: 's' },
    { type: 'system', subtype: 'status', status: 'requesting', uuid: 'u2', session_id: 's' },
    { type: 'rate_limit_event', rate_limit_info: { status: 'allowed' }, uuid: 'u3', session_id: 's' },
    { type: 'hook_event', event: 'PreToolUse', uuid: 'u4' },
  ];
  for (const e of events) for (const ev of p.handleObject(e)) conv.apply(ev);

  // None of the noisy events should leave a SystemBlock in the DOM.
  const systems = root.querySelectorAll('.block.system');
  assert.equal(systems.length, 0, `expected no system blocks, got ${systems.length}`);
});

test('DOM: kept system events render inline in chronological order (no shared __system__ wrap)', async () => {
  const { document, root, Parser, Conversation } = await setupDOM();
  const conv = new Conversation(root);
  const p = new Parser();
  // Simulate two turns: each emits an init, and we want them at their
  // chronological positions, NOT both bunched into one box at the top.
  const stream1 = [
    { type: 'system', subtype: 'init', session_id: 'sid', model: 'claude-opus-4-7', uuid: 'i1' },
    { type: 'stream_event', event: { type: 'message_start', message: { id: 'm1', role: 'assistant' } } },
    { type: 'stream_event', event: { type: 'content_block_start', index: 0, content_block: { type: 'text', text: '' } } },
    { type: 'stream_event', event: { type: 'content_block_delta', index: 0, delta: { type: 'text_delta', text: 'first' } } },
    { type: 'stream_event', event: { type: 'content_block_stop', index: 0 } },
    { type: 'stream_event', event: { type: 'message_stop' } },
    { type: 'result', subtype: 'success', stop_reason: 'end_turn', duration_ms: 1, total_cost_usd: 0 },
  ];
  const stream2 = [
    { type: 'system', subtype: 'init', session_id: 'sid', model: 'claude-opus-4-7', uuid: 'i2' },
    { type: 'stream_event', event: { type: 'message_start', message: { id: 'm2', role: 'assistant' } } },
    { type: 'stream_event', event: { type: 'content_block_start', index: 0, content_block: { type: 'text', text: '' } } },
    { type: 'stream_event', event: { type: 'content_block_delta', index: 0, delta: { type: 'text_delta', text: 'second' } } },
    { type: 'stream_event', event: { type: 'content_block_stop', index: 0 } },
    { type: 'stream_event', event: { type: 'message_stop' } },
    { type: 'result', subtype: 'success', stop_reason: 'end_turn', duration_ms: 1, total_cost_usd: 0 },
  ];
  for (const e of stream1) for (const ev of p.handleObject(e)) conv.apply(ev);
  for (const e of stream2) for (const ev of p.handleObject(e)) conv.apply(ev);

  // We expect exactly TWO init blocks (one per turn), each at its own
  // chronological position in the DOM.
  const inits = [...root.querySelectorAll('.block.system')].filter(n => n.textContent.includes('init'));
  assert.equal(inits.length, 2, `expected one init block per turn, got ${inits.length}`);

  // Each init should be a direct child of the conversation root, not nested
  // inside a shared '__system__' message wrap.
  for (const init of inits) {
    assert.equal(init.parentElement, root, 'system block must be a top-level conversation child');
  }

  // The first init must come BEFORE the first assistant message in DOM
  // order, and the second init must come BEFORE the second assistant.
  const all = [...root.children];
  const firstInitIdx = all.indexOf(inits[0]);
  const secondInitIdx = all.indexOf(inits[1]);
  assert.ok(firstInitIdx < secondInitIdx, 'inits must appear in chronological order');
  const assistants = all.filter(n => n.classList?.contains('msg') && n.classList?.contains('assistant'));
  assert.equal(assistants.length, 2, 'two assistant messages expected');
  assert.ok(firstInitIdx < all.indexOf(assistants[0]), 'first init renders before first assistant');
  assert.ok(secondInitIdx < all.indexOf(assistants[1]), 'second init renders before second assistant');
  assert.ok(secondInitIdx > all.indexOf(assistants[0]), 'second init renders AFTER first assistant — no shared wrap drift');
});

test('DOM: ExitPlanMode renders an approve/reject card with the plan + feedback box', async () => {
  const { document, root, Parser, Conversation } = await setupDOM();
  const decisions = [];
  const conversation = new Conversation(root, { onPlanDecision: (d) => decisions.push(d) });
  const planMarkdown = '# Plan\n- Step 1\n- Step 2';
  const stream = [
    { type: 'stream_event', event: { type: 'message_start', message: { id: 'm', role: 'assistant' } } },
    { type: 'stream_event', event: { type: 'content_block_start', index: 0, content_block: { type: 'tool_use', id: 'tu_plan', name: 'ExitPlanMode', input: {} } } },
    { type: 'stream_event', event: { type: 'content_block_delta', index: 0, delta: { type: 'input_json_delta', partial_json: JSON.stringify({ plan: planMarkdown }) } } },
    { type: 'stream_event', event: { type: 'content_block_stop', index: 0 } },
  ];
  feed(new Parser(), conversation, stream);

  const card = root.querySelector('.block.plan-request');
  assert.ok(card, 'plan card rendered');
  assert.match(card.textContent, /Plan ready for approval/);
  assert.match(card.querySelector('.pr-body').textContent, /Step 1/);

  // Approve fires onPlanDecision with the right shape.
  const approve = card.querySelector('.pr-approve');
  const reject = card.querySelector('.pr-reject');
  const feedback = card.querySelector('.pr-feedback');
  assert.ok(approve && reject && feedback);

  feedback.value = 'looks good';
  approve.click();
  assert.equal(decisions.length, 1);
  assert.equal(decisions[0].toolUseId, 'tu_plan');
  assert.equal(decisions[0].decision, 'approve');
  assert.equal(decisions[0].feedback, 'looks good');
  assert.ok(card.classList.contains('approved'));
  assert.ok(approve.disabled && reject.disabled, 'both buttons disabled after click');

  // Second click is a no-op.
  reject.click();
  assert.equal(decisions.length, 1);
});

test('DOM: ExitPlanMode rejection carries the feedback text', async () => {
  const { document, root, Parser, Conversation } = await setupDOM();
  const decisions = [];
  const conversation = new Conversation(root, { onPlanDecision: (d) => decisions.push(d) });
  const stream = [
    { type: 'stream_event', event: { type: 'message_start', message: { id: 'm', role: 'assistant' } } },
    { type: 'stream_event', event: { type: 'content_block_start', index: 0, content_block: { type: 'tool_use', id: 'tu_p2', name: 'ExitPlanMode', input: {} } } },
    { type: 'stream_event', event: { type: 'content_block_delta', index: 0, delta: { type: 'input_json_delta', partial_json: '{"plan":"do thing"}' } } },
    { type: 'stream_event', event: { type: 'content_block_stop', index: 0 } },
  ];
  feed(new Parser(), conversation, stream);

  const card = root.querySelector('.block.plan-request');
  card.querySelector('.pr-feedback').value = 'add a security review step';
  card.querySelector('.pr-reject').click();
  assert.equal(decisions[0].decision, 'reject');
  assert.equal(decisions[0].feedback, 'add a security review step');
  assert.ok(card.classList.contains('rejected'));
});

test('DOM: tool block always shows its command in the summary even while streaming', async () => {
  // Specifically a regression guard — the user-facing complaint was that
  // the command wasn't visible. We feed the stream up to (but not past) the
  // finalizing content_block_stop and verify the summary already carries
  // the command via the partial-JSON parse fast path.
  const { document, root, Parser, Conversation } = await setupDOM();
  const conversation = new Conversation(root);
  const p = new Parser();
  feed(p, conversation, [
    { type: 'stream_event', event: { type: 'message_start', message: { id: 'mid', role: 'assistant' } } },
    { type: 'stream_event', event: { type: 'content_block_start', index: 0, content_block: { type: 'tool_use', id: 'tu_x', name: 'Bash', input: {} } } },
    { type: 'stream_event', event: { type: 'content_block_delta', index: 0, delta: { type: 'input_json_delta', partial_json: '{"command":"echo hi"}' } } },
  ]);
  const summary = root.querySelector('.block.tool summary');
  assert.ok(summary, 'tool block must have a summary even before content_block_stop');
  assert.match(summary.textContent, /echo hi/, 'summary should already include the command via partial-JSON parse');
});
