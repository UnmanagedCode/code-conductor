// Narration reaches the conductor by default on every MCP surface, marked as a
// `--- narration ---` body segment and never as a thinking block: the default
// get_recent_messages (ring, both reconstruction arms, and a retired session
// served from disk), the folded wake stub, and send_prompt({forward}).
//
// Each worker's prompt turn replays a real fixture from tests/fixtures/narration/
// through the fake CLI: `full` keeps the CLI's assistant envelopes (the
// reconciled arm), `stripped` drops them (the delta arm).

import { test, before, after, beforeEach, afterEach } from 'node:test';
import assert from 'node:assert/strict';
import { promises as fs } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { bootServer, api, waitFor, instForSession, freshProjectsRoot, rmrf, seedSessionJsonl, driveTurn } from './helpers.mjs';
import { localPlace } from '../src/projects.ts';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const FIXTURES = path.join(__dirname, 'fixtures', 'narration');
const SCENARIO_WS = path.join(__dirname, 'fixtures', 'scenario-ws.json');

const NARRATION_MSG = 'msg_011Cg4aZkEcqTrXhBFw7EJnj';
const NARRATION_TEXT = "This is fixable: I'll have the server save the instruction text (not the cut-off frame) as the session's first-prompt preview when the first prompt is a forward, update `readablePrompt`/`promptPreview` to show its first line (falling back to \"Forwarded worker output\" when missing), and adjust the related tests and docs—also noting that generic instruction openers should be replaced with role lines so titles stay meaningful.";
const SEGMENT = `--- narration ---\n${NARRATION_TEXT}`;

let ctx, baseUrl, instances, home;
before(async () => { ctx = await bootServer({ scenarioPath: SCENARIO_WS }); ({ baseUrl, instances } = ctx); });
after(async () => { await ctx.close(); });
beforeEach(async () => { ({ home } = await freshProjectsRoot()); });
afterEach(async () => {
  await instances.shutdown();
  instances._idleSubscribers?.clear();
  instances._idleHub?._owners.clear();
  await rmrf(home);
});

let nextRpcId = 1;
async function callTool(name, args) {
  const res = await fetch(baseUrl + '/mcp', {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ jsonrpc: '2.0', id: nextRpcId++, method: 'tools/call', params: { name, arguments: args } }),
  });
  const body = await res.json();
  assert.ok(body?.result, `tools/call ${name} returned no result; body=${JSON.stringify(body)}`);
  return body.result;
}
const unwrap = (result) => JSON.parse(result.content[0].text);
const metaBodies = (result) => ({ meta: JSON.parse(result.content[0].text), bodies: result.content.slice(1).map(c => c.text) });

const readJsonl = async (f) => (await fs.readFile(f, 'utf8')).split('\n').filter(Boolean).map(l => JSON.parse(l));
const stdoutOf = (name) => readJsonl(path.join(FIXTURES, `${name}.stdout.jsonl`));
const transcriptOf = (name) => readJsonl(path.join(FIXTURES, `${name}.transcript.jsonl`));
const stripEnvelopes = (lines) => lines.filter(l => l.type !== 'assistant');
// The narration message with its AskUserQuestion renamed to a tool nothing
// hoists, so the message carries no text, plan or questions — only narration.
const narrationOnly = (lines) => lines
  .filter(l => l.type !== 'control_request')
  .map(l => JSON.parse(JSON.stringify(l).replaceAll('"name":"AskUserQuestion"', '"name":"ToolSearch"')));

const RESULT = { type: 'result', subtype: 'success', stop_reason: 'end_turn', duration_ms: 10, total_cost_usd: 0.0001, is_error: false, usage: { input_tokens: 4, output_tokens: 2 } };

// Spawn a worker whose first prompt turn emits `lines`, and run that turn.
async function workerEmitting(project, lines) {
  const scenario = path.join(home, `scenario-${project}.json`);
  await fs.writeFile(scenario, JSON.stringify({
    events: [{ type: 'system', subtype: 'init', session_id: '$SID', cwd: '$CWD', model: 'claude-opus-5-5', permissionMode: '$MODE' }],
    turns: [{ on: { type: 'prompt' }, emit: [...lines, RESULT] }],
  }));
  await api(baseUrl, 'POST', '/api/projects', { name: project });
  const prev = process.env.FAKE_CLAUDE_SCENARIO;
  process.env.FAKE_CLAUDE_SCENARIO = scenario;
  let sid;
  try {
    sid = unwrap(await callTool('spawn_instance', { project, mode: 'bypassPermissions' })).sessionId;
    await waitFor(() => instForSession(instances, sid)?.status === 'idle');
  } finally {
    process.env.FAKE_CLAUDE_SCENARIO = prev;
  }
  await driveTurn(instances, sid, () => callTool('send_prompt', { sessionId: sid, text: 'go' }));
  return sid;
}

const recent = async (sid, args = {}) => metaBodies(await callTool('get_recent_messages', { sessionId: sid, ...args }));
const thinkingBlocks = (entry) => (entry.blocks ?? []).filter(b => b.type === 'thinking');

test('default get_recent_messages: narration is a body segment in arrival order, counted in meta, never a block — on both arms', async () => {
  const fixture = await stdoutOf('claude-narration');
  const bodies = {};
  for (const [variant, lines] of [['full', fixture], ['stripped', stripEnvelopes(fixture)]]) {
    const r = await recent(await workerEmitting(`narr-${variant}`, lines));
    assert.equal(r.meta.messages.length, 1, variant);
    const [entry] = r.meta.messages;
    assert.equal(entry.msgId, NARRATION_MSG, variant);
    assert.equal(entry.textChars, 0, `${variant}: narration is not the message's text`);
    assert.equal(entry.narrationChars, NARRATION_TEXT.length, variant);
    assert.equal(entry.narrationTruncated, false, variant);
    assert.deepEqual(thinkingBlocks(entry), [], `${variant}: no thinking block without includeThinking`);
    assert.ok(r.bodies[0].startsWith(`${SEGMENT}\n--- questions ---`),
      `${variant}: the narration segment precedes the questions it arrived before; body=${JSON.stringify(r.bodies[0])}`);
    bodies[variant] = r.bodies[0];
  }
  assert.equal(bodies.stripped, bodies.full, 'the delta arm renders the same body as the reconciled arm');
});

test('includeThinking:true lists the redacted thinking and never the narration', async () => {
  const sid = await workerEmitting('narr-think', await stdoutOf('claude-narration'));
  const r = await recent(sid, { includeThinking: true });
  const [entry] = r.meta.messages;
  assert.deepEqual(thinkingBlocks(entry).map(b => b.text), [''], 'only the redacted block is listed');
  assert.ok(r.bodies[0].includes(SEGMENT), 'narration still rides in the body');
});

test('a message carrying only narration counts as text-bearing', async () => {
  const sid = await workerEmitting('narr-only', narrationOnly(await stdoutOf('claude-narration')));
  const r = await recent(sid);
  assert.equal(r.meta.omittedToolOnly, 0);
  assert.deepEqual(r.meta.messages.map(m => m.msgId), [NARRATION_MSG]);
  assert.equal(r.bodies[0], SEGMENT);
});

test('claude-redacted-only: a redacted-thinking + tool message is still tool-only', async () => {
  const sid = await workerEmitting('redacted-only', await stdoutOf('claude-redacted-only'));
  const r = await recent(sid);
  assert.equal(r.meta.messages.length, 0);
  assert.equal(r.meta.omittedToolOnly, 1);
});

test('deepseek-plain: readable thinking yields no narration segment and is listed only under includeThinking', async () => {
  const sid = await workerEmitting('deepseek', await stdoutOf('deepseek-plain'));
  const plain = await recent(sid, { count: 2, includeToolCalls: true });
  assert.equal(plain.meta.messages.length, 2);
  for (const [i, entry] of plain.meta.messages.entries()) {
    assert.equal('narrationChars' in entry, false);
    assert.deepEqual(thinkingBlocks(entry), []);
    assert.ok(!plain.bodies[i].includes('--- narration ---'));
  }
  const think = await recent(sid, { count: 2, includeToolCalls: true, includeThinking: true });
  for (const entry of think.meta.messages) {
    const t = thinkingBlocks(entry);
    assert.equal(t.length, 1);
    assert.ok(t[0].text.length > 0, 'its thinking text is listed whole');
  }
});

test('a retired session served from disk renders the same narration body as the live ring', async () => {
  const sid = await workerEmitting('narr-retired', await stdoutOf('claude-narration'));
  const live = await recent(sid);
  const inst = instForSession(instances, sid);
  await seedSessionJsonl(localPlace(inst.cwd), inst.backingSessionId, [
    { type: 'user', uuid: 'u0', message: { role: 'user', content: 'go' } },
    ...await transcriptOf('claude-narration'),
  ]);
  const killed = unwrap(await callTool('kill_instance', { sessionId: sid }));
  assert.notEqual(killed.ok, false, `kill_instance refused: ${JSON.stringify(killed)}`);
  await waitFor(() => instances.idsForSession(sid).length === 0);

  const disk = await recent(sid);
  assert.equal(disk.meta.source, 'disk');
  assert.deepEqual(disk.meta.messages.map(m => [m.msgId, m.narrationChars]), [[NARRATION_MSG, NARRATION_TEXT.length]]);
  assert.equal(disk.bodies[0], live.bodies[0]);
});

test('the folded wake stub carries the narration segment', async () => {
  const sid = await workerEmitting('narr-wake', await stdoutOf('claude-narration'));
  const stub = await instances._idleHub._buildFoldedStub(sid);
  assert.ok(stub.includes(SEGMENT), `stub=${stub}`);
});

test('send_prompt({forward}) carries the narration segment to the target', async () => {
  const sourceSid = await workerEmitting('narr-fwd', await stdoutOf('claude-narration'));
  const targetSid = unwrap(await callTool('spawn_instance', { project: 'narr-fwd', mode: 'bypassPermissions' })).sessionId;
  await waitFor(() => instForSession(instances, targetSid)?.status === 'idle');
  const target = instForSession(instances, targetSid);
  const calls = [];
  const orig = target.prompt.bind(target);
  target.prompt = async (...a) => { calls.push(a); return orig(...a); };

  const res = unwrap(await callTool('send_prompt', { sessionId: targetSid, forward: { sessionId: sourceSid }, text: 'Carry on.' }));
  assert.equal(res.forwarded, 1);
  assert.ok(calls[0][0].includes(SEGMENT), `composed=${calls[0][0]}`);
});
