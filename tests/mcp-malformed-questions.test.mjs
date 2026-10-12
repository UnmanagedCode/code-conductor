// A worker's AskUserQuestion `questions` is the model's raw tool input, so a
// non-array `options`, a null question or a null option reaches the server as
// is. Every MCP surface that renders or answers it — get_recent_messages,
// send_prompt({forward}), the idle-wake fold and answer_question — must do so
// without throwing, keeping each question in its numbered position (the
// `answers` array is index-aligned to that numbering), and the answer text must
// still be what QuestionAnswerCorrelator pairs against the RAW array.
//
// The question is injected into a live worker via inst._handleStdoutLine, so one
// scenario serves every malformed shape.

import { test, before, after, beforeEach, afterEach } from 'node:test';
import assert from 'node:assert/strict';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { bootServer, api, waitFor, freshProjectsRoot, rmrf, stripMessageBoundaryHeader } from './helpers.mjs';
import { buildRecentMessages } from '../src/mcp/handlers.ts';
import { formatUserQuestionAnswers } from '../public/userQuestionAnswers.ts';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const SCENARIO_WS = path.join(__dirname, 'fixtures', 'scenario-ws.json');

let ctx, baseUrl, instances, home;
before(async () => { ctx = await bootServer({ scenarioPath: SCENARIO_WS }); ({ baseUrl, instances } = ctx); });
after(async () => { await ctx.close(); });
beforeEach(async () => { ({ home } = await freshProjectsRoot()); });
afterEach(async () => { await instances.shutdown(); await rmrf(home); });

let nextRpcId = 1;
async function callTool(name, args) {
  const res = await fetch(baseUrl + '/mcp', {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ jsonrpc: '2.0', id: nextRpcId++, method: 'tools/call', params: { name, arguments: args } }),
  });
  const body = await res.json();
  assert.ok(body?.result, `tools/call ${name} returned no result; body=${JSON.stringify(body)}`);
  assert.ok(!body.result.isError, `tools/call ${name} errored: ${body.result.content?.[0]?.text}`);
  return body.result;
}
const unwrap = (result) => JSON.parse(result.content[0].text);

async function spawnWorker(project = 'q') {
  await api(baseUrl, 'POST', '/api/projects', { name: project });
  const r = await api(baseUrl, 'POST', '/api/instances', { project, mode: 'bypassPermissions' });
  const inst = instances.get(r.body.id);
  await waitFor(() => inst.status === 'idle' && inst.sessionId);
  return inst;
}

// A worker holding a pending AskUserQuestion whose input is `questions`, verbatim.
async function spawnAsking(questions) {
  const inst = await spawnWorker();
  const inject = (obj) => inst._handleStdoutLine(JSON.stringify(obj));
  inject({ type: 'stream_event', event: { type: 'message_start', message: { id: 'msg_q', role: 'assistant' } } });
  inject({ type: 'stream_event', event: { type: 'content_block_start', index: 0, content_block: { type: 'tool_use', id: 'tu_q', name: 'AskUserQuestion', input: {} } } });
  inject({ type: 'stream_event', event: { type: 'content_block_delta', index: 0, delta: { type: 'input_json_delta', partial_json: JSON.stringify({ questions }) } } });
  inject({ type: 'stream_event', event: { type: 'content_block_stop', index: 0 } });
  inject({ type: 'stream_event', event: { type: 'message_stop' } });
  await waitFor(() => inst.ring.toArray().some(ev => ev.kind === 'user_question'));
  return { inst, sid: inst.sessionId };
}

// The one body block carrying the rendered questions section.
function questionsBody(bodies) {
  const found = bodies.map(stripMessageBoundaryHeader).filter(b => b.includes('--- questions ---'));
  assert.equal(found.length, 1, `exactly one body renders the questions; bodies=${JSON.stringify(bodies)}`);
  return found[0];
}
async function renderedQuestions(sid) {
  const result = await callTool('get_recent_messages', { sessionId: sid });
  return questionsBody(result.content.slice(1).map(c => c.text));
}

// ---------- rendering: get_recent_messages / forward / idle-wake fold ----------

test('get_recent_messages renders a question whose options is an object as one with no options', async () => {
  const { sid } = await spawnAsking([{ question: 'Q1', options: { label: 'x' } }]);
  assert.equal(await renderedQuestions(sid), '--- questions ---\n1. Q1 (multiSelect: false)');
});

test('get_recent_messages renders no option lines for a string options value', async () => {
  const { sid } = await spawnAsking([{ question: 'Q1', options: 'abc' }]);
  assert.equal(await renderedQuestions(sid), '--- questions ---\n1. Q1 (multiSelect: false)');
});

test('get_recent_messages keeps a null question in its numbered position', async () => {
  const { sid } = await spawnAsking([null, { question: 'Q2', options: [{ label: 'Yes' }] }]);
  assert.equal(await renderedQuestions(sid),
    '--- questions ---\n1.  (multiSelect: false)\n2. Q2 (multiSelect: false)\n   - Yes');
});

test('get_recent_messages drops a null option and renders the rest in order', async () => {
  const { sid } = await spawnAsking([{ question: 'Q3', options: [null, { label: 'Yes' }, 'No', { label: 'Maybe' }] }]);
  assert.equal(await renderedQuestions(sid),
    '--- questions ---\n1. Q3 (multiSelect: false)\n   - Yes\n   - Maybe');
});

test('get_recent_messages keeps a label-less option in place', async () => {
  const { sid } = await spawnAsking([{ question: 'Q4', options: [{ description: 'd' }, { label: 'Yes' }] }]);
  assert.equal(await renderedQuestions(sid),
    '--- questions ---\n1. Q4 (multiSelect: false)\n   - : d\n   - Yes');
});

test('the idle-wake fold renders a worker holding a null-option question', async () => {
  const { sid } = await spawnAsking([{ question: 'Q3', options: [null, { label: 'Yes' }] }]);
  const r = await buildRecentMessages({ sessionId: sid }, { instances });
  assert.ok(!('soft' in r), JSON.stringify(r));
  assert.equal(questionsBody(r.bodies), '--- questions ---\n1. Q3 (multiSelect: false)\n   - Yes');
});

test('send_prompt forward carries a malformed question set rendered by position', async () => {
  const { sid: sourceSid } = await spawnAsking([null, { question: 'Q3', options: [null, { label: 'Yes' }] }]);
  const target = await spawnWorker('t');
  const composed = [];
  const orig = target.prompt.bind(target);
  target.prompt = async (...a) => { composed.push(a[0]); return orig(...a); };

  const res = unwrap(await callTool('send_prompt', {
    sessionId: target.sessionId, forward: { sessionId: sourceSid }, text: 'Answer these.',
  }));
  assert.equal(res.forwarded, 1, JSON.stringify(res));
  assert.equal(composed.length, 1);
  assert.ok(composed[0].includes('--- questions ---\n1.  (multiSelect: false)\n2. Q3 (multiSelect: false)\n   - Yes'),
    composed[0]);
});

// ---------- answering: answer_question ----------

test('answer_question answers a question whose options is an object with typed text', async () => {
  const { sid } = await spawnAsking([{ question: 'Q1', options: { label: 'x' } }]);
  const res = unwrap(await callTool('answer_question', { sessionId: sid, answers: [{ text: 't' }] }));
  assert.equal(res.sentText, 'Answer to "Q1": (own answer) "t"', JSON.stringify(res));
});

test('answer_question picks the labelled option beside a null option', async () => {
  const { sid } = await spawnAsking([{ question: 'Q3', options: [null, { label: 'Yes' }] }]);
  const res = unwrap(await callTool('answer_question', { sessionId: sid, answers: [{ option: 'Yes' }] }));
  assert.equal(res.sentText, 'Answer to "Q3": "Yes"', JSON.stringify(res));
});

test('answer_question aligns answers past a null question by index', async () => {
  const { sid } = await spawnAsking([null, { question: 'Q2', options: [{ label: 'Yes' }] }]);
  const res = unwrap(await callTool('answer_question', { sessionId: sid, answers: [{}, { option: 'Yes' }] }));
  assert.equal(res.sentText, 'My answers:\n1. "Question 1": (no answer)\n2. "Q2": "Yes"', JSON.stringify(res));
});

test('answer_question picks the labelled option beside a label-less one', async () => {
  const { sid } = await spawnAsking([{ question: 'Q4', options: [{ description: 'd' }, { label: 'Yes' }] }]);
  const res = unwrap(await callTool('answer_question', { sessionId: sid, answers: [{ option: 'Yes' }] }));
  assert.equal(res.sentText, 'Answer to "Q4": "Yes"', JSON.stringify(res));
});

test('answer_question on a mixed malformed set sends text the correlator stamps against the raw questions', async () => {
  const raw = [null, { question: 'Notes?', options: { a: 1 } }, { question: 'Proceed?', options: [null, { label: 'Yes' }] }, 'oops'];
  const { inst, sid } = await spawnAsking(raw);
  const res = unwrap(await callTool('answer_question', {
    sessionId: sid, answers: [{ text: 'skip' }, {}, { option: 'Yes', note: 'now' }, { text: 'x' }],
  }));
  assert.equal(res.sentText, formatUserQuestionAnswers(raw, [
    { kind: 'custom', text: 'skip' }, { kind: 'none' }, { kind: 'option', label: 'Yes', note: 'now' }, { kind: 'custom', text: 'x' },
  ]), JSON.stringify(res));

  await waitFor(() => inst.ring.toArray().some(ev => ev.kind === 'user_echo' && ev.text === res.sentText));
  const events = inst.ring.toArray();
  const card = events.find(ev => ev.kind === 'user_question');
  const echo = events.find(ev => ev.kind === 'user_echo' && ev.text === res.sentText);
  assert.deepEqual(card.questions, raw, 'the card event keeps the raw tool input');
  assert.equal(echo.questionAnswer?.toolUseId, card.toolUseId, 'the correlator paired the answer with its card');
  assert.deepEqual(echo.questionAnswer.questions, raw);
});
