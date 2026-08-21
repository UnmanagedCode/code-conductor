// driveTurn (tests/helpers.mjs) must wait for a turn_end that lands strictly
// AFTER send() resolves — not just any turn_end already on the ring. This is
// its whole reason to exist over `status === 'idle'` polling (see the doc
// comment on driveTurn): a naive `>=` comparison — or a version of driveTurn
// that skips waiting entirely — is satisfied by the turn_end already present
// before send() was ever called, and would return early.
//
// Exercised against a fake `instances`/instance pair (just idsForSession/get/
// ringSnapshot), no server, so this stays fast and deterministic.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { driveTurn } from './helpers.mjs';

function fakeInstances(getRing) {
  return {
    idsForSession: () => ['id1'],
    get: () => ({ ringSnapshot: getRing }),
  };
}

test('driveTurn does not resolve until a turn_end lands after send() returns', async () => {
  let ring = [{ kind: 'turn_end', _seq: 1 }];
  const instances = fakeInstances(() => ring);

  const send = async () => {
    // The new turn_end lands 60ms after send() resolves — simulating the real
    // race where the MCP call returns before the worker's turn_end event
    // arrives on the ring.
    setTimeout(() => { ring = [...ring, { kind: 'turn_end', _seq: 2 }]; }, 60);
    return 'sent';
  };

  const resultPromise = driveTurn(instances, 'sess', send);
  let resolved = false;
  resultPromise.then(() => { resolved = true; });

  // Shortly after send() would have resolved, but before the new turn_end
  // lands: driveTurn must still be waiting.
  await new Promise(r => setTimeout(r, 15));
  assert.equal(resolved, false, 'driveTurn resolved before a new turn_end appeared on the ring');

  const res = await resultPromise;
  assert.equal(res, 'sent');
  assert.equal(resolved, true);
});
