// The three states _goneForGood must NOT mistake for death: a rotation gap, and
// the _relaunching / _mutating gaps. Each has a wake still owed on the far side.
//
// The one case a heartbeat DOES consume — a target gone for good — is in
// tests/idle-wake-heartbeat.test.mjs.
//
// One of the eight tests/idle-wake-*.test.mjs files (card 2026-0221). The
// contract under test, the MCP transport and the whole lifecycle live in
// ./idleWakeCase.mjs, which lists the family.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { api, waitFor, instForSession } from './helpers.mjs';
import {
  setupIdleWake, callTool, spawnReady, countUserEchoes, findStubFor,
  restWorker, SCENARIO_OPEN,
} from './idleWakeCase.mjs';

// The two handles every test body below reads. Bound inside the harness's own
// `before`, which is the only place they are guaranteed booted — see
// setupIdleWake() in ./idleWakeCase.mjs.
let baseUrl, instances;
setupIdleWake(c => { ({ baseUrl, instances } = c); });

test('a heartbeat inside a rotation gap does NOT retire — the wake is still owed', async () => {
  // `!proc` is equally true across a prune/rewind/respawn's kill -> relaunch gap.
  // Retiring there drops an entry whose wake is still owed (the rotation's own
  // completion, or the reseed turn's turn_end), leaving the owner with "did NOT
  // finish" as its last word and no heartbeat until some later turn start. This
  // stages that gap with the same contract calls pruneSession makes.
  await api(baseUrl, 'POST', '/api/projects', { name: 'p' });
  const callerId = await spawnReady('p');
  const worker = await restWorker('p', SCENARIO_OPEN);
  const caller = instForSession(instances, callerId);
  const beats = () => countUserEchoes(caller,
    ev => ev.text?.includes(worker.sessionId) && ev.text?.includes('did NOT finish'));

  await callTool('send_prompt',
    { sessionId: worker.sessionId, text: 'go', idleTimeoutSeconds: 1 }, { caller: callerId });
  await waitFor(() => worker.status === 'turn');
  await waitFor(() => instances._idleHub.hasArmedWake(worker.id));

  // Enter the gap: rotation open, subprocess gone — exactly pruneSession's
  // `beginRotation` -> `kill` -> (transform) -> `launch` shape.
  worker.beginRotation('prune');
  await worker.kill();
  await waitFor(() => !worker.proc);

  await waitFor(() => beats() >= 1);
  assert.equal(instances._idleHub.hasArmedWake(worker.id), true,
    'a beat inside the gap reports, but must NOT retire a wake that is still owed');
  // …and the wake it kept is still deliverable: the rotation coming up idle is the
  // only wake point a prune will ever offer, and it finds the entry armed.
  worker.endRotation({ ok: true, comesUpIdle: true });
  instances.emit('event', { id: worker.id, ev: {
    kind: 'system', subtype: 'rotation_complete', data: { comesUpIdle: true },
  } });
  await waitFor(() => !!findStubFor(caller, worker.sessionId));
  assert.equal(instances._idleHub.hasArmedWake(worker.id), false, 'and the rotation consumed it');
});

// The other two states `_goneForGood` must not mistake for death. Each is staged
// the way the rotation-gap pin stages its own: set the flag the real operation
// sets, kill the subprocess, let a beat land in the gap.
for (const gap of [
  { name: '_relaunching (rewind / respawn)', enter: (inst) => { inst._relaunching = true; },
    leave: (inst) => { inst._relaunching = false; } },
  { name: '_mutating (transcript rewrite)', enter: (inst) => { inst._mutating = true; },
    leave: (inst) => { inst._mutating = false; } },
]) {
  test(`a heartbeat inside the ${gap.name} gap does NOT retire`, async () => {
    await api(baseUrl, 'POST', '/api/projects', { name: 'p' });
    const callerId = await spawnReady('p');
    const worker = await restWorker('p', SCENARIO_OPEN);
    const caller = instForSession(instances, callerId);
    const beats = () => countUserEchoes(caller,
      ev => ev.text?.includes(worker.sessionId) && ev.text?.includes('did NOT finish'));

    await callTool('send_prompt',
      { sessionId: worker.sessionId, text: 'go', idleTimeoutSeconds: 1 }, { caller: callerId });
    await waitFor(() => worker.status === 'turn');
    await waitFor(() => instances._idleHub.hasArmedWake(worker.id));

    gap.enter(worker);
    await worker.kill();
    await waitFor(() => !worker.proc);

    await waitFor(() => beats() >= 1);
    assert.equal(instances._idleHub.hasArmedWake(worker.id), true,
      'the beat reports, but the wake is still owed once the relaunch lands');
    // …and once the gap closes with the process still gone, the SAME heartbeat
    // retires: the guard delays the retirement, it does not cancel it.
    gap.leave(worker);
    const atGapEnd = beats();
    await waitFor(() => beats() > atGapEnd);
    assert.equal(instances._idleHub.hasArmedWake(worker.id), false,
      'gone for good once nothing is reviving it');
  });
}
