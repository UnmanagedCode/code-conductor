// The `wake_delivered` manager event: what IdleSubscriptionHub.deliver() tells
// the playbook gate so a delivered wake can be ledgered without the hub ever
// importing the ledger. Driven over a stub manager — the hub's constructor only
// builds maps — with a caller whose status is 'turn' and which accepts mid-turn
// steering, so deliver() takes the plain-stub path (no transcript read).

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { IdleSubscriptionHub } from '../src/idleSubscriptions.ts';

function rig({ callerOver = {}, targets = { 't-inst': { sessionId: 'worker-sid' } } } = {}) {
  const emitted = [];
  const prompts = [];
  // The stub's promise settles a tick AFTER it is called, so an emit that fires
  // when `prompt` is merely called (fire-and-forget) reads settled === 0.
  const state = { settled: 0 };
  const caller = {
    proc: {}, status: 'turn', acceptsMidTurnSteering: true,
    sessionId: 'conductor-sid', project: '.conduct',
    prompt: async (text) => { prompts.push(text); await new Promise(r => setImmediate(r)); state.settled++; },
    _emitUi() {},
    ...callerOver,
  };
  const byId = new Map([['c-inst', caller], ...Object.entries(targets)]);
  const manager = { byId, emit: (event, arg) => emitted.push({ event, arg, settledAtEmit: state.settled }), on() {} };
  const hub = new IdleSubscriptionHub(manager);
  const wakes = () => emitted.filter(e => e.event === 'wake_delivered');
  const flush = async () => { for (let i = 0; i < 5; i++) await new Promise(r => setImmediate(r)); };
  return { hub, caller, emitted, wakes, prompts, flush };
}

test('a delivered wake emits one wake_delivered naming the target session, after the prompt resolved', async () => {
  const { hub, wakes, flush } = rig();
  hub.deliver('c-inst', 't-inst');
  await flush();
  assert.equal(wakes().length, 1);
  assert.deepEqual(wakes()[0].arg, {
    callerSessionId: 'conductor-sid', callerProject: '.conduct', targetSessionId: 'worker-sid', heartbeat: false,
  });
  assert.equal(wakes()[0].settledAtEmit, 1, 'emitted only once caller.prompt had RESOLVED, not merely been called');
});

test('a timed-out wake is flagged heartbeat', async () => {
  const { hub, wakes, flush } = rig();
  hub.deliver('c-inst', 't-inst', { timedOut: true, timeoutMs: 1000 });
  await flush();
  assert.equal(wakes().length, 1);
  assert.equal(wakes()[0].arg.heartbeat, true);
});

test('an exited-target wake carries the exited sessionId even when the target left the registry', async () => {
  const { hub, wakes, flush } = rig({ targets: {} });
  hub.deliver('c-inst', 'gone-inst', { exited: { sessionId: 'dead-sid', code: 1, signal: null } });
  await flush();
  assert.equal(wakes().length, 1);
  assert.equal(wakes()[0].arg.targetSessionId, 'dead-sid');
});

test('a caller with no process gets no wake_delivered', async () => {
  const { hub, wakes, flush } = rig({ callerOver: { proc: null } });
  hub.deliver('c-inst', 't-inst');
  await flush();
  assert.equal(wakes().length, 0);
});

test('a suspended hub emits no wake_delivered', async () => {
  const { hub, wakes, flush } = rig();
  hub.suspend();
  hub.deliver('c-inst', 't-inst');
  await flush();
  assert.equal(wakes().length, 0);
});

test('a prompt that rejects emits no wake_delivered', async () => {
  const { hub, wakes, flush } = rig({ callerOver: { prompt: async () => { throw new Error('refused'); } } });
  hub.deliver('c-inst', 't-inst');
  await flush();
  assert.equal(wakes().length, 0);
});

test('a target absent from the registry with no exited record is never reported by its instanceId', async () => {
  const { hub, wakes, flush } = rig({ targets: {} });
  hub.deliver('c-inst', 'gone-inst');
  await flush();
  assert.equal(wakes().length, 0, 'no sessionId to name, so nothing is claimed');
});

test('a wake held for a mid-turn caller that cannot be steered emits once, when released', async () => {
  const { hub, caller, wakes, flush } = rig({ callerOver: { acceptsMidTurnSteering: false } });
  hub.deliver('c-inst', 't-inst');
  await flush();
  assert.equal(wakes().length, 0, 'held: nothing delivered yet');
  caller.acceptsMidTurnSteering = true; // stays mid-turn: the plain-stub path, no transcript read
  hub._flushDeferredWakes('c-inst');
  await flush();
  assert.equal(wakes().length, 1);
});
