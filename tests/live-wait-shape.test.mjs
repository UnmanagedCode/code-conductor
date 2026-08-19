// The LIVE `wait:true` branch subscribes its turn_end waiter BEFORE sending.
//
// This is the one pin a real-instance test cannot make honestly: with the
// in-process launcher, prompt() writes to a PassThrough and the engine reads on
// a later tick, so a turn_end can never arrive before prompt() resolves — a real
// instance physically cannot distinguish "listener attached before the send"
// from "attached after". A scripted collaborator whose prompt() emits
// synchronously makes the ordering explicit and assertable instead.
//
// Real InstanceManager driven with a fake injected into instances.byId, the
// tests/deferred-wake.test.mjs precedent.

import { test, after } from 'node:test';
import assert from 'node:assert/strict';
import { EventEmitter } from 'node:events';
import { InstanceManager } from '../src/instances.ts';
import { sendPrompt } from '../src/mcp/handlers.ts';

const instances = new InstanceManager();
const injected = [];
after(async () => {
  for (const i of injected) instances.byId.delete(i.id);
  await instances.shutdown().catch(() => {});
});

// EventEmitter so waitForEvent's inst.on('event' | 'status', …) works.
// `proc != null` is what liveForSession requires; acceptsMidTurnSteering true
// (its default polarity) keeps sendPrompt on the LIVE branch.
function makeFake(overrides) {
  const inst = Object.assign(new EventEmitter(), {
    id: 'fake-live-1',
    sessionId: 'sess-live-1',
    project: 'test-project',
    proc: { pid: 999 },
    status: 'idle',
    acceptsMidTurnSteering: true,
  }, overrides);
  injected.push(inst);
  instances.byId.set(inst.id, inst);
  return inst;
}

test('the turn_end waiter is subscribed before the send, so an in-flight turn_end is caught', async () => {
  // The fake emits its turn_end synchronously INSIDE prompt(), before resolving —
  // the one ordering a real instance cannot reproduce.
  let inFlight = false, emittedInFlight = false, calls = 0;
  const inst = makeFake({
    async prompt(text) {
      calls++; inFlight = true;
      inst.emit('event', { kind: 'turn_end', isError: false, stopReason: 'end_turn', text });
      emittedInFlight = inFlight;
      inFlight = false;
    },
  });

  const res = await sendPrompt(
    { sessionId: inst.sessionId, text: 'RACE', wait: true, waitTimeoutMs: 40, subscribe: false },
    { instances },
  );

  // FORCING MECHANISM, asserted.
  assert.equal(calls, 1, 'prompt() was called exactly once');
  assert.ok(emittedInFlight, 'the turn_end really was emitted while prompt() was still running');
  // The pin.
  assert.equal(res.turnEnd?.kind, 'turn_end', 'the in-flight turn_end was caught, not missed');
  assert.equal(res.turnEnd?.text, 'RACE', 'and the value came from the waiter, not from prompt() resolving');
  assert.equal(res.subscribeSkipped, 'wait');
});
