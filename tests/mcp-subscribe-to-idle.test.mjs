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
  const text = result.content.map(c => c.text).join('');
  return JSON.parse(text);
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
    assert.equal(sub.ok, true);
    assert.equal(sub.callerId, callerId);
    assert.equal(sub.targetId, targetId);
    assert.equal(sub.already, false);

    // Drive target through one full turn (wait:true ensures turn_end fires
    // before we assert on caller state).
    await callTool(ctx.baseUrl, 'send_prompt',
      { id: targetId, text: 'go', wait: true, waitTimeoutMs: 5000 });

    // The stub is delivered via queueMicrotask + an async prompt() call.
    // Poll the caller's ring until the user_echo appears.
    const caller = ctx.instances.get(callerId);
    await waitFor(() => !!findStubFor(caller, targetId), { timeout: 2000 });

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
    await waitFor(() => !!findStubFor(caller, targetId), { timeout: 2000 });

    // Wait for the caller's own turn (triggered by the stub) to drain.
    await waitFor(() => caller.status === 'idle', { timeout: 5000 });
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
    assert.equal(unsub.ok, true);
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
