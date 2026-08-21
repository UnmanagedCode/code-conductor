// Integration tests for subscribe_to_idle / unsubscribe_from_idle.
//
// These exercise the orchestrator's one-shot idle-callback channel:
// when the *target* instance hits turn_end, a stub user prompt lands
// in the *caller* instance (via Instance.prompt(), the same path WS /
// auto-approve use). The MCP tool registers the subscription; the
// caller identity is read from `?caller=<id>` on the MCP URL.
//
// Tests drive the MCP transport via fetch (same shape a real `claude
// mcp add --transport http` client would use), and use the fake-claude
// subprocess via bootServer() so no real LLM is needed.

import { test, before, after, beforeEach, afterEach } from 'node:test';
import assert from 'node:assert/strict';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { bootServer, api, waitFor, instForSession, freshProjectsRoot, rmrf, driveTurn, settle } from './helpers.mjs';
import { WAKE_CALLBACK_MARKER, WAKE_BODY_SEP } from '../public/wakeCallback.js';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const SCENARIO_WS = path.join(__dirname, 'fixtures', 'scenario-ws.json');
const SCENARIO_QUESTION = path.join(__dirname, 'fixtures', 'scenario-question.json');
const SCENARIO_SLOW = path.join(__dirname, 'fixtures', 'scenario-slow-turn.json');
const SCENARIO_BG_HANG = path.join(__dirname, 'fixtures', 'scenario-bg-task-hang.json');
const SCENARIO_BG_COMPLETE = path.join(__dirname, 'fixtures', 'scenario-bg-task-complete.json');
const SCENARIO_BG_MIDTURN = path.join(__dirname, 'fixtures', 'scenario-bg-task-midturn-complete.json');
const SCENARIO_BG_CONSUMED = path.join(__dirname, 'fixtures', 'scenario-bg-task-midturn-consumed.json');

let ctx, baseUrl, instances, home;
before(async () => { ctx = await bootServer({ scenarioPath: SCENARIO_WS }); ({ baseUrl, instances } = ctx); });
after(async () => { await ctx.close(); });
beforeEach(async () => { ({ home } = await freshProjectsRoot()); });
afterEach(async () => {
  await instances.shutdown();
  // shutdown() clears byId but not _idleSubscribers — purge it so stale
  // subscriptions from one test don't bleed into the next.
  instances._idleSubscribers?.clear();
  await rmrf(home);
});

let nextRpcId = 1;

async function rpc(baseUrl, method, params, { caller } = {}) {
  const id = nextRpcId++;
  // `?caller=` now carries the stable instanceId (what Instance.spawn bakes);
  // translate a caller sessionId to it. Unresolved values pass through so the
  // no-caller / bogus-caller refusal paths still fire.
  const handle = caller ? (instForSession(instances, caller)?.id ?? caller) : null;
  const url = baseUrl + '/mcp' + (handle ? `?caller=${encodeURIComponent(handle)}` : '');
  const res = await fetch(url, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ jsonrpc: '2.0', id, method, params }),
  });
  if (res.status === 202) return { status: 202, body: null };
  const body = await res.json();
  return { status: res.status, body };
}

async function callTool(name, args, opts) {
  const { body } = await rpc(baseUrl, 'tools/call', { name, arguments: args }, opts);
  assert.ok(body, 'rpc returned a response');
  assert.ok(body.result, `tools/call ${name} returned no result; body=${JSON.stringify(body)}`);
  return body.result;
}

function unwrap(result) {
  assert.ok(Array.isArray(result.content), 'tool result has content[]');
  return JSON.parse(result.content[0].text);
}

async function spawnReady(project) {
  const spawn = unwrap(await callTool('spawn_instance', {
    project, mode: 'bypassPermissions',
  }));
  await waitFor(() =>
    instForSession(instances, spawn.sessionId)?.status === 'idle',
  );
  return spawn.sessionId;
}

async function spawnReadyWithScenario(project, scenarioPath) {
  const prev = process.env.FAKE_CLAUDE_SCENARIO;
  process.env.FAKE_CLAUDE_SCENARIO = scenarioPath;
  try {
    return await spawnReady(project);
  } finally {
    process.env.FAKE_CLAUDE_SCENARIO = prev;
  }
}

function countUserEchoes(inst, predicate = () => true) {
  return inst.ringSnapshot().filter(ev => ev.kind === 'user_echo' && predicate(ev)).length;
}

function findStubFor(inst, targetId) {
  return inst.ringSnapshot().find(ev =>
    ev.kind === 'user_echo' &&
    typeof ev.text === 'string' &&
    ev.text.includes(targetId) &&
    ev.text.includes('get_recent_messages'),
  );
}

test('happy path: caller receives a stub user_echo when target hits turn_end', async () => {
  await api(baseUrl, 'POST', '/api/projects', { name: 'p' });
  const callerId = await spawnReady('p');
  const targetId = await spawnReady('p');

  const sub = unwrap(await callTool('subscribe_to_idle',
    { sessionId: targetId }, { caller: callerId }));
  assert.equal(sub.sessionId, targetId);
  assert.equal(sub.already, false);

  // Drive target through one full turn (driveTurn ensures turn_end fires
  // before we assert on caller state).
  await driveTurn(instances, targetId, () => callTool('send_prompt',
    { sessionId: targetId, text: 'go' }));

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

  await callTool('subscribe_to_idle', { sessionId: targetId }, { caller: callerId });

  // Drive the target through turn 1 of scenario-ws (emits the prose "First ").
  await driveTurn(instances, targetId, () => callTool('send_prompt',
    { sessionId: targetId, text: 'go' }));

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

  await callTool('subscribe_to_idle', { sessionId: targetId }, { caller: callerId });
  // The target self-renews (the real shape: MCP tools are auto-registered into
  // every worker, so a worker renews itself), then ends its turn → the clear fires.
  await callTool('renew_session', { summary: 'mid-assignment handoff' }, { caller: targetId });
  await callTool('send_prompt', { sessionId: targetId, text: 'go1' });

  // Catch the exact moment the one-shot is consumed and record what the target
  // looked like then. Both post-conditions are things the pre-card build could not
  // have satisfied: it consumed the subscription on the ARMED turn_end, which fires
  // BEFORE `/clear` is even sent and long before the seed is composed.
  const NEW_SID = 'c0000000-0000-4000-8000-000000000001'; // scenario-renew's post-clear sid
  let stateAtConsume = null;
  await waitFor(() => {
    if (instances._idleHub.hasSubscriber(targetInstanceId)) return false;
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
  assert.equal(instances._idleHub.hasSubscriber(targetInstanceId), false, 'one-shot consumed');
});

test('a REQUESTED renewal auto-subscribes the conductor: one wake, after the reseed', async () => {
  // Phase 2 (card 2026-0127). The targeted renew_session form declares no
  // `subscribe` parameter — a request whose acceptance-or-decline the conductor
  // never hears is useless — so there is deliberately NO subscribe_to_idle call
  // anywhere in this test. Everything else is the sibling test above: the one
  // wake must still be held across arm → /clear → reseed.
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
  assert.equal(req.subscribed, true, 'the request subscribed the conductor with no explicit call');
  assert.equal(instances._idleHub.hasSubscriber(targetInstanceId), true);

  // The worker accepts: it writes its own summary inside the turn the request
  // opened (the fixture's request turn emits nothing, so it is still open), then
  // the turn ends and the managed /clear + reseed run.
  unwrap(await callTool('renew_session', { summary: 'mid-assignment handoff' }, { caller: targetId }));
  await callTool('send_prompt', { sessionId: targetId, text: 'go1' });

  const NEW_SID = 'c0000000-0000-4000-8000-000000000001'; // the fixture's post-clear sid
  let stateAtConsume = null;
  await waitFor(() => {
    if (instances._idleHub.hasSubscriber(targetInstanceId)) return false;
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

test('subscribe_to_idle DEFERS the wake while the target has a live background Agent task', async () => {
  // The dispatch-and-wake contract: a wake means the worker AND all its
  // background subagents are done. This drives the target through a scenario
  // whose turn_end fires while a backgrounded Agent task is still open (and
  // never completes it), then confirms the caller is NOT woken — the idle
  // callback is deferred, keeping the subscription armed.
  await api(baseUrl, 'POST', '/api/projects', { name: 'p' });
  const callerId = await spawnReady('p');
  const targetId = await spawnReadyWithScenario('p', SCENARIO_BG_HANG);

  await callTool('subscribe_to_idle', { sessionId: targetId }, { caller: callerId });
  await callTool('send_prompt', { sessionId: targetId, text: 'kick off a background agent' });

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
  assert.equal(instances._idleHub.hasSubscriber(instForSession(instances, targetId).id), true,
    'a deferred turn_end must NOT consume the one-shot subscription');
});

test('subscribe_to_idle delivers exactly once after the subagent completes and a follow-up turn_end fires', async () => {
  // Same start, but the scenario completes the background task (task_updated
  // completed) and then emits a follow-up turn_end at activeAgentTasks===0 —
  // the deferred wake fires then, exactly once, with a folded stub.
  await api(baseUrl, 'POST', '/api/projects', { name: 'p' });
  const callerId = await spawnReady('p');
  const targetId = await spawnReadyWithScenario('p', SCENARIO_BG_COMPLETE);

  await callTool('subscribe_to_idle', { sessionId: targetId }, { caller: callerId });
  await callTool('send_prompt', { sessionId: targetId, text: 'kick off a background agent' });

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
  // Subscription consumed.
  assert.equal(instances._idleHub.hasSubscriber(instForSession(instances, targetId).id), false);
});

test('subscribe_to_idle defers a MID-TURN subagent completion until the re-invocation turn', async () => {
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

  await callTool('subscribe_to_idle', { sessionId: targetId }, { caller: callerId });
  // Turn 1: spawns the agent and its task_notification fires MID-TURN, so
  // activeAgentTasks is back to 0 by this turn_end.
  await callTool('send_prompt', { sessionId: targetId, text: 'kick off a background agent' });

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
  assert.equal(instances._idleHub.hasSubscriber(instForSession(instances, targetId).id), true,
    'the deferred turn_end must keep the one-shot subscription armed');

  // Turn 2 stands in for the re-invocation turn: it starts clean (flag reset on
  // turn entry) and its turn_end delivers the deferred wake exactly once.
  await callTool('send_prompt', { sessionId: targetId, text: 'process the result' });
  await waitFor(() => !!findStubFor(caller, targetId));
  assert.match(findStubFor(caller, targetId).text, /finished its turn/);

  // BARRIER: turn 2's delivery has landed, and turn 1's turn_end was asserted
  // deferred above — so both handlers have run. A duplicate from either would
  // already be queued; settle() drains it and the count becomes 2.
  await settle();
  const stubs = countUserEchoes(caller,
    ev => ev.text?.includes(targetId) && ev.text?.includes('get_recent_messages'));
  assert.equal(stubs, 1, 'delivery fires exactly once, at the re-invocation turn_end');
  assert.equal(instances._idleHub.hasSubscriber(instForSession(instances, targetId).id), false, 'subscription consumed on delivery');
});

test('subscribe_to_idle wakes at turn_end when a MID-TURN completion was consumed in-turn', async () => {
  // Regression for the indefinite-defer hang (both live repros): the
  // notification fires mid-turn but a top-level tool_result follows it within
  // the same turn — the CLI delivered the result in-turn (sync-delivered /
  // attached), so NO re-invocation turn is owed. The wake must fire at this
  // very turn_end. Pre-fix the flag stayed set (only a turn START cleared it),
  // deferring forever — the conductor hung until the 30-min watchdog.
  await api(baseUrl, 'POST', '/api/projects', { name: 'p' });
  const callerId = await spawnReady('p');
  const targetId = await spawnReadyWithScenario('p', SCENARIO_BG_CONSUMED);

  await callTool('subscribe_to_idle', { sessionId: targetId }, { caller: callerId });
  // One turn: agent launched (async ack) → task_notification MID-TURN → a
  // later Bash round-trip (the consuming top-level tool_result) → turn_end.
  await callTool('send_prompt', { sessionId: targetId, text: 'kick off a background agent' });

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
  assert.equal(instances._idleHub.hasSubscriber(instForSession(instances, targetId).id), false, 'subscription consumed on delivery');
});

test('steering: caller mid-turn at delivery gets the plain stub delivered LIVE', async () => {
  await api(baseUrl, 'POST', '/api/projects', { name: 'p' });
  // Caller runs a slow turn so it is still `status:'turn'` when the target
  // finishes — the wake is delivered LIVE into the running turn (steering) and
  // must NOT fold.
  const callerId = await spawnReadyWithScenario('p', SCENARIO_SLOW);
  const targetId = await spawnReady('p');

  await callTool('subscribe_to_idle', { sessionId: targetId }, { caller: callerId });

  // Kick the caller into its slow turn (no ?caller → no auto-subscribe).
  await callTool('send_prompt', { sessionId: callerId, text: 'busy', subscribe: false });
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
      { sessionId: targetId, text: 'go' }));
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

test('one-shot: a second target turn does not re-fire the callback', async () => {
  await api(baseUrl, 'POST', '/api/projects', { name: 'p' });
  const callerId = await spawnReady('p');
  const targetId = await spawnReady('p');

  await callTool('subscribe_to_idle',
    { sessionId: targetId }, { caller: callerId });

  // Turn 1: stub should land.
  await driveTurn(instances, targetId, () => callTool('send_prompt',
    { sessionId: targetId, text: 'one' }));
  const caller = instForSession(instances, callerId);
  await waitFor(() => !!findStubFor(caller, targetId));

  // Wait for the caller's own turn (triggered by the stub) to drain.
  await waitFor(() => caller.status === 'idle');
  const stubsAfterTurn1 = countUserEchoes(caller,
    ev => ev.text?.includes(targetId) && ev.text?.includes('get_recent_messages'));
  assert.equal(stubsAfterTurn1, 1, 'exactly one stub after turn 1');

  // Turn 2: scenario-ws has a second turn defined. Drive it and assert
  // no additional stub arrives.
  // BARRIER, in two steps, because the assertion below is a NEGATIVE one.
  // driveTurn waits for a NEW turn_end to reach the target's ring (send_prompt's
  // blocking wait option is gone as of card 2026-0187). Then wait for the
  // instance-level handler to have completed — `status === 'idle'` is set by the
  // same turn_end handling that would re-fire the callback — and settle() drains
  // the delivery it would have queued. So a re-fire is COUNTED here rather than
  // outrun by us.
  await driveTurn(instances, targetId, () => callTool('send_prompt',
    { sessionId: targetId, text: 'two' }));
  const target = instForSession(instances, targetId);
  await waitFor(() => target.status === 'idle');
  await settle();
  const stubsAfterTurn2 = countUserEchoes(caller,
    ev => ev.text?.includes(targetId) && ev.text?.includes('get_recent_messages'));
  assert.equal(stubsAfterTurn2, 1, 'subscription is one-shot — no second stub');
});

test('self-subscribe is rejected with a clear error', async () => {
  await api(baseUrl, 'POST', '/api/projects', { name: 'p' });
  const aId = await spawnReady('p');

  const result = await callTool('subscribe_to_idle',
    { sessionId: aId }, { caller: aId });
  assert.equal(result.isError, true);
  assert.match(result.content[0].text, /subscribe to self/);
});

test('missing ?caller= surfaces a clear isError result', async () => {
  await api(baseUrl, 'POST', '/api/projects', { name: 'p' });
  const targetId = await spawnReady('p');

  const { body } = await rpc(baseUrl, 'tools/call', {
    name: 'subscribe_to_idle', arguments: { sessionId: targetId },
  });
  assert.equal(body.result.isError, true);
  assert.match(body.result.content[0].text, /caller identity missing/);
});

test('caller removed before target turn_end: subscription is purged, no crash', async () => {
  await api(baseUrl, 'POST', '/api/projects', { name: 'p' });
  const callerId = await spawnReady('p');
  const targetId = await spawnReady('p');

  await callTool('subscribe_to_idle',
    { sessionId: targetId }, { caller: callerId });

  // Sanity: subscription is registered before we kill anything.
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

test('target removed before turn_end: subscription is purged', async () => {
  await api(baseUrl, 'POST', '/api/projects', { name: 'p' });
  const callerId = await spawnReady('p');
  const targetId = await spawnReady('p');

  await callTool('subscribe_to_idle',
    { sessionId: targetId }, { caller: callerId });
  assert.deepEqual(instances._idleSubscriberSnapshot(),
    { [targetId]: [callerId] });

  await callTool('kill_instance', { sessionId: targetId });
  assert.deepEqual(instances._idleSubscriberSnapshot(), {});

  // Caller is still alive and untouched.
  const caller = instForSession(instances, callerId);
  assert.equal(caller.status, 'idle');
  assert.equal(countUserEchoes(caller), 0);
});

test('unsubscribe_from_idle cancels a pending subscription', async () => {
  await api(baseUrl, 'POST', '/api/projects', { name: 'p' });
  const callerId = await spawnReady('p');
  const targetId = await spawnReady('p');

  await callTool('subscribe_to_idle',
    { sessionId: targetId }, { caller: callerId });
  const unsub = unwrap(await callTool('unsubscribe_from_idle',
    { sessionId: targetId }, { caller: callerId }));
  assert.equal(unsub.removed, true);
  assert.deepEqual(instances._idleSubscriberSnapshot(), {});

  // Driving the target now should not deliver a stub.
  // BARRIER, in two steps — see the one-shot test above for why a negative
  // assertion needs both. driveTurn gets a new turn_end into the ring; the
  // status wait means the handler that makes the fire-or-defer decision has
  // finished; settle() drains what it queued. Had the unsubscribe failed to
  // remove the pair, that handler would have queued a stub and it would be in
  // the ring for the assertion below, instead of racing us.
  await driveTurn(instances, targetId, () => callTool('send_prompt',
    { sessionId: targetId, text: 'go' }));
  const target = instForSession(instances, targetId);
  await waitFor(() => target.status === 'idle');
  await settle();
  const caller = instForSession(instances, callerId);
  assert.equal(findStubFor(caller, targetId), undefined);

  // Re-unsubscribe is idempotent (removed:false).
  const again = unwrap(await callTool('unsubscribe_from_idle',
    { sessionId: targetId }, { caller: callerId }));
  assert.equal(again.removed, false);
});

test('subscribe is idempotent: re-registering the same pair reports already:true', async () => {
  await api(baseUrl, 'POST', '/api/projects', { name: 'p' });
  const callerId = await spawnReady('p');
  const targetId = await spawnReady('p');

  const first = unwrap(await callTool('subscribe_to_idle',
    { sessionId: targetId }, { caller: callerId }));
  assert.equal(first.already, false);
  const second = unwrap(await callTool('subscribe_to_idle',
    { sessionId: targetId }, { caller: callerId }));
  assert.equal(second.already, true);
  // Still exactly one entry — the set dedupes.
  assert.deepEqual(instances._idleSubscriberSnapshot(),
    { [targetId]: [callerId] });
});

// ── timeoutMs watchdog tests ──────────────────────────────────────────────────

function findTimeoutStubFor(inst, targetId) {
  return inst.ringSnapshot().find(ev =>
    ev.kind === 'user_echo' &&
    typeof ev.text === 'string' &&
    ev.text.includes(targetId) &&
    ev.text.includes('did NOT finish'),
  );
}

test('timeoutMs: fires with a timeout stub when turn_end does not arrive in time', async () => {
  await api(baseUrl, 'POST', '/api/projects', { name: 'p' });
  const callerId = await spawnReady('p');
  const targetId = await spawnReady('p');

  // Subscribe with a short watchdog — don't drive the target so turn_end never fires.
  await callTool('subscribe_to_idle',
    { sessionId: targetId, timeoutMs: 150 }, { caller: callerId });

  const caller = instForSession(instances, callerId);
  // The 150ms watchdog fires the stub; inherit the default deadline so a
  // CPU-starved timer + async delivery still lands within the catch window.
  await waitFor(() => !!findTimeoutStubFor(caller, targetId));

  const stub = findTimeoutStubFor(caller, targetId);
  assert.ok(stub, 'timeout stub user_echo present in caller ring');
  assert.match(stub.text, /did NOT finish/);
  assert.match(stub.text, /timed out after 150ms/);
  assert.match(stub.text, /get_recent_messages/);
  assert.ok(stub.text.includes(targetId));
  // Carve-out: the timeout-watchdog stub is marked as a wake bubble but never folded.
  assert.ok(stub.text.startsWith(WAKE_CALLBACK_MARKER),
    'timeout stub is tagged as a wake-callback (renders as the bubble)');
  assert.ok(!stub.text.includes(WAKE_BODY_SEP), 'timeout stub must not fold — body-less');

  // Subscription consumed — map is empty.
  assert.deepEqual(instances._idleSubscriberSnapshot(), {});
});

test('timeoutMs: turn_end before timeout wins; timer is cancelled, only one stub delivered', async () => {
  await api(baseUrl, 'POST', '/api/projects', { name: 'p' });
  const callerId = await spawnReady('p');
  const targetId = await spawnReady('p');

  // A watchdog nothing can beat. At the previous 2000ms this test RACED
  // production's real watchdog against a real fake-CLI turn round-trip: on a
  // starved box the watchdog won and the test failed on a `did NOT finish` stub.
  //
  // Raising it costs nothing that existed. The old "timer was cancelled"
  // assertion below was ALREADY vacuous: subscribe→stub→300ms lands around
  // 800ms, well inside the 2000ms window, so an UNCANCELLED watchdog would not
  // have fired within the observation window either.
  await callTool('subscribe_to_idle',
    { sessionId: targetId, timeoutMs: 600_000 }, { caller: callerId });

  // Drive the target to turn_end before the watchdog fires.
  await driveTurn(instances, targetId, () => callTool('send_prompt',
    { sessionId: targetId, text: 'go' }));

  const caller = instForSession(instances, callerId);
  await waitFor(() => !!findStubFor(caller, targetId));

  const completionStub = findStubFor(caller, targetId);
  assert.ok(completionStub, 'completion stub present');
  assert.match(completionStub.text, /finished its turn/);
  // Must NOT say "did NOT finish".
  assert.doesNotMatch(completionStub.text, /did NOT finish/);

  // Barrier: the delivery decision is already made (findStubFor above resolved,
  // so turn_end was processed and the stub was written to the ring). settle()
  // then drains anything that decision queued. A second delivery would have to
  // be scheduled by that same drained work, so it would be in the ring here.
  await settle();
  const allStubs = caller.ringSnapshot().filter(ev =>
    ev.kind === 'user_echo' && ev.text?.includes(targetId));
  assert.equal(allStubs.length, 1, 'exactly one stub delivered for this pair');

  // HONEST PINNING NOTE. This test does NOT prove the watchdog timer was
  // cleared — with a 600s window an uncancelled timer is indistinguishable from
  // a cancelled one here. Nor does the empty snapshot below prove it: on this
  // path the map removal runs BEFORE the clearTimeout, so the snapshot is empty
  // under a mutation that drops the clearTimeout entirely. The site is pinned by
  // the bounded-window negative further down ('a turn_end DELIVERY clears the
  // watchdog'), whose observation window an uncancelled timer cannot survive.
  //
  // It is explicitly NOT pinned by the handle-leak guard. The watchdog timer is
  // .unref()'d (src/idleSubscriptions.ts, `a lone watchdog must not keep the
  // event loop alive`), and Node v24's process._getActiveHandles() does not
  // report timers at all — so an uncancelled watchdog holds nothing open and is
  // invisible to tests/handleLeakGuard.mjs. Do not "restore" that coupling.
  assert.deepEqual(instances._idleSubscriberSnapshot(), {},
    'the subscription is consumed — the same branch that removes it clears the timer');
});

// ── list() hasIdleSubscriber semantics ───────────────────────────────────────

test('list() sets hasIdleSubscriber on the caller (conductor), not the target (worker)', async () => {
  await api(baseUrl, 'POST', '/api/projects', { name: 'p' });
  const callerId = await spawnReady('p');
  const targetId = await spawnReady('p');

  // Before subscribe: both false.
  let listed = instances.list();
  assert.equal(listed.find(i => i.sessionId === callerId)?.hasIdleSubscriber, false);
  assert.equal(listed.find(i => i.sessionId === targetId)?.hasIdleSubscriber, false);

  // After subscribe: caller=true, target=false.
  await callTool('subscribe_to_idle',
    { sessionId: targetId }, { caller: callerId });
  listed = instances.list();
  assert.equal(listed.find(i => i.sessionId === callerId)?.hasIdleSubscriber, true,
    'caller (conductor) must show hasIdleSubscriber:true while awaiting');
  assert.equal(listed.find(i => i.sessionId === targetId)?.hasIdleSubscriber, false,
    'target (worker) must NOT show hasIdleSubscriber:true');

  // After the subscription fires (target completes a turn): caller goes false.
  await driveTurn(instances, targetId, () => callTool('send_prompt',
    { sessionId: targetId, text: 'go' }));
  const caller = instForSession(instances, callerId);
  await waitFor(() => !!findStubFor(caller, targetId));
  listed = instances.list();
  assert.equal(listed.find(i => i.sessionId === callerId)?.hasIdleSubscriber, false,
    'hasIdleSubscriber must be false after subscription is consumed');
  assert.equal(listed.find(i => i.sessionId === targetId)?.hasIdleSubscriber, false);
});

test('list() hasIdleSubscriber goes false after unsubscribe', async () => {
  await api(baseUrl, 'POST', '/api/projects', { name: 'p' });
  const callerId = await spawnReady('p');
  const targetId = await spawnReady('p');

  await callTool('subscribe_to_idle',
    { sessionId: targetId }, { caller: callerId });
  assert.equal(instances.list().find(i => i.sessionId === callerId)?.hasIdleSubscriber, true);

  await callTool('unsubscribe_from_idle',
    { sessionId: targetId }, { caller: callerId });
  assert.equal(instances.list().find(i => i.sessionId === callerId)?.hasIdleSubscriber, false,
    'hasIdleSubscriber must be false after manual unsubscribe');
});

// ── watchdog-cancellation: TWO negatives and ONE shared positive control ─────
//
// There are two distinct sites that must cancel a pending watchdog timer: the
// unsubscribe path, and the turn_end DELIVERY path. Each gets a negative below.
//
// "No stub arrived" proves the timer was cancelled ONLY if a stub would
// otherwise have arrived in the same window. The single positive control below
// establishes exactly that — an armed watchdog with these constants DOES fire
// inside this observation window — so neither negative can decay into a vacuous
// green. If the watchdog stops firing for any unrelated reason, the control goes
// red and says so.
//
// All three cases MUST share these two constants. Splitting them is what would
// let the group drift apart and silently stop being a control.
const WATCHDOG_MS = 1500;
// Strictly greater than the watchdog, so the window provably elapses: an
// uncancelled timer has necessarily fired by the time we assert.
const OBSERVE_MS = WATCHDOG_MS + 600;

// 1500ms rather than the original 150ms because the original flake was a
// >150ms stall between the subscribe and unsubscribe round-trips on a starved
// box — a 10x margin for two localhost HTTP calls. This is a genuine wall-clock
// dependence and cannot be removed without a fake clock (an src/ change, out of
// scope for this card): the assertion is "the timer did not fire", which
// requires giving it a real chance to fire. Same reason the `watchdog fires`
// test above keeps a short window. If this ever flakes, the answer is a
// different assertion, not a bigger number.
test('timeoutMs: unsubscribe clears the watchdog timer — no stub delivered after unsubscribe', async () => {
  await api(baseUrl, 'POST', '/api/projects', { name: 'p' });
  const callerId = await spawnReady('p');
  const targetId = await spawnReady('p');

  await callTool('subscribe_to_idle',
    { sessionId: targetId, timeoutMs: WATCHDOG_MS }, { caller: callerId });

  // Unsubscribe immediately — should clear the timer.
  const unsub = unwrap(await callTool('unsubscribe_from_idle',
    { sessionId: targetId }, { caller: callerId }));
  assert.equal(unsub.removed, true);
  assert.deepEqual(instances._idleSubscriberSnapshot(), {});

  // Outlive the window, then drain: an uncancelled watchdog has fired by now,
  // and settle() ensures its queued delivery would have reached the ring.
  await new Promise(r => setTimeout(r, OBSERVE_MS));
  await settle();

  const caller = instForSession(instances, callerId);
  assert.equal(findTimeoutStubFor(caller, targetId), undefined,
    'no timeout stub after unsubscribe');
  assert.equal(findStubFor(caller, targetId), undefined,
    'no completion stub either');
});

test('timeoutMs: control — WITHOUT unsubscribe the same watchdog does fire in the same window', async () => {
  // The negative above is only meaningful because of this. Identical setup and
  // identical observation window; the ONLY difference is that nothing
  // unsubscribes. If this ever fails, the negative above has become vacuous and
  // must not be trusted.
  await api(baseUrl, 'POST', '/api/projects', { name: 'p' });
  const callerId = await spawnReady('p');
  const targetId = await spawnReady('p');

  await callTool('subscribe_to_idle',
    { sessionId: targetId, timeoutMs: WATCHDOG_MS }, { caller: callerId });

  const caller = instForSession(instances, callerId);
  // Bounded by the SAME window the negative waits out, not by waitFor's default
  // 10s deadline: the claim being controlled is "a stub arrives inside that
  // window", so a stub that only showed up at 8s would not justify the negative.
  await waitFor(() => !!findTimeoutStubFor(caller, targetId), { timeout: OBSERVE_MS });

  assert.match(findTimeoutStubFor(caller, targetId).text, /did NOT finish/);
  assert.deepEqual(instances._idleSubscriberSnapshot(), {},
    'the fired watchdog consumes the subscription');
});

test('timeoutMs: a turn_end DELIVERY clears the watchdog — no spurious timeout stub follows', async () => {
  // The second cancellation site, and the one with no coverage at all before
  // this test: the turn_end delivery path's clearTimeout. Deleting it changed
  // nothing anywhere in the suite.
  //
  // It cannot be pinned by an empty subscriber snapshot: the map removal happens
  // BEFORE the clearTimeout on that path, so the snapshot is empty either way.
  // And it cannot be pinned by the handle-leak guard: the watchdog is
  // .unref()'d, so an uncancelled one holds nothing open. The only observable is
  // the spurious stub it later delivers — the timer callback calls deliver()
  // UNCONDITIONALLY, without re-checking that the subscription is still live.
  //
  // Production consequence if it regresses: after a wake has already been
  // delivered, the conductor gets a second, false "did NOT finish — timed out"
  // stub up to the subscribe timeout later.
  await api(baseUrl, 'POST', '/api/projects', { name: 'p' });
  const callerId = await spawnReady('p');
  const targetId = await spawnReady('p');

  await callTool('subscribe_to_idle',
    { sessionId: targetId, timeoutMs: WATCHDOG_MS }, { caller: callerId });

  // Let turn_end win the race and deliver the wake. findStubFor resolving IS the
  // barrier that the delivery path ran.
  const caller = instForSession(instances, callerId);
  await driveTurn(instances, targetId, () => callTool('send_prompt',
    { sessionId: targetId, text: 'go' }));
  await waitFor(() => !!findStubFor(caller, targetId));
  assert.doesNotMatch(findStubFor(caller, targetId).text, /did NOT finish/,
    'the delivered stub must be the completion one, not a timeout — if this fails the ' +
    'watchdog beat the turn and the window needs re-examining, not widening');

  // Outlive the window: an uncancelled watchdog has fired by now.
  await new Promise(r => setTimeout(r, OBSERVE_MS));
  await settle();

  assert.equal(findTimeoutStubFor(caller, targetId), undefined,
    'no timeout stub may follow a delivered wake — the delivery must have cleared the watchdog');
  const allStubs = caller.ringSnapshot().filter(ev =>
    ev.kind === 'user_echo' && ev.text?.includes(targetId));
  assert.equal(allStubs.length, 1, 'exactly one stub for this pair, ever');
});

// ── auto-subscribe folded into send_prompt / approve_plan / reject_plan /
//    answer_question ──────────────────────────────────────────────────────

test('send_prompt default (subscribe unset) auto-subscribes the caller', async () => {
  await api(baseUrl, 'POST', '/api/projects', { name: 'p' });
  const callerId = await spawnReady('p');
  const targetId = await spawnReady('p');

  const res = unwrap(await callTool('send_prompt',
    { sessionId: targetId, text: 'go' }, { caller: callerId }));
  assert.equal(res.subscribed, true);
  assert.equal(res.already, false);

  const caller = instForSession(instances, callerId);
  await waitFor(() => !!findStubFor(caller, targetId));
  assert.ok(findStubFor(caller, targetId), 'stub delivered from the auto-registered subscription');
});

test('send_prompt subscribe:false does not register a subscription', async () => {
  await api(baseUrl, 'POST', '/api/projects', { name: 'p' });
  const callerId = await spawnReady('p');
  const targetId = await spawnReady('p');

  const res = unwrap(await callTool('send_prompt',
    { sessionId: targetId, text: 'go', subscribe: false },
    { caller: callerId }));
  assert.equal(res.subscribed, false);
  assert.equal(res.subscribeSkipped, undefined);
  assert.deepEqual(instances._idleSubscriberSnapshot(), {});

  const target = instForSession(instances, targetId);
  await waitFor(() => target.status === 'idle');
  const caller = instForSession(instances, callerId);
  // BARRIER: `target.status === 'idle'` above means the turn_end handler ran.
  // Had subscribe:false still registered a subscription, that handler would have
  // queued a stub; settle() drains it into the ring so its absence here is a
  // real result rather than a fast box.
  await settle();
  assert.equal(findStubFor(caller, targetId), undefined, 'no stub without a subscription');
});

test('send_prompt with no caller still succeeds; subscribed:false, subscribeSkipped:no-caller', async () => {
  await api(baseUrl, 'POST', '/api/projects', { name: 'p' });
  const targetId = await spawnReady('p');

  // No `caller` opt — the MCP URL carries no ?caller=.
  const res = unwrap(await callTool('send_prompt', { sessionId: targetId, text: 'go' }));
  assert.equal(res.sessionId, targetId);
  assert.equal(res.subscribed, false);
  assert.equal(res.subscribeSkipped, 'no-caller');
});

test('approve_plan auto-subscribes the caller by default', async () => {
  await api(baseUrl, 'POST', '/api/projects', { name: 'p' });
  const callerId = await spawnReady('p');
  const targetId = await spawnReady('p');

  const res = unwrap(await callTool('approve_plan',
    { sessionId: targetId }, { caller: callerId }));
  assert.equal(res.subscribed, true);
  assert.equal(res.already, false);

  const caller = instForSession(instances, callerId);
  await waitFor(() => !!findStubFor(caller, targetId));
});

test('reject_plan auto-subscribes the caller by default', async () => {
  await api(baseUrl, 'POST', '/api/projects', { name: 'p' });
  const callerId = await spawnReady('p');
  const targetId = await spawnReady('p');

  const res = unwrap(await callTool('reject_plan',
    { sessionId: targetId, feedback: 'simpler please' }, { caller: callerId }));
  assert.equal(res.subscribed, true);
  assert.equal(res.already, false);

  const caller = instForSession(instances, callerId);
  await waitFor(() => !!findStubFor(caller, targetId));
});

test('answer_question auto-subscribes the caller by default', async () => {
  await api(baseUrl, 'POST', '/api/projects', { name: 'p' });
  const callerId = await spawnReady('p');

  // Spawn the target against the question scenario so it has a pending
  // AskUserQuestion to answer (scenario-ws, this file's default, never asks).
  const prevScenario = process.env.FAKE_CLAUDE_SCENARIO;
  process.env.FAKE_CLAUDE_SCENARIO = SCENARIO_QUESTION;
  let targetId;
  try {
    targetId = await spawnReady('p');
    await driveTurn(instances, targetId, () => callTool('send_prompt', { sessionId: targetId, text: 'go', subscribe: false }));
  } finally {
    process.env.FAKE_CLAUDE_SCENARIO = prevScenario;
  }
  const target = instForSession(instances, targetId);
  await waitFor(() => target.ringSnapshot().some(ev => ev.kind === 'user_question'));

  const res = unwrap(await callTool('answer_question',
    { sessionId: targetId, answers: [{ option: 'Apple' }] }, { caller: callerId }));
  assert.equal(res.subscribed, true);
  assert.equal(res.already, false);

  const caller = instForSession(instances, callerId);
  await waitFor(() => !!findStubFor(caller, targetId));
});
