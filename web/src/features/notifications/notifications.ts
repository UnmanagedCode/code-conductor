// Browser notifications for a top-level session entering the needs-you strip's
// Waiting or Finished group (detection: shared/attention.ts). The decision
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
import { CONDUCTOR_LABEL } from '@shared/conductors';
import { askLabel } from '@shared/needsYou';
import { createAttentionTracker, type AttentionInstance } from '@shared/attention';
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
  const reg = swRegistration;
  if (reg) {
    enqueueSw('show a ping', () => reg.showNotification(title, opts));
    return true;
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

type ShowOptions = NotificationOptions & { renotify?: boolean };

/**
 * Every service-worker notification call runs through this chain, so a close
 * can never overtake the show it targets. A failed step warns and the chain
 * goes on.
 */
let swQueue: Promise<void> = Promise.resolve();
function enqueueSw(what: string, step: () => Promise<unknown>) {
  swQueue = swQueue.then(step).then(() => {}, (err) => { console.warn(`notifications: could not ${what}`, err); });
}

/** Resolves once every queued service-worker call has run. Test seam. */
export function __notificationsSettledForTests() { return swQueue; }

/** The summary's wording for the sessions it names (`where` of each ping). */
export function summaryText(names: readonly string[]) {
  const projects = [...new Set(names.filter(Boolean))];
  const shown = projects.slice(0, SUMMARY_PROJECT_LIMIT);
  const overflow = projects.length - shown.length;
  let body = shown.join(', ');
  if (overflow > 0) body += ` …+${overflow} more`;
  return { title: `${names.length} sessions need you`, body };
}

export type SummaryAction =
  | { kind: 'close' }
  | { kind: 'none' }
  | { kind: 'alert'; title: string; body: string }
  | { kind: 'refresh'; title: string; body: string };

/**
 * What the summary notification does when the announced set moves from `prev`
 * (the set the last decision saw) to `next` (sessionId → where): alert when a
 * session joined, refresh quietly when it only shrank, close below two.
 */
export function summaryAction(prev: ReadonlySet<string>, next: ReadonlyMap<string, string>): SummaryAction {
  if (next.size < 2) return { kind: 'close' };
  const text = summaryText([...next.values()]);
  for (const sid of next.keys()) if (!prev.has(sid)) return { kind: 'alert', ...text };
  return next.size < prev.size ? { kind: 'refresh', ...text } : { kind: 'none' };
}

async function openByTag(reg: ServiceWorkerRegistration, tag: string) {
  return reg.getNotifications({ tag });
}

/** Close one session's ping. SW path only. */
function closePing(sessionId: string) {
  const reg = swRegistration;
  if (!reg) return;
  enqueueSw('close a ping', async () => { for (const n of await openByTag(reg, `session:${sessionId}`)) n.close(); });
}

/** Apply the summary decision to the tray. SW path only. */
function applySummary(action: SummaryAction) {
  const reg = swRegistration;
  if (!reg || action.kind === 'none') return;
  if (action.kind === 'close') {
    enqueueSw('close the summary', async () => { for (const n of await openByTag(reg, SUMMARY_TAG)) n.close(); });
    return;
  }
  const { title, body } = action;
  if (action.kind === 'alert') {
    const opts: ShowOptions = { body, tag: SUMMARY_TAG, icon: NOTIFICATION_ICON, renotify: true };
    enqueueSw('show the summary', () => reg.showNotification(title, opts));
    return;
  }
  // A shrink updates an open summary in place, silently; a dismissed one stays dismissed.
  enqueueSw('refresh the summary', async () => {
    if ((await openByTag(reg, SUMMARY_TAG)).length === 0) return;
    const opts: ShowOptions = { body, tag: SUMMARY_TAG, icon: NOTIFICATION_ICON, silent: true };
    await reg.showNotification(title, opts);
  });
}

/** Coming back to the tab dismisses the pings it already answers. Queued behind any pending show. */
export function closeAllOnFocus() {
  const reg = swRegistration;
  if (!reg) return swQueue;
  enqueueSw('close the pings on focus', async () => {
    for (const n of await reg.getNotifications()) if (n.tag === SUMMARY_TAG || n.tag.startsWith('session:')) n.close();
  });
  return swQueue;
}

export type AttentionTransition = {
  kind: 'waiting' | 'finished';
  sessionId: string;
  instanceId: string;
  entry: { conductor?: boolean; projectName?: string; worktreeName?: string | null; label?: string };
  ask?: string | null;
  source?: string | null;
  isError?: boolean;
};

/** The notification for one attention transition. */
export function attentionNotification(t: AttentionTransition): NotificationPayload {
  const where = t.entry.conductor ? CONDUCTOR_LABEL : `${t.entry.projectName}${t.entry.worktreeName ? ` · ${t.entry.worktreeName}` : ''}`;
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

/** Gate and fire one transition; null when suppressed. */
export function notifyAttention({ transition, onScreen }: { transition: AttentionTransition; onScreen: boolean }) {
  const { permission, globalEnabled } = notificationStore.get();
  if (!shouldNotify({ permission, globalEnabled, muted: isSessionMuted(transition.sessionId), onScreen })) return null;
  return fire(attentionNotification(transition));
}

/**
 * Owns the attention tracker and the summary's set: the sessions this tab
 * pinged that are still in the strip's Waiting or Finished group. A
 * transition is consumed whether or not it notifies, so one suppressed by
 * focus, mute or the bell is never replayed.
 */
export function createAttentionNotifier({ isOnScreen }: { isOnScreen: (sessionId: string) => boolean }) {
  const tracker = createAttentionTracker();
  const announced = new Map<string, string>(); // sessionId → where
  let named = new Set<string>(); // the set the summary decision last saw
  return {
    observe(instances: readonly AttentionInstance[]) {
      for (const transition of tracker.observe(instances)) {
        const payload = attentionNotification(transition);
        if (notifyAttention({ transition, onScreen: isOnScreen(transition.sessionId) }) != null) {
          announced.set(transition.sessionId, payload.data.project);
        }
      }
      const needs = tracker.needsYou();
      for (const sid of [...announced.keys()]) {
        if (needs.has(sid)) continue;
        announced.delete(sid);
        closePing(sid);
      }
      applySummary(summaryAction(named, announced));
      named = new Set(announced.keys());
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
