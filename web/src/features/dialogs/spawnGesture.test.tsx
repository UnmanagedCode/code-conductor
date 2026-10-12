// The spawn dialog's Start session is a gesture that opens its new session
// only once the spawn and the instance list refresh are done: a session the
// user picks meanwhile stands. Runs the real controller, so the pick is a real
// selection.
import { afterEach, describe, expect, it, vi } from 'vitest';
import { act, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { held, routeFetch, type RouteAnswer } from '@/test/routeFetch';

vi.mock('@/lib/core/ws.js', () => ({ bus: new EventTarget(), connect: vi.fn(), send: vi.fn() }));
vi.mock('@/lib/core/capabilities.js', () => ({
  loadCapabilities: vi.fn(async () => ({ remoteSystems: true, voice: true, fuseUnion: true })),
  capabilities: () => null,
}));

import { DialogsHost } from './DialogsHost';
import { closeDialog, dialogStore, openSpawnDialog } from './api';
import { selectInstance } from '@/app/controller';
import { appStore, activeInstance } from '@/state/app';
import type { Instance, Project } from '@/state/types';

const inst = (id: string, sessionId: string): Instance => ({ id, sessionId, project: 'p', status: 'idle', mode: 'default' });
const P: Project = { name: 'p', path: '/w/p', system: 'local', remoteId: null, worktrees: [], isGitRepo: true, unbornHead: false };
const C = inst('iC', 's-c');
const FIRST = inst('i:spawn-1', 's-spawn-1');
const SECOND = inst('i:spawn-2', 's-spawn-2');

afterEach(() => {
  closeDialog('spawn');
  vi.unstubAllGlobals();
});

describe('spawn dialog and a session picked while it spawns', () => {
  it('a session picked while the spawned session is being listed stands, with its anchor, and the new session is not opened', async () => {
    history.replaceState(null, '', '/');
    appStore.set({ projects: [P], instances: [C], activeId: null });
    const spawned = [FIRST, SECOND];
    const reads: ReturnType<typeof held<RouteAnswer>>[] = [];
    routeFetch({
      'GET /api/instances': () => { const h = held<RouteAnswer>(); reads.push(h); return h.answer; },
      'POST /api/instances': () => ({ json: spawned.shift() }),
      'GET /api/projects/': () => ({ json: [] }),
      'GET /api/projects': () => ({ json: [P] }),
      'GET /api/workspaces': () => ({ json: [] }),
    });
    const active = () => activeInstance(appStore.get())?.id ?? null;
    const start = async () => {
      act(() => openSpawnDialog('p'));
      fireEvent.click(await screen.findByRole('button', { name: /Start session/ }));
      await waitFor(() => expect(reads, 'fixture check: the spawn is listing its session').toHaveLength(1));
    };
    const land = async (list: Instance[]) => {
      await act(async () => { reads.shift()!.release({ json: list }); });
      await waitFor(() => expect(dialogStore.get().spawn).toBeNull());
    };
    render(<DialogsHost />);

    await start();
    await land([C, FIRST]);
    expect(active(), 'control: the spawn alone opens its new session').toBe(FIRST.id);

    await start();
    act(() => selectInstance('iC', { userGesture: true }));
    await land([C, FIRST, SECOND]);
    expect(active()).toBe('iC');
    expect(location.hash).toBe('#session=s-c');
  });
});
