// GET /api/conductors/projects: the per-root-owner spawned-projects map
// the Conductors lens's idle chips read, served over REST.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { bootServer, api } from './helpers.mjs';
import { markConducted, setTitle } from '../src/sessionStore.ts';

const C = 'cccccccc-0000-4000-8000-000000000003';
const W1 = 'dddddddd-0000-4000-8000-000000000004';
const W2 = 'eeeeeeee-0000-4000-8000-000000000005';

test('GET /api/conductors/projects returns each root owner\'s spawned projects', async () => {
  const { baseUrl, close } = await bootServer();
  try {
    await setTitle(C, 'the conductor');
    await markConducted(W1, { parent: C, project: 'mid', worktree: 'wt-mid' });
    await markConducted(W2, { parent: W1, project: 'nested' });
    const res = await api(baseUrl, 'GET', '/api/conductors/projects');
    assert.equal(res.status, 200);
    assert.deepEqual(Object.keys(res.body), [C], 'the nested worker is attributed to the root, not its intermediate');
    assert.deepEqual(res.body[C].map(e => e.project).sort(), ['mid', 'nested']);
    for (const e of res.body[C]) {
      assert.deepEqual(Object.keys(e).sort(), ['lastSpawnAt', 'project', 'worktrees']);
      assert.equal(typeof e.lastSpawnAt, 'string');
    }
    const byProject = Object.fromEntries(res.body[C].map(e => [e.project, e.worktrees]));
    assert.deepEqual(byProject, { mid: ['wt-mid'], nested: [] }, 'the recorded worktree names; a main-checkout worker has none');
  } finally { await close(); }
});
