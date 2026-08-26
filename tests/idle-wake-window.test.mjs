// The heartbeat WINDOW: set_idle_timeout's three states (idle target, running
// target, preserved-across-a-dispatch preference), the clamp that lets it only
// SHORTEN, and the two identity refusals (self-directed, and no ?caller= at all).
//
// One of the eight tests/idle-wake-*.test.mjs files (card 2026-0221). The
// contract under test, the MCP transport and the whole lifecycle live in
// ./idleWakeCase.mjs, which lists the family.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { api, waitFor, instForSession } from './helpers.mjs';
import { DEFAULT_SUBSCRIBE_TIMEOUT_SECONDS } from '../src/idleSubscriptions.ts';
import {
  setupIdleWake, rpc, callTool, unwrap, spawnReady,
  spawnReadyWithScenario, findTimeoutStubFor, SCENARIO_OPEN,
} from './idleWakeCase.mjs';

// The two handles every test body below reads. Bound inside the harness's own
// `before`, which is the only place they are guaranteed booted — see
// setupIdleWake() in ./idleWakeCase.mjs.
let baseUrl, instances;
setupIdleWake(c => { ({ baseUrl, instances } = c); });

test('a self-directed set_idle_timeout is rejected with a clear error', async () => {
  await api(baseUrl, 'POST', '/api/projects', { name: 'p' });
  const aId = await spawnReady('p');

  const result = await callTool('set_idle_timeout',
    { sessionId: aId, timeoutSeconds: 1 }, { caller: aId });
  assert.equal(result.isError, true);
  assert.match(result.content[0].text, /wait on self/);
});

test('missing ?caller= surfaces a clear isError result', async () => {
  await api(baseUrl, 'POST', '/api/projects', { name: 'p' });
  const targetId = await spawnReady('p');

  const { body } = await rpc(baseUrl, 'tools/call', {
    name: 'set_idle_timeout', arguments: { sessionId: targetId, timeoutSeconds: 1 },
  });
  assert.equal(body.result.isError, true);
  assert.match(body.result.content[0].text, /caller identity missing/);
});

test('a dispatch with no idleTimeoutSeconds preserves an earlier set_idle_timeout preference', async () => {
  // The docblock on _recordOwner promises this: an absent/invalid timeoutMs leaves
  // the owner's stored window intact rather than silently resetting it to the
  // default. Without the intervening dispatch the fallback is never exercised.
  await api(baseUrl, 'POST', '/api/projects', { name: 'p' });
  const callerId = await spawnReady('p');
  const targetId = await spawnReadyWithScenario('p', SCENARIO_OPEN);
  const target = instForSession(instances, targetId);
  const caller = instForSession(instances, callerId);

  const set = unwrap(await callTool('set_idle_timeout',
    { sessionId: targetId, timeoutSeconds: 5 }, { caller: callerId }));
  assert.equal(set.armed, false, 'target idle, so nothing to re-arm — preference only');

  // A plain dispatch, carrying NO idleTimeoutSeconds.
  await callTool('send_prompt', { sessionId: targetId, text: 'go' }, { caller: callerId });
  await waitFor(() => target.status === 'turn');
  await waitFor(() => instances._idleHub.hasArmedWake(target.id));
  assert.equal(instances._idleSubscribers.get(target.id).get(caller.id).timeoutMs, 5_000,
    'the turn armed on the STORED window, not on the default');
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
    { sessionId: targetId, text: 'go', idleTimeoutSeconds: 30 }, { caller: callerId });
  await waitFor(() => target.status === 'turn');
  await waitFor(() => instances._idleHub.hasArmedWake(target.id));
  assert.equal(instances._idleSubscribers.get(target.id).get(caller.id).timeoutMs, 30_000);

  const res = unwrap(await callTool('set_idle_timeout',
    { sessionId: targetId, timeoutSeconds: 1 }, { caller: callerId }));
  assert.equal(res.armed, true, 'a live heartbeat was re-armed, not just recorded');
  assert.equal(instances._idleSubscribers.get(target.id).get(caller.id).timeoutMs, 1_000,
    'seconds at the MCP boundary, ms in the hub');
  await waitFor(() => !!findTimeoutStubFor(caller, targetId), { timeout: 5000 });
});

test('set_idle_timeout on an idle target records the preference and reports armed:false', async () => {
  await api(baseUrl, 'POST', '/api/projects', { name: 'p' });
  const callerId = await spawnReady('p');
  const targetId = await spawnReady('p');

  const res = unwrap(await callTool('set_idle_timeout',
    { sessionId: targetId, timeoutSeconds: 5 }, { caller: callerId }));
  assert.equal(res.sessionId, targetId);
  assert.equal(res.armed, false, 'nothing is armed while the target is idle');
  assert.deepEqual(instances._idleSubscriberSnapshot(), {});
  // …but the preference is what the NEXT turn arms on.
  const target = instForSession(instances, targetId);
  instances._idleHub.onTurnStart(target.id);
  assert.equal(instances._idleSubscribers.get(target.id)
    .get(instForSession(instances, callerId).id).timeoutMs, 5_000);
});

// ── the clamp: ceiling == default, so these inputs can only SHORTEN ───────────

test('the heartbeat window is clamped: above the default is refused, zero is refused', async () => {
  await api(baseUrl, 'POST', '/api/projects', { name: 'p' });
  const callerId = await spawnReady('p');
  const targetId = await spawnReady('p');
  const over = DEFAULT_SUBSCRIBE_TIMEOUT_SECONDS + 1;

  for (const [tool, args] of [
    ['set_idle_timeout', { sessionId: targetId, timeoutSeconds: over }],
    ['send_prompt', { sessionId: targetId, text: 'go', idleTimeoutSeconds: over }],
  ]) {
    const res = await callTool(tool, args, { caller: callerId });
    assert.equal(res.isError, true, `${tool} must refuse a window above the default`);
    assert.match(res.content[0].text, new RegExp(`must be <= ${DEFAULT_SUBSCRIBE_TIMEOUT_SECONDS}`));
  }
  for (const [tool, args] of [
    ['set_idle_timeout', { sessionId: targetId, timeoutSeconds: 0 }],
    // The pre-existing hole this closes: `integer` with no minimum let
    // idleTimeoutSeconds:-5 through, to be silently swallowed by the default fallback.
    ['send_prompt', { sessionId: targetId, text: 'go', idleTimeoutSeconds: -5 }],
  ]) {
    const res = await callTool(tool, args, { caller: callerId });
    assert.equal(res.isError, true, `${tool} must refuse a non-positive window`);
    assert.match(res.content[0].text, /must be >= 1/);
  }
  // Seconds are WHOLE seconds: a fractional window is refused by the schema too,
  // not floored into something the caller did not ask for.
  for (const [tool, args] of [
    ['set_idle_timeout', { sessionId: targetId, timeoutSeconds: 2.5 }],
    ['send_prompt', { sessionId: targetId, text: 'go', idleTimeoutSeconds: 2.5 }],
  ]) {
    const res = await callTool(tool, args, { caller: callerId });
    assert.equal(res.isError, true, `${tool} must refuse a fractional window`);
    assert.match(res.content[0].text, /must be integer/);
  }
  // Every refusal fired before any handler work: no turn, no ownership recorded.
  assert.equal(instForSession(instances, targetId).status, 'idle');
  assert.deepEqual(instances._idleHub.ownersOf(instForSession(instances, targetId).id), []);
});
