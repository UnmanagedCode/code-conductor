// GET /api/sessions/:sid/workers: the sessions a session spawned directly, live
// or not, as rows plus their recorded place.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import path from 'node:path';
import { bootServer, api, registerLocalProject, seedSessionJsonl } from './helpers.mjs';
import * as projects from '../src/projects.ts';
import { worktreePathFor } from '../src/worktrees.ts';
import { markConducted, setSessionPlace, setSegmentArchived, setTitle } from '../src/sessionStore.ts';

const id = (n) => `aaaaaaaa-0000-4000-8000-${String(n).padStart(12, '0')}`;
const [C, OTHER, W1, W2, W3, W4, W5] = [1, 2, 3, 4, 5, 6, 7].map(id);
const user = (t) => ({ type: 'user', isSidechain: false, timestamp: '2026-01-01T00:00:00.000Z', message: { role: 'user', content: [{ type: 'text', text: t }] } });
const done = (mid, min) => ({
  type: 'assistant', isSidechain: false, timestamp: new Date(Date.UTC(2026, 0, 1, 0, min)).toISOString(),
  message: { id: mid, role: 'assistant', content: [{ type: 'text', text: 'done' }], stop_reason: 'end_turn' },
});

// INVARIANT: the list is the direct children (recorded `parent`) that still have a transcript,
// newest activity first, each with the place and facts its record and transcript carry; another
// conductor's workers, grandchildren and transcript-less records are not in it.
test('GET /api/sessions/:sid/workers lists the sessions it spawned, live or not, with their place, newest first', async () => {
  const { baseUrl, projectsRoot, close } = await bootServer();
  try {
    const dir = await registerLocalProject('wk', path.join(projectsRoot, 'wk'));
    const proj = await projects.getProject('wk');
    const main = projects.localPlace(dir);
    const wt = projects.localPlace(worktreePathFor(proj, 'wt-a'));

    await markConducted(W1, { parent: C });
    await setSessionPlace(W1, { project: 'wk', worktree: null });
    await setTitle(W1, 'older worker');
    await seedSessionJsonl(main, W1, [user('first job'), done('m1', 1)]);

    await markConducted(W2, { parent: C });
    await setSessionPlace(W2, { project: 'wk', worktree: 'wt-a' });
    await seedSessionJsonl(wt, W2, [user('second job'), done('m2', 9)]);
    await setSegmentArchived(W2, true);

    await markConducted(W3, { parent: OTHER });
    await setSessionPlace(W3, { project: 'wk', worktree: null });
    await seedSessionJsonl(main, W3, [user('not ours'), done('m3', 5)]);

    await markConducted(W4, { parent: C });
    await setSessionPlace(W4, { project: 'wk', worktree: null });

    await markConducted(W5, { parent: W1 });
    await setSessionPlace(W5, { project: 'wk', worktree: null });
    await seedSessionJsonl(main, W5, [user('grandchild'), done('m5', 6)]);

    const res = await api(baseUrl, 'GET', `/api/sessions/${C}/workers`);
    assert.equal(res.status, 200);
    assert.deepEqual(res.body.workers.map(w => w.sessionId), [W2, W1], 'direct children with a transcript, newest first');
    const [r2, r1] = res.body.workers;
    assert.equal(r2.project, 'wk');
    assert.equal(r2.worktreeName, 'wt-a');
    assert.equal(r2.archived, true);
    assert.equal(r2.firstPrompt, 'second job');
    assert.equal(r1.worktreeName, null);
    assert.equal(r1.archived, false);
    assert.equal(r1.title, 'older worker');
    assert.equal(r1.firstPrompt, 'first job');
  } finally { await close(); }
});

// INVARIANT: no children reads as an empty list rather than a 404, and the id guard holds.
test('an unknown but valid session id answers an empty list; an invalid id is refused 400', async () => {
  const { baseUrl, close } = await bootServer();
  try {
    const none = await api(baseUrl, 'GET', `/api/sessions/${id(99)}/workers`);
    assert.equal(none.status, 200);
    assert.deepEqual(none.body, { workers: [] });
    const bad = await api(baseUrl, 'GET', '/api/sessions/bad%20id/workers');
    assert.equal(bad.status, 400);
  } finally { await close(); }
});
