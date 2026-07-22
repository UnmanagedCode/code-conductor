// Async-worker CLI envelope shape: each content block is finalized as its own
// top-level `assistant` envelope — a single block per envelope, all sharing
// the parent msgId — instead of one multi-block envelope per message.
// buildMessageFromRing used to keep only the LAST envelope (last-wins), so any
// message whose text preceded a tool_use reconstructed with text:'' — the plan
// preamble / "Let me check X" prose vanished from get_recent_messages. The
// fix merges content blocks across all envelopes for the msgId; these tests
// pin that the prose survives for both the plain-tool and ExitPlanMode shapes
// (fixture derived from a real async-CLI debug trace).

import { test, before, after, beforeEach, afterEach } from 'node:test';
import assert from 'node:assert/strict';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { bootServer, api, waitFor, instForSession, freshProjectsRoot, rmrf, stripMessageBoundaryHeader } from './helpers.mjs';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const SCENARIO_WS = path.join(__dirname, 'fixtures', 'scenario-ws.json');
const SCENARIO_ASYNC_SINGLE_BLOCK = path.join(__dirname, 'fixtures', 'scenario-async-single-block.json');

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
  return { meta, messages: meta.messages.map((m, i) => ({ ...m, text: stripMessageBoundaryHeader(bodies[i] ?? '') })) };
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

async function spawnAsyncShape(projectName) {
  const prev = process.env.FAKE_CLAUDE_SCENARIO;
  process.env.FAKE_CLAUDE_SCENARIO = SCENARIO_ASYNC_SINGLE_BLOCK;
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

test('single-block envelopes: text preceding a tool_use survives reconstruction', async () => {
  const sessionId = await spawnAsyncShape('a');
  await callTool(baseUrl, 'send_prompt', { sessionId, text: 'go', wait: true, waitTimeoutMs: 5000 });

  const res = unwrapMessages(await callTool(baseUrl, 'get_recent_messages', { sessionId }));
  assert.equal(res.messages.length, 1);
  const m = res.messages[0];
  assert.equal(m.text, 'Let me check the config first.', 'prose before the tool_use is preserved (was "")');
  assert.equal(m.textChars, 'Let me check the config first.'.length);
  assert.equal(m.hasToolUse, true);
  assert.ok(Array.isArray(m.blocks) && m.blocks.some(b => b.type === 'tool_use' && b.name === 'Bash'),
    'the Bash tool_use block is carried alongside the text');
});

test('single-block envelopes: plan message keeps both its prose and the hoisted plan', async () => {
  const sessionId = await spawnAsyncShape('a');
  await callTool(baseUrl, 'send_prompt', { sessionId, text: 'one', wait: true, waitTimeoutMs: 5000 });
  await callTool(baseUrl, 'send_prompt', { sessionId, text: 'plan this', wait: true, waitTimeoutMs: 5000 });

  const res = unwrapMessages(await callTool(baseUrl, 'get_recent_messages', { sessionId }));
  assert.equal(res.messages.length, 1, 'text+plan live in ONE message — returned alone, no bonding needed');
  const m = res.messages[0];
  assert.equal(m.text, 'I dug through the reconstruction path; plan follows.', 'plan preamble preserved (was "")');
  assert.equal(m.plan, 'Step A\nStep B');
  assert.ok(!m.blocks?.some(b => b.name === 'ExitPlanMode'), 'hoisted plan is not duplicated in blocks[]');
});

test('single-block envelopes: explicit count returns both messages oldest-first with intact text', async () => {
  const sessionId = await spawnAsyncShape('a');
  await callTool(baseUrl, 'send_prompt', { sessionId, text: 'one', wait: true, waitTimeoutMs: 5000 });
  await callTool(baseUrl, 'send_prompt', { sessionId, text: 'two', wait: true, waitTimeoutMs: 5000 });

  const raw = await callTool(baseUrl, 'get_recent_messages', { sessionId, count: 2 });
  const res = unwrapMessages(raw);
  assert.equal(res.messages.length, 2);
  assert.equal(res.messages[0].text, 'Let me check the config first.');
  assert.equal(res.messages[1].text, 'I dug through the reconstruction path; plan follows.');
  assert.equal(res.meta.source, 'ring');
  // Raw (unstripped) bodies carry the boundary line once >1 message is returned.
  const rawBodies = raw.content.slice(1).map(c => c.text);
  assert.match(rawBodies[0], /^--- message 1\/2 · .+ · \d+ chars ---\nLet me check the config first\./);
  assert.match(rawBodies[1], /^--- message 2\/2 · .+ · \d+ chars ---\nI dug through the reconstruction path; plan follows\.$/);
});
