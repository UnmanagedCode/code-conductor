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

import { test } from 'node:test';
import assert from 'node:assert/strict';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { bootServer, api, waitFor } from './helpers.mjs';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const SCENARIO_WS = path.join(__dirname, 'fixtures', 'scenario-ws.json');

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

async function callTool(baseUrl, name, args, opts) {
  const { body } = await rpc(baseUrl, 'tools/call', { name, arguments: args }, opts);
  assert.ok(body, 'rpc returned a response');
  assert.ok(body.result, `tools/call ${name} returned no result; body=${JSON.stringify(body)}`);
  return body.result;
}

function unwrap(result) {
  assert.ok(Array.isArray(result.content), 'tool result has content[]');
  return JSON.parse(result.content[0].text);
}

async function spawnReady(ctx, project) {
  const spawn = unwrap(await callTool(ctx.baseUrl, 'spawn_instance', {
    project, mode: 'bypassPermissions',
  }));
  await waitFor(() =>
    ctx.instances.get(spawn.id)?.status === 'idle' &&
    ctx.instances.get(spawn.id)?.sessionId,
  );
  return spawn.id;
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
  const ctx = await bootServer({ scenarioPath: SCENARIO_WS });
  try {
    await api(ctx.baseUrl, 'POST', '/api/projects', { name: 'p' });
    const callerId = await spawnReady(ctx, 'p');
    const targetId = await spawnReady(ctx, 'p');

    const sub = unwrap(await callTool(ctx.baseUrl, 'subscribe_to_idle',
      { targetId }, { caller: callerId }));
    assert.equal(sub.callerId, callerId);
    assert.equal(sub.targetId, targetId);
    assert.equal(sub.already, false);

    // Drive target through one full turn (wait:true ensures turn_end fires
    // before we assert on caller state).
    await callTool(ctx.baseUrl, 'send_prompt',
      { id: targetId, text: 'go', wait: true, waitTimeoutMs: 5000 });

    // The stub is delivered via queueMicrotask + an async prompt() call.
    // Poll the caller's ring until the user_echo appears. Inherit the default
    // deadline — delivery follows the target's subprocess turn, which can lag
    // under concurrent CPU contention.
    const caller = ctx.instances.get(callerId);
    await waitFor(() => !!findStubFor(caller, targetId));

    const stub = findStubFor(caller, targetId);
    assert.ok(stub, 'stub user_echo present in caller ring');
    assert.match(stub.text, /finished its turn/);
    assert.match(stub.text, /get_recent_messages/);
    assert.ok(stub.text.includes(targetId));
  } finally { await ctx.close(); }
});

test('one-shot: a second target turn does not re-fire the callback', async () => {
  const ctx = await bootServer({ scenarioPath: SCENARIO_WS });
  try {
    await api(ctx.baseUrl, 'POST', '/api/projects', { name: 'p' });
    const callerId = await spawnReady(ctx, 'p');
    const targetId = await spawnReady(ctx, 'p');

    await callTool(ctx.baseUrl, 'subscribe_to_idle',
      { targetId }, { caller: callerId });

    // Turn 1: stub should land.
    await callTool(ctx.baseUrl, 'send_prompt',
      { id: targetId, text: 'one', wait: true, waitTimeoutMs: 5000 });
    const caller = ctx.instances.get(callerId);
    await waitFor(() => !!findStubFor(caller, targetId));

    // Wait for the caller's own turn (triggered by the stub) to drain.
    await waitFor(() => caller.status === 'idle');
    const stubsAfterTurn1 = countUserEchoes(caller,
      ev => ev.text?.includes(targetId) && ev.text?.includes('get_recent_messages'));
    assert.equal(stubsAfterTurn1, 1, 'exactly one stub after turn 1');

    // Turn 2: scenario-ws has a second turn defined. Drive it and assert
    // no additional stub arrives.
    await callTool(ctx.baseUrl, 'send_prompt',
      { id: targetId, text: 'two', wait: true, waitTimeoutMs: 5000 });
    // Give any spurious delivery a chance to land before we count.
    await new Promise(r => setTimeout(r, 200));
    const stubsAfterTurn2 = countUserEchoes(caller,
      ev => ev.text?.includes(targetId) && ev.text?.includes('get_recent_messages'));
    assert.equal(stubsAfterTurn2, 1, 'subscription is one-shot — no second stub');
  } finally { await ctx.close(); }
});

test('self-subscribe is rejected with a clear error', async () => {
  const ctx = await bootServer({ scenarioPath: SCENARIO_WS });
  try {
    await api(ctx.baseUrl, 'POST', '/api/projects', { name: 'p' });
    const aId = await spawnReady(ctx, 'p');

    const result = await callTool(ctx.baseUrl, 'subscribe_to_idle',
      { targetId: aId }, { caller: aId });
    assert.equal(result.isError, true);
    assert.match(result.content[0].text, /subscribe to self/);
  } finally { await ctx.close(); }
});

test('missing ?caller= surfaces a clear isError result', async () => {
  const ctx = await bootServer({ scenarioPath: SCENARIO_WS });
  try {
    await api(ctx.baseUrl, 'POST', '/api/projects', { name: 'p' });
    const targetId = await spawnReady(ctx, 'p');

    const { body } = await rpc(ctx.baseUrl, 'tools/call', {
      name: 'subscribe_to_idle', arguments: { targetId },
    });
    assert.equal(body.result.isError, true);
    assert.match(body.result.content[0].text, /caller identity missing/);
  } finally { await ctx.close(); }
});

test('caller removed before target turn_end: subscription is purged, no crash', async () => {
  const ctx = await bootServer({ scenarioPath: SCENARIO_WS });
  try {
    await api(ctx.baseUrl, 'POST', '/api/projects', { name: 'p' });
    const callerId = await spawnReady(ctx, 'p');
    const targetId = await spawnReady(ctx, 'p');

    await callTool(ctx.baseUrl, 'subscribe_to_idle',
      { targetId }, { caller: callerId });

    // Sanity: subscription is registered before we kill anything.
    assert.deepEqual(ctx.instances._idleSubscriberSnapshot(),
      { [targetId]: [callerId] });

    // Kill the caller. The manager's _purgeIdleFor hook should drop the entry.
    await callTool(ctx.baseUrl, 'kill_instance', { id: callerId });
    assert.equal(ctx.instances.get(callerId), undefined);
    assert.deepEqual(ctx.instances._idleSubscriberSnapshot(), {});

    // Drive target through a turn. No callers exist → silent no-op, no throw.
    await callTool(ctx.baseUrl, 'send_prompt',
      { id: targetId, text: 'go', wait: true, waitTimeoutMs: 5000 });
    // If we got here without an unhandled rejection / crash, the test passes.
    assert.equal(ctx.instances.get(targetId).status, 'idle');
  } finally { await ctx.close(); }
});

test('target removed before turn_end: subscription is purged', async () => {
  const ctx = await bootServer({ scenarioPath: SCENARIO_WS });
  try {
    await api(ctx.baseUrl, 'POST', '/api/projects', { name: 'p' });
    const callerId = await spawnReady(ctx, 'p');
    const targetId = await spawnReady(ctx, 'p');

    await callTool(ctx.baseUrl, 'subscribe_to_idle',
      { targetId }, { caller: callerId });
    assert.deepEqual(ctx.instances._idleSubscriberSnapshot(),
      { [targetId]: [callerId] });

    await callTool(ctx.baseUrl, 'kill_instance', { id: targetId });
    assert.deepEqual(ctx.instances._idleSubscriberSnapshot(), {});

    // Caller is still alive and untouched.
    const caller = ctx.instances.get(callerId);
    assert.equal(caller.status, 'idle');
    assert.equal(countUserEchoes(caller), 0);
  } finally { await ctx.close(); }
});

test('unsubscribe_from_idle cancels a pending subscription', async () => {
  const ctx = await bootServer({ scenarioPath: SCENARIO_WS });
  try {
    await api(ctx.baseUrl, 'POST', '/api/projects', { name: 'p' });
    const callerId = await spawnReady(ctx, 'p');
    const targetId = await spawnReady(ctx, 'p');

    await callTool(ctx.baseUrl, 'subscribe_to_idle',
      { targetId }, { caller: callerId });
    const unsub = unwrap(await callTool(ctx.baseUrl, 'unsubscribe_from_idle',
      { targetId }, { caller: callerId }));
    assert.equal(unsub.removed, true);
    assert.deepEqual(ctx.instances._idleSubscriberSnapshot(), {});

    // Driving the target now should not deliver a stub.
    await callTool(ctx.baseUrl, 'send_prompt',
      { id: targetId, text: 'go', wait: true, waitTimeoutMs: 5000 });
    await new Promise(r => setTimeout(r, 200));
    const caller = ctx.instances.get(callerId);
    assert.equal(findStubFor(caller, targetId), undefined);

    // Re-unsubscribe is idempotent (removed:false).
    const again = unwrap(await callTool(ctx.baseUrl, 'unsubscribe_from_idle',
      { targetId }, { caller: callerId }));
    assert.equal(again.removed, false);
  } finally { await ctx.close(); }
});

test('subscribe is idempotent: re-registering the same pair reports already:true', async () => {
  const ctx = await bootServer({ scenarioPath: SCENARIO_WS });
  try {
    await api(ctx.baseUrl, 'POST', '/api/projects', { name: 'p' });
    const callerId = await spawnReady(ctx, 'p');
    const targetId = await spawnReady(ctx, 'p');

    const first = unwrap(await callTool(ctx.baseUrl, 'subscribe_to_idle',
      { targetId }, { caller: callerId }));
    assert.equal(first.already, false);
    const second = unwrap(await callTool(ctx.baseUrl, 'subscribe_to_idle',
      { targetId }, { caller: callerId }));
    assert.equal(second.already, true);
    // Still exactly one entry — the set dedupes.
    assert.deepEqual(ctx.instances._idleSubscriberSnapshot(),
      { [targetId]: [callerId] });
  } finally { await ctx.close(); }
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
  const ctx = await bootServer({ scenarioPath: SCENARIO_WS });
  try {
    await api(ctx.baseUrl, 'POST', '/api/projects', { name: 'p' });
    const callerId = await spawnReady(ctx, 'p');
    const targetId = await spawnReady(ctx, 'p');

    // Subscribe with a short watchdog — don't drive the target so turn_end never fires.
    await callTool(ctx.baseUrl, 'subscribe_to_idle',
      { targetId, timeoutMs: 150 }, { caller: callerId });

    const caller = ctx.instances.get(callerId);
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
    assert.deepEqual(ctx.instances._idleSubscriberSnapshot(), {});
  } finally { await ctx.close(); }
});

test('timeoutMs: turn_end before timeout wins; timer is cancelled, only one stub delivered', async () => {
  const ctx = await bootServer({ scenarioPath: SCENARIO_WS });
  try {
    await api(ctx.baseUrl, 'POST', '/api/projects', { name: 'p' });
    const callerId = await spawnReady(ctx, 'p');
    const targetId = await spawnReady(ctx, 'p');

    // Long watchdog — turn_end should fire well before it.
    await callTool(ctx.baseUrl, 'subscribe_to_idle',
      { targetId, timeoutMs: 2000 }, { caller: callerId });

    // Drive the target to turn_end before the watchdog fires.
    await callTool(ctx.baseUrl, 'send_prompt',
      { id: targetId, text: 'go', wait: true, waitTimeoutMs: 5000 });

    const caller = ctx.instances.get(callerId);
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
  } finally { await ctx.close(); }
});

// ── list() hasIdleSubscriber semantics ───────────────────────────────────────

test('list() sets hasIdleSubscriber on the caller (conductor), not the target (worker)', async () => {
  const ctx = await bootServer({ scenarioPath: SCENARIO_WS });
  try {
    await api(ctx.baseUrl, 'POST', '/api/projects', { name: 'p' });
    const callerId = await spawnReady(ctx, 'p');
    const targetId = await spawnReady(ctx, 'p');

    // Before subscribe: both false.
    let listed = ctx.instances.list();
    assert.equal(listed.find(i => i.id === callerId)?.hasIdleSubscriber, false);
    assert.equal(listed.find(i => i.id === targetId)?.hasIdleSubscriber, false);

    // After subscribe: caller=true, target=false.
    await callTool(ctx.baseUrl, 'subscribe_to_idle',
      { targetId }, { caller: callerId });
    listed = ctx.instances.list();
    assert.equal(listed.find(i => i.id === callerId)?.hasIdleSubscriber, true,
      'caller (conductor) must show hasIdleSubscriber:true while awaiting');
    assert.equal(listed.find(i => i.id === targetId)?.hasIdleSubscriber, false,
      'target (worker) must NOT show hasIdleSubscriber:true');

    // After the subscription fires (target completes a turn): caller goes false.
    await callTool(ctx.baseUrl, 'send_prompt',
      { id: targetId, text: 'go', wait: true, waitTimeoutMs: 5000 });
    const caller = ctx.instances.get(callerId);
    await waitFor(() => !!findStubFor(caller, targetId));
    listed = ctx.instances.list();
    assert.equal(listed.find(i => i.id === callerId)?.hasIdleSubscriber, false,
      'hasIdleSubscriber must be false after subscription is consumed');
    assert.equal(listed.find(i => i.id === targetId)?.hasIdleSubscriber, false);
  } finally { await ctx.close(); }
});

test('list() hasIdleSubscriber goes false after unsubscribe', async () => {
  const ctx = await bootServer({ scenarioPath: SCENARIO_WS });
  try {
    await api(ctx.baseUrl, 'POST', '/api/projects', { name: 'p' });
    const callerId = await spawnReady(ctx, 'p');
    const targetId = await spawnReady(ctx, 'p');

    await callTool(ctx.baseUrl, 'subscribe_to_idle',
      { targetId }, { caller: callerId });
    assert.equal(ctx.instances.list().find(i => i.id === callerId)?.hasIdleSubscriber, true);

    await callTool(ctx.baseUrl, 'unsubscribe_from_idle',
      { targetId }, { caller: callerId });
    assert.equal(ctx.instances.list().find(i => i.id === callerId)?.hasIdleSubscriber, false,
      'hasIdleSubscriber must be false after manual unsubscribe');
  } finally { await ctx.close(); }
});

test('timeoutMs: unsubscribe clears the watchdog timer — no stub delivered after unsubscribe', async () => {
  const ctx = await bootServer({ scenarioPath: SCENARIO_WS });
  try {
    await api(ctx.baseUrl, 'POST', '/api/projects', { name: 'p' });
    const callerId = await spawnReady(ctx, 'p');
    const targetId = await spawnReady(ctx, 'p');

    await callTool(ctx.baseUrl, 'subscribe_to_idle',
      { targetId, timeoutMs: 150 }, { caller: callerId });

    // Unsubscribe immediately — should clear the timer.
    const unsub = unwrap(await callTool(ctx.baseUrl, 'unsubscribe_from_idle',
      { targetId }, { caller: callerId }));
    assert.equal(unsub.removed, true);
    assert.deepEqual(ctx.instances._idleSubscriberSnapshot(), {});

    // Wait well past the 150ms window.
    await new Promise(r => setTimeout(r, 300));

    const caller = ctx.instances.get(callerId);
    assert.equal(findTimeoutStubFor(caller, targetId), undefined,
      'no timeout stub after unsubscribe');
    assert.equal(findStubFor(caller, targetId), undefined,
      'no completion stub either');
  } finally { await ctx.close(); }
});
