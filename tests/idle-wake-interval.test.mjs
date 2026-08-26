// The interval HANDLE: exactly one per caller→target pair however many times the
// pair is dispatched, and a turn_end clears every one of them.
//
// One of the eight tests/idle-wake-*.test.mjs files (card 2026-0221). The
// contract under test, the MCP transport and the whole lifecycle live in
// ./idleWakeCase.mjs, which lists the family.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { api, waitFor, instForSession, driveTurn, settle } from './helpers.mjs';
import {
  setupIdleWake, callTool, spawnReady, spawnReadyWithScenario,
  countUserEchoes, findStubFor, findCompletionStubFor,
  findTimeoutStubFor, SCENARIO_PACED, SCENARIO_OPEN,
} from './idleWakeCase.mjs';

// The two handles every test body below reads. Bound inside the harness's own
// `before`, which is the only place they are guaranteed booted — see
// setupIdleWake() in ./idleWakeCase.mjs.
let baseUrl, instances;
setupIdleWake(c => { ({ baseUrl, instances } = c); });

// ── REQUIRED PIN 2: one wake per session across a dispatch + a mid-turn steer ──

test('idempotency: a dispatch plus a mid-turn steer produce exactly ONE wake', async () => {
  await api(baseUrl, 'POST', '/api/projects', { name: 'p' });
  const callerId = await spawnReady('p');
  const targetId = await spawnReadyWithScenario('p', SCENARIO_PACED);
  const target = instForSession(instances, targetId);
  const caller = instForSession(instances, callerId);

  // Dispatch 1 opens the turn and arms.
  await callTool('send_prompt', { sessionId: targetId, text: 'one' }, { caller: callerId });
  await waitFor(() => target.status === 'turn');
  assert.deepEqual(instances._idleSubscriberSnapshot(), { [targetId]: [callerId] });

  // Dispatch 2 lands MID-TURN — a steer, no new turn, so nothing new to arm.
  await callTool('send_prompt', { sessionId: targetId, text: 'two' }, { caller: callerId });
  assert.equal(instances._idleSubscribers.get(target.id).size, 1,
    'one entry for the pair, not two');

  // The paced fixture ends the turn on its own. BARRIER: the turn_end handler is
  // what flips status to idle and what delivers, so settle() drains a double.
  await waitFor(() => target.status === 'idle');
  await waitFor(() => !!findStubFor(caller, targetId));
  await settle();
  assert.equal(countUserEchoes(caller,
    ev => ev.text?.includes(targetId) && ev.text?.includes('get_recent_messages')), 1,
    'exactly one wake for one turn, however many times it was dispatched to');
});

test('idempotency is ONE INTERVAL, not one map entry: no beat survives the turn_end', async () => {
  // The sibling test above counts wakes and map entries, and neither notices a
  // SECOND interval armed for the same pair: `subs.set()` preserves cardinality,
  // so `.size === 1` still holds while the replaced entry's timer is orphaned and
  // unreachable. `_onTurnEnd` clears the one the map still holds; the orphan keeps
  // pinging forever. It is only observable on a SHORT window — on the 30-minute
  // default the leak outlives any test — which is why the window is set here.
  await api(baseUrl, 'POST', '/api/projects', { name: 'p' });
  const callerId = await spawnReady('p');
  const targetId = await spawnReadyWithScenario('p', SCENARIO_PACED);
  const target = instForSession(instances, targetId);
  const caller = instForSession(instances, callerId);
  const beats = () => countUserEchoes(caller,
    ev => ev.text?.includes(targetId) && ev.text?.includes('did NOT finish'));

  await callTool('send_prompt',
    { sessionId: targetId, text: 'one', idleTimeoutSeconds: 1 }, { caller: callerId });
  await waitFor(() => target.status === 'turn');
  // The mid-turn steer is the second arm attempt for the same pair.
  await callTool('send_prompt',
    { sessionId: targetId, text: 'two', idleTimeoutSeconds: 1 }, { caller: callerId });
  assert.equal(instances._idleSubscribers.get(target.id).size, 1, 'one entry for the pair');

  // BARRIER: the paced fixture ends the turn on its own, and that turn_end is what
  // clears the interval the map holds.
  await waitFor(() => target.status === 'idle');
  await waitFor(() => !!findCompletionStubFor(caller, targetId));
  await settle();
  const atEnd = beats();

  // A second, orphaned interval would fire several more times in this window.
  await new Promise(r => setTimeout(r, 2000)); // two windows of the 1s heartbeat
  await settle();
  assert.equal(beats(), atEnd,
    'the turn_end cleared EVERY interval for the pair — a leaked second one keeps pinging');
  assert.equal(instances._idleHub.hasArmedWake(target.id), false);
});

// ── the turn_end DELIVERY must clear the interval: a bounded negative + control ─
//
// "No ping arrived" proves the interval was cleared ONLY if one would otherwise
// have arrived in the same window. The control below establishes exactly that, so
// the negative cannot decay into a vacuous green. Both MUST share these two
// constants — splitting them is what would let the pair drift apart.
//
// A wall-clock window is unavoidable here without a fake clock (an src/ change):
// the assertion is "the timer did not fire", which requires giving it a real
// chance to. 1500ms against a MEASURED worst-case 47ms turn round-trip under
// 24-way starvation is a ~42x margin. Re-measure before shrinking it. (The MCP
// param is whole seconds, so 2 is the smallest window above the 1s minimum that
// still leaves that margin.)
const HEARTBEAT_SECONDS = 2;
// Strictly greater than the window, so it provably elapses: an uncleared interval
// has necessarily fired by the time we assert.
const OBSERVE_MS = HEARTBEAT_SECONDS * 1000 + 600;

test('a turn_end DELIVERY clears the interval — no spurious heartbeat follows', async () => {
  // The interval callback delivers UNCONDITIONALLY, without re-checking that the
  // wake is still live, so the only observable of a missing clearInterval is the
  // spurious ping it sends afterwards — every window, forever, since it repeats.
  // It cannot be pinned by an empty subscriber snapshot (the map removal happens
  // BEFORE the clear on that path) nor by the handle-leak guard (the interval is
  // .unref()'d, and Node v24's process._getActiveHandles() does not report timers
  // at all). Do not "restore" that coupling.
  await api(baseUrl, 'POST', '/api/projects', { name: 'p' });
  const callerId = await spawnReady('p');
  const targetId = await spawnReady('p');

  const caller = instForSession(instances, callerId);
  await driveTurn(instances, targetId, () => callTool('send_prompt',
    { sessionId: targetId, text: 'go', idleTimeoutSeconds: HEARTBEAT_SECONDS }, { caller: callerId }));
  await waitFor(() => !!findStubFor(caller, targetId));
  assert.doesNotMatch(findStubFor(caller, targetId).text, /did NOT finish/,
    'the delivered stub must be the completion one — if this fails a heartbeat beat ' +
    'the turn and the window needs re-examining, not widening');

  // Outlive the window, then drain: an uncleared interval has fired by now.
  await new Promise(r => setTimeout(r, OBSERVE_MS));
  await settle();
  assert.equal(findTimeoutStubFor(caller, targetId), undefined,
    'no heartbeat may follow a delivered wake — the delivery must have cleared the interval');
  const allStubs = caller.ringSnapshot().filter(ev =>
    ev.kind === 'user_echo' && ev.text?.includes(targetId));
  assert.equal(allStubs.length, 1, 'exactly one stub for this pair, ever');
});

test('control — an armed heartbeat DOES fire inside the same window', async () => {
  // The negative above is only meaningful because of this. Identical constants;
  // the only difference is that the turn never ends, so nothing clears anything.
  // If this ever fails, the negative above has become vacuous.
  await api(baseUrl, 'POST', '/api/projects', { name: 'p' });
  const callerId = await spawnReady('p');
  const targetId = await spawnReadyWithScenario('p', SCENARIO_OPEN);
  const target = instForSession(instances, targetId);
  const caller = instForSession(instances, callerId);

  await callTool('send_prompt',
    { sessionId: targetId, text: 'go', idleTimeoutSeconds: HEARTBEAT_SECONDS }, { caller: callerId });
  await waitFor(() => target.status === 'turn');
  // Bounded by the SAME window the negative waits out, not waitFor's 10s default:
  // the claim being controlled is "a stub arrives inside that window".
  await waitFor(() => !!findTimeoutStubFor(caller, targetId), { timeout: OBSERVE_MS });
  assert.match(findTimeoutStubFor(caller, targetId).text, /did NOT finish/);
});
