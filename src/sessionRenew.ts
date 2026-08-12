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
// `event` stream:
//   requested → a CONDUCTOR asked this worker to renew itself (the targeted
//              `renew_session` form). Holds the conductor's `followUp` for
//              exactly one turn: the worker's own renew_session self-call
//              consumes it (arm() folds the followUp in), and the worker's
//              turn_end expires it — which IS the decline signal, reported to
//              the waiting conductor via noteRenewalDeclined.  → armed | gone
//   armed    → the caller's turn_end (the turn the tool was called in): drive
//              `/clear`, remember the pre-clear sessionId.            → clearing
//   clearing → a turn_end where inst.backingSessionId has rotated off the pre-clear id
//              (i.e. `/clear`'s own turn_end, after its system/init): inject the
//              seed and finish. A turn_end that has NOT
//              rotated (e.g. a user turn the CLI had queued mid-turn and ran
//              before `/clear` took effect) is ignored, so an intervening turn
//              can never make us reseed into the wrong session.

import type { InstanceLike, InstanceManagerLike } from './instanceTypes.ts';

// Defensive ceiling: if `/clear` never rotates the session (the real CLI always
// does — this only guards a wedged/hung subprocess), abandon the pending
// renewal rather than leaving the instance stuck in `clearing` forever.
const CLEAR_ROTATE_TIMEOUT_MS = Number(process.env.ORCH_RENEW_CLEAR_TIMEOUT_MS) || 60_000;

export interface RenewalOpts {
  summary?: string;
  // The conductor's POST-renewal directive, carried by a `requested` entry and
  // folded in by arm() when the worker self-calls. Fenced into the seed under its
  // own marker, distinct from the summary section: the summary is the worker's
  // memory, this is the conductor's next task.
  followUp?: string | null;
  stateBlock?: string | null;
}

interface PendingRenewal {
  state: 'requested' | 'armed' | 'clearing';
  opts: RenewalOpts;
  // `requested` only: the sessionId of the conductor that asked. The decline is
  // reported to THAT conductor and no other — with two conductors watching one
  // worker, a target-keyed note would reach whichever woke first, which for the
  // one that never asked is a report about a request it did not make.
  requestedBy: string | null;
  oldSid: string | null;
  timerId: NodeJS.Timeout | null;
}

// The manager's event stream entry for this instance (instances.ts calls
// _sessionRenew.onEvent({ id, ev }) on every instance event).
interface ManagerEvent {
  id: string;
  ev: { kind?: string; subtype?: string } | null;
}

// The summary structure the worker is asked for. ONE home, two consumers: the
// `summary` argument description in src/mcp/tools.ts (a worker renewing on its
// own initiative reads it there) and buildRenewRequest below (a worker answering
// a conductor's request reads it in the prompt).
export const RENEW_SUMMARY_TEMPLATE =
  'Structure it in three sections: '
  + '(1) Live work roster — per still-running worker: sessionId, project/worktree, task, state, '
  + 'agreed sentinel, next action. '
  + '(2) Completed work index — one line per landed job: outcome + pointers to where details live '
  + '(merge sha, worktree name, worker sessionId — transcripts and diffs remain recoverable from '
  + 'these). '
  + '(3) User context — stated preferences, decisions made, pending promises. '
  + 'Write it as a note to your future self: everything not captured here is lost when the context '
  + 'clears.';

// The turn-A prompt for a conductor-REQUESTED renewal. The conductor triggers and
// guides; the worker authors and may refuse — so this asks, states the decline
// path, and carries the conductor's pre-directive under its own fence.
export function buildRenewRequest({ directive }: { directive?: string | null } = {}): string {
  const parts = [
    'Your conductor is asking you to renew your context now (renew_session).',
    'DECLINE if you are mid-operation or holding state only you can land — an unfinished rebase, '
    + 'uncommitted work, a running check whose result nobody else has. Say so and end this turn '
    + 'WITHOUT calling renew_session; nothing is cleared.',
    'Otherwise write your handoff summary, call renew_session({summary}) with it, and do nothing '
    + 'else this turn.',
  ];
  if (directive && String(directive).trim()) {
    parts.push('--- YOUR CONDUCTOR\'S DIRECTIVE FOR THIS SUMMARY ---\n' + String(directive).trim());
  }
  parts.push(RENEW_SUMMARY_TEMPLATE);
  return parts.join('\n\n');
}

// Compose the first-turn seed for the cleared session. Three sections, each in
// its own fence so the worker can tell them apart: the summary it wrote for
// itself, then — when a conductor requested this renewal with a `followUp` — that
// post-renewal directive, then `stateBlock` (the mechanical state block, built
// fresh at reseed time — see buildStateBlock()). Callers pass the whole opts
// object through arm().
export function buildRenewSeed({ summary, followUp = null, stateBlock = null }: RenewalOpts = {}): string {
  const parts: string[] = [];
  parts.push(
    'Your context was just renewed (cleared) at your own request via '
    + 'renew_session. The section below is the handoff summary you wrote for '
    + 'yourself before the clear — treat it as your working memory and continue '
    + 'from it.\n\n--- HANDOFF SUMMARY ---\n' + String(summary ?? '').trim(),
  );
  if (followUp && String(followUp).trim()) {
    parts.push('--- YOUR CONDUCTOR\'S FOLLOW-UP DIRECTIVE ---\n' + String(followUp).trim());
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
export function buildStateBlock(manager: InstanceManagerLike, callerInstanceId: string): string {
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
  private readonly manager: InstanceManagerLike;
  // instanceId → { state:'requested'|'armed'|'clearing', opts, oldSid, timerId }
  private readonly pending = new Map<string, PendingRenewal>();

  constructor(manager: InstanceManagerLike) {
    this.manager = manager;
  }

  // Register a conductor's REQUEST that this worker renew itself. Deliberately
  // does NOT open the rotation window (beginRotation/beginRenewal stay in arm()):
  // a request may be declined, and with the window closed that decline rides the
  // worker's ordinary, undeferred turn_end back to the waiting conductor.
  //
  // Overwrites an existing request (the same idempotency arm() has for a second
  // call in one turn) but never an armed/clearing renewal — the MCP handler's
  // renewalPending interlock makes that unreachable, and this asserts it by
  // leaving the live renewal alone rather than clobbering it.
  request(instanceId: string, { followUp = null, requestedBy = null }: { followUp?: string | null; requestedBy?: string | null } = {}): { requested: boolean; rerequested: boolean } {
    const existing = this.pending.get(instanceId);
    if (existing && existing.state !== 'requested') return { requested: false, rerequested: false };
    this.pending.set(instanceId, {
      state: 'requested', opts: { followUp }, requestedBy, oldSid: null, timerId: null,
    });
    return { requested: true, rerequested: !!existing };
  }

  // Drop an unconsumed request WITHOUT recording a decline: used when the prompt
  // that would have carried the request never went out, so the caller already has
  // the error in hand and there is nothing to report on a later wake.
  dropRequest(instanceId: string): void {
    if (this.pending.get(instanceId)?.state === 'requested') this.pending.delete(instanceId);
  }

  // Arm (or re-arm) a renewal for an instance. Idempotent: re-arming while
  // already pending just refreshes opts (a second renew_session call in the
  // same turn), it never starts a second `/clear`.
  arm(instanceId: string, opts: RenewalOpts = {}): { armed: true; rearmed: boolean } {
    // Open the rotation window HERE — mid-turn, when the tool is called — not at
    // the clear. The idle hub's listener runs before this controller's, so a
    // window opened any later would already have let the ARMED turn_end consume a
    // waiting conductor's one-shot a turn early. beginRotation is idempotent for
    // the same mechanism, so a re-arm does not restart it.
    const armed = this.manager.byId.get(instanceId);
    armed?.beginRotation('renew');
    // The WIDER window, held until the reseed lands. beginRotation's closes at the
    // `/clear`'s turn_end so the idle hub can deliver; this one has to outlive that,
    // or a prune/rewind slipping into the gap makes the reseed 409 and the handoff
    // summary is lost. See Instance._renewing.
    armed?.beginRenewal();
    const existing = this.pending.get(instanceId);
    if (existing) {
      // The conductor's followUp is carried onto the refreshed opts: it belongs to
      // the conductor, so a second self-call refining the summary must not drop it.
      existing.opts = { ...opts, followUp: opts.followUp ?? existing.opts.followUp ?? null };
      // Consuming a pending REQUEST is the transition this whole path exists for,
      // not a re-arm — nothing was armed before it. (A `clearing` entry keeps its
      // state: the machine is already past the point a re-arm could change.)
      if (existing.state === 'requested') { existing.state = 'armed'; return { armed: true, rearmed: false }; }
      return { armed: true, rearmed: true };
    }
    this.pending.set(instanceId, { state: 'armed', opts, requestedBy: null, oldSid: null, timerId: null });
    return { armed: true, rearmed: false };
  }

  onEvent({ id, ev }: ManagerEvent): void {
    // The SECOND fire trigger for an armed renewal, mirroring the idle hub's
    // task-drain path exactly (IdleSubscriptionHub._onTaskEvent): the defer gate
    // below only re-fires on a turn_end, so a background task finishing while the
    // worker is ALREADY idle — with no re-invocation turn ever coming — would
    // strand the armed renewal until the rotate watchdog, and a conductor waiting
    // on it would be told a healthy worker "did NOT finish".
    //
    // Exactly these two subtypes, NOT "any event while idle": arming happens
    // mid-turn in production, but tests arm out-of-band while the worker is idle
    // and then drive the turn_end with send_prompt — a broader trigger would
    // `/clear` before that prompt and break the go1 < /clear < seed ordering.
    // No settle window either: the hub's exists to avoid waking one turn EARLY,
    // while the only risk here is a re-invocation turn opening concurrently, in
    // which case the CLI processes the queued `/clear` after it and `clearing`
    // still reseeds correctly — later than ideal, never wrong.
    if (ev?.kind === 'system' && (ev.subtype === 'task_updated' || ev.subtype === 'task_notification')) {
      const p = this.pending.get(id);
      if (p?.state === 'armed') this._onArmedDrain(id, p);
      return;
    }
    if (ev?.kind !== 'turn_end') return;
    const p = this.pending.get(id);
    if (!p) return;
    // A request lives exactly one turn. Expiry is SYNCHRONOUS inside this
    // dispatch so the decline note is recorded before the idle hub's already-
    // queued delivery microtask reads it — see noteRenewalDeclined.
    if (p.state === 'requested') this._expireRequest(id, p);
    else if (p.state === 'armed') this._onArmedTurnEnd(id, p);
    // Async since the reseed now waits on the durable lineage write. Deliberately
    // not awaited: onEvent is driven from the manager's synchronous event stream.
    // It handles its own failures (see the renew_error emissions), so the catch is
    // only a backstop against an unhandled rejection.
    else if (p.state === 'clearing') void this._onClearingTurnEnd(id, p).catch(() => {});
  }

  // The worker ended the turn the request opened without calling renew_session.
  // That IS the decline — it may be mid-rebase or holding uncommitted state, and
  // only it knows "not now" is the right answer — so drop the request and tell the
  // hub, which reports it on the conductor's wake.
  private _expireRequest(id: string, p: PendingRenewal): void {
    this.pending.delete(id);
    this.manager.noteRenewalDeclined(id, p.requestedBy);
  }

  private _onArmedTurnEnd(id: string, p: PendingRenewal): void {
    const inst = this.manager.byId.get(id);
    if (!inst || !inst.proc) { this._clear(id); return; }
    // Stay armed while there is queued or background work the rotation would
    // strand: a later turn_end (or the drain trigger above) fires the renewal.
    if (this._deferred(inst)) return;
    this._fireClear(id, p, inst);
  }

  // A terminal task event on an armed instance. Fires only from the fully-drained
  // IDLE state — the case no turn_end will ever follow.
  private _onArmedDrain(id: string, p: PendingRenewal): void {
    const inst = this.manager.byId.get(id);
    if (!inst || !inst.proc) return;
    if (inst.status !== 'idle' || this._deferred(inst)) return;
    this._fireClear(id, p, inst);
  }

  // Defer while there is queued or background work the rotation would strand. An
  // overage-queued user turn (server-visible _overageQueue, surfaced as
  // queuedCount) is parked waiting for the rate-limit window to reset — clearing
  // now would both lose it and reseed against a still-throttled account; wait for
  // it to drain. Likewise defer past live subagents / an owed re-invocation.
  // Mirrors the idle hub's defer gate.
  private _deferred(inst: InstanceLike): boolean {
    return (inst._overageQueue?.length ?? 0) > 0
      || inst.activeAgentTaskCount > 0 || inst.taskNotificationPending;
  }

  // Send the `/clear` and move to `clearing`. ONE implementation, two triggers
  // (the armed turn_end and the drained-idle task event).
  private _fireClear(id: string, p: PendingRenewal, inst: InstanceLike): void {
    p.oldSid = inst.backingSessionId;
    p.state = 'clearing';
    p.timerId = setTimeout(() => {
      if (this.pending.get(id) === p) this._clear(id);
    }, CLEAR_ROTATE_TIMEOUT_MS);
    p.timerId.unref?.();
    try { inst.clearContext(); }
    catch { this._clear(id); }
  }

  private async _onClearingTurnEnd(id: string, p: PendingRenewal): Promise<void> {
    const inst = this.manager.byId.get(id);
    if (!inst || !inst.proc) { this._clear(id); return; }
    // Only `/clear`'s own turn_end rotates the BACKING id (the public id is
    // pinned for life). Ignore any intervening turn_end that has NOT rotated (a
    // mid-turn-queued user turn the CLI ran before `/clear` took effect) —
    // reseeding then would land in the old id.
    if (!inst.backingSessionId || inst.backingSessionId === p.oldSid) return;
    // No side-structure migration is needed across the rotation: the
    // idle-subscription graph and overage timers are keyed by the stable
    // instanceId, which `/clear` preserves. The Instance itself already followed
    // the backing-id rotation via its system/init handler.
    // The mechanical state block is built HERE — at reseed time, not arm time —
    // since live instances/subscriptions can change in the window between the
    // tool call and the actual clear firing.
    const stateBlock = buildStateBlock(this.manager, id);
    const seed = buildRenewSeed({ ...p.opts, stateBlock });
    const oldSid = p.oldSid;
    // One-shot: settle state — and CLOSE the rotation window — before the reseed
    // turn opens, so the hub stops deferring and the reseed's turn_end is what
    // delivers the wake. comesUpIdle:false: that turn follows by construction.
    this._clear(id, { ok: true });
    // Carry the caller's durable, sessionId-keyed markers (temp/conducted/title)
    // onto the rotated id and archive the abandoned pre-clear session. This is
    // the ONE place holding both ids, so it owns the carry. Fire-and-forget: the
    // method self-sequences (new id marked first, old id archived last) and is
    // best-effort, so it never blocks or throws into the reseed below. See
    // Instance.carryMarkersAcrossRenewal for why _writeSessionMetadata's
    // incidental re-write on the next turn_end isn't sufficient.
    inst.carryMarkersAcrossRenewal(oldSid).catch(() => {});
    // Wait for the rotation to be DURABLE before the reseed opens a turn against
    // the new backing id. The write was kicked in the system/init handler (the
    // earliest possible moment), so this normally resolves instantly. On failure
    // the rotation is live in memory but absent from disk — recovery would resolve
    // the public id to the pre-clear transcript and orphan everything the renewed
    // session goes on to write — so say so, loudly, and RESEED ANYWAY: the clear
    // already happened irreversibly and the summary is the only thing that can
    // save the session. Failure-visible, not abort.
    try {
      await inst.flushLineage();
    } catch (err) {
      inst._emitUi({
        kind: 'system', subtype: 'renew_error',
        data: {
          stage: 'lineage',
          message: `session lineage write failed: ${errMsg(err)} — the rotation is in memory `
            + 'but not on disk, so a restart before the next rotation would resume the pre-clear '
            + 'transcript and orphan this session\'s new turns',
        },
      });
    }
    // Seed the cleared session as its first user turn. internal:true so it does
    // not trip the overage resume-cancel path (the send itself is not throttled).
    // A failure here leaves the context cleared with NO summary delivered — the
    // worst outcome in the whole flow, so it must never be swallowed.
    try {
      await inst.prompt(seed, [], { internal: true });
    } catch (err) {
      inst._emitUi({
        kind: 'system', subtype: 'renew_error',
        data: {
          stage: 'reseed',
          message: `renewal reseed failed: ${errMsg(err)} — the context was cleared but the `
            + 'handoff summary was not delivered',
        },
      });
      // `renew_error` is a UI event on the WORKER's stream — it reaches a human
      // watching that session and nothing else. A conductor subscribed to this
      // worker is still waiting for the reseed turn that endRotation promised, and
      // that turn is never coming, so without this it waits out the full watchdog
      // and is then told a healthy worker "did NOT finish". Wake it now, by the
      // same rule every abandonment path already follows.
      inst.signalRotationTurnLost('renew');
    } finally {
      // Release the wider window LAST — after the reseed has either landed or
      // failed. Skipped when a NEW renewal has been armed since (arm() re-sets the
      // flag), so this cannot clear a successor's window.
      if (!this.pending.has(id)) inst.endRenewal();
    }
  }

  // Settle the pending renewal AND close the rotation window. `ok` distinguishes
  // the success path (called just before the reseed) from every abandonment path —
  // a dead proc at either turn_end, the clearContext throw, the rotate timeout, and
  // purge().
  //
  // `comesUpIdle` follows from that, and this is why every abandonment path has to
  // reach here: on SUCCESS a reseed turn follows by construction, so the wake point
  // is that turn's turn_end (comesUpIdle:false). On ABANDONMENT no turn is coming at
  // all — the renewal simply did not happen — so the completion event is the only
  // wake point there will ever be. Skipping it would leave a waiting conductor
  // deferred until the watchdog fired and told it the worker "did NOT finish".
  //
  // Guarded on `p` so it only ever closes a window this controller opened.
  private _clear(id: string, { ok = false }: { ok?: boolean } = {}): void {
    const p = this.pending.get(id);
    if (p?.timerId) clearTimeout(p.timerId);
    this.pending.delete(id);
    if (!p) return;
    const inst = this.manager.byId.get(id);
    inst?.endRotation({ ok, comesUpIdle: !ok });
    // ABANDONMENT closes the renewal window too: no reseed is coming, so there is
    // nothing left to protect. On the SUCCESS path it deliberately stays open —
    // _onClearingTurnEnd releases it once the reseed has settled.
    if (!ok) inst?.endRenewal();
  }

  // Drop a pending renewal (called on instance removal).
  purge(instanceId: string): void { this._clear(instanceId); }
}

function errMsg(e: unknown): string {
  return e instanceof Error ? e.message : String(e);
}
