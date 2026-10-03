// A worker whose CLI exits ON ITS OWN while an owner is waiting on it: no
// turn_end will ever come, so the exit itself is the wake. Every armed owner is
// woken at once, exactly once, with an EXITED stub naming the worker's
// sessionId, and the armed entry (and its heartbeat interval) is gone at the
// same moment — temp and non-temp alike. A commanded kill is NOT this path; its
// heartbeat retirement is pinned in idle-wake-heartbeat.
//
// The crash is a SIGKILL straight to the in-process child after its stderr line
// has been read: that bypasses Instance.kill, so the exit is not a commanded one.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { api, waitFor, instForSession, settle } from './helpers.mjs';
import {
  setupIdleWake, callTool, spawnReady, spawnReadyWithScenario, restWorker,
  SCENARIO_OPEN,
} from './idleWakeCase.mjs';
import { parseWakeCallback } from '../public/wakeCallback.js';

let baseUrl, instances;
setupIdleWake((c) => { ({ baseUrl, instances } = c); });

const isExitedStub = (sid) => (ev) => ev.text?.includes(sid) && ev.text?.includes('EXITED');
const exitedStubs = (caller, sid) => caller.ringSnapshot()
  .filter(ev => ev.kind === 'user_echo' && isExitedStub(sid)(ev));

async function crashMidFlight(inst, line) {
  inst.proc.stderr.write(line + '\n');
  await waitFor(() => inst._stderr.includes(line));
  inst.proc.kill('SIGKILL');
}

// Dispatch to the worker from the caller, so the caller owns it and is armed on
// the turn that starts.
async function armedMidTurn(callerId, worker) {
  await callTool('send_prompt', { sessionId: worker.sessionId, text: 'go' }, { caller: callerId });
  await waitFor(() => worker.status === 'turn');
  await waitFor(() => instances.hasArmedWake(worker.id));
}

test('a TEMP worker that crashes mid-turn wakes its owner once with EXITED, and its armed entry is gone', async () => {
  await api(baseUrl, 'POST', '/api/projects', { name: 'p' });
  const callerId = await spawnReady('p');
  const workerSid = await spawnReadyWithScenario('p', SCENARIO_OPEN);
  const caller = instForSession(instances, callerId);
  const worker = instForSession(instances, workerSid);
  await armedMidTurn(callerId, worker);

  await crashMidFlight(worker, 'fatal: EIO reading the union');
  await waitFor(() => exitedStubs(caller, workerSid).length >= 1);
  await settle();
  const stubs = exitedStubs(caller, workerSid);
  assert.equal(stubs.length, 1, 'exactly one wake');
  assert.ok(parseWakeCallback(stubs[0].text), 'a wake-callback stub');
  assert.match(stubs[0].text, /describe_session/);
  assert.doesNotMatch(stubs[0].text, /did NOT finish/, 'the heartbeat phrase reads as "still running"');
  assert.equal(instances.hasArmedWake(worker.id), false);
  assert.deepEqual(instances._idleSubscriberSnapshot(), {}, 'no armed entry — so no heartbeat interval — remains');
});

test('a NON-temp worker that crashes mid-turn wakes its owner with EXITED at once, not a later heartbeat', async () => {
  await api(baseUrl, 'POST', '/api/projects', { name: 'p' });
  const callerId = await spawnReady('p');
  const worker = await restWorker('p', SCENARIO_OPEN);
  const caller = instForSession(instances, callerId);
  await armedMidTurn(callerId, worker);

  await crashMidFlight(worker, 'fatal: socket hang up');
  await waitFor(() => exitedStubs(caller, worker.sessionId).length >= 1);
  await settle();
  assert.ok(instances.byId.has(worker.id), 'precondition: non-temp, still registered');
  // At once: the heartbeat window is the default (ORCH_SUBSCRIBE_TIMEOUT_MS), far
  // beyond waitFor's deadline, so only the exit itself can have delivered this.
  assert.equal(exitedStubs(caller, worker.sessionId).length, 1);
  assert.equal(instances.hasArmedWake(worker.id), false, 'the heartbeat is retired with the wake');
});

// The recipient is mid-turn on a model that cannot take an injected message, so
// the EXITED wake is held until its own turn_end — by which time the temp target
// has been purged and its instance is gone. Fakes, injected into the real
// manager's byId, are the only way to hold the recipient in that state.
test('an EXITED wake held for a mid-turn recipient still names the sessionId after its target is purged', async () => {
  const prompts = [];
  const cond = {
    id: 'cond-inst', sessionId: 'cond-sess', project: 'p', proc: { pid: 999 }, status: 'turn',
    acceptsMidTurnSteering: false, steerPending: false, activeAgentTaskCount: 0,
    taskNotificationPending: false, rotationPending: false, _emitUi() {},
    async prompt(text) { prompts.push(text); },
  };
  const work = {
    id: 'work-inst', sessionId: 'work-sess', project: 'p', proc: { pid: 998 }, status: 'idle',
    activeAgentTaskCount: 0, taskNotificationPending: false, rotationPending: false,
  };
  instances.byId.set(cond.id, cond);
  instances.byId.set(work.id, work);
  try {
    instances.noteDispatch(cond.sessionId, work.sessionId);
    instances._idleHub.onTurnStart(work.id);
    work.proc = null;
    instances._idleHub.onTargetExit(work.id, { sessionId: work.sessionId, code: 1, signal: null });
    instances.byId.delete(work.id);
    instances._purgeIdleFor(work.id);
    await settle();
    assert.equal(prompts.length, 0, 'held: nothing injected into the running turn');

    cond.status = 'idle';
    instances.emit('event', { id: cond.id, ev: { kind: 'turn_end', isError: false, stopReason: 'end_turn' } });
    await settle();
    assert.equal(prompts.length, 1, 'delivered at the recipient\'s own boundary');
    assert.match(prompts[0], /`work-sess` EXITED/);
    assert.doesNotMatch(prompts[0], /work-inst/, 'never the raw instanceId');
  } finally {
    instances.byId.delete(cond.id);
    instances.byId.delete(work.id);
    instances._purgeIdleFor(cond.id);
  }
});
