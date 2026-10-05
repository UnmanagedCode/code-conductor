import { test } from 'node:test';
import assert from 'node:assert/strict';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const MODULE_PATH = path.resolve(__dirname, '..', 'public', 'notifications.js');
const { shouldNotify, summarizeOpenNotifications, resolveNotificationInstance, attentionNotification } = await import(pathToFileURL(MODULE_PATH).href);
// Fresh module instance per test below, so mutating NotificationState (permission,
// globalEnabled) in one test can't leak into another.
const loadFresh = () => import(pathToFileURL(MODULE_PATH).href + `?t=${Math.random()}`);

const OPEN = { permission: 'granted', globalEnabled: true, muted: false, onScreen: false };

test('shouldNotify: fires when every gate is open', () => {
  assert.equal(shouldNotify(OPEN), true);
});

test('shouldNotify: respects global toggle', () => {
  assert.equal(shouldNotify({ ...OPEN, globalEnabled: false }), false);
});

test('shouldNotify: requires granted permission', () => {
  assert.equal(shouldNotify({ ...OPEN, permission: 'denied' }), false);
  assert.equal(shouldNotify({ ...OPEN, permission: 'default' }), false);
});

test('shouldNotify: a muted session is suppressed', () => {
  assert.equal(shouldNotify({ ...OPEN, muted: true }), false);
});

test('shouldNotify: a session on screen is suppressed, and nothing overrides that', () => {
  assert.equal(shouldNotify({ ...OPEN, onScreen: true }), false);
  assert.equal(shouldNotify({ ...OPEN, onScreen: true, isError: true }), false);
});

test('summarizeOpenNotifications: empty tray → no summary', () => {
  assert.deepEqual(summarizeOpenNotifications([]), { shouldFire: false });
  assert.deepEqual(summarizeOpenNotifications(null), { shouldFire: false });
});

test('summarizeOpenNotifications: single session → no summary', () => {
  const open = [{ tag: 'session:a', data: { project: 'projA' } }];
  assert.deepEqual(summarizeOpenNotifications(open), { shouldFire: false });
});

test('summarizeOpenNotifications: two sessions → summary with both projects', () => {
  const open = [
    { tag: 'session:a', data: { project: 'projA' } },
    { tag: 'session:b', data: { project: 'projB' } },
  ];
  const out = summarizeOpenNotifications(open);
  assert.equal(out.shouldFire, true);
  assert.equal(out.title, '2 sessions need you');
  assert.equal(out.body, 'projA, projB');
});

test('summarizeOpenNotifications: dedupes project names and truncates with overflow', () => {
  const open = [
    { tag: 'session:a', data: { project: 'projA' } },
    { tag: 'session:b', data: { project: 'projB' } },
    { tag: 'session:c', data: { project: 'projC' } },
    { tag: 'session:d', data: { project: 'projD' } },
    { tag: 'session:e', data: { project: 'projA' } }, // duplicate name, distinct session
  ];
  const out = summarizeOpenNotifications(open);
  assert.equal(out.shouldFire, true);
  assert.equal(out.title, '5 sessions need you');
  assert.equal(out.body, 'projA, projB, projC …+1 more');
});

test('summarizeOpenNotifications: ignores non-session tags (cc-summary, foreign)', () => {
  const open = [
    { tag: 'session:a', data: { project: 'projA' } },
    { tag: 'cc-summary' },
    { tag: 'session:b', data: { project: 'projB' } },
    { tag: 'other:thing', data: { project: 'projZ' } },
  ];
  const out = summarizeOpenNotifications(open);
  assert.equal(out.shouldFire, true);
  assert.equal(out.title, '2 sessions need you');
  assert.equal(out.body, 'projA, projB');
});

test('summarizeOpenNotifications: counts entries even when project data is missing', () => {
  const open = [
    { tag: 'session:a' },
    { tag: 'session:b', data: {} },
    { tag: 'session:c', data: { project: 'projC' } },
  ];
  const out = summarizeOpenNotifications(open);
  assert.equal(out.shouldFire, true);
  assert.equal(out.title, '3 sessions need you');
  assert.equal(out.body, 'projC');
});

// ── attentionNotification wording ───────────────────────────────────────────

const handEntry = { label: 'fix the build', projectName: 'proj-a', worktreeName: null, conductor: false };
const waiting = (ask, source, entry = handEntry) => ({ kind: 'waiting', sessionId: 's1', instanceId: 'i1', entry, ask, source });
const finished = (isError, entry = handEntry) => ({ kind: 'finished', sessionId: 's1', instanceId: 'i1', entry, isError });

test('attentionNotification: waiting names the kind of ask', () => {
  assert.equal(attentionNotification(waiting('question', 'tool')).title, '❓ proj-a — waiting on you (question)');
  assert.equal(attentionNotification(waiting('plan', 'tool')).title, '❓ proj-a — waiting on you (plan approval)');
  assert.equal(attentionNotification(waiting('question', 'text')).title, '❓ proj-a — waiting on you (asked in text)');
});

test('attentionNotification: finished ok and finished errored wording', () => {
  assert.equal(attentionNotification(finished(false)).title, '✓ proj-a — finished');
  assert.equal(attentionNotification(finished(true)).title, '❌ proj-a — turn errored');
});

test('attentionNotification: where is Conductor for a conductor, project · worktree otherwise', () => {
  const conductor = { ...handEntry, conductor: true, projectName: '.conduct' };
  assert.equal(attentionNotification(finished(false, conductor)).title, '✓ Conductor — finished');
  const wt = { ...handEntry, worktreeName: 'feat-x' };
  assert.equal(attentionNotification(finished(false, wt)).title, '✓ proj-a · feat-x — finished');
});

test('attentionNotification: body is the entry label; tag and data are per session', () => {
  const n = attentionNotification(finished(false));
  assert.equal(n.body, 'fix the build');
  assert.equal(n.tag, 'session:s1');
  assert.deepEqual(n.data, { project: 'proj-a', instanceId: 'i1', sessionId: 's1' });
});

// ── resolveNotificationInstance ─────────────────────────────────────────────
// Pure id/sessionId → live-instance resolution used by the notification
// click handler in wsRouter.js. No DOM/browser globals needed.

test('resolveNotificationInstance: matches by instanceId', () => {
  const instances = [{ id: 'i1', sessionId: 's1' }, { id: 'i2', sessionId: 's2' }];
  assert.deepEqual(resolveNotificationInstance({ instanceId: 'i2', sessionId: 's1' }, instances), instances[1]);
});

test('resolveNotificationInstance: falls back to sessionId when instanceId is not live', () => {
  // Covers a respawn: the notified instanceId is gone, but the session lives
  // on under a new instance id.
  const instances = [{ id: 'i2-new', sessionId: 's1' }];
  assert.deepEqual(resolveNotificationInstance({ instanceId: 'i1-old', sessionId: 's1' }, instances), instances[0]);
});

test('resolveNotificationInstance: no match returns null', () => {
  const instances = [{ id: 'i1', sessionId: 's1' }];
  assert.equal(resolveNotificationInstance({ instanceId: 'nope', sessionId: 'nope' }, instances), null);
});

test('resolveNotificationInstance: missing/empty instances list returns null', () => {
  assert.equal(resolveNotificationInstance({ instanceId: 'i1' }, null), null);
  assert.equal(resolveNotificationInstance({ instanceId: 'i1' }, []), null);
});

test('resolveNotificationInstance: missing data returns null', () => {
  assert.equal(resolveNotificationInstance(undefined, [{ id: 'i1' }]), null);
});

// ── fire click wiring ──────────────────────────────────
// Mock just enough of the page-level Notification path (SW registration
// left null so `fire` falls through to `new Notification(...)`) to assert
// the data shape and the onclick → cc-notification-click dispatch, without
// pulling in a real browser.

function installFakeNotificationGlobals() {
  const dispatched = [];
  let focused = false;
  class FakeNotification {
    constructor(title, opts) { this.title = title; this.opts = opts; this.data = opts.data; this.closed = false; }
    close() { this.closed = true; }
  }
  FakeNotification.permission = 'granted';
  globalThis.Notification = FakeNotification;
  globalThis.window = {
    Notification: FakeNotification,
    focus: () => { focused = true; },
    dispatchEvent: (e) => { dispatched.push(e); },
  };
  globalThis.document = { hidden: true };
  globalThis.CustomEvent = class CustomEvent {
    constructor(type, init) { this.type = type; this.detail = init?.detail; }
  };
  return { dispatched, isFocused: () => focused };
}

// ── per-session mute ────────────────────────────────────────────────────────
// The mute set is keyed by sessionId (not the per-process instance id) so a
// respawn under a new instance id can't silently un-mute a session.

function installFakeLocalStorage(seed = {}) {
  const map = new Map(Object.entries(seed));
  globalThis.localStorage = {
    getItem: (k) => (map.has(k) ? map.get(k) : null),
    setItem: (k, v) => { map.set(k, String(v)); },
    removeItem: (k) => { map.delete(k); },
  };
  return map;
}

test('muted session stays silent while an unmuted sibling still notifies', async () => {
  const mod = await loadFresh();
  const { notifyAttention, muteSession, isSessionMuted, NotificationState } = mod;
  installFakeNotificationGlobals();
  installFakeLocalStorage();
  const t = (sessionId, instanceId, over = {}) => ({ ...finished(false), sessionId, instanceId, ...over });
  try {
    NotificationState.globalEnabled = true;
    NotificationState.permission = 'granted';
    muteSession('sess-muted', true);
    assert.equal(isSessionMuted('sess-muted'), true);
    assert.equal(isSessionMuted('sess-loud'), false);

    assert.equal(notifyAttention({ transition: t('sess-muted', 'i-muted'), onScreen: false }), null,
      'muted session fires nothing');
    assert.ok(notifyAttention({ transition: t('sess-loud', 'i-loud'), onScreen: false }),
      'unmuted sibling still notifies');

    // Respawn: same session, brand-new instance id — still muted.
    assert.equal(notifyAttention({ transition: t('sess-muted', 'i-muted-respawned'), onScreen: false }), null,
      'mute survives a respawn under a new instance id');
    assert.equal(notifyAttention({ transition: t('sess-muted', 'i-muted', { isError: true }), onScreen: false }), null,
      'muted session stays silent even on an errored finish');

    muteSession('sess-muted', false);
    assert.ok(notifyAttention({ transition: t('sess-muted', 'i-muted'), onScreen: false }), 'unmuting restores pings');
  } finally {
    delete globalThis.localStorage;
  }
});

test('mute set round-trips through localStorage across a reload', async () => {
  const store = installFakeLocalStorage();
  try {
    const first = await loadFresh();
    first.muteSession('sess-a', true);
    first.muteSession('sess-b', true);
    assert.deepEqual(JSON.parse(store.get('code-conductor:muted-sessions')), ['sess-a', 'sess-b']);

    // Fresh module instance = a page reload: state starts empty until restored.
    const reloaded = await loadFresh();
    assert.equal(reloaded.isSessionMuted('sess-a'), false, 'starts empty before restore');
    reloaded.restoreMutedSessions();
    assert.equal(reloaded.isSessionMuted('sess-a'), true);
    assert.equal(reloaded.isSessionMuted('sess-b'), true);

    reloaded.muteSession('sess-a', false);
    assert.deepEqual(JSON.parse(store.get('code-conductor:muted-sessions')), ['sess-b']);
    reloaded.muteSession('sess-b', false);
    assert.equal(store.has('code-conductor:muted-sessions'), false, 'empty set clears the key');
  } finally {
    delete globalThis.localStorage;
  }
});

test('restoreMutedSessions: corrupt or absent storage leaves the set empty', async () => {
  installFakeLocalStorage({ 'code-conductor:muted-sessions': '{not json' });
  try {
    const mod = await loadFresh();
    mod.restoreMutedSessions();
    assert.equal(mod.NotificationState.mutedSessions.size, 0);
  } finally {
    delete globalThis.localStorage;
  }
});

test('fire: page-level fallback onclick dispatches cc-notification-click and closes the notification', async () => {
  const { fire } = await loadFresh();
  const { dispatched, isFocused } = installFakeNotificationGlobals();
  const data = { project: 'proj-a', instanceId: 'inst-1', sessionId: 'sess-1' };
  const n = fire({ title: 't', body: 'b', tag: 'session:inst-1', data });
  assert.ok(n, 'notification constructed');
  n.onclick();
  assert.equal(isFocused(), true, 'page focused on click');
  assert.equal(dispatched.length, 1);
  assert.equal(dispatched[0].type, 'cc-notification-click');
  assert.deepEqual(dispatched[0].detail, data);
  assert.equal(n.closed, true, 'notification closed after click');
});
