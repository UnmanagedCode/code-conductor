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
  subscribe: vi.fn(),
  ensureSubscribed: vi.fn(),
}));

import { CLOSE_TITLES, closeActionOf, stopNeedsConfirm } from '@shared/closeAction';
import { SERVER_UNREACHABLE_MESSAGE } from '@shared/http';
import { appStore } from '@/state/app';
import * as controller from './controller';
import { on } from './events';
import {
  archiveSession, closeSession, forkActiveSession, performProjectDelete, promoteSession, respawnActive, resumeSession, rewindActiveSession,
} from './sessionActions';

type Call = { url: string; method: string; body: any };
let calls: Call[] = [];
/** A route answers `{status, body}`, `{status, html: true}` (a body that is not JSON), or an Error (fetch rejects, as with no server). */
function stubFetch(route: (c: Call) => { status?: number; body?: any; html?: boolean } | Error) {
  vi.stubGlobal('fetch', vi.fn(async (url: string, init: RequestInit = {}) => {
    const c = { url, method: init.method ?? 'GET', body: init.body ? JSON.parse(String(init.body)) : undefined };
    calls.push(c);
    const answer = route(c);
    if (answer instanceof Error) throw answer;
    const { status = 200, body = {}, html = false } = answer;
    const json = html ? async () => { throw new SyntaxError("Unexpected token '<', \"<html>\"... is not valid JSON"); } : async () => body;
    return { ok: status < 400, status, json };
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

  // A stop with no server names the one unreachable message, not the browser's wording.
  it('a stop with no server names the unreachable message', async () => {
    stubFetch(() => new TypeError('Failed to fetch'));
    await closeSession({ projectName: 'p', instanceId: 'i1', sessionId: 's1', status: 'idle' });
    expect(calls).toEqual([{ url: '/api/instances/i1', method: 'DELETE', body: undefined }]);
    expect(toasts).toEqual([['error', 'Could not stop the session', SERVER_UNREACHABLE_MESSAGE]]);
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

  // The 409 retry's own refusal is the one toasted, after exactly the two POSTs; nothing is refreshed.
  it('a forced archive the server refuses toasts the retry\'s error', async () => {
    stubFetch((c) => (c.url.endsWith('?force=1') ? { status: 500, body: { error: 'archive dir unwritable' } } : { status: 409, body: { error: 'session is running' } }));
    await archiveSession({ projectName: 'p', sessionId: 's1' });
    expect(calls.map((c) => [c.method, c.url])).toEqual([['POST', '/api/projects/p/sessions/s1/archive'], ['POST', '/api/projects/p/sessions/s1/archive?force=1']]);
    expect(toasts).toEqual([['error', 'Could not archive the session', 'archive dir unwritable']]);
    expect(controller.refreshProjects).not.toHaveBeenCalled();
  });

  // A synthetic session's kill answered 404 is an instance already gone, so the archive goes on; any other refusal toasts and refreshes nothing.
  it('a synthetic archive treats a 404 kill as done and toasts any other refusal without refreshing', async () => {
    appStore.set({ instances: [{ id: 'i3', sessionId: 's3', project: 'p', status: 'idle', mode: 'x' }] });
    stubFetch(() => ({ status: 404, body: { error: 'instance not found' } }));
    await archiveSession({ projectName: 'p', sessionId: 's3', synthetic: true });
    expect(calls).toEqual([{ url: '/api/instances/i3', method: 'DELETE', body: undefined }]);
    expect(toasts).toEqual([]);
    expect(controller.refreshProjects).toHaveBeenCalledTimes(1);

    calls = [];
    vi.mocked(controller.refreshProjects).mockClear();
    stubFetch(() => ({ status: 500, body: { error: 'kill timed out' } }));
    await archiveSession({ projectName: 'p', sessionId: 's3', synthetic: true });
    expect(calls).toEqual([{ url: '/api/instances/i3', method: 'DELETE', body: undefined }]);
    expect(toasts).toEqual([['error', 'Could not archive the session', 'kill timed out']]);
    expect(controller.refreshProjects).not.toHaveBeenCalled();
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
    expect(controller.selectInstance).toHaveBeenLastCalledWith('new', { userGesture: true, gesture: expect.any(Number) });
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

  // A refusal whose body is not JSON (a proxy's HTML) names its status, never a parse error.
  it('a user resume refused with an HTML body toasts HTTP 500', async () => {
    stubFetch(() => ({ status: 500, html: true }));
    await resumeSession({ projectName: 'p', sessionId: 's1' });
    expect(toasts).toEqual([['error', 'Resume failed', 'HTTP 500']]);
  });

  // Only a server answer sends a silent resume looking for a live owner; with no server it neither refreshes nor toasts.
  it('a silent resume with no server neither refreshes nor toasts', async () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
    stubFetch(() => new TypeError('Failed to fetch'));
    await resumeSession({ projectName: 'p', sessionId: 's1', silent: true });
    expect(controller.refreshInstances).not.toHaveBeenCalled();
    expect(controller.selectInstance).not.toHaveBeenCalled();
    expect(toasts).toEqual([]);
    expect(warn).toHaveBeenCalledExactlyOnceWith('anchor auto-resume failed', expect.objectContaining({ message: SERVER_UNREACHABLE_MESSAGE }));
    warn.mockRestore();
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
    expect(controller.selectInstance).toHaveBeenCalledWith('forked', { userGesture: true, gesture: expect.any(Number) });
  });

  it('a refused rewind surfaces the server\'s error as a toast (mirrors rewind-fork-client-text "rewindActiveSession surfaces a non-2xx …")', async () => {
    const error = 'the transcript was rewound, but the session failed to relaunch: No conversation found';
    stubFetch(() => ({ status: 500, body: { error, code: 'RELAUNCH_FAILED' } }));
    appStore.set({ activeId: 'A' });
    await rewindActiveSession(7, 'text');
    expect(toasts).toEqual([['error', 'Rewind failed', error]]);
  });

  // A refused fork toasts exactly the server's message and neither refreshes nor selects.
  it('a refused fork toasts the server\'s message for each refusal and refreshes and selects nothing', async () => {
    const notPersisted = 'prompt 2 hasn\'t been written to the session transcript yet — a message sent during a running turn is written when the turn picks it up; retry in a moment';
    const sourceChanged = 'the session\'s transcript rotated or restarted while the fork was waiting — nothing was written; fork again from the current transcript';
    const refusals = [{ error: notPersisted, code: 'PROMPT_NOT_PERSISTED' }, { error: sourceChanged, code: 'FORK_SOURCE_CHANGED' }];
    stubFetch(() => ({ status: 409, body: refusals.shift() }));
    appStore.set({ activeId: 'A' });
    await forkActiveSession(2, 'text');
    await forkActiveSession(2, 'text');
    expect(confirms.map((c) => c.title)).toEqual(['Fork from here?', 'Fork from here?']);
    expect(calls.map((c) => [c.method, c.url])).toEqual([['POST', '/api/instances/A/fork'], ['POST', '/api/instances/A/fork']]);
    expect(toasts).toEqual([['error', 'Fork failed', notPersisted], ['error', 'Fork failed', sourceChanged]]);
    expect(controller.refreshProjects).not.toHaveBeenCalled();
    expect(controller.refreshInstances).not.toHaveBeenCalled();
    expect(controller.selectInstance).not.toHaveBeenCalled();
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
  it('respawnActive POSTs the active instance\'s respawn route, refreshes and subscribes it unless it already is; a refusal toasts Resume failed', async () => {
    stubFetch(() => ({ body: { ok: true } }));
    appStore.set({ activeId: 'A' });
    await respawnActive();
    expect(calls.map((c) => [c.url, c.method])).toEqual([['/api/instances/A/respawn', 'POST']]);
    expect(controller.refreshInstances).toHaveBeenCalledTimes(1);
    expect(vi.mocked(controller.ensureSubscribed).mock.calls).toEqual([['A']]);
    expect(controller.subscribe).not.toHaveBeenCalled();
    expect(toasts).toEqual([]);

    calls = [];
    vi.mocked(controller.refreshInstances).mockClear();
    vi.mocked(controller.send).mockClear();
    vi.mocked(controller.ensureSubscribed).mockClear();
    stubFetch(() => ({ status: 409, body: { error: 'instance is already running' } }));
    await respawnActive();
    expect(calls.map((c) => [c.url, c.method])).toEqual([['/api/instances/A/respawn', 'POST']]);
    expect(toasts).toEqual([['error', 'Resume failed', 'instance is already running']]);
    expect(controller.refreshInstances).not.toHaveBeenCalled();
    expect(controller.send).not.toHaveBeenCalled();
    expect(controller.ensureSubscribed).not.toHaveBeenCalled();

    calls = [];
    toasts.length = 0;
    appStore.set({ activeId: null });
    await respawnActive();
    expect(calls).toEqual([]);
    expect(toasts).toEqual([]);
  });
});

describe('an automatic resume and a session picked while it runs', () => {
  it('an automatic resume selects its session unless another was selected while its POST ran, a 409 owner likewise; a user\'s resume, silent or not, always selects its own', async () => {
    const answers: ((a: { status?: number; body?: unknown }) => void)[] = [];
    vi.stubGlobal('fetch', vi.fn((url: string, init: RequestInit = {}) => new Promise((resolve) => {
      calls.push({ url, method: init.method ?? 'GET', body: init.body ? JSON.parse(String(init.body)) : undefined });
      answers.push(({ status = 200, body = {} }) => resolve({ ok: status < 400, status, json: async () => body }));
    })));
    /** One resume of `s1` whose POST answers `answer`; `pick` is selected while the POST is in flight. Returns the ids it selected. */
    const run = async (opts: { silent?: boolean; userGesture?: boolean }, answer: { status?: number; body?: unknown }, pick: string | null) => {
      vi.mocked(controller.selectInstance).mockClear();
      appStore.set({ activeId: null, instances: [{ id: 'owner', sessionId: 's1', project: 'p', status: 'idle', mode: 'x' }] });
      const done = resumeSession({ projectName: 'p', sessionId: 's1', ...opts });
      if (pick) appStore.set({ activeId: pick });
      answers.shift()!(answer);
      await done;
      return vi.mocked(controller.selectInstance).mock.calls.map(([id]) => id);
    };
    expect(await run({ silent: true }, { body: { id: 'new' } }, null), 'control: an automatic resume selects its session').toEqual(['new']);
    expect(await run({ silent: true }, { body: { id: 'new' } }, 'picked')).toEqual([]);
    expect(await run({ silent: true }, { status: 409, body: { error: 'busy' } }, null), 'control: an automatic 409 selects the owner').toEqual(['owner']);
    expect(await run({ silent: true }, { status: 409, body: { error: 'busy' } }, 'picked')).toEqual([]);
    expect(await run({}, { body: { id: 'new' } }, 'picked'), 'a user resume selects its own').toEqual(['new']);
    expect(await run({ silent: true, userGesture: true }, { body: { id: 'new' } }, 'picked'), 'a silent user resume (a notification click) selects its own').toEqual(['new']);
  });

  it('an automatic resume also yields to a session selected while its instance list refreshes, a 409 owner likewise', async () => {
    /** One automatic resume of `s1` whose POST answers `status`; `pick` is selected while its refreshInstances is held. Returns the ids it selected. */
    const run = async (status: number, pick: string | null) => {
      stubFetch(() => (status === 409 ? { status, body: { error: 'busy' } } : { body: { id: 'new' } }));
      vi.mocked(controller.selectInstance).mockClear();
      appStore.set({ activeId: null, instances: [{ id: 'owner', sessionId: 's1', project: 'p', status: 'idle', mode: 'x' }] });
      let entered!: () => void;
      const inRefresh = new Promise<void>((r) => { entered = r; });
      let release!: () => void;
      const gate = new Promise<void>((r) => { release = r; });
      vi.mocked(controller.refreshInstances).mockImplementationOnce(() => { entered(); return gate; });
      const done = resumeSession({ projectName: 'p', sessionId: 's1', silent: true });
      await inRefresh;
      if (pick) appStore.set({ activeId: pick });
      release();
      await done;
      return vi.mocked(controller.selectInstance).mock.calls.map(([id]) => id);
    };
    expect(await run(200, null), 'control: an automatic resume selects its session').toEqual(['new']);
    expect(await run(200, 'picked')).toEqual([]);
    expect(await run(409, null), 'control: an automatic 409 selects the owner').toEqual(['owner']);
    expect(await run(409, 'picked')).toEqual([]);
  });
});
