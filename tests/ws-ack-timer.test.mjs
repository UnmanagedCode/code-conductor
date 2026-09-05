// public/ws.js's {ack:true} send timer — what it holds and for how long.
//
// Two mechanisms with different jobs, and this file pins both because either one
// alone is a different, weaker guarantee (card 2026-0344):
//   * clearTimeout on ack is THE FIX — an acked send leaves nothing behind at all;
//   * unref is the structural belt — a send whose ack never arrives still cannot
//     hold a Node process's event loop open for ten seconds.
// Before both, every {ack:true} send parked a ref'd 10s timer that nothing ever
// cleared. Two DOM header test files each sat idle for ~10.5s after their last
// assertion passed, which is ~42s of a `gate:systems` run spent waiting on a timer
// whose callback was already a no-op.
//
// The 10s REJECT is a contract, not an accident (tests/ws-deferred-steer.test.mjs:
// sendCardAnswer's onFail re-opens the card), so it is pinned here too — that is
// what stops the fix being "delete the timer". Driven with mock timers: no real
// sleep.
//
// It drives the REAL public/ws.js over tests/fakeSocket.mjs, the same fake the two
// header files use, so what is asserted is the module the browser loads.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { installFakeSocket } from './fakeSocket.mjs';

const PUB = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', 'public');
// ws.js reads `location` to build its URL; nothing here asserts on the URL.
globalThis.location = { protocol: 'http:', host: 'localhost:0' };
const ws = await import(pathToFileURL(path.join(PUB, 'ws.js')).href);

// The shared fake acks every frame carrying a reqId. The two variants below
// SUBCLASS it rather than paste a second copy: they differ only in what comes
// back, and `static OPEN` resolves up the prototype chain.
function installVariant(sent, reply) {
  installFakeSocket(sent);
  const Acking = globalThis.WebSocket;
  globalThis.WebSocket = class extends Acking {
    send(raw) {
      const msg = JSON.parse(raw);
      sent.push(msg);
      const ack = reply(msg);
      if (!ack) return;
      const ev = new Event('message');
      ev.data = JSON.stringify(ack);
      this.dispatchEvent(ev);
    }
  };
}

const liveTimers = () => process.getActiveResourcesInfo().filter(r => r === 'Timeout').length;

test('an acked send leaves no timer behind — the handle is cleared, not merely unref\'d', async () => {
  const sent = [];
  installFakeSocket(sent);
  ws.connect();

  // Instrumented pass-throughs, so the assertion can tell THE FIX (clearTimeout)
  // from THE BELT (unref): an unref'd timer is already absent from
  // getActiveResourcesInfo (verified on node 24), so that count alone would go
  // green on the belt alone.
  const created = [];
  const cleared = [];
  const realSet = globalThis.setTimeout;
  const realClear = globalThis.clearTimeout;
  globalThis.setTimeout = (fn, ms, ...rest) => {
    const h = realSet(fn, ms, ...rest);
    created.push({ h, ms });
    return h;
  };
  globalThis.clearTimeout = (h) => { cleared.push(h); return realClear(h); };

  const before = liveTimers();
  let acked;
  try {
    acked = await ws.send('ping', { x: 1 }, { ack: true });
  } finally {
    globalThis.setTimeout = realSet;
    globalThis.clearTimeout = realClear;
  }

  assert.equal(acked.ok, true, 'sanity: the fake acked this send');
  assert.equal(liveTimers(), before, 'the ack timer no longer keeps the loop alive');
  const ackTimer = created.find(c => c.ms === 10_000);
  assert.ok(ackTimer, 'sanity: the send armed a 10s ack timer');
  assert.ok(cleared.includes(ackTimer.h), 'the ack path cleared the very handle it armed');
});

test('an unacked send still rejects with `timeout` at the 10s deadline', async (t) => {
  // The contract tests/ws-deferred-steer.test.mjs names. Mock timers, so nothing
  // waits ten real seconds — and note the mock's handle carries no `unref`, which
  // is why ws.js guards that call.
  t.mock.timers.enable({ apis: ['setTimeout'] });
  const sent = [];
  installVariant(sent, () => null); // the server never answers
  ws.connect();

  const settled = ws.send('ping', {}, { ack: true }).then(() => 'resolved', e => e.message);
  t.mock.timers.tick(9_999);
  assert.equal(await Promise.race([settled, Promise.resolve('pending')]), 'pending',
    'it must not reject early');
  t.mock.timers.tick(1);
  assert.equal(await settled, 'timeout');
});

test('a refused ack still rejects with the server\'s error, and still leaves no timer', async () => {
  // Guards the clearTimeout being inserted on only ONE of the two ack paths: the
  // resolve path is covered above, this is the reject path.
  const sent = [];
  installVariant(sent, msg => ({ t: 'ack', reqId: msg.reqId, ok: false, error: 'refused by the server' }));
  ws.connect();

  const before = liveTimers();
  await assert.rejects(ws.send('ping', {}, { ack: true }), /refused by the server/);
  assert.equal(liveTimers(), before, 'the reject path clears its timer too');
});
