import { test } from 'node:test';
import assert from 'node:assert/strict';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const MODULE_PATH = path.resolve(__dirname, '..', 'public', 'notifications.js');
const { shouldNotify, summarizeOpenNotifications, resolveNotificationInstance } = await import(pathToFileURL(MODULE_PATH).href);
// Fresh module instance per test below, so mutating NotificationState (permission,
// globalEnabled) in one test can't leak into another.
const loadFresh = () => import(pathToFileURL(MODULE_PATH).href + `?t=${Math.random()}`);

test('shouldNotify: respects global toggle', () => {
  assert.equal(shouldNotify({ permission: 'granted', globalEnabled: false, mutedInstance: false, documentHidden: true, isError: false }), false);
});

test('shouldNotify: requires granted permission', () => {
  assert.equal(shouldNotify({ permission: 'denied', globalEnabled: true, mutedInstance: false, documentHidden: true, isError: false }), false);
  assert.equal(shouldNotify({ permission: 'default', globalEnabled: true, mutedInstance: false, documentHidden: true, isError: false }), false);
});

test('shouldNotify: muted instance suppresses', () => {
  assert.equal(shouldNotify({ permission: 'granted', globalEnabled: true, mutedInstance: true, documentHidden: true, isError: false }), false);
});

test('shouldNotify: only fires when tab is hidden (for non-error turns)', () => {
  assert.equal(shouldNotify({ permission: 'granted', globalEnabled: true, mutedInstance: false, documentHidden: false, isError: false }), false);
  assert.equal(shouldNotify({ permission: 'granted', globalEnabled: true, mutedInstance: false, documentHidden: true, isError: false }), true);
});

test('shouldNotify: errors notify even when tab is visible', () => {
  assert.equal(shouldNotify({ permission: 'granted', globalEnabled: true, mutedInstance: false, documentHidden: false, isError: true }), true);
});

test('summarizeOpenNotifications: empty tray → no summary', () => {
  assert.deepEqual(summarizeOpenNotifications([]), { shouldFire: false });
  assert.deepEqual(summarizeOpenNotifications(null), { shouldFire: false });
});

test('summarizeOpenNotifications: single instance → no summary', () => {
  const open = [{ tag: 'instance:a', data: { project: 'projA' } }];
  assert.deepEqual(summarizeOpenNotifications(open), { shouldFire: false });
});

test('summarizeOpenNotifications: two instances → summary with both projects', () => {
  const open = [
    { tag: 'instance:a', data: { project: 'projA' } },
    { tag: 'instance:b', data: { project: 'projB' } },
  ];
  const out = summarizeOpenNotifications(open);
  assert.equal(out.shouldFire, true);
  assert.equal(out.title, '2 turns complete');
  assert.equal(out.body, 'projA, projB');
});

test('summarizeOpenNotifications: dedupes project names and truncates with overflow', () => {
  const open = [
    { tag: 'instance:a', data: { project: 'projA' } },
    { tag: 'instance:b', data: { project: 'projB' } },
    { tag: 'instance:c', data: { project: 'projC' } },
    { tag: 'instance:d', data: { project: 'projD' } },
    { tag: 'instance:e', data: { project: 'projA' } }, // duplicate name, distinct instance
  ];
  const out = summarizeOpenNotifications(open);
  assert.equal(out.shouldFire, true);
  assert.equal(out.title, '5 turns complete');
  assert.equal(out.body, 'projA, projB, projC …+1 more');
});

test('summarizeOpenNotifications: ignores non-instance tags (cc-summary, foreign)', () => {
  const open = [
    { tag: 'instance:a', data: { project: 'projA' } },
    { tag: 'cc-summary' },
    { tag: 'instance:b', data: { project: 'projB' } },
    { tag: 'other:thing', data: { project: 'projZ' } },
  ];
  const out = summarizeOpenNotifications(open);
  assert.equal(out.shouldFire, true);
  assert.equal(out.title, '2 turns complete');
  assert.equal(out.body, 'projA, projB');
});

test('summarizeOpenNotifications: counts entries even when project data is missing', () => {
  const open = [
    { tag: 'instance:a' },
    { tag: 'instance:b', data: {} },
    { tag: 'instance:c', data: { project: 'projC' } },
  ];
  const out = summarizeOpenNotifications(open);
  assert.equal(out.shouldFire, true);
  assert.equal(out.title, '3 turns complete');
  assert.equal(out.body, 'projC');
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

// ── fire / maybeNotifyTurnEnd click wiring ──────────────────────────────────
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

test('maybeNotifyTurnEnd: fired notification data carries instanceId and sessionId', async () => {
  const { maybeNotifyTurnEnd, NotificationState } = await loadFresh();
  installFakeNotificationGlobals();
  NotificationState.globalEnabled = true;
  NotificationState.permission = 'granted';
  const result = maybeNotifyTurnEnd({
    instanceId: 'inst-1',
    projectName: 'proj-a',
    sessionId: 'sess-1',
    turnEvent: { isError: false, stopReason: 'end_turn', cost: null },
  });
  assert.ok(result, 'notification fired');
  assert.deepEqual(result.data, { project: 'proj-a', instanceId: 'inst-1', sessionId: 'sess-1' });
});

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
  const { maybeNotifyTurnEnd, muteSession, isSessionMuted, NotificationState } = mod;
  installFakeNotificationGlobals();
  installFakeLocalStorage();
  try {
    NotificationState.globalEnabled = true;
    NotificationState.permission = 'granted';
    muteSession('sess-muted', true);
    assert.equal(isSessionMuted('sess-muted'), true);
    assert.equal(isSessionMuted('sess-loud'), false);

    // shouldNotify's mutedInstance branch, fed from the real mute set.
    const base = { permission: 'granted', globalEnabled: true, documentHidden: true, isError: false };
    assert.equal(mod.shouldNotify({ ...base, mutedInstance: isSessionMuted('sess-muted') }), false);
    assert.equal(mod.shouldNotify({ ...base, mutedInstance: isSessionMuted('sess-loud') }), true);

    // …and end-to-end through the turn_end helper.
    const turnEvent = { isError: false, stopReason: 'end_turn', cost: null };
    assert.equal(
      maybeNotifyTurnEnd({ instanceId: 'i-muted', projectName: 'p', sessionId: 'sess-muted', turnEvent }),
      null, 'muted session fires nothing');
    assert.ok(
      maybeNotifyTurnEnd({ instanceId: 'i-loud', projectName: 'p', sessionId: 'sess-loud', turnEvent }),
      'unmuted sibling still notifies');

    // Respawn: same session, brand-new instance id — still muted.
    assert.equal(
      maybeNotifyTurnEnd({ instanceId: 'i-muted-respawned', projectName: 'p', sessionId: 'sess-muted', turnEvent }),
      null, 'mute survives a respawn under a new instance id');

    // Mute beats the isError override that otherwise notifies on a visible tab.
    assert.equal(
      maybeNotifyTurnEnd({ instanceId: 'i-muted', projectName: 'p', sessionId: 'sess-muted', turnEvent: { isError: true, stopReason: 'error', cost: null } }),
      null, 'muted session stays silent even on an errored turn');

    muteSession('sess-muted', false);
    assert.ok(maybeNotifyTurnEnd({ instanceId: 'i-muted', projectName: 'p', sessionId: 'sess-muted', turnEvent }), 'unmuting restores pings');
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
  const n = fire({ title: 't', body: 'b', tag: 'instance:inst-1', data });
  assert.ok(n, 'notification constructed');
  n.onclick();
  assert.equal(isFocused(), true, 'page focused on click');
  assert.equal(dispatched.length, 1);
  assert.equal(dispatched[0].type, 'cc-notification-click');
  assert.deepEqual(dispatched[0].detail, data);
  assert.equal(n.closed, true, 'notification closed after click');
});
