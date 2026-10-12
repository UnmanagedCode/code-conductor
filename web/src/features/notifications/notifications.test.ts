import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import {
  __setSwRegistrationForTests, attentionNotification, createAttentionNotifier, fire, initNotifications,
  notificationStore, registerServiceWorker, shouldNotify, summarizeOpenNotifications, toggleNotifications,
  type AttentionTransition,
} from './notifications';
import { isSessionMuted, muteSession } from './mutes';

const OPEN = { permission: 'granted' as const, globalEnabled: true, muted: false, onScreen: false };

describe('shouldNotify', () => {
  it('fires only when every gate is open', () => {
    expect(shouldNotify(OPEN)).toBe(true);
    expect(shouldNotify({ ...OPEN, globalEnabled: false })).toBe(false);
    expect(shouldNotify({ ...OPEN, permission: 'denied' })).toBe(false);
    expect(shouldNotify({ ...OPEN, permission: 'default' })).toBe(false);
    expect(shouldNotify({ ...OPEN, muted: true })).toBe(false);
    expect(shouldNotify({ ...OPEN, onScreen: true })).toBe(false);
  });
});

describe('summarizeOpenNotifications', () => {
  it('needs two session pings before summarizing', () => {
    expect(summarizeOpenNotifications([])).toEqual({ shouldFire: false });
    expect(summarizeOpenNotifications(null)).toEqual({ shouldFire: false });
    expect(summarizeOpenNotifications([{ tag: 'session:a', data: { project: 'projA' } }])).toEqual({ shouldFire: false });
  });

  it('dedupes project names, truncates with an overflow count and ignores foreign tags', () => {
    const out = summarizeOpenNotifications([
      { tag: 'session:a', data: { project: 'projA' } },
      { tag: 'cc-summary' },
      { tag: 'session:b', data: { project: 'projB' } },
      { tag: 'session:c', data: { project: 'projC' } },
      { tag: 'session:d', data: { project: 'projD' } },
      { tag: 'session:e', data: { project: 'projA' } },
      { tag: 'other:thing', data: { project: 'projZ' } },
    ]);
    expect(out).toEqual({ shouldFire: true, title: '5 sessions need you', body: 'projA, projB, projC …+1 more' });
  });

  it('counts pings whose project is missing', () => {
    const out = summarizeOpenNotifications([{ tag: 'session:a' }, { tag: 'session:b', data: {} }, { tag: 'session:c', data: { project: 'projC' } }]);
    expect(out).toEqual({ shouldFire: true, title: '3 sessions need you', body: 'projC' });
  });
});

describe('attentionNotification', () => {
  const entry = { label: 'fix the build', projectName: 'proj-a', worktreeName: null, conductor: false };
  const waiting = (ask: string, source: string, e = entry): AttentionTransition => ({ kind: 'waiting', sessionId: 's1', instanceId: 'i1', entry: e, ask, source });
  const finished = (isError: boolean, e: AttentionTransition['entry'] = entry): AttentionTransition => ({ kind: 'finished', sessionId: 's1', instanceId: 'i1', entry: e, isError });

  it('names the kind of ask, and finished vs errored', () => {
    expect(attentionNotification(waiting('question', 'tool')).title).toBe('❓ proj-a — waiting on you (question)');
    expect(attentionNotification(waiting('plan', 'tool')).title).toBe('❓ proj-a — waiting on you (plan approval)');
    expect(attentionNotification(waiting('question', 'text')).title).toBe('❓ proj-a — waiting on you (asked in text)');
    expect(attentionNotification(finished(false)).title).toBe('✓ proj-a — finished');
    expect(attentionNotification(finished(true)).title).toBe('❌ proj-a — turn errored');
  });

  it('says Conductor for a conductor and project · worktree otherwise', () => {
    expect(attentionNotification(finished(false, { ...entry, conductor: true, projectName: '.conduct' })).title).toBe('✓ Conductor — finished');
    expect(attentionNotification(finished(false, { ...entry, worktreeName: 'feat-x' })).title).toBe('✓ proj-a · feat-x — finished');
  });

  it('carries the entry label, a per-session tag and the click data', () => {
    const n = attentionNotification(finished(false));
    expect(n.body).toBe('fix the build');
    expect(n.tag).toBe('session:s1');
    expect(n.data).toEqual({ project: 'proj-a', instanceId: 'i1', sessionId: 's1' });
  });
});

// ── The notifier, end to end over a fake SW registration ────────────────

const inst = (sid: string, o: Record<string, unknown> = {}) => ({
  id: `i-${sid}`, project: 'proj', sessionId: sid, status: 'turn', conducted: false, ownerSessionId: null,
  createdAt: 1000, liveAsks: 0, liveTurnEnds: 0, lastTurnError: false, awaitingUser: null, awaitingUserSource: null, ...o,
});
const done = (sid: string, o: Record<string, unknown> = {}) => inst(sid, { status: 'idle', liveTurnEnds: 1, ...o });

function rig({ onScreen = new Set<string>(), bell = true } = {}) {
  const shown: { title: string; tag?: string; data?: any }[] = [];
  __setSwRegistrationForTests({
    showNotification: async (title: string, opts: NotificationOptions) => { shown.push({ title, ...opts }); },
    getNotifications: async () => [],
  } as unknown as ServiceWorkerRegistration);
  (globalThis as any).Notification = class { static permission = 'granted'; };
  notificationStore.set({ permission: 'granted', globalEnabled: bell });
  const notifier = createAttentionNotifier({ isOnScreen: (sid) => onScreen.has(sid) });
  const pings = () => shown.filter((n) => n.tag !== 'cc-summary');
  return { notifier, pings, onScreen };
}

describe('attention notifier', () => {
  afterEach(() => {
    __setSwRegistrationForTests(null);
    muteSession('s1', false);
  });

  it('stays silent for the session on screen, errors included, and does not replay it later', () => {
    const { notifier, pings, onScreen } = rig({ onScreen: new Set(['s1']) });
    notifier.observe([inst('s1')]);
    notifier.observe([done('s1', { lastTurnError: true })]);
    expect(pings()).toEqual([]);
    onScreen.clear();
    notifier.observe([done('s1', { lastTurnError: true })]);
    expect(pings()).toEqual([]);
  });

  it('notifies for a session that is not on screen, with its tag and click data', () => {
    const { notifier, pings } = rig();
    notifier.observe([inst('s1')]);
    notifier.observe([done('s1')]);
    expect(pings()).toHaveLength(1);
    expect(pings()[0]).toMatchObject({ title: '✓ proj — finished', tag: 'session:s1', data: { project: 'proj', instanceId: 'i-s1', sessionId: 's1' } });
  });

  it('silences a muted session while an unmuted sibling notifies', () => {
    const { notifier, pings } = rig();
    muteSession('s1', true);
    expect(isSessionMuted('s1')).toBe(true);
    notifier.observe([inst('s1'), inst('s2')]);
    notifier.observe([done('s1'), done('s2')]);
    expect(pings().map((n) => n.tag)).toEqual(['session:s2']);
  });

  it('with the bell off fires nothing, and turning it on does not flush the earlier transition', () => {
    const { notifier, pings } = rig({ bell: false });
    notifier.observe([inst('s1')]);
    notifier.observe([done('s1')]);
    notificationStore.set({ globalEnabled: true });
    notifier.observe([done('s1')]);
    expect(pings()).toEqual([]);
  });

  it('announces a live ask as waiting with the ask wording', () => {
    const { notifier, pings } = rig();
    notifier.observe([inst('s1')]);
    notifier.observe([done('s1', { liveAsks: 1, awaitingUser: 'plan', awaitingUserSource: 'tool' })]);
    expect(pings().map((n) => n.title)).toEqual(['❓ proj — waiting on you (plan approval)']);
  });

  it('announces a turn that ended behind a background job once, when the job clears', () => {
    const { notifier, pings } = rig();
    notifier.observe([inst('s1')]);
    notifier.observe([done('s1', { waitingOnJob: true })]);
    expect(pings()).toEqual([]);
    notifier.observe([done('s1', { waitingOnJob: false })]);
    notifier.observe([done('s1', { waitingOnJob: false })]);
    expect(pings()).toHaveLength(1);
  });
});

describe('fire without a service worker', () => {
  it('builds a page notification whose click focuses the page, dispatches cc-notification-click and closes it', () => {
    __setSwRegistrationForTests(null);
    const created: any[] = [];
    (globalThis as any).Notification = class {
      static permission = 'granted';
      closed = false;
      onclick: (() => void) | null = null;
      constructor(public title: string, public opts: NotificationOptions) { created.push(this); }
      close() { this.closed = true; }
    };
    const focus = vi.spyOn(window, 'focus').mockImplementation(() => {});
    const events: CustomEvent[] = [];
    const listener = (e: Event) => events.push(e as CustomEvent);
    addEventListener('cc-notification-click', listener);
    const data = { project: 'proj-a', instanceId: 'inst-1', sessionId: 'sess-1' };
    const n = fire({ title: 't', body: 'b', tag: 'session:sess-1', data }) as any;
    n.onclick();
    removeEventListener('cc-notification-click', listener);
    expect(focus).toHaveBeenCalled();
    expect(events.map((e) => e.detail)).toEqual([data]);
    expect(n.closed).toBe(true);
    focus.mockRestore();
  });
});

describe('the root mount', () => {
  it('registers /sw.js at the root, so an installed client updates that one registration in place', async () => {
    __setSwRegistrationForTests(null);
    const reg = {} as ServiceWorkerRegistration;
    const register = vi.fn(async () => reg);
    Object.defineProperty(navigator, 'serviceWorker', { configurable: true, value: { register, ready: Promise.resolve(reg) } });
    try {
      expect(await registerServiceWorker()).toBe(reg);
      expect(register).toHaveBeenCalledWith('/sw.js');
    } finally {
      delete (navigator as any).serviceWorker;
      __setSwRegistrationForTests(null);
    }
  });

  it('a notification carries the icon served at the root', () => {
    __setSwRegistrationForTests(null);
    const created: { opts: NotificationOptions }[] = [];
    (globalThis as any).Notification = class {
      static permission = 'granted';
      constructor(_title: string, public opts: NotificationOptions) { created.push(this); }
      close() {}
    };
    fire({ title: 't', body: 'b', tag: 'session:s', data: { project: 'p', instanceId: 'i', sessionId: 's' } });
    expect(created.map((n) => n.opts.icon)).toEqual(['/icon-192.png']);
  });
});

describe('the bell', () => {
  beforeEach(() => notificationStore.set({ permission: 'default', globalEnabled: false }));

  it('asks for permission and turns on when granted, then off on the next click', async () => {
    (globalThis as any).Notification = class {
      static permission: NotificationPermission = 'default';
      static requestPermission = vi.fn(async () => { (globalThis as any).Notification.permission = 'granted'; return 'granted'; });
    };
    await toggleNotifications();
    expect(notificationStore.get()).toMatchObject({ permission: 'granted', globalEnabled: true });
    await toggleNotifications();
    expect(notificationStore.get().globalEnabled).toBe(false);
  });

  it('stays off when permission is denied', async () => {
    (globalThis as any).Notification = class { static permission: NotificationPermission = 'denied'; static requestPermission = vi.fn(); };
    await toggleNotifications();
    expect(notificationStore.get()).toMatchObject({ permission: 'denied', globalEnabled: false });
    expect((globalThis as any).Notification.requestPermission).not.toHaveBeenCalled();
  });

  it('boots on when permission was granted before', () => {
    (globalThis as any).Notification = class { static permission: NotificationPermission = 'granted'; };
    initNotifications();
    expect(notificationStore.get()).toMatchObject({ permission: 'granted', globalEnabled: true });
  });
});
