// What holds an armed wake BACK: a session rotation (the reseed turn is the one
// that wakes), and a live or queued background Agent task (the drain is).
//
// One of the eight tests/idle-wake-*.test.mjs files (card 2026-0221). The
// contract under test, the MCP transport and the whole lifecycle live in
// ./idleWakeCase.mjs, which lists the family.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { api, waitFor, instForSession, settle } from './helpers.mjs';
import { WAKE_CALLBACK_MARKER, WAKE_BODY_SEP } from '../public/wakeCallback.js';
import {
  setupIdleWake, callTool, unwrap, spawnReady, spawnReadyWithScenario,
  countUserEchoes, findStubFor, SCENARIO_BG_HANG, SCENARIO_BG_COMPLETE,
  SCENARIO_BG_MIDTURN, SCENARIO_BG_CONSUMED,
} from './idleWakeCase.mjs';

const __dirname = path.dirname(fileURLToPath(import.meta.url));

// The two handles every test body below reads. Bound inside the harness's own
// `before`, which is the only place they are guaranteed booted — see
// setupIdleWake() in ./idleWakeCase.mjs.
let baseUrl, instances;
setupIdleWake(c => { ({ baseUrl, instances } = c); });

// ---------------------------------------------------------------------------
// Rotation defer (card 2026-0126). The hub's listener is registered BEFORE the
// renew controller's, so before this the ARMED turn_end consumed the one-shot a
// turn early: the conductor woke with pre-clear state and no later wake ever came.
// ---------------------------------------------------------------------------

test('a renewal defers the wake to the reseed turn — exactly one, naming the pinned id', async () => {
  const RENEW = path.join(__dirname, 'fixtures', 'scenario-renew.json');
  await api(baseUrl, 'POST', '/api/projects', { name: 'p' });
  const callerId = await spawnReady('p');
  const targetId = await spawnReadyWithScenario('p', RENEW);
  const target = instForSession(instances, targetId);
  const caller = instForSession(instances, callerId);
  const targetInstanceId = target.id;

  // The target self-renews (the real shape: MCP tools are auto-registered into
  // every worker, so a worker renews itself), then ends its turn → the clear fires.
  await callTool('renew_session', { summary: 'mid-assignment handoff' }, { caller: targetId });
  await callTool('send_prompt', { sessionId: targetId, text: 'go1' }, { caller: callerId });

  // Catch the exact moment the wake is consumed and record what the target
  // looked like then. Both post-conditions are things the pre-card build could not
  // have satisfied: it consumed the wake on the ARMED turn_end, which fires
  // BEFORE `/clear` is even sent and long before the seed is composed.
  const NEW_SID = 'c0000000-0000-4000-8000-000000000001'; // scenario-renew's post-clear sid
  let stateAtConsume = null;
  await waitFor(() => {
    if (instances._idleHub.hasArmedWake(targetInstanceId)) return false;
    stateAtConsume = {
      backing: target.backingSessionId,
      seeded: target.ringSnapshot().some(ev => ev.kind === 'user_echo'
        && typeof ev.text === 'string' && ev.text.includes('mid-assignment handoff')),
    };
    return true;
  });
  assert.equal(stateAtConsume.backing, NEW_SID,
    'the wake was held past the rotation, not spent on the armed turn_end');
  assert.equal(stateAtConsume.seeded, true,
    'and held past the RESEED — the conductor wakes to post-clear state, not pre-clear');

  // Exactly one wake across arm → clear → reseed, naming the PINNED public id (the
  // id the conductor was given, which it can still act on).
  await waitFor(() => findStubFor(caller, targetId));
  await waitFor(() => target.status === 'idle');
  assert.equal(countUserEchoes(caller, ev => ev.text.includes('get_recent_messages')), 1,
    'exactly one wake across arm → clear → reseed');
  const stub = findStubFor(caller, targetId);
  assert.ok(!stub.text.includes('did NOT finish'), `the wake must not be the watchdog stub: ${stub.text}`);
  // The rotated BACKING id must never appear in what a conductor is handed.
  assert.ok(!stub.text.includes(target.backingSessionId),
    `the internal backing id must not leak into the wake stub: ${stub.text}`);
  assert.equal(instances._idleHub.hasArmedWake(targetInstanceId), false, 'the wake was consumed');
});

test('a REQUESTED renewal wakes the conductor: one wake, after the reseed', async () => {
  // Phase 2 (card 2026-0127). A request whose acceptance-or-decline the conductor
  // never hears is useless, so the targeted renew_session form records ownership
  // like every other turn-starting call and the request's own turn arms the wake.
  // Everything else is the sibling test above: the one wake must still be held
  // across arm → /clear → reseed.
  const REQUEST = path.join(__dirname, 'fixtures', 'scenario-renew-request.json');
  await api(baseUrl, 'POST', '/api/projects', { name: 'p' });
  const callerId = await spawnReady('p');
  const targetId = await spawnReadyWithScenario('p', REQUEST);
  const target = instForSession(instances, targetId);
  const caller = instForSession(instances, callerId);
  const targetInstanceId = target.id;

  const req = unwrap(await callTool('renew_session',
    { sessionId: targetId, directive: 'MARK-D: roster + sentinels' }, { caller: callerId }));
  assert.equal(req.requested, true, JSON.stringify(req));
  assert.equal(instances._idleHub.hasArmedWake(targetInstanceId), true,
    'the request armed the conductor\'s wake with no explicit call');

  // The worker accepts: it writes its own summary inside the turn the request
  // opened (the fixture's request turn emits nothing, so it is still open), then
  // the turn ends and the managed /clear + reseed run.
  unwrap(await callTool('renew_session', { summary: 'mid-assignment handoff' }, { caller: targetId }));
  await callTool('send_prompt', { sessionId: targetId, text: 'go1' }, { caller: callerId });

  const NEW_SID = 'c0000000-0000-4000-8000-000000000001'; // the fixture's post-clear sid
  let stateAtConsume = null;
  await waitFor(() => {
    if (instances._idleHub.hasArmedWake(targetInstanceId)) return false;
    stateAtConsume = {
      backing: target.backingSessionId,
      seeded: target.ringSnapshot().some(ev => ev.kind === 'user_echo'
        && typeof ev.text === 'string' && ev.text.includes('mid-assignment handoff')),
    };
    return true;
  });
  assert.equal(stateAtConsume.backing, NEW_SID,
    'the wake was held past the rotation, not spent on the armed turn_end');
  assert.equal(stateAtConsume.seeded, true,
    'and held past the RESEED — the conductor wakes to post-clear state');

  await waitFor(() => findStubFor(caller, targetId));
  await waitFor(() => target.status === 'idle');
  assert.equal(countUserEchoes(caller, ev => ev.text.includes('get_recent_messages')), 1,
    'exactly one wake across request → self-call → clear → reseed');
  const stub = findStubFor(caller, targetId);
  assert.ok(!stub.text.includes('did NOT finish'), `the wake must not be the watchdog stub: ${stub.text}`);
  assert.ok(!stub.text.includes('DECLINED'), `an accepted request must not report a decline: ${stub.text}`);
  assert.ok(!stub.text.includes(target.backingSessionId),
    `the internal backing id must not leak into the wake stub: ${stub.text}`);
});

test('the wake DEFERS while the target has a live background Agent task', async () => {
  // The dispatch-and-wake contract: a wake means the worker AND all its
  // background subagents are done. This drives the target through a scenario
  // whose turn_end fires while a backgrounded Agent task is still open (and
  // never completes it), then confirms the caller is NOT woken — the idle
  // callback is deferred, keeping the subscription armed.
  await api(baseUrl, 'POST', '/api/projects', { name: 'p' });
  const callerId = await spawnReady('p');
  const targetId = await spawnReadyWithScenario('p', SCENARIO_BG_HANG);

  await callTool('send_prompt',
    { sessionId: targetId, text: 'kick off a background agent' }, { caller: callerId });

  const target = instForSession(instances, targetId);
  // turn_end has fired (status back to idle) while the background task is still
  // open — the target is displayStatus:'running'.
  await waitFor(() => target.status === 'idle' && target.summary().activeAgentTasks === 1);
  assert.equal(target.summary().displayStatus, 'running');

  // BARRIER: the waitFor above is downstream of the delivery decision — the
  // turn_end handler is what flips status to 'idle', and it is the same handler
  // that chooses to fire or defer. So the choice is already made here. settle()
  // then drains what that choice queued: had it (wrongly) fired, the stub would
  // be in the caller's ring and findStubFor below would find it.
  await settle();
  const caller = instForSession(instances, callerId);
  assert.equal(findStubFor(caller, targetId), undefined,
    'wake must be deferred while a background subagent is still running');
  assert.equal(instances._idleHub.hasArmedWake(instForSession(instances, targetId).id), true,
    'a deferred turn_end must NOT consume the armed wake');
});

test('the wake delivers exactly once after the subagent completes and a follow-up turn_end fires', async () => {
  // Same start, but the scenario completes the background task (task_updated
  // completed) and then emits a follow-up turn_end at activeAgentTasks===0 —
  // the deferred wake fires then, exactly once, with a folded stub.
  await api(baseUrl, 'POST', '/api/projects', { name: 'p' });
  const callerId = await spawnReady('p');
  const targetId = await spawnReadyWithScenario('p', SCENARIO_BG_COMPLETE);

  await callTool('send_prompt',
    { sessionId: targetId, text: 'kick off a background agent' }, { caller: callerId });

  const caller = instForSession(instances, callerId);
  await waitFor(() => !!findStubFor(caller, targetId));

  const stub = findStubFor(caller, targetId);
  assert.match(stub.text, /finished its turn/);
  // Delivered to an idle caller on a real turn_end → folded.
  assert.ok(stub.text.startsWith(WAKE_CALLBACK_MARKER), 'delivery stub is a wake-callback');
  assert.ok(stub.text.includes(WAKE_BODY_SEP), 'folded stub carries the body separator');

  // BARRIER: findStubFor resolved, so the FOLLOW-UP turn_end has been handled —
  // and the intermediate (deferred) turn_end strictly preceded it. A second
  // delivery from that earlier turn_end would therefore already be queued, and
  // settle() drains it into the ring, making the count 2.
  await settle();
  const stubs = countUserEchoes(caller,
    ev => ev.text?.includes(targetId) && ev.text?.includes('get_recent_messages'));
  assert.equal(stubs, 1, 'delivery fires exactly once, at the follow-up turn_end');
  // The wake was consumed.
  assert.equal(instances._idleHub.hasArmedWake(instForSession(instances, targetId).id), false);
});

test('the wake defers a MID-TURN subagent completion until the re-invocation turn', async () => {
  // Regression for the a26bbc4 bug: the subagent's task_notification fires
  // DURING the turn with NO tool round-trip after it, so activeAgentTasks is
  // already 0 at that turn_end — yet the notification is still queued and the
  // CLI owes a re-invocation turn to deliver it. Firing at the first turn_end
  // would wake the caller a turn early. Pre-fix, the first turn_end delivers +
  // consumes the subscription (the assertions below the first turn fail);
  // post-fix it defers on taskNotificationPending and the wake lands only at
  // the re-invocation turn's turn_end, exactly once.
  await api(baseUrl, 'POST', '/api/projects', { name: 'p' });
  const callerId = await spawnReady('p');
  const targetId = await spawnReadyWithScenario('p', SCENARIO_BG_MIDTURN);

  // Turn 1: spawns the agent and its task_notification fires MID-TURN, so
  // activeAgentTasks is back to 0 by this turn_end.
  await callTool('send_prompt',
    { sessionId: targetId, text: 'kick off a background agent' }, { caller: callerId });

  const target = instForSession(instances, targetId);
  const caller = instForSession(instances, callerId);
  await waitFor(() => target.status === 'idle');
  // The completion happened mid-turn, so this turn_end must be DEFERRED even
  // though the count is 0 — the subscription stays armed and no stub lands yet.
  // BARRIER: `target.status === 'idle'` above means turn 1's turn_end handler
  // ran, and that handler is where the defer-or-fire choice happens. settle()
  // drains a delivery it would have queued, so a wrongly-fired wake shows up in
  // findStubFor below rather than racing us.
  await settle();
  assert.equal(target.summary().activeAgentTasks, 0, 'count already drained (completion was mid-turn)');
  assert.equal(findStubFor(caller, targetId), undefined,
    'a mid-turn completion must NOT wake the caller at that turn_end (re-invocation turn owed)');
  assert.equal(instances._idleHub.hasArmedWake(instForSession(instances, targetId).id), true,
    'the deferred turn_end must keep the wake armed');

  // Turn 2 stands in for the re-invocation turn: it starts clean (flag reset on
  // turn entry) and its turn_end delivers the deferred wake exactly once.
  await callTool('send_prompt', { sessionId: targetId, text: 'process the result' }, { caller: callerId });
  await waitFor(() => !!findStubFor(caller, targetId));
  assert.match(findStubFor(caller, targetId).text, /finished its turn/);

  // BARRIER: turn 2's delivery has landed, and turn 1's turn_end was asserted
  // deferred above — so both handlers have run. A duplicate from either would
  // already be queued; settle() drains it and the count becomes 2.
  await settle();
  const stubs = countUserEchoes(caller,
    ev => ev.text?.includes(targetId) && ev.text?.includes('get_recent_messages'));
  assert.equal(stubs, 1, 'delivery fires exactly once, at the re-invocation turn_end');
  assert.equal(instances._idleHub.hasArmedWake(instForSession(instances, targetId).id), false, 'the wake was consumed on delivery');
});

test('the wake fires at turn_end when a MID-TURN completion was consumed in-turn', async () => {
  // Regression for the indefinite-defer hang (both live repros): the
  // notification fires mid-turn but a top-level tool_result follows it within
  // the same turn — the CLI delivered the result in-turn (sync-delivered /
  // attached), so NO re-invocation turn is owed. The wake must fire at this
  // very turn_end. Pre-fix the flag stayed set (only a turn START cleared it),
  // deferring forever — the conductor hung until the 30-min watchdog.
  await api(baseUrl, 'POST', '/api/projects', { name: 'p' });
  const callerId = await spawnReady('p');
  const targetId = await spawnReadyWithScenario('p', SCENARIO_BG_CONSUMED);

  // One turn: agent launched (async ack) → task_notification MID-TURN → a
  // later Bash round-trip (the consuming top-level tool_result) → turn_end.
  await callTool('send_prompt',
    { sessionId: targetId, text: 'kick off a background agent' }, { caller: callerId });

  const target = instForSession(instances, targetId);
  const caller = instForSession(instances, callerId);
  await waitFor(() => target.status === 'idle');

  // The notification was consumed in-turn: nothing owed, wake fires NOW.
  await waitFor(() => !!findStubFor(caller, targetId));
  assert.match(findStubFor(caller, targetId).text, /finished its turn/);
  assert.equal(target.summary().activeAgentTasks, 0);

  // Exactly once, and the one-shot subscription is consumed — no re-invocation
  // turn is needed or awaited.
  // BARRIER: the wake landed, so this turn's turn_end handler has run. A second
  // delivery could only have been queued by that same handler, and settle()
  // drains it — so a double-fire reads as count 2 rather than slipping past us.
  await settle();
  const stubs = countUserEchoes(caller,
    ev => ev.text?.includes(targetId) && ev.text?.includes('get_recent_messages'));
  assert.equal(stubs, 1, 'wake fires exactly once, at the consuming turn\'s end');
  assert.equal(instances._idleHub.hasArmedWake(instForSession(instances, targetId).id), false, 'the wake was consumed on delivery');
});
