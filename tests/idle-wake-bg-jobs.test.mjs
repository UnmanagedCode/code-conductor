// Background Bash jobs and the idle wake. A worker that ends its turn with a
// background job still running is FINISHED for wake purposes: the wake is
// delivered at once and nothing up the ownership chain is held. The jobs only
// (a) ride in the stub, as a block in its always-visible summary, and (b) drive
// list()'s display-only `waitingOnJob`, which never touches `awaitingWake`.
//
// Two layers:
//   1. Hub: the REAL InstanceManager → IdleSubscriptionHub path with injected
//      fake instances exposing a settable `backgroundJobs` (the pattern of
//      tests/idle-subagent-defer.test.mjs).
//   2. End to end: bootServer + the fake CLI through ./idleWakeCase.mjs, with
//      tests/fixtures/scenario-bg-bash-job.json — a turn that starts a
//      background Bash job and ends, then (on a test-only control request
//      standing in for the job exiting) the CLI's empty snapshot, the task's
//      completion frames and an unprompted re-invocation turn, in the order
//      CLI 2.1.286 emits them (tests/fixtures/bg-bash-jobs.stdout.jsonl, E1).

import { test, after } from 'node:test';
import assert from 'node:assert/strict';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { api, waitFor, instForSession, settle } from './helpers.mjs';
import { WAKE_BODY_SEP, parseWakeCallback } from '../public/wakeCallback.js';
import {
  setupIdleWake, callTool, spawnReady, spawnReadyWithScenario, restWorker,
  findCompletionStubFor,
} from './idleWakeCase.mjs';
import { InstanceManager } from '../src/instances.ts';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const SCENARIO_BG_BASH_JOB = path.join(__dirname, 'fixtures', 'scenario-bg-bash-job.json');

// ---------------------------------------------------------------------------
// 1. Hub layer
// ---------------------------------------------------------------------------

const hub = new InstanceManager();
after(() => hub.shutdown().catch(() => {}));

const JOB = { title: 'sleep probe', startedAt: Date.now() - 65_000 };

function makeFake({ id, sessionId, status = 'idle', activeAgentTaskCount = 0, backgroundJobs = [] }) {
  const prompts = [];
  const inst = {
    id, sessionId, project: 'test-project', proc: { pid: 999 }, status,
    activeAgentTaskCount, taskNotificationPending: false, backgroundJobs,
    _emitUi() {},
    ring: { trimmedBefore: 0 },
    ringSnapshot() { return []; },
    async prompt(text, _atts, opts) { prompts.push({ text, opts }); },
    summary() { return { id, sessionId, status: this.status, displayStatus: this.status, backgroundJobs: this.backgroundJobs }; },
  };
  inst.prompts = prompts;
  return inst;
}

function inject(...fakes) { for (const f of fakes) hub.byId.set(f.id, f); }
function cleanup(...fakes) {
  hub._idleSubscribers.clear();
  hub._idleHub._owners.clear();
  for (const f of fakes) hub.byId.delete(f.id);
}
function armWake(callerSid, targetSid) {
  hub.noteDispatch(callerSid, targetSid);
  hub._idleHub.onTurnStart(hub.liveForSession(targetSid).id);
}
const emitTurnEnd = (id) => hub.emit('event', { id, ev: { kind: 'turn_end', isError: false, stopReason: 'end_turn' } });
const tick = () => new Promise(r => setTimeout(r, 20));
const rowOf = (id) => hub.list().find(r => r.id === id);

test('a turn end with a background job and no agents delivers exactly one wake at once', async () => {
  const c = makeFake({ id: 'c1', sessionId: 'cs1' });
  const w = makeFake({ id: 'w1', sessionId: 'ws1', backgroundJobs: [JOB] });
  inject(c, w);
  armWake('cs1', 'ws1');
  emitTurnEnd('w1');
  await tick();
  assert.equal(c.prompts.length, 1, 'the job does not hold the wake');
  assert.equal(hub._idleHub.hasArmedWake('w1'), false, 'the wake was consumed');
  cleanup(c, w);
});

test('a job never holds a wake up the chain: P ← C ← W, C\'s turn end wakes P while W\'s job runs', async () => {
  const p = makeFake({ id: 'p2', sessionId: 'ps2' });
  const c = makeFake({ id: 'c2', sessionId: 'cs2' });
  const w = makeFake({ id: 'w2', sessionId: 'ws2', backgroundJobs: [JOB] });
  inject(p, c, w);
  armWake('ps2', 'cs2');
  armWake('cs2', 'ws2');
  emitTurnEnd('w2');
  await tick();
  assert.equal(c.prompts.length, 1, 'C was woken by W');
  emitTurnEnd('c2');
  await tick();
  assert.equal(p.prompts.length, 1, 'C is not held by W\'s running job');
  assert.equal(w.backgroundJobs.length, 1, 'the job was still running throughout');
  cleanup(p, c, w);
});

test('folded stub: the job lines and the re-invoke line sit in the summary, before the body', async () => {
  const c = makeFake({ id: 'c3', sessionId: 'cs3' });
  const w = makeFake({ id: 'w3', sessionId: 'ws3', backgroundJobs: [JOB] });
  inject(c, w);
  armWake('cs3', 'ws3');
  emitTurnEnd('w3');
  await tick();
  const { text } = c.prompts[0];
  assert.ok(text.includes(WAKE_BODY_SEP), 'an idle caller gets the folded stub');
  const { summary, body } = parseWakeCallback(text);
  assert.match(summary, /finished its turn/);
  assert.match(summary, /\nBackground jobs still running:\n- "sleep probe" — running 1m\d+s\n/);
  assert.ok(summary.endsWith('Worker `ws3` is re-invoked when each job exits, and you will be woken again after that turn.'), summary);
  assert.ok(!body.includes('Background jobs'), 'nothing of it lands in the collapsed body');
  cleanup(c, w);
});

test('plain stub (mid-turn caller): carries the jobs block', async () => {
  const c = makeFake({ id: 'c4', sessionId: 'cs4', status: 'turn' });
  const w = makeFake({ id: 'w4', sessionId: 'ws4', backgroundJobs: [JOB] });
  inject(c, w);
  armWake('cs4', 'ws4');
  emitTurnEnd('w4');
  await tick();
  const { text } = c.prompts[0];
  assert.ok(!text.includes(WAKE_BODY_SEP), 'a mid-turn caller gets the plain stub');
  assert.match(text, /finished its turn\. .*\nBackground jobs still running:\n- "sleep probe" — running /s);
  assert.match(text, /Worker `ws4` is re-invoked when each job exits/);
  cleanup(c, w);
});

test('heartbeat (timedOut): no jobs block while the target has jobs', async () => {
  const c = makeFake({ id: 'c5', sessionId: 'cs5' });
  const w = makeFake({ id: 'w5', sessionId: 'ws5', status: 'turn', backgroundJobs: [JOB] });
  inject(c, w);
  hub._idleHub.deliver('c5', 'w5', { timedOut: true, timeoutMs: 60_000 });
  await tick();
  const { text } = c.prompts[0];
  assert.match(text, /did NOT finish/);
  assert.ok(!text.includes('Background jobs'), text);
  assert.ok(!text.includes('re-invoked'), text);
  cleanup(c, w);
});

test('no jobs: the stub carries no jobs block', async () => {
  const c = makeFake({ id: 'c6', sessionId: 'cs6' });
  const m = makeFake({ id: 'm6', sessionId: 'ms6', status: 'turn' });
  const w = makeFake({ id: 'w6', sessionId: 'ws6' });
  inject(c, m, w);
  armWake('cs6', 'ws6');
  armWake('ms6', 'ws6');
  emitTurnEnd('w6');
  await tick();
  for (const f of [c, m]) {
    assert.equal(f.prompts.length, 1);
    assert.ok(!f.prompts[0].text.includes('Background jobs'), f.prompts[0].text);
    assert.ok(!f.prompts[0].text.includes('re-invoked'), f.prompts[0].text);
  }
  cleanup(c, m, w);
});

test('mixed: an agent still defers; once it drains, one wake lists the job', async () => {
  const c = makeFake({ id: 'c7', sessionId: 'cs7' });
  const w = makeFake({ id: 'w7', sessionId: 'ws7', activeAgentTaskCount: 1, backgroundJobs: [JOB] });
  inject(c, w);
  armWake('cs7', 'ws7');
  emitTurnEnd('w7');
  await tick();
  assert.equal(c.prompts.length, 0, 'the live agent defers the wake');
  w.activeAgentTaskCount = 0;
  emitTurnEnd('w7');
  await tick();
  assert.equal(c.prompts.length, 1);
  assert.match(c.prompts[0].text, /- "sleep probe" — running /);
  cleanup(c, w);
});

test('display separation: after the wake the owner is not awaitingWake but is waitingOnJob, until the job clears', async () => {
  const c = makeFake({ id: 'c8', sessionId: 'cs8' });
  const w = makeFake({ id: 'w8', sessionId: 'ws8', backgroundJobs: [JOB] });
  inject(c, w);
  armWake('cs8', 'ws8');
  emitTurnEnd('w8');
  await tick();
  assert.equal(c.prompts.length, 1);
  assert.equal(hub.isIdleCaller('c8'), false, 'no held wake');
  assert.deepEqual([rowOf('c8').awaitingWake, rowOf('c8').waitingOnJob], [false, true]);
  assert.deepEqual([rowOf('w8').awaitingWake, rowOf('w8').waitingOnJob], [false, true]);
  w.backgroundJobs = [];
  assert.deepEqual([rowOf('c8').waitingOnJob, rowOf('w8').waitingOnJob], [false, false]);
  cleanup(c, w);
});

// ---------------------------------------------------------------------------
// 2. End to end
// ---------------------------------------------------------------------------

let baseUrl, instances;
setupIdleWake((c) => { ({ baseUrl, instances } = c); });

const rows = async () => (await api(baseUrl, 'GET', '/api/instances')).body;
const waitingOnJob = async (id) => (await rows()).find(r => r.id === id)?.waitingOnJob;
const completionStubs = (caller, sid) => caller.ringSnapshot().filter(ev =>
  ev.kind === 'user_echo' && typeof ev.text === 'string' && ev.text.includes(sid) && ev.text.includes('finished its turn'));

async function startJob(callerId, workerSid) {
  await callTool('send_prompt', { sessionId: workerSid, text: 'start the probe' }, { caller: callerId });
  const worker = instForSession(instances, workerSid);
  await waitFor(() => worker.status === 'idle' && worker.backgroundJobs.length === 1);
  return worker;
}

test('e2e: the stub lists the job, both rows wait on it, and its exit re-invokes the worker and wakes the owner again', async () => {
  await api(baseUrl, 'POST', '/api/projects', { name: 'p' });
  const callerId = await spawnReady('p');
  const workerSid = await spawnReadyWithScenario('p', SCENARIO_BG_BASH_JOB);
  const caller = instForSession(instances, callerId);
  const worker = await startJob(callerId, workerSid);

  await waitFor(() => findCompletionStubFor(caller, workerSid));
  const first = findCompletionStubFor(caller, workerSid).text;
  assert.match(first, /- "sleep probe" — running \S+/);
  assert.ok(first.includes(`Worker \`${workerSid}\` is re-invoked when each job exits`), first);

  assert.equal(await waitingOnJob(worker.id), true, 'the worker waits on its own job');
  assert.equal(await waitingOnJob(caller.id), true, 'and so does its owner');

  // The job exits: the CLI's empty snapshot, its completion, and the unprompted
  // re-invocation turn, whose turn end wakes the owner a second time.
  await worker._controlRequest({ subtype: 'cc_test_job_exit' });
  await waitFor(() => completionStubs(caller, workerSid).length === 2);
  await waitFor(() => worker.status === 'idle');
  await settle();
  assert.equal(completionStubs(caller, workerSid).length, 2, 'exactly two wakes');
  assert.ok(!completionStubs(caller, workerSid)[1].text.includes('Background jobs'),
    'the second wake has nothing left running');
  assert.deepEqual(worker.backgroundJobs, []);
  for (const r of await rows()) assert.equal(r.waitingOnJob, false, `${r.id} still waiting on a job`);
});

test('e2e kill: kill_instance on the worker clears its owner\'s waitingOnJob', async () => {
  await api(baseUrl, 'POST', '/api/projects', { name: 'p' });
  const callerId = await spawnReady('p');
  const workerSid = await spawnReadyWithScenario('p', SCENARIO_BG_BASH_JOB);
  const caller = instForSession(instances, callerId);
  await startJob(callerId, workerSid);
  await waitFor(async () => (await waitingOnJob(caller.id)) === true);

  await callTool('kill_instance', { sessionId: workerSid }, { caller: callerId });
  await waitFor(async () => (await waitingOnJob(caller.id)) === false);
  for (const r of await rows()) assert.equal(r.waitingOnJob, false, `${r.id} still waiting on a job`);
});

test('e2e crash: a worker killed outright with a job tracked leaves no row waiting', async () => {
  await api(baseUrl, 'POST', '/api/projects', { name: 'p' });
  const callerId = await spawnReady('p');
  const worker = await restWorker('p', SCENARIO_BG_BASH_JOB);
  const caller = instForSession(instances, callerId);
  await startJob(callerId, worker.sessionId);
  await waitFor(async () => (await waitingOnJob(caller.id)) === true);

  worker.proc.kill('SIGKILL');
  await waitFor(() => worker.status === 'crashed');
  const all = await rows();
  const w = all.find(r => r.id === worker.id);
  assert.ok(w, 'the non-temp worker is retained');
  assert.deepEqual(w.backgroundJobs, []);
  for (const r of all) assert.equal(r.waitingOnJob, false, `${r.id} still waiting on a job`);
});
