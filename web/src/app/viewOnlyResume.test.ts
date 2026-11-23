// View-only: resuming a session opens the read-only Ended pane instead of POSTing
// /api/instances — from a sidebar row (resumeSession) and from a notification
// click (resumeSessionByAnchor). Flag off: both still resume.
import '@/test/browserHash';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { routeFetch } from '@/test/routeFetch';

vi.mock('@shared/ws', () => ({ bus: new EventTarget(), connect: vi.fn(), send: vi.fn() }));

const EMPTY_PAGE = { events: [], hasMore: false, segment: null, nextBefore: null, pageSegment: null, currentSegmentId: null };
const HIT = { project: 'p', worktreeName: null, archived: false };

async function boot(viewOnly: boolean) {
  vi.resetModules();
  // The flag lives in a module the reset replaced: set it on the fresh instance the app code will import.
  (await import('@shared/viewOnly')).setViewOnly(viewOnly);
  const calls = routeFetch({
    'GET /api/sessions/s-1/lineage-events': () => ({ json: EMPTY_PAGE }),
    'GET /api/sessions/s-1/pristine': () => ({ status: 404, json: { error: 'no' } }),
    'GET /api/sessions/s-1/locate': () => ({ json: HIT }),
    'POST /api/instances': () => ({ json: { id: 'i-new', project: 'p', sessionId: 's-1', status: 'idle', mode: 'default', worktree: null } }),
    'GET /api/': () => ({ json: [] }),
  });
  const { appStore } = await import('@/state/app');
  const actions = await import('./sessionActions');
  const controller = await import('./controller');
  return { calls, appStore, actions, controller };
}
const posts = (calls: { method: string; url: string }[]) => calls.filter((c) => c.method === 'POST' && c.url === '/api/instances');

beforeEach(() => history.replaceState(null, '', '/'));
afterEach(() => { vi.unstubAllGlobals(); });

describe('view-only resume', () => {
  it('resumeSession opens the Ended pane and sends no POST', async () => {
    // Invariant: a spectator's resume is a read-only open of the session, never a spawn.
    const b = await boot(true);
    await b.actions.resumeSession({ projectName: 'p', sessionId: 's-1' });
    expect(posts(b.calls)).toEqual([]);
    expect(b.appStore.get().activeId).toBe('ended:s-1');
    expect(b.appStore.get().ended).toMatchObject({ sessionId: 's-1', ended: { source: 'session' } });
  });

  it('a notification click opens the Ended pane without resuming', async () => {
    // Invariant: even a user gesture lands on the read-only pane, with no "Resuming session…" status and no POST.
    const b = await boot(true);
    const seen: unknown[] = [];
    b.appStore.subscribe(() => seen.push(b.appStore.get().sidebarStatus));
    await b.controller.resumeSessionByAnchor('s-1', { userGesture: true });
    expect(posts(b.calls)).toEqual([]);
    expect(b.appStore.get().activeId).toBe('ended:s-1');
    expect(seen.filter(Boolean)).toEqual([]);
  });

  it('normal mode still resumes', async () => {
    // Invariant (control): with the flag off the same call POSTs /api/instances.
    const b = await boot(false);
    await b.actions.resumeSession({ projectName: 'p', sessionId: 's-1' });
    expect(posts(b.calls)).toHaveLength(1);
  });
});
