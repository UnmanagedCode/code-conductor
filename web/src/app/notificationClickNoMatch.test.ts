import { beforeEach, describe, expect, it, vi } from 'vitest';

vi.mock('@shared/ws', () => {
  const bus = new EventTarget();
  return { bus, sent: [], connect: vi.fn(), send: vi.fn() };
});
vi.mock('./sessionActions', () => ({ resumeSession: vi.fn(async () => {}) }));

let stop: (() => void) | null = null;
async function boot(instances: any[]) {
  stop?.();
  vi.resetModules();
  const fetch = vi.fn(async (url: string) => (
    url.endsWith('/locate') || url.endsWith('/pristine') ? { ok: false, status: 404, json: async () => ({}) }
      : { ok: true, json: async () => (url === '/api/instances' ? instances : []) }
  ));
  vi.stubGlobal('fetch', fetch);
  const c = await import('./controller');
  const { appStore } = await import('@/state/app');
  const events = await import('./events');
  const actions: any = await import('./sessionActions');
  const selects: unknown[] = [];
  events.on('select', (p) => selects.push(p));
  appStore.set({ instances, activeId: instances[0]?.id ?? null });
  c.startController();
  stop = c.stopController;
  return { c, appStore, fetch, selects, actions };
}

beforeEach(() => history.replaceState(null, '', '/'));

describe('a notification click that matches nothing', () => {
  it('selects and resumes nothing when neither id names a live or locatable session', async () => {
    // Invariant: an unmatched click leaves the active session and the route alone.
    const b = await boot([{ id: 'inst-2', sessionId: 's2' }]);
    const before = b.selects.length;
    await b.c.handleNotificationClick({ instanceId: 'nope', sessionId: 'nope' });
    expect(b.selects.length).toBe(before);
    expect(b.appStore.get().activeId).toBe('inst-2');
    expect(b.actions.resumeSession).not.toHaveBeenCalled();
    expect(location.hash).toBe('');
  });

  it('does nothing for missing data or an empty live list', async () => {
    // Invariant: no payload, or nothing live to match, is a silent no-op with no lookup.
    const b = await boot([]);
    await b.c.handleNotificationClick(null);
    await b.c.handleNotificationClick({ instanceId: 'i1' });
    expect(b.selects).toEqual([]);
    expect(b.appStore.get().activeId).toBeNull();
    expect(b.fetch).not.toHaveBeenCalledWith(expect.stringContaining('/locate'));
    expect(b.actions.resumeSession).not.toHaveBeenCalled();
  });
});
