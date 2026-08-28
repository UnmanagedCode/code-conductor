// Consent before dispatch: the GUI half of "sync measures, dispatching is a
// separate act" (card 2026-0186).
//
// Server-side tests cannot see any of this. `POST /sync` returning
// `commit-required` / `rebase-conflict` is green whether the client silently
// fires `/rebase-prompt`, asks first, or does nothing — and "the user was asked
// before a turn started in their session" is the entire user-facing point of
// the change. These drive `installSessionActions`'s real `syncWorktree` against
// a scripted fetch, so the confirm→POST edge is the thing under test.
//
// sessionActions.js has no import-time browser deps (see anchor-autoresume),
// so it loads here directly; only `fetch`/`alert`/`confirm` are stubbed.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const PUB = path.resolve(__dirname, '..', 'public');
const load = (name) => import(pathToFileURL(path.join(PUB, name)).href + `?t=${Math.random()}`);

const ID = 'inst-1';

const BLOCKED = {
  ok: true, action: 'rebase-conflict', ahead: 1, behind: 1,
  branch: 'code-conductor/auth', baseBranch: 'main', baseSha: 'abcdef012345',
  rebasePrompt: 'You are running in an isolated git worktree.\n…',
};

// A world where /sync answers `syncBody` and /rebase-prompt answers `sendBody`,
// recording every request so "no POST" is an assertion rather than an absence
// of visible effect.
async function setup({ instance, syncBody = BLOCKED, sendBody = { ok: true, action: 'rebase-prompt-sent', blocker: 'conflict' }, confirmAnswer = true } = {}) {
  const { installSessionActions } = await load('sessionActions.js');
  const calls = [];
  const alerts = [];
  const confirms = [];
  globalThis.alert = (m) => alerts.push(String(m));
  globalThis.confirm = (m) => { confirms.push(String(m)); return confirmAnswer; };
  globalThis.fetch = async (url, opts) => {
    calls.push({ url: String(url), method: opts?.method });
    const body = String(url).endsWith('/rebase-prompt') ? sendBody : syncBody;
    return { ok: true, status: 200, json: async () => body };
  };
  const handles = installSessionActions({
    getActiveId: () => ID, setActiveId: () => {}, getInstances: () => (instance ? [instance] : []),
    refreshProjects: async () => {}, refreshInstances: async () => {},
    selectInstance: () => {}, sidebar: {}, clearUnread: () => {}, headerUpdate: () => {},
  });
  return { ...handles, calls, alerts, confirms };
}

const sent = (calls) => calls.filter(c => c.url.endsWith('/rebase-prompt'));
const LIVE = { id: ID, sessionId: 'sid-abcdef12', status: 'idle', title: 'auth worker' };

test('declining the confirm sends NO rebase prompt', async () => {
  const t = await setup({ instance: LIVE, confirmAnswer: false });
  await t.syncWorktree();
  assert.equal(t.confirms.length, 1, 'the user was asked');
  assert.equal(sent(t.calls).length, 0, 'declining must not start a turn in the session');
});

test('the confirm names the session that would be asked, and what blocks the sync', async () => {
  const t = await setup({ instance: LIVE, confirmAnswer: false });
  await t.syncWorktree();
  // Consent is only meaningful if the user can tell WHOSE session is about to
  // take a turn; a generic "send the rebase prompt?" is not the same decision.
  assert.match(t.confirms[0], /auth worker/);
  assert.match(t.confirms[0], /conflicts with main/);
  assert.match(t.confirms[0], /starts a turn/);
});

test('accepting the confirm POSTs /rebase-prompt exactly once', async () => {
  const t = await setup({ instance: LIVE, confirmAnswer: true });
  await t.syncWorktree();
  const posts = sent(t.calls);
  assert.equal(posts.length, 1);
  assert.equal(posts[0].url, `/api/instances/${ID}/rebase-prompt`);
  assert.equal(posts[0].method, 'POST');
  assert.match(t.alerts.join('\n'), /Rebase prompt sent/);
});

test('a dead session is told, not asked — no confirm and no POST', async () => {
  for (const status of ['exited', 'crashed']) {
    const t = await setup({ instance: { ...LIVE, status }, confirmAnswer: true });
    await t.syncWorktree();
    assert.equal(t.confirms.length, 0, `${status}: nobody to consent for`);
    assert.equal(sent(t.calls).length, 0, `${status}: nothing to dispatch to`);
    assert.match(t.alerts.join('\n'), /No agent is running here/);
    assert.match(t.alerts.join('\n'), /code-conductor\/auth/, 'names the branch to rebase by hand');
  }
});

test('an instance missing from the list is treated as dead, not silently skipped', async () => {
  const t = await setup({ instance: null, confirmAnswer: true });
  await t.syncWorktree();
  assert.equal(t.confirms.length, 0);
  assert.equal(sent(t.calls).length, 0);
  assert.match(t.alerts.join('\n'), /No agent is running here/);
});

test('commit-required takes the same consent path, worded for its own blocker', async () => {
  const t = await setup({
    instance: LIVE, confirmAnswer: false,
    syncBody: { ...BLOCKED, action: 'commit-required' },
  });
  await t.syncWorktree();
  assert.equal(t.confirms.length, 1);
  assert.match(t.confirms[0], /uncommitted changes and is 1 commit\(s\) behind main/);
  assert.equal(sent(t.calls).length, 0);
});

test('a landed sync never reaches the consent path', async () => {
  for (const action of ['already-in-sync', 'fast-forwarded', 'rebased']) {
    const t = await setup({ instance: LIVE, syncBody: { ok: true, action, newSha: 'abcdef012345' } });
    await t.syncWorktree();
    assert.equal(t.confirms.length, 0, `${action}: nothing to consent to`);
    assert.equal(sent(t.calls).length, 0, `${action}: nothing to dispatch`);
  }
});

test("a refused dispatch surfaces the server's reason instead of claiming success", async () => {
  const t = await setup({
    instance: LIVE, confirmAnswer: true,
    sendBody: { ok: false, code: 'SESSION_NOT_LIVE', reason: 'instance is not running' },
  });
  await t.syncWorktree();
  assert.equal(sent(t.calls).length, 1);
  const text = t.alerts.join('\n');
  assert.match(text, /Cannot ask the agent to rebase/);
  assert.match(text, /instance is not running/);
  assert.doesNotMatch(text, /Rebase prompt sent/);
});
