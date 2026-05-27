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

  // The raw-JSON input is wrapped in its own collapsible <details>, mirroring
  // the tool_result pattern. Default-closed.
  const input = tool.querySelector('.block.tool-input');
  assert.ok(input, 'raw-JSON input must be wrapped in a .block.tool-input details');
  assert.equal(input.hasAttribute('open') || input.open, false, 'tool_input should be collapsed by default');
  assert.match(input.querySelector('summary')?.textContent ?? '', /tool_input/);
  assert.match(input.textContent, /ls -la/, 'tool_input body still contains the JSON-rendered command');
});

function editToolCallStream() {
  const msgId = 'msg_test_edit';
  const input = { file_path: '/x/y.js', old_string: 'foo', new_string: 'bar' };
  return [
    { type: 'stream_event', event: { type: 'message_start', message: { id: msgId, role: 'assistant' } } },
    { type: 'stream_event', event: { type: 'content_block_start', index: 0, content_block: { type: 'tool_use', id: 'tu_edit', name: 'Edit', input: {} } } },
    { type: 'stream_event', event: { type: 'content_block_delta', index: 0, delta: { type: 'input_json_delta', partial_json: JSON.stringify(input) } } },
    { type: 'stream_event', event: { type: 'content_block_stop', index: 0 } },
    { type: 'stream_event', event: { type: 'message_stop' } },
  ];
}

test('DOM: Edit tool call still renders as a diff (no tool_input wrapper for specialty renderers)', async () => {
  const { root, Parser, Conversation } = await setupDOM();
  const conversation = new Conversation(root);
  feed(new Parser(), conversation, editToolCallStream());

  const tool = root.querySelector('.block.tool');
  assert.ok(tool, 'Edit tool block must be present');
  // Specialty renderer wins — diff is rendered flush in the body.
  assert.ok(tool.querySelector('.diff'), 'Edit should render as a .diff');
  assert.equal(tool.querySelector('.block.tool-input'), null,
    'specialty diff renderer must NOT be wrapped in tool_input');
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

test('DOM: picking an option flips the custom input into a "note" field and attaches the note to the answer', async () => {
  const { root, Parser, Conversation } = await setupDOM();
  const submissions = [];
  const conversation = new Conversation(root, {
    onUserQuestionSubmit: (s) => submissions.push(s),
  });
  feed(new Parser(), conversation, askUserQuestionStream());

  const card = root.querySelector('.block.user-question');
  const buttons = card.querySelectorAll('button.uq-opt');
  const input = card.querySelector('.uq-custom-input');
  const labelSpan = card.querySelector('.uq-custom-label');
  const submit = card.querySelector('.uq-submit');

  // Pre-selection: label is "Other:", input is not the active highlight.
  assert.equal(labelSpan.textContent, 'Other:');
  assert.ok(!input.classList.contains('active'));

  // Pick Apple → label/placeholder swap to note mode; input not highlighted.
  buttons[0].click();
  assert.equal(labelSpan.textContent, 'Add a note (optional)');
  assert.match(input.placeholder, /optional/);
  assert.ok(!input.classList.contains('active'), 'note-mode input is not the "custom" highlight');

  // Type a note. Submit. The note must travel with the option in the answer.
  input.value = "it's in season";
  input.dispatchEvent(new window.Event('input'));
  assert.equal(submit.disabled, false);
  submit.click();
  assert.deepEqual(submissions[0].answers[0], { kind: 'option', label: 'Apple', note: "it's in season" });
});

test('DOM: option with no note submits without a `note` field (clean shape)', async () => {
  const { root, Parser, Conversation } = await setupDOM();
  const submissions = [];
  const conversation = new Conversation(root, {
    onUserQuestionSubmit: (s) => submissions.push(s),
  });
  feed(new Parser(), conversation, askUserQuestionStream());

  const card = root.querySelector('.block.user-question');
  card.querySelectorAll('button.uq-opt')[0].click();
  card.querySelector('.uq-submit').click();
  assert.deepEqual(submissions[0].answers[0], { kind: 'option', label: 'Apple' });
});

test('DOM: typed draft persists across pick → un-pick, flipping between note and custom', async () => {
  const { root, Parser, Conversation } = await setupDOM();
  const submissions = [];
  const conversation = new Conversation(root, {
    onUserQuestionSubmit: (s) => submissions.push(s),
  });
  feed(new Parser(), conversation, askUserQuestionStream());

  const card = root.querySelector('.block.user-question');
  const apple = card.querySelectorAll('button.uq-opt')[0];
  const input = card.querySelector('.uq-custom-input');

  // Type Mango (acts as custom answer pre-selection).
  input.value = 'Mango';
  input.dispatchEvent(new window.Event('input'));
  assert.ok(input.classList.contains('active'), 'custom highlight while no pick');

  // Pick Apple — text persists; role flips to note.
  apple.click();
  assert.equal(input.value, 'Mango', 'typed text must survive role flip');
  assert.ok(!input.classList.contains('active'), 'no custom highlight in note mode');

  // Un-pick Apple — falls back to a custom answer carrying the same draft.
  apple.click();
  assert.equal(input.value, 'Mango', 'typed text must survive un-pick');
  assert.ok(input.classList.contains('active'), 'custom highlight restored after un-pick');

  // Submit the custom fallback.
  card.querySelector('.uq-submit').click();
  assert.deepEqual(submissions[0].answers[0], { kind: 'custom', text: 'Mango' });
});

test('DOM: custom-input label and placeholder swap to "Add a note (optional)" once an option is picked', async () => {
  const { root, Parser, Conversation } = await setupDOM();
  const conversation = new Conversation(root, { onUserQuestionSubmit: () => {} });
  feed(new Parser(), conversation, askUserQuestionStream());

  const card = root.querySelector('.block.user-question');
  const labelSpan = card.querySelector('.uq-custom-label');
  const input = card.querySelector('.uq-custom-input');
  const apple = card.querySelectorAll('button.uq-opt')[0];

  assert.equal(labelSpan.textContent, 'Other:');
  assert.match(input.placeholder, /type your own/);

  apple.click();
  assert.equal(labelSpan.textContent, 'Add a note (optional)');
  assert.match(input.placeholder, /optional/);

  apple.click(); // un-pick
  assert.equal(labelSpan.textContent, 'Other:');
  assert.match(input.placeholder, /type your own/);
});

test('DOM: multi-select shares one note across all picked labels', async () => {
  const { root, Parser, Conversation } = await setupDOM();
  const submissions = [];
  const conversation = new Conversation(root, {
    onUserQuestionSubmit: (s) => submissions.push(s),
  });
  const inputObj = {
    questions: [
      { question: 'Pick fruits', header: 'Fruits', multiSelect: true, options: [{ label: 'Apple' }, { label: 'Banana' }] },
    ],
  };
  feed(new Parser(), conversation, [
    { type: 'stream_event', event: { type: 'message_start', message: { id: 'm', role: 'assistant' } } },
    { type: 'stream_event', event: { type: 'content_block_start', index: 0, content_block: { type: 'tool_use', id: 'tu_multi_note', name: 'AskUserQuestion', input: {} } } },
    { type: 'stream_event', event: { type: 'content_block_delta', index: 0, delta: { type: 'input_json_delta', partial_json: JSON.stringify(inputObj) } } },
    { type: 'stream_event', event: { type: 'content_block_stop', index: 0 } },
  ]);

  const card = root.querySelector('.block.user-question');
  const opts = card.querySelectorAll('button.uq-opt');
  const input = card.querySelector('.uq-custom-input');

  opts[0].click();
  opts[1].click();
  input.value = 'for v2';
  input.dispatchEvent(new window.Event('input'));
  card.querySelector('.uq-submit').click();
  assert.deepEqual(submissions[0].answers[0], { kind: 'multi', labels: ['Apple', 'Banana'], note: 'for v2' });
});

test('DOM: multi-select — un-picking all options with a draft reverts to custom answer', async () => {
  const { root, Parser, Conversation } = await setupDOM();
  const submissions = [];
  const conversation = new Conversation(root, {
    onUserQuestionSubmit: (s) => submissions.push(s),
  });
  const inputObj = {
    questions: [
      { question: 'Pick fruits', header: 'Fruits', multiSelect: true, options: [{ label: 'Apple' }, { label: 'Banana' }] },
    ],
  };
  feed(new Parser(), conversation, [
    { type: 'stream_event', event: { type: 'message_start', message: { id: 'm', role: 'assistant' } } },
    { type: 'stream_event', event: { type: 'content_block_start', index: 0, content_block: { type: 'tool_use', id: 'tu_multi_fb', name: 'AskUserQuestion', input: {} } } },
    { type: 'stream_event', event: { type: 'content_block_delta', index: 0, delta: { type: 'input_json_delta', partial_json: JSON.stringify(inputObj) } } },
    { type: 'stream_event', event: { type: 'content_block_stop', index: 0 } },
  ]);

  const card = root.querySelector('.block.user-question');
  const apple = card.querySelectorAll('button.uq-opt')[0];
  const input = card.querySelector('.uq-custom-input');
  const submit = card.querySelector('.uq-submit');

  input.value = 'Mango';
  input.dispatchEvent(new window.Event('input'));
  apple.click(); // pick → note mode
  apple.click(); // un-pick → no labels left, draft falls back to custom

  assert.equal(submit.disabled, false);
  submit.click();
  assert.deepEqual(submissions[0].answers[0], { kind: 'custom', text: 'Mango' });
});

test('formatUserQuestionAnswers: notes are appended with an em dash; whitespace-only notes are suppressed', async () => {
  const { formatUserQuestionAnswers } = await import(
    new URL('../public/blocks.js', import.meta.url).href
  );

  // Option with note.
  assert.equal(
    formatUserQuestionAnswers(
      [{ question: 'Pick a fruit' }],
      [{ kind: 'option', label: 'Apple', note: "it's in season" }],
    ),
    'Answer to "Pick a fruit": Apple — it\'s in season',
  );

  // Multi with note.
  assert.match(
    formatUserQuestionAnswers(
      [{ question: 'Pick features' }],
      [{ kind: 'multi', labels: ['Auth', 'Search'], note: 'needed for v2' }],
    ),
    /Auth, Search — needed for v2/,
  );

  // Regression: option without note must still produce today's exact short form.
  assert.equal(
    formatUserQuestionAnswers([{ question: 'Pick a fruit' }], [{ kind: 'option', label: 'Apple' }]),
    'Answer to "Pick a fruit": Apple',
  );

  // Whitespace-only note: no em dash in the output.
  const ws = formatUserQuestionAnswers(
    [{ question: 'Pick a fruit' }],
    [{ kind: 'option', label: 'Apple', note: '   ' }],
  );
  assert.equal(ws, 'Answer to "Pick a fruit": Apple');
  assert.ok(!ws.includes('—'), 'whitespace-only note must not produce an em dash');
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
  // Simulate the user sending a follow-up between turns so the second turn
  // starts a fresh assistant envelope (consecutive assistant msgIds without a
  // user echo are grouped into a single envelope — see grouping tests above).
  conv.apply({ kind: 'user_echo', text: 'go again', attachments: [] });
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

test('DOM: ExitPlanMode auto-approve — when the event arrives with autoApproved=true the card renders display-only', async () => {
  // Auto-approval now lives on the server: the Instance flips its mode and
  // sends the approval prompt itself before broadcasting the plan_request,
  // tagging the event with `autoApproved: true`. The renderer's job is just
  // to show that tag — no client-side onPlanDecision auto-fire any more.
  const { root, Conversation } = await setupDOM();
  const decisions = [];
  const conversation = new Conversation(root, {
    onPlanDecision: (d) => decisions.push(d),
  });

  conversation.apply({
    kind: 'plan_request',
    toolUseId: 'tu_auto',
    plan: 'auto plan',
    planPath: null,
    autoApproved: true,
    _seq: 0,
  });

  const card = root.querySelector('.block.plan-request');
  assert.ok(card, 'plan card still renders so the user can see what was auto-approved');
  assert.ok(card.classList.contains('approved'), 'auto-approved card carries the .approved class');
  assert.equal(card.querySelector('.pr-approve'), null, 'no Approve button');
  assert.equal(card.querySelector('.pr-reject'), null, 'no Reject button');
  assert.equal(card.querySelector('.pr-feedback'), null, 'no feedback textarea');
  assert.match(card.querySelector('.pr-status').textContent, /auto-approved/i);
  assert.match(card.querySelector('.pr-body').textContent, /auto plan/);
  assert.equal(decisions.length, 0,
    'renderer no longer auto-fires onPlanDecision — the server already sent the approval');
});

test('DOM: ExitPlanMode — without the autoApproved annotation the card is interactive', async () => {
  const { root, Parser, Conversation } = await setupDOM();
  const decisions = [];
  const conversation = new Conversation(root, {
    onPlanDecision: (d) => decisions.push(d),
  });
  feed(new Parser(), conversation, [
    { type: 'stream_event', event: { type: 'message_start', message: { id: 'm', role: 'assistant' } } },
    { type: 'stream_event', event: { type: 'content_block_start', index: 0, content_block: { type: 'tool_use', id: 'tu_manual', name: 'ExitPlanMode', input: {} } } },
    { type: 'stream_event', event: { type: 'content_block_delta', index: 0, delta: { type: 'input_json_delta', partial_json: '{"plan":"manual plan"}' } } },
    { type: 'stream_event', event: { type: 'content_block_stop', index: 0 } },
  ]);
  const card = root.querySelector('.block.plan-request');
  assert.ok(card.querySelector('.pr-approve'), 'Approve button is present when not auto-approved');
  assert.ok(card.querySelector('.pr-reject'), 'Reject button is present when not auto-approved');
  assert.equal(decisions.length, 0, 'no auto-fire when the event does not carry autoApproved');
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

test('DOM: permission_request renders an Allow/Deny card with the tool preview; click sends a hook_decision', async () => {
  const { document, root, Conversation } = await setupDOM();
  const decisions = [];
  const conversation = new Conversation(root, { onPermissionDecision: (d) => decisions.push(d) });
  conversation.apply({
    kind: 'permission_request',
    toolUseId: 'tu_perm_1',
    toolName: 'Write',
    toolInput: { file_path: '/tmp/foo.txt', content: 'hello\nworld\n' },
  });
  const card = root.querySelector('.block.permission');
  assert.ok(card, 'permission card rendered');
  assert.match(card.textContent, /Allow Write/);
  assert.match(card.textContent, /foo\.txt/);

  const allow = card.querySelector('.perm-allow');
  const deny = card.querySelector('.perm-deny');
  assert.ok(allow && deny);

  allow.click();
  assert.equal(decisions.length, 1);
  assert.equal(decisions[0].toolUseId, 'tu_perm_1');
  assert.equal(decisions[0].allow, true);
  assert.ok(allow.disabled && deny.disabled, 'both buttons disabled after click');

  // Server confirms with permission_resolved → card flips to "allowed".
  conversation.apply({ kind: 'permission_resolved', toolUseId: 'tu_perm_1', allow: true });
  assert.ok(card.classList.contains('allowed'));
  assert.match(card.querySelector('.perm-status').textContent, /allowed/i);
});

test('DOM: permission_request for Edit renders the inline diff body', async () => {
  const { document, root, Conversation } = await setupDOM();
  const conversation = new Conversation(root);
  conversation.apply({
    kind: 'permission_request',
    toolUseId: 'tu_perm_edit',
    toolName: 'Edit',
    toolInput: { file_path: '/tmp/code.js', old_string: 'old line', new_string: 'new line' },
  });
  const card = root.querySelector('.block.permission');
  assert.ok(card.querySelector('.diff'), 'Edit permission card renders a diff');
  assert.match(card.textContent, /old line/);
  assert.match(card.textContent, /new line/);
});

test('DOM: a sub-agent tool_use (no streaming deltas) renders its tool block + attached result', async () => {
  // Sub-agent assistant turns arrive on the same stream as the outer turn
  // but only as a complete `assistant` envelope tagged with
  // parent_tool_use_id — no per-block stream_event deltas. Before the
  // reconciliation pass was added, the tool_use content blocks never reached
  // the DOM and the matching tool_result landed as a floating block in the
  // sub-conversation.
  const { document, root, Parser, Conversation } = await setupDOM();
  const conversation = new Conversation(root);
  const p = new Parser();
  // Outer Task tool_use streams in via stream_event chunks so the parent
  // ToolUseBlock exists in outer.toolBlocks for sub-event routing to land.
  feed(p, conversation, [
    { type: 'stream_event', event: { type: 'message_start', message: { id: 'msg_outer', role: 'assistant' } } },
    { type: 'stream_event', event: { type: 'content_block_start', index: 0, content_block: { type: 'tool_use', id: 'task_xyz', name: 'Task', input: {} } } },
    { type: 'stream_event', event: { type: 'content_block_delta', index: 0, delta: { type: 'input_json_delta', partial_json: '{"description":"search","prompt":"go"}' } } },
    { type: 'stream_event', event: { type: 'content_block_stop', index: 0 } },
    // Sub-agent assistant turn — only the complete envelope, no deltas.
    {
      type: 'assistant',
      parent_tool_use_id: 'task_xyz',
      message: {
        id: 'msg_sub',
        role: 'assistant',
        content: [
          { type: 'tool_use', id: 'tu_grep', name: 'Grep', input: { pattern: 'foo' } },
        ],
      },
    },
    // Sub-agent tool_result for the Grep call.
    {
      type: 'user',
      parent_tool_use_id: 'task_xyz',
      message: {
        role: 'user',
        content: [{ type: 'tool_result', tool_use_id: 'tu_grep', content: 'No matches found', is_error: false }],
      },
    },
  ]);

  const sub = root.querySelector('.sub-conversation');
  assert.ok(sub, 'sub-conversation container must exist under the Task tool block');

  // The Grep tool_use block must be rendered inside the sub-conversation.
  const subToolBlocks = sub.querySelectorAll('.block.tool');
  assert.equal(subToolBlocks.length, 1, 'expected exactly one sub-agent tool block');
  const grep = subToolBlocks[0];
  const summary = grep.querySelector('summary');
  assert.ok(summary);
  assert.match(summary.textContent, /Grep/, `summary should mention Grep (got: ${summary.textContent})`);
  assert.match(summary.textContent, /foo/, `summary should mention the pattern (got: ${summary.textContent})`);

  // The tool_result must be attached UNDER the Grep block, not floating.
  const attached = grep.querySelector('.block.tool-result');
  assert.ok(attached, 'tool_result must be attached under the sub-agent tool block');
  assert.match(attached.textContent, /No matches found/);

  // Defensive: no floating tool_result siblings of the Grep block inside the sub.
  const floating = sub.querySelectorAll('.msg > .blocks > .block.tool-result');
  assert.equal(floating.length, 0, 'no tool_result should float at the sub-conversation msg level');
});

test('DOM: parallel sub-agent tool_uses split across same-msgId envelopes both render with their results attached', async () => {
  // Production bug shape from session 7c452875: a sub-agent that issues two
  // parallel Bash tool_uses in one logical assistant message emits them as
  // TWO separate `assistant` envelopes that share the same msgId, each
  // carrying its lone content block at iteration index 0. The old reconcile
  // dedup keyed by `${msgId}:${i}:tool` made the second envelope a no-op,
  // its tool_use never reached the DOM, and the matching tool_result
  // dropped into a floating "__floating__" wrap.
  const { document, root, Parser, Conversation } = await setupDOM();
  const conversation = new Conversation(root);
  feed(new Parser(), conversation, [
    // Outer Task tool_use streamed normally so subA gets a registered parent.
    { type: 'stream_event', event: { type: 'message_start', message: { id: 'msg_outer', role: 'assistant' } } },
    { type: 'stream_event', event: { type: 'content_block_start', index: 0, content_block: { type: 'tool_use', id: 'task_xyz', name: 'Task', input: {} } } },
    { type: 'stream_event', event: { type: 'content_block_delta', index: 0, delta: { type: 'input_json_delta', partial_json: '{"description":"x"}' } } },
    { type: 'stream_event', event: { type: 'content_block_stop', index: 0 } },
    // Two separate sub-agent assistant envelopes, SAME msgId, each one
    // tool_use at the envelope's iteration index 0 — the bug shape.
    {
      type: 'assistant',
      parent_tool_use_id: 'task_xyz',
      message: {
        id: 'msg_sub_shared',
        role: 'assistant',
        content: [{ type: 'tool_use', id: 'tu_a', name: 'Bash', input: { command: 'ls /a' } }],
      },
    },
    {
      type: 'assistant',
      parent_tool_use_id: 'task_xyz',
      message: {
        id: 'msg_sub_shared',
        role: 'assistant',
        content: [{ type: 'tool_use', id: 'tu_b', name: 'Bash', input: { command: 'ls /b' } }],
      },
    },
    {
      type: 'user',
      parent_tool_use_id: 'task_xyz',
      message: { role: 'user', content: [{ type: 'tool_result', tool_use_id: 'tu_a', content: 'A out' }] },
    },
    {
      type: 'user',
      parent_tool_use_id: 'task_xyz',
      message: { role: 'user', content: [{ type: 'tool_result', tool_use_id: 'tu_b', content: 'B out' }] },
    },
  ]);

  const sub = root.querySelector('.sub-conversation');
  assert.ok(sub, 'sub-conversation container must exist under the Task tool block');

  const subToolBlocks = sub.querySelectorAll('.block.tool');
  assert.equal(subToolBlocks.length, 2, 'both parallel sub-agent tool_use blocks must render');

  // No orphan tool_result at the sub-conversation msg level — both must be
  // attached under their matching tool_use block.
  const orphans = sub.querySelectorAll('.msg > .blocks > .block.tool-result');
  assert.equal(orphans.length, 0, 'no tool_result should float at the sub-conversation msg level');

  const attachedA = subToolBlocks[0].querySelector('.block.tool-result');
  const attachedB = subToolBlocks[1].querySelector('.block.tool-result');
  assert.ok(attachedA, 'first tool_use must have its tool_result attached');
  assert.ok(attachedB, 'second tool_use must have its tool_result attached');
  assert.match(attachedA.textContent, /A out/);
  assert.match(attachedB.textContent, /B out/);
});

test('DOM: sequential outer-turn tool_uses sharing one msgId all render with their results attached', async () => {
  // Production bug shape from session ea7b99b2: the model issued a Bash
  // followed by two Greps as three sequential outer-turn tool_uses. The
  // CLI labeled all three with the same `message.id` and emitted each as
  // its own message_start → content_block_start(index=0, tool_use) →
  // content_block_stop → message_stop cycle. The persisted jsonl shows
  // the same shape: three `type:"assistant"` records sharing msg.id,
  // each carrying one tool_use at content[0]. Under the old code the
  // (msgId, blockIdx)-keyed blocksByKey dedup dropped the 2nd and 3rd
  // tool blocks and their tool_results landed as floating siblings of
  // the rendered Bash block.
  const { document, root, Parser, Conversation } = await setupDOM();
  const conversation = new Conversation(root);
  const sharedMsgId = 'msg_013jopDt19FniiiaB18H161f';
  feed(new Parser(), conversation, [
    // Bash tool_use — its own message_start/stop cycle.
    { type: 'stream_event', event: { type: 'message_start', message: { id: sharedMsgId, role: 'assistant' } } },
    { type: 'stream_event', event: { type: 'content_block_start', index: 0, content_block: { type: 'tool_use', id: 'tu_bash', name: 'Bash', input: {} } } },
    { type: 'stream_event', event: { type: 'content_block_delta', index: 0, delta: { type: 'input_json_delta', partial_json: '{"command":"ls /tests/fixtures/"}' } } },
    { type: 'stream_event', event: { type: 'content_block_stop', index: 0 } },
    { type: 'stream_event', event: { type: 'message_stop' } },
    { type: 'user', message: { role: 'user', content: [{ type: 'tool_result', tool_use_id: 'tu_bash', content: 'scenario-basic.json\nscenario-tool.json', is_error: false }] } },
    // First Grep — fresh message_start, same msg.id, index 0 again.
    { type: 'stream_event', event: { type: 'message_start', message: { id: sharedMsgId, role: 'assistant' } } },
    { type: 'stream_event', event: { type: 'content_block_start', index: 0, content_block: { type: 'tool_use', id: 'tu_grep_a', name: 'Grep', input: {} } } },
    { type: 'stream_event', event: { type: 'content_block_delta', index: 0, delta: { type: 'input_json_delta', partial_json: '{"pattern":"parent_tool_use_id"}' } } },
    { type: 'stream_event', event: { type: 'content_block_stop', index: 0 } },
    { type: 'stream_event', event: { type: 'message_stop' } },
    { type: 'user', message: { role: 'user', content: [{ type: 'tool_result', tool_use_id: 'tu_grep_a', content: 'No files found', is_error: false }] } },
    // Second Grep — same again.
    { type: 'stream_event', event: { type: 'message_start', message: { id: sharedMsgId, role: 'assistant' } } },
    { type: 'stream_event', event: { type: 'content_block_start', index: 0, content_block: { type: 'tool_use', id: 'tu_grep_b', name: 'Grep', input: {} } } },
    { type: 'stream_event', event: { type: 'content_block_delta', index: 0, delta: { type: 'input_json_delta', partial_json: '{"pattern":"parentToolUseId"}' } } },
    { type: 'stream_event', event: { type: 'content_block_stop', index: 0 } },
    { type: 'stream_event', event: { type: 'message_stop' } },
    { type: 'user', message: { role: 'user', content: [{ type: 'tool_result', tool_use_id: 'tu_grep_b', content: 'No files found', is_error: false }] } },
  ]);

  // All three tool blocks must render at the outer (assistant) level.
  const toolBlocks = root.querySelectorAll('.msg.assistant > .blocks > .block.tool');
  assert.equal(toolBlocks.length, 3, 'all three sequential tool_use blocks must render');

  // No orphan tool_result floating at the assistant body level.
  const orphans = root.querySelectorAll('.msg.assistant > .blocks > .block.tool-result');
  assert.equal(orphans.length, 0, 'no tool_result should float at the assistant body level');

  // Each tool block carries its own attached result with the right content.
  const [bash, grepA, grepB] = toolBlocks;
  assert.match(bash.querySelector('summary').textContent, /Bash/);
  assert.match(bash.querySelector('.block.tool-result').textContent, /scenario-basic/);
  assert.match(grepA.querySelector('summary').textContent, /Grep/);
  assert.match(grepA.querySelector('.block.tool-result').textContent, /No files found/);
  assert.match(grepB.querySelector('summary').textContent, /Grep/);
  assert.match(grepB.querySelector('.block.tool-result').textContent, /No files found/);
});

test('DOM: outer-turn assistant envelope is a no-op — streamed tool block stays single + done', async () => {
  // The outer turn's UI is driven entirely by stream_event deltas. The
  // trailing `assistant` envelope must NOT cause a second tool block to
  // be rendered next to the streamed one — that was the regression where
  // the streamed block stuck at status 'streaming…' while a reconciler-
  // built block reported 'done' (same toolUseId, two DOM nodes).
  const { document, root, Parser, Conversation } = await setupDOM();
  const conversation = new Conversation(root);
  feed(new Parser(), conversation, [
    ...bashToolCallStream(),
    {
      type: 'assistant',
      message: {
        id: 'msg_test_bash',
        role: 'assistant',
        content: [
          { type: 'tool_use', id: 'tu_bash', name: 'Bash', input: { command: 'ls -la', description: 'List files' } },
        ],
      },
    },
  ]);

  const toolBlocks = root.querySelectorAll('.block.tool');
  assert.equal(toolBlocks.length, 1, 'outer-turn assistant envelope must not produce a second tool block');
  const status = toolBlocks[0].querySelector('.tool-status');
  assert.ok(status);
  assert.match(status.textContent, /done/, `status must stay 'done' after attached result (got: ${status.textContent})`);
});

test('DOM: outer-turn assistant envelope does not duplicate text or tool blocks when its content shape differs from the streamed indices', async () => {
  // Reproduces the user-reported bug: an outer-turn assistant envelope
  // whose content[] array is in a different shape/order than the
  // streamed content_block_* indices would, under the old reconcile
  // path, create a SECOND copy of each text/tool block next to the
  // streamed one (key mismatch made the dedup check miss). With the
  // outer reconcile gated off, the trailing envelope is a no-op and the
  // DOM keeps exactly one block per streamed entry.
  const { document, root, Parser, Conversation } = await setupDOM();
  const conversation = new Conversation(root);
  const msgId = 'msg_dup_repro';
  feed(new Parser(), conversation, [
    { type: 'stream_event', event: { type: 'message_start', message: { id: msgId, role: 'assistant' } } },
    // Thinking @ index 0 — content streams in.
    { type: 'stream_event', event: { type: 'content_block_start', index: 0, content_block: { type: 'thinking' } } },
    { type: 'stream_event', event: { type: 'content_block_delta', index: 0, delta: { type: 'thinking_delta', thinking: 'planning the write' } } },
    { type: 'stream_event', event: { type: 'content_block_stop', index: 0 } },
    // Text @ index 1.
    { type: 'stream_event', event: { type: 'content_block_start', index: 1, content_block: { type: 'text' } } },
    { type: 'stream_event', event: { type: 'content_block_delta', index: 1, delta: { type: 'text_delta', text: 'Now I have enough context to plan. Let me write the plan file.' } } },
    { type: 'stream_event', event: { type: 'content_block_stop', index: 1 } },
    // Write tool_use @ index 2.
    { type: 'stream_event', event: { type: 'content_block_start', index: 2, content_block: { type: 'tool_use', id: 'tu_write', name: 'Write', input: {} } } },
    { type: 'stream_event', event: { type: 'content_block_delta', index: 2, delta: { type: 'input_json_delta', partial_json: '{"file_path":"/tmp/plan.md","content":"hi"}' } } },
    { type: 'stream_event', event: { type: 'content_block_stop', index: 2 } },
    { type: 'stream_event', event: { type: 'message_stop' } },
    // Trailing assistant envelope. Same msgId; the content array shape
    // would, under the old code, drive reconcile to re-render every
    // block. We assert the DOM keeps exactly the streamed blocks.
    {
      type: 'assistant',
      message: {
        id: msgId,
        role: 'assistant',
        content: [
          { type: 'thinking', thinking: 'planning the write' },
          { type: 'text', text: 'Now I have enough context to plan. Let me write the plan file.' },
          { type: 'tool_use', id: 'tu_write', name: 'Write', input: { file_path: '/tmp/plan.md', content: 'hi' } },
        ],
      },
    },
  ]);

  assert.equal(root.querySelectorAll('.block.tool').length, 1, 'outer tool block must not be duplicated by reconcile');
  assert.equal(root.querySelectorAll('.block.text').length, 1, 'outer text block must not be duplicated by reconcile');
  assert.equal(root.querySelectorAll('.block.thinking').length, 1, 'outer thinking block must not be duplicated by reconcile');
  // And the streamed tool block reached 'running' via the content_block_stop tool_use event.
  const status = root.querySelector('.block.tool .tool-status');
  assert.ok(status);
  assert.match(status.textContent, /running/, `streamed tool block reaches 'running' on its own content_block_stop (got: ${status.textContent})`);
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

// Two distinct msgIds back-to-back. Each is a fresh assistant envelope on the
// wire (sequential tool calls split into per-msgId message_start/_stop pairs
// because every tool_use → tool_result cycle is a separate CLI-level turn).
// The renderer must NOT mint a new .msg.assistant box for the second msgId —
// both should land in a single grouped envelope.
function twoSequentialAssistantTurns() {
  return [
    { type: 'stream_event', event: { type: 'message_start', message: { id: 'msg_one', role: 'assistant' } } },
    { type: 'stream_event', event: { type: 'content_block_start', index: 0, content_block: { type: 'tool_use', id: 'tu_one', name: 'Bash', input: {} } } },
    { type: 'stream_event', event: { type: 'content_block_delta', index: 0, delta: { type: 'input_json_delta', partial_json: '{"command":"ls"}' } } },
    { type: 'stream_event', event: { type: 'content_block_stop', index: 0 } },
    { type: 'stream_event', event: { type: 'message_stop' } },
    { type: 'user', message: { role: 'user', content: [{ type: 'tool_result', tool_use_id: 'tu_one', content: 'a\nb\n', is_error: false }] } },
    { type: 'stream_event', event: { type: 'message_start', message: { id: 'msg_two', role: 'assistant' } } },
    { type: 'stream_event', event: { type: 'content_block_start', index: 0, content_block: { type: 'tool_use', id: 'tu_two', name: 'Bash', input: {} } } },
    { type: 'stream_event', event: { type: 'content_block_delta', index: 0, delta: { type: 'input_json_delta', partial_json: '{"command":"pwd"}' } } },
    { type: 'stream_event', event: { type: 'content_block_stop', index: 0 } },
    { type: 'stream_event', event: { type: 'message_stop' } },
    { type: 'user', message: { role: 'user', content: [{ type: 'tool_result', tool_use_id: 'tu_two', content: '/tmp\n', is_error: false }] } },
  ];
}

test('DOM: consecutive assistant turns (different msgIds) render in a single grouped envelope', async () => {
  const { root, Parser, Conversation } = await setupDOM();
  const conversation = new Conversation(root);
  feed(new Parser(), conversation, twoSequentialAssistantTurns());

  const wraps = root.querySelectorAll('.msg.assistant');
  assert.equal(wraps.length, 1, 'two consecutive assistant msgIds must group into one .msg.assistant');
  const tools = wraps[0].querySelectorAll('.block.tool');
  assert.equal(tools.length, 2, 'both tool blocks land inside the single grouped envelope');
  const roles = wraps[0].querySelectorAll('.role');
  assert.equal(roles.length, 1, 'only one "assistant" role label is rendered');
});

test('DOM: a user_echo between two assistant turns reopens the envelope', async () => {
  const { root, Parser, Conversation } = await setupDOM();
  const conversation = new Conversation(root);
  const parser = new Parser();
  feed(parser, conversation, twoSequentialAssistantTurns());
  // Simulate a user echo (composer-submitted message) then a third turn.
  conversation.apply({ kind: 'user_echo', text: 'hi again', attachments: [] });
  feed(parser, conversation, [
    { type: 'stream_event', event: { type: 'message_start', message: { id: 'msg_three', role: 'assistant' } } },
    { type: 'stream_event', event: { type: 'content_block_start', index: 0, content_block: { type: 'tool_use', id: 'tu_three', name: 'Bash', input: {} } } },
    { type: 'stream_event', event: { type: 'content_block_delta', index: 0, delta: { type: 'input_json_delta', partial_json: '{"command":"date"}' } } },
    { type: 'stream_event', event: { type: 'content_block_stop', index: 0 } },
    { type: 'stream_event', event: { type: 'message_stop' } },
  ]);

  const assistantWraps = root.querySelectorAll('.msg.assistant');
  assert.equal(assistantWraps.length, 2, 'user echo must close the open assistant envelope so the next turn starts a new one');
  const userWraps = root.querySelectorAll('.msg.user');
  assert.equal(userWraps.length, 1);
});

test('DOM: sub-agent (Task) drill-down groups its own consecutive assistant turns', async () => {
  const { root, Parser, Conversation } = await setupDOM();
  const conversation = new Conversation(root);
  const parser = new Parser();
  // Outer turn: assistant invokes the Task tool.
  feed(parser, conversation, [
    { type: 'stream_event', event: { type: 'message_start', message: { id: 'msg_outer', role: 'assistant' } } },
    { type: 'stream_event', event: { type: 'content_block_start', index: 0, content_block: { type: 'tool_use', id: 'tu_task', name: 'Task', input: {} } } },
    { type: 'stream_event', event: { type: 'content_block_delta', index: 0, delta: { type: 'input_json_delta', partial_json: '{"description":"go","prompt":"do it","subagent_type":"general-purpose"}' } } },
    { type: 'stream_event', event: { type: 'content_block_stop', index: 0 } },
    { type: 'stream_event', event: { type: 'message_stop' } },
  ]);
  // Two sub-agent assistant envelopes (different msgIds) routed via parent_tool_use_id.
  // Sub-agent turns only arrive as `assistant` envelopes (no stream_event deltas);
  // the reconciliation pass renders them.
  feed(parser, conversation, [
    { type: 'assistant', parent_tool_use_id: 'tu_task', message: { id: 'sub_msg_one', role: 'assistant', content: [
      { type: 'tool_use', id: 'sub_tu_one', name: 'Bash', input: { command: 'ls' } },
    ] } },
    { type: 'assistant', parent_tool_use_id: 'tu_task', message: { id: 'sub_msg_two', role: 'assistant', content: [
      { type: 'tool_use', id: 'sub_tu_two', name: 'Bash', input: { command: 'pwd' } },
    ] } },
  ]);

  const subConv = root.querySelector('.sub-conversation');
  assert.ok(subConv, 'sub-agent drill-down area should be rendered');
  const subAssistantWraps = subConv.querySelectorAll('.msg.assistant');
  assert.equal(subAssistantWraps.length, 1, 'sub-agent consecutive msgIds must group into a single envelope');
  const subTools = subAssistantWraps[0].querySelectorAll('.block.tool');
  assert.equal(subTools.length, 2, 'both sub-agent tool blocks land in the single envelope');
});

test('DOM: redacted thinking renders as a non-expandable "thinking (redacted)" line', async () => {
  // Opus 4.7 emits a thinking block carrying only a signature_delta — no
  // thinking content. The parser emits thinking_redacted followed by
  // thinking_end. The UI must show a single static line, NOT a collapsible
  // <details> that opens to reveal the placeholder sentence (the previous
  // bug, where thinking_end's finalize() overwrote the redacted label with
  // "thinking (77 chars)" based on the placeholder body length).
  const { root, Parser, Conversation } = await setupDOM();
  const conversation = new Conversation(root);
  const msgId = 'msg_redacted';
  feed(new Parser(), conversation, [
    { type: 'stream_event', event: { type: 'message_start', message: { id: msgId, role: 'assistant' } } },
    { type: 'stream_event', event: { type: 'content_block_start', index: 0, content_block: { type: 'thinking' } } },
    { type: 'stream_event', event: { type: 'content_block_delta', index: 0, delta: { type: 'signature_delta', signature: 'sig_abc' } } },
    { type: 'stream_event', event: { type: 'content_block_stop', index: 0 } },
    { type: 'stream_event', event: { type: 'content_block_start', index: 1, content_block: { type: 'text' } } },
    { type: 'stream_event', event: { type: 'content_block_delta', index: 1, delta: { type: 'text_delta', text: 'ok' } } },
    { type: 'stream_event', event: { type: 'content_block_stop', index: 1 } },
    { type: 'stream_event', event: { type: 'message_stop' } },
  ]);

  const thinkings = root.querySelectorAll('.block.thinking');
  assert.equal(thinkings.length, 1, 'exactly one thinking block in the DOM');
  const node = thinkings[0];
  assert.equal(node.tagName, 'DIV', 'redacted thinking must NOT be a <details> — no expansion affordance');
  assert.equal(node.querySelector('summary'), null, 'redacted thinking must have no <summary>');
  assert.equal(node.textContent.trim(), 'thinking (redacted)', `label must be "thinking (redacted)" (got: ${node.textContent})`);
  assert.ok(node.classList.contains('redacted'), 'redacted thinking carries .redacted class for styling hooks');
  assert.doesNotMatch(root.textContent, /\d+ chars/, 'no "(NN chars)" leak from finalize() onto the redacted block');
  assert.doesNotMatch(root.textContent, /signature is streamed/, 'placeholder sentence is no longer in the DOM');
});

// Working/in-progress indicator: must exist in the static markup, default
// hidden, and only show the "Claude is working" sub-row while status==='turn'.
// The outer bar is now a persistent footer (visible whenever an instance is
// selected) hosting the ctx chip on the right — see updateActiveHeader().
test('DOM: #turn-indicator is the persistent footer; .ti-left tracks status==="turn"', async () => {
  const fs = await import('node:fs/promises');
  const html = await fs.readFile(path.join(PUB, 'index.html'), 'utf8');
  const window = new Window({ url: 'http://localhost/' });
  globalThis.window = window;
  globalThis.document = window.document;
  globalThis.HTMLElement = window.HTMLElement;
  document.documentElement.innerHTML = html.replace(/^[\s\S]*?<html[^>]*>/, '').replace(/<\/html>[\s\S]*$/, '');

  // Inject the actual stylesheet so [hidden] vs. visible can be tested
  // via computed style — the `hidden` attribute alone isn't enough,
  // because an author `display: flex` rule overrides the UA's
  // `[hidden] { display: none }`. That mismatch is the bug this test
  // exists to catch.
  const css = await fs.readFile(path.join(PUB, 'styles.css'), 'utf8');
  const styleTag = document.createElement('style');
  styleTag.textContent = css;
  document.head.appendChild(styleTag);

  const indicator = document.getElementById('turn-indicator');
  assert.ok(indicator, '#turn-indicator must exist in index.html');
  assert.equal(indicator.hidden, true, 'indicator carries the hidden attribute by default (no instance selected)');
  assert.equal(
    window.getComputedStyle(indicator).display, 'none',
    'indicator must be display:none while the hidden attribute is set — author CSS must not override the UA [hidden] rule',
  );

  const tiLeft = document.getElementById('ti-left');
  const tiRight = document.getElementById('ti-usage-slot');
  assert.ok(tiLeft, '#ti-left must exist for the working-indicator content');
  assert.ok(tiRight, '#ti-usage-slot must exist for the ctx chip');
  assert.ok(tiLeft.querySelector('.ti-dot'), '.ti-left contains the .ti-dot');
  assert.match(tiLeft.textContent, /Claude is working/, '.ti-left has the working label');
  assert.equal(tiLeft.hidden, true, '.ti-left starts hidden (no turn yet)');

  // It must sit between #task-panel and #composer — i.e. directly above
  // the composer at the bottom of the chat pane.
  const taskPanel = document.getElementById('task-panel');
  const composer = document.getElementById('composer');
  assert.ok(taskPanel && composer);
  assert.equal(taskPanel.nextElementSibling, indicator, '#turn-indicator follows #task-panel');
  assert.equal(indicator.nextElementSibling, composer, '#turn-indicator immediately precedes #composer');

  // Reproduce the toggle rules used in app.js:updateActiveHeader:
  //   - outer indicator: visible whenever there is a selected instance
  //   - .ti-left: visible only while status === 'turn'
  const applyStatus = (status) => {
    indicator.hidden = false;
    tiLeft.hidden = status !== 'turn';
  };
  const displayFor = (el) => window.getComputedStyle(el).display;
  applyStatus('idle');
  assert.notEqual(displayFor(indicator), 'none', 'idle → bar visible (ctx chip stays mounted)');
  assert.equal(displayFor(tiLeft), 'none', 'idle → .ti-left display:none');
  applyStatus('turn');
  assert.notEqual(displayFor(indicator), 'none', 'turn → bar visible');
  assert.notEqual(displayFor(tiLeft), 'none', 'turn → .ti-left visible (working dot animates)');
  applyStatus('spawning'); assert.equal(displayFor(tiLeft), 'none', 'spawning → .ti-left display:none');
  applyStatus('crashed'); assert.equal(displayFor(tiLeft), 'none', 'crashed → .ti-left display:none');
  // No-instance case: outer bar collapses back.
  indicator.hidden = true;
  assert.equal(displayFor(indicator), 'none', 'no-instance → bar display:none');

  // The CSS rule that styles it must reference --green (the working colour)
  // and reuse the existing `pulse` animation defined for the sidebar dot.
  assert.match(css, /\.turn-indicator\b/, 'styles.css defines .turn-indicator');
  assert.match(css, /\.turn-indicator\s+\.ti-dot[\s\S]*?--green/, '.ti-dot uses --green');
  assert.match(css, /\.turn-indicator\s+\.ti-dot[\s\S]*?animation:\s*pulse/, '.ti-dot reuses the pulse keyframe');
});

test('DOM: assistant text re-renders as Markdown + autolinks on text_end', async () => {
  const { root, Parser, Conversation } = await setupDOM();
  const conv = new Conversation(root);
  const p = new Parser();
  const stream = [
    { type: 'stream_event', event: { type: 'message_start', message: { id: 'm_md', role: 'assistant' } } },
    { type: 'stream_event', event: { type: 'content_block_start', index: 0, content_block: { type: 'text', text: '' } } },
    { type: 'stream_event', event: { type: 'content_block_delta', index: 0, delta: { type: 'text_delta', text: 'See **bold** and ' } } },
    { type: 'stream_event', event: { type: 'content_block_delta', index: 0, delta: { type: 'text_delta', text: 'https://example.com here.' } } },
  ];
  for (const e of stream) for (const ev of p.handleObject(e)) conv.apply(ev);

  // Mid-stream: text is plain (no markdown re-render yet).
  const textBlock = root.querySelector('.block.text');
  assert.ok(textBlock, 'a .block.text must exist while streaming');
  assert.equal(textBlock.querySelector('a'), null, 'no anchor before text_end');
  assert.equal(textBlock.querySelector('strong'), null, 'no <strong> before text_end');
  assert.match(textBlock.textContent, /See \*\*bold\*\* and https:\/\/example\.com here\./);

  // Close the block — finalize() should re-render as Markdown with the URL autolinked.
  for (const ev of p.handleObject({ type: 'stream_event', event: { type: 'content_block_stop', index: 0 } })) conv.apply(ev);

  assert.ok(textBlock.classList.contains('md'), 'finalize adds the md class for shared markdown CSS');
  const strong = textBlock.querySelector('strong');
  assert.ok(strong, 'bold renders as <strong> after finalize');
  assert.equal(strong.textContent, 'bold');
  const a = textBlock.querySelector('a');
  assert.ok(a, 'bare URL becomes an anchor after finalize');
  assert.equal(a.getAttribute('href'), 'https://example.com');
  assert.equal(a.getAttribute('target'), '_blank');
  assert.equal(a.getAttribute('rel'), 'noopener noreferrer');
  // Trailing sentence punctuation must remain outside the anchor.
  assert.match(textBlock.textContent, /here\.$/);
});
