// Tests for the answer_question MCP tool: structured AskUserQuestion answers
// delivered byte-identically to the UI question card, plus soft-refusal
// validation. Mirrors the bootServer + rpc + unwrap pattern from
// tests/mcp-conduct-tools.test.mjs.

import { test, before, after, beforeEach, afterEach } from 'node:test';
import assert from 'node:assert/strict';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { bootServer, api, waitFor, freshProjectsRoot, rmrf } from './helpers.mjs';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const SCENARIO_QUESTION = path.join(__dirname, 'fixtures', 'scenario-question.json');

let ctx, baseUrl, instances, home, projectsRoot;
before(async () => { ctx = await bootServer({ scenarioPath: SCENARIO_QUESTION }); ({ baseUrl, instances } = ctx); });
after(async () => { await ctx.close(); });
beforeEach(async () => { ({ home, projectsRoot } = await freshProjectsRoot()); });
afterEach(async () => { await instances.shutdown(); await rmrf(home); });

let nextRpcId = 1;
async function rpc(method, params) {
  const id = nextRpcId++;
  const res = await fetch(baseUrl + '/mcp', {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ jsonrpc: '2.0', id, method, params }),
  });
  if (res.status === 202) return { status: 202, body: null };
  return { status: res.status, body: await res.json() };
}
async function callTool(name, args) {
  const { body } = await rpc('tools/call', { name, arguments: args });
  assert.ok(body?.result, `tools/call ${name} returned no result; body=${JSON.stringify(body)}`);
  return body.result;
}
function unwrap(result) {
  assert.ok(Array.isArray(result.content), 'tool result has content[]');
  return JSON.parse(result.content[0].text);
}

// Spawn a worker and drive it to the pending-question state (send a prompt and
// wait for the turn to end on the can_use_tool deny). Returns { inst, sid }.
async function spawnAtQuestion() {
  await api(baseUrl, 'POST', '/api/projects', { name: 'q' });
  const r = await api(baseUrl, 'POST', '/api/instances', { project: 'q', mode: 'bypassPermissions' });
  const inst = instances.get(r.body.id);
  await waitFor(() => inst.status === 'idle');
  const sid = inst.sessionId;
  await callTool('send_prompt', { sessionId: sid, text: 'go', wait: true });
  await waitFor(() => inst.ring.toArray().some(ev => ev.kind === 'user_question'));
  return { inst, sid };
}

test('tools/list includes answer_question with an object inputSchema', async () => {
  const { body } = await rpc('tools/list');
  const t = body.result.tools.find(x => x.name === 'answer_question');
  assert.ok(t, 'tools/list missing answer_question');
  assert.equal(t.inputSchema.type, 'object');
  assert.ok(typeof t.description === 'string' && t.description.length > 20);
});

test('answer_question sends the canonical single-option text and lands it as user_echo', async () => {
  const { inst, sid } = await spawnAtQuestion();
  const res = unwrap(await callTool('answer_question', { sessionId: sid, answers: [{ option: 'Apple' }] }));
  assert.equal(res.sessionId, sid);
  assert.equal(res.sentText, 'Answer to "Pick a fruit": Apple');
  await waitFor(() => inst.ring.toArray().some(
    ev => ev.kind === 'user_echo' && ev.text === 'Answer to "Pick a fruit": Apple'));
});

test('answer_question appends an option note', async () => {
  const { sid } = await spawnAtQuestion();
  const res = unwrap(await callTool('answer_question', {
    sessionId: sid, answers: [{ option: 'Banana', note: 'ripe' }],
  }));
  assert.equal(res.sentText, 'Answer to "Pick a fruit": Banana — ripe');
});

test('answer_question accepts a custom typed answer (trimmed)', async () => {
  const { sid } = await spawnAtQuestion();
  const res = unwrap(await callTool('answer_question', {
    sessionId: sid, answers: [{ text: '  Mango  ' }],
  }));
  assert.equal(res.sentText, 'Answer to "Pick a fruit": Mango');
});

test('answer_question soft-refuses INVALID_OPTION for an unoffered label', async () => {
  const { sid } = await spawnAtQuestion();
  const res = unwrap(await callTool('answer_question', {
    sessionId: sid, answers: [{ option: 'Cherry' }],
  }));
  assert.equal(res.ok, false);
  assert.equal(res.code, 'INVALID_OPTION');
  assert.deepEqual(res.invalid, ['Cherry']);
});

test('answer_question soft-refuses NOT_MULTISELECT when options[] used on a single-choice question', async () => {
  const { sid } = await spawnAtQuestion();
  const res = unwrap(await callTool('answer_question', {
    sessionId: sid, answers: [{ options: ['Apple', 'Banana'] }],
  }));
  assert.equal(res.ok, false);
  assert.equal(res.code, 'NOT_MULTISELECT');
});

test('answer_question soft-refuses ANSWER_COUNT_MISMATCH', async () => {
  const { sid } = await spawnAtQuestion();
  const res = unwrap(await callTool('answer_question', {
    sessionId: sid, answers: [{ option: 'Apple' }, { option: 'Banana' }],
  }));
  assert.equal(res.ok, false);
  assert.equal(res.code, 'ANSWER_COUNT_MISMATCH');
  assert.equal(res.expected, 1);
  assert.equal(res.got, 2);
});

test('answer_question soft-refuses EMPTY_ANSWER when every entry is empty', async () => {
  const { sid } = await spawnAtQuestion();
  const res = unwrap(await callTool('answer_question', {
    sessionId: sid, answers: [{}],
  }));
  assert.equal(res.ok, false);
  assert.equal(res.code, 'EMPTY_ANSWER');
});

test('answer_question soft-refuses NO_PENDING_QUESTION when the worker never asked', async () => {
  await api(baseUrl, 'POST', '/api/projects', { name: 'q' });
  const r = await api(baseUrl, 'POST', '/api/instances', { project: 'q', mode: 'bypassPermissions' });
  const inst = instances.get(r.body.id);
  await waitFor(() => inst.status === 'idle');
  const res = unwrap(await callTool('answer_question', {
    sessionId: inst.sessionId, answers: [{ option: 'Apple' }],
  }));
  assert.equal(res.ok, false);
  assert.equal(res.code, 'NO_PENDING_QUESTION');
});
