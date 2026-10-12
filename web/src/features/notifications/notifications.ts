// Browser notifications for a top-level session entering the needs-you strip's
// Waiting or Finished group (detection: lib/core/attention.js). The decision
// logic is pure and exported for tests; the Notification / Service Worker
// plumbing wraps it.
//
// Mobile Chrome only shows notifications through
// `ServiceWorkerRegistration.showNotification()` (page-level
// `new Notification()` throws there), so the SW is used first and the page
// constructor is the desktop fallback. Both click paths land on the
// controller's notification-click handling: the SW posts a
// `cc-notification-click` message, the page fallback dispatches the same-named
// window event.
import { askLabel } from '@/lib/core/needsYou.js';
import { createAttentionTracker } from '@/lib/core/attention.js';
import { createStore } from '@/state/createStore';
import { isSessionMuted } from './mutes';

export type Permission = NotificationPermission | 'unsupported';

export const notificationStore = createStore<{ permission: Permission; globalEnabled: boolean }>({
  permission: 'default',
  globalEnabled: false,
});

let swRegistration: ServiceWorkerRegistration | null = null;

export const NOTIFICATION_ICON = '/icon-192.png';
const SUMMARY_TAG = 'cc-summary';
const SUMMARY_PROJECT_LIMIT = 3;

/** Fire only with the bell on, permission granted, the session unmuted and not on screen. */
export function shouldNotify({ permission, globalEnabled, muted, onScreen }: { permission: Permission; globalEnabled: boolean; muted: boolean; onScreen: boolean }) {
  return !!globalEnabled && permission === 'granted' && !muted && !onScreen;
}

export function isNotificationAPIAvailable() {
  return typeof window !== 'undefined' && 'Notification' in window;
}

/**
 * Register the UI's own `sw.js` once, as `/sw.js` at scope `/`, so an installed
 * client updates that one registration in place. Done eagerly at
 * boot even without notification permission: Chrome only offers "Install app"
 * (a real PWA) once a service worker is active.
 */
export async function registerServiceWorker(): Promise<ServiceWorkerRegistration | null> {
  if (swRegistration) return swRegistration;
  if (typeof navigator === 'undefined' || !('serviceWorker' in navigator)) return null;
  try {
    const reg = await navigator.serviceWorker.register('/sw.js');
    await navigator.serviceWorker.ready;
    swRegistration = reg;
    return reg;
  } catch {
    return null;
  }
}

export async function ensurePermission(): Promise<Permission> {
  if (!isNotificationAPIAvailable()) return 'unsupported';
  const result = Notification.permission === 'granted' || Notification.permission === 'denied'
    ? Notification.permission
    : await Notification.requestPermission();
  notificationStore.set({ permission: result });
  if (result === 'granted') await registerServiceWorker();
  return result;
}

export function setGlobalEnabled(on: boolean) {
  notificationStore.set({ globalEnabled: !!on });
}

export type NotificationPayload = { title: string; body: string; tag: string; data: { project: string; instanceId: string; sessionId: string } };

export function fire({ title, body, tag, data }: NotificationPayload): unknown {
  if (!isNotificationAPIAvailable() || Notification.permission !== 'granted') return null;
  const opts: NotificationOptions = { body, tag, icon: NOTIFICATION_ICON, data };
  if (swRegistration) {
    try {
      void swRegistration.showNotification(title, opts);
      return true;
    } catch { /* fall through to the page-level constructor */ }
  }
  try {
    const n = new Notification(title, opts);
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

/** With two or more session pings open, one summary names how many and which projects. */
export function summarizeOpenNotifications(notifications: { tag?: string; data?: any }[] | null) {
  const ours = (notifications || []).filter((n) => typeof n?.tag === 'string' && n.tag.startsWith('session:'));
  if (ours.length < 2) return { shouldFire: false as const };
  const projects: string[] = [];
  const seen = new Set<string>();
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
  return { shouldFire: true as const, title: `${ours.length} sessions need you`, body };
}

async function getOpenNotifications() {
  if (!swRegistration) return null;
  try { return await swRegistration.getNotifications(); } catch { return null; }
}

export async function maybeUpdateSummary() {
  const reg = swRegistration;
  if (!reg) return;
  const open = await getOpenNotifications();
  if (open == null) return;
  const summary = summarizeOpenNotifications(open);
  if (summary.shouldFire) {
    try { void reg.showNotification(summary.title, { body: summary.body, tag: SUMMARY_TAG, icon: NOTIFICATION_ICON }); } catch { /* ignore */ }
  } else {
    for (const n of open) if (n.tag === SUMMARY_TAG) n.close();
  }
}

/** Coming back to the tab dismisses the pings it already answers. */
export async function closeAllOnFocus() {
  const open = await getOpenNotifications();
  if (open == null) return;
  for (const n of open) if (n.tag === SUMMARY_TAG || n.tag.startsWith('session:')) n.close();
}

export type AttentionTransition = {
  kind: 'waiting' | 'finished';
  sessionId: string;
  instanceId: string;
  entry: { conductor?: boolean; projectName?: string; worktreeName?: string | null; label?: string };
  ask?: string;
  source?: string;
  isError?: boolean;
};

/** The notification for one attention transition. */
export function attentionNotification(t: AttentionTransition): NotificationPayload {
  const where = t.entry.conductor ? 'Conductor' : `${t.entry.projectName}${t.entry.worktreeName ? ` · ${t.entry.worktreeName}` : ''}`;
  const title = t.kind === 'waiting'
    ? `❓ ${where} — waiting on you (${askLabel(t.ask, t.source)})`
    : t.isError ? `❌ ${where} — turn errored` : `✓ ${where} — finished`;
  return {
    title,
    body: t.entry.label ?? '',
    tag: `session:${t.sessionId}`,
    data: { project: where, instanceId: t.instanceId, sessionId: t.sessionId },
  };
}

/** Gate, fire and refresh the summary for one transition; null when suppressed. */
export function notifyAttention({ transition, onScreen }: { transition: AttentionTransition; onScreen: boolean }) {
  const { permission, globalEnabled } = notificationStore.get();
  if (!shouldNotify({ permission, globalEnabled, muted: isSessionMuted(transition.sessionId), onScreen })) return null;
  const result = fire(attentionNotification(transition));
  void maybeUpdateSummary();
  return result;
}

/**
 * Owns the attention tracker. A transition is consumed whether or not it
 * notifies, so one suppressed by focus, mute or the bell is never replayed.
 */
export function createAttentionNotifier({ isOnScreen }: { isOnScreen: (sessionId: string) => boolean }) {
  const tracker = createAttentionTracker();
  return {
    observe(instances: unknown[]) {
      for (const transition of tracker.observe(instances) as AttentionTransition[]) {
        notifyAttention({ transition, onScreen: isOnScreen(transition.sessionId) });
      }
    },
  };
}

/** Bell click: off when on; otherwise ask for permission and turn on when granted. */
export async function toggleNotifications() {
  if (!isNotificationAPIAvailable()) return;
  if (notificationStore.get().globalEnabled) { setGlobalEnabled(false); return; }
  const perm = await ensurePermission();
  if (perm === 'granted') setGlobalEnabled(true);
}

/** Boot: mirror the permission, auto-enable when already granted, register the SW. */
export function initNotifications() {
  const permission: Permission = isNotificationAPIAvailable() ? Notification.permission : 'unsupported';
  notificationStore.set({ permission });
  if (permission === 'granted') {
    setGlobalEnabled(true);
    ensurePermission().catch(() => {});
  } else {
    registerServiceWorker().catch(() => {});
  }
  document.addEventListener('visibilitychange', () => { if (!document.hidden) void closeAllOnFocus(); });
}

/** Test seam. */
export function __setSwRegistrationForTests(reg: ServiceWorkerRegistration | null) { swRegistration = reg; }
