// Browser notifications for a top-level session entering the needs-you strip's
// Waiting or Finished group (detection: public/attention.js).
//
// Uses the Notification API directly (works on Android Chrome / Termux
// browser when bound to localhost). The decision logic is split out as
// pure functions so it can be unit-tested without a real browser.

import { askLabel } from './needsYou.js';
import { createAttentionTracker } from './attention.js';
import { isActivePaneSeen } from './viewedMarker.js';

export const NotificationState = {
  permission: 'default',          // mirrors Notification.permission
  globalEnabled: false,           // user toggled the bell on
  // Per-session mute, keyed by sessionId rather than the per-process
  // instance id: a crash + resume mints a new instance id for the same
  // session, which would silently un-mute it.
  mutedSessions: new Set(),
  swRegistration: null,           // ServiceWorkerRegistration, once registered
};

/**
 * Pure decision: given current state, should we fire a notification?
 * `onScreen` is true when the user is looking at that session's pane.
 * Public so tests can exercise it directly.
 */
export function shouldNotify({ permission, globalEnabled, muted, onScreen }) {
  return !!globalEnabled && permission === 'granted' && !muted && !onScreen;
}

export function isNotificationAPIAvailable() {
  return typeof window !== 'undefined' && 'Notification' in window;
}

// Exported because Chrome only offers the "Install app" PWA flow once a
// Service Worker is active — registering eagerly on page boot (rather than
// waiting for the user to tap the 🔔 toggle) is what flips the menu entry
// from "Add to home screen" (bookmark) to "Install app" (full PWA).
// Idempotent: NotificationState.swRegistration is set once and reused.
export async function registerServiceWorker() {
  if (NotificationState.swRegistration) return NotificationState.swRegistration;
  if (typeof navigator === 'undefined' || !('serviceWorker' in navigator)) return null;
  try {
    const reg = await navigator.serviceWorker.register('/sw.js');
    // Wait for the SW to be ready so showNotification() works on first call.
    await navigator.serviceWorker.ready;
    NotificationState.swRegistration = reg;
    return reg;
  } catch {
    return null;
  }
}

export async function ensurePermission() {
  if (!isNotificationAPIAvailable()) return 'unsupported';
  let result;
  if (Notification.permission === 'granted' || Notification.permission === 'denied') {
    result = Notification.permission;
  } else {
    result = await Notification.requestPermission();
  }
  NotificationState.permission = result;
  // Pre-register the Service Worker as soon as we have permission. Mobile
  // Chrome only fires notifications via `registration.showNotification()`;
  // page-level `new Notification(...)` throws "Illegal constructor" there.
  if (result === 'granted') await registerServiceWorker();
  return result;
}

export function setGlobalEnabled(on) { NotificationState.globalEnabled = !!on; }

const MUTED_STORAGE_KEY = 'code-conductor:muted-sessions';
function safeStorage() {
  try { return typeof localStorage !== 'undefined' ? localStorage : null; }
  catch { return null; }
}
function saveMutedSessions() {
  const storage = safeStorage();
  if (!storage) return;
  try {
    if (NotificationState.mutedSessions.size === 0) storage.removeItem(MUTED_STORAGE_KEY);
    else storage.setItem(MUTED_STORAGE_KEY, JSON.stringify([...NotificationState.mutedSessions]));
  } catch { /* quota / disabled storage — mute is best-effort */ }
}

// Rehydrate the mute set from localStorage. Called once at app bootstrap;
// keyed by sessionId, so the restored entries stay meaningful even for
// sessions that have since been respawned under a new instance id.
export function restoreMutedSessions() {
  const storage = safeStorage();
  if (!storage) return;
  try {
    const raw = storage.getItem(MUTED_STORAGE_KEY);
    if (!raw) return;
    const arr = JSON.parse(raw);
    if (!Array.isArray(arr)) return;
    for (const id of arr) if (typeof id === 'string' && id) NotificationState.mutedSessions.add(id);
  } catch { /* corrupt or unreadable — start unmuted */ }
}

export function muteSession(sessionId, mute) {
  if (!sessionId) return;
  if (mute) NotificationState.mutedSessions.add(sessionId);
  else NotificationState.mutedSessions.delete(sessionId);
  saveMutedSessions();
}

export function isSessionMuted(sessionId) {
  return !!sessionId && NotificationState.mutedSessions.has(sessionId);
}

export function fire({ title, body, tag, data }) {
  if (!isNotificationAPIAvailable()) return null;
  if (Notification.permission !== 'granted') return null;
  const opts = { body, tag, icon: '/favicon.ico', data };
  // Mobile Chrome only allows notifications via the Service Worker
  // registration. Try that first; fall back to the page-level constructor
  // for desktop browsers where it still works.
  if (NotificationState.swRegistration) {
    try {
      NotificationState.swRegistration.showNotification(title, opts);
      return true;
    } catch { /* fall through to page-level */ }
  }
  try {
    const n = new Notification(title, opts);
    // The Service Worker's notificationclick handler covers the
    // showNotification path above; page-level notifications need their own
    // click wiring so both paths land on the same instance-selection logic
    // in wsRouter.js (via this shared custom event).
    n.onclick = () => {
      window.focus();
      window.dispatchEvent(new CustomEvent('cc-notification-click', { detail: data }));
      n.close();
    };
    return n;
  } catch {
    return null;
  }
}

const SUMMARY_TAG = 'cc-summary';
const SUMMARY_PROJECT_LIMIT = 3;

/**
 * Pure: given the current set of open notifications, decide whether a summary
 * should be visible and what it should say. Public for tests.
 */
export function summarizeOpenNotifications(notifications) {
  const ours = (notifications || []).filter(n => typeof n?.tag === 'string' && n.tag.startsWith('session:'));
  if (ours.length < 2) return { shouldFire: false };
  const projects = [];
  const seen = new Set();
  for (const n of ours) {
    const p = n?.data?.project;
    if (!p || seen.has(p)) continue;
    seen.add(p);
    projects.push(p);
  }
  const shown = projects.slice(0, SUMMARY_PROJECT_LIMIT);
  const overflow = projects.length - shown.length;
  let body = shown.join(', ');
  if (overflow > 0) body += ` …+${overflow} more`;
  return {
    shouldFire: true,
    title: `${ours.length} sessions need you`,
    body,
  };
}

async function getOpenNotifications() {
  const reg = NotificationState.swRegistration;
  if (!reg) return null;
  try { return await reg.getNotifications(); }
  catch { return null; }
}

export async function maybeUpdateSummary() {
  const reg = NotificationState.swRegistration;
  if (!reg) return;
  const open = await getOpenNotifications();
  if (open == null) return;
  const { shouldFire, title, body } = summarizeOpenNotifications(open);
  if (shouldFire) {
    try { reg.showNotification(title, { body, tag: SUMMARY_TAG, renotify: false, icon: '/favicon.ico' }); }
    catch { /* ignore */ }
  } else {
    for (const n of open) if (n.tag === SUMMARY_TAG) n.close();
  }
}

export async function closeAllOnFocus() {
  const open = await getOpenNotifications();
  if (open == null) return;
  for (const n of open) {
    if (n.tag === SUMMARY_TAG || (typeof n.tag === 'string' && n.tag.startsWith('session:'))) n.close();
  }
}

/**
 * Pure: the notification for one attention transition (public/attention.js).
 */
export function attentionNotification(t) {
  const where = t.entry.conductor
    ? 'Conductor'
    : `${t.entry.projectName}${t.entry.worktreeName ? ` · ${t.entry.worktreeName}` : ''}`;
  const title = t.kind === 'waiting'
    ? `❓ ${where} — waiting on you (${askLabel(t.ask, t.source)})`
    : t.isError ? `❌ ${where} — turn errored` : `✓ ${where} — finished`;
  return {
    title,
    body: t.entry.label,
    tag: `session:${t.sessionId}`,
    data: { project: where, instanceId: t.instanceId, sessionId: t.sessionId },
  };
}

/**
 * Gate, fire, and refresh the summary for one transition.
 * Returns the fire() result (null if suppressed).
 */
export function notifyAttention({ transition, onScreen }) {
  const decision = shouldNotify({
    permission: NotificationState.permission,
    globalEnabled: NotificationState.globalEnabled,
    muted: isSessionMuted(transition.sessionId),
    onScreen,
  });
  if (!decision) return null;
  const result = fire(attentionNotification(transition));
  // Best-effort summary refresh; failures here must not block the per-session ping.
  maybeUpdateSummary();
  return result;
}

/**
 * Owns the attention tracker. observe(instances) runs on every /api/instances
 * refresh. A transition is consumed whether or not it notifies, so a
 * suppressed one (focus, mute, bell off) is never replayed later.
 */
export function installAttentionNotifier({ getActiveInstance, doc = document, win = window }) {
  const tracker = createAttentionTracker();
  return {
    observe(instances) {
      for (const transition of tracker.observe(instances)) {
        const onScreen = isActivePaneSeen({ doc, win })
          && getActiveInstance()?.sessionId === transition.sessionId;
        notifyAttention({ transition, onScreen });
      }
    },
  };
}

/**
 * Pure: given a notification click's data payload, find the currently-live
 * instance it refers to. Prefers instanceId (stable within one process
 * lifetime); falls back to sessionId (survives a respawn under a new id).
 * Public so tests can exercise it without a real browser/SW.
 */
export function resolveNotificationInstance({ instanceId, sessionId } = {}, instances) {
  if (!instances) return null;
  if (instanceId) {
    const byId = instances.find(i => i.id === instanceId);
    if (byId) return byId;
  }
  if (sessionId) {
    const bySession = instances.find(i => i.sessionId === sessionId);
    if (bySession) return bySession;
  }
  return null;
}

// The 🔔/🔕 header toggle, the boot-time permission/Service-Worker bootstrap,
// and the focus listener that dismisses lingering OS notifications. Extracted
// from app.js — every symbol it touches already lives in this module.
//
// The SW is registered eagerly even WITHOUT notification permission: Chrome
// only surfaces the "Install app" PWA entry once an active SW is present, and
// without it the menu offers the weaker "Add to home screen" bookmark instead.
export function installNotifyToggle({ dom }) {
  function renderNotifyToggle() {
    const on = NotificationState.globalEnabled && NotificationState.permission === 'granted';
    dom.notifyToggle.textContent = on ? '🔔' : '🔕';
    dom.notifyToggle.setAttribute('aria-pressed', on ? 'true' : 'false');
    dom.notifyToggle.title = !isNotificationAPIAvailable()
      ? 'Notifications unsupported in this browser'
      : NotificationState.permission === 'denied'
        ? 'Notifications blocked — change in browser site settings'
        : on
          ? 'Notifications on — tap to mute'
          : 'Notifications off — tap to enable';
  }
  dom.notifyToggle.addEventListener('click', async () => {
    if (!isNotificationAPIAvailable()) { renderNotifyToggle(); return; }
    if (NotificationState.globalEnabled) {
      setGlobalEnabled(false);
      renderNotifyToggle();
      return;
    }
    const perm = await ensurePermission();
    if (perm === 'granted') setGlobalEnabled(true);
    renderNotifyToggle();
  });
  NotificationState.permission = isNotificationAPIAvailable() ? Notification.permission : 'unsupported';
  if (NotificationState.permission === 'granted') {
    // User previously granted permission. Auto-enable + register the SW so
    // notifications actually fire on mobile (which requires SW transport).
    setGlobalEnabled(true);
    ensurePermission().catch(() => {});
  } else {
    registerServiceWorker().catch(() => {});
  }
  renderNotifyToggle();
  document.addEventListener('visibilitychange', () => {
    if (!document.hidden) closeAllOnFocus();
  });
}
