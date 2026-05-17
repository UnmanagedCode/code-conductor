// Browser notifications for turn completion.
//
// Uses the Notification API directly (works on Android Chrome / Termux
// browser when bound to localhost). The decision logic is split out as
// pure functions so it can be unit-tested without a real browser.

export const NotificationState = {
  permission: 'default',          // mirrors Notification.permission
  globalEnabled: false,           // user toggled the bell on
  mutedInstances: new Set(),      // per-instance mute
  swRegistration: null,           // ServiceWorkerRegistration, once registered
};

/**
 * Pure decision: given current state, should we fire a notification?
 * Public so tests can exercise it directly.
 */
export function shouldNotify({ permission, globalEnabled, mutedInstance, documentHidden, isError }) {
  if (!globalEnabled) return false;
  if (permission !== 'granted') return false;
  if (mutedInstance) return false;
  // Always notify on errors, even if the tab is visible — they're rare and
  // important. Otherwise only notify when the user can't see the tab.
  if (isError) return true;
  return documentHidden;
}

export function isNotificationAPIAvailable() {
  return typeof window !== 'undefined' && 'Notification' in window;
}

async function ensureServiceWorker() {
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
  if (result === 'granted') await ensureServiceWorker();
  return result;
}

export function setGlobalEnabled(on) { NotificationState.globalEnabled = !!on; }
export function muteInstance(id, mute) {
  if (!id) return;
  if (mute) NotificationState.mutedInstances.add(id);
  else NotificationState.mutedInstances.delete(id);
}

export function fire({ title, body, tag }) {
  if (!isNotificationAPIAvailable()) return null;
  if (Notification.permission !== 'granted') return null;
  const opts = { body, tag, icon: '/favicon.ico' };
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
    return new Notification(title, opts);
  } catch {
    return null;
  }
}

/**
 * Decide-and-fire helper for a turn_end event.
 * Returns the Notification instance (or null if suppressed).
 */
export function maybeNotifyTurnEnd({ instanceId, projectName, turnEvent }) {
  const decision = shouldNotify({
    permission: NotificationState.permission,
    globalEnabled: NotificationState.globalEnabled,
    mutedInstance: NotificationState.mutedInstances.has(instanceId),
    documentHidden: typeof document !== 'undefined' ? document.hidden : false,
    isError: !!turnEvent.isError,
  });
  if (!decision) return null;
  const cost = turnEvent.cost != null ? ` · $${turnEvent.cost.toFixed(4)}` : '';
  const title = turnEvent.isError ? `❌ ${projectName} — turn errored` : `✓ ${projectName} — turn complete`;
  const body = `${turnEvent.stopReason ?? 'end_turn'}${cost}`;
  return fire({ title, body, tag: `instance:${instanceId}` });
}
