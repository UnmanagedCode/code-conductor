import { beforeEach, describe, expect, it, vi } from 'vitest';

const confirmAnswer = { value: true };
const confirms: any[] = [];
const toasts: any[] = [];
vi.mock('@/ui/feedback', () => ({
  confirmDialog: vi.fn(async (opts: any) => { confirms.push(opts); return confirmAnswer.value; }),
  toast: {
    error: (...a: any[]) => toasts.push(['error', ...a]),
    success: (...a: any[]) => toasts.push(['success', ...a]),
    info: (...a: any[]) => toasts.push(['info', ...a]),
    warning: (...a: any[]) => toasts.push(['warning', ...a]),
  },
}));
vi.mock('./controller', () => ({
  refreshProjects: vi.fn(async () => {}),
  refreshInstances: vi.fn(async () => {}),
  selectInstance: vi.fn(),
  send: vi.fn(),
}));

import { CLOSE_TITLES, closeActionOf, stopNeedsConfirm } from '@/lib/core/closeAction.js';
import { appStore } from '@/state/app';
import * as controller from './controller';
import { on } from './events';
import {
  archiveSession, closeSession, forkActiveSession, performProjectDelete, promoteSession, respawnActive, resumeSession, rewindActiveSession,
} from './sessionActions';

type Call = { url: string; method: string; body: any };
let calls: Call[] = [];
function stubFetch(route: (c: Call) => { status?: number; body?: any }) {
  vi.stubGlobal('fetch', vi.fn(async (url: string, init: RequestInit = {}) => {
    const c = { url, method: init.method ?? 'GET', body: init.body ? JSON.parse(String(init.body)) : undefined };
    calls.push(c);
    const { status = 200, body = {} } = route(c);
    return { ok: status < 400, status, json: async () => body };
  }));
}

beforeEach(() => {
  calls = [];
  confirms.length = 0;
  toasts.length = 0;
  confirmAnswer.value = true;
  vi.mocked(controller.refreshProjects).mockClear();
  vi.mocked(controller.refreshInstances).mockClear();
  vi.mocked(controller.selectInstance).mockClear();
  vi.mocked(controller.send).mockClear();
  appStore.set({ activeId: null, instances: [] });
});

describe('closing a session', () => {
  it('one step down: stop only a live persistent session; idle stops silently', () => {
    expect(closeActionOf({ instanceId: 'i', status: 'idle', temp: false })).toBe('stop');
    expect(closeActionOf({ instanceId: 'i', status: 'idle', temp: true })).toBe('archive');
    expect(closeActionOf({ instanceId: null, status: null, temp: false })).toBe('archive');
    expect(CLOSE_TITLES).toEqual({ stop: 'Stop session', archive: 'Archive session (keeps history)' });
    expect(stopNeedsConfirm('idle')).toBe(false);
    expect(stopNeedsConfirm('turn')).toBe(true);
  });

  it('a live persistent idle session: one DELETE, no confirm, refreshes and drops the scope cache; deselects only that one', async () => {
    stubFetch(() => ({ body: { ok: true } }));
    appStore.set({ activeId: 'i1' });
    const stale: unknown[] = [];
    const off = on('sessionsStale', (p) => stale.push(p));
    await closeSession({ projectName: 'p', instanceId: 'i1', sessionId: 's1', status: 'idle' });
    expect(calls).toEqual([{ url: '/api/instances/i1', method: 'DELETE', body: undefined }]);
    expect(confirms).toHaveLength(0);
    expect(appStore.get().activeId).toBeNull();
    expect(stale).toEqual([{ project: 'p', worktree: null }]);
    expect(controller.refreshProjects).toHaveBeenCalled();
    expect(controller.refreshInstances).toHaveBeenCalled();

    appStore.set({ activeId: 'other' });
    await closeSession({ projectName: 'p', instanceId: 'i2', sessionId: 's2', status: 'idle' });
    expect(appStore.get().activeId).toBe('other');
    off();
  });

  it('a busy session asks once; declining sends nothing', async () => {
    stubFetch(() => ({}));
    confirmAnswer.value = false;
    await closeSession({ projectName: 'p', instanceId: 'i1', sessionId: 's1', status: 'turn', preview: 'Fix the bug' });
    expect(confirms).toHaveLength(1);
    expect(confirms[0].title).toMatch(/Stop session “Fix the bug”/);
    expect(calls).toHaveLength(0);
  });

  it('a session with no instance is archived once the confirm is accepted: exactly the archive POST', async () => {
    stubFetch(() => ({ body: { ok: true } }));
    await closeSession({ projectName: 'p', instanceId: null, sessionId: 's9' });
    expect(confirms).toHaveLength(1);
    expect(confirms[0].title).toMatch(/^Archive session/);
    expect(calls).toEqual([{ url: '/api/projects/p/sessions/s9/archive', method: 'POST', body: undefined }]);
  });

  it('a busy stop asks once, naming the session and that its transcript is kept, then DELETEs — for every busy status', async () => {
    stubFetch(() => ({ body: { ok: true } }));
    for (const status of ['turn', 'running', 'spawning']) {
      calls = [];
      confirms.length = 0;
      await closeSession({ projectName: 'p', instanceId: 'i1', sessionId: 's1', status, preview: 'Alpha' });
      expect(confirms, status).toHaveLength(1);
      expect(confirms[0].title, status).toMatch(/^Stop session “Alpha”\?/);
      expect(confirms[0].description, status).toMatch(/transcript is kept/);
      expect(calls, status).toEqual([{ url: '/api/instances/i1', method: 'DELETE', body: undefined }]);
    }
  });

  it('declining a busy stop sends nothing and leaves the selection, the lists and the session caches alone — for every busy status', async () => {
    stubFetch(() => ({ body: { ok: true } }));
    confirmAnswer.value = false;
    appStore.set({ activeId: 'i1' });
    const stale: unknown[] = [];
    const off = on('sessionsStale', (p) => stale.push(p));
    for (const status of ['turn', 'running', 'spawning']) {
      confirms.length = 0;
      await closeSession({ projectName: 'p', instanceId: 'i1', sessionId: 's1', status, preview: 'Alpha' });
      expect(confirms, status).toHaveLength(1);
      expect(calls, status).toEqual([]);
      expect(appStore.get().activeId, status).toBe('i1');
      expect(controller.refreshProjects, status).not.toHaveBeenCalled();
      expect(controller.refreshInstances, status).not.toHaveBeenCalled();
      expect(stale, status).toEqual([]);
    }
    off();
  });

  it('an exited or crashed instance is archived, never stopped', async () => {
    stubFetch(() => ({ body: { ok: true } }));
    for (const status of ['exited', 'crashed']) {
      calls = [];
      await closeSession({ projectName: 'p', instanceId: 'i1', sessionId: 's1', status, preview: 'Alpha' });
      expect(confirms.at(-1).title, status).toMatch(/^Archive session/);
      expect(calls, status).toEqual([{ url: '/api/projects/p/sessions/s1/archive', method: 'POST', body: undefined }]);
    }
  });

  it('a failed stop reports the error and refreshes nothing', async () => {
    stubFetch(() => ({ status: 500, body: { error: 'boom' } }));
    await closeSession({ projectName: 'p', instanceId: 'i1', sessionId: 's1', status: 'idle' });
    expect(toasts[0]).toEqual(['error', 'Could not stop the session', 'boom']);
    expect(controller.refreshInstances).not.toHaveBeenCalled();
  });

  it('a temp or not-live session is archived after confirming; declining sends nothing', async () => {
    stubFetch(() => ({ body: { ok: true } }));
    await closeSession({ projectName: 'p', instanceId: 'i1', sessionId: 's1', status: 'idle', temp: true });
    expect(confirms[0].title).toMatch(/^Archive session/);
    expect(calls).toEqual([{ url: '/api/projects/p/sessions/s1/archive', method: 'POST', body: undefined }]);
    calls = [];
    confirmAnswer.value = false;
    await closeSession({ projectName: 'p', worktreeName: 'wt', sessionId: 's2' });
    expect(calls).toHaveLength(0);
  });

  it('archiving the open conductor retries with force on 409 and drops the selection', async () => {
    stubFetch((c) => ({ status: c.url.endsWith('?force=1') ? 200 : 409, body: { ok: true } }));
    appStore.set({ activeId: 'c1', instances: [{ id: 'c1', sessionId: 'cs', project: '.conduct', status: 'idle', mode: 'x' }] });
    await archiveSession({ projectName: '.conduct', sessionId: 'cs' });
    expect(calls.map((c) => c.url)).toEqual(['/api/projects/.conduct/sessions/cs/archive', '/api/projects/.conduct/sessions/cs/archive?force=1']);
    expect(appStore.get().activeId).toBeNull();
  });

  it('a conductor that is not open leaves the selection alone; a synthetic one is killed by instance id', async () => {
    stubFetch(() => ({ body: { ok: true } }));
    appStore.set({ activeId: 'other', instances: [{ id: 'c1', sessionId: 'cs', project: '.conduct', status: 'idle', mode: 'x' }] });
    await archiveSession({ projectName: '.conduct', sessionId: 'cs' });
    expect(appStore.get().activeId).toBe('other');
    calls = [];
    await archiveSession({ projectName: '.conduct', sessionId: 'cs', synthetic: true });
    expect(calls).toEqual([{ url: '/api/instances/c1', method: 'DELETE', body: undefined }]);
  });
});

describe('promote, resume, rewind, fork, delete', () => {
  it('promoting asks first (conductor wording for .conduct), POSTs promote and refreshes instances only', async () => {
    stubFetch(() => ({ body: { ok: true } }));
    await promoteSession({ projectName: '.conduct', instanceId: 'c1', preview: 'Plan it' });
    expect(confirms[0].title).toBe('Make this conductor persistent?');
    expect(calls).toEqual([{ url: '/api/instances/c1/promote', method: 'POST', body: undefined }]);
    expect(controller.refreshInstances).toHaveBeenCalledTimes(1);
    expect(controller.refreshProjects).not.toHaveBeenCalled();
    calls = [];
    await promoteSession({ projectName: 'p', instanceId: 'w1' });
    expect(confirms[1].title).toBe('Keep this session in p?');
    confirmAnswer.value = false;
    calls = [];
    await promoteSession({ projectName: 'p', instanceId: 'w1' });
    expect(calls).toHaveLength(0);
  });

  it('declining the conductor promote sends nothing and refreshes nothing', async () => {
    stubFetch(() => ({ body: { ok: true } }));
    confirmAnswer.value = false;
    await promoteSession({ projectName: '.conduct', instanceId: 'c1', preview: 'Alpha' });
    expect(confirms).toHaveLength(1);
    expect(confirms[0].title).toBe('Make this conductor persistent?');
    expect(calls).toEqual([]);
    expect(controller.refreshInstances).not.toHaveBeenCalled();
    expect(controller.refreshProjects).not.toHaveBeenCalled();
  });

  it('a failed promote reports the error and refreshes nothing', async () => {
    stubFetch(() => ({ status: 500, body: { error: 'boom' } }));
    await promoteSession({ projectName: '.conduct', instanceId: 'c1', preview: 'Alpha' });
    expect(calls).toEqual([{ url: '/api/instances/c1/promote', method: 'POST', body: undefined }]);
    expect(toasts).toEqual([['error', 'Could not make the session persistent', 'boom']]);
    expect(controller.refreshInstances).not.toHaveBeenCalled();
    expect(controller.refreshProjects).not.toHaveBeenCalled();
  });

  it('a user resume selects with a gesture; a silent one without; a silent 409 selects the owner', async () => {
    stubFetch(() => ({ body: { id: 'new' } }));
    await resumeSession({ projectName: 'p', worktreeName: 'wt', sessionId: 's1' });
    expect(calls[0]).toEqual({ url: '/api/instances', method: 'POST', body: { project: 'p', resume: 's1', worktree: 'wt' } });
    expect(controller.selectInstance).toHaveBeenLastCalledWith('new', { userGesture: true });
    await resumeSession({ projectName: 'p', sessionId: 's1', silent: true });
    expect(controller.selectInstance).toHaveBeenLastCalledWith('new', { userGesture: false });
    stubFetch(() => ({ status: 409, body: { error: 'busy' } }));
    appStore.set({ instances: [{ id: 'owner', sessionId: 's1', project: 'p', status: 'idle', mode: 'x' }] });
    await resumeSession({ projectName: 'p', sessionId: 's1', silent: true });
    expect(controller.selectInstance).toHaveBeenLastCalledWith('owner', { userGesture: false });
    expect(toasts).toHaveLength(0);
    await resumeSession({ projectName: 'p', sessionId: 's1' });
    expect(toasts[0]).toEqual(['error', 'Resume failed', 'busy']);
  });

  it('rewind and fork POST the bubble\'s index and its exact text; a fork selects the new instance with a gesture', async () => {
    const text = '  exact\ntext with <transcribed>\n spaces  ';
    stubFetch((c) => ({ body: c.url.endsWith('/fork') ? { instance: { id: 'forked' } } : { ok: true } }));
    appStore.set({ activeId: 'A' });
    await rewindActiveSession(3, text);
    await forkActiveSession(3, text);
    expect(calls.map((c) => [c.url, c.body])).toEqual([
      ['/api/instances/A/rewind', { userMessageIndex: 3, text }],
      ['/api/instances/A/fork', { userMessageIndex: 3, text }],
    ]);
    expect(controller.selectInstance).toHaveBeenCalledWith('forked', { userGesture: true });
  });

  it('a refused rewind surfaces the server\'s error as a toast (mirrors rewind-fork-client-text "rewindActiveSession surfaces a non-2xx …")', async () => {
    const error = 'the transcript was rewound, but the session failed to relaunch: No conversation found';
    stubFetch(() => ({ status: 500, body: { error, code: 'RELAUNCH_FAILED' } }));
    appStore.set({ activeId: 'A' });
    await rewindActiveSession(7, 'text');
    expect(toasts).toEqual([['error', 'Rewind failed', error]]);
  });

  it('deleting a project sends deleteDirectory as chosen and drops a selection inside it', async () => {
    stubFetch(() => ({ body: { ok: true } }));
    appStore.set({ activeId: 'i1', instances: [{ id: 'i1', project: 'gone', sessionId: 's', status: 'idle', mode: 'x' }] });
    await performProjectDelete({ name: 'gone', deleteDirectory: false });
    expect(calls[0]).toEqual({ url: '/api/projects/gone', method: 'DELETE', body: { deleteDirectory: false } });
    expect(appStore.get().activeId).toBeNull();
    await performProjectDelete({ name: 'other', deleteDirectory: true });
    expect(calls[1].body).toEqual({ deleteDirectory: true });
  });
});

describe('resuming the active session', () => {
  it('respawnActive POSTs the active instance\'s respawn route, refreshes and resubscribes; a refusal toasts Resume failed', async () => {
    stubFetch(() => ({ body: { ok: true } }));
    appStore.set({ activeId: 'A' });
    await respawnActive();
    expect(calls.map((c) => [c.url, c.method])).toEqual([['/api/instances/A/respawn', 'POST']]);
    expect(controller.refreshInstances).toHaveBeenCalledTimes(1);
    expect(vi.mocked(controller.send).mock.calls).toEqual([['subscribe', { id: 'A' }]]);
    expect(toasts).toEqual([]);

    calls = [];
    vi.mocked(controller.refreshInstances).mockClear();
    vi.mocked(controller.send).mockClear();
    stubFetch(() => ({ status: 409, body: { error: 'instance is already running' } }));
    await respawnActive();
    expect(calls.map((c) => [c.url, c.method])).toEqual([['/api/instances/A/respawn', 'POST']]);
    expect(toasts).toEqual([['error', 'Resume failed', 'instance is already running']]);
    expect(controller.refreshInstances).not.toHaveBeenCalled();
    expect(controller.send).not.toHaveBeenCalled();

    calls = [];
    toasts.length = 0;
    appStore.set({ activeId: null });
    await respawnActive();
    expect(calls).toEqual([]);
    expect(toasts).toEqual([]);
  });
});
