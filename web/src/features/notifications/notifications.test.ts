import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import {
  __setSwRegistrationForTests, attentionNotification, createAttentionNotifier, fire, initNotifications,
  notificationStore, registerServiceWorker, shouldNotify, summaryAction, summaryText, toggleNotifications,
  __notificationsSettledForTests,
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

describe('summaryText', () => {
  it('counts every member and names two of them', () => {
    // Invariant: 1 — the count is the number of set members.
    expect(summaryText(['alpha-proj', 'beta-proj'])).toEqual({ title: '2 sessions need you', body: 'alpha-proj, beta-proj' });
  });

  it('dedupes names, truncates with an overflow count', () => {
    // Invariant: 1 — the count stays the member count while names dedupe.
    expect(summaryText(['projA', 'projB', 'projC', 'projD', 'projA'])).toEqual({ title: '5 sessions need you', body: 'projA, projB, projC …+1 more' });
  });

  it('counts a member whose name is missing', () => {
    // Invariant: 1 — a nameless member still counts.
    expect(summaryText(['', 'projC', ''])).toEqual({ title: '3 sessions need you', body: 'projC' });
  });
});

describe('summaryAction', () => {
  const next = (...ids: string[]) => new Map(ids.map((i) => [i, `proj-${i}`]));
  const set = (...ids: string[]) => new Set(ids);

  it('closes below two members, whatever the previous set was', () => {
    // Invariant: 4 — fewer than two sessions need you, no summary.
    expect(summaryAction(set(), next())).toEqual({ kind: 'close' });
    expect(summaryAction(set('A', 'B'), next('A'))).toEqual({ kind: 'close' });
    expect(summaryAction(set(), next('A'))).toEqual({ kind: 'close' });
  });

  it('alerts when a session joins, including a same-size swap', () => {
    // Invariant: 3 — the summary alerts when the set gains a session.
    expect(summaryAction(set('A'), next('A', 'B'))).toMatchObject({ kind: 'alert', title: '2 sessions need you' });
    expect(summaryAction(set('A', 'B'), next('A', 'C'))).toMatchObject({ kind: 'alert' });
  });

  it('does nothing when unchanged and refreshes when the set shrinks but keeps two', () => {
    // Invariant: 3 — an unchanged set is silent; a shrink updates the count only.
    expect(summaryAction(set('A', 'B'), next('A', 'B'))).toEqual({ kind: 'none' });
    expect(summaryAction(set('A', 'B', 'C'), next('A', 'B'))).toMatchObject({ kind: 'refresh', title: '2 sessions need you' });
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
  id: `i-${sid}`, project: 'proj', sessionId: sid, status: 'turn', conducted: false, rootSessionId: null,
  createdAt: 1000, liveAsks: 0, liveTurnEnds: 0, lastTurnError: false, awaitingUser: null, awaitingUserSource: null, ...o,
});
const done = (sid: string, o: Record<string, unknown> = {}) => inst(sid, { status: 'idle', liveTurnEnds: 1, ...o });

type Shown = { title: string; tag?: string; data?: any; body?: string; silent?: boolean | null; renotify?: boolean };

// A fake tray: a same-tag show replaces, an alert is a new tag or a renotify
// replace that is not silent, and the spec's TypeErrors are enforced.
function rig({ onScreen = new Set<string>(), bell = true } = {}) {
  const shown: Shown[] = [];
  const alerts: Shown[] = [];
  const tray = new Map<string, Shown & { close(): void }>();
  let gate: Promise<void> | null = null;
  __setSwRegistrationForTests({
    showNotification: async (title: string, opts: NotificationOptions & { renotify?: boolean }) => {
      if (opts.renotify && !opts.tag) throw new TypeError('renotify needs a tag');
      if (opts.renotify && opts.silent) throw new TypeError('renotify and silent conflict');
      if (gate) await gate;
      const entry = { title, ...opts, close: () => { if (tray.get(opts.tag!) === entry) tray.delete(opts.tag!); } };
      const replaced = !!opts.tag && tray.has(opts.tag);
      shown.push({ title, ...opts });
      if (opts.tag) tray.set(opts.tag, entry);
      if (!opts.silent && (!replaced || opts.renotify)) alerts.push({ title, ...opts });
    },
    getNotifications: async (filter?: { tag?: string }) => [...tray.values()].filter((n) => !filter?.tag || n.tag === filter.tag),
  } as unknown as ServiceWorkerRegistration);
  (globalThis as any).Notification = class { static permission = 'granted'; };
  notificationStore.set({ permission: 'granted', globalEnabled: bell });
  const notifier = createAttentionNotifier({ isOnScreen: (sid) => onScreen.has(sid) });
  const pings = () => shown.filter((n) => n.tag !== 'cc-summary');
  const summaryShows = () => shown.filter((n) => n.tag === 'cc-summary');
  const summaryAlerts = () => alerts.filter((n) => n.tag === 'cc-summary');
  const summary = () => tray.get('cc-summary');
  const open = () => [...tray.keys()].sort();
  // Shows made from now on wait for the returned release.
  const holdShows = () => {
    let release!: () => void;
    gate = new Promise<void>((r) => { release = () => { gate = null; r(); }; });
    return release;
  };
  const dismiss = (tag: string) => { tray.delete(tag); };
  const seed = (tag: string) => { tray.set(tag, { title: 'stale', tag, close: () => { tray.delete(tag); } }); };
  const observe = async (list: ReturnType<typeof inst>[]) => { notifier.observe(list); await __notificationsSettledForTests(); };
  return { notifier, observe, holdShows, pings, summaryShows, summaryAlerts, summary, open, dismiss, seed, onScreen };
}

describe('attention notifier', () => {
  afterEach(() => {
    __setSwRegistrationForTests(null);
    muteSession('s1', false);
  });

  it('stays silent for the session on screen, errors included, and does not replay it later', async () => {
    const { notifier, pings, onScreen } = rig({ onScreen: new Set(['s1']) });
    notifier.observe([inst('s1')]);
    notifier.observe([done('s1', { lastTurnError: true })]);
    await __notificationsSettledForTests();
    expect(pings()).toEqual([]);
    onScreen.clear();
    notifier.observe([done('s1', { lastTurnError: true })]);
    await __notificationsSettledForTests();
    expect(pings()).toEqual([]);
  });

  it('notifies for a session that is not on screen, with its tag and click data', async () => {
    const { notifier, pings } = rig();
    notifier.observe([inst('s1')]);
    notifier.observe([done('s1')]);
    await __notificationsSettledForTests();
    expect(pings()).toHaveLength(1);
    await __notificationsSettledForTests();
    expect(pings()[0]).toMatchObject({ title: '✓ proj — finished', tag: 'session:s1', data: { project: 'proj', instanceId: 'i-s1', sessionId: 's1' } });
  });

  it('silences a muted session while an unmuted sibling notifies', async () => {
    const { notifier, pings } = rig();
    muteSession('s1', true);
    expect(isSessionMuted('s1')).toBe(true);
    notifier.observe([inst('s1'), inst('s2')]);
    notifier.observe([done('s1'), done('s2')]);
    await __notificationsSettledForTests();
    expect(pings().map((n) => n.tag)).toEqual(['session:s2']);
  });

  it('with the bell off fires nothing, and turning it on does not flush the earlier transition', async () => {
    const { notifier, pings } = rig({ bell: false });
    notifier.observe([inst('s1')]);
    notifier.observe([done('s1')]);
    notificationStore.set({ globalEnabled: true });
    notifier.observe([done('s1')]);
    await __notificationsSettledForTests();
    expect(pings()).toEqual([]);
  });

  it('announces a live ask as waiting with the ask wording', async () => {
    const { notifier, pings } = rig();
    notifier.observe([inst('s1')]);
    notifier.observe([done('s1', { liveAsks: 1, awaitingUser: 'plan', awaitingUserSource: 'tool' })]);
    await __notificationsSettledForTests();
    expect(pings().map((n) => n.title)).toEqual(['❓ proj — waiting on you (plan approval)']);
  });

  it('announces a turn that ended behind a background job once, when the job clears', async () => {
    const { notifier, pings } = rig();
    notifier.observe([inst('s1')]);
    notifier.observe([done('s1', { waitingOnJob: true })]);
    await __notificationsSettledForTests();
    expect(pings()).toEqual([]);
    notifier.observe([done('s1', { waitingOnJob: false })]);
    notifier.observe([done('s1', { waitingOnJob: false })]);
    await __notificationsSettledForTests();
    expect(pings()).toHaveLength(1);
  });
});

const asking = (sid: string, o: Record<string, unknown> = {}) =>
  done(sid, { liveAsks: 1, awaitingUser: 'question', awaitingUserSource: 'tool', ...o });
const cond = (sid: string, o: Record<string, unknown> = {}) => inst(sid, { project: '.conduct', ...o });
const condDone = (sid: string, o: Record<string, unknown> = {}) => cond(sid, { status: 'idle', liveTurnEnds: 1, ...o });
const condOnWorker = (sid: string) => cond(sid, { status: 'idle', awaitingWake: true, liveTurnEnds: 1 });

describe('the summary notification', () => {
  afterEach(() => { __setSwRegistrationForTests(null); });

  it('counts the sessions this tab announced and ignores a stale ping it never fired', async () => {
    // Invariant: 1 — the count is announced sessions, not open session:* notifications.
    const r = rig();
    r.seed('session:Z');
    await r.observe([inst('X', { project: 'pX' }), cond('C')]);
    await r.observe([asking('X', { project: 'pX' }), cond('C')]);
    await r.observe([asking('X', { project: 'pX' }), condDone('C')]);
    expect(r.summary()).toMatchObject({ title: '2 sessions need you', body: 'pX, Conductor' });
  });

  it('closes a session\'s ping when it leaves Waiting/Finished, whether it runs again or vanishes', async () => {
    // Invariant: 2 — a ping closes when its session no longer needs you.
    const r = rig();
    await r.observe([inst('X', { project: 'pX' }), cond('C')]);
    await r.observe([asking('X', { project: 'pX' }), cond('C')]);
    await r.observe([asking('X', { project: 'pX' }), condDone('C')]);
    expect(r.open()).toEqual(['cc-summary', 'session:C', 'session:X']);
    await r.observe([asking('X', { project: 'pX' }), cond('C', { status: 'turn', liveTurnEnds: 1 })]);
    expect(r.open()).toContain('session:X');
    expect(r.open()).not.toContain('session:C');
    await r.observe([cond('C', { status: 'turn', liveTurnEnds: 1 })]);
    expect(r.open()).not.toContain('session:X');
  });

  it('never alerts again for an unchanged set, a repeated observe or a same-session ping', async () => {
    // Invariant: 3 — alert only when the set gains a session.
    const r = rig();
    await r.observe([inst('X', { project: 'pX' }), cond('C')]);
    await r.observe([done('X', { project: 'pX' }), cond('C')]);
    await r.observe([done('X', { project: 'pX' }), condDone('C')]);
    expect(r.summaryAlerts()).toHaveLength(1);
    for (let i = 0; i < 3; i++) await r.observe([done('X', { project: 'pX' }), condDone('C')]);
    await r.observe([asking('X', { project: 'pX', liveTurnEnds: 1 }), condDone('C')]);
    expect(r.pings().filter((n) => n.tag === 'session:X')).toHaveLength(2);
    expect(r.summaryShows()).toHaveLength(1);
    expect(r.summaryAlerts()).toHaveLength(1);
  });

  async function threeAnnounced() {
    const r = rig();
    const ids = ['X', 'Y', 'Z'];
    await r.observe(ids.map((i) => inst(i)));
    for (let n = 1; n <= 3; n++) await r.observe(ids.map((i, k) => (k < n ? done(i) : inst(i))));
    expect(r.summary()).toMatchObject({ title: '3 sessions need you' });
    return r;
  }

  it('respects a dismissed summary: unchanged and shrinking sets do not bring it back', async () => {
    // Invariant: 3 — a dismissed summary is never recreated by a non-growing set.
    const r = await threeAnnounced();
    r.dismiss('cc-summary');
    const alerts = r.summaryAlerts().length;
    await r.observe([done('X'), done('Y'), done('Z')]);
    expect(r.summary()).toBeUndefined();
    await r.observe([done('X'), done('Y'), inst('Z')]);
    expect(r.summary()).toBeUndefined();
    expect(r.summaryAlerts()).toHaveLength(alerts);
  });

  it('shrinks an open summary in place without an alert', async () => {
    // Invariant: 3 — a shrink updates the open summary silently.
    const r = await threeAnnounced();
    const alerts = r.summaryAlerts().length;
    await r.observe([done('X'), done('Y'), inst('Z')]);
    expect(r.summary()).toMatchObject({ title: '2 sessions need you' });
    expect(r.summaryAlerts()).toHaveLength(alerts);
  });

  it('alerts when a new session joins, even after the summary was dismissed', async () => {
    // Invariant: 3 — growth alerts whether or not the user dismissed the summary.
    const r = await threeAnnounced();
    r.dismiss('cc-summary');
    const alerts = r.summaryAlerts().length;
    await r.observe([done('X'), done('Y'), done('Z'), inst('W')]);
    await r.observe([done('X'), done('Y'), done('Z'), done('W')]);
    expect(r.summary()).toMatchObject({ title: '4 sessions need you' });
    expect(r.summaryAlerts()).toHaveLength(alerts + 1);
  });

  it('closes a summary left in the tray by an earlier page when a fresh notifier sees fewer than two', async () => {
    // Invariant: 4 — below two there is no summary, even one this page never showed.
    const r = rig();
    r.seed('cc-summary');
    await r.observe([inst('X')]);
    expect(r.summary()).toBeUndefined();
  });

  it('alerts when a session joins while the summary is open', async () => {
    // Invariant: 3 — growth alerts even when it replaces an open summary.
    const r = rig();
    await r.observe([inst('X'), inst('C'), inst('W')]);
    await r.observe([done('X'), inst('C'), inst('W')]);
    await r.observe([done('X'), done('C'), inst('W')]);
    expect(r.summary()).toMatchObject({ title: '2 sessions need you' });
    const alerts = r.summaryAlerts().length;
    await r.observe([done('X'), done('C'), done('W')]);
    expect(r.summary()).toMatchObject({ title: '3 sessions need you' });
    expect(r.summaryAlerts()).toHaveLength(alerts + 1);
  });

  it('closes the ping of a session that departs while its show is still held back', async () => {
    // Invariant: 2 — every service-worker call runs in order, so a departure close sees the ping show it targets.
    const r = rig();
    await r.observe([inst('X')]);
    const release = r.holdShows();
    r.notifier.observe([done('X')]);
    r.notifier.observe([inst('X')]);
    let settled = false;
    const pending = __notificationsSettledForTests().then(() => { settled = true; });
    await new Promise((res) => setTimeout(res, 0));
    expect(settled).toBe(false);
    release();
    await pending;
    expect(r.open()).toEqual([]);
  });

  it('closes the summary when fewer than two sessions are left, and keeps it closed', async () => {
    // Invariant: 4 — below two there is no summary.
    const r = rig();
    await r.observe([inst('X', { project: 'pX' }), cond('C')]);
    await r.observe([done('X', { project: 'pX' }), condDone('C')]);
    expect(r.summary()).toBeDefined();
    await r.observe([done('X', { project: 'pX' }), cond('C', { status: 'turn', liveTurnEnds: 1 })]);
    expect(r.summary()).toBeUndefined();
    await r.observe([cond('C', { status: 'turn', liveTurnEnds: 1 })]);
    expect(r.summary()).toBeUndefined();
  });

  it('adds only sessions whose own ping fired: a muted or on-screen one is not counted', async () => {
    // Invariant: 1 — summary members and per-session pings are one-to-one.
    const r = rig({ onScreen: new Set(['S']) });
    muteSession('M', true);
    await r.observe([inst('X'), inst('M'), inst('S')]);
    await r.observe([done('X'), done('M'), done('S')]);
    muteSession('M', false);
    expect(r.pings().map((n) => n.tag)).toEqual(['session:X']);
    expect(r.summaryShows()).toEqual([]);
  });

  it('makes no notification call while a conductor cycles between running and on a worker', async () => {
    // Invariant: 1, 3 — no ping and no summary call without a fired transition.
    const r = rig();
    await r.observe([inst('X'), cond('C', { status: 'turn' })]);
    await r.observe([asking('X'), cond('C', { status: 'turn' })]);
    const before = r.pings().length + r.summaryShows().length;
    for (let i = 0; i < 3; i++) {
      await r.observe([asking('X'), condOnWorker('C')]);
      await r.observe([asking('X'), cond('C', { status: 'turn', liveTurnEnds: 1 })]);
    }
    expect(r.pings().length + r.summaryShows().length).toBe(before);
    expect(r.summaryAlerts()).toEqual([]);
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
