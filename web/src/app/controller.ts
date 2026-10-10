// The app's data spine: REST refreshers, session selection, the WebSocket
// router (snapshot / reset_snapshot / segment / event / status / instances /
// projects) and the first-connect anchor restore. UI features subscribe to the
// stores and to app events; nothing here touches the DOM beyond the URL hash.
import { bus, connect, send } from '@/lib/core/ws.js';
import { latestOnly } from '@/lib/core/latestOnly.js';
import { readSessionAnchor, writeSessionAnchor, pushSessionAnchor, consumeStashedAnchor } from '@/lib/core/anchor.js';
import { appStore, activeInstance, type AppState } from '@/state/app';
import { syncRoute, routeStore } from '@/state/route';
import type { Instance, UiEvent } from '@/state/types';
import { ConversationModel } from '@/conversation/model';
import { createLazyHistory } from '@/conversation/lazyHistory';
import { createStickyPrompt } from '@/conversation/stickyPrompt';
import { getTaskTracker, getUsageTracker, rateLimits, trackerSignal } from './trackers';
import { emit } from './events';
import { closeSidebarOnMobile } from './ui';
import { resumeSession } from './sessionActions';

export { send };

export const conversation = new ConversationModel({
  onAssistantText: (node) => emit('assistantText', { text: node.buffer, nodeId: node.id }),
});

export const lazyHistory = createLazyHistory({ model: conversation, getActiveId: () => appStore.get().activeId });

export const stickyPrompt = createStickyPrompt({
  isConducted: () => !!activeInstance(appStore.get())?.conducted,
  getActiveId: () => appStore.get().activeId,
  history: lazyHistory,
  isHistoryReady: () => lazyHistory.isReady(),
});

// ── REST refreshers ──────────────────────────────────────────────────────

export async function refreshProjects() {
  const [projects, workspaces, conductSessions, conductorSpawns] = await Promise.all([
    fetch('/api/projects').then((r) => r.json()),
    fetch('/api/workspaces').then((r) => r.json()).catch(() => []),
    fetch('/api/projects/.conduct/sessions').then((r) => (r.ok ? r.json() : [])).catch(() => []),
    fetch('/api/conductors/projects').then((r) => (r.ok ? r.json() : {})).catch(() => ({})),
  ]);
  appStore.set({
    projects: Array.isArray(projects) ? projects : [],
    workspaces: Array.isArray(workspaces) ? workspaces.map((w: { name?: string }) => w.name).filter(Boolean) as string[] : [],
    conductSessions: Array.isArray(conductSessions) ? conductSessions : [],
    conductorSpawns: conductorSpawns && typeof conductorSpawns === 'object' ? (conductorSpawns as AppState['conductorSpawns']) : {},
  });
}

const instancesGuard = latestOnly();
export async function refreshInstances() {
  await instancesGuard(
    () => fetch('/api/instances').then((r) => r.json()),
    (data: Instance[]) => {
      appStore.set({ instances: Array.isArray(data) ? data : [] });
      emit('instances');
    },
  );
}

function patchInstance(id: string, patch: Partial<Instance>) {
  const { instances } = appStore.get();
  const i = instances.findIndex((x) => x.id === id);
  if (i < 0) return;
  const next = instances.slice();
  next[i] = { ...instances[i], ...patch };
  appStore.set({ instances: next });
}

// ── Selection ────────────────────────────────────────────────────────────

export type SelectOptions = { push?: boolean; userGesture?: boolean };

export function selectInstance(id: string | null, opts: SelectOptions = {}) {
  const prev = appStore.get().activeId;
  if (prev && prev !== id) send('unsubscribe', { id: prev });
  appStore.set({ activeId: id });
  conversation.clear();
  lazyHistory.reset();
  const inst = id ? appStore.get().instances.find((i) => i.id === id) ?? null : null;
  emit('select', { id, sessionId: inst?.sessionId ?? null, userGesture: !!opts.userGesture });
  if (id) send('subscribe', { id });
  // The hash carries the sessionId (stable across crash / resume), not the instance id.
  if (opts.push) pushSessionAnchor(inst?.sessionId || null);
  else writeSessionAnchor(inst?.sessionId || null);
  syncRoute();
  closeSidebarOnMobile();
}

/** Select a live instance owning `sessionId`, or locate it on disk and resume it. */
export async function resumeSessionByAnchor(anchor: string, { clearAnchorOnMiss = true, userGesture = false } = {}): Promise<boolean> {
  const live = appStore.get().instances.find((i) => i.sessionId === anchor);
  if (live) {
    selectInstance(live.id, { userGesture });
    return true;
  }
  try {
    const r = await fetch(`/api/sessions/${encodeURIComponent(anchor)}/locate`);
    if (r.ok) {
      const { project, worktreeName, archived } = await r.json();
      // An archived session is never resurrected silently from a link.
      if (archived) {
        if (clearAnchorOnMiss) { writeSessionAnchor(null); syncRoute(); }
        return true;
      }
      appStore.set({ sidebarStatus: { text: 'Resuming session…', warn: true } });
      try {
        await resumeSession({ projectName: project, worktreeName, sessionId: anchor, silent: true, userGesture });
      } finally {
        appStore.set({ sidebarStatus: null });
      }
      return true;
    }
    if (clearAnchorOnMiss) { writeSessionAnchor(null); syncRoute(); }
    return false;
  } catch (e) {
    console.warn('auto-resume from anchor failed', e);
    if (clearAnchorOnMiss) { writeSessionAnchor(null); syncRoute(); }
    return false;
  }
}

/** A notification click names an instance and/or a session; land on whichever still exists. */
export async function handleNotificationClick(data: { instanceId?: string; sessionId?: string } | null) {
  if (!data) return;
  const { instances } = appStore.get();
  const target = (data.instanceId && instances.find((i) => i.id === data.instanceId))
    || (data.sessionId && instances.find((i) => i.sessionId === data.sessionId))
    || null;
  if (target) {
    selectInstance(target.id, { userGesture: true });
    return;
  }
  if (data.sessionId) await resumeSessionByAnchor(data.sessionId, { clearAnchorOnMiss: false, userGesture: true });
}

// ── Event replay ─────────────────────────────────────────────────────────

function replay(m: { id: string; events?: UiEvent[] }, isActive: boolean) {
  const tracker = getTaskTracker(m.id);
  const usage = getUsageTracker(m.id);
  const run = () => {
    for (const ev of m.events ?? []) {
      const prev = tracker.completedBatches.length;
      tracker.apply(ev);
      usage.apply(ev);
      if (isActive) {
        conversation.apply(ev);
        if (tracker.completedBatches.length > prev) {
          conversation.apply({ kind: 'task_completion', tasks: tracker.completedBatches[tracker.completedBatches.length - 1].tasks });
        }
      }
    }
  };
  if (isActive) conversation.batch(run);
  else run();
  trackerSignal.bump();
}

// Event kinds that move the header (model, context %, rate limits).
const HEADER_EVENTS = new Set(['turn_end', 'message_start', 'context_usage']);
const HEADER_SYSTEM = new Set(['init', 'model_changed', 'rate_limit_event']);

let lifetime: AbortController | null = null;

/** Remove every listener startController installed (tests; a hot reload). */
export function stopController() {
  lifetime?.abort();
  lifetime = null;
}

export function startController() {
  if (lifetime) return;
  lifetime = new AbortController();
  const { signal } = lifetime;
  const listen = (t: string, fn: (e: Event) => void) => bus.addEventListener(t, fn, { signal });

  listen('snapshot', (e: Event) => {
    const m = (e as CustomEvent).detail;
    const tracker = getTaskTracker(m.id);
    tracker.reset();
    if (m.tasksAtTailStart?.length) tracker.seedActive(m.tasksAtTailStart);
    const usage = getUsageTracker(m.id);
    usage.reset();
    if (m.lastContextUsage) usage.seedContext(m.lastContextUsage);
    const isActive = m.id === appStore.get().activeId;
    if (isActive) {
      conversation.clear();
      conversation.setCurrentSegment(m.currentSegmentId ?? null);
      conversation.segmentId = m.tailSegmentId ?? null;
    }
    replay(m, isActive);
    patchInstance(m.id, {
      autoApprovePlan: !!m.autoApprovePlan,
      ...(typeof m.playbookEnforcement === 'string' ? { playbookEnforcement: m.playbookEnforcement } : {}),
      interrupting: !!m.interrupting,
    });
    if (!isActive) return;
    lazyHistory.init(m);
    if (typeof m.droppedText === 'string') emit('prefill', { text: m.droppedText });
  });

  listen('reset_snapshot', (e: Event) => {
    const m = (e as CustomEvent).detail;
    getTaskTracker(m.id).reset();
    getUsageTracker(m.id).reset();
    const isActive = m.id === appStore.get().activeId;
    if (isActive) {
      conversation.clear();
      lazyHistory.reset();
    }
    replay(m, isActive);
    if (isActive && typeof m.droppedText === 'string') emit('prefill', { text: m.droppedText });
  });

  listen('segment', (e: Event) => {
    const m = (e as CustomEvent).detail;
    if (m.id !== appStore.get().activeId) return;
    conversation.segmentId = m.currentSegmentId ?? null;
    conversation.setCurrentSegment(m.currentSegmentId ?? null);
  });

  listen('event', (e: Event) => {
    const m = (e as CustomEvent).detail;
    const tracker = getTaskTracker(m.id);
    const prev = tracker.completedBatches.length;
    tracker.apply(m.ev);
    getUsageTracker(m.id).apply(m.ev);
    rateLimits.apply(m.ev);
    const k = m.ev?.kind;
    if (HEADER_EVENTS.has(k) || (k === 'system' && HEADER_SYSTEM.has(m.ev?.subtype))) trackerSignal.bump();
    if (m.id !== appStore.get().activeId) return;
    conversation.apply(m.ev);
    if (tracker.completedBatches.length > prev) {
      conversation.apply({ kind: 'task_completion', tasks: tracker.completedBatches[tracker.completedBatches.length - 1].tasks });
    }
  });

  listen('status', (e: Event) => {
    const m = (e as CustomEvent).detail;
    patchInstance(m.id, {
      status: m.status,
      mode: m.mode,
      model: m.model,
      sessionId: m.sessionId,
      ...(typeof m.autoApprovePlan === 'boolean' ? { autoApprovePlan: m.autoApprovePlan } : {}),
      ...(typeof m.playbookEnforcement === 'string' ? { playbookEnforcement: m.playbookEnforcement } : {}),
      interrupting: !!m.interrupting,
      modelSwitch: m.modelSwitch ?? null,
      modelSwitchFailure: m.modelSwitchFailure ?? null,
    });
  });

  listen('instances', () => { void refreshInstances(); });
  listen('projects', () => { void refreshProjects(); });

  listen('close', () => {
    appStore.set({ connection: 'reconnecting', everDropped: true });
  });

  // Back / forward between session anchors (e.g. back from a worker to its conductor).
  addEventListener('popstate', () => {
    if (routeStore.get().route.view !== 'session') return;
    const anchor = readSessionAnchor();
    const live = anchor ? appStore.get().instances.find((i) => i.sessionId === anchor) : null;
    const target = live?.id ?? null;
    if (target !== appStore.get().activeId) selectInstance(target);
  }, { signal });

  if (typeof navigator !== 'undefined' && navigator.serviceWorker) {
    navigator.serviceWorker.addEventListener('message', (event) => {
      if (event.data?.type === 'cc-notification-click') void handleNotificationClick(event.data);
    }, { signal });
  }
  addEventListener('cc-notification-click', (event) => void handleNotificationClick((event as CustomEvent).detail), { signal });

  let firstConnect = true;
  listen('open', async () => {
    appStore.set({ connection: 'open' });
    await refreshProjects();
    await refreshInstances();
    if (firstConnect) {
      firstConnect = false;
      if (!appStore.get().activeId && routeStore.get().route.view === 'session') {
        const anchor = readSessionAnchor() || consumeStashedAnchor();
        if (anchor && (await resumeSessionByAnchor(anchor))) return;
      }
    }
    const { activeId, instances } = appStore.get();
    if (activeId && instances.some((i) => i.id === activeId)) send('subscribe', { id: activeId });
  });

  connect();
}

export function getActiveInstance() {
  return activeInstance(appStore.get());
}
