// Worktree sync / merge / lock and the rebase-prompt consent flow
// (app/sessionActions.ts). A blocked sync may start a turn in the session on
// that worktree, so it is only ever done with the user's consent, asked of the
// session on THE TARGET worktree, and never of a dead one.
import { beforeEach, describe, expect, it, vi } from 'vitest';

const confirmAnswer = { value: true };
const confirms: string[] = [];
const toasts: string[] = [];
vi.mock('@/ui/feedback', () => ({
  confirmDialog: vi.fn(async (opts: any) => { confirms.push(`${opts.title}\n${opts.description ?? ''}`); return confirmAnswer.value; }),
  toast: Object.fromEntries(['error', 'success', 'info', 'warning'].map((k) => [k, (t: string, d?: string) => toasts.push(`${t}\n${d ?? ''}`)])),
}));
const refreshProjectsError: { value: Error | null } = { value: null };
vi.mock('./controller', () => ({
  refreshProjects: vi.fn(async () => { if (refreshProjectsError.value) throw refreshProjectsError.value; }),
  refreshInstances: vi.fn(async () => {}),
  selectInstance: vi.fn(),
  send: vi.fn(),
}));

import { appStore } from '@/state/app';
import type { Instance } from '@/state/types';
import * as controller from './controller';
import { mergeWorktree, setWorktreeLock, syncWorktree } from './sessionActions';

type Call = { url: string; method?: string; body?: any };
let calls: Call[] = [];
let bodies: { sync?: any; merge?: any; lock?: any; rebasePrompt?: any } = {};

beforeEach(() => {
  calls = [];
  bodies = {};
  confirms.length = 0;
  toasts.length = 0;
  confirmAnswer.value = true;
  refreshProjectsError.value = null;
  vi.mocked(controller.refreshProjects).mockClear();
  vi.stubGlobal('fetch', vi.fn(async (url: string, init: RequestInit = {}) => {
    calls.push({ url, method: init.method, ...(init.body !== undefined ? { body: JSON.parse(String(init.body)) } : {}) });
    const body = url.endsWith('/rebase-prompt') ? bodies.rebasePrompt
      : url.endsWith('/sync') ? bodies.sync
      : url.endsWith('/merge') ? bodies.merge
      : url.endsWith('/lock') ? bodies.lock : undefined;
    return { ok: true, status: 200, json: async () => body };
  }));
  appStore.set({ activeId: null, instances: [] });
});

const ID = 'inst-1';
const TARGET = { project: 'demo', worktree: 'wt-a' };
const BLOCKED = { ok: true, action: 'rebase-conflict', ahead: 1, behind: 1, branch: 'code-conductor/wt-a', baseBranch: 'main', baseSha: 'abcdef012345', rebasePrompt: 'x' };
const SENT = { ok: true, action: 'rebase-prompt-sent', blocker: 'conflict' };
const inst = (id: string, worktree: string | null, extra: Partial<Instance> = {}): Instance => ({
  id, project: 'demo', sessionId: `sid-${id}-abcdef`, status: 'idle', mode: 'plan', title: `title ${id}`,
  worktree: worktree ? ({ worktreeName: worktree } as any) : null, ...extra,
});
const setState = (activeId: string | null, instances: Instance[]) => appStore.set({ activeId, instances });
const posts = (suffix: string) => calls.filter((c) => c.url.endsWith(suffix));
const toastText = () => toasts.join('\n');

describe('rebase-prompt consent (untargeted header sync)', () => {
  const LIVE = inst(ID, 'wt-a', { sessionId: 'sid-abcdef12', title: 'auth worker' });
  const blocked = { ...BLOCKED, branch: 'code-conductor/auth' };

  it('declining the confirm sends no rebase prompt', async () => {
    setState(ID, [LIVE]);
    bodies = { sync: blocked, rebasePrompt: SENT };
    confirmAnswer.value = false;
    await syncWorktree();
    expect(confirms).toHaveLength(1);
    expect(posts('/rebase-prompt')).toHaveLength(0);
  });

  it('the confirm names the session that would be asked, and what blocks the sync', async () => {
    setState(ID, [LIVE]);
    bodies = { sync: blocked };
    confirmAnswer.value = false;
    await syncWorktree();
    expect(confirms[0]).toMatch(/auth worker/);
    expect(confirms[0]).toMatch(/conflicts with main/);
    expect(confirms[0]).toMatch(/starts a turn/);
  });

  it('accepting POSTs /rebase-prompt exactly once and says so', async () => {
    setState(ID, [LIVE]);
    bodies = { sync: blocked, rebasePrompt: SENT };
    await syncWorktree();
    const sent = posts('/rebase-prompt');
    expect(sent).toHaveLength(1);
    expect(sent[0]).toMatchObject({ url: `/api/instances/${ID}/rebase-prompt`, method: 'POST' });
    expect(toastText()).toMatch(/Rebase prompt sent/);
  });

  it('a dead session is told, not asked: no confirm and no POST, and the branch is named', async () => {
    for (const status of ['exited', 'crashed']) {
      calls = []; confirms.length = 0; toasts.length = 0;
      setState(ID, [{ ...LIVE, status }]);
      bodies = { sync: blocked, rebasePrompt: SENT };
      await syncWorktree();
      expect(confirms).toHaveLength(0);
      expect(posts('/rebase-prompt')).toHaveLength(0);
      expect(toastText()).toMatch(/No agent is running here/);
      expect(toastText()).toMatch(/code-conductor\/auth/);
    }
  });

  it('an instance missing from the list is treated as dead', async () => {
    setState(ID, []);
    bodies = { sync: blocked, rebasePrompt: SENT };
    await syncWorktree();
    expect(confirms).toHaveLength(0);
    expect(posts('/rebase-prompt')).toHaveLength(0);
    expect(toastText()).toMatch(/No agent is running here/);
  });

  it('commit-required takes the same consent path, worded for its own blocker', async () => {
    setState(ID, [LIVE]);
    bodies = { sync: { ...blocked, action: 'commit-required' } };
    confirmAnswer.value = false;
    await syncWorktree();
    expect(confirms).toHaveLength(1);
    expect(confirms[0]).toMatch(/uncommitted changes and is 1 commit\(s\) behind main/);
  });

  it('a landed sync never reaches the consent path', async () => {
    for (const action of ['already-in-sync', 'fast-forwarded', 'rebased']) {
      setState(ID, [LIVE]);
      bodies = { sync: { ok: true, action, newSha: 'abcdef012345' } };
      await syncWorktree();
    }
    expect(confirms).toHaveLength(0);
    expect(posts('/rebase-prompt')).toHaveLength(0);
  });

  it("a refused dispatch surfaces the server's reason instead of claiming success", async () => {
    setState(ID, [LIVE]);
    bodies = { sync: blocked, rebasePrompt: { ok: false, code: 'SESSION_NOT_LIVE', reason: 'instance is not running' } };
    await syncWorktree();
    expect(posts('/rebase-prompt')).toHaveLength(1);
    expect(toastText()).toMatch(/Cannot ask the agent to rebase/);
    expect(toastText()).toMatch(/instance is not running/);
    expect(toastText()).not.toMatch(/Rebase prompt sent/);
  });
});

describe('targeted worktree sync', () => {
  it("POSTs the worktree route, never the active instance's, and returns the result", async () => {
    setState('other', [inst('other', 'wt-b')]);
    bodies = { sync: { ok: true, action: 'fast-forwarded', newSha: 'abcdef0123456789' } };
    const result = await syncWorktree(TARGET);
    expect(calls).toEqual([{ url: '/api/projects/demo/worktrees/wt-a/sync', method: 'POST' }]);
    expect(result.action).toBe('fast-forwarded');
    expect(controller.refreshProjects).toHaveBeenCalledTimes(1);
  });

  it('encodes the project and worktree names', async () => {
    bodies = { sync: { ok: true, action: 'already-in-sync' } };
    await syncWorktree({ project: 'my proj', worktree: 'a/b' });
    expect(calls[0].url).toBe('/api/projects/my%20proj/worktrees/a%2Fb/sync');
  });

  it('an untargeted sync POSTs the active instance route; with no active session it sends nothing', async () => {
    setState('act', [inst('act', 'wt-a')]);
    bodies = { sync: { ok: true, action: 'already-in-sync' } };
    await syncWorktree();
    expect(calls).toEqual([{ url: '/api/instances/act/sync', method: 'POST' }]);
    calls = [];
    setState(null, []);
    expect(await syncWorktree()).toBeNull();
    expect(calls).toEqual([]);
  });

  it('a blocked sync asks the live session on THAT worktree, not the active one', async () => {
    setState('A', [inst('A', 'wt-b'), inst('B', 'wt-a')]);
    bodies = { sync: BLOCKED, rebasePrompt: SENT };
    await syncWorktree(TARGET);
    expect(confirms).toHaveLength(1);
    expect(confirms[0]).toMatch(/title B/);
    expect(confirms[0]).not.toMatch(/title A/);
    expect(posts('/rebase-prompt').map((c) => c.url)).toEqual(['/api/instances/B/rebase-prompt']);
  });

  it('prefers the active session on the worktree, then a live one, over a dead one', async () => {
    const dead = inst('dead', 'wt-a', { status: 'exited' });
    const live = inst('live', 'wt-a');
    const active = inst('active', 'wt-a');
    for (const [activeId, list, want] of [['active', [dead, live, active], 'active'], [null, [dead, live], 'live']] as const) {
      calls = [];
      setState(activeId, [...list]);
      bodies = { sync: BLOCKED, rebasePrompt: SENT };
      await syncWorktree(TARGET);
      expect(posts('/rebase-prompt')[0]?.url).toBe(`/api/instances/${want}/rebase-prompt`);
    }
  });

  it('a crashed or exited active session does not shadow a live one; only dead ones are told', async () => {
    for (const status of ['crashed', 'exited']) {
      calls = []; confirms.length = 0; toasts.length = 0;
      setState('dead', [inst('dead', 'wt-a', { status }), inst('live', 'wt-a')]);
      bodies = { sync: BLOCKED, rebasePrompt: SENT };
      await syncWorktree(TARGET);
      expect(confirms[0]).toMatch(/title live/);
      expect(posts('/rebase-prompt')[0]?.url).toBe('/api/instances/live/rebase-prompt');
    }
    calls = []; confirms.length = 0; toasts.length = 0;
    setState('dead', [inst('dead', 'wt-a', { status: 'crashed' })]);
    await syncWorktree(TARGET);
    expect(confirms).toHaveLength(0);
    expect(toastText()).toMatch(/No agent is running here/);
  });

  it('with no session on the worktree it tells instead of asking', async () => {
    setState('A', [inst('A', 'wt-b'), inst('P', null), { ...inst('Q', 'wt-a'), project: 'elsewhere' }]);
    bodies = { sync: BLOCKED, rebasePrompt: SENT };
    await syncWorktree(TARGET);
    expect(confirms).toHaveLength(0);
    expect(posts('/rebase-prompt')).toHaveLength(0);
    expect(toastText()).toMatch(/No agent is running here/);
  });

  it('a refused sync reports the reason, returns the refusal and does not refresh', async () => {
    bodies = { sync: { ok: false, reason: 'parent is dirty' } };
    const result = await syncWorktree(TARGET);
    expect(toastText()).toMatch(/Cannot sync\nparent is dirty/);
    expect(result.ok).toBe(false);
    expect(controller.refreshProjects).not.toHaveBeenCalled();
  });

  it('a refresh failure keeps the result and still offers the rebase prompt', async () => {
    refreshProjectsError.value = new Error('boom');
    bodies = { sync: { ok: true, action: 'fast-forwarded', newSha: '0123456789abcdef' } };
    expect(await syncWorktree(TARGET)).toEqual(bodies.sync);
    expect(toastText()).not.toMatch(/failed/i);
    setState(null, [inst('B', 'wt-a')]);
    bodies = { sync: BLOCKED, rebasePrompt: SENT };
    await syncWorktree(TARGET);
    expect(confirms).toHaveLength(1);
    expect(posts('/rebase-prompt')).toHaveLength(1);
  });
});

describe('merge and lock', () => {
  it('merge confirms, POSTs, reports the new sha, refreshes and returns the result', async () => {
    bodies = { merge: { ok: true, newSha: '0123456789abcdef0123' } };
    const result = await mergeWorktree(TARGET);
    expect(confirms).toHaveLength(1);
    expect(calls).toEqual([{ url: '/api/projects/demo/worktrees/wt-a/merge', method: 'POST' }]);
    expect(toastText()).toMatch(/0123456789ab/);
    expect(controller.refreshProjects).toHaveBeenCalledTimes(1);
    expect(result).toEqual(bodies.merge);
  });

  it('declining the merge sends nothing and returns null', async () => {
    confirmAnswer.value = false;
    expect(await mergeWorktree(TARGET)).toBeNull();
    expect(calls).toEqual([]);
  });

  it("a refused merge reports the server's reason without refreshing", async () => {
    bodies = { merge: { ok: false, reason: 'worktree is behind main — click Sync first' } };
    const result = await mergeWorktree(TARGET);
    expect(toastText()).toMatch(/Cannot merge\nworktree is behind main — click Sync first/);
    expect(result.ok).toBe(false);
    expect(controller.refreshProjects).not.toHaveBeenCalled();
  });

  it('a refresh failure after a merge keeps the result', async () => {
    refreshProjectsError.value = new Error('boom');
    bodies = { merge: { ok: true, newSha: '0123456789abcdef' } };
    expect(await mergeWorktree(TARGET)).toEqual(bodies.merge);
    expect(toastText()).not.toMatch(/failed/i);
  });

  it('merge and lock encode names', async () => {
    bodies = { merge: { ok: true, newSha: 'abcdef0123456789' }, lock: { ok: true, locked: true } };
    await mergeWorktree({ project: 'my proj#1', worktree: 'a/b c' });
    await setWorktreeLock({ project: 'my proj#1', worktree: 'a/b c' }, true);
    expect(calls.map((c) => c.url)).toEqual([
      '/api/projects/my%20proj%231/worktrees/a%2Fb%20c/merge',
      '/api/projects/my%20proj%231/worktrees/a%2Fb%20c/lock',
    ]);
  });

  it('lock PUTs {locked}, refreshes and returns the result, asking nothing', async () => {
    for (const locked of [true, false]) {
      calls = [];
      bodies = { lock: { ok: true, worktree: 'wt-a', locked } };
      expect(await setWorktreeLock(TARGET, locked)).toEqual(bodies.lock);
      expect(calls).toEqual([{ url: '/api/projects/demo/worktrees/wt-a/lock', method: 'PUT', body: { locked } }]);
    }
    expect(confirms).toEqual([]);
    expect(toasts).toEqual([]);
  });

  it('a refused lock reports the reason and returns the refusal', async () => {
    bodies = { lock: { ok: false, reason: 'nope' } };
    const result = await setWorktreeLock(TARGET, true);
    expect(toastText()).toMatch(/Cannot change the lock\nnope/);
    expect(result.ok).toBe(false);
    expect(controller.refreshProjects).not.toHaveBeenCalled();
  });
});
