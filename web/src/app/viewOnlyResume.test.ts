// A read-only session (shared/viewOnly.ts sessionViewOnly): resuming it opens
// the read-only Ended pane instead of POSTing /api/instances — from a sidebar
// row (resumeSession) and from a notification click (resumeSessionByAnchor).
// Under `full` both still resume, and under `interact` the focused session does.
import '@/test/browserHash';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { routeFetch } from '@/test/routeFetch';

vi.mock('@shared/ws', () => ({ bus: new EventTarget(), connect: vi.fn(), send: vi.fn() }));

const EMPTY_PAGE = { events: [], hasMore: false, segment: null, nextBefore: null, pageSegment: null, currentSegmentId: null };
const HIT = { project: 'p', worktreeName: null, archived: false };

async function boot(mode: 'full' | 'view' | 'interact', focused: string | null = null) {
  vi.resetModules();
  // The mode and focus live in modules the reset replaced: set them on the fresh instances the app code will import.
  (await import('@shared/focus')).setFocus(focused === null ? null : { sessionId: focused });
  const vo = await import('@shared/viewOnly');
  vo.setUiMode(mode);
  const calls = routeFetch({
    'GET /api/sessions/s-1/lineage-events': () => ({ json: EMPTY_PAGE }),
    'GET /api/sessions/s-1/pristine': () => ({ status: 404, json: { error: 'no' } }),
    'GET /api/sessions/s-1/locate': () => ({ json: HIT }),
    'GET /api/sessions/s-2/lineage-events': () => ({ json: EMPTY_PAGE }),
    'GET /api/sessions/s-2/pristine': () => ({ status: 404, json: { error: 'no' } }),
    'GET /api/sessions/s-2/locate': () => ({ json: HIT }),
    'POST /api/instances': () => ({ json: { id: 'i-new', project: 'p', sessionId: 's-1', status: 'idle', mode: 'default', worktree: null } }),
    'GET /api/': () => ({ json: [] }),
  });
  const { appStore } = await import('@/state/app');
  const actions = await import('./sessionActions');
  const controller = await import('./controller');
  return { calls, appStore, actions, controller, vo };
}
const posts = (calls: { method: string; url: string }[]) => calls.filter((c) => c.method === 'POST' && c.url === '/api/instances');

beforeEach(() => history.replaceState(null, '', '/'));
afterEach(() => { vi.unstubAllGlobals(); });

describe('read-only resume', () => {
  it('resumeSession opens the Ended pane and sends no POST', async () => {
    // Invariant: a spectator's resume is a read-only open of the session, never a spawn.
    const b = await boot('view');
    await b.actions.resumeSession({ projectName: 'p', sessionId: 's-1' });
    expect(posts(b.calls)).toEqual([]);
    expect(b.appStore.get().activeId).toBe('ended:s-1');
    expect(b.appStore.get().ended).toMatchObject({ sessionId: 's-1', ended: { source: 'session' } });
  });

  it('a notification click opens the Ended pane without resuming', async () => {
    // Invariant: even a user gesture lands on the read-only pane, with no "Resuming session…" status and no POST.
    const b = await boot('view');
    const seen: unknown[] = [];
    b.appStore.subscribe(() => seen.push(b.appStore.get().sidebarStatus));
    await b.controller.resumeSessionByAnchor('s-1', { userGesture: true });
    expect(posts(b.calls)).toEqual([]);
    expect(b.appStore.get().activeId).toBe('ended:s-1');
    expect(seen.filter(Boolean)).toEqual([]);
  });

  it('normal mode still resumes', async () => {
    // Invariant (control): under `full` the same call POSTs /api/instances.
    const b = await boot('full');
    await b.actions.resumeSession({ projectName: 'p', sessionId: 's-1' });
    expect(posts(b.calls)).toHaveLength(1);
  });

  it('interact: the focused session resumes; another opens the Ended pane', async () => {
    // Invariant: under `interact` resumeSession POSTs /api/instances (through the
    // client chokepoint) for the focused session only; any other session opens
    // read-only with no POST.
    const b = await boot('interact', 's-1');
    await b.actions.resumeSession({ projectName: 'p', sessionId: 's-2' });
    expect(posts(b.calls)).toEqual([]);
    expect(b.appStore.get().activeId).toBe('ended:s-2');
    await b.actions.resumeSession({ projectName: 'p', sessionId: 's-1' });
    expect(posts(b.calls)).toHaveLength(1);
  });

  it('interact: a gesture resumes the focused session; a page load opens it read-only', async () => {
    // Invariant: resumeSessionByAnchor resumes the focused session under
    // `interact` only on a user gesture; with no gesture it opens the Ended
    // pane, so focus mode never auto-resumes.
    const quiet = await boot('interact', 's-1');
    await quiet.controller.resumeSessionByAnchor('s-1', { userGesture: false });
    expect(posts(quiet.calls)).toEqual([]);
    expect(quiet.appStore.get().activeId).toBe('ended:s-1');
    const b = await boot('interact', 's-1');
    await b.controller.resumeSessionByAnchor('s-1', { userGesture: true });
    expect(posts(b.calls)).toHaveLength(1);
  });

  it('interact: the controller maps an instance to its session for the frame filter', async () => {
    // Invariant: startController registers the instance → session lookup, so
    // under `interact` a prompt frame for the focused session's instance passes
    // the frame filter and one for another instance does not; stopController
    // clears it.
    const b = await boot('interact', 's-1');
    b.appStore.set({ instances: [
      { id: 'i-root', project: '.conduct', status: 'idle', sessionId: 's-1', mode: 'default' },
      { id: 'i-worker', project: 'p', status: 'idle', sessionId: 's-2', mode: 'default' },
    ] });
    expect(b.vo.frameAllowed('prompt', { id: 'i-root' })).toBe(false);
    b.controller.startController();
    try {
      expect(b.vo.frameAllowed('prompt', { id: 'i-root' })).toBe(true);
      expect(b.vo.frameAllowed('prompt', { id: 'i-worker' })).toBe(false);
    } finally { b.controller.stopController(); }
    expect(b.vo.frameAllowed('prompt', { id: 'i-root' })).toBe(false);
  });
});
