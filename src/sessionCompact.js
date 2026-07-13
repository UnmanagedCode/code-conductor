// Managed self-compaction — the `compact_session` MCP tool. An agent calls
// `compact_session` on its OWN session with a self-authored handoff summary;
// code-conductor then drives a server-side `/clear` on that session at the
// caller's next turn_end. `/clear` rotates the CLI's sessionId to a fresh UUID
// IN PLACE (same OS process/pid, non-destructive to the old jsonl), clearing
// the accumulated conversation. The freshly-cleared session is then seeded with
// the summary as its first user turn, so work continues from a compact context.
//
// Keyed by instanceId (NOT sessionId): the whole point is that the sessionId
// rotates mid-operation, so only the stable instanceId (the `byId` key, which
// `/clear` leaves untouched) can track the caller across the rotation. The
// sessionId-keyed side structures (idle-subscription graph, overage timers) are
// migrated separately via manager.rekeySession() at the moment of rotation.
//
// One pending compaction per instance. State machine, driven by the manager's
// `event` stream (turn_end only):
//   armed    → the caller's turn_end (the turn the tool was called in): drive
//              `/clear`, remember the pre-clear sessionId.            → clearing
//   clearing → a turn_end where inst.sessionId has rotated off the pre-clear id
//              (i.e. `/clear`'s own turn_end, after its system/init): migrate
//              side structures, inject the seed, finish. A turn_end that has NOT
//              rotated (e.g. a user turn the CLI had queued mid-turn and ran
//              before `/clear` took effect) is ignored, so an intervening turn
//              can never make us reseed into the wrong session.

// Defensive ceiling: if `/clear` never rotates the session (the real CLI always
// does — this only guards a wedged/hung subprocess), abandon the pending
// compaction rather than leaving the instance stuck in `clearing` forever.
const CLEAR_ROTATE_TIMEOUT_MS = Number(process.env.ORCH_COMPACT_CLEAR_TIMEOUT_MS) || 60_000;

// Compose the first-turn seed for the cleared session. Extensibility seam: phase
// 1 uses only `summary`. Later phases fill `rolePreamble` (conductor-role/system
// instructions injected on resume) and `replayPrompt` (replay the last user turn
// into the fresh session) — both compose here so the injection path never
// changes. Callers pass the whole opts object through arm().
export function buildCompactSeed({ summary, rolePreamble = null, replayPrompt = null } = {}) {
  const parts = [];
  if (rolePreamble && String(rolePreamble).trim()) parts.push(String(rolePreamble).trim());
  parts.push(
    'Your context was just compacted (cleared) at your own request via '
    + 'compact_session. Everything below is the handoff summary you wrote for '
    + 'yourself before the clear — treat it as your working memory and continue '
    + 'from it.\n\n--- HANDOFF SUMMARY ---\n' + String(summary ?? '').trim(),
  );
  if (replayPrompt && String(replayPrompt).trim()) {
    parts.push('--- REPLAYED REQUEST ---\n' + String(replayPrompt).trim());
  }
  return parts.join('\n\n');
}

export class SessionCompactController {
  constructor(manager) {
    this.manager = manager;
    // instanceId → { state:'armed'|'clearing', opts, oldSid, timerId }
    this.pending = new Map();
  }

  // Arm (or re-arm) a compaction for an instance. Idempotent: re-arming while
  // already pending just refreshes opts (a second compact_session call in the
  // same turn), it never starts a second `/clear`.
  arm(instanceId, opts = {}) {
    const existing = this.pending.get(instanceId);
    if (existing) { existing.opts = opts; return { armed: true, rearmed: true }; }
    this.pending.set(instanceId, { state: 'armed', opts, oldSid: null, timerId: null });
    return { armed: true, rearmed: false };
  }

  onEvent({ id, ev }) {
    if (ev?.kind !== 'turn_end') return;
    const p = this.pending.get(id);
    if (!p) return;
    if (p.state === 'armed') this._onArmedTurnEnd(id, p);
    else if (p.state === 'clearing') this._onClearingTurnEnd(id, p);
  }

  _onArmedTurnEnd(id, p) {
    const inst = this.manager.byId.get(id);
    if (!inst || !inst.proc) { this._clear(id); return; }
    // Defer while there is queued or background work the rotation would strand.
    // An overage-queued user turn (server-visible _overageQueue, surfaced as
    // queuedCount) is parked waiting for the rate-limit window to reset —
    // clearing now would both lose it and reseed against a still-throttled
    // account; wait for it to drain. Likewise defer past live subagents / an
    // owed re-invocation. Stay armed: a later turn_end (once the queue drains /
    // subagents finish) fires the compaction. Mirrors the idle hub's defer gate.
    if (inst._overageQueue?.length > 0
        || inst.activeAgentTaskCount > 0 || inst.taskNotificationPending) {
      return;
    }
    p.oldSid = inst.sessionId;
    p.state = 'clearing';
    p.timerId = setTimeout(() => {
      if (this.pending.get(id) === p) this._clear(id);
    }, CLEAR_ROTATE_TIMEOUT_MS);
    p.timerId.unref?.();
    try { inst.clearContext(); }
    catch { this._clear(id); }
  }

  _onClearingTurnEnd(id, p) {
    const inst = this.manager.byId.get(id);
    if (!inst || !inst.proc) { this._clear(id); return; }
    // Only `/clear`'s own turn_end rotates the sessionId. Ignore any intervening
    // turn_end that has NOT rotated (a mid-turn-queued user turn the CLI ran
    // before `/clear` took effect) — reseeding then would land in the old id.
    if (!inst.sessionId || inst.sessionId === p.oldSid) return;
    const newSid = inst.sessionId;
    // Migrate sessionId-keyed side structures so nothing is orphaned across the
    // rotation (idle subscriptions, overage timers). The Instance itself already
    // followed the rotation via system/init.
    try { this.manager.rekeySession(p.oldSid, newSid); } catch { /* best effort */ }
    const seed = buildCompactSeed(p.opts);
    this._clear(id); // one-shot: settle state BEFORE the reseed turn opens
    // Seed the cleared session as its first user turn. internal:true so it does
    // not trip the overage resume-cancel path (the send itself is not throttled).
    inst.prompt(seed, [], { internal: true }).catch(() => {});
  }

  _clear(id) {
    const p = this.pending.get(id);
    if (p?.timerId) clearTimeout(p.timerId);
    this.pending.delete(id);
  }

  // Drop a pending compaction (called on instance removal).
  purge(instanceId) { this._clear(instanceId); }
}
