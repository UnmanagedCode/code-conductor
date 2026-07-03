// WS event router — the data/routing bus listeners that were the integration
// hub of app.js (slice 9). Wired LAST in app.js (right before connect()), so it
// is a pure leaf consumer: every dependency it needs is already constructed and
// injected, no holder/forward-ref required.
//
// Owns the nine routing/data handlers (snapshot, reset_snapshot, event,
// turn_notification, status, instances, projects, the window 'popstate', and
// the first-connect 'open' anchor-restore / auto-resume) plus the one-shot
// `firstConnect` flag they share.
//
// NOTE on registration order: app.js calls installRestart() BEFORE
// installWsRouter(), so restartFlow.js's 'open' listener (connection-status)
// registers before this module's 'open' listener (anchor restore) — preserving
// the original dispatch order for the two 'open' listeners. The other handlers
// each own a unique event type, so cross-type order is irrelevant.
//
// app.js stays the orchestrator: it constructs `state`, the trackers
// (getTracker/getUsage/globalRLTracker), conversation, headerHandle,
// lazyController, sessionActions, composer, sidebar, subagentPanel, the
// unread/queued-answer helpers (bumpUnread/flushPendingAnswers — kept there
// because they share module state with clearUnread/sendOrQueuePrompt), the
// REST refreshers, selectInstance, and setSidebarStatus — all injected here.
// `accountUsage` is NOT touched by any handler, so it stays wholly in app.js.

import { bus, send } from './ws.js';
import { maybeNotifyTurnEnd } from './notifications.js';
import { readSessionAnchor, writeSessionAnchor, consumeStashedAnchor } from './anchor.js';

export function installWsRouter({
  state,
  getTracker,
  getUsage,
  globalRLTracker,
  conversation,
  headerHandle,
  lazyController,
  sessionActions,
  composer,
  sidebar,
  subagentPanel,
  bumpUnread,
  flushPendingAnswers,
  refreshProjects,
  refreshInstances,
  selectInstance,
  setSidebarStatus,
}) {
  bus.addEventListener('snapshot', (e) => {
    const m = e.detail;
    // Rebuild task tracker from the snapshot for any instance we observe
    // — not just the active one — so the panel is correct the moment
    // the user flips to it. Same shape for the usage tracker so the
    // header chip lands populated when resuming a long historical session.
    // For the active instance, tracker and conversation are stepped together
    // so completed-batch records land inline at the right position.
    const tracker = getTracker(m.id);
    tracker.reset();
    // Seed the in-flight batch as of the tail start (server: tasksAtTailStart)
    // BEFORE replaying the tail, so a batch whose TaskCreate is below the tail
    // still drives the panel and completes correctly if it finishes in-tail.
    if (m.tasksAtTailStart?.length) tracker.seedActive(m.tasksAtTailStart);
    const usage = getUsage(m.id);
    usage.reset();
    // Rate limits are account-wide — do NOT reset globalRLTracker per snapshot,
    // and do NOT feed it from this replay loop either. A session's replayed
    // history is only time-ordered within that session, so a stale historical
    // rate_limit_event (e.g. from a long-idle session) would clobber a fresher
    // account-wide value already set by a live event or the periodic
    // /api/usage fetch. globalRLTracker is fed ONLY by the live 'event'
    // handler below and by refreshAccountUsage() in app.js.
    const isActive = m.id === state.activeId;
    if (isActive) conversation.clear();
    if (isActive) conversation._replayMode = true;
    for (const ev of m.events ?? []) {
      const prevCount = tracker.completedBatches.length;
      tracker.apply(ev);
      usage.apply(ev);
      if (isActive) {
        conversation.apply(ev);
        if (tracker.completedBatches.length > prevCount) {
          conversation.apply({ kind: 'task_completion',
            tasks: tracker.completedBatches[tracker.completedBatches.length - 1].tasks });
        }
      }
    }
    if (isActive) conversation._replayMode = false;
    // Mirror the server's auto-approve-plan flag into our local instance
    // entry so the header toggle reflects it correctly the moment a tab
    // subscribes (or re-subscribes after a session switch).
    const inst = state.instances.find(i => i.id === m.id);
    if (inst) {
      inst.autoApprovePlan = !!m.autoApprovePlan;
      inst.interrupting = !!m.interrupting;
    }
    if (!isActive) return;
    headerHandle.update();
    // Tail-only snapshot: arm the scroll-up lazy-load when older history
    // exists below the rendered tail.
    lazyController.init(m);
    // Fork case: the newly-spawned instance's first snapshot is our cue to
    // prefill the composer with the dropped user prompt. (Rewind goes
    // through reset_snapshot below instead.) The fork-prefill state is owned
    // by sessionActions; consumePendingPrefill returns { text } (possibly '')
    // on a match for this instance, or null otherwise — clears on read.
    const pf = sessionActions.consumePendingPrefill(m.id);
    if (pf) composer.prefill(pf.text);
  });

  // Server-issued reset: the active instance's ring buffer was just wiped by
  // a rewind, and the replayed events from the truncated jsonl will start
  // landing through normal `event` frames immediately after. Mirror the
  // snapshot handler but treat the incoming events as initial state rather
  // than a merge. Also consume any pending composer prefill stashed by
  // rewindActiveSession — by now the subprocess is back to spawning, the
  // user can see the cleared view, and the prompt slides back in.
  bus.addEventListener('reset_snapshot', (e) => {
    const m = e.detail;
    const tracker = getTracker(m.id);
    tracker.reset();
    const usage = getUsage(m.id);
    usage.reset();
    // Rate limits are account-wide — do NOT reset globalRLTracker on rewind,
    // and (same reasoning as the snapshot handler above) do NOT feed it from
    // this replay loop either; it stays fed only by live events + the
    // periodic /api/usage fetch.
    const isActive = m.id === state.activeId;
    if (isActive) { conversation.reset(); lazyController.reset(); }
    if (isActive) conversation._replayMode = true;
    for (const ev of m.events ?? []) {
      const prevCount = tracker.completedBatches.length;
      tracker.apply(ev);
      usage.apply(ev);
      if (isActive) {
        conversation.apply(ev);
        if (tracker.completedBatches.length > prevCount) {
          conversation.apply({ kind: 'task_completion',
            tasks: tracker.completedBatches[tracker.completedBatches.length - 1].tasks });
        }
      }
    }
    if (isActive) conversation._replayMode = false;
    if (!isActive) return;
    headerHandle.update();
    // Rewind carries the dropped prompt directly on the frame so the
    // composer is prefilled regardless of when the rewind HTTP response
    // returns. Fork still uses the legacy pendingPrefill handshake — its
    // prefill lands on the *new* instance's first `snapshot` frame, not
    // here.
    if (typeof m.droppedText === 'string') {
      composer.prefill(m.droppedText);
    }
  });

  bus.addEventListener('event', (e) => {
    const m = e.detail;
    const tracker = getTracker(m.id);
    const prevCount = tracker.completedBatches.length;
    tracker.apply(m.ev);
    getUsage(m.id).apply(m.ev);
    globalRLTracker.apply(m.ev);
    if (m.id !== state.activeId) return;
    conversation.apply(m.ev);
    // When the tracker records a newly-completed batch, append a permanent
    // snapshot block into the conversation at this exact chronological point.
    if (tracker.completedBatches.length > prevCount) {
      conversation.apply({ kind: 'task_completion',
        tasks: tracker.completedBatches[tracker.completedBatches.length - 1].tasks });
    }
    // Refresh the header chip whenever data that affects it lands. init
    // sets the model, message_start gives a live mid-turn context-size
    // update (each agent-loop step fires its own with cumulative counts),
    // turn_end finalizes both current + cumulative totals.
    // rate_limit_event updates the left-side rate-limit chip independently.
    if (m.ev?.kind === 'turn_end'
        || m.ev?.kind === 'message_start'
        || (m.ev?.kind === 'system' && m.ev?.subtype === 'init')
        || (m.ev?.kind === 'system' && m.ev?.subtype === 'rate_limit_event')) {
      headerHandle.update();
    }
  });

  bus.addEventListener('turn_notification', (e) => {
    const m = e.detail;
    maybeNotifyTurnEnd({
      instanceId: m.id,
      projectName: m.project ?? 'instance',
      turnEvent: { isError: m.isError, stopReason: m.stopReason, cost: m.cost },
    });
    // Mark the session unread in the sidebar — unless the user is already
    // looking at it, in which case the activity is by definition seen.
    if (m.id !== state.activeId) {
      const inst = state.instances.find(i => i.id === m.id);
      bumpUnread(inst?.sessionId);
    }
  });

  bus.addEventListener('status', (e) => {
    const m = e.detail;
    const inst = state.instances.find(i => i.id === m.id);
    if (inst) {
      inst.status = m.status;
      inst.mode = m.mode;
      inst.sessionId = m.sessionId;
      if (typeof m.autoApprovePlan === 'boolean') inst.autoApprovePlan = m.autoApprovePlan;
      inst.interrupting = !!m.interrupting;
      sidebar.setInstances(state.instances);
      subagentPanel.setInstances(state.instances, state.activeId);
      if (m.id === state.activeId) headerHandle.update();
    }
    // Now that this instance is idle again, drain any queued user-question
    // answers that came in while a turn was running.
    if (m.status === 'idle') flushPendingAnswers(m.id);
  });

  bus.addEventListener('instances', () => { refreshInstances(); });
  bus.addEventListener('projects', () => { refreshProjects(); });

  // Handle browser back/forward button. Fires when the user pops a history
  // entry created by pushSessionAnchor (e.g. going back from a sub-agent to
  // the conductor session that opened it).
  window.addEventListener('popstate', () => {
    // Settings/commits/review have their own handlers; don't interfere when
    // the user navigates forward back into one of those views.
    if (location.hash === '#settings') return;
    if (location.hash === '#commits' || location.hash === '#review') return;
    const anchor = readSessionAnchor();
    const live = anchor ? state.instances.find(i => i.sessionId === anchor) : null;
    const targetId = live?.id ?? null;
    if (targetId !== state.activeId) selectInstance(targetId);
  });

  let firstConnect = true;
  bus.addEventListener('open', async () => {
    await refreshProjects();
    await refreshInstances();
    // On the first WS open after page load, try to restore the session named
    // in the URL hash so a refresh keeps the user on the same conversation.
    // Guarded by firstConnect so a mid-session reconnect doesn't snap focus
    // back if the user has since navigated elsewhere or closed the instance.
    if (firstConnect) {
      firstConnect = false;
      if (!state.activeId && location.hash !== '#settings') {
        // Prefer the URL hash; fall back to the stashed anchor that an
        // external-link click squirreled away in localStorage right before we
        // handed off to Chrome. Covers cold-relaunches where Android reaped the
        // PWA process while it was backgrounded and start_url ('/') doesn't
        // carry the previous hash.
        const anchor = readSessionAnchor() || consumeStashedAnchor();
        if (anchor) {
          const live = state.instances.find(i => i.sessionId === anchor);
          if (live) {
            selectInstance(live.id);
            return;
          }
          // No live instance owns this anchor — locate the session on disk
          // and auto-resume it. Covers refreshes after a server restart (all
          // instances gone) and refreshes after the user killed the instance
          // but is still anchored to the same conversation. A --resume spawn
          // costs zero API tokens (the model isn't called until the user
          // sends a prompt), so this is always free except for the
          // subprocess itself.
          try {
            const r = await fetch(`/api/sessions/${encodeURIComponent(anchor)}/locate`);
            if (r.ok) {
              const { project, worktreeName } = await r.json();
              setSidebarStatus('resuming session…', { warn: true });
              try {
                await sessionActions.resumeSession({ projectName: project, worktreeName, sessionId: anchor });
              } finally { setSidebarStatus(''); }
              return;
            }
            // 404 / other — session jsonl no longer on disk. Clear the stale
            // anchor so a follow-up refresh doesn't re-attempt and let the
            // user fall through to the empty placeholder.
            writeSessionAnchor(null);
          } catch (e) {
            console.warn('auto-resume from anchor failed', e);
            writeSessionAnchor(null);
          }
        }
      }
    }
    if (state.activeId && state.instances.some(i => i.id === state.activeId)) {
      send('subscribe', { id: state.activeId });
    }
  });
}
