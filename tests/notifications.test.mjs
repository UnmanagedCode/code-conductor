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
