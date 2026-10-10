import { describe, expect, it, vi } from 'vitest';
import { appStore } from '@/state/app';
import { performRestart, restartStore, waitForReplacement } from './restart';

const health = (bootId: string | null) => new Response(JSON.stringify({ ok: true, bootId }), { status: 200 });

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
  it('posts the resume choice, reports progress in the sidebar status, reloads, and ignores a second click meanwhile', async () => {
    restartStore.set({ inProgress: false });
    const calls: { url: string; body?: string }[] = [];
    let boot = 'a';
    const fetchImpl = vi.fn(async (url: string, init?: RequestInit) => {
      calls.push({ url, body: init?.body as string | undefined });
      if (url === '/api/admin/restart') { boot = 'b'; return new Response('{}', { status: 202 }); }
      return health(boot);
    }) as unknown as typeof fetch;
    const reload = vi.fn();
    const p = performRestart({ resume: true }, { fetchImpl, reload });
    expect(appStore.get().sidebarStatus?.text).toBe('Draining sessions…');
    await performRestart({ resume: false }, { fetchImpl, reload });
    await p;
    const post = calls.find((c) => c.url === '/api/admin/restart');
    expect(JSON.parse(post!.body!)).toEqual({ resume: true });
    expect(calls.filter((c) => c.url === '/api/admin/restart')).toHaveLength(1);
    expect(reload).toHaveBeenCalledTimes(1);
    expect(appStore.get().sidebarStatus?.text).toBe('Reloading…');
  });
});
