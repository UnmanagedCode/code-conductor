// GET /api/sessions/:sid/spawner: a session's recorded spawn lineage, read by the ended pane's owner chip.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { bootServer, api } from './helpers.mjs';
import { markConducted, setSegmentArchived, setTitle } from '../src/sessionStore.ts';

const id = (n) => `bbbbbbbb-0000-4000-8000-${String(n).padStart(12, '0')}`;
const [C, W, G, PLAIN, UNKNOWN, ARCH] = [1, 2, 3, 4, 5, 6].map(id);
const NONE = { conducted: false, parentSessionId: null, rootSessionId: null };

// INVARIANT: the endpoint reports the recorded parent and its resolved root regardless of liveness
// or archive state; a non-conducted or unknown session reports the not-conducted shape; an invalid id is 400.
test('GET /api/sessions/:sid/spawner reports the recorded parent and resolved root', async () => {
  const { baseUrl, close } = await bootServer();
  try {
    await setTitle(C, 'top-level conductor'); // a root is a stored, non-conducted record
    await markConducted(W, { parent: C });
    await markConducted(G, { parent: W });
    await markConducted(ARCH, { parent: C });
    await setSegmentArchived(ARCH, true);

    const w = await api(baseUrl, 'GET', `/api/sessions/${W}/spawner`);
    assert.equal(w.status, 200);
    assert.deepEqual(w.body, { conducted: true, parentSessionId: C, rootSessionId: C });

    const g = await api(baseUrl, 'GET', `/api/sessions/${G}/spawner`);
    assert.deepEqual(g.body, { conducted: true, parentSessionId: W, rootSessionId: C }, 'a grandchild names its parent and the root');

    const arch = await api(baseUrl, 'GET', `/api/sessions/${ARCH}/spawner`);
    assert.deepEqual(arch.body, { conducted: true, parentSessionId: C, rootSessionId: C }, 'an archived worker still answers its lineage');

    const plain = await api(baseUrl, 'GET', `/api/sessions/${PLAIN}/spawner`);
    assert.deepEqual(plain.body, NONE);
    const unknown = await api(baseUrl, 'GET', `/api/sessions/${UNKNOWN}/spawner`);
    assert.equal(unknown.status, 200);
    assert.deepEqual(unknown.body, NONE);

    const bad = await api(baseUrl, 'GET', '/api/sessions/bad%20id/spawner');
    assert.equal(bad.status, 400);
  } finally { await close(); }
});
