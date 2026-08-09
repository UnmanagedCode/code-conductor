// get_recent_messages must surface the PATH of the plan document backing an
// ExitPlanMode, so a conductor can hand a fresh implementer the plan itself
// rather than a paraphrase. Three branches, two rules: an empty-input
// ExitPlanMode (the plan-mode harness's normal shape) takes the session's last
// ~/.claude/plans/*.md write unconditionally — the server presents that file's
// contents AS the plan, so path and text corroborate by construction — while an
// INLINE plan only takes a path written in the SAME turn, since nothing else
// ties the remembered path to that particular ExitPlanMode.

import { test, before, after, beforeEach, afterEach } from 'node:test';
import assert from 'node:assert/strict';
import { promises as fs } from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import { fileURLToPath } from 'node:url';
import { bootServer, api, waitFor, instForSession, freshProjectsRoot, rmrf, stripMessageBoundaryHeader } from './helpers.mjs';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const SCENARIO_WS = path.join(__dirname, 'fixtures', 'scenario-ws.json');
const SCENARIO_PLAN_FILE = path.join(__dirname, 'fixtures', 'scenario-exit-plan-file.json');
const SCENARIO_PLAN_FILE_INLINE = path.join(__dirname, 'fixtures', 'scenario-exit-plan-file-inline.json');
const SCENARIO_PLAN_FILE_LATER_TURN = path.join(__dirname, 'fixtures', 'scenario-exit-plan-file-later-turn.json');

let nextRpcId = 1;
async function rpc(baseUrl, method, params) {
  const id = nextRpcId++;
  const res = await fetch(baseUrl + '/mcp', {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ jsonrpc: '2.0', id, method, params }),
  });
  return { status: res.status, body: await res.json() };
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
  delete process.env.FAKE_PLAN_FILE;
});

// Seed a plan file at the path the scenarios reference via $PLANFILE. When
// `content` is null the path is reserved but never created — the "unreadable
// plan file" case.
async function seedPlanFile(content) {
  const tmpDir = await fs.mkdtemp(path.join(os.tmpdir(), 'planpath-'));
  const planDir = path.join(tmpDir, '.claude', 'plans');
  await fs.mkdir(planDir, { recursive: true });
  const planFile = path.join(planDir, 'the-plan.md');
  if (content !== null) await fs.writeFile(planFile, content);
  process.env.FAKE_PLAN_FILE = planFile;
  return { planFile, cleanup: () => fs.rm(tmpDir, { recursive: true, force: true }).catch(() => {}) };
}

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

test('get_recent_messages: empty-input ExitPlanMode surfaces the plan file\'s path', async () => {
  const { planFile, cleanup } = await seedPlanFile('# Plan\n- Make X\n');
  try {
    const sessionId = await spawnWithScenario(SCENARIO_PLAN_FILE, 'a');
    await callTool(baseUrl, 'send_prompt', { sessionId, text: 'plan this', wait: true, waitTimeoutMs: 5000 });

    const res = unwrapMessages(await callTool(baseUrl, 'get_recent_messages', { sessionId }));
    assert.equal(res.messages[0].planPath, planFile, 'the plan file path reaches the MCP metadata');
    assert.equal(res.messages[0].text, `--- plan · saved to ${planFile} ---\n# Plan\n- Make X\n`,
      'the body header names the path and carries the file\'s contents');
  } finally { await cleanup(); }
});

test('get_recent_messages: empty-input ExitPlanMode bonds with the turn\'s trailing prose', async () => {
  const { cleanup } = await seedPlanFile('# Plan\n- Make X\n');
  try {
    const sessionId = await spawnWithScenario(SCENARIO_PLAN_FILE, 'a');
    await callTool(baseUrl, 'send_prompt', { sessionId, text: 'plan this', wait: true, waitTimeoutMs: 5000 });

    // The defect this card fixes: before the change, a plan written to a file
    // left the message plan-less, so the default call returned ONLY the
    // trailing prose and the conductor never saw a plan at all.
    const res = unwrapMessages(await callTool(baseUrl, 'get_recent_messages', { sessionId }));
    assert.equal(res.messages.length, 2, 'the plan message bonds with the trailing prose');
    assert.equal(res.messages[0].hasPlan, true);
    assert.equal(res.messages[1].text, 'Standing by for approval.');
  } finally { await cleanup(); }
});

test('get_recent_messages: an unreadable plan file still yields a path and still bonds', async () => {
  const { planFile, cleanup } = await seedPlanFile(null); // path reserved, file never created
  try {
    const sessionId = await spawnWithScenario(SCENARIO_PLAN_FILE, 'a');
    await callTool(baseUrl, 'send_prompt', { sessionId, text: 'plan this', wait: true, waitTimeoutMs: 5000 });

    const res = unwrapMessages(await callTool(baseUrl, 'get_recent_messages', { sessionId }));
    assert.equal(res.messages.length, 2, 'a path-only plan message still bonds its trailing prose');
    assert.equal(res.messages[0].planPath, planFile, 'the path is the deliverable even when the read failed');
    assert.equal(res.messages[0].hasPlan, true);
    assert.equal(res.messages[0].text, `--- plan · saved to ${planFile} ---`,
      'header alone — no content to follow it');
  } finally { await cleanup(); }
});

test('get_recent_messages: an inline plan written the same turn also carries the path', async () => {
  const { planFile, cleanup } = await seedPlanFile('# Plan\n- Make X\n');
  try {
    const sessionId = await spawnWithScenario(SCENARIO_PLAN_FILE_INLINE, 'a');
    await callTool(baseUrl, 'send_prompt', { sessionId, text: 'plan this', wait: true, waitTimeoutMs: 5000 });

    const res = unwrapMessages(await callTool(baseUrl, 'get_recent_messages', { sessionId }));
    assert.equal(res.messages[0].planPath, planFile, 'same-turn write binds the file to this plan');
    assert.equal(res.messages[0].text, `--- plan · saved to ${planFile} ---\nStep 1\nStep 2`,
      'the body keeps the model\'s inline text, not the file\'s contents');
  } finally { await cleanup(); }
});

test('get_recent_messages: an inline plan in a later turn does not inherit the earlier turn\'s path', async () => {
  const { cleanup } = await seedPlanFile('# Plan\n- Make X\n');
  try {
    const sessionId = await spawnWithScenario(SCENARIO_PLAN_FILE_LATER_TURN, 'a');
    await callTool(baseUrl, 'send_prompt', { sessionId, text: 'plan this', wait: true, waitTimeoutMs: 5000 });
    await callTool(baseUrl, 'send_prompt', { sessionId, text: 'revise it', wait: true, waitTimeoutMs: 5000 });

    // Turn 2's ExitPlanMode supplied its own text and wrote no file. The
    // remembered path is from turn 1 — nothing ties it to this plan, and
    // ~/.claude/plans/ accumulates unrelated runs, so attaching it would
    // silently point a fresh implementer at another task's plan.
    const res = unwrapMessages(await callTool(baseUrl, 'get_recent_messages', { sessionId }));
    assert.equal(res.messages.length, 2);
    assert.ok(!Object.hasOwn(res.messages[0], 'planPath'), 'no path attaches across the turn boundary');
    assert.equal(res.messages[0].hasPlan, true);
    assert.equal(res.messages[0].text, '--- plan ---\nStep 1\nStep 2',
      'byte-identical to the no-plan-file body');
  } finally { await cleanup(); }
});
