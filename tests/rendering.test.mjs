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

test('DOM: AskUserQuestion renders an option-button card with the questions and labels', async () => {
  const { document, root, Parser, Conversation } = await setupDOM();
  const answers = [];
  const conversation = new Conversation(root, {
    onUserQuestionAnswer: (payload) => answers.push(payload),
  });
  feed(new Parser(), conversation, askUserQuestionStream());

  // A user-question card should be rendered.
  const cards = root.querySelectorAll('.block.user-question');
  assert.equal(cards.length, 1, 'expected exactly one user-question card');
  const card = cards[0];

  // The question text should be visible.
  assert.match(card.textContent, /Which fruit\?/, 'question text must be visible');

  // Each option should be a clickable button with its label visible.
  const buttons = card.querySelectorAll('button.uq-opt');
  assert.equal(buttons.length, 2, `expected 2 option buttons, got ${buttons.length}`);
  assert.match(buttons[0].textContent, /Apple/);
  assert.match(buttons[1].textContent, /Banana/);

  // Tapping a button must fire the onUserQuestionAnswer callback with the
  // correct label, question index, and toolUseId.
  buttons[0].click();
  assert.equal(answers.length, 1, 'click should fire onUserQuestionAnswer once');
  assert.equal(answers[0].label, 'Apple');
  assert.equal(answers[0].questionIndex, 0);
  assert.equal(answers[0].toolUseId, 'tu_q');
  assert.ok(Array.isArray(answers[0].questions), 'questions array forwarded for prompt formatting');

  // After a pick, the card should be marked answered (buttons disabled).
  assert.ok(card.classList.contains('answered'), 'card should be marked answered');
  for (const btn of buttons) assert.ok(btn.disabled, 'all option buttons should be disabled post-pick');
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
