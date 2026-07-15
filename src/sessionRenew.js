// Managed session renewal — the `renew_session` MCP tool. An agent calls
// `renew_session` on its OWN session with a self-authored handoff summary;
// code-conductor then drives a server-side `/clear` on that session at the
// caller's next turn_end. `/clear` rotates the CLI's sessionId to a fresh UUID
// IN PLACE (same OS process/pid, non-destructive to the old jsonl), clearing
// the accumulated conversation (a compaction primitive under the hood). The
// freshly-cleared session is then seeded with the summary — plus a
// server-generated mechanical state block, see buildStateBlock() below — as
// its first user turn, so work continues from a compact context.
//
// Keyed by instanceId (NOT sessionId): the whole point is that the sessionId
// rotates mid-operation, so only the stable instanceId (the `byId` key, which
// `/clear` leaves untouched) can track the caller across the rotation. The
// other internal side structures (idle-subscription graph, overage timers) are
// likewise instanceId-keyed, so the rotation needs no migration at all.
//
// One pending renewal per instance. State machine, driven by the manager's
// `event` stream (turn_end only):
//   armed    → the caller's turn_end (the turn the tool was called in): drive
//              `/clear`, remember the pre-clear sessionId.            → clearing
//   clearing → a turn_end where inst.sessionId has rotated off the pre-clear id
//              (i.e. `/clear`'s own turn_end, after its system/init): inject the
//              seed and finish. A turn_end that has NOT
//              rotated (e.g. a user turn the CLI had queued mid-turn and ran
//              before `/clear` took effect) is ignored, so an intervening turn
//              can never make us reseed into the wrong session.

// Defensive ceiling: if `/clear` never rotates the session (the real CLI always
// does — this only guards a wedged/hung subprocess), abandon the pending
// renewal rather than leaving the instance stuck in `clearing` forever.
const CLEAR_ROTATE_TIMEOUT_MS = Number(process.env.ORCH_RENEW_CLEAR_TIMEOUT_MS) || 60_000;

// Compose the first-turn seed for the cleared session. Extensibility seam: phase
// 1 uses only `summary`. Later phases fill `rolePreamble` (conductor-role/system
// instructions injected on resume) and `replayPrompt` (replay the last user turn
// into the fresh session) — both compose here so the injection path never
// changes. `stateBlock` (the mechanical state block, built fresh at reseed time
// — see buildStateBlock()) is the newest seam member. Callers pass the whole
// opts object through arm().
export function buildRenewSeed({ summary, rolePreamble = null, replayPrompt = null, stateBlock = null } = {}) {
  const parts = [];
  if (rolePreamble && String(rolePreamble).trim()) parts.push(String(rolePreamble).trim());
  parts.push(
    'Your context was just renewed (cleared) at your own request via '
    + 'renew_session. Everything below is the handoff summary you wrote for '
    + 'yourself before the clear — treat it as your working memory and continue '
    + 'from it.\n\n--- HANDOFF SUMMARY ---\n' + String(summary ?? '').trim(),
  );
  if (replayPrompt && String(replayPrompt).trim()) {
    parts.push('--- REPLAYED REQUEST ---\n' + String(replayPrompt).trim());
  }
  if (stateBlock && String(stateBlock).trim()) {
    parts.push(String(stateBlock).trim());
  }
  return parts.join('\n\n');
}

// The server-generated mechanical state block — a safety net for a degraded or
// incomplete self-authored summary. Enumerates, from live manager state, every
// instance the caller spawned (Instance.callerInstanceId, the same tracking
// `conductedWorkersOf`/the sub-agent panel use) that is still live, plus the
// caller's own pending idle subscriptions. If the summary's roster and this
// block disagree, this block wins for EXISTENCE (a worker it lists is really
// still live) while the summary wins for INTENT (task, state, next action) —
// so a worker the summary omitted is never silently orphaned.
export function buildStateBlock(manager, callerInstanceId) {
  const workers = manager.liveOwnedBy(callerInstanceId);
  const subs = manager.idleSubscriptionsOf(callerInstanceId);
  const lines = [
    '--- MECHANICAL STATE (server-generated at renewal; safety net — if this '
    + 'disagrees with your summary above, this list wins for EXISTENCE, the '
    + 'summary wins for INTENT) ---',
    'Live instances you spawned:',
  ];
  lines.push(workers.length
    ? workers.map((w) => `  - sessionId=${w.sessionId} project=${w.project} `
        + `worktree=${w.worktree ?? '(none)'} status=${w.status}`).join('\n')
    : '  (none)');
  lines.push('Your pending idle subscriptions (workers you are watching for idle):');
  lines.push(subs.length ? subs.map((s) => `  - ${s}`).join('\n') : '  (none)');
  return lines.join('\n');
}

export class SessionRenewController {
  constructor(manager) {
    this.manager = manager;
    // instanceId → { state:'armed'|'clearing', opts, oldSid, timerId }
    this.pending = new Map();
  }

  // Arm (or re-arm) a renewal for an instance. Idempotent: re-arming while
  // already pending just refreshes opts (a second renew_session call in the
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
    // subagents finish) fires the renewal. Mirrors the idle hub's defer gate.
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
    // No side-structure migration is needed across the rotation: the
    // idle-subscription graph and overage timers are keyed by the stable
    // instanceId, which `/clear` preserves. The Instance itself already followed
    // the sessionId rotation via its system/init handler.
    // The mechanical state block is built HERE — at reseed time, not arm time —
    // since live instances/subscriptions can change in the window between the
    // tool call and the actual clear firing.
    const stateBlock = buildStateBlock(this.manager, id);
    const seed = buildRenewSeed({ ...p.opts, stateBlock });
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

  // Drop a pending renewal (called on instance removal).
  purge(instanceId) { this._clear(instanceId); }
}
