// The headless completion predicate: InstanceManager.isTreeQuiescent(rootId) is
// true only when the root and every session it transitively owns are idle with
// nothing still coming — no armed, held, in-flight or deferred wake, no
// target-side defer, no running background Bash job, no tool ask on the root.
// IdleSubscriptionHub.ownedTreeOf is the tree it walks.
//
// Hub-level, on a real InstanceManager with plain-object fakes in byId (the
// pattern of tests/idle-wake-hold.test.mjs): ownership through noteDispatch or a
// fake's callerInstanceId, a turn as `status` + onTurnStart, a turn end as the
// manager's turn_end event, a delivered wake opening a turn through the fake's
// prompt() exactly as a real send does.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { InstanceManager } from '../src/instances.ts';
import { posixPlatform } from '../src/platform/posix.ts';

const sleep = (ms) => new Promise(r => setTimeout(r, ms));
const tick = () => sleep(15);

function rig() {
  const instances = new InstanceManager({ platform: posixPlatform });
  const hub = instances._idleHub;
  const mk = (id, over = {}) => {
    const inst = {
      id, sessionId: `${id}-s`, project: 'p', proc: { pid: 1 }, status: 'idle', callerInstanceId: null,
      acceptsMidTurnSteering: true, steerPending: false, activeAgentTaskCount: 0, backgroundJobs: [],
      taskNotificationPending: false, rotationPending: false, idleWindowDirty: false, relaunching: false,
      _stopInterruptedTurn: false, turnForceAborted: false, liveTurnEnds: 1, awaitingUserSource: null,
      consumeTurnForceAborted() { const was = inst.turnForceAborted; inst.turnForceAborted = false; return was; },
      _emitUi() {}, ring: { trimmedBefore: 0, nextSeq: 0 }, ringSnapshot() { return []; },
      summary() {
        return {
          id, sessionId: inst.sessionId, status: inst.status, liveTurnEnds: inst.liveTurnEnds,
          awaitingUser: inst.awaitingUserSource ? 'question' : null, awaitingUserSource: inst.awaitingUserSource,
        };
      },
      async prompt() { if (inst.status !== 'turn') { inst.status = 'turn'; hub.onTurnStart(id); } },
      ...over,
    };
    instances.byId.set(id, inst);
    return inst;
  };
  const own = (owner, target) => instances.noteDispatch(owner.sessionId, target.sessionId);
  const start = (x) => { x.status = 'turn'; hub.onTurnStart(x.id); };
  const end = (x) => {
    x.status = 'idle';
    instances.emit('event', { id: x.id, ev: { kind: 'turn_end', isError: false, stopReason: 'end_turn' } });
  };
  const teardown = async () => {
    for (const subs of hub.subscribers.values()) for (const { timerId } of subs.values()) clearInterval(timerId);
    hub.subscribers.clear();
    hub._inFlight.clear();
    hub._cancelAllSettles();
    await tick();
    await instances.shutdown().catch(() => {});
  };
  return { instances, hub, mk, own, start, end, teardown };
}

test('a root alone, idle after its first turn with nothing pending, is quiescent', async () => {
  const r = rig();
  r.mk('R');
  assert.equal(r.instances.isTreeQuiescent('R'), true);
  await r.teardown();
});

test('the root itself: not before its first turn ends, not mid-turn, not when gone', async (t) => {
  for (const [name, over] of [
    ['no turn has ended yet', { liveTurnEnds: 0 }],
    ['mid-turn', { status: 'turn' }],
    ['starting', { status: 'starting' }],
    ['its process gone', { proc: null, status: 'exited' }],
  ]) {
    await t.test(name, async () => {
      const r = rig();
      r.mk('R', over);
      assert.equal(r.instances.isTreeQuiescent('R'), false);
      await r.teardown();
    });
  }
  const r = rig();
  assert.equal(r.instances.isTreeQuiescent('nobody'), false, 'an unknown root');
  await r.teardown();
});

test('a tool ask on the root blocks; a text ask does not', async () => {
  const r = rig();
  const R = r.mk('R', { awaitingUserSource: 'tool' });
  assert.equal(r.instances.isTreeQuiescent('R'), false);
  R.awaitingUserSource = 'text';
  assert.equal(r.instances.isTreeQuiescent('R'), true);
  await r.teardown();
});

test('a spawned worker mid-turn blocks, and its delivered wake ends the block only once the root has handled it', async () => {
  const r = rig();
  const R = r.mk('R');
  const W = r.mk('W', { callerInstanceId: 'R' });
  r.start(W);
  assert.equal(r.instances.isTreeQuiescent('R'), false, 'worker mid-turn, root armed');
  r.end(W);
  await tick();
  assert.equal(R.status, 'turn', 'the wake opened a root turn');
  assert.equal(r.instances.isTreeQuiescent('R'), false);
  r.end(R);
  await tick();
  assert.equal(r.instances.isTreeQuiescent('R'), true, 'every owned session idle, no armed wake');
  await r.teardown();
});

test('a wake in flight to the root blocks', async () => {
  const r = rig();
  r.mk('R');
  r.hub._inFlight.set('R', 1);
  assert.equal(r.instances.isTreeQuiescent('R'), false);
  r.hub._inFlight.delete('R');
  assert.equal(r.instances.isTreeQuiescent('R'), true);
  await r.teardown();
});

test('an idle section lead waiting on its own mid-turn worker blocks the root', async () => {
  const r = rig();
  const R = r.mk('R'), C = r.mk('C'), G = r.mk('G');
  r.own(R, C); r.own(C, G);
  r.start(G);
  assert.equal(r.instances.isIdleCaller('R'), false, 'fixture check: nothing armed on the root');
  assert.equal(r.instances.isTreeQuiescent('R'), false, 'the grandchild is in the tree');
  r.end(G);
  await tick();
  r.end(C);
  await tick();
  assert.equal(R.status, 'turn', 'the lead\'s turn end woke the root');
  r.end(R);
  await tick();
  assert.equal(r.instances.isTreeQuiescent('R'), true);
  await r.teardown();
});

test('a target-side defer on an owned session blocks', async (t) => {
  for (const [name, over] of [
    ['a live background agent', { activeAgentTaskCount: 1 }],
    ['a pending task notification', { taskNotificationPending: true }],
    ['a pending rotation', { rotationPending: true }],
    ['a parked steer', { steerPending: true }],
  ]) {
    await t.test(name, async () => {
      const r = rig();
      r.mk('R');
      r.mk('W', { callerInstanceId: 'R', ...over });
      assert.equal(r.instances.isTreeQuiescent('R'), false);
      await r.teardown();
    });
  }
});

test('a running background Bash job anywhere in the tree blocks', async () => {
  const r = rig();
  r.mk('R');
  const W = r.mk('W', { callerInstanceId: 'R', backgroundJobs: [{ title: 'sleep 60', startedAt: 0 }] });
  assert.equal(r.instances.isTreeQuiescent('R'), false);
  W.backgroundJobs = [];
  assert.equal(r.instances.isTreeQuiescent('R'), true);
  await r.teardown();
});

test('an exited or crashed worker does not block; a live busy one does', async () => {
  const r = rig();
  r.mk('R');
  const W = r.mk('W', { callerInstanceId: 'R', status: 'turn' });
  assert.equal(r.instances.isTreeQuiescent('R'), false, 'positive control');
  for (const status of ['exited', 'crashed']) {
    Object.assign(W, { status, proc: null });
    assert.equal(r.instances.isTreeQuiescent('R'), true, status);
  }
  await r.teardown();
});

test('ownedTreeOf follows spawn and dispatch ownership transitively, and only below the root', async () => {
  const r = rig();
  const R = r.mk('R'), C = r.mk('C');
  r.mk('S', { callerInstanceId: 'R' });
  const G = r.mk('G', { callerInstanceId: 'C' });
  const other = r.mk('X'), Y = r.mk('Y');
  r.own(R, C);
  r.own(other, Y);
  assert.deepEqual(r.hub.ownedTreeOf('R').sort(), ['C', 'G', 'S']);
  assert.deepEqual(r.hub.ownedTreeOf(G.id), []);
  await r.teardown();
});

test('ownedTreeOf terminates on mutual ownership and never lists the root', async () => {
  const r = rig();
  const R = r.mk('R'), C = r.mk('C');
  r.own(R, C); r.own(C, R);
  assert.deepEqual(r.hub.ownedTreeOf('R'), ['C']);
  assert.equal(r.instances.isTreeQuiescent('R'), true);
  await r.teardown();
});

// A temp section lead leaves byId the moment its CLI exits (and remove() drops
// any lead), taking its ownership edges with it; its workers still carry the
// root's durable attribution (rootSessionId, set at create), and a busy one
// must still block.
test('a grandchild whose section lead left byId still blocks while mid-turn', async () => {
  const r = rig();
  const R = r.mk('R');
  const C = r.mk('C', { conducted: true, rootSessionId: 'R-s' });
  const G = r.mk('G', { conducted: true, rootSessionId: 'R-s' });
  r.own(R, C); r.own(C, G);
  r.start(G);
  r.instances.byId.delete(C.id);
  r.instances._purgeIdleFor(C.id);
  assert.deepEqual(r.hub.ownedTreeOf('R'), [], 'fixture check: the ownership walk no longer reaches G');
  assert.equal(r.instances.isTreeQuiescent('R'), false);
  r.end(G);
  await tick();
  assert.equal(R.status, 'idle', 'nobody is left to wake');
  assert.equal(r.instances.isTreeQuiescent('R'), true, 'idle once the grandchild is');
  await r.teardown();
});

test('root attribution counts only conducted sessions attributed to this root', async () => {
  const r = rig();
  r.mk('R');
  r.mk('X', { conducted: true, rootSessionId: 'other-root-s', status: 'turn' });
  r.mk('N', { conducted: false, rootSessionId: 'R-s', status: 'turn' });
  assert.equal(r.instances.isTreeQuiescent('R'), true);
  r.mk('W', { conducted: true, rootSessionId: 'R-s', status: 'turn' });
  assert.equal(r.instances.isTreeQuiescent('R'), false);
  await r.teardown();
});
