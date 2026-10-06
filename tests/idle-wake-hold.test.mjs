// The wake HOLD (src/idleSubscriptions.ts → _holds / _waitsOnWork /
// _releaseHeld): a session that ends a turn while it is still waiting on work of
// its own keeps its owner's wake armed, and the owner is woken when the session
// needs it — at a turn end with nothing outstanding, at a question or plan, at a
// force-abort, at an exit, or when its wait clears without a turn.
//
// Hub-level, on a real InstanceManager with plain-object fakes in byId (the
// pattern of idle-wake-in-flight / idle-subagent-defer). Ownership is recorded
// with noteDispatch; a turn is `status` + onTurnStart, as Instance._setStatus
// drives it; a fake's prompt() opens a turn the same way, so a delivered wake
// puts its recipient into a turn exactly as a real send does.

import { test } from 'node:test';
import assert from 'node:assert/strict';

// Module-load-time constant, so it is set before the dynamic import.
process.env.ORCH_IDLE_DRAIN_SETTLE_MS = '40';
const SETTLE_MS = 40;

const { InstanceManager } = await import('../src/instances.ts');
const { posixPlatform } = await import('../src/platform/posix.ts');
const { WAKE_BODY_SEP } = await import('../public/wakeCallback.js');

const sleep = (ms) => new Promise(r => setTimeout(r, ms));
// Delivery is a microtask plus an async fold — a short beat settles it.
const tick = () => sleep(15);
async function until(pred, ms = 2000) {
  const end = Date.now() + ms;
  while (!pred()) {
    if (Date.now() > end) throw new Error('condition not reached');
    await sleep(5);
  }
}

function rig() {
  const instances = new InstanceManager({ platform: posixPlatform });
  const hub = instances._idleHub;
  const fakes = {};
  const mk = (id, over = {}) => {
    const calls = [];
    const inst = {
      id, sessionId: `${id}-s`, project: 'p', proc: { pid: 1 }, status: 'idle',
      acceptsMidTurnSteering: true, steerPending: false, activeAgentTaskCount: 0, backgroundJobs: [],
      taskNotificationPending: false, rotationPending: false, idleWindowDirty: false,
      _stopInterruptedTurn: false, turnForceAborted: false,
      consumeTurnForceAborted() { const was = inst.turnForceAborted; inst.turnForceAborted = false; return was; },
      _emitUi() {}, ring: { trimmedBefore: 0, nextSeq: 0 }, ringSnapshot() { return []; },
      summary() { return { id, sessionId: inst.sessionId, status: inst.status }; },
      // A sent wake opens a turn, as Instance.prompt → _setStatus('turn') does.
      async prompt(text, _atts, opts) {
        calls.push({ text, opts });
        if (inst.status !== 'turn') { inst.status = 'turn'; hub.onTurnStart(id); }
      },
      ...over,
    };
    inst.calls = calls;
    fakes[id] = inst;
    instances.byId.set(id, inst);
    return inst;
  };
  const own = (owner, target, timeoutMs) => instances.noteDispatch(owner.sessionId, target.sessionId, timeoutMs);
  const start = (x) => { x.status = 'turn'; hub.onTurnStart(x.id); };
  const end = (x) => {
    x.status = 'idle';
    instances.emit('event', { id: x.id, ev: { kind: 'turn_end', isError: false, stopReason: 'end_turn' } });
  };
  const emit = (x, ev) => instances.emit('event', { id: x.id, ev });
  const teardown = async () => {
    for (const subs of hub.subscribers.values()) for (const { timerId } of subs.values()) clearInterval(timerId);
    hub.subscribers.clear();
    hub._cancelAllSettles();
    await tick();
    await instances.shutdown().catch(() => {});
  };
  return { instances, hub, mk, own, start, end, emit, teardown, fakes };
}

// P owns C, C owns G; C and G are mid-turn.
function chain(r, over = {}) {
  const P = r.mk('P', over.P), C = r.mk('C', over.C), G = r.mk('G', over.G);
  r.own(P, C, over.windowMs); r.own(C, G);
  r.start(C); r.start(G);
  return { P, C, G };
}

const folded = (call) => call.text.includes(WAKE_BODY_SEP);

// Invariant: a child's turn ends while it still waits on a busy worker do not
// wake the owner, however many there are; the owner stays armed and reported as
// waiting, and the child's first turn end with nothing outstanding wakes it once
// with the child's folded output.
test('the owner is not woken while its child ends turns waiting on its own worker, then woken once', async () => {
  const r = rig();
  const { P, C, G } = chain(r);
  r.end(C);
  for (let i = 0; i < 2; i++) { r.start(C); r.end(C); }
  await tick();
  assert.equal(P.calls.length, 0, 'three held turn ends, no wake');
  assert.equal(r.hub.subscribers.get('C')?.has('P'), true, 'the owner stays armed');
  assert.equal(r.instances.isIdleCaller('P'), true);
  assert.equal(r.instances.list().find(i => i.id === 'P').awaitingWake, true);

  r.end(G);
  await tick();
  assert.equal(C.calls.length, 1, 'the worker woke its owner C');
  assert.equal(P.calls.length, 0, 'C is in the turn that wake opened');
  r.end(C);
  await tick();
  assert.equal(P.calls.length, 1, 'woken exactly once');
  assert.ok(folded(P.calls[0]), 'with the child\'s folded output');
  await r.teardown();
});

// Invariant: a turn that put a question or a plan to the user wakes the owner at
// its end even though the child still waits on its worker; an auto-approved plan
// is not an ask and stays held.
test('a question or a plan for the user passes through the hold', async (t) => {
  const cases = [
    ['a question', { kind: 'user_question', toolUseId: 'q1' }, 1],
    ['a plan awaiting approval', { kind: 'plan_request', toolUseId: 'p1' }, 1],
    ['an auto-approved plan stays held', { kind: 'plan_request', toolUseId: 'p2', autoApproved: true }, 0],
  ];
  for (const [name, ev, wakes] of cases) {
    await t.test(name, async () => {
      const r = rig();
      const { P, C } = chain(r);
      r.emit(C, ev);
      r.end(C);
      await tick();
      assert.equal(P.calls.length, wakes);
      await r.teardown();
    });
  }
});

// Invariant: an ask outlives a turn end whose wake was deferred target-side, and
// passes through when that wake resolves.
test('an ask in a turn whose wake was deferred still passes through at the re-invocation turn end', async () => {
  const r = rig();
  const { P, C } = chain(r);
  r.emit(C, { kind: 'user_question', toolUseId: 'q1' });
  C.activeAgentTaskCount = 1;
  r.end(C);
  await tick();
  assert.equal(P.calls.length, 0, 'deferred on the live subagent');
  C.activeAgentTaskCount = 0;
  r.start(C); r.end(C);
  await tick();
  assert.equal(P.calls.length, 1, 'the ask still passed through');
  await r.teardown();
});

// Invariant: an ask whose wake was delivered does not make a later turn pass
// through.
test('an ask does not leak into a later held turn', async () => {
  const r = rig();
  const { P, C } = chain(r);
  r.emit(C, { kind: 'user_question', toolUseId: 'q1' });
  r.end(C);
  await tick();
  assert.equal(P.calls.length, 1, 'premise: the ask woke the owner');
  P.status = 'idle';
  r.start(C); r.end(C);
  await tick();
  assert.equal(P.calls.length, 1, 'the next turn, with no ask, is held');
  await r.teardown();
});

// Invariant: a force-aborted turn is reported at its end, as INTERRUPTED, even
// while the child still waits on its worker.
test('a force-aborted turn passes through the hold as INTERRUPTED', async () => {
  const r = rig();
  const { P, C } = chain(r);
  C.turnForceAborted = true;
  r.end(C);
  await tick();
  assert.equal(P.calls.length, 1);
  assert.match(P.calls[0].text, /INTERRUPTED/);
  assert.ok(!folded(P.calls[0]), 'partial output is not folded');
  await r.teardown();
});

// Invariant: a held entry keeps the heartbeat it was armed with across the
// child's turns — no turn start re-arms it.
test('a held wake keeps one heartbeat interval across the child\'s turns', async () => {
  const r = rig();
  chain(r);
  const before = r.hub.subscribers.get('C').get('P').timerId;
  r.end(r.fakes.C); r.start(r.fakes.C); r.end(r.fakes.C);
  assert.equal(r.hub.subscribers.get('C').get('P').timerId, before);
  await r.teardown();
});

// Invariant: while the child sits idle holding the owner's wake, the heartbeat
// still reports "did NOT finish" without consuming, and the real wake still
// arrives afterwards.
test('the heartbeat reports a held child and leaves the wake armed', async () => {
  const r = rig();
  const { P, C, G } = chain(r, { windowMs: 30 });
  r.end(C);
  await until(() => P.calls.length > 0);
  assert.match(P.calls[0].text, /did NOT finish/);
  assert.equal(r.hub.subscribers.get('C')?.has('P'), true, 'still armed after the beat');
  r.end(G);
  await tick();
  r.end(C);
  // P's beats opened turns of its own, so the real wake may arrive folded or as
  // a mid-turn stub; either way it is the one call that is not a beat.
  const real = () => P.calls.filter(c => !/did NOT finish/.test(c.text));
  await until(() => real().length > 0);
  assert.equal(real().length, 1, 'the real wake arrived once');
  assert.equal(r.hub.subscribers.get('C')?.has('P') ?? false, false, 'and consumed the entry');
  await r.teardown();
});

// Invariant: a dispatch to a target its owner is already armed on restarts that
// pair's heartbeat; set_idle_timeout still re-arms too.
test('a dispatch to an armed pair restarts its heartbeat', async () => {
  const r = rig();
  const { P, C } = chain(r);
  const first = r.hub.subscribers.get('C').get('P').timerId;
  r.own(P, C);
  const second = r.hub.subscribers.get('C').get('P').timerId;
  assert.notEqual(second, first, 'noteDispatch replaced the interval');
  r.instances.setIdleTimeout(P.sessionId, C.sessionId, 60_000);
  assert.notEqual(r.hub.subscribers.get('C').get('P').timerId, second, 'setIdleTimeout replaced it too');
  await r.teardown();
});

// Invariant: removing the last worker an idle child was waiting on wakes the
// child's owner once with the child's output, and wakes the child not at all.
test('removing the worker an idle child waits on releases the owner\'s held wake', async () => {
  const r = rig();
  const { P, C } = chain(r);
  r.end(C);
  r.instances.byId.delete('G');
  r.instances._purgeIdleFor('G');
  await tick();
  assert.equal(P.calls.length, 1);
  assert.ok(folded(P.calls[0]));
  assert.equal(C.calls.length, 0, 'a removal delivers nothing to the child');
  await r.teardown();
});

// Invariant: the removal release never fires for a child that is deferring its
// own wake target-side, or whose process is gone — only for a live child with
// nothing still outstanding.
test('the removal release skips a child that is deferring or has no process', async (t) => {
  const cases = [
    ['live child, nothing outstanding', () => {}, 1],
    ['child with a live subagent', (C) => { C.activeAgentTaskCount = 1; }, 0],
    ['child with no process', (C) => { C.proc = null; }, 0],
  ];
  for (const [name, mutate, wakes] of cases) {
    await t.test(name, async () => {
      const r = rig();
      const { P, C } = chain(r);
      r.end(C);
      mutate(C);
      r.instances.byId.delete('G');
      r.instances._purgeIdleFor('G');
      await tick();
      assert.equal(P.calls.length, wakes);
      await r.teardown();
    });
  }
});

// Invariant: a worker whose wake to the child is decided but not yet delivered
// (an idle-drain settle pending) is still work, so no other cleared wait releases
// the owner early; the owner is woken exactly once, after the child has had the
// worker's result.
test('a worker with an idle-drain settle pending keeps the owner held until the child\'s real turn end', async () => {
  const r = rig();
  const { P, C, G } = chain(r);
  const H = r.mk('H');
  r.own(C, H); r.start(H);
  G.activeAgentTaskCount = 1;
  r.end(G); // deferred on the live subagent
  r.end(C); // held
  G.activeAgentTaskCount = 0;
  r.emit(G, { kind: 'system', subtype: 'task_notification', data: { task_id: 't' } });
  assert.ok(r.hub._pendingSettles.has('G'), 'premise: G\'s settle is pending');
  r.instances.byId.delete('H');
  r.instances._purgeIdleFor('H'); // C's other wait cleared
  await tick();
  assert.equal(P.calls.length, 0, 'not released while G\'s wake to C is pending');
  await until(() => C.calls.length === 1, SETTLE_MS + 5000);
  assert.equal(P.calls.length, 0, 'C is in the turn G\'s result opened');
  r.end(C);
  await tick();
  assert.equal(P.calls.length, 1, 'one wake, after C\'s real turn end');
  assert.ok(folded(P.calls[0]));
  await r.teardown();
});

// Invariant: a worker that still owes the child an armed wake its settle did not
// deliver — dropped on an idle-time line after the arm, or refused because the
// window was already dirty — is work: a sibling purge does not release the
// owner, the child's heartbeat-driven turns stay held, and the owner is woken
// exactly once, after the worker's turn has reached the child and the child's
// real turn end — with no second wake afterwards.
test('a worker whose settle did not deliver keeps the owner held, and the owner is woken once', async (t) => {
  const cases = [
    ['settle dropped after its arm', (r, G) => {
      r.emit(G, { kind: 'system', subtype: 'task_notification', data: { task_id: 't' } });
      assert.ok(r.hub._pendingSettles.has('G'), 'premise: settle armed');
      G.idleWindowDirty = true; // an idle-time line after the arm
      G.ring.nextSeq += 1;
    }],
    ['settle refused on a dirty window', (r, G) => {
      G.idleWindowDirty = true;
      r.emit(G, { kind: 'system', subtype: 'task_notification', data: { task_id: 't' } });
      assert.equal(r.hub._pendingSettles.has('G'), false, 'premise: settle refused');
    }],
  ];
  for (const [name, settle] of cases) {
    await t.test(name, async () => {
      const r = rig();
      const { P, C, G } = chain(r);
      const H = r.mk('H');
      r.own(C, H); r.start(H);
      r.own(C, G, 30); // C's heartbeat on G, short enough to fire during the test
      G.activeAgentTaskCount = 1;
      r.end(G); // deferred on the live subagent
      r.end(C); // held
      G.activeAgentTaskCount = 0;
      settle(r, G);
      await until(() => !r.hub._pendingSettles.has('G'), SETTLE_MS + 5000);
      assert.equal(r.hub.subscribers.get('G')?.has('C'), true, 'premise: G still owes C its wake');
      r.instances.byId.delete('H');
      r.instances._purgeIdleFor('H');
      await tick();
      assert.equal(P.calls.length, 0, 'the purge does not release P');
      // C acts on a heartbeat about G, and ends that turn: still held.
      await until(() => C.calls.length > 0);
      assert.match(C.calls[0].text, /did NOT finish/);
      r.end(C);
      await tick();
      assert.equal(P.calls.length, 0, 'C\'s heartbeat turn end is held');
      // G's turn finally delivers its wake; C's real turn end wakes P.
      // (C may be in a heartbeat turn, so the wake can arrive plain or folded.)
      r.start(G); r.end(G);
      await until(() => C.calls.some(c => !/did NOT finish/.test(c.text)));
      r.end(C);
      await until(() => P.calls.length > 0);
      assert.ok(folded(P.calls[0]));
      await sleep(120); // several of C's old heartbeat windows: no second wake
      assert.equal(P.calls.length, 1, 'exactly one owner wake in total');
      await r.teardown();
    });
  }
});

// Invariant: a release only delivers wakes a hold decision is holding — an
// armed wake still owed by the target's own undelivered settle is not released
// when another of the target's waits clears.
test('a cleared wait releases a held wake but not one still owed by an undelivered settle', async (t) => {
  for (const [name, held, wakes] of [['held', true, 1], ['owed, not held', false, 0]]) {
    await t.test(name, async () => {
      const r = rig();
      const { C, G } = chain(r);
      const W = r.mk('W');
      if (held) {
        r.own(G, W); r.start(W);
        r.end(G); // held on W
      } else {
        G.activeAgentTaskCount = 1;
        r.end(G); // deferred, never decided
        G.activeAgentTaskCount = 0; // drained with no settle delivering
        r.own(G, W); r.start(W);
      }
      r.hub.disarmSilently('W', 'G');
      await tick();
      assert.equal(C.calls.length, wakes);
      await r.teardown();
    });
  }
});

// Invariant: a project removal that deletes both a child and its worker never
// wakes the child's owner, whichever kill finishes first.
test('removing a project that holds both a child and its worker does not wake the child\'s owner', async (t) => {
  for (const [name, both, wakes] of [['child and worker removed', true, 0], ['only the worker removed', false, 1]]) {
    await t.test(name, async () => {
      const r = rig();
      const { P, C, G } = chain(r, {
        C: { project: both ? 'doomed' : 'p' },
        G: { project: 'doomed' },
      });
      r.end(C);
      // G's kill resolves at once; C's waits until after G has been purged.
      let releaseC;
      const cGate = new Promise((res) => { releaseC = res; });
      G.kill = async () => { G.proc = null; };
      C.kill = async () => { await cGate; C.proc = null; };
      const removal = r.instances.removeAllForProject('doomed');
      await until(() => !r.instances.byId.has('G'));
      await tick();
      releaseC();
      await removal;
      await tick();
      assert.equal(P.calls.length, wakes);
      await r.teardown();
    });
  }
});

// Invariant: the removal release never wakes the owner while the child is
// mid-turn — the child's own turn end decides.
test('removing the worker of a mid-turn child leaves the decision to the child\'s turn end', async () => {
  const r = rig();
  const { P, C } = chain(r);
  r.instances.byId.delete('G');
  r.instances._purgeIdleFor('G');
  await tick();
  assert.equal(P.calls.length, 0);
  r.end(C);
  await tick();
  assert.equal(P.calls.length, 1);
  await r.teardown();
});

// Invariant: an owner's own disarm of its worker is a wait ending without a turn,
// so it releases what that owner held.
test('disarming the child\'s last wait releases the owner\'s held wake', async () => {
  const r = rig();
  const { P, C } = chain(r);
  r.end(C);
  r.hub.disarmSilently('G', 'C');
  await tick();
  assert.equal(P.calls.length, 1);
  await r.teardown();
});

// Invariant: a wake to the child that is refused ends the child's wait without a
// turn and releases the owner; one that is sent opens a turn and keeps holding.
test('a refused wake to the child releases the owner; a sent one keeps holding', async (t) => {
  for (const [name, refuse, wakes] of [['refused', true, 1], ['sent', false, 0]]) {
    await t.test(name, async () => {
      const r = rig();
      const { P, C, G } = chain(r);
      if (refuse) C.prompt = async () => { throw new Error('refused'); };
      // Back-to-back in one synchronous run: the wake to C is in flight (its send
      // is a queued microtask) when C's turn ends.
      r.end(G);
      r.end(C);
      assert.equal(P.calls.length, 0, 'held on the in-flight wake');
      await tick();
      assert.equal(P.calls.length, wakes);
      await r.teardown();
    });
  }
});

// Invariant: a wake deferred to a child that cannot take a mid-turn message holds
// the owner at the child's turn end, and that same turn end delivers the child's
// own wake.
test('a wake deferred to the child holds the owner and is flushed at the child\'s turn end', async () => {
  const r = rig();
  const { P, C, G } = chain(r, { C: { acceptsMidTurnSteering: false } });
  r.end(G);
  assert.equal(r.hub._deferredWakes.get('C')?.length, 1, 'premise: deferred');
  r.end(C);
  await tick();
  assert.equal(C.calls.length, 1, 'the deferred wake was flushed');
  assert.equal(P.calls.length, 0, 'the owner was held');
  r.end(C);
  await tick();
  assert.equal(P.calls.length, 1);
  await r.teardown();
});

// Invariant: the hold reaches through any depth — each level is woken exactly
// once, in order, when the level below it ends with nothing outstanding.
test('a chain P ← C ← G ← W wakes each level exactly once, bottom up', async () => {
  const r = rig();
  const { P, C, G } = chain(r);
  const W = r.mk('W');
  r.own(G, W); r.start(W);
  r.end(G); r.end(C);
  await tick();
  assert.deepEqual([P.calls.length, C.calls.length, G.calls.length], [0, 0, 0], 'everything held on W');
  r.end(W);
  await tick();
  assert.deepEqual([P.calls.length, C.calls.length, G.calls.length], [0, 0, 1]);
  r.end(G);
  await tick();
  assert.deepEqual([P.calls.length, C.calls.length, G.calls.length], [0, 1, 1]);
  r.end(C);
  await tick();
  assert.deepEqual([P.calls.length, C.calls.length, G.calls.length], [1, 1, 1]);
  await r.teardown();
});

// Invariant: two sessions that own each other never hold each other's wake for
// good — a target only waiting back on the session being decided does not count.
test('mutual ownership does not deadlock the hold', async () => {
  const r = rig();
  const P = r.mk('P'), C = r.mk('C');
  r.own(P, C); r.own(C, P);
  r.start(C);
  r.start(P);
  r.end(C);
  await tick();
  assert.equal(P.calls.length, 0, 'C ended while P was busy: held');
  r.end(P);
  await tick();
  assert.equal(C.calls.length, 1, 'P ended waiting only on C: not held');
  r.end(C);
  await tick();
  assert.equal(P.calls.length, 1, 'C\'s next turn end released P');
  await r.teardown();
});

// Invariant: a worker that is idle but still running background subagents keeps
// its owner waiting, so the child holds its own owner's wake.
test('a worker idle with live subagents still holds', async () => {
  const r = rig();
  const { P, C, G } = chain(r);
  G.activeAgentTaskCount = 1;
  r.end(G);
  r.end(C);
  await tick();
  assert.equal(P.calls.length, 0);
  await r.teardown();
});

// Invariant: a worker with no process and nothing reviving it is not work, so it
// does not hold.
test('a stopped worker does not hold', async () => {
  const r = rig();
  const { P, C, G } = chain(r);
  G.proc = null; G.status = 'exited';
  r.end(C);
  await tick();
  assert.equal(P.calls.length, 1);
  await r.teardown();
});

// Invariant: the idle task-drain settle and a prune's idle rotation apply the
// same hold as a turn end — and deliver when nothing holds.
test('the idle-drain settle and an idle rotation hold too', async (t) => {
  for (const held of [true, false]) {
    await t.test(`settle, worker ${held ? 'busy' : 'idle'}`, async () => {
      const r = rig();
      const { P, C, G } = chain(r);
      if (!held) { G.status = 'idle'; r.hub.disarmSilently('G', 'C'); }
      C.activeAgentTaskCount = 1;
      r.end(C);
      C.activeAgentTaskCount = 0;
      r.emit(C, { kind: 'system', subtype: 'task_notification', data: { task_id: 't' } });
      assert.ok(r.hub._pendingSettles.has('C'), 'premise: settle armed');
      await until(() => !r.hub._pendingSettles.has('C'), SETTLE_MS + 5000);
      await tick();
      assert.equal(P.calls.length, held ? 0 : 1);
      await r.teardown();
    });
    await t.test(`rotation, worker ${held ? 'busy' : 'idle'}`, async () => {
      const r = rig();
      const { P, C, G } = chain(r);
      if (!held) { G.status = 'idle'; r.hub.disarmSilently('G', 'C'); }
      C.rotationPending = true;
      r.end(C);
      C.rotationPending = false;
      r.emit(C, { kind: 'system', subtype: 'rotation_complete', data: { comesUpIdle: true } });
      await tick();
      assert.equal(P.calls.length, held ? 0 : 1);
      await r.teardown();
    });
  }
});

// Invariant: a held child exiting on its own still wakes the owner, as EXITED.
test('a held child exiting on its own wakes the owner with EXITED', async () => {
  const r = rig();
  const { P, C } = chain(r);
  r.end(C);
  C.proc = null;
  r.hub.onTargetExit('C', { sessionId: C.sessionId, code: 1, signal: null });
  await tick();
  assert.equal(P.calls.length, 1);
  assert.match(P.calls[0].text, /EXITED/);
  await r.teardown();
});

// Invariant: the overage sever of a worker does not release its idle owner's
// held wake — nothing is prompted into the throttled account — and the owner is
// still reported as having lost a callback.
test('an overage sever of the worker does not release the held wake', async () => {
  const r = rig();
  const { P, C } = chain(r);
  r.end(C);
  const lost = r.hub.severForOverageStop('G');
  await tick();
  assert.ok(lost.includes('C'), 'C lost its wait');
  assert.equal(P.calls.length, 0);
  assert.equal(r.hub.subscribers.get('C')?.has('P'), true, 'P stays armed on C');
  await r.teardown();
});

// Invariant: an overage sever that clears a held child's last wait delivers
// nothing, yet leaves the child owing its owner a wake rather than "held with
// nothing outstanding" — so the owner's own owner is not woken until the child
// has actually reported, and then exactly once.
test('an overage sever re-decides the severed child\'s hold without delivering', async () => {
  const r = rig();
  const R = r.mk('R');
  const { P, C, G } = chain(r);
  r.own(R, P); r.start(P); // R owns P, P owns C, C owns G
  r.end(C); // held on G
  r.end(P); // held on C
  r.hub.severForOverageStop('G');
  await tick();
  assert.deepEqual([R.calls.length, P.calls.length], [0, 0], 'the sever delivers nothing');
  r.start(P); r.end(P); // P ends another turn while C still owes it
  await tick();
  assert.equal(R.calls.length, 0, 'P is still held on C');
  r.start(C); r.end(C); // C finally reports to P
  await tick();
  assert.equal(P.calls.length, 1);
  r.end(P);
  await tick();
  assert.equal(R.calls.length, 1, 'R woken once, after C reported');
  await r.teardown();
});

// Invariant: a turn start clears the child's hold marker, so a later turn end
// that defers target-side (and never re-decides the hold) leaves the child
// owing, not held: clearing its last wait does not release the owner.
test('a child\'s new turn clears its hold, so a deferred turn end is not released', async (t) => {
  for (const [name, newTurn, wakes] of [['held turn end', false, 1], ['new turn deferred, then drained', true, 0]]) {
    await t.test(name, async () => {
      const r = rig();
      const { P, C } = chain(r);
      r.end(C); // held on G
      if (newTurn) {
        r.start(C);
        C.activeAgentTaskCount = 1;
        r.end(C); // defers before the hold is decided
        C.activeAgentTaskCount = 0; // drained with no settle delivering
      }
      r.instances.byId.delete('G');
      r.instances._purgeIdleFor('G');
      await tick();
      assert.equal(P.calls.length, wakes);
      await r.teardown();
    });
  }
});

// Invariant: once wakes are suspended, no path delivers anything — a heartbeat,
// a turn end, or a release — and a release consumes nothing either.
test('suspended wakes deliver nothing on any path', async () => {
  const r = rig();
  const { P, C, G } = chain(r, { windowMs: 10 });
  const G2 = r.mk('G2');
  r.own(C, G2); r.start(G2);
  r.end(C);
  r.instances.suspendWakes();
  await sleep(50); // several heartbeat windows of P on the held C
  r.end(G); // a turn end that would wake C
  r.instances.byId.delete('G2');
  r.instances._purgeIdleFor('G2'); // C's last wait cleared: a release of P
  await tick();
  assert.deepEqual([P.calls.length, C.calls.length], [0, 0]);
  assert.equal(r.hub.subscribers.get('C')?.has('P'), true, 'the release consumed nothing');
  await r.teardown();
});
