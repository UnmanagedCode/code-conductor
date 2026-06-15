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
import { bootServer, api, waitFor, instForSession, freshProjectsRoot, rmrf } from './helpers.mjs';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const SCENARIO_WS = path.join(__dirname, 'fixtures', 'scenario-ws.json');

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
  const url = baseUrl + '/mcp' + (caller ? `?caller=${encodeURIComponent(caller)}` : '');
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

  // Drive target through one full turn (wait:true ensures turn_end fires
  // before we assert on caller state).
  await callTool('send_prompt',
    { sessionId: targetId, text: 'go', wait: true, waitTimeoutMs: 5000 });

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

test('one-shot: a second target turn does not re-fire the callback', async () => {
  await api(baseUrl, 'POST', '/api/projects', { name: 'p' });
  const callerId = await spawnReady('p');
  const targetId = await spawnReady('p');

  await callTool('subscribe_to_idle',
    { sessionId: targetId }, { caller: callerId });

  // Turn 1: stub should land.
  await callTool('send_prompt',
    { sessionId: targetId, text: 'one', wait: true, waitTimeoutMs: 5000 });
  const caller = instForSession(instances, callerId);
  await waitFor(() => !!findStubFor(caller, targetId));

  // Wait for the caller's own turn (triggered by the stub) to drain.
  await waitFor(() => caller.status === 'idle');
  const stubsAfterTurn1 = countUserEchoes(caller,
    ev => ev.text?.includes(targetId) && ev.text?.includes('get_recent_messages'));
  assert.equal(stubsAfterTurn1, 1, 'exactly one stub after turn 1');

  // Turn 2: scenario-ws has a second turn defined. Drive it and assert
  // no additional stub arrives.
  await callTool('send_prompt',
    { sessionId: targetId, text: 'two', wait: true, waitTimeoutMs: 5000 });
  // Give any spurious delivery a chance to land before we count.
  await new Promise(r => setTimeout(r, 200));
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
  await callTool('send_prompt',
    { sessionId: targetId, text: 'go', wait: true, waitTimeoutMs: 5000 });
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
  await callTool('send_prompt',
    { sessionId: targetId, text: 'go', wait: true, waitTimeoutMs: 5000 });
  await new Promise(r => setTimeout(r, 200));
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

  // Subscription consumed — map is empty.
  assert.deepEqual(instances._idleSubscriberSnapshot(), {});
});

test('timeoutMs: turn_end before timeout wins; timer is cancelled, only one stub delivered', async () => {
  await api(baseUrl, 'POST', '/api/projects', { name: 'p' });
  const callerId = await spawnReady('p');
  const targetId = await spawnReady('p');

  // Long watchdog — turn_end should fire well before it.
  await callTool('subscribe_to_idle',
    { sessionId: targetId, timeoutMs: 2000 }, { caller: callerId });

  // Drive the target to turn_end before the watchdog fires.
  await callTool('send_prompt',
    { sessionId: targetId, text: 'go', wait: true, waitTimeoutMs: 5000 });

  const caller = instForSession(instances, callerId);
  await waitFor(() => !!findStubFor(caller, targetId));

  const completionStub = findStubFor(caller, targetId);
  assert.ok(completionStub, 'completion stub present');
  assert.match(completionStub.text, /finished its turn/);
  // Must NOT say "did NOT finish".
  assert.doesNotMatch(completionStub.text, /did NOT finish/);

  // Wait well past the 2000ms watchdog window to confirm the timer was cancelled.
  await new Promise(r => setTimeout(r, 300));
  const allStubs = caller.ringSnapshot().filter(ev =>
    ev.kind === 'user_echo' && ev.text?.includes(targetId));
  assert.equal(allStubs.length, 1, 'exactly one stub — timer was cancelled');
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
  await callTool('send_prompt',
    { sessionId: targetId, text: 'go', wait: true, waitTimeoutMs: 5000 });
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

test('timeoutMs: unsubscribe clears the watchdog timer — no stub delivered after unsubscribe', async () => {
  await api(baseUrl, 'POST', '/api/projects', { name: 'p' });
  const callerId = await spawnReady('p');
  const targetId = await spawnReady('p');

  await callTool('subscribe_to_idle',
    { sessionId: targetId, timeoutMs: 150 }, { caller: callerId });

  // Unsubscribe immediately — should clear the timer.
  const unsub = unwrap(await callTool('unsubscribe_from_idle',
    { sessionId: targetId }, { caller: callerId }));
  assert.equal(unsub.removed, true);
  assert.deepEqual(instances._idleSubscriberSnapshot(), {});

  // Wait well past the 150ms window.
  await new Promise(r => setTimeout(r, 300));

  const caller = instForSession(instances, callerId);
  assert.equal(findTimeoutStubFor(caller, targetId), undefined,
    'no timeout stub after unsubscribe');
  assert.equal(findStubFor(caller, targetId), undefined,
    'no completion stub either');
});
