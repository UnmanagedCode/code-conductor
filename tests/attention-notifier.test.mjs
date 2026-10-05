// installAttentionNotifier (public/notifications.js): the focus rule, mute, the
// bell, and the fired payload, driven through the real tracker over successive
// instance lists. happy-dom window for the hash, a fake document for
// visibility, a fake Service Worker registration recording showNotification.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { Window } from 'happy-dom';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
let counter = 0;
const pub = (f) => pathToFileURL(path.resolve(__dirname, '..', 'public', f)).href;

const inst = (sid, o = {}) => ({
  id: `i-${sid}`, project: 'proj', sessionId: sid, status: 'turn', conducted: false, ownerSessionId: null,
  createdAt: 1000, liveAsks: 0, liveTurnEnds: 0, lastTurnError: false, awaitingUser: null, awaitingUserSource: null, ...o,
});
const done = (sid, o = {}) => inst(sid, { status: 'idle', liveTurnEnds: 1, ...o });

async function rig({ hash = '#session=s1', visible = true, activeSid = 's1', bell = true } = {}) {
  const window = new Window({ url: `http://localhost/${hash}` });
  globalThis.window = window;
  globalThis.Notification = class { static permission = 'granted'; };
  window.Notification = globalThis.Notification;
  const { registerMainView } = await import(pub('mainViews.js'));
  registerMainView({ matches: (h) => h === '#settings', isOpen: () => false, supersede: () => {} });
  const mod = await import(`${pub('notifications.js')}?t=${++counter}`);
  const shown = [];
  mod.NotificationState.swRegistration = {
    showNotification: (title, opts) => { shown.push({ title, ...opts }); },
    getNotifications: async () => [],
  };
  mod.NotificationState.permission = 'granted';
  mod.NotificationState.globalEnabled = bell;
  const doc = new EventTarget();
  doc.visibilityState = visible ? 'visible' : 'hidden';
  const state = { activeSid };
  const notifier = mod.installAttentionNotifier({
    getActiveInstance: () => (state.activeSid ? { sessionId: state.activeSid } : null),
    doc, win: window,
  });
  return { mod, shown, state, notifier };
}

// Notifications whose title is not the summary's.
const pings = (shown) => shown.filter(n => n.tag !== 'cc-summary');

test('a visible tab with that session active suppresses', async () => {
  const { notifier, shown } = await rig();
  notifier.observe([inst('s1')]);
  notifier.observe([done('s1')]);
  assert.deepEqual(pings(shown), []);
});

test('a visible tab with a different session active notifies', async () => {
  const { notifier, shown } = await rig({ activeSid: 's2' });
  notifier.observe([inst('s1')]);
  notifier.observe([done('s1')]);
  assert.equal(pings(shown).length, 1);
});

test('a hidden tab notifies even with the same session active', async () => {
  const { notifier, shown } = await rig({ visible: false });
  notifier.observe([inst('s1')]);
  notifier.observe([done('s1')]);
  assert.equal(pings(shown).length, 1);
});

test('a visible tab on a full-page view notifies even with the same session active', async () => {
  const { notifier, shown } = await rig({ hash: '#settings' });
  notifier.observe([inst('s1')]);
  notifier.observe([done('s1')]);
  assert.equal(pings(shown).length, 1);
});

test('an errored finish on the on-screen session is suppressed too: errors have no override', async () => {
  const { notifier, shown } = await rig();
  notifier.observe([inst('s1')]);
  notifier.observe([done('s1', { lastTurnError: true })]);
  assert.deepEqual(pings(shown), []);
});

test('a suppressed transition is consumed: switching away and re-observing emits nothing', async () => {
  const { notifier, shown, state } = await rig();
  notifier.observe([inst('s1')]);
  notifier.observe([done('s1')]);
  state.activeSid = 's2';
  notifier.observe([done('s1')]);
  assert.deepEqual(pings(shown), []);
});

test('mute silences one session while an unmuted sibling notifies', async () => {
  const { mod, notifier, shown } = await rig({ activeSid: null });
  mod.NotificationState.mutedSessions.add('s1');
  notifier.observe([inst('s1'), inst('s2')]);
  notifier.observe([done('s1'), done('s2')]);
  assert.deepEqual(pings(shown).map(n => n.tag), ['session:s2']);
});

test('bell off fires nothing, and turning it on afterwards does not flush the earlier transition', async () => {
  const { mod, notifier, shown } = await rig({ activeSid: null, bell: false });
  notifier.observe([inst('s1')]);
  notifier.observe([done('s1')]);
  assert.deepEqual(pings(shown), []);
  mod.NotificationState.globalEnabled = true;
  notifier.observe([done('s1')]);
  assert.deepEqual(pings(shown), []);
});

test('the fired notification carries the per-session tag and the click data', async () => {
  const { notifier, shown } = await rig({ activeSid: null });
  notifier.observe([inst('s1')]);
  notifier.observe([done('s1')]);
  const [n] = pings(shown);
  assert.equal(n.tag, 'session:s1');
  assert.deepEqual(n.data, { project: 'proj', instanceId: 'i-s1', sessionId: 's1' });
  assert.equal(n.title, '✓ proj — finished');
});

test('a live ask notifies as waiting with the ask wording', async () => {
  const { notifier, shown } = await rig({ activeSid: null });
  notifier.observe([inst('s1')]);
  notifier.observe([done('s1', { liveAsks: 1, awaitingUser: 'plan', awaitingUserSource: 'tool' })]);
  assert.deepEqual(pings(shown).map(n => n.title), ['❓ proj — waiting on you (plan approval)']);
});
