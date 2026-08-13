// Read-only retrieval for a RETIRED session: get_recent_messages and
// get_transcript resolve through getInstOrDisk (live-instance → disk-location →
// soft refusal), so a killed temp worker's output stays readable from the
// transcript _archiveTempSession retained. Every other worker-addressing tool
// stays strict-live.
//
// The fake CLI writes no jsonl, so each fixture seeds the transcript the CLI
// would have written (tests/helpers.mjs seedSessionJsonl) at the live worker's
// own sessionId BEFORE killing it — the file the retired read then serves.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { promises as fs } from 'node:fs';
import { bootServer, api, waitFor, instForSession, seedSessionJsonl } from './helpers.mjs';
import { orchStoreRoot } from '../src/projects.ts';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const SCENARIO_WS = path.join(__dirname, 'fixtures', 'scenario-ws.json');

let nextRpcId = 1;
async function callTool(baseUrl, name, args, { caller } = {}) {
  const url = baseUrl + '/mcp' + (caller ? `?caller=${encodeURIComponent(caller)}` : '');
  const res = await fetch(url, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ jsonrpc: '2.0', id: nextRpcId++, method: 'tools/call', params: { name, arguments: args } }),
  });
  const body = await res.json();
  assert.ok(body?.result, `tools/call ${name} returned no result; body=${JSON.stringify(body)}`);
  return body.result;
}
function unwrap(result) {
  assert.ok(Array.isArray(result.content), 'tool result has content[]');
  return JSON.parse(result.content[0].text);
}
function unwrapMsgs(result) {
  const meta = JSON.parse(result.content[0].text);
  const bodies = result.content.slice(1).map(c => c.text);
  return { meta, bodies, messages: meta.messages.map((m, i) => ({ ...m, text: bodies[i] ?? '' })) };
}

// Spawn a TEMP worker, seed the transcript the CLI would have persisted for it,
// then kill it and wait for the byId drop. What comes back is a sessionId with
// no instance anywhere in memory and a jsonl still on disk — the retired state
// this whole card is about.
async function retiredTempWorker(ctx, projectName, lines) {
  await api(ctx.baseUrl, 'POST', '/api/projects', { name: projectName });
  const spawn = unwrap(await callTool(ctx.baseUrl, 'spawn_instance', {
    project: projectName, mode: 'bypassPermissions', temp: true,
  }));
  const sid = spawn.sessionId;
  await waitFor(() => instForSession(ctx.instances, sid)?.status === 'idle');
  await callTool(ctx.baseUrl, 'send_prompt', { sessionId: sid, text: 'go', wait: true, waitTimeoutMs: 5000 });

  // Seed at the BACKING id — the id that actually names a transcript on disk;
  // `sid` is the public handle a conductor addresses it by.
  const projectPath = path.join(ctx.projectsRoot, projectName);
  await seedSessionJsonl(ctx.claudeProjectsRoot, projectPath, instForSession(ctx.instances, sid).backingSessionId, lines);

  const killed = unwrap(await callTool(ctx.baseUrl, 'kill_instance', { sessionId: sid }));
  assert.notEqual(killed.ok, false, `kill_instance refused: ${JSON.stringify(killed)}`);
  await waitFor(() => ctx.instances.idsForSession(sid).length === 0);
  return sid;
}

const ONE_TURN = [
  { type: 'user', uuid: 'u0', message: { role: 'user', content: 'do the work' } },
  { type: 'assistant', uuid: 'a0', message: { id: 'm_done', role: 'assistant', content: [{ type: 'text', text: 'the work is done' }] } },
];

// Turn A ends with a plan; turn B is its OWN plan message followed by TWO
// pure-prose messages. A default get_recent_messages must bond back across
// both prose messages to turn B's plan.
const TWO_PLANNED_TURNS = [
  { type: 'user', uuid: 'uA', message: { role: 'user', content: 'plan A' } },
  { type: 'assistant', uuid: 'aA0', message: { id: 'm_a_prose', role: 'assistant', content: [{ type: 'text', text: 'thinking about A' }] } },
  { type: 'assistant', uuid: 'aA1', message: { id: 'm_a_plan', role: 'assistant', content: [
    { type: 'tool_use', id: 'tu_a', name: 'ExitPlanMode', input: { plan: 'PLAN-A-BODY' } },
  ] } },
  { type: 'user', uuid: 'uB', message: { role: 'user', content: 'plan B' } },
  { type: 'assistant', uuid: 'aB0', message: { id: 'm_b_plan', role: 'assistant', content: [
    { type: 'tool_use', id: 'tu_b', name: 'ExitPlanMode', input: { plan: 'PLAN-B-BODY' } },
  ] } },
  { type: 'assistant', uuid: 'aB1', message: { id: 'm_b_p1', role: 'assistant', content: [{ type: 'text', text: 'prose one' }] } },
  { type: 'assistant', uuid: 'aB2', message: { id: 'm_b_p2', role: 'assistant', content: [{ type: 'text', text: 'prose two' }] } },
];

// The other direction: turn A ends with a plan and turn B carries NONE, so the
// walk-back must stop at the turn boundary and return the last message alone.
// Without disk-side boundaries the walk runs straight on into turn A and hands
// over a stale plan — which is precisely the failure this fixture catches,
// since the bonded fixture above breaks at turn B's own plan before it could.
const PLAN_THEN_PLAINTURN = [
  { type: 'user', uuid: 'uA', message: { role: 'user', content: 'plan A' } },
  { type: 'assistant', uuid: 'aA0', message: { id: 'm_a_prose', role: 'assistant', content: [{ type: 'text', text: 'thinking about A' }] } },
  { type: 'assistant', uuid: 'aA1', message: { id: 'm_a_plan', role: 'assistant', content: [
    { type: 'tool_use', id: 'tu_a', name: 'ExitPlanMode', input: { plan: 'PLAN-A-BODY' } },
  ] } },
  { type: 'user', uuid: 'uB', message: { role: 'user', content: 'now just talk' } },
  { type: 'assistant', uuid: 'aB1', message: { id: 'm_b_p1', role: 'assistant', content: [{ type: 'text', text: 'prose one' }] } },
  { type: 'assistant', uuid: 'aB2', message: { id: 'm_b_p2', role: 'assistant', content: [{ type: 'text', text: 'prose two' }] } },
];

// 1 — the core case: a killed temp worker's messages come back from disk.
test('get_recent_messages: a retired temp worker is served from disk, not refused', async () => {
  const ctx = await bootServer({ scenarioPath: SCENARIO_WS });
  try {
    const sid = await retiredTempWorker(ctx, 'retired', ONE_TURN);

    const res = unwrapMsgs(await callTool(ctx.baseUrl, 'get_recent_messages', { sessionId: sid }));
    assert.equal(res.meta.ok, undefined, `expected a result, got a refusal: ${JSON.stringify(res.meta)}`);
    assert.equal(res.meta.source, 'disk', 'served from the transcript, not a ring');
    assert.equal(res.messages.length, 1);
    assert.match(res.messages[0].text, /the work is done/);
    // Nothing is retained in memory — proof this did not come from a ring.
    assert.equal(res.meta.retained.lastSeq, -1);
    assert.equal(res.meta.retained.trimmed, false);
    assert.equal(res.meta.retained.firstSeq, 0);
  } finally { await ctx.close(); }
});

// 2 — acceptance item 2. The CLI never persists turn_end, so bonding on disk
// runs off outer user_echo boundaries (diskTurnIndex).
test('get_recent_messages: disk-side bonding surfaces the retired planner\'s plan body, scoped to its own turn', async () => {
  const ctx = await bootServer({ scenarioPath: SCENARIO_WS });
  try {
    const sid = await retiredTempWorker(ctx, 'retiredplan', TWO_PLANNED_TURNS);

    const res = unwrapMsgs(await callTool(ctx.baseUrl, 'get_recent_messages', { sessionId: sid }));
    assert.equal(res.meta.source, 'disk');
    // Plan + both trailing prose messages: without a boundary index the walk
    // would run on into turn A (4 messages); without any turn index at all it
    // would collapse to the last prose message alone (1).
    assert.equal(res.meta.messages.length, 3,
      `expected plan + 2 prose, got ${JSON.stringify(res.meta.messages.map(m => m.msgId))}`);
    assert.equal(res.meta.messages[0].hasPlan, true);
    assert.equal(res.meta.messages[0].msgId, 'm_b_plan');
    const all = res.bodies.join('\n');
    assert.match(all, /PLAN-B-BODY/, 'this turn\'s plan body is bonded in');
    assert.doesNotMatch(all, /PLAN-A-BODY/, 'the previous turn\'s plan is never pulled in');
    assert.match(all, /prose one/);
    assert.match(all, /prose two/);

    // Same walk, opposite direction: this turn carries no plan of its own, so
    // the boundary must stop the walk instead of reaching back into turn A.
    const plainSid = await retiredTempWorker(ctx, 'retiredplain', PLAN_THEN_PLAINTURN);
    const plain = unwrapMsgs(await callTool(ctx.baseUrl, 'get_recent_messages', { sessionId: plainSid }));
    assert.equal(plain.meta.source, 'disk');
    assert.equal(plain.meta.messages.length, 1,
      `a plan-less turn bonds nothing, got ${JSON.stringify(plain.meta.messages.map(m => m.msgId))}`);
    assert.equal(plain.meta.messages[0].msgId, 'm_b_p2');
    assert.doesNotMatch(plain.bodies.join('\n'), /PLAN-A-BODY/,
      'the previous turn\'s plan is never pulled across the turn boundary');
  } finally { await ctx.close(); }
});

// 3 — the other read-only call site.
test('get_transcript: a retired temp worker\'s events page from disk', async () => {
  const ctx = await bootServer({ scenarioPath: SCENARIO_WS });
  try {
    const sid = await retiredTempWorker(ctx, 'retiredtx', TWO_PLANNED_TURNS);

    const page = unwrap(await callTool(ctx.baseUrl, 'get_transcript', { sessionId: sid, fromSeq: 0, limit: 50 }));
    assert.equal(page.source, 'disk');
    assert.equal(page.status, 'exited', 'a session with no process is exited, not an invented status');
    assert.ok(page.events.length > 0, 'events came back');
    assert.equal(page.trimmedBefore, 0, 'nothing was evicted — there is no ring');
    // fromSeq:0 is inclusive and reaches the very first replayed event.
    assert.equal(page.events[0]._seq, 0);
    assert.equal(page.events[0].kind, 'user_echo');
    assert.equal(page.events[0].text, 'plan A');
    for (let i = 1; i < page.events.length; i++) {
      assert.ok(page.events[i]._seq > page.events[i - 1]._seq, 'oldest-first, strictly increasing');
    }
    // Forward paging terminates instead of re-serving the boundary event.
    const rePoll = unwrap(await callTool(ctx.baseUrl, 'get_transcript', { sessionId: sid, fromSeq: page.nextFrom, limit: 50 }));
    assert.equal(rePoll.events.length, 0, 'a caught-up re-poll returns nothing');
    assert.equal(rePoll.nextFrom, page.nextFrom, 'and the cursor does not move backwards');
  } finally { await ctx.close(); }
});

// 4 — the relaxation is not "always succeed".
test('an id nothing on disk answers to still refuses SESSION_UNKNOWN on both read tools', async () => {
  const ctx = await bootServer({ scenarioPath: SCENARIO_WS });
  try {
    await api(ctx.baseUrl, 'POST', '/api/projects', { name: 'p' });
    const bogus = '00000000-dead-dead-dead-000000000000';

    const recent = unwrap(await callTool(ctx.baseUrl, 'get_recent_messages', { sessionId: bogus }));
    assert.equal(recent.ok, false);
    assert.equal(recent.code, 'SESSION_UNKNOWN');

    const tx = unwrap(await callTool(ctx.baseUrl, 'get_transcript', { sessionId: bogus }));
    assert.equal(tx.ok, false);
    assert.equal(tx.code, 'SESSION_UNKNOWN');
  } finally { await ctx.close(); }
});

// 5 — acceptance item 3. A transcript under a directory no registered project
// or worktree owns is retired-and-unreachable, NOT never-existed.
test('an orphaned transcript refuses SESSION_NOT_LIVE naming its unregistered owner, distinctly from SESSION_UNKNOWN', async () => {
  const ctx = await bootServer({ scenarioPath: SCENARIO_WS });
  try {
    await api(ctx.baseUrl, 'POST', '/api/projects', { name: 'p' });
    const orphanSid = '11111111-2222-3333-4444-555555555555';
    const bogusSid = '99999999-8888-7777-6666-555555555555';
    // A cwd no project or worktree is registered at — findSessionLocation
    // cannot see it, only the orphan scan can.
    await seedSessionJsonl(ctx.claudeProjectsRoot, path.join(ctx.tmpHome, 'never-registered'), orphanSid);

    const orphan = unwrap(await callTool(ctx.baseUrl, 'get_recent_messages', { sessionId: orphanSid }));
    assert.equal(orphan.ok, false);
    assert.equal(orphan.code, 'SESSION_NOT_LIVE');
    assert.match(orphan.reason, /no registered project or worktree owns/);

    const unknown = unwrap(await callTool(ctx.baseUrl, 'get_recent_messages', { sessionId: bogusSid }));
    assert.equal(unknown.code, 'SESSION_UNKNOWN');
    assert.notEqual(orphan.code, unknown.code,
      'retired-but-unreachable and never-existed are distinguishable by code alone');
  } finally { await ctx.close(); }
});

// 6 — acceptance item 1's second half: the relaxation reached exactly two tools.
test('the worker-addressing tools still refuse a retired worker SESSION_NOT_LIVE', async () => {
  const ctx = await bootServer({ scenarioPath: SCENARIO_WS });
  try {
    const sid = await retiredTempWorker(ctx, 'retiredaddr', ONE_TURN);

    const cases = [
      ['send_prompt', { sessionId: sid, text: 'go' }],
      ['set_mode', { sessionId: sid, mode: 'bypassPermissions' }],
      ['interrupt_turn', { sessionId: sid }],
      ['sync_worktree', { sessionId: sid }],
      ['kill_instance', { sessionId: sid }],
    ];
    for (const [name, args] of cases) {
      const res = unwrap(await callTool(ctx.baseUrl, name, args));
      assert.equal(res.ok, false, `${name} must still refuse a retired worker`);
      assert.equal(res.code, 'SESSION_NOT_LIVE', `${name} refusal code`);
    }
    // ...while the same sessionId reads fine, in the same test.
    const res = unwrapMsgs(await callTool(ctx.baseUrl, 'get_recent_messages', { sessionId: sid }));
    assert.equal(res.meta.source, 'disk');
  } finally { await ctx.close(); }
});

// 7 — acceptance item 6. The playbook gate runs at the MCP boundary, BEFORE the
// handler, and decideTargeted resolves its subject from the ledger projection,
// which is liveness-agnostic. A relaxed resolver must not become a policy
// bypass: a stage that denies get_recent_messages still denies it for a worker
// whose subprocess is gone.
test('a stage that denies get_recent_messages still denies it for a retired worker, before any disk read', async () => {
  const ctx = await bootServer({ scenarioPath: SCENARIO_WS });
  try {
    await api(ctx.baseUrl, 'POST', '/api/projects', { name: 'p' });
    await api(ctx.baseUrl, 'POST', '/api/projects/.conduct/ensure');
    const pbDir = path.join(orchStoreRoot(), 'playbooks');
    await fs.mkdir(pbDir, { recursive: true });
    await fs.writeFile(path.join(pbDir, 'noread.json'), JSON.stringify({
      id: 'noread', name: 'No read', description: 'denies the read tool', entryStages: ['a'],
      // spawn_instance must be named explicitly for an entry stage to be spawnable.
      stages: { a: { tools: { spawn_instance: 'allow', get_recent_messages: 'deny' } } },
      transitions: [],
    }));

    const conductor = await api(ctx.baseUrl, 'POST', '/api/instances', {
      project: '.conduct', mode: 'bypassPermissions', temp: true, playbookEnforcement: 'enforce',
    });
    assert.equal(conductor.status, 201, `conductor spawn failed: ${JSON.stringify(conductor.body)}`);
    const conductorId = conductor.body.id;
    await waitFor(() => ctx.instances.get(conductorId)?.status === 'idle');

    const worker = unwrap(await callTool(ctx.baseUrl, 'spawn_instance',
      { project: 'p', mode: 'bypassPermissions', playbook: 'noread', stage: 'a' }, { caller: conductorId }));
    assert.ok(worker.sessionId, `worker spawn refused: ${JSON.stringify(worker)}`);
    const sid = worker.sessionId;
    await waitFor(() => instForSession(ctx.instances, sid)?.status === 'idle');

    // Retire it: seed the transcript, then kill the subprocess directly so the
    // ledger subject survives while the process does not.
    await seedSessionJsonl(ctx.claudeProjectsRoot, path.join(ctx.projectsRoot, 'p'),
      instForSession(ctx.instances, sid).backingSessionId, ONE_TURN);
    await instForSession(ctx.instances, sid).kill({ graceMs: 200 });
    await waitFor(() => !instForSession(ctx.instances, sid)?.proc);

    const denied = unwrap(await callTool(ctx.baseUrl, 'get_recent_messages', { sessionId: sid }, { caller: conductorId }));
    assert.equal(denied.ok, false);
    assert.equal(denied.code, 'TOOL_DENIED_IN_STAGE', 'stage policy wins over the relaxed resolver');
    assert.equal(denied.meta, undefined, 'no disk read happened');

    // Non-vacuity: the very same call, ungoverned, DOES serve the transcript —
    // so the refusal above is the gate, not a failed read.
    const served = unwrapMsgs(await callTool(ctx.baseUrl, 'get_recent_messages', { sessionId: sid }));
    assert.equal(served.meta.source, 'disk');
    assert.match(served.messages[0].text, /the work is done/);
  } finally { await ctx.close(); }
});
