import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

// The real on-screen predicate in index.ts, reached through startNotifications
// (the notifications.test.ts rig injects its own predicate instead).

const inst = (sid: string, o: Record<string, unknown> = {}) => ({
  id: `i-${sid}`, project: 'proj', sessionId: sid, status: 'turn', conducted: false, ownerSessionId: null,
  createdAt: 1000, liveAsks: 0, liveTurnEnds: 0, lastTurnError: false, awaitingUser: null, awaitingUserSource: null, ...o,
});
const done = (sid: string) => inst(sid, { status: 'idle', liveTurnEnds: 1 });

function setVisibility(state: 'visible' | 'hidden') {
  Object.defineProperty(document, 'visibilityState', { configurable: true, get: () => state });
  Object.defineProperty(document, 'hidden', { configurable: true, get: () => state === 'hidden' });
}

async function boot({ view, active }: { view: string; active: string }) {
  vi.resetModules();
  (globalThis as any).Notification = class { static permission = 'granted'; };
  const shown: { title: string; tag?: string }[] = [];
  const n = await import('./notifications');
  const { startNotifications } = await import('./index');
  const { appStore } = await import('@/state/app');
  const { routeStore, parseHash } = await import('@/state/route');
  const { emit } = await import('@/app/events');
  startNotifications();
  n.__setSwRegistrationForTests({
    showNotification: async (title: string, opts: NotificationOptions) => { shown.push({ title, ...opts }); },
    getNotifications: async () => [],
  } as unknown as ServiceWorkerRegistration);
  n.notificationStore.set({ permission: 'granted', globalEnabled: true });
  routeStore.set({ route: parseHash(view) });
  const feed = (instances: any[]) => {
    appStore.set({ instances, activeId: active });
    emit('instances');
  };
  return { feed, pings: () => shown.filter((s) => s.tag !== 'cc-summary') };
}

describe('the real on-screen predicate', () => {
  beforeEach(() => setVisibility('visible'));
  afterEach(() => {
    setVisibility('visible');
    delete (globalThis as any).Notification;
  });

  it('a visible tab showing the active session suppresses its finish, while its sibling still notifies', async () => {
    // Invariant: only a visible tab on the session view with that session active counts as looking at it.
    const { feed, pings } = await boot({ view: '#session=s7', active: 'i-s7' });
    feed([inst('s7'), inst('s8')]);
    feed([done('s7'), done('s8')]);
    expect(pings().map((p) => p.tag)).toEqual(['session:s8']);
  });

  it('a hidden tab counts as not on screen even with that session active', async () => {
    // Invariant: a hidden tab is never "looking"; the same session that was suppressed while visible notifies.
    setVisibility('hidden');
    const { feed, pings } = await boot({ view: '#session=s7', active: 'i-s7' });
    feed([inst('s7')]);
    feed([done('s7')]);
    expect(pings().map((p) => p.tag)).toEqual(['session:s7']);
  });

  it('a full-page view counts as not on screen even with that session active', async () => {
    // Invariant: a full-page view covers the session pane, so its finish still notifies.
    const { feed, pings } = await boot({ view: '#costs', active: 'i-s7' });
    feed([inst('s7')]);
    feed([done('s7')]);
    expect(pings().map((p) => p.tag)).toEqual(['session:s7']);
  });
});
