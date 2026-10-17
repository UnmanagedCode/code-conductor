// The REST refreshers on a refused read: a JSON 5xx from /api/projects or
// /api/instances rejects with the server's reason, and the store keeps the
// last list it applied rather than blanking the sidebar.
import { describe, expect, it, vi } from 'vitest';
import { routeFetch, type RouteAnswer } from '@/test/routeFetch';

vi.mock('@shared/ws', () => ({ bus: new EventTarget(), connect: vi.fn(), send: vi.fn() }));

import { bus } from '@shared/ws';
import { refreshInstances, refreshProjects, startController, stopController } from './controller';
import { appStore, type AppState } from '@/state/app';
import type { Project, SessionRow } from '@/state/types';

describe('refreshing the lists', () => {
  it('a JSON 5xx from /api/projects rejects with its reason and keeps the last project list', async () => {
    const answers: RouteAnswer[] = [{ json: [{ name: 'alpha' }] }, { status: 500, json: { error: 'store locked' } }];
    routeFetch({
      'GET /api/projects/.conduct/sessions': () => ({ json: [] }),
      'GET /api/projects': () => answers.shift()!,
      'GET /api/workspaces': () => ({ json: [] }),
      'GET /api/conductors/projects': () => ({ json: {} }),
    });
    await refreshProjects();
    expect(appStore.get().projects, 'positive control: the first list landed').toEqual([{ name: 'alpha' }]);
    await expect(refreshProjects()).rejects.toThrow('store locked');
    expect(appStore.get().projects).toEqual([{ name: 'alpha' }]);
  });

  it('a JSON 5xx from /api/instances rejects with its reason and keeps the last instance list', async () => {
    const live = { id: 'i1', sessionId: 's1', project: 'alpha', status: 'idle', mode: 'default' };
    const answers: RouteAnswer[] = [{ json: [live] }, { status: 503, json: { error: 'instances unavailable' } }];
    routeFetch({ 'GET /api/instances': () => answers.shift()! });
    await refreshInstances();
    expect(appStore.get().instances, 'positive control: the first list landed').toEqual([live]);
    await expect(refreshInstances()).rejects.toThrow('instances unavailable');
    expect(appStore.get().instances).toEqual([live]);
  });

  it('a refused workspaces read degrades to no workspaces, silently, and the project list still applies', async () => {
    appStore.set({ workspaces: ['stale-ws'] });
    routeFetch({
      'GET /api/projects/.conduct/sessions': () => ({ json: [] }),
      'GET /api/projects': () => ({ json: [{ name: 'gamma' }] }),
      'GET /api/workspaces': () => ({ status: 500, json: { error: 'workspaces read refused' } }),
      'GET /api/conductors/projects': () => ({ json: {} }),
    });
    await expect(refreshProjects()).resolves.toBeUndefined();
    expect(appStore.get().workspaces).toEqual([]);
    expect(appStore.get().projects).toEqual([{ name: 'gamma' }]);
  });

  it('refused conductor-session and conductor-spawn reads degrade to empty, silently, and the project list still applies', async () => {
    appStore.set({ conductSessions: [{ sessionId: 'stale' }] as unknown as SessionRow[], conductorSpawns: { stale: [] } as AppState['conductorSpawns'] });
    routeFetch({
      'GET /api/projects/.conduct/sessions': () => ({ status: 500, json: { error: 'conduct sessions refused' } }),
      'GET /api/projects': () => ({ json: [{ name: 'delta' }] }),
      'GET /api/workspaces': () => ({ json: [{ name: 'ws1' }] }),
      'GET /api/conductors/projects': () => new TypeError('Failed to fetch'),
    });
    await expect(refreshProjects()).resolves.toBeUndefined();
    expect(appStore.get().conductSessions).toEqual([]);
    expect(appStore.get().conductorSpawns).toEqual({});
    expect(appStore.get().workspaces).toEqual(['ws1']);
    expect(appStore.get().projects).toEqual([{ name: 'delta' }]);
  });

  it("a server hint whose read is refused is logged, not left unhandled, and keeps the last list", async () => {
    // Invariant: the hint listeners catch a refused refresh (an unhandled rejection fails this run).
    const live = { id: 'i2', sessionId: 's2', project: 'alpha', status: 'idle', mode: 'default' };
    appStore.set({ instances: [live], projects: [{ name: 'beta' }] as unknown as Project[] });
    routeFetch({
      'GET /api/instances': () => ({ status: 500, json: { error: 'hint read refused' } }),
      'GET /api/projects': () => ({ status: 500, json: { error: 'hint read refused' } }),
    });
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
    startController();
    try {
      bus.dispatchEvent(new CustomEvent('instances'));
      bus.dispatchEvent(new CustomEvent('projects'));
      await vi.waitFor(() => expect(warn).toHaveBeenCalledTimes(2));
      expect(warn.mock.calls).toEqual([
        ['refreshInstances on a hint failed:', expect.objectContaining({ message: 'hint read refused' })],
        ['refreshProjects on a hint failed:', expect.objectContaining({ message: 'hint read refused' })],
      ]);
      expect(appStore.get().instances).toEqual([live]);
      expect(appStore.get().projects).toEqual([{ name: 'beta' }]);
    } finally {
      stopController();
      warn.mockRestore();
    }
  });
});
