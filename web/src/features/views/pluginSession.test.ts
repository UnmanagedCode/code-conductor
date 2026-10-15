// @vitest-environment-options {"settings":{"disableIframePageLoading":true}}
// The host side of the bridge's session awareness: the `session` broadcast and the
// `openSession` / `sendPrompt` calls, over frames the way plugins.test.ts mounts them
// (happy-dom loads no frame document, so each frame gets a stand-in window).
import '@/test/browserHash';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

vi.mock('@shared/ws', () => ({ bus: new EventTarget(), connect: vi.fn(), send: vi.fn() }));

import { send } from '@shared/ws';
import { selectInstance } from '@/app/controller';
import { startPristineWatch } from '@/app/pristine';
import { draftStore } from '@/features/composer/drafts';
import { appStore } from '@/state/app';
import { routeStore, syncRoute } from '@/state/route';
import type { Instance } from '@/state/types';
import { pluginFrames } from './plugins';
import { startPluginSessionBridge } from './pluginSession';
import { postFrom, standInWindow, type StandIn } from './test/pluginHost';

const sendMock = vi.mocked(send);
const json = (body: unknown, status = 200) => new Response(JSON.stringify(body), { status });

const inst = (id: string, over: Partial<Instance> = {}): Instance => ({ id, project: 'p', status: 'idle', sessionId: `s-${id}`, mode: 'default', worktree: null, ...over });
const WT = { worktreeName: 'feat', branch: 'b', baseBranch: 'main', baseSha: 'abc', postWorktreeCreate: null };

/** What GET /api/sessions/:sid/locate answers, by session id: a hit, or absent for a 404. */
let located: Record<string, { project: string; worktreeName: string | null; archived: boolean }> = {};
let fetchCalls: string[] = [];

function stubNetwork(opts: { locateFails?: boolean } = {}) {
  vi.stubGlobal('fetch', vi.fn(async (url: string, o: RequestInit = {}) => {
    fetchCalls.push(`${o.method ?? 'GET'} ${url}`);
    const status = /^\/api\/plugins\/([^/]+)\/status$/.exec(url);
    if (status) return json({ name: status[1], state: 'ready', enabled: true, frontendKeepAlive: status[1] === 'keep' });
    const loc = /^\/api\/sessions\/([^/]+)\/locate$/.exec(url);
    if (loc) {
      if (opts.locateFails) throw new TypeError('Failed to fetch');
      const hit = located[decodeURIComponent(loc[1])];
      return hit ? json(hit) : json({ error: 'no such session' }, 404);
    }
    return json({});
  }));
}

let shared: StandIn;
let resident: StandIn;
let stranger: StandIn;
let stop: () => void;
let abortPristine: AbortController;

const sessionMsgs = (w: StandIn) => w.posted.filter((m: any) => m?.type === 'session') as { session: unknown }[];
const results = (w: StandIn) => w.posted.filter((m: any) => m?.type === 'result') as any[];
const settle = () => new Promise<void>((r) => setTimeout(r, 0));
/** Posts one call and returns the one result the frame got back for its id. */
async function ask(from: StandIn, type: 'openSession' | 'sendPrompt', fields: Record<string, unknown>) {
  const id = `c${Math.random()}`;
  postFrom(from, { cc: 1, type, id, ...fields });
  await vi.waitFor(() => expect(results(from).some((r) => r.id === id)).toBe(true));
  const mine = results(from).filter((r) => r.id === id);
  expect(mine, 'exactly one reply per call').toHaveLength(1);
  return mine[0];
}

beforeEach(async () => {
  located = {};
  fetchCalls = [];
  sendMock.mockReset();
  stubNetwork();
  history.replaceState(null, '', '/#session=s-a');
  syncRoute();
  appStore.set({ instances: [inst('a'), inst('b')], pristine: null, activeId: 'a' });
  const host = document.createElement('div');
  document.body.appendChild(host);
  pluginFrames.attach(host);
  await pluginFrames.load({ id: 'keep', subpath: '/' });
  await pluginFrames.load({ id: 'hub', subpath: '/' });
  shared = standInWindow(host.querySelector('iframe[data-plugin-frame="shared"]') as HTMLIFrameElement);
  resident = standInWindow(host.querySelector('iframe[data-plugin-frame="resident"]') as HTMLIFrameElement);
  const recorder: StandIn & { postMessage(m: unknown, o?: unknown): void } = { posted: [], origins: [], postMessage(m, o) { recorder.posted.push(m); recorder.origins.push(o); } };
  stranger = recorder;
  stop = startPluginSessionBridge();
});

afterEach(() => {
  stop();
  abortPristine?.abort();
  pluginFrames.leave();
  for (const id of pluginFrames.residentIds()) (pluginFrames as any).evict(pluginFrames.resident.get(id));
  document.body.innerHTML = '';
  appStore.set({ instances: [], pristine: null, activeId: null });
  vi.unstubAllGlobals();
});

describe('the session broadcast', () => {
  it('answers a frame\'s ready with the active session, to that frame alone', () => {
    // Invariant: a frame that announces itself learns the active session as {sessionId, project, worktree}, and no other frame is told.
    postFrom(shared, { cc: 1, type: 'ready' });
    expect(sessionMsgs(shared)).toEqual([{ cc: 1, type: 'session', session: { sessionId: 's-a', project: 'p', worktree: null } }]);
    expect(sessionMsgs(resident)).toEqual([]);
  });

  it('reports a worktree session by its worktree name', () => {
    // Invariant: `worktree` is the instance's worktreeName, the key GET /api/projects/:name/worktrees uses.
    appStore.set({ instances: [inst('a', { worktree: WT })] });
    postFrom(resident, { cc: 1, type: 'ready' });
    expect(sessionMsgs(resident)[0].session).toEqual({ sessionId: 's-a', project: 'p', worktree: 'feat' });
  });

  it('tells every frame, a hidden resident one included, when the active session changes', () => {
    // Invariant: a selection change reaches the shared frame and the hidden keep-alive frame alike.
    expect(pluginFrames.resident.get('keep')!.frame.hidden, 'precondition: the resident frame is hidden').toBe(true);
    selectInstance('b');
    for (const w of [shared, resident]) {
      expect(sessionMsgs(w)).toEqual([{ cc: 1, type: 'session', session: { sessionId: 's-b', project: 'p', worktree: null } }]);
    }
  });

  it('posts nothing when the active triple is unchanged, and null when nothing usable is selected', () => {
    // Invariant: only a change of (sessionId, project, worktree) is broadcast; a list refresh or status change is not, and no selection / no session id reads null.
    appStore.set({ instances: [inst('a', { status: 'turn' }), inst('b')] });
    appStore.set({ instances: [inst('a', { status: 'idle', title: 'renamed' }), inst('b')] });
    expect(sessionMsgs(shared)).toEqual([]);
    appStore.set({ instances: [inst('a', { sessionId: null, status: 'spawning' }), inst('b')] });
    expect(sessionMsgs(shared).map((m) => m.session)).toEqual([null]);
    selectInstance(null);
    expect(sessionMsgs(shared).map((m) => m.session), 'still null: not re-sent').toEqual([null]);
    selectInstance('b');
    expect(sessionMsgs(shared).map((m) => m.session)).toEqual([null, { sessionId: 's-b', project: 'p', worktree: null }]);
  });

  it('names the pristine conductor when it is the active session', () => {
    // Invariant: the active session is activeInstance (instances plus the pristine slot), so a pristine conductor is reported as itself.
    appStore.set({ pristine: inst('pr', { pristine: true, sessionId: 's-pr' }), activeId: 'pr' });
    expect(sessionMsgs(shared).map((m) => m.session), 'broadcast on selection').toEqual([{ sessionId: 's-pr', project: 'p', worktree: null }]);
    postFrom(resident, { cc: 1, type: 'ready' });
    expect(sessionMsgs(resident)[0].session).toEqual({ sessionId: 's-pr', project: 'p', worktree: null });
  });

  it('posts session and result with the host origin as the target', async () => {
    // Invariant: nothing the host sends a frame is addressed to "*" or another origin — broadcast, ready replies and results all target location.origin.
    postFrom(shared, { cc: 1, type: 'ready' });
    selectInstance('b');
    await ask(shared, 'openSession', { sessionId: 's-a' });
    expect(shared.posted.length, 'precondition: a ready reply, a broadcast and a result').toBeGreaterThanOrEqual(3);
    expect(resident.origins.length, 'precondition: the resident frame was broadcast to').toBeGreaterThan(0);
    for (const w of [shared, resident]) expect(w.origins.every((o) => o === location.origin)).toBe(true);
  });

  it('answers nothing to a message from a window that is no frame', () => {
    // Invariant: ready from an unattributed source gets no session and no reply.
    postFrom(stranger, { cc: 1, type: 'ready' });
    expect(stranger.posted).toEqual([]);
  });
});

describe('openSession', () => {
  it('selects a live non-active session as a sidebar pick does and replies ok', async () => {
    // Invariant: a live session becomes the selection and the anchor, and the caller is told ok.
    const r = await ask(shared, 'openSession', { sessionId: 's-b' });
    expect(r).toMatchObject({ cc: 1, type: 'result', ok: true });
    expect(appStore.get().activeId).toBe('b');
    expect(location.hash).toBe('#session=s-b');
  });

  it('leaves a full-screen plugin view for the session', async () => {
    // Invariant: from #plugin/… the route view becomes the session, as a sidebar pick does.
    history.replaceState(null, '', '/#plugin/hub/');
    syncRoute();
    expect(routeStore.get().route.view, 'precondition').toBe('plugin');
    await ask(shared, 'openSession', { sessionId: 's-b' });
    expect(routeStore.get().route.view).toBe('session');
  });

  it('accepts the call from a hidden resident frame', async () => {
    // Invariant: any known frame may call, not only the shown one.
    const r = await ask(resident, 'openSession', { sessionId: 's-b' });
    expect(r.ok).toBe(true);
    expect(appStore.get().activeId).toBe('b');
  });

  it.each([
    ['an exited-only instance', 's-b', () => appStore.set({ instances: [inst('a'), inst('b', { status: 'exited' })] }), 'SESSION_NOT_LIVE'],
    ['a located archived session', 's-gone', () => { located['s-gone'] = { project: 'p', worktreeName: null, archived: true }; }, 'SESSION_NOT_LIVE'],
    ['a located unarchived session no instance carries', 's-gone', () => { located['s-gone'] = { project: 'p', worktreeName: null, archived: false }; }, 'SESSION_NOT_LIVE'],
    ['a session locate refuses', 's-gone', () => {}, 'SESSION_UNKNOWN'],
  ])('refuses %s and changes nothing', async (_name, sid, arrange, code) => {
    // Invariant: a session that is not live is refused with its code, with no selection change and no resume.
    arrange();
    const r = await ask(shared, 'openSession', { sessionId: sid });
    expect(r).toMatchObject({ ok: false, code });
    expect(appStore.get().activeId).toBe('a');
    expect(location.hash).toBe('#session=s-a');
    expect(fetchCalls.filter((c) => c.startsWith('POST'))).toEqual([]);
  });

  it('prefers a live instance over a dead one sharing the session id', async () => {
    // Invariant: after a respawn the live instance wins over the dead one carrying the same session id.
    appStore.set({ instances: [inst('a'), inst('dead', { status: 'crashed', sessionId: 's-b' }), inst('b')] });
    const r = await ask(shared, 'openSession', { sessionId: 's-b' });
    expect(r.ok).toBe(true);
    expect(appStore.get().activeId).toBe('b');
  });

  it('reports a failed lookup read as LOOKUP_FAILED', async () => {
    // Invariant: a network failure of the locate read is not mistaken for an unknown session.
    stubNetwork({ locateFails: true });
    const r = await ask(shared, 'openSession', { sessionId: 's-gone' });
    expect(r).toMatchObject({ ok: false, code: 'LOOKUP_FAILED' });
  });

  it('rejects a missing or empty sessionId as INVALID_ARGUMENT', async () => {
    // Invariant: a call without a usable session id is refused, not looked up.
    expect(await ask(shared, 'openSession', {})).toMatchObject({ ok: false, code: 'INVALID_ARGUMENT' });
    expect(await ask(shared, 'openSession', { sessionId: '' })).toMatchObject({ ok: false, code: 'INVALID_ARGUMENT' });
    expect(fetchCalls.filter((c) => c.includes('/locate'))).toEqual([]);
  });
});

describe('sendPrompt', () => {
  const promptCalls = () => sendMock.mock.calls.filter((c) => c[0] === 'prompt');

  it('sends the composer\'s frame to a non-active session without switching or touching its draft', async () => {
    // Invariant: the ws frame is exactly the composer's (trimmed text, acked), and the selection, the hash and the human's draft are left alone.
    sendMock.mockResolvedValue({ t: 'ack', ok: true } as never);
    draftStore.save('s-b', { text: 'half typed', transcribed: false });
    const r = await ask(shared, 'sendPrompt', { sessionId: 's-b', text: '  hi  ' });
    expect(r).toMatchObject({ cc: 1, type: 'result', ok: true });
    expect(promptCalls()).toEqual([['prompt', { id: 'b', text: 'hi' }, { ack: true }]]);
    expect(appStore.get().activeId).toBe('a');
    expect(location.hash).toBe('#session=s-a');
    expect(draftStore.load('s-b')).toEqual({ text: 'half typed', transcribed: false });
    draftStore.clear('s-b');
  });

  it('sends to a busy session (the server steers it)', async () => {
    // Invariant: a status-turn session is deliverable, as the composer lets a human send mid-turn.
    sendMock.mockResolvedValue({ t: 'ack', ok: true } as never);
    appStore.set({ instances: [inst('a'), inst('b', { status: 'turn' })] });
    expect((await ask(shared, 'sendPrompt', { sessionId: 's-b', text: 'x' })).ok).toBe(true);
    expect(promptCalls()).toHaveLength(1);
  });

  it.each([
    ['spawning', { status: 'spawning' }],
    ['mid model switch', { modelSwitch: { from: 'a', to: 'b' } }],
    ['overage stopped unarmed', { overageStoppedUnarmed: true }],
  ])('refuses a session that is %s as SESSION_NOT_READY and sends nothing', async (_name, over) => {
    // Invariant: the bridge honours the composer's Send-disabled gate.
    appStore.set({ instances: [inst('a'), inst('b', over)] });
    expect(await ask(shared, 'sendPrompt', { sessionId: 's-b', text: 'x' })).toMatchObject({ ok: false, code: 'SESSION_NOT_READY' });
    expect(sendMock).not.toHaveBeenCalled();
  });

  it('refuses a dead session as SESSION_NOT_LIVE and an unknown one as SESSION_UNKNOWN', async () => {
    // Invariant: the same liveness vocabulary as openSession, and nothing is sent either way.
    appStore.set({ instances: [inst('a'), inst('b', { status: 'exited' })] });
    expect(await ask(shared, 'sendPrompt', { sessionId: 's-b', text: 'x' })).toMatchObject({ ok: false, code: 'SESSION_NOT_LIVE' });
    expect(await ask(shared, 'sendPrompt', { sessionId: 's-zz', text: 'x' })).toMatchObject({ ok: false, code: 'SESSION_UNKNOWN' });
    expect(sendMock).not.toHaveBeenCalled();
  });

  it('reports a rejected ack as SEND_FAILED', async () => {
    // Invariant: a server refusal, closed socket or ack timeout surfaces to the plugin instead of reading as delivered.
    sendMock.mockRejectedValue(new Error('timeout'));
    expect(await ask(shared, 'sendPrompt', { sessionId: 's-b', text: 'x' })).toMatchObject({ ok: false, code: 'SEND_FAILED' });
  });

  it('rejects a bad sessionId or empty text as INVALID_ARGUMENT', async () => {
    // Invariant: the composer refuses an empty send, so the bridge does too, before any lookup or send.
    for (const fields of [{ text: 'x' }, { sessionId: 's-b' }, { sessionId: 's-b', text: '   ' }, { sessionId: 's-b', text: 5 }]) {
      expect(await ask(shared, 'sendPrompt', fields)).toMatchObject({ ok: false, code: 'INVALID_ARGUMENT' });
    }
    expect(sendMock).not.toHaveBeenCalled();
  });

  it('reaches a pristine-slot session and marks it sent, so a later selection change sends no pristine_leave', async () => {
    // Invariant: sendPrompt goes through notePristineSent, so a pristine conductor a plugin prompted is not reaped when the human moves away.
    sendMock.mockResolvedValue({ t: 'ack', ok: true } as never);
    const pr = inst('pr', { pristine: true, sessionId: 's-pr' });
    appStore.set({ pristine: pr, activeId: 'pr' });
    abortPristine = new AbortController();
    startPristineWatch(abortPristine.signal);
    expect(sendMock.mock.calls.some((c) => c[0] === 'pristine_view'), 'precondition: the pristine conductor is shown').toBe(true);
    const r = await ask(shared, 'sendPrompt', { sessionId: 's-pr', text: 'go' });
    expect(r.ok).toBe(true);
    expect(promptCalls()).toEqual([['prompt', { id: 'pr', text: 'go' }, { ack: true }]]);
    selectInstance('b');
    expect(sendMock.mock.calls.some((c) => c[0] === 'pristine_leave')).toBe(false);
  });
});

describe('exactly one result per call', () => {
  it('answers HOST_ERROR once when the host throws mid-call', async () => {
    // Invariant: an unexpected host-side failure still yields exactly one {ok:false, code:'HOST_ERROR'} (ask() asserts one reply per id).
    sendMock.mockImplementation(() => { throw new Error('socket layer blew up'); });
    expect(await ask(shared, 'openSession', { sessionId: 's-b' })).toMatchObject({ ok: false, code: 'HOST_ERROR' });
    await settle();
    expect(results(shared)).toHaveLength(1);
  });

  it('answers LOOKUP_FAILED when the locate read never settles', async () => {
    // Invariant: the lookup is bounded (10 s, as the send ack is), so a stalled read cannot leave a frame unanswered.
    vi.useFakeTimers();
    try {
      vi.stubGlobal('fetch', vi.fn(() => new Promise<Response>(() => {})));
      postFrom(shared, { cc: 1, type: 'openSession', id: 'slow', sessionId: 's-gone' });
      await vi.advanceTimersByTimeAsync(9_000);
      expect(results(shared), 'not before the bound').toEqual([]);
      await vi.advanceTimersByTimeAsync(2_000);
      expect(results(shared)).toEqual([{ cc: 1, type: 'result', id: 'slow', ok: false, code: 'LOOKUP_FAILED' }]);
    } finally { vi.useRealTimers(); }
  });
});

describe('who may call', () => {
  it('ignores a foreign-origin call, an unattributed-source call and a sourceless call entirely', async () => {
    // Invariant: only a same-origin message from a known frame can act; anything else gets no reply, no send and no selection change.
    const data = { cc: 1, type: 'sendPrompt', id: 'x1', sessionId: 's-b', text: 'hi' };
    const open = { cc: 1, type: 'openSession', id: 'x2', sessionId: 's-b' };
    for (const d of [data, open]) {
      window.dispatchEvent(new MessageEvent('message', { data: d, origin: 'http://evil', source: shared as unknown as Window }));
      window.dispatchEvent(new MessageEvent('message', { data: d, origin: location.origin, source: stranger as unknown as Window }));
      window.dispatchEvent(new MessageEvent('message', { data: d, origin: location.origin }));
    }
    await settle();
    expect(results(shared)).toEqual([]);
    expect(results(resident)).toEqual([]);
    expect(stranger.posted).toEqual([]);
    expect(sendMock).not.toHaveBeenCalled();
    expect(appStore.get().activeId).toBe('a');
  });

  it('ignores a call without a string id', async () => {
    // Invariant: with nowhere to reply, a call with no id does nothing.
    postFrom(shared, { cc: 1, type: 'openSession', sessionId: 's-b' });
    postFrom(shared, { cc: 1, type: 'openSession', id: 7, sessionId: 's-b' });
    await settle();
    expect(results(shared)).toEqual([]);
    expect(appStore.get().activeId).toBe('a');
  });

  it('replies to the calling frame only', async () => {
    // Invariant: a result goes to the frame that asked, not to the others.
    await ask(resident, 'openSession', { sessionId: 's-b' });
    expect(results(shared)).toEqual([]);
  });
});
