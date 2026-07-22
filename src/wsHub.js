// WebSocket hub. One /ws endpoint multiplexes subscriptions to many instances.
//
// Client → server:
//   { t: "subscribe",   id }
//   { t: "unsubscribe", id }
//   { t: "prompt",         id, text, attachments?: [{name, mediaType, dataBase64}] }
//   { t: "mode",           id, mode }
//   { t: "interrupt",      id }
//   { t: "kill",           id }
//   { t: "hook_decision",  id, toolUseId, allow }
//   { t: "auto_approve_plan", id, enabled }
//
// Server → client:
//   { t: "snapshot",       id, status, mode, sessionId, project, autoApprovePlan,
//                          events: [...],            // ring TAIL only (≤ ORCH_SNAPSHOT_TAIL, default 500)
//                          tailStartSeq, trimmedBefore, // >0 ⇒ older history exists; page it via
//                                                        // GET /api/instances/:id/events?before=<seq>
//                          droppedText? }            // present once on a fork's first snapshot ⇒ composer prefill
//   { t: "reset_snapshot", id, status, mode, sessionId, project, events: [...], droppedText? } // droppedText ⇒ rewind prefill
//   { t: "event",          id, ev }
//   { t: "status",         id, status, sessionId, mode, autoApprovePlan }
//   { t: "closed",         id, code, signal }
//   { t: "projects" }              // hint to re-fetch /api/projects
//   { t: "instances" }             // hint to re-fetch /api/instances
//   { t: "ack",            reqId, ok, error? }
//   { t: "error",          message }

import { WebSocket } from 'ws';
import { invalidateAll } from './projectsCache.js';

export function attachWsHub({ wss, instances }) {
  const subscribers = new Map(); // instanceId -> Set<ws>

  function subsFor(id) {
    let s = subscribers.get(id);
    if (!s) { s = new Set(); subscribers.set(id, s); }
    return s;
  }

  instances.on('event', ({ id, ev }) => {
    const subs = subscribers.get(id);
    if (subs) {
      const msg = JSON.stringify({ t: 'event', id, ev });
      for (const ws of subs) safeSend(ws, msg);
    }
    // Turn-end notifications go to every connected client (not just
    // subscribers), so users get pings for background instances they aren't
    // currently viewing in the foreground tab.
    //
    // ORDERING DEPENDENCY: the idle hub's 'event' listener (registered in
    // InstanceManager's constructor) always runs before this handler
    // (registered by attachWsHub in server.js). shouldSuppressTurnNotification
    // relies on IdleSubscriptionHub._justConsumed being populated by that
    // earlier listener. Do not reorder those registrations without revisiting
    // instances.shouldSuppressTurnNotification().
    if (ev?.kind === 'turn_end') {
      const inst = instances.get(id);
      // Suppress orchestration-internal notifications:
      //   - conductor finishing its own turn while waiting for a worker (isCaller)
      //   - worker whose turn_end just woke a subscribed conductor (wasConsumed)
      if (instances.shouldSuppressTurnNotification(id)) return;
      const note = JSON.stringify({
        t: 'turn_notification',
        id,
        project: inst?.project ?? null,
        isError: !!ev.isError,
        stopReason: ev.stopReason ?? null,
        cost: ev.costDelta ?? ev.cost ?? null,
      });
      broadcastAll(note);
    }
  });

  instances.on('status', (summary) => {
    const subs = subscribers.get(summary.id);
    const payload = JSON.stringify({
      t: 'status',
      id: summary.id,
      status: summary.status,
      sessionId: summary.sessionId,
      mode: summary.mode,
      autoApprovePlan: !!summary.autoApprovePlan,
      interrupting: !!summary.interrupting,
    });
    if (subs) for (const ws of subs) safeSend(ws, payload);
    broadcastAll(JSON.stringify({ t: 'instances' }));
    // Status flips (especially the post-turn transition back to `idle`)
    // mean the CLI has flushed its session jsonl to disk, so per-project
    // session summary numbers may have just changed. Nudge clients to
    // re-fetch /api/projects — otherwise the sidebar's `summary.count`
    // stays stale at the page-load value and a Sessions subnode can
    // vanish when the last live instance is removed.
    broadcastAll(JSON.stringify({ t: 'projects' }));
  });

  instances.on('list_changed', () => {
    // Instance spawn/exit changes sessionIds; clear all cached git facts so
    // the next /api/projects fetch reflects the new instance assignment. This
    // also covers worktree creation (which is tied to instance spawn).
    invalidateAll();
    broadcastAll(JSON.stringify({ t: 'instances' }));
    broadcastAll(JSON.stringify({ t: 'projects' }));
  });

  instances.on('subscription_changed', () => {
    broadcastAll(JSON.stringify({ t: 'instances' }));
  });

  // Rewind: server-side, the instance's ring buffer was just wiped and the
  // subprocess respawned against a truncated jsonl. Subscribers need to
  // drop their current conversation DOM before the replayed events from
  // the new spawn start landing — that's what `reset_snapshot` does. Same
  // shape as `snapshot` so the client can apply it through the same path.
  instances.on('snapshot_reset', (snap) => {
    const subs = subscribers.get(snap.id);
    if (!subs) return;
    const msg = JSON.stringify({ t: 'reset_snapshot', ...snap });
    for (const ws of subs) safeSend(ws, msg);
  });

  function broadcastAll(msg) {
    for (const ws of wss.clients) safeSend(ws, msg);
  }

  function safeSend(ws, msg) {
    if (ws.readyState === WebSocket.OPEN) {
      try { ws.send(msg); } catch { /* ignore */ }
    }
  }

  wss.on('connection', (ws) => {
    ws.on('message', async (raw) => {
      let msg;
      try { msg = JSON.parse(raw.toString()); }
      catch { safeSend(ws, JSON.stringify({ t: 'error', message: 'invalid json' })); return; }

      const reply = (ok, error) => safeSend(ws, JSON.stringify({ t: 'ack', reqId: msg.reqId ?? null, ok, error }));
      const inst = msg.id ? instances.get(msg.id) : null;

      try {
        switch (msg.t) {
          case 'subscribe': {
            if (!inst) { reply(false, 'unknown instance'); return; }
            subsFor(msg.id).add(ws);
            // Tail-only snapshot: at most ORCH_SNAPSHOT_TAIL (default 500)
            // trailing events, snapped to a turn boundary. tailStartSeq > 0
            // tells the client older history exists — it lazy-loads it via
            // GET /api/instances/:id/events?before=<seq>.
            const events = inst.snapshotTail();
            const tailStartSeq = events.length ? events[0]._seq : inst.ring.trimmedBefore;
            const tasksAtTailStart = inst.reconstructActiveTasks(tailStartSeq);
            // Re-attach the ephemeral thinking-token counter when a block is
            // still streaming (the per-token events aren't retained in the ring
            // — see EventLog.push). Appended LAST so the client applies it to
            // the reconstructed open thinking block; seq-less so it never enters
            // dedup/paging. tailStartSeq/tasks are computed from ring events above.
            if (inst.liveThinkingTokens != null) {
              events.push({ kind: 'system', subtype: 'thinking_tokens',
                data: { estimated_tokens: inst.liveThinkingTokens } });
            }
            // Fork prefill rides the new instance's first snapshot as
            // `droppedText` (consumed once — later subscribes get null),
            // the inline analogue of rewind's `reset_snapshot` droppedText.
            const droppedText = inst.consumePrefill();
            safeSend(ws, JSON.stringify({
              t: 'snapshot',
              id: inst.id,
              project: inst.project,
              status: inst.status,
              mode: inst.mode,
              sessionId: inst.sessionId,
              autoApprovePlan: !!inst.autoApprovePlan,
              interrupting: !!inst.interrupting,
              events,
              tailStartSeq,
              trimmedBefore: inst.ring.trimmedBefore,
              // In-flight task batch as of the tail start, so the client panel
              // reflects a batch whose TaskCreate is below the tail.
              tasksAtTailStart,
              ...(droppedText != null ? { droppedText } : {}),
            }));
            reply(true);
            return;
          }
          case 'unsubscribe': {
            if (msg.id) subscribers.get(msg.id)?.delete(ws);
            reply(true);
            return;
          }
          case 'prompt': {
            if (!inst) { reply(false, 'unknown instance'); return; }
            const atts = Array.isArray(msg.attachments)
              ? msg.attachments.filter(a =>
                  a && typeof a === 'object' &&
                  typeof a.name === 'string' &&
                  typeof a.dataBase64 === 'string' &&
                  typeof a.mediaType === 'string',
                )
              : [];
            await inst.prompt(String(msg.text ?? ''), atts);
            reply(true);
            return;
          }
          case 'mode': {
            if (!inst) { reply(false, 'unknown instance'); return; }
            await inst.setMode(String(msg.mode));
            reply(true);
            return;
          }
          case 'model': {
            if (!inst) { reply(false, 'unknown instance'); return; }
            await inst.setModel(String(msg.model), msg.backendKind);
            reply(true);
            return;
          }
          case 'interrupt': {
            if (!inst) { reply(false, 'unknown instance'); return; }
            await inst.interrupt({ force: !!msg.force });
            reply(true);
            return;
          }
          case 'kill': {
            if (!inst) { reply(false, 'unknown instance'); return; }
            await inst.kill();
            reply(true);
            return;
          }
          case 'auto_approve_plan': {
            if (!inst) { reply(false, 'unknown instance'); return; }
            inst.setAutoApprovePlan(!!msg.enabled);
            reply(true);
            return;
          }
          case 'hook_decision': {
            if (!inst) { reply(false, 'unknown instance'); return; }
            const toolUseId = msg.toolUseId;
            if (!toolUseId) { reply(false, 'missing toolUseId'); return; }
            const resolved = inst.resolveHookCallback(toolUseId, !!msg.allow);
            if (!resolved) { reply(false, 'no pending permission request for that toolUseId'); return; }
            reply(true);
            return;
          }
          default:
            reply(false, `unknown message type: ${msg.t}`);
        }
      } catch (e) {
        reply(false, e.message ?? 'error');
      }
    });

    ws.on('close', () => {
      for (const subs of subscribers.values()) subs.delete(ws);
    });

    safeSend(ws, JSON.stringify({ t: 'hello' }));
  });
}
