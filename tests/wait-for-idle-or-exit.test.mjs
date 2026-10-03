// PINS (T7): `waitForIdleOrExit` fails FAST on a worker that dies before idle,
// and its message carries the exit cause — never a bare `waitFor: timeout`.
// A plain-object fake stands in for the Instance: the helper reads only
// `status`, `lastExit` and `id`.

import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import { waitForIdleOrExit } from './helpers.mjs';

const STDERR = 'chroot: cannot change root directory to \'/x\': Transport endpoint is not connected';

function fakeInst() {
  return { id: 'fake-1', status: 'starting', lastExit: null };
}

describe('waitForIdleOrExit', () => {
  test('a worker that crashes before idle rejects with its code and stderr, not a timeout', async () => {
    const inst = fakeInst();
    setTimeout(() => {
      inst.lastExit = { code: 125, signal: null, stderrTail: STDERR };
      inst.status = 'crashed';
    }, 20);
    await assert.rejects(waitForIdleOrExit(inst, { timeout: 2000 }), (e) => {
      assert.notEqual(e.message, 'waitFor: timeout');
      assert.match(e.message, /code=125/);
      assert.ok(e.message.includes(STDERR), e.message);
      return true;
    });
  });

  test('a worker that reaches idle resolves', async () => {
    const inst = fakeInst();
    setTimeout(() => { inst.status = 'idle'; }, 20);
    await waitForIdleOrExit(inst, { timeout: 2000 });
  });

  // The provisional tail is null until the launch's stderr settles, and is then
  // recut in place on the same object.
  test('a stderr tail recut after the exit is the one reported', async () => {
    const inst = fakeInst();
    const cause = { code: 78, signal: null, stderrTail: null };
    setTimeout(() => { inst.lastExit = cause; inst.status = 'crashed'; }, 20);
    setTimeout(() => { cause.stderrTail = STDERR; }, 120);
    await assert.rejects(waitForIdleOrExit(inst, { timeout: 2000 }), (e) => {
      assert.match(e.message, /code=78/);
      assert.ok(e.message.includes(STDERR), e.message);
      return true;
    });
  });

  test('a terminal status with no exit cause says it was commanded', async () => {
    const inst = fakeInst();
    setTimeout(() => { inst.status = 'exited'; }, 20);
    await assert.rejects(waitForIdleOrExit(inst, { timeout: 2000 }), /exited before reaching idle — commanded exit, no cause/);
  });
});
