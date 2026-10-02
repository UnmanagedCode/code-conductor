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
