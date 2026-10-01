// Where the per-call usage line lands in a real Conversation (happy-dom). A
// live `call_usage` follows its call's last block. The line joins the wrap's
// open action group when there is one, else the wrap body. It is never a
// `.block`, so it never changes a group's tally, never opens or splits a
// group, and never creates a wrap of its own.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { Window } from 'happy-dom';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const PUB = path.resolve(__dirname, '..', 'public');

async function setupDOM() {
  const window = new Window({ url: 'http://localhost/' });
  globalThis.window = window;
  globalThis.document = window.document;
  globalThis.HTMLElement = window.HTMLElement;
  globalThis.Element = window.Element;
  globalThis.Node = window.Node;
  const { Conversation } = await import(pathToFileURL(path.join(PUB, 'conversation.js')).href);
  const { renderEventBatch } = await import(pathToFileURL(path.join(PUB, 'lazyHistory.js')).href);
  document.body.innerHTML = '<div id="root"></div>';
  return { root: document.getElementById('root'), Conversation, renderEventBatch };
}

const feed = (conv, events) => { for (const ev of events) conv.apply(ev); };

const thinking = (msgId, blockIdx) => [
  { kind: 'thinking_start', msgId, blockIdx },
  { kind: 'thinking_delta', msgId, blockIdx, text: 'pondering' },
  { kind: 'thinking_end', msgId, blockIdx },
];
const text = (msgId, blockIdx, body) => [
  { kind: 'text_delta', msgId, blockIdx, text: body },
  { kind: 'text_end', msgId, blockIdx },
];
const tool = (msgId, blockIdx, id, name) => [
  { kind: 'tool_use_start', msgId, blockIdx, toolUseId: id, name },
  { kind: 'tool_use', msgId, blockIdx, toolUseId: id, name, input: { command: 'x' } },
  { kind: 'tool_result', toolUseId: id, content: 'ok', isError: false },
];
const callUsage = (msgId, over = {}) => ({
  kind: 'call_usage', msgId, parentToolUseId: null,
  outputTokens: 460, thinkingTokens: 73, promptTokens: 84_000, growthTokens: 3_200, ...over,
});

const groupsIn = (node) => [...node.querySelectorAll('.action-group')];
const agBodyOf = (group) => [...group.children].find(c => c.classList.contains('ag-body'));
const summaryOf = (group) => group.querySelector('.ag-summary').textContent;

test('a thinking + parallel-tool call: the line joins the open group after its last tool, and the tally ignores it', async () => {
  const { root, Conversation } = await setupDOM();
  const conv = new Conversation(root);
  feed(conv, [...thinking('m1', 0), ...tool('m1', 1, 'tu1', 'Read'), ...tool('m1', 2, 'tu2', 'Read')]);
  const [group] = groupsIn(root);
  const before = summaryOf(group);

  conv.apply(callUsage('m1'));
  assert.equal(groupsIn(root).length, 1, 'no group opened or split');
  const kids = [...agBodyOf(group).children];
  assert.ok(kids.at(-1).classList.contains('call-usage'), 'the line follows the call\'s last tool block');
  assert.ok(kids.at(-2).classList.contains('tool'));
  assert.equal(summaryOf(group), before, 'the group header count is unchanged');
  assert.match(before, /^3 actions/);
  assert.ok(group.open, 'the badge does not close the still-running group');
});

test('a call ending in text: the line goes in the wrap body after the text, with no group created', async () => {
  const { root, Conversation } = await setupDOM();
  const conv = new Conversation(root);
  feed(conv, [...thinking('m1', 0), ...text('m1', 1, 'the answer')]);
  const groupsBefore = groupsIn(root).length;

  conv.apply(callUsage('m1', { thinkingTokens: 0 }));
  assert.equal(groupsIn(root).length, groupsBefore, 'no extra action group');
  const body = root.querySelector('.msg.assistant > .blocks');
  assert.ok(body.lastElementChild.classList.contains('call-usage'));
  assert.ok(body.lastElementChild.previousElementSibling.classList.contains('text'));
  assert.equal(body.lastElementChild.textContent, '+3.2k → ctx 84k · out 460');
});

test('the next call\'s tools continue the same group, past the line', async () => {
  const { root, Conversation } = await setupDOM();
  const conv = new Conversation(root);
  feed(conv, [...tool('m1', 0, 'tu1', 'Read'), callUsage('m1'), ...tool('m2', 0, 'tu2', 'Bash')]);
  const groups = groupsIn(root);
  assert.equal(groups.length, 1, 'one run across both calls');
  const kinds = [...agBodyOf(groups[0]).children].map(c => (c.classList.contains('call-usage') ? 'usage' : 'tool'));
  assert.deepEqual(kinds, ['tool', 'usage', 'tool']);
  assert.match(summaryOf(groups[0]), /^2 actions/);
});

test('a call_usage for an unknown msgId creates no wrap and keeps the empty-state placeholder', async () => {
  const { root, Conversation } = await setupDOM();
  const conv = new Conversation(root);
  assert.ok(root.querySelector('.empty'), 'premise: a fresh conversation shows the placeholder');
  conv.apply(callUsage('m-unknown'));
  assert.equal(root.querySelectorAll('.msg').length, 0);
  assert.equal(root.querySelectorAll('.call-usage').length, 0);
  assert.ok(root.querySelector('.empty'), 'the placeholder survives');
});

test('a static lazy-history batch without call_usage renders no line', async () => {
  const { renderEventBatch } = await setupDOM();
  const { holder } = renderEventBatch([
    { kind: 'user_echo', text: 'go', userIndex: 0 },
    ...thinking('m1', 0), ...tool('m1', 1, 'tu1', 'Read'), ...text('m1', 2, 'done'),
  ]);
  assert.ok(holder.querySelector('.tool'), 'premise: the batch rendered its blocks');
  assert.equal(holder.querySelectorAll('.call-usage').length, 0);
});
