import { beforeEach, describe, expect, it, vi } from 'vitest';
import { appStore } from '@/state/app';
import { ndjsonStream } from '@/features/settings/test/ndjson';
import { toast } from '@/ui/feedback';
import { bus } from '@shared/ws';
import { performRestart, performShutdown, powerStore, STOPPED_STATUS, waitForReplacement } from './restart';

vi.mock('@/ui/feedback', () => ({ toast: { error: vi.fn() } }));

const health = (bootId: string | null) => new Response(JSON.stringify({ ok: true, bootId }), { status: 200 });

beforeEach(() => {
  powerStore.set({ inProgress: false, stopped: false });
  appStore.set({ sidebarStatus: null });
  vi.mocked(toast.error).mockClear();
});

describe('waitForReplacement', () => {
  it('waits until a server with a different bootId answers', async () => {
    const ids = ['old', 'old', 'new'];
    const fetchImpl = vi.fn(async () => health(ids.shift() ?? 'new')) as unknown as typeof fetch;
    const ok = await waitForReplacement('old', { tries: 10, delayMs: 0, fetchImpl, sleep: async () => {} });
    expect(ok).toBe(true);
    expect(fetchImpl).toHaveBeenCalledTimes(3);
  });
  it('gives up after its tries while the server stays down', async () => {
    const fetchImpl = vi.fn(async () => { throw new Error('down'); }) as unknown as typeof fetch;
    expect(await waitForReplacement('old', { tries: 3, delayMs: 0, fetchImpl, sleep: async () => {} })).toBe(false);
  });
});

describe('performRestart', () => {
  it('posts autoContinue only when asked, reports progress in the sidebar status, reloads, and ignores a second click meanwhile', async () => {
    // Invariant: performRestart({autoContinue:true}) posts exactly {autoContinue:true}; a second call while one runs posts nothing.
        const calls: { url: string; body?: string }[] = [];
    let boot = 'a';
    const fetchImpl = vi.fn(async (url: string, init?: RequestInit) => {
      calls.push({ url, body: init?.body as string | undefined });
      if (url === '/api/admin/restart') { boot = 'b'; return new Response('{}', { status: 202 }); }
      return health(boot);
    }) as unknown as typeof fetch;
    const reload = vi.fn();
    const p = performRestart({ autoContinue: true }, { fetchImpl, reload });
    expect(appStore.get().sidebarStatus?.text).toBe('Preparing the restart…');
    expect(await performRestart({}, { fetchImpl, reload })).toEqual({ ok: false, error: 'a restart is already in progress' });
    expect(await p).toEqual({ ok: true });
    const post = calls.find((c) => c.url === '/api/admin/restart');
    expect(JSON.parse(post!.body!)).toEqual({ autoContinue: true });
    expect(calls.filter((c) => c.url === '/api/admin/restart')).toHaveLength(1);
    expect(reload).toHaveBeenCalledTimes(1);
    expect(appStore.get().sidebarStatus?.text).toBe('Reloading…');
  });

  it('the power menu\'s restart posts no autoContinue', async () => {
    // Invariant: performRestart() with no options posts a body without autoContinue, so the next boot gates its notices.
    let body: string | undefined;
    const fetchImpl = vi.fn(async (url: string, init?: RequestInit) => {
      if (url === '/api/admin/restart') { body = init?.body as string; return new Response('{}', { status: 202 }); }
      return health(url === '/api/health' && body ? 'new' : 'old');
    }) as unknown as typeof fetch;
    expect(await performRestart(undefined, { fetchImpl, reload: vi.fn() })).toEqual({ ok: true });
    expect(JSON.parse(body!)).toEqual({});
  });

  it('a restart keeps waiting through the long drain budget before it reloads', async () => {
    // Invariant: every restart polls /api/health exactly 480 times, 250 ms apart, before it gives up and reloads.
    vi.useFakeTimers({ toFake: ['setTimeout'] });
    try {
            let healthCalls = 0;
      const fetchImpl = vi.fn(async (url: string) => {
        if (url === '/api/admin/restart') return new Response('{}', { status: 202 });
        healthCalls++;
        return health('same');
      }) as unknown as typeof fetch;
      const reload = vi.fn();
      const p = performRestart({}, { fetchImpl, reload });
      await vi.advanceTimersByTimeAsync(479 * 250);
      expect(reload).not.toHaveBeenCalled();
      await vi.advanceTimersByTimeAsync(1_000);
      await p;
      expect(reload).toHaveBeenCalledTimes(1);
      expect(healthCalls).toBe(481);
    } finally {
      vi.useRealTimers();
    }
  });
});

describe('performRestart against the streamed restart', () => {
  // A fetch whose restart POST answers `restart` and whose health check reports
  // `boot`, flipped to 'new' once the restart's stream has ended.
  function server(restart: () => Response) {
    let boot = 'old';
    const fetchImpl = vi.fn(async (url: string) => {
      if (url === '/api/admin/restart') return restart();
      return health(boot);
    }) as unknown as typeof fetch;
    return { fetchImpl, relaunched: () => { boot = 'new'; } };
  }

  it('shows each phase in the sidebar status as its chunks arrive, then waits for the replacement and reloads', async () => {
    // Invariant: deps and npm read as installing, build as building, drain as draining; an ok result hands off to the wait.
    const stream = ndjsonStream();
    const s = server(() => stream.response);
    const reload = vi.fn();
    const p = performRestart({}, { fetchImpl: s.fetchImpl, reload });
    const status = () => appStore.get().sidebarStatus?.text;
    for (const [phase, want] of [['deps', 'Installing dependencies…'], ['npm', 'Installing dependencies…'], ['build', 'Building the interface…'], ['drain', 'Draining sessions…']]) {
      stream.push({ type: 'chunk', phase, text: 'x\n' });
      await vi.waitFor(() => expect(status()).toBe(want));
    }
    expect(reload).not.toHaveBeenCalled();
    s.relaunched();
    stream.push({ type: 'result', ok: true });
    stream.end();
    expect(await p).toEqual({ ok: true });
    expect(reload).toHaveBeenCalledTimes(1);
    expect(status()).toBe('Reloading…');
    expect(powerStore.get().inProgress).toBe(true);
  });

  it('a refused restart (ok:false) never reloads: the status and a toast name the error, and Restart re-arms', async () => {
    const stream = ndjsonStream();
    const s = server(() => stream.response);
    const reload = vi.fn();
    const p = performRestart({}, { fetchImpl: s.fetchImpl, reload });
    stream.push({ type: 'chunk', phase: 'build', text: 'x\n' });
    stream.push({ type: 'result', ok: false, error: 'vite build failed (exit 1)', tail: 'error: Unexpected token' });
    stream.end();
    expect(await p).toEqual({ ok: false, error: 'vite build failed (exit 1)', tail: 'error: Unexpected token' });
    expect(reload).not.toHaveBeenCalled();
    expect(powerStore.get().inProgress).toBe(false);
    expect(appStore.get().sidebarStatus).toEqual({ text: 'Restart refused: vite build failed (exit 1) — cc is still running', warn: true });
    expect(toast.error).toHaveBeenCalledWith('Restart refused — cc is still running', 'vite build failed (exit 1)');
    expect(vi.mocked(s.fetchImpl).mock.calls.filter(([url]) => url === '/api/health')).toHaveLength(1);
  });

  it('a 409 (a restart or update already in progress) is refused the same way', async () => {
    const s = server(() => new Response(JSON.stringify({ error: 'a restart or update is already in progress (update)', code: 'MAINTENANCE_IN_PROGRESS' }), { status: 409, headers: { 'content-type': 'application/json' } }));
    const reload = vi.fn();
    expect(await performRestart({}, { fetchImpl: s.fetchImpl, reload })).toEqual({ ok: false, error: 'a restart or update is already in progress (update)' });
    expect(reload).not.toHaveBeenCalled();
    expect(powerStore.get().inProgress).toBe(false);
    expect(appStore.get().sidebarStatus?.text).toBe('Restart refused: a restart or update is already in progress (update) — cc is still running');
  });

  it('a refusal answered as plain JSON carries the server\'s tail and never reloads', async () => {
    // Invariant: the non-streamed refusal is an ApiError like the streamed one, so its `tail` reaches the outcome.
    const s = server(() => new Response(JSON.stringify({ error: 'build failed', tail: 'tsc: 3 errors' }), { status: 409, headers: { 'content-type': 'application/json' } }));
    const reload = vi.fn();
    expect(await performRestart({}, { fetchImpl: s.fetchImpl, reload })).toEqual({ ok: false, error: 'build failed', tail: 'tsc: 3 errors' });
    expect(reload).not.toHaveBeenCalled();
    expect(toast.error).toHaveBeenCalledWith('Restart refused — cc is still running', 'build failed');
  });

  it('a connection that drops before a result still waits for a replacement and reloads', async () => {
    // Invariant: only a refusal the server answered stops the restart; a dropped connection is the old process going down.
    const s = server(() => { s.relaunched(); throw new TypeError('fetch failed'); });
    const reload = vi.fn();
    expect(await performRestart({}, { fetchImpl: s.fetchImpl, reload })).toEqual({ ok: true });
    expect(reload).toHaveBeenCalledTimes(1);
    expect(toast.error).not.toHaveBeenCalled();
  });
});

describe('performShutdown', () => {
  function server(shutdown: () => Response) {
    const urls: string[] = [];
    const fetchImpl = vi.fn(async (url: string) => {
      urls.push(url);
      if (url === '/api/admin/shutdown') return shutdown();
      return health('old');
    }) as unknown as typeof fetch;
    return { fetchImpl, urls };
  }

  it('drains with status, then shows the stopped state and reloads only once the WebSocket reopens', async () => {
    // Invariant: an ok shutdown never polls /api/health and never reloads by itself; it sets stopped and the stopped status, and the next WS open reloads exactly once.
    const stream = ndjsonStream();
    const s = server(() => stream.response);
    const reload = vi.fn();
    const p = performShutdown({ fetchImpl: s.fetchImpl, reload });
    expect(appStore.get().sidebarStatus?.text).toBe('Preparing the shutdown…');
    stream.push({ type: 'chunk', phase: 'drain', text: 'x\n' });
    await vi.waitFor(() => expect(appStore.get().sidebarStatus?.text).toBe('Draining sessions…'));
    stream.push({ type: 'result', ok: true });
    stream.end();
    expect(await p).toEqual({ ok: true });
    expect(powerStore.get()).toEqual({ inProgress: true, stopped: true });
    expect(appStore.get().sidebarStatus).toEqual({ text: STOPPED_STATUS, warn: true });
    expect(s.urls).toEqual(['/api/admin/shutdown']);
    expect(reload).not.toHaveBeenCalled();
    bus.dispatchEvent(new CustomEvent('open'));
    bus.dispatchEvent(new CustomEvent('open'));
    expect(reload).toHaveBeenCalledTimes(1);
  });

  it('a dropped connection is the server going down: stopped as well', async () => {
    // Invariant: only a refusal the server answered keeps cc reading as running.
    const s = server(() => { throw new TypeError('fetch failed'); });
    const reload = vi.fn();
    expect(await performShutdown({ fetchImpl: s.fetchImpl, reload })).toEqual({ ok: true });
    expect(powerStore.get().stopped).toBe(true);
    bus.dispatchEvent(new CustomEvent('open'));
    expect(reload).toHaveBeenCalledTimes(1);
  });

  it('a refused shutdown says so, re-arms the menu, and never reloads', async () => {
    // Invariant: a refusal toasts and shows "Shut down refused", leaves stopped false and inProgress false, and a later WS open reloads nothing.
    const s = server(() => new Response(JSON.stringify({ error: 'a restart or update is already in progress (restart)', code: 'MAINTENANCE_IN_PROGRESS' }), { status: 409, headers: { 'content-type': 'application/json' } }));
    const reload = vi.fn();
    expect(await performShutdown({ fetchImpl: s.fetchImpl, reload })).toEqual({ ok: false, error: 'a restart or update is already in progress (restart)' });
    expect(powerStore.get()).toEqual({ inProgress: false, stopped: false });
    expect(appStore.get().sidebarStatus?.text).toBe('Shut down refused: a restart or update is already in progress (restart) — cc is still running');
    expect(toast.error).toHaveBeenCalledWith('Shut down refused — cc is still running', 'a restart or update is already in progress (restart)');
    bus.dispatchEvent(new CustomEvent('open'));
    expect(reload).not.toHaveBeenCalled();
  });

  it('a shutdown while a restart runs is refused locally and posts nothing', async () => {
    // Invariant: the power actions are mutually exclusive in the page.
    powerStore.set({ inProgress: true });
    const s = server(() => new Response('{}'));
    expect(await performShutdown({ fetchImpl: s.fetchImpl, reload: vi.fn() })).toEqual({ ok: false, error: 'a restart is already in progress' });
    expect(s.urls).toEqual([]);
  });
});
