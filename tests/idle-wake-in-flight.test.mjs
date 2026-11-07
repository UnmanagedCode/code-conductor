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

// Invariant: a delivery that fails against a caller that still has a process
// keeps the conductor waiting — the wake goes back on the deferred queue and the
// caller's next turn_end redelivers it (the same stub), after which it clears.
test('a refused send to a live caller requeues the wake and the next turn_end redelivers it', async () => {
  const r = rig();
  const sent = [];
  let refuse = true;
  r.conductor.prompt = async (text) => {
    sent.push(text);
    if (refuse) throw new Error('refused');
    r.conductor.status = 'turn';
  };
  r.finishWorker();
  r.release();
  await r.settle();
  assert.deepEqual(sent, ['stub'], 'the first attempt was made');
  assert.equal(r.hub._deferredWakes.get('c')?.length, 1, 'the wake is owed again');
  assert.equal(r.instances.isIdleCaller('c'), true, 'still waiting after the refusal');
  assert.deepEqual(r.changes, [], 'no clear was announced');
  refuse = false;
  r.instances.emit('event', { id: 'c', ev: { kind: 'turn_end', isError: false, stopReason: 'end_turn' } });
  await r.settle();
  assert.deepEqual(sent, ['stub', 'stub'], 'redelivered with the stub');
  assert.equal(r.hub._deferredWakes.has('c'), false);
  assert.equal(r.instances.isIdleCaller('c'), false, 'cleared once delivered');
  assert.ok(r.changes.length > 0, 'the clearing emitted subscription_changed');
  await r.instances.shutdown().catch(() => {});
});

// Invariant: a wake sent into a RUNNING turn that the CLI may queue keeps the
// conductor waiting through that turn's own turn_end (status idle), and the
// hold is released, with an announcement, only when the queued turn starts.
test('a wake written into a running turn stays awaiting through the caller\'s turn_end until its queued turn starts', async () => {
  const r = rig({ status: 'turn', queuedPromptPending: false });
  r.conductor.prompt = async () => { r.conductor.queuedPromptPending = true; };
  r.finishWorker();
  await r.settle();
  assert.equal(r.hub._parked.get('c')?.length, 1, 'premise: parked after the send');
  assert.equal(r.instances.isIdleCaller('c'), true, 'sent mid-turn, not yet taken in');
  r.conductor.status = 'idle';
  r.instances.emit('event', { id: 'c', ev: { kind: 'turn_end', isError: false, stopReason: 'end_turn' } });
  assert.equal(r.instances.isIdleCaller('c'), true, 'the caller\'s own turn_end does not release it');
  assert.deepEqual(r.changes, []);
  r.conductor.status = 'turn';
  r.conductor.queuedPromptPending = false;
  r.hub.onTurnStart('c');
  assert.equal(r.instances.isIdleCaller('c'), false, 'released at the queued turn\'s start');
  assert.ok(r.changes.length > 0, 'the release emitted subscription_changed');
  await r.instances.shutdown().catch(() => {});
});

// Invariant: a wake the CLI folded into the running turn (a top-level
// tool_result cleared the flag) releases the hold mid-turn, so the later
// turn_end reads not awaiting.
test('a fold (flag cleared at a tool_result event) releases the hold before the caller\'s turn_end', async () => {
  const r = rig({ status: 'turn', queuedPromptPending: false });
  r.conductor.prompt = async () => { r.conductor.queuedPromptPending = true; };
  r.finishWorker();
  await r.settle();
  assert.equal(r.instances.isIdleCaller('c'), true, 'premise: parked');
  r.instances.emit('event', { id: 'c', ev: { kind: 'tool_result', toolUseId: 't' } });
  assert.equal(r.instances.isIdleCaller('c'), true, 'flag still set: an unrelated event does not release');
  r.conductor.queuedPromptPending = false;
  r.instances.emit('event', { id: 'c', ev: { kind: 'tool_result', toolUseId: 't' } });
  assert.equal(r.instances.isIdleCaller('c'), false, 'released mid-turn');
  r.conductor.status = 'idle';
  r.instances.emit('event', { id: 'c', ev: { kind: 'turn_end', isError: false, stopReason: 'end_turn' } });
  assert.equal(r.instances.isIdleCaller('c'), false, 'the turn_end snapshot reads not awaiting');
  await r.instances.shutdown().catch(() => {});
});

// Invariant: a parked hold does not outlive its caller — purge drops it, and an
// exit event with the flag cleared releases it.
test('a parked hold is dropped by purge and released by an exit event', async () => {
  const a = rig({ status: 'turn', queuedPromptPending: false });
  a.conductor.prompt = async () => { a.conductor.queuedPromptPending = true; };
  a.finishWorker();
  await a.settle();
  assert.equal(a.instances.isIdleCaller('c'), true, 'premise: parked');
  a.conductor.queuedPromptPending = false;
  a.instances.emit('event', { id: 'c', ev: { kind: 'system', subtype: 'exit', data: { code: 1, signal: null } } });
  assert.equal(a.hub._parked.has('c'), false);
  assert.equal(a.hub._inFlight.has('c'), false, 'exit released the count');
  await a.instances.shutdown().catch(() => {});

  const b = rig({ status: 'turn', queuedPromptPending: false });
  b.conductor.prompt = async () => { b.conductor.queuedPromptPending = true; };
  b.finishWorker();
  await b.settle();
  assert.equal(b.hub._parked.get('c')?.length, 1, 'premise: parked');
  b.hub.purge('c');
  assert.equal(b.hub._parked.has('c'), false);
  assert.equal(b.hub._inFlight.has('c'), false);
  await b.instances.shutdown().catch(() => {});
});

// Invariant: a wake for a caller whose rewrite (rewind, prune, model switch)
// makes prompt() refuse is held without calling prompt, and the unblock event
// delivers it.
test('a wake to a caller with rewriteBlocksPrompts is held and delivered on prompts_unblocked', async () => {
  const r = rig({ rewriteBlocksPrompts: true });
  const sent = [];
  r.conductor.prompt = async (text) => { sent.push(text); r.conductor.status = 'turn'; };
  r.finishWorker();
  r.release();
  await r.settle();
  assert.deepEqual(sent, [], 'prompt was not called');
  assert.equal(r.hub._deferredWakes.get('c')?.length, 1, 'held');
  assert.equal(r.instances.isIdleCaller('c'), true);
  r.conductor.rewriteBlocksPrompts = false;
  r.hub.onPromptsUnblocked('c');
  await r.settle();
  assert.deepEqual(sent, ['stub']);
  assert.equal(r.instances.isIdleCaller('c'), false);
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

// Invariant: a failed delivery whose caller lost its process meanwhile is
// dropped, not requeued, and the in-flight count clears.
test('a refused send to a caller that died meanwhile is dropped, not requeued', async () => {
  const r = rig();
  r.conductor.prompt = async () => { r.conductor.proc = null; throw new Error('gone'); };
  r.finishWorker();
  r.release();
  await r.settle();
  assert.equal(r.hub._deferredWakes.has('c'), false, 'nothing requeued');
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
