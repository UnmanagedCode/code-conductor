// The ownership EDGE and the arm that follows it: the two ways an edge is
// established (spawn or dispatch), that every turn-starting tool records one and
// none can opt out, purge when either end is removed, the delivered stub's shape
// (plain vs folded), and the caller-side awaitingWake flag the UI reads.
//
// One of the eight tests/idle-wake-*.test.mjs files (card 2026-0221). The
// contract under test, the MCP transport and the whole lifecycle live in
// ./idleWakeCase.mjs, which lists the family.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { api, waitFor, instForSession, driveTurn } from './helpers.mjs';
import { WAKE_CALLBACK_MARKER, WAKE_BODY_SEP } from '../public/wakeCallback.js';
import {
  setupIdleWake, callTool, unwrap, spawnReady, armWake,
  spawnReadyWithScenario, countUserEchoes, findStubFor,
  findCompletionStubFor, SCENARIO_QUESTION, SCENARIO_SLOW,
  SCENARIO_PACED, SCENARIO_LONG, SCENARIO_UNPROMPTED,
} from './idleWakeCase.mjs';

// The two handles every test body below reads. Bound inside the harness's own
// `before`, which is the only place they are guaranteed booted — see
// setupIdleWake() in ./idleWakeCase.mjs.
let baseUrl, instances;
setupIdleWake(c => { ({ baseUrl, instances } = c); });

test('happy path: caller receives a stub user_echo when target hits turn_end', async () => {
  await api(baseUrl, 'POST', '/api/projects', { name: 'p' });
  const callerId = await spawnReady('p');
  const targetId = await spawnReady('p');

  // One call, no registration: the send records ownership and the turn it starts
  // arms the wake (driveTurn ensures turn_end fires before we assert).
  await driveTurn(instances, targetId, () => callTool('send_prompt',
    { sessionId: targetId, text: 'go' }, { caller: callerId }));

  // The stub is delivered via queueMicrotask + an async prompt() call.
  // Poll the caller's ring until the user_echo appears. Inherit the default
  // deadline — delivery follows the target's subprocess turn, which can lag
  // under concurrent CPU contention.
  const caller = instForSession(instances, callerId);
  await waitFor(() => !!findStubFor(caller, targetId));

  const stub = findStubFor(caller, targetId);
  assert.ok(stub, 'stub user_echo present in caller ring');
  assert.match(stub.text, /finished its turn/);
  // The stub points at the sessionId-keyed tool, naming the worker by sessionId.
  assert.ok(stub.text.includes(`get_recent_messages({sessionId:"${targetId}"})`),
    'stub references get_recent_messages({sessionId:"<target sid>"})');
  assert.ok(stub.text.includes(targetId));
});

test('fold: real turn_end to an idle caller folds the recent-messages payload into the stub', async () => {
  await api(baseUrl, 'POST', '/api/projects', { name: 'p' });
  const callerId = await spawnReady('p');
  const targetId = await spawnReady('p');

  // Drive the target through turn 1 of scenario-ws (emits the prose "First ").
  await driveTurn(instances, targetId, () => callTool('send_prompt',
    { sessionId: targetId, text: 'go' }, { caller: callerId }));

  const caller = instForSession(instances, callerId);
  await waitFor(() => !!findStubFor(caller, targetId));
  const stub = findStubFor(caller, targetId);

  // Folded: tagged with the wake-callback marker, still names the worker and
  // still says it finished its turn.
  assert.ok(stub.text.startsWith(WAKE_CALLBACK_MARKER),
    'idle-delivery stub is tagged as a wake-callback');
  assert.ok(stub.text.includes(WAKE_BODY_SEP),
    'folded stub carries the body separator — the real "folded" signal');
  assert.match(stub.text, /finished its turn/);
  assert.ok(stub.text.includes(targetId));
  // The folded body carries the SAME content a default get_recent_messages
  // returns: the flattened meta block (with the target sessionId) + the prose.
  assert.ok(stub.text.includes('"sessionId"'), 'folded body includes the meta block');
  assert.ok(stub.text.includes('First'), 'folded body includes the reconstructed prose');
});

test('steering: caller mid-turn at delivery gets the plain stub delivered LIVE', async () => {
  await api(baseUrl, 'POST', '/api/projects', { name: 'p' });
  // Caller runs a slow turn so it is still `status:'turn'` when the target
  // finishes — the wake is delivered LIVE into the running turn (steering) and
  // must NOT fold.
  const callerId = await spawnReadyWithScenario('p', SCENARIO_SLOW);
  const targetId = await spawnReady('p');

  // Kick the caller into its slow turn. No ?caller= on THIS send, so nothing
  // starts owning the caller.
  await callTool('send_prompt', { sessionId: callerId, text: 'busy' });
  const caller = instForSession(instances, callerId);
  await waitFor(() => caller.status === 'turn');

  // Capture the caller's status at the exact moment the wake stub is delivered.
  // prompt() fires the user_echo event BEFORE its own _setStatus('turn'), so the
  // captured status reflects the caller's still-running slow turn: 'turn' proves
  // the wake landed live (the old deferred path would have captured 'idle').
  let statusAtDelivery = null;
  const onEvent = (ev) => {
    if (statusAtDelivery === null &&
        ev.kind === 'user_echo' &&
        typeof ev.text === 'string' &&
        ev.text.includes(targetId) &&
        ev.text.includes('get_recent_messages')) {
      statusAtDelivery = caller.status;
    }
  };
  caller.on('event', onEvent);

  try {
    // Fire the target's turn_end while the caller is still mid-turn.
    await driveTurn(instances, targetId, () => callTool('send_prompt',
      { sessionId: targetId, text: 'go' }, { caller: callerId }));
    // The stub is delivered live — no waiting for the caller's slow turn to drain.
    await waitFor(() => statusAtDelivery !== null);
  } finally {
    caller.off('event', onEvent);
  }

  assert.equal(statusAtDelivery, 'turn',
    'wake stub delivered live while the caller is still mid-turn (steering, not deferred)');

  const stub = findStubFor(caller, targetId);
  assert.ok(stub.text.startsWith(WAKE_CALLBACK_MARKER),
    'mid-turn stub is tagged as a wake-callback (renders as the bubble)');
  assert.ok(!stub.text.includes(WAKE_BODY_SEP),
    'mid-turn delivery must not fold — marked but body-less');
  assert.match(stub.text, /to inspect the result/);
  assert.ok(!stub.text.includes('First'), 'plain stub carries no folded worker output');
});

// INVERTED from the old one-shot pin: ownership is durable, so a SECOND turn of
// the same target wakes the owner again with no second registration. Deleting the
// re-arm in Instance._setStatus's into-`turn` branch (or the manager's
// 'turn_start' wiring) makes the count stay at 1 and fails here.
test('ownership is durable: a second target turn wakes the owner again', async () => {
  await api(baseUrl, 'POST', '/api/projects', { name: 'p' });
  const callerId = await spawnReady('p');
  const targetId = await spawnReady('p');

  // Turn 1: the send records ownership and its turn arms the first wake.
  await driveTurn(instances, targetId, () => callTool('send_prompt',
    { sessionId: targetId, text: 'one' }, { caller: callerId }));
  const caller = instForSession(instances, callerId);
  await waitFor(() => !!findStubFor(caller, targetId));

  // Wait for the caller's own turn (triggered by the stub) to drain.
  await waitFor(() => caller.status === 'idle');
  const stubsAfterTurn1 = countUserEchoes(caller,
    ev => ev.text?.includes(targetId) && ev.text?.includes('get_recent_messages'));
  assert.equal(stubsAfterTurn1, 1, 'exactly one stub after turn 1');

  // Turn 2, driven with NO ?caller= at all: the ownership edge from turn 1 is
  // what re-arms, so the wake is not riding on this call.
  await driveTurn(instances, targetId, () => callTool('send_prompt',
    { sessionId: targetId, text: 'two' }));
  await waitFor(() => countUserEchoes(caller,
    ev => ev.text?.includes(targetId) && ev.text?.includes('get_recent_messages')) === 2);
});

test('caller removed before target turn_end: the wake is purged, no crash', async () => {
  await api(baseUrl, 'POST', '/api/projects', { name: 'p' });
  const callerId = await spawnReady('p');
  const targetId = await spawnReady('p');

  armWake(callerId, targetId, 600_000);

  // Sanity: the wake is armed before we kill anything.
  assert.deepEqual(instances._idleSubscriberSnapshot(),
    { [targetId]: [callerId] });

  // Kill the caller. The manager's _purgeIdleFor hook should drop the entry.
  await callTool('kill_instance', { sessionId: callerId });
  assert.equal(instForSession(instances, callerId), undefined);
  assert.deepEqual(instances._idleSubscriberSnapshot(), {});

  // Drive target through a turn. No callers exist → silent no-op, no throw.
  await driveTurn(instances, targetId, () => callTool('send_prompt',
    { sessionId: targetId, text: 'go' }));
  // If we got here without an unhandled rejection / crash, the test passes.
  assert.equal(instForSession(instances, targetId).status, 'idle');
});

test('target removed before turn_end: the wake is purged', async () => {
  await api(baseUrl, 'POST', '/api/projects', { name: 'p' });
  const callerId = await spawnReady('p');
  const targetId = await spawnReady('p');

  armWake(callerId, targetId, 600_000);
  assert.deepEqual(instances._idleSubscriberSnapshot(),
    { [targetId]: [callerId] });

  await callTool('kill_instance', { sessionId: targetId });
  assert.deepEqual(instances._idleSubscriberSnapshot(), {});

  // Caller is still alive and untouched.
  const caller = instForSession(instances, callerId);
  assert.equal(caller.status, 'idle');
  assert.equal(countUserEchoes(caller), 0);
});

// ── ownership: the two ways an edge is established, and the arm that follows ──

test('spawn-only ownership: the SPAWNER is woken even with no dispatch of its own', async () => {
  // `callerInstanceId` (set by spawn_instance) is an ownership edge in its own
  // right. The turn below is driven with NO ?caller=, so no dispatch edge exists
  // and only the spawn edge can produce this wake.
  await api(baseUrl, 'POST', '/api/projects', { name: 'p' });
  const conductorId = await spawnReady('p');
  const spawned = unwrap(await callTool('spawn_instance',
    { project: 'p', mode: 'bypassPermissions' }, { caller: conductorId }));
  const workerId = spawned.sessionId;
  await waitFor(() => instForSession(instances, workerId)?.status === 'idle');
  assert.deepEqual(instances._idleHub._owners.size, 0, 'no dispatch edge exists');

  await driveTurn(instances, workerId, () => callTool('send_prompt',
    { sessionId: workerId, text: 'go' }));
  const conductor = instForSession(instances, conductorId);
  await waitFor(() => !!findStubFor(conductor, workerId));
});

test('a first-time dispatch to a MID-TURN target arms for the turn it just steered', async () => {
  // `onTurnStart` has already been and gone for that turn, so `noteDispatch`'s
  // own "target is already mid-turn ⇒ arm now" branch is the only thing that can
  // arm. Without it a conductor that steers a worker it did not previously own
  // gets no report on the very turn it steered. Turn 1 is opened with NO ?caller=
  // so no ownership edge exists when the turn starts.
  await api(baseUrl, 'POST', '/api/projects', { name: 'p' });
  const callerId = await spawnReady('p');
  const targetId = await spawnReadyWithScenario('p', SCENARIO_PACED);
  const target = instForSession(instances, targetId);
  const caller = instForSession(instances, callerId);

  await callTool('send_prompt', { sessionId: targetId, text: 'one' });
  await waitFor(() => target.status === 'turn');
  assert.equal(instances._idleHub.hasArmedWake(target.id), false, 'nobody owns it yet');

  await callTool('send_prompt', { sessionId: targetId, text: 'steer' }, { caller: callerId });
  assert.equal(instances._idleHub.hasArmedWake(target.id), true,
    'the dispatch armed for the running turn, not just for the next one');

  await waitFor(() => !!findCompletionStubFor(caller, targetId));
});

test('an UNPROMPTED turn re-arms: the auto-approved-plan gap', async () => {
  // The fixture answers ONE prompt with TWO CLI turns — the second message_start
  // has no prompt behind it, exactly as an auto-approved plan rolling into
  // implementation does. The arm lives in _setStatus's into-`turn` branch, which
  // both turns pass through, so both wake the owner. An arm keyed on the MCP call
  // instead would deliver only the first.
  await api(baseUrl, 'POST', '/api/projects', { name: 'p' });
  const callerId = await spawnReady('p');
  const targetId = await spawnReadyWithScenario('p', SCENARIO_UNPROMPTED);
  const target = instForSession(instances, targetId);
  const caller = instForSession(instances, callerId);

  await callTool('send_prompt', { sessionId: targetId, text: 'go' }, { caller: callerId });
  await waitFor(() => target.ringSnapshot().filter(ev => ev.kind === 'turn_end').length === 2);
  assert.equal(countUserEchoes(target, ev => ev.text === 'go'), 1,
    'exactly one prompt reached the worker — the second turn was unprompted');
  await waitFor(() => countUserEchoes(caller,
    ev => ev.text?.includes(targetId) && ev.text?.includes('get_recent_messages')) === 2);
});

// ── awaitingWake: the caller-side flag the sidebar dot and list_sessions read ──

test('awaitingWake tracks the TURN, not a registration', async () => {
  await api(baseUrl, 'POST', '/api/projects', { name: 'p' });
  const callerId = await spawnReady('p');
  // The LONG fixture, not the paced one: this test must observe a heartbeat while
  // the turn is still running, and the 1s window (the MCP minimum) does not fit
  // inside the paced turn's ~1.2s span with room to read the flag afterwards.
  const targetId = await spawnReadyWithScenario('p', SCENARIO_LONG);
  const target = instForSession(instances, targetId);
  const caller = instForSession(instances, callerId);
  const flag = (sid) => instances.list().find(i => i.sessionId === sid)?.awaitingWake;

  assert.equal(flag(callerId), false, 'nothing armed yet');
  assert.equal(flag(targetId), false);

  // Mid-turn: the OWNER's row lights up, never the worker's — awaitingWake is
  // caller-side ("I am waiting on someone"), which is what makes an idle
  // conductor's dot distinguishable from a finished one.
  await callTool('send_prompt',
    { sessionId: targetId, text: 'go', idleTimeoutSeconds: 1 }, { caller: callerId });
  await waitFor(() => target.status === 'turn');
  assert.equal(flag(callerId), true, 'the owner is awaiting while its worker runs');
  assert.equal(flag(targetId), false, 'the worker itself is not awaiting anything');

  // …and it STAYS true across a heartbeat. This is the leg that differs from the
  // old one-shot watchdog, which consumed the entry and left the conductor's dot
  // reading "done" while its worker was still hung.
  await waitFor(() => countUserEchoes(caller,
    ev => ev.text?.includes(targetId) && ev.text?.includes('did NOT finish')) >= 1);
  assert.equal(flag(callerId), true, 'a heartbeat must not clear the flag');

  // The turn ends → the wake is consumed → the flag drops.
  await waitFor(() => target.status === 'idle');
  await waitFor(() => flag(callerId) === false);
  assert.equal(flag(targetId), false);
});

// ── the turn-starting tools all record ownership, and none of them can opt out ─

test('send_prompt with no caller still succeeds and records no ownership', async () => {
  await api(baseUrl, 'POST', '/api/projects', { name: 'p' });
  const targetId = await spawnReady('p');

  // No `caller` opt — the MCP URL carries no ?caller=.
  const res = unwrap(await callTool('send_prompt', { sessionId: targetId, text: 'go' }));
  assert.equal(res.sessionId, targetId);
  assert.deepEqual(Object.keys(res).sort(), ['sessionId', 'status'],
    'no wake-registration fields survive — there is nothing to report');
  assert.deepEqual(instances._idleHub.ownersOf(instForSession(instances, targetId).id), []);
});

test('approve_plan / reject_plan / answer_question each wake their caller', async () => {
  await api(baseUrl, 'POST', '/api/projects', { name: 'p' });

  for (const build of [
    (sid) => ['approve_plan', { sessionId: sid }],
    (sid) => ['reject_plan', { sessionId: sid, feedback: 'simpler please' }],
  ]) {
    const callerId = await spawnReady('p');
    const targetId = await spawnReady('p');
    const [tool, args] = build(targetId);
    const res = unwrap(await callTool(tool, args, { caller: callerId }));
    assert.equal(res.subscribed, undefined, `${tool} reports no subscription field`);
    const caller = instForSession(instances, callerId);
    await waitFor(() => !!findStubFor(caller, targetId));
  }

  // answer_question needs a pending AskUserQuestion to answer.
  const callerId = await spawnReady('p');
  const targetId = await spawnReadyWithScenario('p', SCENARIO_QUESTION);
  await driveTurn(instances, targetId,
    () => callTool('send_prompt', { sessionId: targetId, text: 'go' }));
  const target = instForSession(instances, targetId);
  await waitFor(() => target.ringSnapshot().some(ev => ev.kind === 'user_question'));

  const res = unwrap(await callTool('answer_question',
    { sessionId: targetId, answers: [{ option: 'Apple' }] }, { caller: callerId }));
  assert.equal(res.subscribed, undefined, 'answer_question reports no subscription field');
  const caller = instForSession(instances, callerId);
  await waitFor(() => !!findStubFor(caller, targetId));
});
