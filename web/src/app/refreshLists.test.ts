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

  describe('a side read that fails after a good load', () => {
    type Side = { workspaces: RouteAnswer; sessions: RouteAnswer; spawns: RouteAnswer };
    const prevSession = { sessionId: 'cond-prev' };
    const prevSpawn = { 'cond-prev': [{ project: 'p1' }] };
    const good1: Side = {
      workspaces: { json: [{ name: 'ws-alpha' }, { name: 'ws-beta' }] },
      sessions: { json: [prevSession] },
      spawns: { json: prevSpawn },
    };
    const good2: Side = {
      workspaces: { json: [{ name: 'ws-gamma' }] },
      sessions: { json: [{ sessionId: 'cond-next' }] },
      spawns: { json: { 'cond-next': [{ project: 'p2' }] } },
    };
    const refused = (what: string): RouteAnswer => ({ status: 500, json: { error: what } });

    /** Serves the project list and each side read from its own queue of answers, one per refresh. */
    function serve(rounds: Side[]) {
      const queues = {
        workspaces: rounds.map((r) => r.workspaces), sessions: rounds.map((r) => r.sessions), spawns: rounds.map((r) => r.spawns),
      };
      const names = ['alpha', 'gamma', 'delta', 'epsilon'];
      let n = 0;
      routeFetch({
        'GET /api/projects/.conduct/sessions': () => queues.sessions.shift()!,
        'GET /api/projects': () => ({ json: [{ name: names[n++] }] }),
        'GET /api/workspaces': () => queues.workspaces.shift()!,
        'GET /api/conductors/projects': () => queues.spawns.shift()!,
      });
    }
    const quietWarn = () => vi.spyOn(console, 'warn').mockImplementation(() => {});
    const expectFirstLoad = () => {
      expect(appStore.get().workspaces, 'positive control: workspaces landed').toEqual(['ws-alpha', 'ws-beta']);
      expect(appStore.get().conductSessions, 'positive control: sessions landed').toEqual([prevSession]);
      expect(appStore.get().conductorSpawns, 'positive control: spawns landed').toEqual(prevSpawn);
    };

    it('a refused workspaces read after a good load keeps the last workspaces and flags them stale', async () => {
      const warn = quietWarn();
      try {
        serve([good1, { ...good2, workspaces: refused('workspaces read refused') }]);
        await refreshProjects();
        expectFirstLoad();
        await refreshProjects();
        expect(appStore.get().workspaces).toEqual(['ws-alpha', 'ws-beta']);
        expect(appStore.get()).toMatchObject({ staleLists: ['workspaces'], projects: [{ name: 'gamma' }], conductSessions: [{ sessionId: 'cond-next' }] });
        expect(warn.mock.calls).toEqual([['workspaces read failed; keeping the last list:', expect.objectContaining({ message: 'workspaces read refused' })]]);
      } finally { warn.mockRestore(); }
    });

    it('a refused conductor-sessions read after a good load keeps the last sessions and flags them stale', async () => {
      const warn = quietWarn();
      try {
        serve([good1, { ...good2, sessions: refused('conduct sessions refused') }]);
        await refreshProjects();
        expectFirstLoad();
        await refreshProjects();
        expect(appStore.get().conductSessions).toEqual([prevSession]);
        expect(appStore.get()).toMatchObject({ staleLists: ['conductSessions'], projects: [{ name: 'gamma' }], workspaces: ['ws-gamma'] });
        expect(warn.mock.calls).toEqual([['conductSessions read failed; keeping the last list:', expect.objectContaining({ message: 'conduct sessions refused' })]]);
      } finally { warn.mockRestore(); }
    });

    it('an unreachable conductor-projects read after a good load keeps the last spawn map and flags it stale', async () => {
      const warn = quietWarn();
      try {
        serve([good1, { ...good2, spawns: new TypeError('Failed to fetch') }]);
        await refreshProjects();
        expectFirstLoad();
        await refreshProjects();
        expect(appStore.get().conductorSpawns).toEqual(prevSpawn);
        expect(appStore.get()).toMatchObject({ staleLists: ['conductorSpawns'], projects: [{ name: 'gamma' }], workspaces: ['ws-gamma'] });
        expect(warn.mock.calls).toEqual([['conductorSpawns read failed; keeping the last list:', expect.objectContaining({ message: 'Failed to fetch' })]]);
      } finally { warn.mockRestore(); }
    });

    it('a list that keeps failing warns once and keeps one stale flag', async () => {
      const warn = quietWarn();
      try {
        const bad = (o: Partial<Side> = {}): Side => ({ ...good2, workspaces: refused('ws down'), ...o });
        serve([good1, bad(), bad(), bad({ sessions: refused('sessions down') })]);
        await refreshProjects();
        expectFirstLoad();
        await refreshProjects();
        const first = (appStore.get() as unknown as { staleLists: unknown }).staleLists;
        expect(first).toEqual(['workspaces']);
        await refreshProjects();
        expect((appStore.get() as unknown as { staleLists: unknown }).staleLists).toBe(first);
        expect(warn).toHaveBeenCalledTimes(1);
        await refreshProjects();
        expect(appStore.get()).toMatchObject({ staleLists: ['workspaces', 'conductSessions'] });
        expect(warn).toHaveBeenCalledTimes(2);
        expect(warn.mock.calls[1]).toEqual(['conductSessions read failed; keeping the last list:', expect.objectContaining({ message: 'sessions down' })]);
      } finally { warn.mockRestore(); }
    });

    it('a good read after a failure applies the new list and clears the stale flag', async () => {
      const warn = quietWarn();
      try {
        const bad: Side = { ...good2, workspaces: refused('ws down') };
        serve([good1, bad, { ...good2, workspaces: { json: [{ name: 'ws-delta' }] } }, bad]);
        await refreshProjects();
        expectFirstLoad();
        await refreshProjects();
        expect(appStore.get()).toMatchObject({ staleLists: ['workspaces'] });
        await refreshProjects();
        expect(appStore.get()).toMatchObject({ workspaces: ['ws-delta'], staleLists: [] });
        expect(warn).toHaveBeenCalledTimes(1);
        await refreshProjects();
        expect(appStore.get()).toMatchObject({ workspaces: ['ws-delta'], staleLists: ['workspaces'] });
        expect(warn).toHaveBeenCalledTimes(2);
      } finally { warn.mockRestore(); }
    });
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
