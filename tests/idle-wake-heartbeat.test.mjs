// What a heartbeat consumes: NOTHING — it reports "did NOT finish" and leaves the
// wake armed — except the one case where the target is gone for good and no
// turn_end can ever follow, where the beat retires itself.
//
// One of the eight tests/idle-wake-*.test.mjs files (card 2026-0221). The
// contract under test, the MCP transport and the whole lifecycle live in
// ./idleWakeCase.mjs, which lists the family.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { api, waitFor, instForSession, driveTurn, settle } from './helpers.mjs';
import { WAKE_CALLBACK_MARKER, WAKE_BODY_SEP } from '../public/wakeCallback.js';
import {
  setupIdleWake, callTool, spawnReady, spawnReadyWithScenario,
  countUserEchoes, findStubFor, findCompletionStubFor,
  findTimeoutStubFor, restWorker, SCENARIO_LONG, SCENARIO_OPEN,
} from './idleWakeCase.mjs';

// The two handles every test body below reads. Bound inside the harness's own
// `before`, which is the only place they are guaranteed booted — see
// setupIdleWake() in ./idleWakeCase.mjs.
let baseUrl, instances;
setupIdleWake(c => { ({ baseUrl, instances } = c); });

// ── REQUIRED PIN 1: the heartbeat repeats, reports, and consumes NOTHING ─────

test('the heartbeat repeats without consuming, and the real turn_end wake still lands', async () => {
  // Three things pinned together, because they are one behaviour: the ping
  // REPEATS (a setTimeout one-shot fires once and this fails at >=2), it does not
  // self-consume (the armed wake is still there between pings), and the turn_end
  // wake it was reporting about still arrives when the turn finally ends — then
  // the interval stops.
  await api(baseUrl, 'POST', '/api/projects', { name: 'p' });
  const callerId = await spawnReady('p');
  // ~4s of mid-turn span at the 1s window (the MCP minimum). The two beats this
  // needs must both land BEFORE the turn ends, so the span is the real budget —
  // 1s × 2 inside ~4s tolerates a stall of nearly 1s per beat. On the old ~1s
  // span the margin was ~350ms, and that is what flaked under a loaded machine.
  const targetId = await spawnReadyWithScenario('p', SCENARIO_LONG);
  const target = instForSession(instances, targetId);
  const caller = instForSession(instances, callerId);

  await callTool('send_prompt',
    { sessionId: targetId, text: 'go', idleTimeoutSeconds: 1 }, { caller: callerId });
  await waitFor(() => target.status === 'turn');

  const beats = () => countUserEchoes(caller,
    ev => ev.text?.includes(targetId) && ev.text?.includes('did NOT finish'));
  await waitFor(() => beats() >= 2, { timeout: 20000 });
  const stub = findTimeoutStubFor(caller, targetId);
  assert.match(stub.text, /did NOT finish/);
  assert.match(stub.text, /timed out after 1s/);
  assert.match(stub.text, /get_recent_messages/);
  // Carve-out: a heartbeat stub is marked as a wake bubble but never folded.
  assert.ok(stub.text.startsWith(WAKE_CALLBACK_MARKER),
    'heartbeat stub is tagged as a wake-callback (renders as the bubble)');
  assert.ok(!stub.text.includes(WAKE_BODY_SEP), 'heartbeat stub must not fold — body-less');
  assert.equal(instances._idleHub.hasArmedWake(target.id), true,
    'a heartbeat reports; it must not consume the wake it is reporting about');

  // The paced fixture ends the turn on its own: the real wake lands, and it is a
  // COMPLETION, not another ping.
  await waitFor(() => !!findCompletionStubFor(caller, targetId));
  assert.equal(instances._idleHub.hasArmedWake(target.id), false, 'and consumed the wake');

  // …and the interval really stopped: several more windows produce no further ping.
  const atEnd = beats();
  await new Promise(r => setTimeout(r, 2000)); // two windows of the 1s heartbeat
  await settle();
  assert.equal(beats(), atEnd, 'the turn_end must have cleared the interval');
});

test('turn_end before the first heartbeat wins: exactly one stub, and it is the completion', async () => {
  await api(baseUrl, 'POST', '/api/projects', { name: 'p' });
  const callerId = await spawnReady('p');
  const targetId = await spawnReady('p');

  // A window nothing can beat, so the completion is guaranteed to be first.
  // MEASURED dispatch→delivered-stub: min 1ms, p50 3ms, max 11ms quiet; under
  // 24-way CPU starvation p50 7ms, p90 ~24ms, max 47ms. The clearInterval site
  // itself is pinned by the bounded-window negative below, not here — with a 600s
  // window an uncleared interval is indistinguishable from a cleared one.
  await driveTurn(instances, targetId, () => callTool('send_prompt',
    { sessionId: targetId, text: 'go', idleTimeoutSeconds: 600 }, { caller: callerId }));

  const caller = instForSession(instances, callerId);
  await waitFor(() => !!findStubFor(caller, targetId));
  const completionStub = findStubFor(caller, targetId);
  assert.match(completionStub.text, /finished its turn/);
  assert.doesNotMatch(completionStub.text, /did NOT finish/);

  // Barrier: the delivery decision is already made (findStubFor above resolved),
  // and settle() drains anything that decision queued.
  await settle();
  const allStubs = caller.ringSnapshot().filter(ev =>
    ev.kind === 'user_echo' && ev.text?.includes(targetId));
  assert.equal(allStubs.length, 1, 'exactly one stub delivered for this pair');
  assert.deepEqual(instances._idleSubscriberSnapshot(), {});
});

// ── retirement: the ONE case a heartbeat consumes ─────────────────────────────
//
// The three gaps it must NOT mistake for death are in
// tests/idle-wake-retire-gaps.test.mjs.

test('a heartbeat on a target that is GONE FOR GOOD retires itself after one ping', async () => {
  // The one case the heartbeat consumes: no turn_end can ever follow a dead
  // process, so pinging on forever would be an unbounded false report. Without the
  // retirement the owner of a crashed worker is told "did NOT finish" every window
  // for the life of the daemon.
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

  // The process dies mid-turn, with nothing reviving it. Non-temp, so the instance
  // stays in byId and no purge runs.
  await worker.kill();
  await waitFor(() => !worker.proc);
  assert.ok(instances.byId.has(worker.id), 'precondition: still registered, just dead');

  await waitFor(() => beats() >= 1);
  assert.equal(instances._idleHub.hasArmedWake(worker.id), false,
    'that ping was the last one — the entry retired');
  const atRetire = beats();
  await new Promise(r => setTimeout(r, 2000)); // two windows of the 1s heartbeat
  await settle();
  assert.equal(beats(), atRetire, 'and no further ping arrives');
});
