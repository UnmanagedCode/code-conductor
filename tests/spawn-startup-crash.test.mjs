// A worker whose CLI exits on its own — at startup, before anything was sent to
// it, or mid-turn — must not vanish without a trace. Three surfaces carry the
// cause:
//   - one server-log line (console.warn) per spontaneous exit, every backend;
//   - every MCP call that addresses the dead worker answers SESSION_NOT_LIVE
//     with an `exit: {code, signal, stderrTail}` field, never SESSION_UNKNOWN,
//     and the advice depends on whether a transcript exists to resume;
//   - describe_session shows it.
// A commanded kill produces none of it, and the stderr tail belongs to one
// launch and is bounded.
//
// The startup crash uses tests/controllableLauncher.mjs's `crashNext` arm. Every
// other worker runs the in-process fake CLI, crashed mid-flight by writing its
// stderr line and SIGKILLing its child directly — which bypasses Instance.kill,
// so the exit is not a commanded one.

import { test, before, after, beforeEach, afterEach } from 'node:test';
import assert from 'node:assert/strict';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { bootServer, api, waitFor, freshProjectsRoot, rmrf, instForSession, seedSessionJsonl, settle } from './helpers.mjs';
import { InProcessClaudeLauncher } from './inProcessLauncher.mjs';
import { ControllableLauncher } from './controllableLauncher.mjs';
import { localPlace } from '../src/projects.ts';
import * as instancesModule from '../src/instances.ts';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const SCENARIO_WS = path.join(__dirname, 'fixtures', 'scenario-ws.json');
// A turn that never ends on its own — the worker is mid-turn when it dies.
const SCENARIO_OPEN = path.join(__dirname, 'fixtures', 'scenario-open-turn.json');

// The in-process fake CLI for every launch, except one armed with crashNext / failNext.
const controllable = new ControllableLauncher();
const inProcess = new InProcessClaudeLauncher();
const launcher = {
  inProcess: true,
  launch: (opts) => (controllable.armed ? controllable.launch(opts) : inProcess.launch(opts)),
};

let ctx, baseUrl, instances, home, projectsRoot;
before(async () => {
  ctx = await bootServer({ scenarioPath: SCENARIO_WS, claudeLauncher: launcher });
  ({ baseUrl, instances } = ctx);
});
after(async () => { await ctx.close(); });
beforeEach(async () => { ({ home, projectsRoot } = await freshProjectsRoot()); });
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
  return body.result;
}
const text = (result) => result.content[0].text;
const json = async (name, args) => JSON.parse(text(await callTool(name, args)));

// Every console.warn line written while `fn` runs.
async function capturingWarn(fn) {
  const lines = [];
  const orig = console.warn;
  console.warn = (...a) => { lines.push(a.join(' ')); };
  try { await fn(); } finally { console.warn = orig; }
  return lines;
}
const exitLines = (lines, sid) => lines.filter(l => l.includes(sid) && l.includes('exited on its own'));

const EIO_LINE = "Error: EIO: i/o error, open '/proj/.claude/settings.json'";

// An MCP-spawned (temp) worker whose CLI exits 1 with EIO_LINE before it is sent
// anything. Returns the spawn result once the instance has left byId.
async function startupCrashedWorker(project = 'p') {
  await api(baseUrl, 'POST', '/api/projects', { name: project });
  controllable.crashNext(EIO_LINE, 1);
  const spawn = await json('spawn_instance', { project, mode: 'bypassPermissions' });
  await waitFor(() => instances.idsForSession(spawn.sessionId).length === 0);
  return spawn;
}

// A worker running the fake CLI, killed by SIGKILL straight to its child after
// its own stderr line has been read — a spontaneous exit, not a commanded one.
async function crashMidFlight(inst, stderrLines) {
  for (const l of stderrLines) inst.proc.stderr.write(l + '\n');
  const last = stderrLines.at(-1);
  await waitFor(() => inst._stderr.includes(last));
  inst.proc.kill('SIGKILL');
  await waitFor(() => !inst.proc);
}

const ONE_TURN = [
  { type: 'user', uuid: 'u0', message: { role: 'user', content: 'do the work' } },
  { type: 'assistant', uuid: 'a0', message: { id: 'm_done', role: 'assistant', content: [{ type: 'text', text: 'half the work' }] } },
];

// An MCP-spawned worker, parked mid-turn, with the transcript the CLI would have
// written seeded at its backing id.
async function midTurnWorkerWithTranscript(project = 'p') {
  await api(baseUrl, 'POST', '/api/projects', { name: project });
  const prev = process.env.FAKE_CLAUDE_SCENARIO;
  process.env.FAKE_CLAUDE_SCENARIO = SCENARIO_OPEN;
  let sid;
  try {
    sid = (await json('spawn_instance', { project, mode: 'bypassPermissions' })).sessionId;
    await waitFor(() => instForSession(instances, sid)?.status === 'idle');
  } finally { process.env.FAKE_CLAUDE_SCENARIO = prev; }
  const inst = instForSession(instances, sid);
  await seedSessionJsonl(localPlace(path.join(projectsRoot, project)), inst.backingSessionId, ONE_TURN);
  await callTool('send_prompt', { sessionId: sid, text: 'go' });
  await waitFor(() => inst.status === 'turn');
  return { sid, inst };
}

test('a startup crash: spawn_instance still succeeds, and the next send_prompt is SESSION_NOT_LIVE carrying the exit and re-spawn advice', async () => {
  const spawn = await startupCrashedWorker();
  // Today's spawn contract, unchanged: the success shape, no refusal, no cause.
  assert.equal(typeof spawn.sessionId, 'string');
  assert.equal(spawn.ok, undefined, JSON.stringify(spawn));
  assert.equal(spawn.exit, undefined);

  const r = await json('send_prompt', { sessionId: spawn.sessionId, text: 'hello?' });
  assert.equal(r.code, 'SESSION_NOT_LIVE', JSON.stringify(r));
  assert.equal(r.exit?.code, 1);
  assert.equal(r.exit?.signal, null);
  assert.match(r.exit?.stderrTail ?? '', /EIO/);
  assert.match(r.reason, /spawn a fresh worker/, 'no transcript, so nothing to resume');
  assert.doesNotMatch(r.reason, /spawn_instance\(\{resume/);
});

test('a startup crash: describe_session is SESSION_NOT_LIVE carrying the exit', async () => {
  const { sessionId } = await startupCrashedWorker();
  const r = await json('describe_session', { sessionId });
  assert.equal(r.code, 'SESSION_NOT_LIVE', JSON.stringify(r));
  assert.equal(r.exit?.code, 1);
  assert.match(r.exit?.stderrTail ?? '', /EIO/);
});

test('a startup crash writes one server-log line naming the session, the exit code and the stderr', async () => {
  let sid;
  const lines = await capturingWarn(async () => { sid = (await startupCrashedWorker()).sessionId; });
  const mine = exitLines(lines, sid);
  assert.equal(mine.length, 1, `one line, got:\n${lines.join('\n')}`);
  assert.match(mine[0], /code=1/);
  assert.match(mine[0], /EIO/);
});

test('a commanded kill_instance carries no exit cause and writes no exit log line', async () => {
  await api(baseUrl, 'POST', '/api/projects', { name: 'p' });
  const sid = (await json('spawn_instance', { project: 'p', mode: 'bypassPermissions' })).sessionId;
  const inst = instForSession(instances, sid);
  await waitFor(() => inst.status === 'idle');
  await seedSessionJsonl(localPlace(path.join(projectsRoot, 'p')), inst.backingSessionId, ONE_TURN);

  const lines = await capturingWarn(async () => {
    await json('kill_instance', { sessionId: sid });
    await waitFor(() => instances.idsForSession(sid).length === 0);
  });
  assert.deepEqual(exitLines(lines, sid), []);
  const r = await json('send_prompt', { sessionId: sid, text: 'x' });
  assert.equal(r.code, 'SESSION_NOT_LIVE', JSON.stringify(r));
  assert.equal('exit' in r, false);
});

test('a mid-turn crash with a transcript: SESSION_NOT_LIVE with the exit and resume advice; describe_session shows it; reads still serve', async () => {
  const { sid, inst } = await midTurnWorkerWithTranscript();
  await crashMidFlight(inst, ['fatal: socket hang up']);
  await waitFor(() => instances.idsForSession(sid).length === 0);

  const r = await json('send_prompt', { sessionId: sid, text: 'x' });
  assert.equal(r.code, 'SESSION_NOT_LIVE', JSON.stringify(r));
  assert.equal(r.exit?.code, null);
  assert.equal(r.exit?.signal, 'SIGKILL');
  assert.match(r.exit?.stderrTail ?? '', /socket hang up/);
  assert.match(r.reason, new RegExp(`spawn_instance\\(\\{resume:"${sid}"\\}\\)`));

  const described = text(await callTool('describe_session', { sessionId: sid }));
  assert.match(described, /retired/);
  assert.match(described, /exited code — signal SIGKILL — fatal: socket hang up/);

  const recent = await callTool('get_recent_messages', { sessionId: sid });
  assert.notEqual(JSON.parse(text(recent)).code, 'SESSION_NOT_LIVE');
  assert.ok(recent.content.some(c => c.text.includes('half the work')), 'the transcript is still served');
});

test('a successful resume clears the cause: a later commanded kill refuses with no exit', async () => {
  const { sid, inst } = await midTurnWorkerWithTranscript();
  await crashMidFlight(inst, ['fatal: socket hang up']);
  await waitFor(() => instances.idsForSession(sid).length === 0);
  assert.ok((await json('send_prompt', { sessionId: sid, text: 'x' })).exit, 'precondition: the cause is recorded');

  const resumed = await json('spawn_instance', { resume: sid });
  assert.equal(resumed.ok, undefined, JSON.stringify(resumed));
  await waitFor(() => instForSession(instances, sid)?.status === 'idle');
  await json('kill_instance', { sessionId: sid });
  await waitFor(() => !instForSession(instances, sid)?.proc);

  const r = await json('send_prompt', { sessionId: sid, text: 'x' });
  assert.equal(r.code, 'SESSION_NOT_LIVE', JSON.stringify(r));
  assert.equal('exit' in r, false);
});

// A non-temp worker stays in byId after it dies, so the same Instance is respawned.
async function restWorker(project = 'p') {
  await api(baseUrl, 'POST', '/api/projects', { name: project });
  const r = await api(baseUrl, 'POST', '/api/instances', { project, mode: 'bypassPermissions' });
  assert.equal(r.status, 201, JSON.stringify(r.body));
  const inst = instances.get(r.body.id);
  await waitFor(() => inst.status === 'idle' && inst.sessionId);
  return inst;
}

test('the stderr tail belongs to the launch that exited, not an earlier one', async () => {
  const inst = await restWorker();
  await crashMidFlight(inst, ['FIRST-LAUNCH-STDERR']);
  await instances.respawn(inst.id);
  await waitFor(() => inst.status === 'idle');
  await crashMidFlight(inst, ['SECOND-LAUNCH-STDERR']);

  const r = await json('send_prompt', { sessionId: inst.sessionId, text: 'x' });
  assert.equal(r.code, 'SESSION_NOT_LIVE', JSON.stringify(r));
  assert.match(r.exit?.stderrTail ?? '', /SECOND-LAUNCH-STDERR/);
  assert.doesNotMatch(r.exit?.stderrTail ?? '', /FIRST-LAUNCH-STDERR/);
});

test('an oversized stderr is cut to its tail, within both bounds', async () => {
  const { EXIT_STDERR_TAIL_LINES, EXIT_STDERR_TAIL_CHARS } = instancesModule;
  assert.equal(typeof EXIT_STDERR_TAIL_LINES, 'number');
  assert.equal(typeof EXIT_STDERR_TAIL_CHARS, 'number');
  const inst = await restWorker();
  const lines = Array.from({ length: EXIT_STDERR_TAIL_LINES * 4 },
    (_, i) => `line-${String(i).padStart(4, '0')} ${'x'.repeat(Math.ceil(EXIT_STDERR_TAIL_CHARS / 8))}`);
  await crashMidFlight(inst, lines);

  const tail = (await json('send_prompt', { sessionId: inst.sessionId, text: 'x' })).exit?.stderrTail ?? '';
  assert.ok(tail.length <= EXIT_STDERR_TAIL_CHARS, `${tail.length} chars`);
  assert.ok(tail.split('\n').length <= EXIT_STDERR_TAIL_LINES, `${tail.split('\n').length} lines`);
  assert.ok(tail.endsWith(lines.at(-1)), 'the last line survives');
  assert.doesNotMatch(tail, /line-0000 /, 'the head is dropped');
});

// A real child process may deliver 'exit' before its stderr has been read to EOF,
// so a cut taken at the latch can miss the very line that says why it died.
test('a stderr line delivered after the exit event is still in the tail, the refusal and the log line', async () => {
  await api(baseUrl, 'POST', '/api/projects', { name: 'p' });
  const LATE = 'FATAL: written after the exit event';
  let sid;
  const lines = await capturingWarn(async () => {
    controllable.crashNext(LATE, 1, { exitFirst: true });
    sid = (await json('spawn_instance', { project: 'p', mode: 'bypassPermissions' })).sessionId;
    // 'close' follows the late line.
    await controllable.last.closed;
    await settle();
  });
  assert.equal(exitLines(lines, sid).length, 1, lines.join('\n'));
  assert.match(exitLines(lines, sid)[0], /FATAL: written after the exit event/);
  const r = await json('send_prompt', { sessionId: sid, text: 'x' });
  assert.equal(r.code, 'SESSION_NOT_LIVE', JSON.stringify(r));
  assert.match(r.exit?.stderrTail ?? '', /FATAL: written after the exit event/);
});

// The 'error' handler marks the instance crashed BEFORE the terminal latch runs
// the exit path, so a cause keyed on that status transition would be missed.
test('a spawn that never started records its cause: SESSION_NOT_LIVE with exit and re-spawn advice', async () => {
  await api(baseUrl, 'POST', '/api/projects', { name: 'p' });
  controllable.failNext = 'spawn claude ENOENT';
  const sid = (await json('spawn_instance', { project: 'p', mode: 'bypassPermissions' })).sessionId;
  await waitFor(() => !instForSession(instances, sid)?.proc);

  const r = await json('send_prompt', { sessionId: sid, text: 'x' });
  assert.equal(r.code, 'SESSION_NOT_LIVE', JSON.stringify(r));
  assert.equal(r.exit?.code, -2);
  assert.equal(r.exit?.stderrTail, null);
  assert.match(r.reason, /spawn a fresh worker/);
});

test('the exit-cause map is capped at EXIT_CAUSE_CAP, evicting the oldest entry', () => {
  const { EXIT_CAUSE_CAP } = instancesModule;
  assert.equal(typeof EXIT_CAUSE_CAP, 'number');
  const cause = { code: 1, signal: null, stderrTail: null };
  for (let i = 0; i <= EXIT_CAUSE_CAP; i++) instances._noteExitCause(`cap-${i}`, cause);
  assert.equal(instances._exitCauses.size, EXIT_CAUSE_CAP);
  assert.equal(instances.exitCauseFor('cap-0'), null, 'the oldest is evicted');
  assert.notEqual(instances.exitCauseFor('cap-1'), null);
  assert.notEqual(instances.exitCauseFor(`cap-${EXIT_CAUSE_CAP}`), null);
  instances._exitCauses.clear();
});

// Short lines, so the char cap cannot be what trims the tail — only the line cap.
test('a many-line stderr is cut to exactly its last EXIT_STDERR_TAIL_LINES lines', async () => {
  const { EXIT_STDERR_TAIL_LINES, EXIT_STDERR_TAIL_CHARS } = instancesModule;
  const inst = await restWorker();
  const lines = Array.from({ length: EXIT_STDERR_TAIL_LINES * 3 }, (_, i) => `L${i}`);
  assert.ok(lines.at(-1).length * EXIT_STDERR_TAIL_LINES < EXIT_STDERR_TAIL_CHARS / 4,
    'precondition: the kept lines are far under the char cap');
  await crashMidFlight(inst, lines);

  const tail = (await json('send_prompt', { sessionId: inst.sessionId, text: 'x' })).exit?.stderrTail ?? '';
  assert.deepEqual(tail.split('\n'), lines.slice(-EXIT_STDERR_TAIL_LINES));
});

// The cause belongs to the launch that crashed: a respawn on the same Instance
// followed by a commanded kill must leave the session with no cause.
test('a commanded kill after a respawn leaves no cause from the earlier crash', async () => {
  const inst = await restWorker();
  await crashMidFlight(inst, ['FIRST-LAUNCH-CRASH']);
  assert.notEqual(instances.exitCauseFor(inst.sessionId), null, 'precondition: the crash recorded a cause');
  await instances.respawn(inst.id);
  await waitFor(() => inst.status === 'idle');
  await inst.kill({ graceMs: 50 });
  await waitFor(() => !inst.proc);

  assert.equal(instances.exitCauseFor(inst.sessionId), null);
  const r = await json('send_prompt', { sessionId: inst.sessionId, text: 'x' });
  assert.equal(r.code, 'SESSION_NOT_LIVE', JSON.stringify(r));
  assert.equal('exit' in r, false);
});

test('a read tool addressing a startup-crashed worker is SESSION_NOT_LIVE with exit and re-spawn advice', async () => {
  const { sessionId } = await startupCrashedWorker();
  for (const tool of ['get_recent_messages', 'get_transcript']) {
    const r = await json(tool, { sessionId });
    assert.equal(r.code, 'SESSION_NOT_LIVE', `${tool}: ${JSON.stringify(r)}`);
    assert.equal(r.exit?.code, 1, tool);
    assert.match(r.exit?.stderrTail ?? '', /EIO/, tool);
    assert.match(r.reason, /spawn a fresh worker/, tool);
  }
});
