// The per-place session-list cache: a stop or an archive drops only its own
// place's list; the Archived page's null stale event drops every place.
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

vi.mock('@/app/controller', () => ({
  refreshProjects: vi.fn(async () => {}),
  refreshInstances: vi.fn(async () => {}),
  selectInstance: vi.fn(),
  send: vi.fn(),
}));
vi.mock('@/ui/feedback', () => ({
  confirmDialog: vi.fn(async () => true),
  toast: { error: vi.fn() },
}));

import * as controller from '@/app/controller';
import { emit } from '@/app/events';
import { archiveSession, closeSession } from '@/app/sessionActions';
import { appStore } from '@/state/app';
import { sessionsCache } from './state';

function reseed() {
  sessionsCache.clear();
  for (const k of ['p', 'p:wt', 'q']) sessionsCache.set(k, []);
}
const keys = () => [...sessionsCache.keys()].sort();

beforeEach(() => {
  vi.mocked(controller.refreshProjects).mockClear();
  vi.mocked(controller.refreshInstances).mockClear();
  appStore.set({ activeId: null, instances: [] });
  vi.stubGlobal('fetch', vi.fn(async () => ({ ok: true, status: 200, json: async () => ({ ok: true }) })));
});
afterEach(() => {
  vi.unstubAllGlobals();
});

describe('session-list cache', () => {
  it('a stop drops only its own place\'s cached session list — the project\'s, or the worktree\'s — and refreshes both lists once', async () => {
    reseed();
    await closeSession({ projectName: 'p', instanceId: 'i1', sessionId: 's1', status: 'idle' });
    expect(keys()).toEqual(['p:wt', 'q']);
    expect(controller.refreshProjects).toHaveBeenCalledTimes(1);
    expect(controller.refreshInstances).toHaveBeenCalledTimes(1);

    reseed();
    await closeSession({ projectName: 'p', worktreeName: 'wt', instanceId: 'i1', sessionId: 's1', status: 'idle' });
    expect(keys()).toEqual(['p', 'q']);
  });

  it('an archive drops only its own place\'s list too; a null stale event drops every place', async () => {
    reseed();
    await archiveSession({ projectName: 'p', worktreeName: 'wt', sessionId: 's2' });
    expect(keys()).toEqual(['p', 'q']);

    reseed();
    await archiveSession({ projectName: 'q', sessionId: 's3', synthetic: true });
    expect(keys()).toEqual(['p', 'p:wt']);

    reseed();
    emit('sessionsStale', null);
    expect(keys()).toEqual([]);
  });
});
