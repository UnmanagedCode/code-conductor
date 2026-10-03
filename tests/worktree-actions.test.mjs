// The commits view's Sync / Merge go through the same `sessionActions` helpers
// as the session header's Sync, with a `{project, worktree}` target in place of
// "the active instance". These drive the real `installSessionActions` against a
// scripted fetch (tests/sessionActionsHarness.mjs).
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { ID, setupSessionActions } from './sessionActionsHarness.mjs';

const TARGET = { project: 'demo', worktree: 'wt-a' };
const BLOCKED = {
  ok: true, action: 'rebase-conflict', ahead: 1, behind: 1,
  branch: 'code-conductor/wt-a', baseBranch: 'main', baseSha: 'abcdef012345',
  rebasePrompt: 'x',
};
const SENT = { ok: true, action: 'rebase-prompt-sent', blocker: 'conflict' };
const inst = (id, worktree, extra = {}) => ({
  id, project: 'demo', sessionId: `sid-${id}-abcdef`, status: 'idle', title: `title ${id}`,
  worktree: worktree ? { worktreeName: worktree } : null, ...extra,
});
const posts = (calls, suffix) => calls.filter(c => c.url.endsWith(suffix));

test('a targeted sync POSTs the worktree route, never the active instance\'s', async () => {
  const t = await setupSessionActions({
    activeId: 'other', instances: [inst('other', 'wt-b')],
    bodies: { sync: { ok: true, action: 'fast-forwarded', newSha: 'abcdef0123456789' } },
  });
  const result = await t.syncWorktree(TARGET);
  assert.deepEqual(t.calls, [{ url: '/api/projects/demo/worktrees/wt-a/sync', method: 'POST' }]);
  assert.equal(result.action, 'fast-forwarded', 'the server result is returned for the view');
  assert.equal(t.refreshes.projects, 1);
});

test('a targeted sync encodes the project and worktree names in the URL', async () => {
  const t = await setupSessionActions({ bodies: { sync: { ok: true, action: 'already-in-sync' } } });
  await t.syncWorktree({ project: 'my proj', worktree: 'a/b' });
  assert.equal(t.calls[0].url, '/api/projects/my%20proj/worktrees/a%2Fb/sync');
});

test('an untargeted (header) sync still POSTs /api/instances/<active>/sync', async () => {
  const t = await setupSessionActions({
    activeId: 'act', instances: [inst('act', 'wt-a')],
    bodies: { sync: { ok: true, action: 'already-in-sync' } },
  });
  await t.syncWorktree();
  assert.deepEqual(t.calls, [{ url: '/api/instances/act/sync', method: 'POST' }]);
});

test('an untargeted sync with no active session sends nothing and returns null', async () => {
  const t = await setupSessionActions({ activeId: null });
  assert.equal(await t.syncWorktree(), null);
  assert.deepEqual(t.calls, []);
});

test('a targeted blocked sync asks the live session on THAT worktree, not the active one', async () => {
  const t = await setupSessionActions({
    activeId: 'A', instances: [inst('A', 'wt-b'), inst('B', 'wt-a')],
    bodies: { sync: BLOCKED, rebasePrompt: SENT },
  });
  await t.syncWorktree(TARGET);
  assert.equal(t.confirms.length, 1);
  assert.match(t.confirms[0], /title B/, 'the confirm names the session on the target worktree');
  assert.doesNotMatch(t.confirms[0], /title A/);
  const sent = posts(t.calls, '/rebase-prompt');
  assert.equal(sent.length, 1);
  assert.equal(sent[0].url, '/api/instances/B/rebase-prompt');
});

test('a targeted blocked sync prefers the active session, then a live one, over a dead one', async (t) => {
  const dead = inst('dead', 'wt-a', { status: 'exited' });
  const live = inst('live', 'wt-a');
  const active = inst('active', 'wt-a');
  for (const [name, activeId, instances, want] of [
    ['the active session on the worktree', 'active', [dead, live, active], 'active'],
    ['a live session when the active one is elsewhere', null, [dead, live], 'live'],
  ]) {
    await t.test(name, async () => {
      const w = await setupSessionActions({ activeId, instances, bodies: { sync: BLOCKED, rebasePrompt: SENT } });
      await w.syncWorktree(TARGET);
      assert.equal(posts(w.calls, '/rebase-prompt')[0]?.url, `/api/instances/${want}/rebase-prompt`);
    });
  }
});

test('a targeted blocked sync with no session on the worktree is told, not asked', async () => {
  const t = await setupSessionActions({
    activeId: 'A', instances: [inst('A', 'wt-b'), inst('P', null), { ...inst('Q', 'wt-a'), project: 'elsewhere' }],
    bodies: { sync: BLOCKED, rebasePrompt: SENT },
  });
  await t.syncWorktree(TARGET);
  assert.equal(t.confirms.length, 0);
  assert.equal(posts(t.calls, '/rebase-prompt').length, 0);
  assert.match(t.alerts.join('\n'), /No agent is running here/);
});

test('a refused targeted sync alerts the reason and returns the refusal', async () => {
  const t = await setupSessionActions({ bodies: { sync: { ok: false, reason: 'parent is dirty' } } });
  const result = await t.syncWorktree(TARGET);
  assert.match(t.alerts.join('\n'), /Cannot sync:\nparent is dirty/);
  assert.equal(result.ok, false);
  assert.equal(t.refreshes.projects, 0);
});

test('mergeWorktree confirms, POSTs the worktree merge route, alerts the new sha, refreshes projects and returns the result', async () => {
  const body = { ok: true, newSha: '0123456789abcdef0123' };
  const t = await setupSessionActions({ activeId: 'other', bodies: { merge: body } });
  const result = await t.mergeWorktree(TARGET);
  assert.equal(t.confirms.length, 1);
  assert.deepEqual(t.calls, [{ url: '/api/projects/demo/worktrees/wt-a/merge', method: 'POST' }]);
  assert.match(t.alerts.join('\n'), /Merged into parent → 0123456789ab/);
  assert.equal(t.refreshes.projects, 1);
  assert.deepEqual(result, body);
});

test('declining the merge confirm sends nothing and returns null', async () => {
  const t = await setupSessionActions({ confirmAnswer: false, bodies: { merge: { ok: true, newSha: 'x' } } });
  assert.equal(await t.mergeWorktree(TARGET), null);
  assert.deepEqual(t.calls, []);
  assert.equal(t.refreshes.projects, 0);
});

test('a refused merge alerts the server\'s reason', async () => {
  const t = await setupSessionActions({ bodies: { merge: { ok: false, reason: 'worktree is behind main — click Sync first' } } });
  const result = await t.mergeWorktree(TARGET);
  assert.match(t.alerts.join('\n'), /Cannot merge:\nworktree is behind main — click Sync first/);
  assert.equal(result.ok, false, 'the view keys its refresh on ok');
  assert.equal(t.refreshes.projects, 0);
});

// PINS: a sidebar-refresh failure never turns a confirmed server result into a
// failure — the merge/sync already happened, so no "failed" alert, and the
// helper still returns the result (the commits view reloads its list off it).
test('a refreshProjects() rejection after a merge or sync leaves the result intact: no failure alert, result returned', async (t) => {
  const boom = new Error('projects fetch blew up');
  for (const [kind, body, call] of [
    ['merge', { ok: true, newSha: '0123456789abcdef' }, (w) => w.mergeWorktree(TARGET)],
    ['sync', { ok: true, action: 'fast-forwarded', newSha: '0123456789abcdef' }, (w) => w.syncWorktree(TARGET)],
  ]) {
    await t.test(kind, async () => {
      const w = await setupSessionActions({ bodies: { [kind]: body }, refreshProjectsError: boom });
      const result = await call(w);
      assert.deepEqual(result, body, 'the server result is returned');
      assert.equal(w.refreshes.projects, 1, 'the refresh was attempted');
      assert.doesNotMatch(w.alerts.join('\n'), /failed/);
    });
  }
});

// PINS: a blocked sync's rebase prompt is still offered when the sidebar
// refresh fails — the refresh sits before the offer, so it must not abort it.
test('a refreshProjects() rejection does not swallow the rebase-prompt offer', async () => {
  const w = await setupSessionActions({
    activeId: null, instances: [inst('B', 'wt-a')],
    bodies: { sync: BLOCKED, rebasePrompt: SENT }, refreshProjectsError: new Error('boom'),
  });
  await w.syncWorktree(TARGET);
  assert.equal(w.confirms.length, 1);
  assert.equal(posts(w.calls, '/rebase-prompt').length, 1);
});

// PINS: the target's names are URL-encoded in the MERGE route as in the sync one.
test('mergeWorktree encodes the project and worktree names in the URL', async () => {
  const w = await setupSessionActions({ bodies: { merge: { ok: true, newSha: 'abcdef0123456789' } } });
  await w.mergeWorktree({ project: 'my proj#1', worktree: 'a/b c' });
  assert.equal(w.calls[0].url, '/api/projects/my%20proj%231/worktrees/a%2Fb%20c/merge');
});

// PINS: the rebase prompt goes to a LIVE session on the worktree even when the
// active one there is dead; "No agent is running here" only when none is live.
test('a crashed or exited active session on the worktree does not shadow a live one', async (t) => {
  for (const status of ['crashed', 'exited']) {
    await t.test(`${status} active + live other`, async () => {
      const w = await setupSessionActions({
        activeId: 'dead', instances: [inst('dead', 'wt-a', { status }), inst('live', 'wt-a')],
        bodies: { sync: BLOCKED, rebasePrompt: SENT },
      });
      await w.syncWorktree(TARGET);
      assert.equal(w.confirms.length, 1);
      assert.match(w.confirms[0], /title live/);
      assert.equal(posts(w.calls, '/rebase-prompt')[0]?.url, '/api/instances/live/rebase-prompt');
      assert.doesNotMatch(w.alerts.join('\n'), /No agent is running here/);
    });
  }
  await t.test('only dead sessions: still told, not asked', async () => {
    const w = await setupSessionActions({
      activeId: 'dead', instances: [inst('dead', 'wt-a', { status: 'crashed' })],
      bodies: { sync: BLOCKED, rebasePrompt: SENT },
    });
    await w.syncWorktree(TARGET);
    assert.equal(w.confirms.length, 0);
    assert.match(w.alerts.join('\n'), /No agent is running here/);
  });
});

// ── setWorktreeLock (the commits view's Lock toggle) ─────────────────────────

// PINS: the wire call — a PUT of {locked} to the worktree's lock route, names
// encoded — then a projects refresh (the sidebar's 🔒), returning the server's
// result for the view to apply. No confirm in either direction.
test('setWorktreeLock PUTs {locked} to the lock route, refreshes projects and returns the result', async (t) => {
  for (const locked of [true, false]) {
    await t.test(`locked: ${locked}`, async () => {
      const body = { ok: true, worktree: 'wt-a', locked };
      const w = await setupSessionActions({ bodies: { lock: body } });
      const result = await w.setWorktreeLock(TARGET, locked);
      assert.deepEqual(w.calls, [{ url: '/api/projects/demo/worktrees/wt-a/lock', method: 'PUT', body: { locked } }]);
      assert.equal(w.refreshes.projects, 1);
      assert.deepEqual(result, body);
      assert.deepEqual(w.confirms, []);
      assert.deepEqual(w.alerts, []);
    });
  }
  await t.test('names are encoded', async () => {
    const w = await setupSessionActions({ bodies: { lock: { ok: true, locked: true } } });
    await w.setWorktreeLock({ project: 'my proj#1', worktree: 'a/b c' }, true);
    assert.equal(w.calls[0].url, '/api/projects/my%20proj%231/worktrees/a%2Fb%20c/lock');
  });
});

// PINS: a refusal is alerted with its reason, returned, and refreshes nothing.
test('a refused setWorktreeLock alerts the reason and returns the refusal', async () => {
  const w = await setupSessionActions({ bodies: { lock: { ok: false, reason: 'nope' } } });
  const result = await w.setWorktreeLock(TARGET, true);
  assert.match(w.alerts.join('\n'), /Cannot change the lock:\nnope/);
  assert.equal(result.ok, false);
  assert.equal(w.refreshes.projects, 0);
});
