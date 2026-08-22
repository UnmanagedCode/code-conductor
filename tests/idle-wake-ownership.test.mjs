// Integration tests for idle wake by OWNERSHIP.
//
// The contract under test, in one sentence: an owned session enters a turn,
// therefore its owner is woken when that turn ends. Ownership is spawn
// (`callerInstanceId`) OR dispatch (any turn-starting MCP call), the arm happens
// on the transition INTO `turn`, and there is no register verb and no opt-out.
// When the *target* hits turn_end a stub user prompt lands in the *owner* (via
// Instance.prompt(), the same path WS / auto-approve use). Caller identity is
// read from `?caller=<id>` on the MCP URL. Alongside the armed wake runs a
// repeating heartbeat that reports "did NOT finish" WITHOUT consuming it.
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
import { DEFAULT_SUBSCRIBE_TIMEOUT_MS } from '../src/idleSubscriptions.ts';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const SCENARIO_WS = path.join(__dirname, 'fixtures', 'scenario-ws.json');
const SCENARIO_QUESTION = path.join(__dirname, 'fixtures', 'scenario-question.json');
const SCENARIO_SLOW = path.join(__dirname, 'fixtures', 'scenario-slow-turn.json');
const SCENARIO_BG_HANG = path.join(__dirname, 'fixtures', 'scenario-bg-task-hang.json');
const SCENARIO_BG_COMPLETE = path.join(__dirname, 'fixtures', 'scenario-bg-task-complete.json');
const SCENARIO_BG_MIDTURN = path.join(__dirname, 'fixtures', 'scenario-bg-task-midturn-complete.json');
const SCENARIO_BG_CONSUMED = path.join(__dirname, 'fixtures', 'scenario-bg-task-midturn-consumed.json');
// A turn that stays open ~1s and then ends on its own (delay_ms spaces every
// event), so a short heartbeat can fire several times inside one real turn.
const SCENARIO_PACED = path.join(__dirname, 'fixtures', 'scenario-paced-turn.json');
// Same turn, 800ms between events, so the mid-turn span is ~4s. Used where the
// assertion needs SEVERAL heartbeats inside one turn: with a bounded span the
// budget for them is the span itself, not waitFor's timeout, and a starved event
// loop coalesces missed setInterval fires rather than replaying them — so a wide
// SPAN is the only thing that buys schedule tolerance. A window count does not:
// halving the interval doubles the windows but survives no longer a stall.
const SCENARIO_LONG = path.join(__dirname, 'fixtures', 'scenario-long-turn.json');
// The paced turn, but the fake swallows `interrupt` control_requests instead of
// auto-ACKing — the only way to stage a REAL _controlRequest timeout end to end.
const SCENARIO_NO_ACK = path.join(__dirname, 'fixtures', 'scenario-no-interrupt-ack.json');
// A turn parked mid-text-block that never ends on its own — a SOFT interrupt
// never reaches an output boundary on it — plus an interrupt turn, so a FORCED
// interrupt produces the turn_end a real forced abort produces.
const SCENARIO_OPEN = path.join(__dirname, 'fixtures', 'scenario-open-turn.json');
// ONE prompt, TWO CLI turns: the second message_start has no prompt behind it.
const SCENARIO_UNPROMPTED = path.join(__dirname, 'fixtures', 'scenario-unprompted-second-turn.json');
// prompt opens a turn holding a live background Agent; the forced abort's own
// turn_end therefore DEFERS, the task drains, and an UNPROMPTED re-invocation
// turn's turn_end is where the deferred wake finally resolves.
const SCENARIO_ABORT_DEFER = path.join(__dirname, 'fixtures', 'scenario-abort-defer-reinvoke.json');
// Same open turn, but the abort's turn_end STAYS deferred — the drain and the
// following turn are gated behind a fresh 'again' prompt, so a new instruction is
// what moves the deferred wake on.
const SCENARIO_ABORT_DEFER_THEN_PROMPT = path.join(__dirname, 'fixtures', 'scenario-abort-defer-then-prompt.json');

let ctx, baseUrl, instances, home;
before(async () => { ctx = await bootServer({ scenarioPath: SCENARIO_WS }); ({ baseUrl, instances } = ctx); });
after(async () => { await ctx.close(); });
beforeEach(async () => { ({ home } = await freshProjectsRoot()); });
afterEach(async () => {
  await instances.shutdown();
  // shutdown() clears byId but not the hub's maps — purge both so neither a
  // stale armed wake nor a stale ownership edge bleeds into the next test.
  instances._idleSubscribers?.clear();
  instances._idleHub?._owners.clear();
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

// Arm a wake without running a turn: `noteDispatch` records the ownership edge
// and `onTurnStart` is the exact call Instance._setStatus makes when a turn
// begins. Used only where the target must STAY idle for the case under test.
function armWake(callerSid, targetSid, timeoutMs) {
  instances.noteDispatch(callerSid, targetSid, timeoutMs);
  instances._idleHub.onTurnStart(instForSession(instances, targetSid).id);
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

test('a self-directed set_idle_timeout is rejected with a clear error', async () => {
  await api(baseUrl, 'POST', '/api/projects', { name: 'p' });
  const aId = await spawnReady('p');

  const result = await callTool('set_idle_timeout',
    { sessionId: aId, timeoutMs: 1000 }, { caller: aId });
  assert.equal(result.isError, true);
  assert.match(result.content[0].text, /wait on self/);
});

test('missing ?caller= surfaces a clear isError result', async () => {
  await api(baseUrl, 'POST', '/api/projects', { name: 'p' });
  const targetId = await spawnReady('p');

  const { body } = await rpc(baseUrl, 'tools/call', {
    name: 'set_idle_timeout', arguments: { sessionId: targetId, timeoutMs: 1000 },
  });
  assert.equal(body.result.isError, true);
  assert.match(body.result.content[0].text, /caller identity missing/);
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
    { sessionId: targetId, text: 'go', idleTimeoutMs: 150 }, { caller: callerId });
  await waitFor(() => target.status === 'turn');

  const soft = unwrap(await callTool('interrupt_turn', { sessionId: targetId }));
  assert.equal(soft.interrupting, true, 'ARMED, not stopped');
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
    { sessionId: targetId, text: 'one', idleTimeoutMs: 150 }, { caller: callerId });
  await waitFor(() => target.status === 'turn');
  // The mid-turn steer is the second arm attempt for the same pair.
  await callTool('send_prompt',
    { sessionId: targetId, text: 'two', idleTimeoutMs: 150 }, { caller: callerId });
  assert.equal(instances._idleSubscribers.get(target.id).size, 1, 'one entry for the pair');

  // BARRIER: the paced fixture ends the turn on its own, and that turn_end is what
  // clears the interval the map holds.
  await waitFor(() => target.status === 'idle');
  await waitFor(() => !!findCompletionStubFor(caller, targetId));
  await settle();
  const atEnd = beats();

  // A second, orphaned interval would fire several more times in this window.
  await new Promise(r => setTimeout(r, 150 * 5));
  await settle();
  assert.equal(beats(), atEnd,
    'the turn_end cleared EVERY interval for the pair — a leaked second one keeps pinging');
  assert.equal(instances._idleHub.hasArmedWake(target.id), false);
});

test('a dispatch with no idleTimeoutMs preserves an earlier set_idle_timeout preference', async () => {
  // The docblock on _recordOwner promises this: an absent/invalid timeoutMs leaves
  // the owner's stored window intact rather than silently resetting it to the
  // default. Without the intervening dispatch the fallback is never exercised.
  await api(baseUrl, 'POST', '/api/projects', { name: 'p' });
  const callerId = await spawnReady('p');
  const targetId = await spawnReadyWithScenario('p', SCENARIO_OPEN);
  const target = instForSession(instances, targetId);
  const caller = instForSession(instances, callerId);

  const set = unwrap(await callTool('set_idle_timeout',
    { sessionId: targetId, timeoutMs: 5_000 }, { caller: callerId }));
  assert.equal(set.armed, false, 'target idle, so nothing to re-arm — preference only');

  // A plain dispatch, carrying NO idleTimeoutMs.
  await callTool('send_prompt', { sessionId: targetId, text: 'go' }, { caller: callerId });
  await waitFor(() => target.status === 'turn');
  await waitFor(() => instances._idleHub.hasArmedWake(target.id));
  assert.equal(instances._idleSubscribers.get(target.id).get(caller.id).timeoutMs, 5_000,
    'the turn armed on the STORED window, not on the default');
});

// ── heartbeat tests ──────────────────────────────────────────────────────────

// Count heartbeat deliveries for one target AT THE HUB. "The heartbeat keeps
// firing" is a statement about the interval, and routing that observation through
// the caller's fake subprocess (deliver → prompt → stdin → user_echo → ring) puts
// four contention-sensitive hops between the fact and the assertion — measured:
// two of eight concurrent copies of this file timed out at 20s waiting for an echo
// whose beat had almost certainly fired. Where the assertion is about the timer,
// watch the timer. Where it is about the conductor actually being TOLD (the
// repeat pin), the echo is the point and stays.
function watchBeats(hub, targetInstanceId) {
  const real = hub.deliver.bind(hub);
  const state = { n: 0, restore() { hub.deliver = real; } };
  hub.deliver = (callerId, tid, opts) => {
    if (tid === targetInstanceId && opts?.timedOut) state.n++;
    return real(callerId, tid, opts);
  };
  return state;
}

// A COMPLETION stub specifically — findStubFor matches any wake naming the
// target, heartbeat pings included.
function findCompletionStubFor(inst, targetId) {
  return inst.ringSnapshot().find(ev =>
    ev.kind === 'user_echo' &&
    typeof ev.text === 'string' &&
    ev.text.includes(targetId) &&
    ev.text.includes('finished its turn'),
  );
}

function findInterruptedStubFor(inst, targetId) {
  return inst.ringSnapshot().find(ev =>
    ev.kind === 'user_echo' &&
    typeof ev.text === 'string' &&
    ev.text.includes(targetId) &&
    ev.text.includes('was INTERRUPTED'),
  );
}

function findTimeoutStubFor(inst, targetId) {
  return inst.ringSnapshot().find(ev =>
    ev.kind === 'user_echo' &&
    typeof ev.text === 'string' &&
    ev.text.includes(targetId) &&
    ev.text.includes('did NOT finish'),
  );
}

// ── REQUIRED PIN 1: the heartbeat repeats, reports, and consumes NOTHING ─────

test('the heartbeat repeats without consuming, and the real turn_end wake still lands', async () => {
  // Three things pinned together, because they are one behaviour: the ping
  // REPEATS (a setTimeout one-shot fires once and this fails at >=2), it does not
  // self-consume (the armed wake is still there between pings), and the turn_end
  // wake it was reporting about still arrives when the turn finally ends — then
  // the interval stops.
  await api(baseUrl, 'POST', '/api/projects', { name: 'p' });
  const callerId = await spawnReady('p');
  // ~4s of mid-turn span at a 150ms window. The two beats this needs must both
  // land BEFORE the turn ends, so the span is the real budget — 150ms × 2 inside
  // 4000ms tolerates a stall of nearly 2s per beat. On the old ~1s span it was
  // ~350ms, and that is the margin that flaked under a loaded machine.
  const targetId = await spawnReadyWithScenario('p', SCENARIO_LONG);
  const target = instForSession(instances, targetId);
  const caller = instForSession(instances, callerId);

  await callTool('send_prompt',
    { sessionId: targetId, text: 'go', idleTimeoutMs: 150 }, { caller: callerId });
  await waitFor(() => target.status === 'turn');

  const beats = () => countUserEchoes(caller,
    ev => ev.text?.includes(targetId) && ev.text?.includes('did NOT finish'));
  await waitFor(() => beats() >= 2, { timeout: 20000 });
  const stub = findTimeoutStubFor(caller, targetId);
  assert.match(stub.text, /did NOT finish/);
  assert.match(stub.text, /timed out after 150ms/);
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
  await new Promise(r => setTimeout(r, 150 * 4));
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
    { sessionId: targetId, text: 'go', idleTimeoutMs: 600_000 }, { caller: callerId }));

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
// 24-way starvation is a ~32x margin. Re-measure before shrinking it.
const HEARTBEAT_MS = 1500;
// Strictly greater than the window, so it provably elapses: an uncleared interval
// has necessarily fired by the time we assert.
const OBSERVE_MS = HEARTBEAT_MS + 600;

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
    { sessionId: targetId, text: 'go', idleTimeoutMs: HEARTBEAT_MS }, { caller: callerId }));
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
    { sessionId: targetId, text: 'go', idleTimeoutMs: HEARTBEAT_MS }, { caller: callerId });
  await waitFor(() => target.status === 'turn');
  // Bounded by the SAME window the negative waits out, not waitFor's 10s default:
  // the claim being controlled is "a stub arrives inside that window".
  await waitFor(() => !!findTimeoutStubFor(caller, targetId), { timeout: OBSERVE_MS });
  assert.match(findTimeoutStubFor(caller, targetId).text, /did NOT finish/);
});

test('set_idle_timeout re-arms a RUNNING heartbeat', async () => {
  // Recording the preference without re-arming would make the tool useless in its
  // only real use case — mid-turn, on a worker already running long. With the
  // re-arm missing, the 30s window below never elapses inside the test and the
  // waitFor times out.
  await api(baseUrl, 'POST', '/api/projects', { name: 'p' });
  const callerId = await spawnReady('p');
  const targetId = await spawnReadyWithScenario('p', SCENARIO_OPEN);
  const target = instForSession(instances, targetId);
  const caller = instForSession(instances, callerId);

  await callTool('send_prompt',
    { sessionId: targetId, text: 'go', idleTimeoutMs: 30_000 }, { caller: callerId });
  await waitFor(() => target.status === 'turn');
  await waitFor(() => instances._idleHub.hasArmedWake(target.id));
  assert.equal(instances._idleSubscribers.get(target.id).get(caller.id).timeoutMs, 30_000);

  const res = unwrap(await callTool('set_idle_timeout',
    { sessionId: targetId, timeoutMs: 120 }, { caller: callerId }));
  assert.equal(res.armed, true, 'a live heartbeat was re-armed, not just recorded');
  assert.equal(instances._idleSubscribers.get(target.id).get(caller.id).timeoutMs, 120);
  await waitFor(() => !!findTimeoutStubFor(caller, targetId), { timeout: 3000 });
});

test('set_idle_timeout on an idle target records the preference and reports armed:false', async () => {
  await api(baseUrl, 'POST', '/api/projects', { name: 'p' });
  const callerId = await spawnReady('p');
  const targetId = await spawnReady('p');

  const res = unwrap(await callTool('set_idle_timeout',
    { sessionId: targetId, timeoutMs: 5_000 }, { caller: callerId }));
  assert.equal(res.sessionId, targetId);
  assert.equal(res.armed, false, 'nothing is armed while the target is idle');
  assert.deepEqual(instances._idleSubscriberSnapshot(), {});
  // …but the preference is what the NEXT turn arms on.
  const target = instForSession(instances, targetId);
  instances._idleHub.onTurnStart(target.id);
  assert.equal(instances._idleSubscribers.get(target.id)
    .get(instForSession(instances, callerId).id).timeoutMs, 5_000);
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
    { sessionId: targetId, text: 'go', idleTimeoutMs: 150 }, { caller: callerId });
  await waitFor(() => target.status === 'turn');
  await waitFor(() => instances._idleHub.hasArmedWake(target.id));

  const res = unwrap(await callTool('interrupt_turn',
    { sessionId: targetId }, { caller: callerId }));
  assert.equal(res.interrupting, true, 'ARMED, not stopped');
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

// The qualifier is latched BEFORE the control_request await, because the ACK and
// the abort's own `result` can arrive in one stdout chunk and node:readline
// dispatches every line of a chunk synchronously — set it afterwards and that
// turn_end reads false. The rollback is what makes set-before safe, but it must
// distinguish the rejection modes: only some of them mean "the abort did not
// land". The fake CLI auto-ACKs every control_request regardless of scenario
// turns, so the rejection is injected at _controlRequest — exactly the seam the
// real timer rejects at.
for (const mode of [
  {
    name: 'an explicit REFUSAL rolls the qualifier back — the abort provably did not land',
    // What `ok:false`, dead stdin and `subprocess exited` all produce: no
    // `timedOut` marker, and a definite negative.
    err: () => new Error('control_request failed'),
    expectFlag: false,
    expectStub: /finished its turn/,
    rejectStub: /was INTERRUPTED/,
    why: 'the turn ran on and finished, so that is what the owner is told',
  },
  {
    name: 'a TIMEOUT leaves the qualifier set — the outcome is unknown, not negative',
    // The 5s timer deletes _pending before rejecting, so a CLI that honours the
    // interrupt and ACKs at 6s is silently dropped: we do not know. The two error
    // directions are not symmetric — a false INTERRUPTED costs some re-driving of
    // good work, a false "finished" hands the conductor partial output as a
    // complete result — so an unknown outcome reports pessimistically.
    err: () => Object.assign(new Error('control_request timeout'), { timedOut: true }),
    expectFlag: true,
    expectStub: /was INTERRUPTED/,
    rejectStub: /finished its turn/,
    why: 'unknown resolves to the pessimistic report, not the dangerous one',
  },
]) {
  test(mode.name, async () => {
    await api(baseUrl, 'POST', '/api/projects', { name: 'p' });
    const callerId = await spawnReady('p');
    const targetId = await spawnReadyWithScenario('p', SCENARIO_PACED);
    const target = instForSession(instances, targetId);
    const caller = instForSession(instances, callerId);

    await callTool('send_prompt', { sessionId: targetId, text: 'go' }, { caller: callerId });
    await waitFor(() => target.status === 'turn');

    const real = target._controlRequest;
    target._controlRequest = async () => { throw mode.err(); };
    await assert.rejects(() => target.interrupt({ force: true }));
    target._controlRequest = real;
    assert.equal(target.turnForceAborted, mode.expectFlag, mode.why);

    // The paced turn was never actually aborted, so it runs to completion — and
    // whichever way the flag went is what its wake reports.
    const stub = await waitFor(() => findStubFor(caller, targetId));
    assert.match(stub.text, mode.expectStub);
    assert.doesNotMatch(stub.text, mode.rejectStub);
    // Either way the pessimism is BOUNDED to that one turn: the turn start that
    // follows finds no surviving wake and clears.
    await driveTurn(instances, targetId,
      () => callTool('send_prompt', { sessionId: targetId, text: 'next' }, { caller: callerId }));
    assert.equal(target.turnForceAborted, false, 'never leaks into a later turn');
  });
}

test('a REAL unanswered interrupt times out and still leaves the qualifier set', async () => {
  // The two cases above inject the rejection at _controlRequest, so neither
  // exercises the marker's SOURCE: drop `timedOut` from the real 5s timer and they
  // both still pass while a genuine timeout silently rolls back. This one goes
  // through the wire — the fixture's `swallow_control` makes the fake never ACK —
  // and so pins the whole chain: timer fires → marker set → rollback declines.
  // It costs one real 5s wait, which is why it is the only test that pays it.
  await api(baseUrl, 'POST', '/api/projects', { name: 'p' });
  const callerId = await spawnReady('p');
  const targetId = await spawnReadyWithScenario('p', SCENARIO_NO_ACK);
  const target = instForSession(instances, targetId);
  const caller = instForSession(instances, callerId);

  await callTool('send_prompt', { sessionId: targetId, text: 'go' }, { caller: callerId });
  await waitFor(() => target.status === 'turn');
  await assert.rejects(() => target.interrupt({ force: true }), /timeout/i);
  assert.equal(target.turnForceAborted, true,
    'a real timeout is an UNKNOWN outcome — it must not roll back to "not aborted"');

  const stub = await waitFor(() => findStubFor(caller, targetId));
  assert.match(stub.text, /was INTERRUPTED/);
});

// ── the abort qualifier's LIFETIME: cleared too early vs never cleared ────────

test('the abort qualifier survives an UNPROMPTED re-invocation turn that resolves its deferred wake', async () => {
  // _onTurnEnd defers an abort's wake while a subagent is live or a task
  // notification is queued, and the CLI resolves that by opening an unprompted
  // re-invocation turn. Clearing the qualifier at every turn START — which looked
  // like the obviously-safe place — wipes it along exactly that trace, BEFORE the
  // wake it qualifies has been delivered, so the owner is told a killed turn
  // finished. The paired test below is what makes this one meaningful: alone it
  // cannot distinguish "correctly preserved" from "never cleared at all".
  await api(baseUrl, 'POST', '/api/projects', { name: 'p' });
  const callerId = await spawnReady('p');
  const targetId = await spawnReadyWithScenario('p', SCENARIO_ABORT_DEFER);
  const target = instForSession(instances, targetId);
  const caller = instForSession(instances, callerId);

  await callTool('send_prompt', { sessionId: targetId, text: 'go' }, { caller: callerId });
  await waitFor(() => target.status === 'turn');
  await waitFor(() => target.activeAgentTaskCount > 0);
  await waitFor(() => instances._idleHub.hasArmedWake(target.id));

  // The UI door, so nobody is disarmed and the owner is still armed to be told.
  await target.interrupt({ force: true });

  // The aborted turn's own turn_end lands first and must NOT consume the wake.
  await waitFor(() => target.ringSnapshot().filter(ev => ev.kind === 'turn_end').length >= 1);
  assert.equal(instances._idleHub.hasArmedWake(target.id), true,
    'precondition: the abort\'s turn_end deferred on the live background task');
  assert.equal(findStubFor(caller, targetId), undefined, 'and delivered nothing yet');

  // …then the re-invocation turn runs, and ITS turn_end resolves the wake.
  await waitFor(() => target.ringSnapshot().filter(ev => ev.kind === 'turn_end').length >= 2);
  const stub = await waitFor(() => findStubFor(caller, targetId));
  assert.match(stub.text, /was INTERRUPTED/,
    'the qualifier outlived the unprompted turn that resolved its wake');
  assert.doesNotMatch(stub.text, /finished its turn/);
  await settle();
  assert.equal(countUserEchoes(caller,
    ev => ev.text?.includes(targetId) && ev.text?.includes('get_recent_messages')), 1);
});

test('an unprompted turn after a DISARMED abort is reported on its own terms', async () => {
  // The hole neither of the other two clears reaches. A SOLE owner forces the
  // abort, so its own entry is silently disarmed and nothing is left armed; the
  // abort is confirmed, so the qualifier is latched; no consuming path ever runs
  // (nothing to consume) and no prompt() ever runs. The CLI still owes the queued
  // task notification, so it opens an UNPROMPTED re-invocation turn — real work,
  // which finishes fine — whose turn_start re-arms the owner (ownership surviving
  // a disarm is by design). Without the survived-a-wake check that turn's wake
  // said "was INTERRUPTED … do not treat this as a result" about a completed turn.
  await api(baseUrl, 'POST', '/api/projects', { name: 'p' });
  const callerId = await spawnReady('p');
  const targetId = await spawnReadyWithScenario('p', SCENARIO_ABORT_DEFER);
  const target = instForSession(instances, targetId);
  const caller = instForSession(instances, callerId);

  await callTool('send_prompt', { sessionId: targetId, text: 'go' }, { caller: callerId });
  await waitFor(() => target.status === 'turn');
  await waitFor(() => target.activeAgentTaskCount > 0);
  await waitFor(() => instances._idleHub.hasArmedWake(target.id));

  // The MCP door WITH a caller: the sole owner is the interrupter, so it is
  // silently disarmed and nobody is left armed.
  await callTool('interrupt_turn', { sessionId: targetId, force: true }, { caller: callerId });
  await waitFor(() => target.turnForceAborted === true);
  assert.equal(instances._idleHub.hasArmedWake(target.id), false,
    'precondition: the disarm left nothing armed, so no path can consume the flag');

  // The unprompted re-invocation turn re-arms and completes.
  await waitFor(() => target.ringSnapshot().filter(ev => ev.kind === 'turn_end').length >= 2);
  const stub = await waitFor(() => findStubFor(caller, targetId));
  assert.match(stub.text, /finished its turn/,
    'a turn that finished must not inherit the previous abort\'s qualifier');
  assert.doesNotMatch(stub.text, /was INTERRUPTED/);
});

test('a NEW prompt clears the abort qualifier even while the aborted wake is still ARMED', async () => {
  // The case the hub's survived-a-wake check deliberately does NOT clear, so it is
  // prompt()'s alone: the abort's turn_end deferred on a live background task, so
  // a wake IS still armed at the next turn start. Left uncleared, the conductor's
  // own re-drive would come back reported as the previous abort. A new instruction
  // is what makes that abort irrelevant.
  await api(baseUrl, 'POST', '/api/projects', { name: 'p' });
  const callerId = await spawnReady('p');
  const targetId = await spawnReadyWithScenario('p', SCENARIO_ABORT_DEFER_THEN_PROMPT);
  const target = instForSession(instances, targetId);
  const caller = instForSession(instances, callerId);

  await callTool('send_prompt', { sessionId: targetId, text: 'go' }, { caller: callerId });
  await waitFor(() => target.status === 'turn');
  await waitFor(() => target.activeAgentTaskCount > 0);
  // The UI door, so the owner is NOT disarmed and its wake survives the abort.
  await target.interrupt({ force: true });
  await waitFor(() => target.status === 'idle');
  await settle();
  assert.equal(instances._idleHub.hasArmedWake(target.id), true,
    'precondition: the abort\'s turn_end deferred, so a wake survived it');
  assert.equal(target.turnForceAborted, true, 'and the qualifier is still latched');
  assert.equal(findStubFor(caller, targetId), undefined, 'nothing delivered yet');

  // A fresh dispatch: the wake it arms is about THIS turn.
  await callTool('send_prompt', { sessionId: targetId, text: 'again' }, { caller: callerId });
  const stub = await waitFor(() => findStubFor(caller, targetId));
  assert.match(stub.text, /finished its turn/,
    'the re-drive is reported on its own terms, not the previous abort\'s');
  assert.doesNotMatch(stub.text, /was INTERRUPTED/);
});

// ── retirement: the ONE case a heartbeat consumes, and the gap it must not ────

// A NON-temp worker (the REST spawn path): an MCP-spawned worker is temp, so its
// exit drops it from byId and purge() clears the graph before any beat can land —
// which is exactly the case these two tests are NOT about.
async function restWorker(project, scenarioPath) {
  const prev = process.env.FAKE_CLAUDE_SCENARIO;
  process.env.FAKE_CLAUDE_SCENARIO = scenarioPath;
  try {
    const r = await api(baseUrl, 'POST', '/api/instances', { project, mode: 'bypassPermissions' });
    assert.equal(r.status, 201);
    const inst = instances.get(r.body.id);
    await waitFor(() => inst.status === 'idle' && inst.sessionId);
    return inst;
  } finally { process.env.FAKE_CLAUDE_SCENARIO = prev; }
}

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
    { sessionId: worker.sessionId, text: 'go', idleTimeoutMs: 150 }, { caller: callerId });
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
  await new Promise(r => setTimeout(r, 150 * 5));
  await settle();
  assert.equal(beats(), atRetire, 'and no further ping arrives');
});

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
    { sessionId: worker.sessionId, text: 'go', idleTimeoutMs: 150 }, { caller: callerId });
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
      { sessionId: worker.sessionId, text: 'go', idleTimeoutMs: 150 }, { caller: callerId });
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

// ── the clamp: ceiling == default, so these inputs can only SHORTEN ───────────

test('the heartbeat window is clamped: above the default is refused, zero is refused', async () => {
  await api(baseUrl, 'POST', '/api/projects', { name: 'p' });
  const callerId = await spawnReady('p');
  const targetId = await spawnReady('p');
  const over = DEFAULT_SUBSCRIBE_TIMEOUT_MS + 1;

  for (const [tool, args] of [
    ['set_idle_timeout', { sessionId: targetId, timeoutMs: over }],
    ['send_prompt', { sessionId: targetId, text: 'go', idleTimeoutMs: over }],
  ]) {
    const res = await callTool(tool, args, { caller: callerId });
    assert.equal(res.isError, true, `${tool} must refuse a window above the default`);
    assert.match(res.content[0].text, new RegExp(`must be <= ${DEFAULT_SUBSCRIBE_TIMEOUT_MS}`));
  }
  for (const [tool, args] of [
    ['set_idle_timeout', { sessionId: targetId, timeoutMs: 0 }],
    // The pre-existing hole this closes: `integer` with no minimum let
    // idleTimeoutMs:-5 through, to be silently swallowed by the default fallback.
    ['send_prompt', { sessionId: targetId, text: 'go', idleTimeoutMs: -5 }],
  ]) {
    const res = await callTool(tool, args, { caller: callerId });
    assert.equal(res.isError, true, `${tool} must refuse a non-positive window`);
    assert.match(res.content[0].text, /must be >= 1/);
  }
  // Every refusal fired before any handler work: no turn, no ownership recorded.
  assert.equal(instForSession(instances, targetId).status, 'idle');
  assert.deepEqual(instances._idleHub.ownersOf(instForSession(instances, targetId).id), []);
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
  const targetId = await spawnReadyWithScenario('p', SCENARIO_PACED);
  const target = instForSession(instances, targetId);
  const caller = instForSession(instances, callerId);
  const flag = (sid) => instances.list().find(i => i.sessionId === sid)?.awaitingWake;

  assert.equal(flag(callerId), false, 'nothing armed yet');
  assert.equal(flag(targetId), false);

  // Mid-turn: the OWNER's row lights up, never the worker's — awaitingWake is
  // caller-side ("I am waiting on someone"), which is what makes an idle
  // conductor's dot distinguishable from a finished one.
  await callTool('send_prompt',
    { sessionId: targetId, text: 'go', idleTimeoutMs: 150 }, { caller: callerId });
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
