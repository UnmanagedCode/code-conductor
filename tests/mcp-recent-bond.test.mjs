// get_recent_messages default-call "bonding": when `count` is omitted (not
// merely passed as 1), a turn can split its prose and its
// ExitPlanMode/AskUserQuestion tool call across two separate assistant
// messages (the CLI starts a fresh message after the tool_result denial).
// The default call should surface both halves in one shot instead of
// silently returning only the trailing prose. Explicit `count` stays literal.

import { test, before, after, beforeEach, afterEach } from 'node:test';
import assert from 'node:assert/strict';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { bootServer, api, waitFor, instForSession, freshProjectsRoot, rmrf, stripMessageBoundaryHeader } from './helpers.mjs';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const SCENARIO_WS = path.join(__dirname, 'fixtures', 'scenario-ws.json');
const SCENARIO_EXIT_PLAN_SPLIT = path.join(__dirname, 'fixtures', 'scenario-exit-plan-split.json');
const SCENARIO_EXIT_PLAN_COMBINED = path.join(__dirname, 'fixtures', 'scenario-exit-plan-combined.json');
const SCENARIO_EXIT_PLAN_MULTI_TRAILING = path.join(__dirname, 'fixtures', 'scenario-exit-plan-multi-trailing.json');
const SCENARIO_QUESTION = path.join(__dirname, 'fixtures', 'scenario-question.json');
const SCENARIO_PROSE_THEN_PLAN = path.join(__dirname, 'fixtures', 'scenario-prose-then-plan.json');

let nextRpcId = 1;
async function rpc(baseUrl, method, params) {
  const id = nextRpcId++;
  const res = await fetch(baseUrl + '/mcp', {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ jsonrpc: '2.0', id, method, params }),
  });
  const body = await res.json();
  return { status: res.status, body };
}
async function callTool(baseUrl, name, args) {
  const { body } = await rpc(baseUrl, 'tools/call', { name, arguments: args });
  assert.ok(body?.result, `tools/call ${name} returned no result; body=${JSON.stringify(body)}`);
  return body.result;
}
function unwrap(result) {
  assert.ok(Array.isArray(result.content), 'tool result has content[]');
  return JSON.parse(result.content[0].text);
}
function unwrapMessages(result) {
  assert.ok(Array.isArray(result.content), 'tool result has content[]');
  const meta = JSON.parse(result.content[0].text);
  const bodies = result.content.slice(1).map(c => c.text);
  return {
    sessionId: meta.sessionId,
    messages: meta.messages.map((m, i) => ({ ...m, text: stripMessageBoundaryHeader(bodies[i] ?? '') })),
  };
}

let ctx, baseUrl, instances, home;

before(async () => {
  ctx = await bootServer({ scenarioPath: SCENARIO_WS });
  ({ baseUrl, instances } = ctx);
});
after(async () => { await ctx.close(); });
beforeEach(async () => { ({ home } = await freshProjectsRoot()); });
afterEach(async () => {
  await instances.shutdown();
  await rmrf(home);
});

async function spawnWithScenario(scenarioPath, projectName) {
  const prev = process.env.FAKE_CLAUDE_SCENARIO;
  process.env.FAKE_CLAUDE_SCENARIO = scenarioPath;
  try {
    await api(baseUrl, 'POST', '/api/projects', { name: projectName });
    const spawn = unwrap(await callTool(baseUrl, 'spawn_instance', { project: projectName, mode: 'bypassPermissions' }));
    await waitFor(() => instForSession(instances, spawn.sessionId)?.status === 'idle');
    return spawn.sessionId;
  } finally {
    if (prev === undefined) delete process.env.FAKE_CLAUDE_SCENARIO;
    else process.env.FAKE_CLAUDE_SCENARIO = prev;
  }
}

test('get_recent_messages: default call bonds a split ExitPlanMode + trailing prose', async () => {
  const sessionId = await spawnWithScenario(SCENARIO_EXIT_PLAN_SPLIT, 'a');
  await callTool(baseUrl, 'send_prompt', { sessionId, text: 'plan this', wait: true, waitTimeoutMs: 5000 });

  const res = unwrapMessages(await callTool(baseUrl, 'get_recent_messages', { sessionId }));
  assert.equal(res.messages.length, 2, 'default call bonds the plan message with the trailing prose');
  assert.equal(res.messages[0].hasPlan, true);
  assert.equal(res.messages[0].text, '--- plan ---\nStep 1\nStep 2');
  assert.ok(!Object.hasOwn(res.messages[1], 'hasPlan'), 'second message has no plan of its own');
  assert.equal(res.messages[1].text, 'Standing by for approval.');
});

test('get_recent_messages: default call bonds a plan + TWO trailing prose messages in one turn', async () => {
  const sessionId = await spawnWithScenario(SCENARIO_EXIT_PLAN_MULTI_TRAILING, 'a');
  await callTool(baseUrl, 'send_prompt', { sessionId, text: 'plan this', wait: true, waitTimeoutMs: 5000 });

  const raw = await callTool(baseUrl, 'get_recent_messages', { sessionId });
  const res = unwrapMessages(raw);
  assert.equal(res.messages.length, 3, 'default call spans the plan message through the end of the turn');
  assert.equal(res.messages[0].hasPlan, true);
  assert.equal(res.messages[0].text, '--- plan ---\nStep 1\nStep 2');
  assert.ok(!Object.hasOwn(res.messages[1], 'hasPlan'));
  assert.equal(res.messages[1].text, 'First trailing note.');
  // Raw (unstripped) bodies carry the boundary line once >1 message is
  // returned — the text-less plan message's body is the boundary line
  // followed by the fenced plan (never empty for a plan-only turn).
  const rawBodies = raw.content.slice(1).map(c => c.text);
  assert.match(rawBodies[0], /^--- message 1\/3 · .+ · 0 chars ---\n--- plan ---\nStep 1\nStep 2$/);
  assert.match(rawBodies[1], /^--- message 2\/3 · .+ · \d+ chars ---\nFirst trailing note\.$/);
  assert.match(rawBodies[2], /^--- message 3\/3 · .+ · \d+ chars ---\nStanding by for approval\.$/);
  assert.ok(!Object.hasOwn(res.messages[2], 'hasPlan'));
  assert.equal(res.messages[2].text, 'Standing by for approval.');
});

test('get_recent_messages: explicit count:1 stays literal on a multi-trailing turn (no bonding)', async () => {
  const sessionId = await spawnWithScenario(SCENARIO_EXIT_PLAN_MULTI_TRAILING, 'a');
  await callTool(baseUrl, 'send_prompt', { sessionId, text: 'plan this', wait: true, waitTimeoutMs: 5000 });

  const res = unwrapMessages(await callTool(baseUrl, 'get_recent_messages', { sessionId, count: 1 }));
  assert.equal(res.messages.length, 1, 'explicit count:1 returns exactly one message, no bonding');
  assert.equal(res.messages[0].text, 'Standing by for approval.');
  assert.ok(!Object.hasOwn(res.messages[0], 'hasPlan'));
});

test('get_recent_messages: explicit count:1 stays literal (no bonding) on a split ExitPlanMode turn', async () => {
  const sessionId = await spawnWithScenario(SCENARIO_EXIT_PLAN_SPLIT, 'a');
  await callTool(baseUrl, 'send_prompt', { sessionId, text: 'plan this', wait: true, waitTimeoutMs: 5000 });

  const res = unwrapMessages(await callTool(baseUrl, 'get_recent_messages', { sessionId, count: 1 }));
  assert.equal(res.messages.length, 1, 'explicit count:1 returns exactly one message, no bonding');
  assert.equal(res.messages[0].text, 'Standing by for approval.');
  assert.ok(!Object.hasOwn(res.messages[0], 'hasPlan'));
});

test('get_recent_messages: default call bonds a split AskUserQuestion + trailing prose', async () => {
  const sessionId = await spawnWithScenario(SCENARIO_QUESTION, 'a');
  await callTool(baseUrl, 'send_prompt', { sessionId, text: 'ask me', wait: true, waitTimeoutMs: 5000 });

  const res = unwrapMessages(await callTool(baseUrl, 'get_recent_messages', { sessionId }));
  assert.equal(res.messages.length, 2, 'default call bonds the question message with the trailing prose');
  assert.equal(res.messages[0].questionCount, 1);
  assert.equal(
    res.messages[0].text,
    '--- questions ---\n1. Pick a fruit (multiSelect: false) · header: Fruit\n   - Apple\n   - Banana',
  );
  assert.equal(res.messages[1].text, 'Waiting for your response.');
  assert.ok(!Object.hasOwn(res.messages[1], 'questionCount'));
});

test('get_recent_messages: bonding never walks back more than one message', async () => {
  const sessionId = await spawnWithScenario(SCENARIO_QUESTION, 'a');
  await callTool(baseUrl, 'send_prompt', { sessionId, text: 'ask me', wait: true, waitTimeoutMs: 5000 });
  // Second turn: a further pure-prose message. Its immediate predecessor
  // ("Waiting for your response.") is pure prose too, so the question two
  // messages back must NOT be pulled in.
  await callTool(baseUrl, 'send_prompt', { sessionId, text: 'continue', wait: true, waitTimeoutMs: 5000 });

  const res = unwrapMessages(await callTool(baseUrl, 'get_recent_messages', { sessionId }));
  assert.equal(res.messages.length, 1, 'no bonding when the immediate predecessor has no plan/questions');
  assert.equal(res.messages[0].text, 'got it');
});

test('get_recent_messages: an already-combined message (text + plan together) is returned alone', async () => {
  const sessionId = await spawnWithScenario(SCENARIO_EXIT_PLAN_COMBINED, 'a');
  await callTool(baseUrl, 'send_prompt', { sessionId, text: 'plan this', wait: true, waitTimeoutMs: 5000 });

  const res = unwrapMessages(await callTool(baseUrl, 'get_recent_messages', { sessionId }));
  assert.equal(res.messages.length, 1, 'no bonding attempted when the last message already carries its own plan');
  // Order-faithful: the prose block preceded the ExitPlanMode tool_use in the
  // turn's block stream, so it renders before the "--- plan ---" fence.
  assert.equal(res.messages[0].text, 'Here is my plan.\n--- plan ---\nStep 1\nStep 2');
  assert.equal(res.messages[0].hasPlan, true);
});

test('get_recent_messages: last message carrying its own plan is not bonded backward to earlier prose', async () => {
  const sessionId = await spawnWithScenario(SCENARIO_PROSE_THEN_PLAN, 'a');
  await callTool(baseUrl, 'send_prompt', { sessionId, text: 'one', wait: true, waitTimeoutMs: 5000 });
  await callTool(baseUrl, 'send_prompt', { sessionId, text: 'two', wait: true, waitTimeoutMs: 5000 });

  const res = unwrapMessages(await callTool(baseUrl, 'get_recent_messages', { sessionId }));
  assert.equal(res.messages.length, 1, 'the plan message is returned alone, earlier prose is not pulled backward');
  assert.equal(res.messages[0].hasPlan, true);
  assert.equal(res.messages[0].text, '--- plan ---\nOnly plan');
});
