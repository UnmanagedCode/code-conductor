// Idle-wake graph, extracted from InstanceManager as a composed collaborator.
// This is the orchestrator's wake lifeline, and it is a property of OWNERSHIP,
// not of a registration verb:
//
//   an owned session enters a turn, therefore its owner is woken when that
//   turn ends.
//
// A conductor OWNS a target if it spawned it (`target.callerInstanceId`) or has
// ever dispatched to it (noteDispatch, called by every turn-starting MCP
// handler). On every transition into `turn` the manager calls onTurnStart(),
// which ARMS one entry per live owner; the entry is consumed when the turn ends
// and a wake-stub user prompt is injected into the owner. An idle conductor gets
// the worker's recent output folded into the stub; a conductor that is itself
// mid-turn gets a plain stub delivered live into its running turn as a steering
// callback. There is no register verb, so there is no window between "the turn
// started" and "someone is watching it" for a fast turn_end to fall into.
//
// Keyed internally by the stable `instanceId` (NOT a sessionId): the
// event stream carries the instanceId, and an in-place `/clear` rotates a
// session's sessionId while keeping its instanceId, so instanceId keying needs
// no migration across a rotation. sessionId lives only at the boundary — the
// MCP-supplied args to noteDispatch()/setIdleTimeout() (translated to
// instanceId on entry), the sessionId woven into the wake stub in deliver(),
// and the sessionId-shaped debug view from snapshot(). Nothing here is
// persisted, and every map is purged on remove(), so there is nothing to
// "survive a restart."
//
// An ARMED entry is consumed by whichever of THREE trigger paths lands first:
//   1. turn_end (the classic path — see _onTurnEnd and its defer gate),
//   2. the idle task-drain settle (_onTaskEvent/_fireSettle — a background
//      task finishing while the worker is already idle, with NO re-invocation
//      turn ever coming, e.g. a nested Monitor whose completion is the last
//      thing the stream says),
//   3. rotation completion (_onRotationComplete — a rotation that comes up IDLE
//      with no turn at all, i.e. a prune; a renewal declares comesUpIdle:false
//      and is delivered by its reseed turn's turn_end instead).
// A forced `interrupt_turn` clears only the INTERRUPTER's own entry
// (disarmSilently) — every other owner is still woken at that turn_end and told
// the turn was INTERRUPTED rather than finished, since silencing an owner that did
// not ask for the abort would strand a wait nothing else can end.
// Alongside those runs a repeating HEARTBEAT (_arm's setInterval) that reports
// "did NOT finish" without consuming anything: a hung worker keeps pinging its
// owner, and the real turn_end wake is still there when the turn finally ends.
// The one non-consuming-path exception is a target whose process is gone: no
// turn_end can ever arrive, so that ping is the last one (see _arm).
//
// Cross-instance lookups (idsForSession / byId / liveForSession) and event
// emission go through the owning InstanceManager passed in at construction.

import { buildRecentMessages } from './mcp/handlers.ts';
import { flattenPayload } from './mcp/content.ts';
import { buildWakeStub, markPlainStub } from '../public/wakeCallback.js';
import type { InstanceLike, InstanceManagerLike } from './instanceTypes.ts';
import type { UiEvent } from './parser.ts';

// The heartbeat interval for EVERY armed wake, AND the ceiling `set_idle_timeout`
// / `idleTimeoutMs` will accept (src/mcp/tools.ts reads this constant for the
// schemas' `maximum`), so those inputs can in practice only SHORTEN the window.
// One number, two uses, deliberately: it means "the longest a mid-turn session
// may go without telling its owner it is still running", so raising
// ORCH_SUBSCRIBE_TIMEOUT_MS moves the default and the cap together.
// Delivery of the real wake is deferred until the worker's turn ends AND all its
// background subagents have finished (see _onTurnEnd / _onTaskEvent), so without
// the heartbeat a stuck subagent would leave the owner silent indefinitely.
export const DEFAULT_SUBSCRIBE_TIMEOUT_MS = Number(process.env.ORCH_SUBSCRIBE_TIMEOUT_MS) || 1_800_000;

// Settle window for the idle task-drain wake path. When a terminal task event
// drains an ALREADY-IDLE worker to zero background tasks, the CLI either opens
// an unprompted re-invocation turn (whose turn_end is the correct wake point)
// or never speaks again (the orphan case this path exists for). The two are
// distinguished structurally, not by task shape: a re-invocation announces
// itself with CLI-local `system/init` + `system/status` writes within
// milliseconds of the notification (only its message_start waits on the API),
// so "the stream stayed completely frozen for the whole settle window" means
// no turn is coming. 5s is enormous headroom over that ms-scale gap (even
// under heavy device throttle — the gap is process-local, never API-bound)
// while still waking ~360x sooner than the 30-min heartbeat would report.
const IDLE_DRAIN_SETTLE_MS = Number(process.env.ORCH_IDLE_DRAIN_SETTLE_MS) || 5_000;

// An ARMED wake for a single caller→target pair: the repeating heartbeat and the
// window it repeats on (kept so setIdleTimeout can re-arm a running one).
interface SubscriptionEntry {
  timerId: NodeJS.Timeout;
  timeoutMs: number;
}

// An OWNERSHIP edge established by dispatch (spawn-side ownership is read off
// `Instance.callerInstanceId` instead — see ownersOf). `timeoutMs` is that
// owner's preferred heartbeat window for this target, null until it names one.
interface OwnerEntry {
  timeoutMs: number | null;
}

// A pending idle task-drain settle, keyed by target instanceId. `proc` pins the
// arm to a specific subprocess run (respawn/rewind reuse the Instance AND its
// instanceId but mint a new proc and reset the ring, so seq comparisons across
// runs are meaningless); `armSeq` is the ring's nextSeq at arm time, so
// `nextSeq === armSeq` at fire time means literally zero events of any kind
// arrived since the arming task event.
interface PendingSettle {
  timerId: NodeJS.Timeout;
  proc: unknown;
  armSeq: number;
}

// Prefixed into a wake that was held while its recipient was mid-turn and whose
// worker has started ANOTHER turn since. Marked, never dropped: dropping loses a
// wake the conductor may be blocked on, while the note removes the "it's done"
// reading the plain stub would otherwise carry.
const STALE_WAKE_NOTE = 'NOTE: this report was held while you were mid-turn, and the worker has '
  + 'since started another turn — it is no longer idle.';

// Options threaded through deliver(). `note` is a pre-taken decline note (a
// deferred wake takes it at defer time); `stale` marks a deferred wake whose
// target went busy again before the wake could be delivered.
interface DeliverOpts {
  timedOut?: boolean;
  timeoutMs?: number;
  note?: string | null;
  stale?: boolean;
  // The turn being reported was force-aborted, so its output is partial and the
  // worker did not finish. Never folded — see deliver().
  interrupted?: boolean;
}

// The wording for a declined renewal request, prefixed into the wake stub's
// summary. One sentence, true whether or not the conductor supplied a followUp.
// Server-only — the client never builds it.
function declineNote(targetSessionId: string): string {
  return `Renewal request DECLINED by \`${targetSessionId}\` — it ended its turn without calling `
    + 'renew_session, so nothing was cleared.';
}

export class IdleSubscriptionHub {
  manager: InstanceManagerLike;
  // ARMED wakes: when target hits turn_end, deliver a stub user prompt to every
  // armed owner and clear the set. Armed by onTurnStart (a turn began) — so this
  // map is empty for every target that is not mid-turn.
  // Keyed by targetInstanceId → Map<callerInstanceId, SubscriptionEntry>.
  subscribers: Map<string, Map<string, SubscriptionEntry>>;
  // OWNERSHIP edges established by dispatch, targetInstanceId →
  // Map<callerInstanceId, OwnerEntry>. Durable across wakes (that is the point:
  // ownership is what re-arms every subsequent turn) and dropped only by purge.
  // Spawn-side ownership is NOT mirrored here — it already lives on
  // `Instance.callerInstanceId`, and a second copy would be a second source.
  _owners: Map<string, Map<string, OwnerEntry>>;
  // Short-lived map of targetInstanceId → the callerInstanceIds that were watching
  // it, populated in _onTurnEnd() BEFORE subscribers is cleared, so the
  // synchronously-following wsHub turn_notification handler can read it (via
  // wasConsumed) and so a decline note can be attributed to a caller whose
  // wake has already been consumed in this dispatch (see
  // noteRenewalDeclined). A queueMicrotask cleanup runs after both synchronous
  // listeners complete. turn_end-ONLY by contract: the settle path never touches
  // it (a settle fires while the worker is idle with a frozen stream, so no worker
  // turn_notification exists to suppress).
  _justConsumed: Map<string, Set<string>>;
  // Pending idle task-drain settles, keyed by targetInstanceId (see
  // PendingSettle).
  _pendingSettles: Map<string, PendingSettle>;
  // Notes to prefix into the next wake stub, keyed targetInstanceId →
  // callerInstanceId — currently only a declined renewal request. Keyed by BOTH
  // ends because a note belongs to the conductor that asked, not to whoever this
  // worker happens to wake next. Read-and-deleted by _takeDecline; see
  // noteRenewalDeclined.
  _pendingDeclines: Map<string, Map<string, string>>;
  // Wakes held back because the RECIPIENT (a conductor) is mid-turn on a model
  // that cannot take an injected message — keyed by callerInstanceId, flushed at
  // that conductor's own next turn_end. The decline note is taken at defer time
  // and carried, because it belongs to the wake that was deferred, not to
  // whatever else that pair does in between.
  _deferredWakes: Map<string, Array<{ targetInstanceId: string; opts?: DeliverOpts; note: string | null }>>;

  constructor(manager: InstanceManagerLike) {
    this.manager = manager;
    this.subscribers = new Map();
    this._owners = new Map();
    this._justConsumed = new Map();
    this._pendingSettles = new Map();
    this._pendingDeclines = new Map();
    this._deferredWakes = new Map();
  }

  // Driven by InstanceManager's `event` listener — EVERY instance event lands
  // here. turn_end takes the classic wake path (_onTurnEnd); the task-lifecycle
  // completion subtypes take the idle task-drain settle path (_onTaskEvent),
  // which exists because a background task can finish while the worker is
  // ALREADY idle with no re-invocation turn ever following (verified: a nested
  // Monitor's completion emits only task_updated + task_notification and the
  // stream goes silent) — waiting for the next turn_end would orphan the
  // wake until the next heartbeat. Everything else is ignored, but note that
  // every ignored event still advanced the target's ring seq and, if it
  // arrived while the target was idle, set its idleWindowDirty flag — the two
  // structural signals the settle path uses to avoid firing early.
  onEvent({ id, ev }: { id: string; ev: UiEvent | null }): void {
    if (ev?.kind === 'turn_end') {
      this._onTurnEnd(id);
      // …and, as the RECIPIENT of a held-back wake, this is the boundary that
      // makes it deliverable. Synchronously, so a steer queued on this instance
      // is still `steerPending` when _flushDeferredWakes reads it (its own flush
      // runs on a microtask) and the wake correctly re-defers behind it.
      this._flushDeferredWakes(id);
    } else if (ev?.kind === 'system' && ev.subtype === 'steer_settled') {
      // A queued steer drained WITHOUT starting a turn (delivery failed, or the
      // process died) — no turn_end is coming, so flush here or the wake strands.
      this._flushDeferredWakes(id);
    } else if (ev?.kind === 'system'
        && (ev.subtype === 'task_updated' || ev.subtype === 'task_notification')) {
      this._onTaskEvent(id);
    } else if (ev?.kind === 'system' && ev.subtype === 'rotation_complete') {
      this._onRotationComplete(id, ev);
    }
  }

  // When a target instance's turn_end fires, deliver to every caller
  // armed for it and consume the armed set (stopping each heartbeat — turn_end
  // won).
  //
  // Deferral: a backgrounded Agent-tool call resolves its tool_result
  // immediately (isAsync:true), so a worker's turn_end can fire while it still
  // has live subagents (Instance._activeAgentTasks non-empty). We want the wake
  // to mean "the agent AND all its subagents finished, and no re-invocation
  // turn is still owed," so we DEFER for either of two reasons, keeping the
  // wake (and its heartbeat) armed:
  //   1. activeAgentTaskCount > 0 — a subagent is still running.
  //   2. taskNotificationPending — a task_notification fired during the turn
  //      now ending and NO top-level tool_result followed it, which (per the
  //      CLI's queue semantics — see the _taskNotificationPending comment in
  //      instances.ts) means the notification is still queued and the CLI WILL
  //      open an unprompted re-invocation turn to deliver it. Firing here
  //      would wake the caller one turn early (it would read the worker's
  //      output from before the result was processed), so we wait for that
  //      re-invocation turn's turn_end. A notification consumed in-turn (the
  //      task's own held-open tool_result, or attached to a later tool
  //      round-trip) clears the flag, so a turn that merely CONTAINED a task
  //      completion — e.g. a long test-run Bash promoted to a task — wakes
  //      normally at its turn_end, parked or not.
  // A completion between turns (worker idle) does NOT set the flag: when a
  // re-invocation turn follows immediately, it IS the processing turn and its
  // turn_end fires the wake correctly — and when NO re-invocation follows at
  // all, the idle task-drain settle path (_onTaskEvent) delivers the wake. A
  // never-finishing subagent — or a CLI that never flushes its queue — is
  // reported by the repeating heartbeat.
  _onTurnEnd(targetInstanceId: string): void {
    // The event payload carries the instanceId — the graph's key directly.
    const target = this.manager.byId.get(targetInstanceId);
    if (!target) return;
    // A turn_end supersedes any pending idle-drain settle: either it consumes
    // the wake right here, or its defer keeps the turn_end path in
    // charge (and the settle's fire-time freeze check would drop it anyway —
    // this cancel is the eager form of that).
    this._cancelSettle(targetInstanceId);
    const subs = this.subscribers.get(targetInstanceId);
    if (!subs || subs.size === 0) return;
    // Mark BEFORE the defer check / clearing so the wsHub 'event' listener
    // (registered after this one in server.ts: new InstanceManager() then
    // attachWsHub()) can still detect that the target had a watcher when its
    // turn_end fired — on the deferred intermediate turn_end as well as the
    // final one, so the worker's turn_notification stays suppressed across the
    // whole deferral.
    this._justConsumed.set(targetInstanceId, new Set(subs.keys()));
    queueMicrotask(() => this._justConsumed.delete(targetInstanceId));
    // Defer while background subagents are still running OR an unconsumed
    // mid-turn task notification means a re-invocation turn is still owed —
    // keep the wake and its heartbeat armed; a later turn_end with both
    // clear delivers. `target` is a live Instance here (a falsy `subs` above
    // already returned when it was absent), so the getters are always present.
    // …and defer while a context ROTATION is in flight, for the same reason: the
    // turn_end being observed is the one the rotation was armed in, so firing here
    // would wake the caller with the pre-rotation state and spend the wake a
    // turn early. The window lives on the Instance (set at arm time, before this
    // can fire), so this defer works regardless of listener registration order —
    // which is what makes it correct without reordering the two listeners.
    // …and defer while a steer is parked on this target waiting for a block-edge
    // stop (a model that can't take a mid-turn injection — see
    // Instance.queueSteerAfterStop). The turn_end being observed is the one the
    // stop produced: the worker was CUT OFF to deliver the steer, it did not
    // finish, so spending the wake here would wake the conductor a turn early.
    // Same shape and same reason as rotationPending — the flag lives on the
    // Instance and is set in the send_prompt handler before the abort is even
    // armed, so this defer is independent of listener registration order.
    if (target.activeAgentTaskCount > 0 || target.taskNotificationPending
        || target.rotationPending || target.steerPending) return;
    const entries = [...subs.entries()];
    subs.clear();
    this.subscribers.delete(targetInstanceId);
    const abort = this._abortQualifier(target);
    for (const [callerInstanceId, { timerId }] of entries) {
      clearInterval(timerId); // stop the heartbeat — turn_end arrived
      this.deliver(callerInstanceId, targetInstanceId, abort);
    }
  }

  // The INTERRUPTED qualifier, or undefined for an ordinary resolution. Read by
  // EVERY consuming path, not just turn_end: which path happens to resolve an
  // armed wake is an accident of what the worker was doing, and the report must
  // not change with it. A force-abort whose turn_end defers on a live subagent is
  // resolved by the idle-drain settle instead; a prune resolves the same deferred
  // wake through rotation completion. Both would otherwise say "finished its turn"
  // AND fold the partial aborted output in as the result.
  //
  // The owner that called for the abort has already had its own entry silently
  // disarmed (disarmSilently), so whoever is still armed did not ask for it — and
  // the UI's stop button has no interrupter at all, so on that door every owner
  // takes this path.
  // Pure READ. It used to clear here too, but onTurnStart's survived-a-wake check
  // now owns the qualifier's whole lifetime: every consuming path empties this
  // target's `subscribers` entry, so the next turn start necessarily sees
  // survived === false and clears. Clearing in both places left a line no test
  // could distinguish — one responsibility, one home.
  _abortQualifier(target: InstanceLike | null | undefined): DeliverOpts | undefined {
    return target?.turnForceAborted === true ? { interrupted: true } : undefined;
  }

  // The idle task-drain settle path. Called on every task_updated /
  // task_notification event. If the event leaves a WATCHED target in the
  // fully-drained idle state — idle, zero live tasks, no re-invocation owed,
  // and an idle window containing nothing but task bookkeeping — it arms (or
  // re-arms) a settle timer. The timer delivers the wake only if the target's
  // stream stays COMPLETELY frozen for the whole window (_fireSettle); any
  // event at all — a re-invocation's init/status, a prompt echo, an exit —
  // means someone else owns the wake (turn_end) and the settle
  // drops. Two-sided guard against waking one turn early:
  //   pre-arm:  idleWindowDirty — a re-invocation that STARTED opening before
  //             this drain event (its init/status already written, its
  //             message_start still waiting on the API) refuses the arm;
  //   post-arm: the armSeq freeze check — a re-invocation opening AFTER the
  //             arm advances the ring within ms (CLI-local writes) and the
  //             fire-time check drops.
  // Deliberately task-shape agnostic: no task_type / nesting / init-counting.
  _onTaskEvent(targetInstanceId: string): void {
    const target = this.manager.byId.get(targetInstanceId);
    if (!target) return;
    const subs = this.subscribers.get(targetInstanceId);
    if (!subs || subs.size === 0) return;
    const drained = target.status === 'idle'
      && target.activeAgentTaskCount === 0
      && !target.taskNotificationPending
      && !target.idleWindowDirty
      // Also guards instances without a real ring (malformed / test fakes):
      // never arm on a baseline the freeze check can't verify.
      && Number.isInteger(target.ring?.nextSeq);
    if (!drained) {
      // The state moved (a new task started, a re-invocation is opening, …) —
      // whatever was pending is stale. turn_end owns the wake.
      this._cancelSettle(targetInstanceId);
      return;
    }
    this._cancelSettle(targetInstanceId); // re-arm: reset countdown and baseline
    const timerId = setTimeout(() => this._fireSettle(targetInstanceId), IDLE_DRAIN_SETTLE_MS);
    timerId.unref?.(); // a lone settle must not keep the process alive
    this._pendingSettles.set(targetInstanceId, {
      timerId,
      proc: target.proc,
      armSeq: target.ring.nextSeq,
    });
  }

  // Settle-timer callback. Every check re-derives current state; failing ANY
  // of them drops the settle silently — the wake and its heartbeat stay
  // armed, so the worst wrong outcome here is "wake later than ideal", never
  // "wake one turn early" or "wake twice".
  _fireSettle(targetInstanceId: string): void {
    const pending = this._pendingSettles.get(targetInstanceId);
    this._pendingSettles.delete(targetInstanceId); // always self-clean, even on drop
    if (!pending) return;
    const subs = this.subscribers.get(targetInstanceId);
    if (!subs || subs.size === 0) return; // consumed meanwhile (turn_end)
    const inst = this.manager.byId.get(targetInstanceId);
    if (!inst) return;
    // Same subprocess run: respawn/rewind mint a new proc (and reset the
    // ring), which would make the seq comparison below meaningless.
    if (inst.proc == null || inst.proc !== pending.proc) return;
    if (inst.status !== 'idle' || inst.activeAgentTaskCount > 0
        || inst.taskNotificationPending || inst.idleWindowDirty) return;
    // The freeze check: zero events of any kind since the arming task event.
    if (inst.ring?.nextSeq !== pending.armSeq) return;
    // Consume — the same shape as the heartbeat path, but with the normal
    // "finished" stub. NOTE: _justConsumed is intentionally NOT marked (it is
    // turn_end-only; no worker turn_notification is in flight right now).
    const entries = [...subs.entries()];
    subs.clear();
    this.subscribers.delete(targetInstanceId);
    this.manager.emit('subscription_changed', { targetId: targetInstanceId });
    const abort = this._abortQualifier(inst);
    for (const [callerInstanceId, { timerId }] of entries) {
      clearInterval(timerId); // stop the heartbeat — the settle won
      this.deliver(callerInstanceId, targetInstanceId, abort);
    }
  }

  // A rotation finished. Fire the wake immediately IFF the mechanism declared the
  // session comes up IDLE with no turn — a prune, where this event is the only wake
  // point that will ever arrive. A renewal declares comesUpIdle:false: its reseed
  // turn follows by construction, and that turn's turn_end (no longer deferred,
  // since rotationPending is false by the time this fires) delivers instead.
  //
  // Declared by the mechanism rather than read off `inst.status`, because status is
  // still 'idle' at this moment for BOTH mechanisms — microseconds before a
  // renewal's prompt() flips it. That is also why prune's future MCP exposure needs
  // no change here.
  _onRotationComplete(targetInstanceId: string, ev: UiEvent): void {
    const data = (ev as { data?: { comesUpIdle?: unknown } }).data;
    if (data?.comesUpIdle !== true) return;
    const subs = this.subscribers.get(targetInstanceId);
    if (!subs || subs.size === 0) return;
    const entries = [...subs.entries()];
    subs.clear();
    this.subscribers.delete(targetInstanceId);
    // No watchers left, so any pending idle-drain settle has nothing to deliver to.
    this._cancelSettle(targetInstanceId);
    this.manager.emit('subscription_changed', { targetId: targetInstanceId });
    const abort = this._abortQualifier(this.manager.byId.get(targetInstanceId));
    for (const [callerInstanceId, { timerId }] of entries) {
      clearInterval(timerId); // stop the heartbeat — the rotation won
      this.deliver(callerInstanceId, targetInstanceId, abort);
    }
  }

  // A conductor's renewal request expired unconsumed on this target — the worker
  // declined (see src/sessionRenew.ts). The note is filed against the conductor
  // that ASKED (`requestedBy`), never against the target alone: two conductors may
  // watch one worker, and telling the one that made no request is a report about
  // something it never did, while the requester hears nothing.
  //
  // Recorded ONLY if that caller is actually waiting (_isWaitingOn), so a note can
  // never linger for a wake that never comes; and consumed by whichever path ends
  // the wait (_takeDecline), so it can never surface on a later, unrelated one.
  //
  // Called SYNCHRONOUSLY inside the same event dispatch as the expiry, which is
  // what makes the ordering safe without depending on listener order: deliver()'s
  // body runs as a microtask, so the note is always set before it reads.
  noteRenewalDeclined(targetInstanceId: string, requestedBy: string | null): void {
    // sessionId in, instanceId thereafter — the same boundary translation
    // noteDispatch() does. A requester that is gone has nothing to be told.
    const callerInstanceId = requestedBy ? this.manager.liveForSession(requestedBy)?.id ?? null : null;
    if (!callerInstanceId) return;
    if (!this._isWaitingOn(targetInstanceId, callerInstanceId)) return;
    const sid = this.manager.byId.get(targetInstanceId)?.sessionId ?? targetInstanceId;
    let notes = this._pendingDeclines.get(targetInstanceId);
    if (!notes) { notes = new Map(); this._pendingDeclines.set(targetInstanceId, notes); }
    notes.set(callerInstanceId, declineNote(sid));
  }

  // Cancel the pending settle for a target instance, if any. Idempotent.
  _cancelSettle(targetInstanceId: string): void {
    const pending = this._pendingSettles.get(targetInstanceId);
    if (!pending) return;
    clearTimeout(pending.timerId);
    this._pendingSettles.delete(targetInstanceId);
  }

  // Drop every pending settle. Test teardown hook — suites that reach into
  // the subscriber map directly need a way to also drop the (unref'd) timers
  // so a stale settle can't fire into a later test's manager state.
  _cancelAllSettles(): void {
    for (const { timerId } of this._pendingSettles.values()) clearTimeout(timerId);
    this._pendingSettles.clear();
  }

  // Every LIVE owner of a target: the conductors that will be woken when this
  // target's next turn ends. Ownership is spawn OR dispatch — the union of the
  // dispatch edges in `_owners` and the spawner recorded on the Instance itself.
  // Self is excluded (a session cannot wait on its own turn), and so is any
  // owner that is no longer in byId (there is nobody left to wake).
  ownersOf(targetInstanceId: string): string[] {
    const out = new Set<string>(this._owners.get(targetInstanceId)?.keys() ?? []);
    const spawner = this.manager.byId.get(targetInstanceId)?.callerInstanceId;
    if (spawner) out.add(spawner);
    out.delete(targetInstanceId);
    return [...out].filter(id => this.manager.byId.get(id) != null);
  }

  // Record that `caller` dispatched to `target` — called by every turn-starting
  // MCP handler BEFORE the send, because the arm itself happens synchronously
  // inside prompt() → _setStatus('turn'), so a record made afterwards is already
  // too late for the turn it was made for.
  //
  // Boundary translation (sessionId in, instanceId thereafter) and the self-edge
  // throw are this hub's only sessionId-facing entry, shared with setIdleTimeout()
  // below. `timeoutMs`, when a usable positive finite
  // number, becomes this owner's preferred heartbeat window; an absent/invalid
  // one leaves an earlier set_idle_timeout preference intact rather than
  // silently resetting it to the default.
  //
  // If the target is ALREADY mid-turn, arm right here: onTurnStart has been and
  // gone for that turn, and a mid-turn steer from a conductor that did not
  // previously own the target would otherwise get no wake for the very turn it
  // just steered. An owner already armed makes this a no-op.
  noteDispatch(callerSessionId: string, targetSessionId: string, timeoutMs?: number): void {
    if (typeof callerSessionId !== 'string' || !callerSessionId) {
      throw new Error('callerSessionId required');
    }
    if (typeof targetSessionId !== 'string' || !targetSessionId) {
      throw new Error('targetSessionId required');
    }
    if (callerSessionId === targetSessionId) {
      throw new Error('cannot wait on self');
    }
    const caller = this.manager.liveForSession(callerSessionId);
    if (!caller) throw new Error(`caller session not live: ${callerSessionId}`);
    const target = this.manager.liveForSession(targetSessionId);
    if (!target) throw new Error(`target session not live: ${targetSessionId}`);
    this._recordOwner(target.id, caller.id, timeoutMs);
    if (target.status === 'turn' && this._arm(target.id, caller.id)) {
      this.manager.emit('subscription_changed', { targetId: target.id });
    }
  }

  // A target entered a turn (driven by InstanceManager's per-instance
  // 'turn_start' wiring, which fires from _setStatus's into-`turn` branch — so
  // it covers prompt-initiated AND unprompted re-invocation turns alike). Arm
  // one wake per live owner; owners already armed are left alone, which is what
  // makes a mid-turn steer deliver ONE wake rather than two.
  onTurnStart(targetInstanceId: string): void {
    // Read BEFORE arming: did a wake survive from the previous turn into this
    // transition? That is the discriminator for the abort qualifier's third and
    // last hole. If something WAS armed, it is the deferred wake of the aborted
    // turn and the qualifier still belongs to it (the CLI resolves a deferred
    // wake by opening exactly this kind of unprompted re-invocation turn). If
    // nothing was armed, no wake survived that the qualifier could describe — so a
    // flag still set here is stale, and the only way to get one is the case
    // neither other clear reaches: a SOLE owner forced the abort, its own entry
    // was silently disarmed, so no consuming path ever ran consumeTurnForceAborted
    // and no prompt() ever ran either, while the CLI still owed a queued
    // notification and opened an unprompted turn that does real work and finishes
    // fine. Without this, that turn's wake reported "was INTERRUPTED … do not
    // treat this as a result" about a completed turn.
    const survived = (this.subscribers.get(targetInstanceId)?.size ?? 0) > 0;
    let armed = false;
    for (const callerInstanceId of this.ownersOf(targetInstanceId)) {
      if (this._arm(targetInstanceId, callerInstanceId)) armed = true;
    }
    if (!survived) this.manager.byId.get(targetInstanceId)?.consumeTurnForceAborted?.();
    if (armed) this.manager.emit('subscription_changed', { targetId: targetInstanceId });
  }

  // Adjust one owner's heartbeat window. Records the preference for every future
  // turn AND re-arms a RUNNING heartbeat — mid-turn is the only case a conductor
  // has any reason to call this, so a stored-but-inert preference would be the
  // useless half of the behaviour. Returns whether a heartbeat was live to re-arm.
  setIdleTimeout(callerSessionId: string, targetSessionId: string, timeoutMs: number): { armed: boolean } {
    const caller = this.manager.liveForSession(callerSessionId);
    if (!caller) throw new Error(`caller session not live: ${callerSessionId}`);
    const target = this.manager.liveForSession(targetSessionId);
    if (!target) throw new Error(`target session not live: ${targetSessionId}`);
    if (caller.id === target.id) throw new Error('cannot wait on self');
    // Recording the preference also establishes the ownership edge: asking to be
    // pinged about a worker is the same declaration of interest a dispatch makes.
    this._recordOwner(target.id, caller.id, timeoutMs);
    const entry = this.subscribers.get(target.id)?.get(caller.id);
    if (!entry) return { armed: false };
    clearInterval(entry.timerId);
    this.subscribers.get(target.id)!.delete(caller.id);
    this._arm(target.id, caller.id);
    this.manager.emit('subscription_changed', { targetId: target.id });
    return { armed: true };
  }

  // Clear ONE caller's armed wake on a target and deliver nothing to it — the
  // forced `interrupt_turn` path. Because arming only ever happens on turn START,
  // which has already passed, nothing re-arms for that caller until the target's
  // next turn; `_owners` is deliberately left intact, since the conductor still
  // owns the worker, it just wants no report on the turn it killed.
  //
  // Scoped to the CALLER on purpose. The justification — "a turn this caller just
  // killed" — extends to nobody else: a target can have several owners (spawn OR
  // dispatch, and the interrupter need not be an owner at all), and clearing the
  // whole per-target map left every other owner with no stub, no heartbeat, and a
  // wait that could never end. Those owners are woken instead, and told the turn
  // was interrupted rather than finished — see `Instance.turnForceAborted` and
  // `_plainStub`'s interrupted variant.
  disarmSilently(targetInstanceId: string, callerInstanceId: string): void {
    if (!this.subscribers.get(targetInstanceId)?.has(callerInstanceId)) return;
    this._dropArmed(targetInstanceId, callerInstanceId);
    this._takeDecline(targetInstanceId, callerInstanceId); // this wait is over
    this.manager.emit('subscription_changed', { targetId: targetInstanceId });
  }

  // Create/update one dispatch ownership edge. A usable timeoutMs wins; anything
  // else preserves whatever window this owner already asked for.
  _recordOwner(targetInstanceId: string, callerInstanceId: string, timeoutMs?: number): void {
    let owners = this._owners.get(targetInstanceId);
    if (!owners) { owners = new Map(); this._owners.set(targetInstanceId, owners); }
    const prev = owners.get(callerInstanceId)?.timeoutMs ?? null;
    const wanted = (typeof timeoutMs === 'number' && isFinite(timeoutMs) && timeoutMs > 0)
      ? timeoutMs
      : prev;
    owners.set(callerInstanceId, { timeoutMs: wanted });
  }

  // Arm the repeating heartbeat for one caller→target pair. Returns false when
  // the pair is already armed (the idempotency that makes one turn = one wake).
  //
  // The heartbeat delivers the timeout-flagged "did NOT finish" stub and touches
  // NO other state: the pending turn_end wake it reports about is still armed
  // afterwards, which is the whole point — a hung worker keeps pinging and the
  // real wake still arrives when the turn finally ends. The single exception is a
  // target that is gone for good: no turn_end can ever follow, so that ping is
  // the last one rather than the first of an unbounded series. "Gone for good" is
  // NOT just `!proc` — a prune/rewind/respawn kills the subprocess and relaunches
  // it, and a beat landing in that gap would retire an entry whose wake is still
  // owed (the rotation's own completion, or the reseed turn's turn_end, would then
  // find nothing armed and the owner would be left with "did NOT finish" as its
  // last word). So the retirement also requires that nothing is reviving it.
  // .unref()'d so a lone heartbeat never keeps the process alive.
  _arm(targetInstanceId: string, callerInstanceId: string): boolean {
    let subs = this.subscribers.get(targetInstanceId);
    if (!subs) { subs = new Map(); this.subscribers.set(targetInstanceId, subs); }
    if (subs.has(callerInstanceId)) return false;
    const timeoutMs = this._owners.get(targetInstanceId)?.get(callerInstanceId)?.timeoutMs
      ?? DEFAULT_SUBSCRIBE_TIMEOUT_MS;
    const timerId = setInterval(() => {
      if (this._goneForGood(targetInstanceId)) {
        // Nothing can ever end this turn — this ping is the last one rather than
        // the first of an unbounded series.
        this._dropArmed(targetInstanceId, callerInstanceId);
        this.manager.emit('subscription_changed', { targetId: targetInstanceId });
      }
      this.deliver(callerInstanceId, targetInstanceId, { timedOut: true, timeoutMs });
    }, timeoutMs);
    timerId.unref?.();
    subs.set(callerInstanceId, { timerId, timeoutMs });
    return true;
  }

  // Is this target past every possible wake point — no subprocess AND nothing in
  // flight that will bring one back? A live instance in the kill→relaunch gap of a
  // prune/rewind/respawn, or holding `_mutating` around a destructive rewrite,
  // explicitly is NOT: its wake is still owed.
  //
  // The absent-instance case is defensive totality, not a behaviour choice: every
  // `byId.delete` in InstanceManager is paired with `_purgeIdleFor` in the same
  // breath, and purge clears this very interval, so a beat cannot outlive its
  // target's registration. Written as optional chaining rather than an explicit
  // `if (!t)` branch precisely so it makes no untestable claim — undefined falls
  // through to `true` (retire), which is the only safe answer if that pairing ever
  // breaks. `rotationPending` covers the whole rotation window; `rotationInFlight`
  // is the same `_rotation` field read for its reason, so testing both was one
  // predicate spelled twice.
  _goneForGood(targetInstanceId: string): boolean {
    const t = this.manager.byId.get(targetInstanceId);
    if (t?.proc) return false;
    return !t?.relaunching && !t?.rotationPending && !t?._mutating;
  }

  // Remove one armed entry (clearing its heartbeat) and tidy the maps behind it.
  _dropArmed(targetInstanceId: string, callerInstanceId: string): void {
    const subs = this.subscribers.get(targetInstanceId);
    const entry = subs?.get(callerInstanceId);
    if (!subs || !entry) return;
    clearInterval(entry.timerId);
    subs.delete(callerInstanceId);
    if (subs.size === 0) {
      this.subscribers.delete(targetInstanceId);
      // No watchers left — a pending idle-drain settle has nothing to deliver
      // to (its fire-time re-check would drop it; this is the eager form so the
      // map stays clean).
      this._cancelSettle(targetInstanceId);
    }
  }

  // Snapshot of the currently ARMED wake graph, projected back to sessionIds.
  // Test/debug-only — the honest "who is waiting on whose running turn" view
  // (internal keys are instanceIds). Falls back to the raw key if the instance
  // is already gone.
  snapshot(): Record<string, string[]> {
    const sid = (id: string): string => this.manager.byId.get(id)?.sessionId ?? id;
    const out: Record<string, string[]> = {};
    for (const [targetId, callers] of this.subscribers) {
      out[sid(targetId)] = [...callers.keys()].map(sid);
    }
    return out;
  }

  // Drop an instanceId from every map (as caller) AND drop any entry where it
  // was the target — armed wakes AND the ownership edges behind them, because a
  // removed instance can neither be woken nor start another turn. Clears
  // heartbeat timers. Called on instance removal. Guards a falsy id.
  purge(instanceId: string): void {
    if (!instanceId) return;
    this._cancelSettle(instanceId); // as target: drop any pending idle-drain settle
    this._owners.delete(instanceId); // as target: every owner edge pointing at it
    for (const [target, owners] of this._owners) { // as owner of something else
      if (!owners.delete(instanceId)) continue;
      if (owners.size === 0) this._owners.delete(target);
    }
    // As RECIPIENT: wakes held for this instance have nowhere to go. (As a
    // deferred wake's TARGET it needs no cleanup — deliver() resolves a missing
    // target to its raw id and still reports honestly.)
    this._deferredWakes.delete(instanceId);
    this._pendingDeclines.delete(instanceId); // …and every note about it
    // As CALLER: a note filed for this instance under some other target can no
    // longer reach anyone either.
    for (const [target] of this._pendingDeclines) this._takeDecline(target, instanceId);
    const asTarget = this.subscribers.get(instanceId);
    if (asTarget) {
      for (const [, { timerId }] of asTarget) clearInterval(timerId);
      this.subscribers.delete(instanceId);
    }
    for (const [target, subs] of this.subscribers) {
      const entry = subs.get(instanceId);
      if (entry) {
        clearInterval(entry.timerId);
        subs.delete(instanceId);
        if (subs.size === 0) {
          this.subscribers.delete(target);
          this._cancelSettle(target); // that target lost its last watcher
        }
      }
    }
  }

  // Sever every wake edge touching a session the overage stop is stopping, and
  // return the instanceIds of the callers that lost a wait on it — the overage
  // stop marks each so its own resume prompt says the callbacks are gone.
  //
  // Keyed on THIS graph, not on the conducted-spawn graph, and that still matters
  // now that the graph is ownership-keyed: ownership here is spawn OR dispatch, so
  // a conductor can be waiting on a session it never spawned. Keying on spawn
  // alone left exactly that case armed — the stopped session's turn_end delivered
  // an `internal:true` wake, which the overage queue intercept deliberately does
  // NOT hold, and the caller started a fresh turn inside the lockout.
  //
  // Both directions, because the session is stopped: its turn_end must wake nobody,
  // and nothing may later wake it. purge() covers all of that except one case it is
  // deliberately wrong for here — a wake ALREADY deferred behind some mid-turn
  // recipient that names this session as its target. purge() leaves those (a
  // REMOVED target still reports honestly through deliver()), but a
  // stopped-and-alive one must not be reported at all: _flushDeferredWakes would
  // deliver it at the recipient's next boundary and restart the burn.
  severForOverageStop(instanceId: string): string[] {
    if (!instanceId) return [];
    // Every id read BEFORE purge() empties the maps.
    const lost = new Set<string>();
    for (const caller of this.subscribers.get(instanceId)?.keys() ?? []) lost.add(caller);
    // The stopped session's OWN waits end here too, so it is reported alongside the
    // callers waiting on it — a stopped conductor needs the same "your callbacks are
    // gone" line as one that merely lost a worker.
    const lostFrom = [...this.subscribers]
      .filter(([, subs]) => subs.has(instanceId)).map(([target]) => target);
    if (lostFrom.length || this._deferredWakes.has(instanceId)) lost.add(instanceId);
    this.purge(instanceId);
    for (const [callerInstanceId, queue] of [...this._deferredWakes]) {
      const kept = queue.filter(q => q.targetInstanceId !== instanceId);
      if (kept.length === queue.length) continue;
      if (kept.length) this._deferredWakes.set(callerInstanceId, kept);
      else this._deferredWakes.delete(callerInstanceId);
      lost.add(callerInstanceId);
    }
    for (const target of lostFrom) this.manager.emit('subscription_changed', { targetId: target });
    this.manager.emit('subscription_changed', { targetId: instanceId });
    return [...lost];
  }

  // Deliver every wake held back for this recipient, now that it has reached a
  // boundary. Re-defers (returns, keeping the queue) while a steer is still parked
  // on it: that steer starts a turn in a microtask, and delivering here would race
  // a second prompt() into the same instant.
  _flushDeferredWakes(callerInstanceId: string): void {
    const pending = this._deferredWakes.get(callerInstanceId);
    if (!pending) return;
    const caller = this.manager.byId.get(callerInstanceId);
    if (!caller?.proc) {
      // Recipient gone — nothing can be delivered. Its notes were already
      // consumed at defer time.
      this._deferredWakes.delete(callerInstanceId);
      return;
    }
    if (caller.steerPending) return;
    this._deferredWakes.delete(callerInstanceId);
    for (const p of pending) {
      // The worker may have gone busy again while the wake waited — say so
      // rather than let a "finished its turn" stub misreport it.
      const target = this.manager.byId.get(p.targetInstanceId);
      const stale = target != null && target.status === 'turn';
      this.deliver(callerInstanceId, p.targetInstanceId, { ...p.opts, note: p.note, stale });
    }
  }

  deliver(callerInstanceId: string, targetInstanceId: string, opts?: DeliverOpts): void {
    // Resolve the live caller instance directly by instanceId.
    const caller = this.manager.byId.get(callerInstanceId);
    if (!caller || !caller.proc) {
      // Caller gone — drop silently, but consume its note: this wake is the one
      // that note was for, and nothing else will ever read it.
      this._takeDecline(targetInstanceId, callerInstanceId);
      return;
    }
    // Boundary: the stub names the worker by sessionId and points at
    // get_recent_messages (sessionId-addressed), so translate the target's
    // CURRENT sessionId here (a /clear-rotated target resolves to its new id).
    // A recipient that cannot take a message injected into a running turn gets
    // the wake HELD until its own next turn_end — never a block-edge stop: an
    // idle report is not urgent, and aborting a conductor mid-turn would sever
    // whatever orchestration it has in flight. The decline note is taken NOW,
    // synchronously, because it belongs to this wake (see noteRenewalDeclined).
    if (caller.status === 'turn' && caller.acceptsMidTurnSteering === false) {
      const queue = this._deferredWakes.get(callerInstanceId) ?? [];
      queue.push({ targetInstanceId, opts, note: this._takeDecline(targetInstanceId, callerInstanceId) });
      this._deferredWakes.set(callerInstanceId, queue);
      return;
    }
    const targetSessionId = this.manager.byId.get(targetInstanceId)?.sessionId ?? targetInstanceId;
    // Fold the worker's recent output into the stub ONLY on a real turn_end
    // delivered to an already-idle caller. The heartbeat path and the
    // live mid-turn steering path keep the plain pointer stub. Decided here,
    // synchronously, on the caller's status at delivery time.
    // A STALE wake keeps the plain pointer stub too: folding a busy worker's
    // mid-flight output in would read as its finished result.
    // …and so does an INTERRUPTED one, deliberately: the presence of the body
    // separator IS the client's "this is the finished result" signal, so folding
    // partial aborted output in would invite the conductor to act on exactly what
    // the abort was meant to stop it acting on. It gets the pointer instead.
    const fold = !opts?.timedOut && !opts?.stale && !opts?.interrupted && caller.status !== 'turn';
    const deliver = async (): Promise<void> => {
      // Read-and-delete BEFORE any await: the expiry that recorded this note ran
      // synchronously in the dispatch that queued this microtask, and the note
      // belongs to exactly one wake. A deferred wake already took its note at
      // defer time and carries it in `opts`.
      const note = opts?.note ?? this._takeDecline(targetInstanceId, callerInstanceId);
      try {
        if (!caller.proc) return;
        const stub = fold
          ? await this._buildFoldedStub(targetSessionId, note)
          : this._plainStub(targetSessionId, { ...opts, note });
        // `internal:true` — this is an orchestrator-injected wake, not a user
        // takeover, so it must NOT cancel a pending overage auto-resume armed on
        // the caller (an overage-stopped conductor still gets woken when its
        // worker finishes). `annotateIfMidTurn:false` — MID_TURN_NOTE says "the
        // user sent this message", which is wrong for an orchestrator wake; a
        // mid-turn wake is delivered live into the caller's running turn as a
        // clean steering stub (its WAKE_CALLBACK_MARKER still leads the echoed
        // text, so the UI renders the wake bubble unchanged).
        await caller.prompt(stub, [], { internal: true, annotateIfMidTurn: false });
      } catch (err) {
        caller._emitUi({
          kind: 'system', subtype: 'stderr',
          data: { line: `idle-callback delivery failed: ${(err as Error).message}` },
        });
      }
    };
    // A mid-turn caller receives the wake live (steering); an idle caller gets
    // it folded. Either way it goes out on the next microtask.
    queueMicrotask(deliver);
  }

  // The plain pointer stub — text for the heartbeat path and the live
  // mid-turn steering path. Tells the caller to go call get_recent_messages.
  // Tagged with the wake marker (body-less, no WAKE_BODY_SEP) so the conductor
  // UI renders it as a wake bubble too — just the summary line, no fold.
  _plainStub(targetSessionId: string, opts?: DeliverOpts): string {
    const summary = opts?.interrupted
      ? `Worker \`${targetSessionId}\` was INTERRUPTED — its turn was force-aborted, so it did ` +
        `NOT finish and whatever it produced is PARTIAL; work in progress was discarded. ` +
        `Call \`mcp__code-conductor__get_recent_messages({sessionId:"${targetSessionId}"})\` ` +
        `to see how far it got, then re-drive it or escalate — do not treat this as a result.`
      : opts?.timedOut
      ? `Worker \`${targetSessionId}\` did NOT finish — timed out after ${opts.timeoutMs}ms; ` +
        `it may still be busy or stuck. ` +
        `Call \`mcp__code-conductor__get_recent_messages({sessionId:"${targetSessionId}"})\` ` +
        `to check its current state, then decide whether to wait, ` +
        `call interrupt_turn, or escalate.`
      : `Worker \`${targetSessionId}\` finished its turn. ` +
        `Call \`mcp__code-conductor__get_recent_messages({sessionId:"${targetSessionId}"})\` ` +
        `to inspect the result.`;
    const prefix = [opts?.note, opts?.stale ? STALE_WAKE_NOTE : null].filter(Boolean).join(' ');
    return markPlainStub(prefix ? `${prefix} ${summary}` : summary);
  }

  // The folded stub — reuses buildRecentMessages (the SAME selection/bonding a
  // default get_recent_messages call runs) and flattens it inline so the caller
  // doesn't need the follow-up MCP round-trip. Falls back to the plain stub on a
  // soft-refusal (e.g. the worker went away between turn_end and delivery).
  async _buildFoldedStub(targetSessionId: string, note: string | null = null): Promise<string> {
    const r = await buildRecentMessages({ sessionId: targetSessionId }, { instances: this.manager });
    if ('soft' in r) return this._plainStub(targetSessionId, { note });
    return buildWakeStub({ targetSessionId, payloadText: flattenPayload(r.meta, r.bodies), note });
  }

  // Does this target have at least one ARMED wake on it — i.e. is someone due a
  // report when its running turn ends.
  hasArmedWake(instanceId: string): boolean {
    const subs = this.subscribers.get(instanceId);
    return subs != null && subs.size > 0;
  }

  // Returns true when instanceId was the *target* of a wake that fired
  // this synchronous event-dispatch cycle (populated before subscribers clears).
  wasConsumed(instanceId: string): boolean {
    return this._justConsumed.has(instanceId);
  }

  // Is `callerInstanceId` waiting on `targetInstanceId` right now — either still
  // ARMED, or armed at the turn_end being dispatched (this hub's listener
  // runs FIRST, so by the time the renew controller expires a request the delivered
  // wake is already out of `subscribers`; `_justConsumed` is that record).
  // On the only production trigger — a `turn_end`, where `_onTurnEnd` marks
  // `_justConsumed` with the whole armed-owner set before its defer check — the
  // second disjunct subsumes the first. The first is what keeps a DIRECT call
  // correct: `noteRenewalDeclined` is public on `InstanceManagerLike`, and called
  // outside a turn_end dispatch (`_justConsumed` empty) only it is true. That path
  // has no production caller today; it is exercised by
  // tests/renew-session.test.mjs → "a decline note is recorded only for a conductor
  // that is waiting, and dies with the wait", which is why both disjuncts stay.
  _isWaitingOn(targetInstanceId: string, callerInstanceId: string): boolean {
    return (this.subscribers.get(targetInstanceId)?.has(callerInstanceId) ?? false)
      || (this._justConsumed.get(targetInstanceId)?.has(callerInstanceId) ?? false);
  }

  // Read AND delete the note for one caller/target pair — a note belongs to exactly
  // ONE wake. Every path that ends a caller's wait calls this (delivery, a dead
  // caller, disarmSilently, purge), so a recorded note can never linger and
  // mis-report on a later, unrelated wake.
  _takeDecline(targetInstanceId: string, callerInstanceId: string): string | null {
    const notes = this._pendingDeclines.get(targetInstanceId);
    if (!notes) return null;
    const note = notes.get(callerInstanceId) ?? null;
    notes.delete(callerInstanceId);
    if (notes.size === 0) this._pendingDeclines.delete(targetInstanceId);
    return note;
  }

  // Returns true when instanceId is the *caller* (conductor) of any ARMED wake —
  // i.e. one of its sessions is mid-turn right now and it is due a report when
  // that turn ends. This is what the sidebar's accent idle dot reads (surfaced as
  // `awaitingWake`), and it stays true across a heartbeat, because a heartbeat
  // reports without consuming.
  isCaller(instanceId: string): boolean {
    for (const callers of this.subscribers.values()) {
      if (callers.has(instanceId)) return true;
    }
    return false;
  }

  // The sessionIds of every target callerInstanceId OWNS — i.e. every session
  // whose next turn will wake it. Reports OWNED rather than currently-armed
  // deliberately: the armed set is empty whenever a target is idle, which would
  // gut `renew_session`'s "never orphan a worker" safety net (src/sessionRenew.ts)
  // precisely in the case it exists for. Owned is a strict superset of armed.
  // instanceId-keyed throughout, since the caller's renewal already has direct
  // instanceId access with no sessionId round-trip.
  ownedWakeTargetsOf(callerInstanceId: string): string[] {
    const out: string[] = [];
    for (const targetId of this.manager.byId.keys()) {
      if (targetId === callerInstanceId) continue;
      if (!this.ownersOf(targetId).includes(callerInstanceId)) continue;
      out.push(this.manager.byId.get(targetId)?.sessionId ?? targetId);
    }
    return out;
  }
}
