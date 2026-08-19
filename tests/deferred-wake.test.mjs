// IdleSubscriptionHub against models that cannot take a mid-turn injection.
//
// Two independent behaviours, both keyed on the per-model capability flag:
//   RECIPIENT side — a wake for a conductor that is mid-turn on a flagged model
//     is HELD (never a block-edge stop: an idle report is not urgent, and
//     aborting a conductor would sever its in-flight orchestration) and
//     delivered at that conductor's own next turn_end.
//   TARGET side — the turn_end an armed stop produces on a worker must NOT
//     consume the one-shot subscription: the worker was cut off to deliver a
//     steer, it did not finish.
//
// Drives the REAL InstanceManager → IdleSubscriptionHub edge with injected fake
// instances, same layer as tests/idle-subagent-defer.test.mjs.

import { test, after } from 'node:test';
import assert from 'node:assert/strict';
import { InstanceManager } from '../src/instances.ts';
import { parseWakeCallback } from '../public/wakeCallback.js';

const instances = new InstanceManager();
after(() => instances.shutdown().catch(() => {}));

// `acceptsMidTurnSteering` defaults TRUE — the pre-flag behaviour, and the
// polarity every read site uses (only an explicit false diverts).
function makeFake({ id, sessionId, status = 'idle', acceptsMidTurnSteering = true, steerPending = false }) {
  const _promptCalls = [];
  const inst = {
    id,
    sessionId,
    project: 'test-project',
    proc: { pid: 999 },
    status,
    acceptsMidTurnSteering,
    steerPending,
    activeAgentTaskCount: 0,
    taskNotificationPending: false,
    rotationPending: false,
    _emitUi() {},
    ring: { trimmedBefore: 0 },
    ringSnapshot() { return []; },
    async prompt(text, _atts, opts) { _promptCalls.push({ text, opts }); },
  };
  inst._promptCalls = _promptCalls;
  return inst;
}

const emit = (id, ev) => instances.emit('event', { id, ev });
const emitTurnEnd = (id) => emit(id, { kind: 'turn_end', isError: false, stopReason: 'end_turn' });
const emitSteerSettled = (id) => emit(id, { kind: 'system', subtype: 'steer_settled', data: {} });
const tick = () => new Promise(r => setTimeout(r, 20));

function inject(...insts) { for (const i of insts) instances.byId.set(i.id, i); }
function cleanup(...insts) {
  instances._idleSubscribers.clear();
  instances._idleHub._deferredWakes.clear();
  for (const i of insts) instances.byId.delete(i.id);
}
const stubOf = (call) => parseWakeCallback(call.text);

// ── recipient side: hold the wake, deliver it at the recipient's own boundary ──

test('a flagged, mid-turn conductor gets NOTHING now and exactly one folded wake at its own turn_end', async () => {
  const cond = makeFake({ id: 'c1', sessionId: 'cs1', status: 'turn', acceptsMidTurnSteering: false });
  const work = makeFake({ id: 'w1', sessionId: 'ws1' });
  inject(cond, work);
  instances.subscribeIdle('cs1', 'ws1');

  emitTurnEnd('w1');
  await tick();
  assert.equal(cond._promptCalls.length, 0, 'nothing may be injected into the running turn');

  // The conductor finishes its own turn — now it can receive.
  cond.status = 'idle';
  emitTurnEnd('c1');
  await tick();
  assert.equal(cond._promptCalls.length, 1, 'delivered exactly once');
  const stub = stubOf(cond._promptCalls[0]);
  assert.ok(stub, 'still a wake-callback stub');
  assert.match(stub.summary, /finished its turn/);
  assert.ok(stub.body !== '', 'delivered to an idle recipient ⇒ folded, not the plain pointer');

  // …and not again on the next boundary.
  emitTurnEnd('c1');
  await tick();
  assert.equal(cond._promptCalls.length, 1, 'the held queue is consumed, not replayed');
  cleanup(cond, work);
});

test('an UNFLAGGED mid-turn conductor is unchanged: a live plain-stub injection', async () => {
  const cond = makeFake({ id: 'c2', sessionId: 'cs2', status: 'turn' });
  const work = makeFake({ id: 'w2', sessionId: 'ws2' });
  inject(cond, work);
  instances.subscribeIdle('cs2', 'ws2');

  emitTurnEnd('w2');
  await tick();
  assert.equal(cond._promptCalls.length, 1, 'delivered live into the running turn');
  assert.equal(stubOf(cond._promptCalls[0]).body, '', 'the plain pointer stub, not a fold');
  assert.equal(cond._promptCalls[0].opts.annotateIfMidTurn, false);
  assert.equal(cond._promptCalls[0].opts.internal, true);
  cleanup(cond, work);
});

test('a held wake whose worker went busy again is MARKED stale, not folded and not dropped', async () => {
  const cond = makeFake({ id: 'c3', sessionId: 'cs3', status: 'turn', acceptsMidTurnSteering: false });
  const work = makeFake({ id: 'w3', sessionId: 'ws3' });
  inject(cond, work);
  instances.subscribeIdle('cs3', 'ws3');

  emitTurnEnd('w3');
  await tick();
  work.status = 'turn';          // the worker picked up new work while we waited
  cond.status = 'idle';
  emitTurnEnd('c3');
  await tick();

  assert.equal(cond._promptCalls.length, 1, 'marked, never dropped — the conductor may be blocked on it');
  const stub = stubOf(cond._promptCalls[0]);
  assert.match(stub.summary, /no longer idle/, 'the stale note leads the summary');
  assert.equal(stub.body, '', 'a busy worker\'s mid-flight output must not be folded in as its result');
  cleanup(cond, work);
});

test('a held wake for a conductor that dies is dropped silently', async () => {
  const cond = makeFake({ id: 'c4', sessionId: 'cs4', status: 'turn', acceptsMidTurnSteering: false });
  const work = makeFake({ id: 'w4', sessionId: 'ws4' });
  inject(cond, work);
  instances.subscribeIdle('cs4', 'ws4');
  emitTurnEnd('w4');
  await tick();

  cond.proc = null;
  emitTurnEnd('c4');
  await tick();
  assert.equal(cond._promptCalls.length, 0, 'no delivery, no throw');
  assert.equal(instances._idleHub._deferredWakes.has('c4'), false, 'and the queue is released');
  cleanup(cond, work);
});

// ── recipient side: a wake held BEHIND a queued steer ────────────────────────

test('a wake held behind a queued steer waits for the steered turn, then lands once', async () => {
  const cond = makeFake({ id: 'c5', sessionId: 'cs5', status: 'turn', acceptsMidTurnSteering: false });
  const work = makeFake({ id: 'w5', sessionId: 'ws5' });
  inject(cond, work);
  instances.subscribeIdle('cs5', 'ws5');
  emitTurnEnd('w5');
  await tick();

  // The conductor's turn ends, but a steer is parked on it — its own fresh turn
  // is a microtask away, so delivering here would race a second prompt().
  cond.steerPending = true;
  cond.status = 'idle';
  emitTurnEnd('c5');
  await tick();
  assert.equal(cond._promptCalls.length, 0, 'the wake re-defers behind the steer');

  cond.steerPending = false;
  emitTurnEnd('c5');
  await tick();
  assert.equal(cond._promptCalls.length, 1, 'delivered at the steered turn\'s end');
  cleanup(cond, work);
});

// The strand this guards: the steer failed (or was overage-queued), so NO
// turn_end is ever coming and the subscription's watchdog was already cancelled
// when the worker's turn_end consumed it.
test('a steer that settles with no turn at all still flushes the held wake', async () => {
  const cond = makeFake({ id: 'c6', sessionId: 'cs6', status: 'turn', acceptsMidTurnSteering: false });
  const work = makeFake({ id: 'w6', sessionId: 'ws6' });
  inject(cond, work);
  instances.subscribeIdle('cs6', 'ws6');
  emitTurnEnd('w6');
  await tick();

  cond.steerPending = true;
  cond.status = 'idle';
  emitTurnEnd('c6');
  await tick();
  assert.equal(cond._promptCalls.length, 0);

  cond.steerPending = false;     // the queue drained without starting a turn
  emitSteerSettled('c6');
  await tick();
  assert.equal(cond._promptCalls.length, 1, 'the wake is not stranded');
  cleanup(cond, work);
});

// ── target side: the stop's own turn_end must not spend the subscription ─────

test('a worker with a steer parked does NOT consume its subscription at that turn_end', async () => {
  const cond = makeFake({ id: 'c7', sessionId: 'cs7' });
  const work = makeFake({ id: 'w7', sessionId: 'ws7', steerPending: true });
  inject(cond, work);
  instances.subscribeIdle('cs7', 'ws7');

  emitTurnEnd('w7');             // the turn_end the block-edge stop produced
  await tick();
  assert.equal(cond._promptCalls.length, 0, 'the worker was cut off — it did not finish');
  assert.equal(instances._idleHub.hasSubscriber('w7'), true, 'the one-shot is still armed');

  work.steerPending = false;
  emitTurnEnd('w7');             // the steered turn's real end
  await tick();
  assert.equal(cond._promptCalls.length, 1, 'delivered exactly once, one turn later');
  assert.equal(instances._idleHub.hasSubscriber('w7'), false);
  cleanup(cond, work);
});
