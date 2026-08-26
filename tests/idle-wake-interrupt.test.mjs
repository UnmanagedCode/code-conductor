// The two interrupt tiers and who each one silences: a FORCED abort disarms the
// interrupter alone and tells every other owner INTERRUPTED, while a SOFT one
// disarms nobody and leaves the heartbeat as the escalation signal.
//
// One of the eight tests/idle-wake-*.test.mjs files (card 2026-0221). The
// contract under test, the MCP transport and the whole lifecycle live in
// ./idleWakeCase.mjs, which lists the family.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { api, waitFor, instForSession, settle } from './helpers.mjs';
import { WAKE_CALLBACK_MARKER, WAKE_BODY_SEP } from '../public/wakeCallback.js';
import {
  setupIdleWake, callTool, unwrap, spawnReady, waitParkedMidBlock,
  spawnReadyWithScenario, countUserEchoes, findStubFor, watchBeats,
  findInterruptedStubFor, SCENARIO_OPEN,
} from './idleWakeCase.mjs';

// The two handles every test body below reads. Bound inside the harness's own
// `before`, which is the only place they are guaranteed booted — see
// setupIdleWake() in ./idleWakeCase.mjs.
let baseUrl, instances;
setupIdleWake(c => { ({ baseUrl, instances } = c); });

// ── interrupt_turn: the two tiers do OPPOSITE things to the armed wake ────────

test('interrupt_turn force:true wakes the INTERRUPTER not at all', async () => {
  // A forced abort produces a turn_end like any other. Without the disarm the
  // interrupter is told the worker "finished its turn" about a turn it killed
  // itself — and the fixture's interrupt turn emits exactly that result, so this
  // is the real wire shape, not a synthetic event.
  await api(baseUrl, 'POST', '/api/projects', { name: 'p' });
  const callerId = await spawnReady('p');
  const targetId = await spawnReadyWithScenario('p', SCENARIO_OPEN);
  const target = instForSession(instances, targetId);
  const caller = instForSession(instances, callerId);

  await callTool('send_prompt', { sessionId: targetId, text: 'go' }, { caller: callerId });
  await waitFor(() => target.status === 'turn');
  await waitFor(() => instances._idleHub.hasArmedWake(target.id));

  await callTool('interrupt_turn', { sessionId: targetId, force: true }, { caller: callerId });

  // BARRIER: the forced abort's own turn_end is what flips the target to idle,
  // and that same handler is where a wake would be delivered. settle() then
  // drains what it queued, so a delivery shows up here rather than racing us.
  await waitFor(() => target.status === 'idle');
  await settle();
  assert.equal(findStubFor(caller, targetId), undefined,
    'the interrupter gets no wake at all — not a completion, not an interrupted one');
  assert.equal(instances._idleHub.hasArmedWake(target.id), false, 'and nothing stays armed');
  // Ownership survives: the NEXT turn re-arms.
  assert.ok(instances._idleHub.ownersOf(target.id).includes(caller.id),
    'the disarm drops the wake, not the ownership');
});

test('a forced interrupt silences ONLY the interrupter; every other owner is woken, and told INTERRUPTED', async () => {
  // The disarm is caller-scoped. Clearing the whole per-target map instead left
  // every other owner with no stub, no heartbeat, and a wait nothing could ever
  // end — and the interrupter need not be an owner at all, so any session that
  // could address a target could silence its watchers. Multi-owner is
  // first-class: the edge is spawn OR dispatch.
  await api(baseUrl, 'POST', '/api/projects', { name: 'p' });
  const aId = await spawnReady('p');
  const bId = await spawnReady('p');
  const targetId = await spawnReadyWithScenario('p', SCENARIO_OPEN);
  const target = instForSession(instances, targetId);
  const a = instForSession(instances, aId);
  const b = instForSession(instances, bId);

  // A opens the turn (arming A); B then dispatches mid-turn (arming B too).
  await callTool('send_prompt', { sessionId: targetId, text: 'go' }, { caller: aId });
  await waitFor(() => target.status === 'turn');
  await callTool('send_prompt', { sessionId: targetId, text: 'me too' }, { caller: bId });
  assert.equal(instances._idleSubscribers.get(target.id).size, 2, 'precondition: two owners armed');

  await callTool('interrupt_turn', { sessionId: targetId, force: true }, { caller: aId });
  await waitFor(() => target.status === 'idle');
  await settle();

  assert.equal(findStubFor(a, targetId), undefined, 'A asked for the abort, so A hears nothing');
  const bStub = await waitFor(() => findInterruptedStubFor(b, targetId));
  assert.match(bStub.text, /was INTERRUPTED/, 'B is woken rather than stranded');
  assert.match(bStub.text, /PARTIAL/, 'and told its output is partial');
  assert.doesNotMatch(bStub.text, /finished its turn/,
    'a killed turn must never be reported to B as finished');
  // Renders as the bell bubble, but is NEVER folded: the body separator is the
  // client's "this is the finished result" signal.
  assert.ok(bStub.text.startsWith(WAKE_CALLBACK_MARKER), 'still a wake-callback bubble');
  assert.ok(!bStub.text.includes(WAKE_BODY_SEP),
    'interrupted output must not fold — folding invites acting on what the abort stopped');
  assert.equal(countUserEchoes(b,
    ev => ev.text?.includes(targetId) && ev.text?.includes('get_recent_messages')), 1,
    'exactly one wake for B');
});

test('the UI stop button (no interrupter) tells EVERY owner the turn was interrupted', async () => {
  // wsHub calls Instance.interrupt({force:true}) directly with no caller, so there
  // is nobody to silence. Before the interrupted variant existed, that door
  // delivered a FOLDED "finished its turn" stub about aborted partial work — the
  // exact misreport the MCP force path was built to prevent. Driving
  // Instance.interrupt directly is that door's own shape.
  await api(baseUrl, 'POST', '/api/projects', { name: 'p' });
  const callerId = await spawnReady('p');
  const targetId = await spawnReadyWithScenario('p', SCENARIO_OPEN);
  const target = instForSession(instances, targetId);
  const caller = instForSession(instances, callerId);

  await callTool('send_prompt', { sessionId: targetId, text: 'go' }, { caller: callerId });
  await waitFor(() => target.status === 'turn');
  await waitFor(() => instances._idleHub.hasArmedWake(target.id));

  await target.interrupt({ force: true });
  await waitFor(() => target.status === 'idle');

  const stub = await waitFor(() => findInterruptedStubFor(caller, targetId));
  assert.match(stub.text, /was INTERRUPTED/);
  assert.doesNotMatch(stub.text, /finished its turn/);
  assert.ok(!stub.text.includes(WAKE_BODY_SEP), 'never folded, even to an idle recipient');
  await settle();
  assert.equal(countUserEchoes(caller,
    ev => ev.text?.includes(targetId) && ev.text?.includes('get_recent_messages')), 1);
});

test('a SOFT interrupt leaves the wake armed, and the heartbeat keeps firing', async () => {
  // The soft tier's boundary wait is unbounded — the fixture parks mid-text-block,
  // so no boundary ever arrives — which is exactly why the heartbeat must keep
  // pinging: it is the conductor's signal to escalate to force:true.
  await api(baseUrl, 'POST', '/api/projects', { name: 'p' });
  const callerId = await spawnReady('p');
  const targetId = await spawnReadyWithScenario('p', SCENARIO_OPEN);
  const target = instForSession(instances, targetId);
  const caller = instForSession(instances, callerId);

  await callTool('send_prompt',
    { sessionId: targetId, text: 'go', idleTimeoutSeconds: 1 }, { caller: callerId });
  await waitParkedMidBlock(target);

  const soft = unwrap(await callTool('interrupt_turn', { sessionId: targetId }));
  assert.equal(soft.interrupting, true, 'ARMED, not stopped');
  assert.equal(target._interruptFired, false,
    'ARMED means nothing was sent: a control_request here ends the turn and consumes the wake');
  // Immediate and schedule-free: a disarm would show here with nothing to wait for.
  assert.equal(instances._idleHub.hasArmedWake(target.id), true,
    'a soft interrupt must not clear the wake it is waiting on');

  // A beat strictly AFTER the interrupt — "two in total" could be satisfied by two
  // that both preceded it, asserting nothing about the interrupt at all.
  const beats = watchBeats(instances._idleHub, target.id);
  try {
    await waitFor(() => beats.n > 0, { timeout: 20000 });
  } finally {
    beats.restore();
  }
  assert.equal(instances._idleHub.hasArmedWake(target.id), true,
    'and the beat consumed nothing');
});

test('a soft interrupt by an IDENTIFIED caller disarms nothing — the heartbeat is the escalation signal', async () => {
  // The sibling soft-interrupt pin drives interrupt_turn with NO ?caller=, so the
  // handler's `force && callerId` guard short-circuits on callerId and the
  // caller-scoped branch is never reached. That leaves the contract the conductor
  // role doc actually promises — YOUR soft interrupt leaves YOUR wake armed, and
  // the continuing heartbeat is what tells you to escalate — asserted by nobody.
  await api(baseUrl, 'POST', '/api/projects', { name: 'p' });
  const callerId = await spawnReady('p');
  const targetId = await spawnReadyWithScenario('p', SCENARIO_OPEN);
  const target = instForSession(instances, targetId);
  const caller = instForSession(instances, callerId);
  await callTool('send_prompt',
    { sessionId: targetId, text: 'go', idleTimeoutSeconds: 1 }, { caller: callerId });
  await waitParkedMidBlock(target);
  await waitFor(() => instances._idleHub.hasArmedWake(target.id));

  const res = unwrap(await callTool('interrupt_turn',
    { sessionId: targetId }, { caller: callerId }));
  assert.equal(res.interrupting, true, 'ARMED, not stopped');
  assert.equal(target._interruptFired, false,
    'ARMED means nothing was sent: a control_request here ends the turn and consumes the wake');
  // The C2 mutant (`force && callerId` → `callerId`) disarms right here, so this
  // single assertion kills it with nothing scheduled at all.
  assert.equal(instances._idleHub.hasArmedWake(target.id), true,
    'the caller\'s own soft interrupt must NOT disarm its wake');

  // The fixture parks mid-text-block, so no output boundary ever arrives and the
  // soft tier never fires — the unbounded wait the heartbeat exists to surface.
  const beats = watchBeats(instances._idleHub, target.id);
  try {
    await waitFor(() => beats.n > 0, { timeout: 20000 });
  } finally {
    beats.restore();
  }
  assert.equal(instances._idleHub.hasArmedWake(target.id), true, 'and consumed nothing');
  assert.equal(target.status, 'turn', 'the turn is still running');
});
