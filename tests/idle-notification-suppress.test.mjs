// Integration tests for turn_notification suppression during conductor orchestration.
//
// Verifies that the idle hub's onTurnEnd() listener (registered first on the
// InstanceManager event emitter) and wsHub's turn_notification handler (registered
// second by attachWsHub) interact correctly:
//
//   Condition 1: conductor's own turn_end while subscribed to a worker → suppressed
//   Condition 2: worker's turn_end with a subscribed conductor watching → suppressed
//   Baseline:    standalone session with no subscription → notified normally
//
// Tests drive both listeners through the real InstanceManager.emit('event', ...) path
// so the ordering dependency is exercised end-to-end without a full server boot.

import { test, after } from 'node:test';
import assert from 'node:assert/strict';
import { EventEmitter } from 'node:events';
import { WebSocket } from 'ws';
import { InstanceManager } from '../src/instances.js';
import { attachWsHub } from '../src/wsHub.js';

// Minimal fake WebSocketServer: provides `clients` + EventEmitter surface.
// Captured .send() calls are collected in `received` for assertion.
function makeFakeWss() {
  const received = [];
  const mockClient = {
    readyState: WebSocket.OPEN,
    send(msg) { received.push(JSON.parse(msg)); },
  };
  const wss = Object.assign(new EventEmitter(), { clients: new Set([mockClient]) });
  return { wss, received };
}

// Inject a minimal fake instance into the manager's byId map.
// `proc` is truthy so IdleSubscriptionHub.isLive() treats it as live.
function injectFakeInstance(instances, { id, sessionId, activeAgentTaskCount = 0 }) {
  const inst = {
    id,
    sessionId,
    project: 'test-project',
    proc: { pid: 999 },   // marks as "live" for subscribe() isLive() check
    status: 'idle',
    // Real Instances expose this getter; IdleSubscriptionHub.onTurnEnd reads it
    // to gate the wake on the worker's live background-subagent count.
    activeAgentTaskCount,
    prompt: async () => {},   // no-op; called by deliver() in a microtask
  };
  instances.byId.set(id, inst);
  return inst;
}

// Emit a real turn_end through the InstanceManager (the same path the
// real system uses): Instance._emitUi() → inst.emit('event') → manager.emit('event').
// Here we skip the Instance layer and emit directly on the manager, which is
// where both the idle hub and wsHub register their listeners.
function emitTurnEnd(instances, instanceId) {
  instances.emit('event', {
    id: instanceId,
    ev: { kind: 'turn_end', isError: false, stopReason: 'end_turn', costDelta: null, cost: null },
  });
}

function turnNotificationsFor(received, instanceId) {
  return received.filter(m => m.t === 'turn_notification' && m.id === instanceId);
}

// Shared manager + wss wired up once.
const instances = new InstanceManager();
const { wss, received } = makeFakeWss();
// ORDERING: attachWsHub registers its 'event' listener AFTER the idle hub
// (registered in InstanceManager's constructor). This ordering is what
// shouldSuppressTurnNotification() depends on for Condition 2.
attachWsHub({ wss, instances });

after(() => instances.shutdown().catch(() => {}));

test('Condition 1: conductor turn_end suppressed while it is subscribed as caller to a worker', () => {
  received.length = 0;

  const condId = 'cond-inst-1';
  const condSid = 'cond-session-1';
  const workId = 'work-inst-1';
  const workSid = 'work-session-1';

  injectFakeInstance(instances, { id: condId, sessionId: condSid });
  injectFakeInstance(instances, { id: workId, sessionId: workSid });

  // Conductor subscribes to worker — conductor is now isCaller(condSid) === true.
  instances.subscribeIdle(condSid, workSid);

  // Conductor's OWN turn ends. The worker subscription is still pending.
  emitTurnEnd(instances, condId);

  const notifs = turnNotificationsFor(received, condId);
  assert.equal(notifs.length, 0,
    'conductor turn_notification must be suppressed while it has an active idle subscription');

  // Clean up
  instances._idleSubscribers.clear();
  instances.byId.delete(condId);
  instances.byId.delete(workId);
});

test('Condition 2: worker turn_end suppressed when a conductor is subscribed to it', () => {
  received.length = 0;

  const condId = 'cond-inst-2';
  const condSid = 'cond-session-2';
  const workId = 'work-inst-2';
  const workSid = 'work-session-2';

  injectFakeInstance(instances, { id: condId, sessionId: condSid });
  injectFakeInstance(instances, { id: workId, sessionId: workSid });

  instances.subscribeIdle(condSid, workSid);

  // Worker's turn ends — idle hub fires first (consumes subscription + sets
  // _justConsumed), then wsHub handler checks and suppresses.
  emitTurnEnd(instances, workId);

  const notifs = turnNotificationsFor(received, workId);
  assert.equal(notifs.length, 0,
    'worker turn_notification must be suppressed when a conductor is subscribed to it');

  // Subscription was consumed; confirm state is clean.
  assert.equal(instances._idleHub.hasSubscriber(workSid), false);

  instances.byId.delete(condId);
  instances.byId.delete(workId);
});

test('Baseline: standalone session turn_end fires turn_notification normally', () => {
  received.length = 0;

  const soloId = 'solo-inst-3';
  const soloSid = 'solo-session-3';

  injectFakeInstance(instances, { id: soloId, sessionId: soloSid });

  // No subscription registered.
  emitTurnEnd(instances, soloId);

  const notifs = turnNotificationsFor(received, soloId);
  assert.equal(notifs.length, 1,
    'standalone session must still receive a turn_notification');
  assert.equal(notifs[0].project, 'test-project');

  instances.byId.delete(soloId);
});

test('Condition 1: conductor turn_notification fires after its subscription is consumed', () => {
  received.length = 0;

  // Once the WORKER's turn ends (subscription consumed), the conductor's
  // NEXT turn_end is no longer suppressed (isCaller is false).
  const condId = 'cond-inst-4';
  const condSid = 'cond-session-4';
  const workId = 'work-inst-4';
  const workSid = 'work-session-4';

  injectFakeInstance(instances, { id: condId, sessionId: condSid });
  injectFakeInstance(instances, { id: workId, sessionId: workSid });

  instances.subscribeIdle(condSid, workSid);

  // Worker finishes → subscription consumed.
  emitTurnEnd(instances, workId);
  received.length = 0; // discard worker's suppressed notification

  // Now conductor finishes its own next turn — subscription is gone, not suppressed.
  emitTurnEnd(instances, condId);

  const notifs = turnNotificationsFor(received, condId);
  assert.equal(notifs.length, 1,
    'conductor turn_notification must fire once subscription has been consumed');

  instances.byId.delete(condId);
  instances.byId.delete(workId);
});
