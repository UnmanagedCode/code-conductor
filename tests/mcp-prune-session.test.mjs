// Integration coverage of the prune_session MCP tool — the conductor-facing face
// of Instance.pruneSession (src/mcp/handlers.ts → pruneSession).
//
// What is pinned here and nowhere else: the tool addresses a worker by its PUBLIC
// sessionId and hands the SAME id back (a prune rotates only the backing id), the
// payload never leaks a backing id, keepLatestTurns reaches the transform, and
// every guard state is a SOFT refusal with a code rather than an isError.
// The transform's own arithmetic is pinned in tests/prune-transform.test.mjs.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { promises as fs } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { bootServer, api, waitFor, instForSession } from './helpers.mjs';
import { encodeCwd } from '../src/projects.ts';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const SCENARIO = path.join(__dirname, 'fixtures', 'scenario-resume.json');
// scenario-instance's second turn hangs mid-stream (no turn_end) — how the other
// lifecycle tests catch an instance in `turn` status.
const SCENARIO_HANG = path.join(__dirname, 'fixtures', 'scenario-instance.json');

const BIG_TEXT = 'y'.repeat(4000);
const bigText = BIG_TEXT;

let nextRpcId = 1;
let mgr = null;
// `?caller=` carries the stable INSTANCE id, so translate a caller sessionId to
// its instanceId here (same shim as tests/renew-session.test.mjs).
async function rpc(baseUrl, method, params, { caller } = {}) {
  const handle = caller ? (instForSession(mgr, caller)?.id ?? caller) : null;
  const url = baseUrl + '/mcp' + (handle ? `?caller=${encodeURIComponent(handle)}` : '');
  const res = await fetch(url, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ jsonrpc: '2.0', id: nextRpcId++, method, params }),
  });
  return { status: res.status, body: await res.json() };
}
// The raw tools/call result — `isError` is what separates a soft refusal from a
// thrown one, so the refusal tests need it unparsed.
async function rawCall(baseUrl, name, args, opts) {
  const { body } = await rpc(baseUrl, 'tools/call', { name, arguments: args }, opts);
  assert.ok(body?.result, `tools/call ${name} returned no result; body=${JSON.stringify(body)}`);
  return body.result;
}
async function callTool(baseUrl, name, args, opts) {
  const r = await rawCall(baseUrl, name, args, opts);
  assert.equal(r.isError ?? false, false, `tools/call ${name} errored: ${r.content?.[0]?.text}`);
  return JSON.parse(r.content[0].text);
}

// Two turns, each carrying a bulky tool_use + tool_result, so a default prune
// (newest turn kept) and a full one are distinguishable on disk.
function sessionLines(bigText = BIG_TEXT) {
  return [
    { type: 'user', uuid: 'u1', message: { role: 'user', content: 'first' } },
    { type: 'assistant', uuid: 'a1', message: { id: 'm1', role: 'assistant', content: [
      { type: 'tool_use', id: 't1', name: 'Read', input: { file_path: '/tmp/x.ts' } },
    ] } },
    { type: 'user', uuid: 'r1', toolUseResult: { type: 'text' },
      message: { role: 'user', content: [{ type: 'tool_result', tool_use_id: 't1', content: bigText }] } },
    { type: 'assistant', uuid: 'a2', message: { id: 'm2', role: 'assistant', content: [
      { type: 'text', text: 'first reply' },
    ] } },
    { type: 'user', uuid: 'u2', message: { role: 'user', content: 'second' } },
    { type: 'assistant', uuid: 'a3', message: { id: 'm3', role: 'assistant', content: [
      { type: 'tool_use', id: 't2', name: 'Bash', input: { command: `echo ${bigText}` } },
    ] } },
    { type: 'user', uuid: 'r2', toolUseResult: 'ok',
      message: { role: 'user', content: [{ type: 'tool_result', tool_use_id: 't2', content: bigText }] } },
    { type: 'assistant', uuid: 'a4', message: { id: 'm4', role: 'assistant', content: [
      { type: 'text', text: 'second reply' },
    ] } },
  ];
}

async function seedSession({ ctx, projectName, sid, lines = sessionLines() }) {
  await api(ctx.baseUrl, 'POST', '/api/projects', { name: projectName });
  const projectPath = path.join(ctx.projectsRoot, projectName);
  const sessionDir = path.join(ctx.claudeProjectsRoot, encodeCwd(projectPath));
  await fs.mkdir(sessionDir, { recursive: true });
  await fs.writeFile(path.join(sessionDir, `${sid}.jsonl`), lines.map(l => JSON.stringify(l)).join('\n') + '\n');
  return { sessionDir };
}

// Spawn a worker resumed from a seeded transcript and wait for it to settle.
async function liveWorker(ctx, { projectName, sid, lines }) {
  const { sessionDir } = await seedSession({ ctx, projectName, sid, lines });
  const r = await api(ctx.baseUrl, 'POST', '/api/instances', {
    project: projectName, mode: 'bypassPermissions', resume: sid,
  });
  const id = r.body.id;
  await waitFor(() => ctx.instances.get(id).status === 'idle');
  return { id, sessionDir, inst: ctx.instances.get(id) };
}

const byUuid = async (sessionDir, sid) => Object.fromEntries(
  (await fs.readFile(path.join(sessionDir, `${sid}.jsonl`), 'utf8'))
    .split('\n').filter(Boolean).map(l => JSON.parse(l)).map(o => [o.uuid, o]));

test('prune_session keeps the newest turn by default and hands back the SAME sessionId', async () => {
  const ctx = await bootServer({ scenarioPath: SCENARIO });
  mgr = ctx.instances;
  try {
    const sid = 'bbbbbbb1-2222-3333-4444-555555555555';
    const { id, sessionDir, inst } = await liveWorker(ctx, { projectName: 'mp1', sid });

    const res = await callTool(ctx.baseUrl, 'prune_session', { sessionId: sid });
    assert.equal(res.ok, true, JSON.stringify(res));
    // The public id is pinned across the rotation — the whole reason the tool can
    // take a sessionId in and need no id migration on the way out.
    assert.equal(res.sessionId, sid);
    assert.equal(res.keptTurns, 1, 'keepLatestTurns defaults to 1');
    assert.equal(res.prunedTurns, 1);
    assert.ok(res.saved.toolOutputs > 900, `the old Read output was stubbed: ${JSON.stringify(res.saved)}`);

    // No BACKING id may reach a conductor — a pass-through spread of the instance
    // method's return would leak both.
    assert.ok(!('newSessionId' in res), `backing id leaked: ${JSON.stringify(res)}`);
    assert.ok(!('oldSessionId' in res), `backing id leaked: ${JSON.stringify(res)}`);

    // The worker really did come back live and IDLE with nothing seeded…
    assert.equal(ctx.instances.get(id), inst, 'same instance, new backing id');
    await waitFor(() => inst.status === 'idle');
    assert.ok(inst.proc, 'the worker is respawned, not left dead');
    // …and the newest turn was left verbatim on the pruned transcript.
    const out = await byUuid(sessionDir, inst.backingSessionId);
    assert.equal(out.a3.message.content[0].input.command, `echo ${bigText}`);
    assert.match(out.r1.message.content[0].content[0].text, /^\[pruned: /,
      'the OLD turn\'s output is stubbed');

    // …and the same sessionId still addresses it afterwards.
    const sent = await callTool(ctx.baseUrl, 'send_prompt', { sessionId: sid, text: 'still here?' });
    assert.equal(sent.sessionId ?? sid, sid);
    await waitFor(() => inst.status === 'idle');
  } finally { await ctx.close(); }
});

test('prune_session reports the real pre-prune baseline and a calibrated saving', async () => {
  // Every assistant message carries usage, so the session has enough measured
  // history for a live calibration factor, and the newest one is the ctx
  // reading the resumed worker latches.
  const ctx = await bootServer({ scenarioPath: SCENARIO });
  mgr = ctx.instances;
  try {
    const sid = 'bbbbbbb3-2222-3333-4444-555555555555';
    const lines = sessionLines('y'.repeat(6000));
    const promptByMessage = { m1: 10000, m2: 17000, m3: 17100, m4: 22100 };
    for (const o of lines) {
      if (o.type !== 'assistant') continue;
      o.message.model = 'claude-opus-5';
      o.message.usage = { input_tokens: 7, cache_read_input_tokens: promptByMessage[o.message.id] - 7,
        cache_creation_input_tokens: 0, output_tokens: 30 };
    }
    const { id } = await liveWorker(ctx, { projectName: 'mp3', sid, lines });
    const analysis = (await api(ctx.baseUrl, 'GET', `/api/instances/${id}/prune/analysis`)).body;
    const { factor } = analysis.calibration;
    assert.notEqual(factor, 1, 'the seeded usage must make the factor live');

    const res = await callTool(ctx.baseUrl, 'prune_session', { sessionId: sid });
    assert.equal(res.ok, true, JSON.stringify(res));
    assert.equal(res.contextTokensBefore, promptByMessage.m4, 'the ctx reading taken before the prune wiped it');
    // keepLatestTurns defaults to 1: turn 0 is the pruned prefix; thinking is global.
    const prefix = analysis.turns.slice(0, res.prunedTurns);
    assert.deepEqual(res.saved, {
      thinking: Math.round(analysis.turns.reduce((a, t) => a + t.thinking, 0) * factor),
      toolInputs: Math.round(prefix.reduce((a, t) => a + t.toolInputTruncatable, 0) * factor),
      toolOutputs: Math.round(prefix.reduce((a, t) => a + t.toolOutput, 0) * factor),
    });
  } finally { await ctx.close(); }
});

test('prune_session({keepLatestTurns: 0}) prunes every turn, newest included', async () => {
  const ctx = await bootServer({ scenarioPath: SCENARIO });
  mgr = ctx.instances;
  try {
    const sid = 'bbbbbbb2-2222-3333-4444-555555555555';
    const { sessionDir, inst } = await liveWorker(ctx, { projectName: 'mp2', sid });

    const res = await callTool(ctx.baseUrl, 'prune_session',
      { sessionId: sid, keepLatestTurns: 0, inputMode: 'minimal' });
    assert.equal(res.ok, true, JSON.stringify(res));
    assert.equal(res.prunedTurns, 2, 'both turns fell inside the cut');
    assert.equal(res.keptTurns, 0);

    await waitFor(() => inst.status === 'idle');
    const out = await byUuid(sessionDir, inst.backingSessionId);
    // The newest turn's payloads — unreachable at any cut the old cap allowed.
    assert.match(out.a3.message.content[0].input.command, /^\[pruned: /,
      'minimal mode replaces the newest turn\'s tool input with a size marker');
    assert.match(out.r2.message.content[0].content, /^\[pruned: /);
    // The prose either side of it is untouched.
    assert.equal(out.a4.message.content[0].text, 'second reply');
  } finally { await ctx.close(); }
});

test('prune_session refuses softly, with a code, in every guarded state', async () => {
  const ctx = await bootServer({ scenarioPath: SCENARIO });
  mgr = ctx.instances;
  try {
    const sid = 'bbbbbbb3-2222-3333-4444-555555555555';
    const { inst } = await liveWorker(ctx, { projectName: 'mp3', sid });

    // Every one of these is a REFUSAL, not an error: a conductor must be able to
    // read the code and route, and rawCall asserts isError stays false.
    const unknown = await callTool(ctx.baseUrl, 'prune_session',
      { sessionId: 'ffffffff-0000-4000-8000-000000000000' });
    assert.equal(unknown.ok, false);
    assert.equal(unknown.code, 'SESSION_UNKNOWN');

    // Self-target: pruning yourself would kill your own process mid-call, so it
    // routes to renew_session rather than falling through to a "busy" report.
    const self = await callTool(ctx.baseUrl, 'prune_session', { sessionId: sid }, { caller: sid });
    assert.equal(self.ok, false, JSON.stringify(self));
    assert.equal(self.code, 'INVALID_PRUNE_TARGET');
    assert.match(self.reason, /renew_session/);

    // Not live: the transcript is known but no subprocess is attached.
    await inst.kill({ graceMs: 200 });
    await waitFor(() => !ctx.instances.get(inst.id)?.proc);
    const dead = await callTool(ctx.baseUrl, 'prune_session', { sessionId: sid });
    assert.equal(dead.ok, false);
    assert.equal(dead.code, 'SESSION_NOT_LIVE');

    // Mid-turn: a prune kills the subprocess under a running turn. The instance
    // method throws 409 here; the handler must pre-check so this is soft.
    const prevScenario = process.env.FAKE_CLAUDE_SCENARIO;
    process.env.FAKE_CLAUDE_SCENARIO = SCENARIO_HANG;
    try {
      const hang = await api(ctx.baseUrl, 'POST', '/api/instances',
        { project: 'mp3', mode: 'bypassPermissions' });
      const hangInst = ctx.instances.get(hang.body.id);
      await waitFor(() => hangInst.status === 'idle' && hangInst.sessionId);
      await hangInst.prompt('first');
      await waitFor(() => hangInst.status === 'idle');
      await hangInst.prompt('hang');
      await waitFor(() => hangInst.status === 'turn');
      const busy = await callTool(ctx.baseUrl, 'prune_session', { sessionId: hangInst.sessionId });
      assert.equal(busy.ok, false, JSON.stringify(busy));
      assert.equal(busy.code, 'SESSION_BUSY');
      assert.match(busy.reason, /interrupt_turn/);
    } finally {
      if (prevScenario === undefined) delete process.env.FAKE_CLAUDE_SCENARIO;
      else process.env.FAKE_CLAUDE_SCENARIO = prevScenario;
    }
  } finally { await ctx.close(); }
});

test('prune_session refuses SESSION_ROTATING while a rotation holds the worker', async () => {
  // The renew↔prune interlock, prune-side and over MCP. The reverse direction is
  // covered in tests/renew-session.test.mjs.
  const ctx = await bootServer({ scenarioPath: SCENARIO });
  mgr = ctx.instances;
  try {
    const sid = 'bbbbbbb4-2222-3333-4444-555555555555';
    const { inst } = await liveWorker(ctx, { projectName: 'mp4', sid });

    inst.beginRotation('renew');
    try {
      const res = await callTool(ctx.baseUrl, 'prune_session', { sessionId: sid });
      assert.equal(res.ok, false, JSON.stringify(res));
      assert.equal(res.code, 'SESSION_ROTATING');
      assert.equal(res.sessionId, sid, 'and the refusal names the public id');
      // Nothing was torn down: a refusal is a refusal, not a half-done prune.
      assert.ok(inst.proc, 'the subprocess must survive a refused prune');
    } finally { inst.endRotation({ ok: false, comesUpIdle: true }); }
  } finally { await ctx.close(); }
});

test('prune_session rejects bad arguments without touching the subprocess', async () => {
  // Bad arguments are the one class of input that is a hard isError rather than a
  // soft refusal. `inst.proc === procBefore` is the load-bearing assertion, and it
  // pins different things for the two arguments:
  //
  //   keepLatestTurns — genuinely SCHEMA-gated (`minimum: 0`, `type: 'integer'`).
  //     Drop the constraint and -1 reaches the handler, which kills the
  //     subprocess before the post-kill transform rejects it — so proc-untouched
  //     is what catches a schema that stopped declaring it.
  //   inputMode — rejected pre-kill, but NOT provably by the schema. It is
  //     deliberately validated three times (schema `enum`, Instance.pruneSession
  //     pre-kill, pruneSessionToNewId), all three of which produce the same
  //     isError and leave the proc alone, so this test cannot tell which layer
  //     fired. It kills only the removal of ALL of them.
  const ctx = await bootServer({ scenarioPath: SCENARIO });
  mgr = ctx.instances;
  try {
    const sid = 'bbbbbbb5-2222-3333-4444-555555555555';
    const { inst } = await liveWorker(ctx, { projectName: 'mp5', sid });
    const procBefore = inst.proc;

    for (const [args, pattern] of [
      [{ sessionId: sid, inputMode: 'bogus' }, /inputMode/],
      [{ sessionId: sid, keepLatestTurns: -1 }, /keepLatestTurns/],
      [{ sessionId: sid, keepLatestTurns: 1.5 }, /keepLatestTurns/],
    ]) {
      const r = await rawCall(ctx.baseUrl, 'prune_session', args);
      assert.equal(r.isError, true, `expected a validation error for ${JSON.stringify(args)}`);
      assert.match(r.content[0].text, pattern);
    }
    assert.equal(inst.proc, procBefore, 'a rejected request must not touch the subprocess');
  } finally { await ctx.close(); }
});
