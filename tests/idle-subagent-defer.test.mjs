// Unit tests for IdleSubscriptionHub's subagent-aware wake deferral.
//
// The dispatch-and-wake callback must fire only when a worker's turn_end lands
// AND the worker has no live background subagents (Instance._activeAgentTasks
// empty). A turn_end while a backgrounded Agent call is still running defers the
// wake — keeping the one-shot subscription (and its watchdog) armed — until the
// follow-up turn_end that fires once the last subagent completes.
//
// These drive the REAL InstanceManager -> IdleSubscriptionHub path via
// manager.emit('event', {id, ev:{kind:'turn_end'}}) (the same edge the live
// system uses), with injected fake instances that expose a settable
// `activeAgentTaskCount` and a `prompt` spy. Modeled on
// idle-notification-suppress.test.mjs.

import { test, after } from 'node:test';
import assert from 'node:assert/strict';
import { InstanceManager } from '../src/instances.js';

const instances = new InstanceManager();
after(() => instances.shutdown().catch(() => {}));

// Fake instance: `proc` truthy so isLive()/liveForSession treat it as live;
// `prompt` records deliveries; `activeAgentTaskCount` is the gate input.
function makeFake({ id, sessionId, activeAgentTaskCount = 0, subagentCompletedThisTurn = false }) {
  const _promptCalls = [];
  const inst = {
    id,
    sessionId,
    project: 'test-project',
    proc: { pid: 999 },
    status: 'idle',
    activeAgentTaskCount,
    subagentCompletedThisTurn,
    _emitUi() {},
    // Minimal ring surface so the folded-stub builder (buildRecentMessages)
    // resolves against this fake instead of throwing — the fold produces an
    // (empty) payload and deliver() still calls prompt().
    ring: { trimmedBefore: 0 },
    ringSnapshot() { return []; },
    async prompt(text, _atts, opts) { _promptCalls.push({ text, opts }); },
  };
  inst._promptCalls = _promptCalls;
  return inst;
}

function emitTurnEnd(id) {
  instances.emit('event', { id, ev: { kind: 'turn_end', isError: false, stopReason: 'end_turn' } });
}

// Delivery is queueMicrotask + an async (folding) prompt() — give it a beat.
const tick = () => new Promise(r => setTimeout(r, 20));

function inject(cond, work) {
  instances.byId.set(cond.id, cond);
  instances.byId.set(work.id, work);
}
function cleanup(cond, work) {
  instances._idleSubscribers.clear();
  instances.byId.delete(cond.id);
  instances.byId.delete(work.id);
}

test('(a)+(b) turn_end with an active subagent defers; delivery fires once after the count drains', async () => {
  const cond = makeFake({ id: 'c1', sessionId: 'cs1' });
  const work = makeFake({ id: 'w1', sessionId: 'ws1', activeAgentTaskCount: 1 });
  inject(cond, work);
  instances.subscribeIdle('cs1', 'ws1');

  // (a) turn_end while a subagent is active → deferred, subscription untouched.
  emitTurnEnd('w1');
  await tick();
  assert.equal(cond._promptCalls.length, 0, 'no delivery while a background subagent is active');
  assert.equal(instances._idleHub.hasSubscriber('ws1'), true,
    'a deferred turn_end must NOT consume the one-shot subscription');

  // (b) subagent finishes → follow-up turn_end at count 0 → deliver exactly once.
  work.activeAgentTaskCount = 0;
  emitTurnEnd('w1');
  await tick();
  assert.equal(cond._promptCalls.length, 1, 'delivered exactly once after the count drained');
  assert.equal(instances._idleHub.hasSubscriber('ws1'), false, 'subscription consumed on delivery');

  cleanup(cond, work);
});

test('(c) multiple background subagents — delivery waits for the LAST', async () => {
  const cond = makeFake({ id: 'c2', sessionId: 'cs2' });
  const work = makeFake({ id: 'w2', sessionId: 'ws2', activeAgentTaskCount: 2 });
  inject(cond, work);
  instances.subscribeIdle('cs2', 'ws2');

  emitTurnEnd('w2'); await tick();
  assert.equal(cond._promptCalls.length, 0, 'count 2 → defer');

  work.activeAgentTaskCount = 1;
  emitTurnEnd('w2'); await tick();
  assert.equal(cond._promptCalls.length, 0, 'count 1 → still defer (last subagent not done)');

  work.activeAgentTaskCount = 0;
  emitTurnEnd('w2'); await tick();
  assert.equal(cond._promptCalls.length, 1, 'count 0 → delivered exactly once');
  assert.equal(instances._idleHub.hasSubscriber('ws2'), false);

  cleanup(cond, work);
});

test('(c2) mid-turn completion: count 0 but subagentCompletedThisTurn defers until the re-invocation turn', async () => {
  // The observed bug: a background subagent completes DURING the turn, so
  // activeAgentTaskCount is already 0 at this turn_end, yet the CLI still owes
  // an unprompted re-invocation turn. The gate must defer on the flag alone.
  const cond = makeFake({ id: 'c7', sessionId: 'cs7' });
  const work = makeFake({ id: 'w7', sessionId: 'ws7', activeAgentTaskCount: 0, subagentCompletedThisTurn: true });
  inject(cond, work);
  instances.subscribeIdle('cs7', 'ws7');

  // turn_end with count 0 but a mid-turn completion → deferred, subscription kept.
  emitTurnEnd('w7'); await tick();
  assert.equal(cond._promptCalls.length, 0,
    'count 0 but a subagent completed this turn → defer (re-invocation turn owed)');
  assert.equal(instances._idleHub.hasSubscriber('ws7'), true,
    'a deferred turn_end must NOT consume the one-shot subscription');

  // The re-invocation turn runs; _setStatus would have reset the flag at its
  // start. Its turn_end (flag clear, count 0) delivers exactly once.
  work.subagentCompletedThisTurn = false;
  emitTurnEnd('w7'); await tick();
  assert.equal(cond._promptCalls.length, 1, 'delivered once at the re-invocation turn_end');
  assert.equal(instances._idleHub.hasSubscriber('ws7'), false, 'subscription consumed on delivery');

  cleanup(cond, work);
});

test('(e) regression: a normal no-subagent turn_end delivers immediately', async () => {
  const cond = makeFake({ id: 'c3', sessionId: 'cs3' });
  const work = makeFake({ id: 'w3', sessionId: 'ws3', activeAgentTaskCount: 0 });
  inject(cond, work);
  instances.subscribeIdle('cs3', 'ws3');

  emitTurnEnd('w3'); await tick();
  assert.equal(cond._promptCalls.length, 1, 'no subagents → immediate single delivery');
  assert.equal(instances._idleHub.hasSubscriber('ws3'), false);

  cleanup(cond, work);
});

test('every subscription arms a watchdog by default (no explicit timeoutMs)', () => {
  const cond = makeFake({ id: 'c4', sessionId: 'cs4' });
  const work = makeFake({ id: 'w4', sessionId: 'ws4' });
  inject(cond, work);
  instances.subscribeIdle('cs4', 'ws4'); // no timeoutMs

  const entry = instances._idleSubscribers.get('ws4')?.get('cs4');
  assert.ok(entry, 'subscription registered');
  assert.notEqual(entry.timerId, null,
    'a default watchdog timer is armed even with no explicit timeoutMs');

  instances.unsubscribeIdle('cs4', 'ws4'); // clears the timer
  instances.byId.delete('c4');
  instances.byId.delete('w4');
});

test('(d) watchdog still fires across a deferral when a subagent never completes', async () => {
  const cond = makeFake({ id: 'c5', sessionId: 'cs5' });
  const work = makeFake({ id: 'w5', sessionId: 'ws5', activeAgentTaskCount: 1 });
  inject(cond, work);
  instances.subscribeIdle('cs5', 'ws5', 60); // short watchdog

  // turn_end defers (count 1) and must NOT clear the watchdog.
  emitTurnEnd('w5'); await tick();
  assert.equal(cond._promptCalls.length, 0, 'deferred — no completion delivery');

  // Wait past the 60ms watchdog window (measured across the whole deferral).
  await new Promise(r => setTimeout(r, 150));
  assert.equal(cond._promptCalls.length, 1, 'watchdog fired across the deferral');
  assert.match(cond._promptCalls[0].text, /did NOT finish/,
    'watchdog stub is the non-completion "did NOT finish" wording');
  assert.equal(instances._idleHub.hasSubscriber('ws5'), false, 'watchdog consumed the subscription');

  instances.byId.delete('c5');
  instances.byId.delete('w5');
});

test('a deferred turn_end still marks the worker consumed (turn_notification stays suppressed)', async () => {
  const cond = makeFake({ id: 'c6', sessionId: 'cs6' });
  const work = makeFake({ id: 'w6', sessionId: 'ws6', activeAgentTaskCount: 1 });
  inject(cond, work);
  instances.subscribeIdle('cs6', 'ws6');

  emitTurnEnd('w6');
  // wasConsumed() is set synchronously in onTurnEnd (before the microtask that
  // clears it) so the wsHub handler suppresses the worker's ping on the
  // deferred intermediate turn_end too.
  assert.equal(instances._idleHub.wasConsumed('ws6'), true,
    'worker marked consumed on the deferred turn_end');
  await tick();
  assert.equal(cond._promptCalls.length, 0, 'still deferred (no delivery)');
  assert.equal(instances._idleHub.hasSubscriber('ws6'), true);

  cleanup(cond, work);
});
