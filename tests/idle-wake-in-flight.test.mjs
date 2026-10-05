// The idle hub keeps a conductor reported as waiting (isCaller → `awaitingWake`)
// from the moment its wake is consumed until the wake's send has run, because
// the stub is built asynchronously and the conductor is idle with nothing armed
// in between. The delivery gate is injected (a deferred _buildFoldedStub), so
// nothing here depends on timing.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { posixPlatform } from '../src/platform/posix.ts';
import { InstanceManager } from '../src/instances.ts';

const mkFake = (id, sessionId, over = {}) => ({
  id, sessionId, project: 'p', proc: { pid: 1 }, status: 'idle', acceptsMidTurnSteering: true,
  steerPending: false, activeAgentTaskCount: 0, taskNotificationPending: false, rotationPending: false,
  _stopInterruptedTurn: false, _emitUi() {}, ring: { trimmedBefore: 0 }, ringSnapshot() { return []; },
  async prompt() {}, async interrupt() {}, ...over,
});

function rig(conductorOver = {}) {
  const instances = new InstanceManager({ platform: posixPlatform });
  const hub = instances._idleHub;
  const conductor = mkFake('c', 'cs', conductorOver);
  const worker = mkFake('w', 'ws', { status: 'turn' });
  instances.byId.set('w', worker); instances.byId.set('c', conductor);
  instances.noteDispatch('cs', 'ws');
  hub.onTurnStart('w');
  const changes = [];
  instances.on('subscription_changed', (e) => changes.push(e));
  let release;
  const gate = new Promise((r) => { release = r; });
  hub._buildFoldedStub = async () => { await gate; return 'stub'; };
  const finishWorker = () => {
    worker.status = 'idle';
    instances.emit('event', { id: 'w', ev: { kind: 'turn_end', isError: false, stopReason: 'end_turn' } });
  };
  const settle = async () => { for (let i = 0; i < 10; i++) await Promise.resolve(); };
  return { instances, hub, conductor, changes, release, finishWorker, settle };
}

// Invariant: consuming the wake does not make the conductor look un-waiting
// before its wake turn starts, however slow the stub build is; once prompt() has
// run it stops reading as waiting, with an event to say so.
test('awaitingWake holds across the consume → wake-turn-start gap and clears once the send has run', async () => {
  const r = rig();
  let heldAtSend = null;
  r.conductor.prompt = async () => { heldAtSend = r.hub.isCaller('c'); r.conductor.status = 'turn'; };
  assert.equal(r.instances.isIdleCaller('c'), true, 'premise: armed');
  r.finishWorker();
  assert.equal(r.hub.hasArmedWake('w'), false, 'the wake was consumed');
  assert.equal(r.instances.isIdleCaller('c'), true, 'consumed, send not started');
  await r.settle();
  assert.equal(r.instances.isIdleCaller('c'), true, 'stub build still pending');
  r.release();
  await r.settle();
  assert.equal(heldAtSend, true, 'still waiting when prompt() was entered');
  assert.equal(r.instances.isIdleCaller('c'), false, 'cleared after the send');
  assert.ok(r.changes.length > 0, 'the clearing emitted subscription_changed');
  await r.instances.shutdown().catch(() => {});
});

// Invariant: a refused send does not strand the conductor in "on a worker".
test('a refused send clears awaitingWake and emits', async () => {
  const r = rig();
  r.conductor.prompt = async () => { throw new Error('refused'); };
  r.finishWorker();
  r.release();
  await r.settle();
  assert.equal(r.instances.isIdleCaller('c'), false);
  assert.ok(r.changes.length > 0, 'an event announced the clear');
  await r.instances.shutdown().catch(() => {});
});

// Invariant: a conductor that dies between the consume and the send does not
// stay waiting.
test('an abandoned delivery (conductor gone before the send) clears awaitingWake and emits', async () => {
  const r = rig();
  let prompted = false;
  r.conductor.prompt = async () => { prompted = true; };
  r.finishWorker();
  assert.equal(r.instances.isIdleCaller('c'), true);
  r.conductor.proc = null;
  r.release();
  await r.settle();
  assert.equal(prompted, false, 'nothing was sent');
  assert.equal(r.instances.isIdleCaller('c'), false);
  assert.ok(r.changes.length > 0);
  await r.instances.shutdown().catch(() => {});
});

// Invariant: a wake held for a mid-turn recipient that cannot take it keeps the
// recipient reported as waiting until its own boundary delivers it.
test('a held (deferred) wake keeps the conductor waiting until it is delivered and sent', async () => {
  const r = rig({ status: 'turn', acceptsMidTurnSteering: false });
  r.conductor.prompt = async () => { r.conductor.status = 'turn'; };
  r.finishWorker();
  assert.equal(r.hub._deferredWakes.get('c')?.length, 1, 'premise: held');
  r.conductor.status = 'idle';
  assert.equal(r.instances.isIdleCaller('c'), true, 'held wake still counts');
  r.instances.emit('event', { id: 'c', ev: { kind: 'turn_end', isError: false, stopReason: 'end_turn' } });
  assert.equal(r.instances.isIdleCaller('c'), true, 'flushed into delivery, send not started');
  r.release();
  await r.settle();
  assert.equal(r.instances.isIdleCaller('c'), false);
  await r.instances.shutdown().catch(() => {});
});

// Invariant: a heartbeat (which consumes nothing) leaves the armed wake in
// place and does not emit when its send completes.
test('a heartbeat delivery leaves the armed wake and emits nothing on completion', async () => {
  const r = rig();
  r.release();
  r.hub.deliver('c', 'w', { timedOut: true, timeoutMs: 1 });
  await r.settle();
  assert.equal(r.hub.hasArmedWake('w'), true);
  assert.equal(r.instances.isIdleCaller('c'), true);
  assert.deepEqual(r.changes, []);
  r.hub.subscribers.clear();
  await r.instances.shutdown().catch(() => {});
});
