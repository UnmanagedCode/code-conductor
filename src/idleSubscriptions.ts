// Idle-subscription graph, extracted from InstanceManager as a composed
// collaborator. This is the orchestrator's dispatch-and-wake lifeline: a
// conductor calls `subscribe_to_idle` (MCP) on a worker's sessionId, and when
// that worker's next `turn_end` fires, a wake-stub user prompt is injected into
// the conductor so it re-wakes and inspects the result. An idle conductor gets
// the worker's recent output folded into the stub; a conductor that is itself
// mid-turn gets a plain stub delivered live into its running turn as a steering
// callback.
//
// Keyed internally by the stable `instanceId` (NOT a sessionId): the
// event stream carries the instanceId, and an in-place `/clear` rotates a
// session's sessionId while keeping its instanceId, so instanceId keying needs
// no migration across a rotation. sessionId lives only at the boundary — the
// MCP-supplied args to subscribe()/unsubscribe() (translated to instanceId on
// entry), the sessionId woven into the wake stub in deliver(), and the
// sessionId-shaped debug view from snapshot(). A subscription is NOT persisted
// and is purged on remove(), so there is nothing to "survive a restart."
// One-shot: a subscription is consumed when it fires — by whichever of FOUR
// trigger paths lands first:
//   1. turn_end (the classic path — see _onTurnEnd and its defer gate),
//   2. the idle task-drain settle (_onTaskEvent/_fireSettle — a background
//      task finishing while the worker is already idle, with NO re-invocation
//      turn ever coming, e.g. a nested Monitor whose completion is the last
//      thing the stream says),
//   3. rotation completion (_onRotationComplete — a rotation that comes up IDLE
//      with no turn at all, i.e. a prune; a renewal declares comesUpIdle:false
//      and is delivered by its reseed turn's turn_end instead),
//   4. the timeout watchdog.
// Cross-instance lookups (idsForSession / byId / liveForSession) and event
// emission go through the owning InstanceManager passed in at construction.

import { buildRecentMessages } from './mcp/handlers.ts';
import { flattenPayload } from './mcp/content.ts';
import { buildWakeStub, markPlainStub } from '../public/wakeCallback.js';
import type { InstanceManagerLike } from './instanceTypes.ts';
import type { UiEvent } from './parser.ts';

// Default watchdog for EVERY idle subscription. Delivery is deferred until the
// worker's turn ends AND all its background subagents have finished (see
// _onTurnEnd / _onTaskEvent), so a subscription with no explicit timeout could
// otherwise hang forever on a stuck/hung subagent. This guarantees the "always has a timeout"
// safety net — a subscription with no caller-supplied timeoutMs still eventually
// wakes the conductor with the non-completion "did NOT finish" stub. Tunable via
// ORCH_SUBSCRIBE_TIMEOUT_MS; an explicit finite subscribe timeoutMs wins.
const DEFAULT_SUBSCRIBE_TIMEOUT_MS = Number(process.env.ORCH_SUBSCRIBE_TIMEOUT_MS) || 1_800_000;

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
// while still waking ~360x sooner than the 30-min watchdog fallback.
const IDLE_DRAIN_SETTLE_MS = Number(process.env.ORCH_IDLE_DRAIN_SETTLE_MS) || 5_000;

// A subscription entry: the watchdog timer for a single caller→target pair.
interface SubscriptionEntry {
  timerId: NodeJS.Timeout;
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
  // One-shot idle subscriptions: when target hits turn_end, deliver
  // a stub user prompt to every registered caller and clear the set.
  // Keyed by targetInstanceId → Map<callerInstanceId, { timerId }>.
  subscribers: Map<string, Map<string, SubscriptionEntry>>;
  // Short-lived map of targetInstanceId → the callerInstanceIds that were watching
  // it, populated in _onTurnEnd() BEFORE subscribers is cleared, so the
  // synchronously-following wsHub turn_notification handler can read it (via
  // wasConsumed) and so a decline note can be attributed to a caller whose
  // subscription has already been consumed in this dispatch (see
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
  // subscription until the watchdog. Everything else is ignored, but note that
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
  // subscribed to it and consume the subscription set (cancelling each
  // watchdog — turn_end won).
  //
  // Deferral: a backgrounded Agent-tool call resolves its tool_result
  // immediately (isAsync:true), so a worker's turn_end can fire while it still
  // has live subagents (Instance._activeAgentTasks non-empty). We want the wake
  // to mean "the agent AND all its subagents finished, and no re-invocation
  // turn is still owed," so we DEFER for either of two reasons, keeping the
  // subscription (and its watchdog) armed:
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
  // caught by the watchdog (always armed).
  _onTurnEnd(targetInstanceId: string): void {
    // The event payload carries the instanceId — the graph's key directly.
    const target = this.manager.byId.get(targetInstanceId);
    if (!target) return;
    // A turn_end supersedes any pending idle-drain settle: either it consumes
    // the subscription right here, or its defer keeps the turn_end path in
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
    // keep the subscription and its watchdog armed; a later turn_end with both
    // clear delivers. `target` is a live Instance here (a falsy `subs` above
    // already returned when it was absent), so the getters are always present.
    // …and defer while a context ROTATION is in flight, for the same reason: the
    // turn_end being observed is the one the rotation was armed in, so firing here
    // would wake the caller with the pre-rotation state and spend the one-shot a
    // turn early. The window lives on the Instance (set at arm time, before this
    // can fire), so this defer works regardless of listener registration order —
    // which is what makes it correct without reordering the two listeners.
    // …and defer while a steer is parked on this target waiting for a block-edge
    // stop (a model that can't take a mid-turn injection — see
    // Instance.queueSteerAfterStop). The turn_end being observed is the one the
    // stop produced: the worker was CUT OFF to deliver the steer, it did not
    // finish, so spending the one-shot here would wake the conductor a turn early.
    // Same shape and same reason as rotationPending — the flag lives on the
    // Instance and is set in the send_prompt handler before the abort is even
    // armed, so this defer is independent of listener registration order.
    if (target.activeAgentTaskCount > 0 || target.taskNotificationPending
        || target.rotationPending || target.steerPending) return;
    const entries = [...subs.entries()];
    subs.clear();
    this.subscribers.delete(targetInstanceId);
    for (const [callerInstanceId, { timerId }] of entries) {
      clearTimeout(timerId); // cancel watchdog — turn_end arrived first
      this.deliver(callerInstanceId, targetInstanceId);
    }
  }

  // The idle task-drain settle path. Called on every task_updated /
  // task_notification event. If the event leaves a WATCHED target in the
  // fully-drained idle state — idle, zero live tasks, no re-invocation owed,
  // and an idle window containing nothing but task bookkeeping — it arms (or
  // re-arms) a settle timer. The timer delivers the wake only if the target's
  // stream stays COMPLETELY frozen for the whole window (_fireSettle); any
  // event at all — a re-invocation's init/status, a prompt echo, an exit —
  // means someone else owns the wake (turn_end or watchdog) and the settle
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
      // whatever was pending is stale. turn_end / watchdog own the wake.
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
  // of them drops the settle silently — the subscription and its watchdog stay
  // armed, so the worst wrong outcome here is "wake later than ideal", never
  // "wake one turn early" or "wake twice".
  _fireSettle(targetInstanceId: string): void {
    const pending = this._pendingSettles.get(targetInstanceId);
    this._pendingSettles.delete(targetInstanceId); // always self-clean, even on drop
    if (!pending) return;
    const subs = this.subscribers.get(targetInstanceId);
    if (!subs || subs.size === 0) return; // consumed meanwhile (turn_end/watchdog)
    const inst = this.manager.byId.get(targetInstanceId);
    if (!inst) return;
    // Same subprocess run: respawn/rewind mint a new proc (and reset the
    // ring), which would make the seq comparison below meaningless.
    if (inst.proc == null || inst.proc !== pending.proc) return;
    if (inst.status !== 'idle' || inst.activeAgentTaskCount > 0
        || inst.taskNotificationPending || inst.idleWindowDirty) return;
    // The freeze check: zero events of any kind since the arming task event.
    if (inst.ring?.nextSeq !== pending.armSeq) return;
    // Consume — the same shape as the watchdog path, but with the normal
    // "finished" stub. NOTE: _justConsumed is intentionally NOT marked (it is
    // turn_end-only; no worker turn_notification is in flight right now).
    const entries = [...subs.entries()];
    subs.clear();
    this.subscribers.delete(targetInstanceId);
    this.manager.emit('subscription_changed', { targetId: targetInstanceId });
    for (const [callerInstanceId, { timerId }] of entries) {
      clearTimeout(timerId); // cancel watchdog — the settle won
      this.deliver(callerInstanceId, targetInstanceId);
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
    for (const [callerInstanceId, { timerId }] of entries) {
      clearTimeout(timerId); // cancel watchdog — the rotation won
      this.deliver(callerInstanceId, targetInstanceId);
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
    // subscribe() does. A requester that is gone has nothing to be told.
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

  // Register a one-shot callback: when targetId next reaches "turn ended AND
  // all background subagents done" (via turn_end or the idle task-drain
  // settle), a stub user prompt lands in callerId pointing at
  // get_recent_messages. Re-subscribing the same pair
  // before the callback fires is a no-op.
  // A watchdog is ALWAYS armed: an explicit finite timeoutMs > 0 wins, otherwise
  // DEFAULT_SUBSCRIBE_TIMEOUT_MS. It fires the subscription early (with a
  // timeout-flagged "did NOT finish" stub) if the agent+subagents-done state is
  // never reached — the safety net for a hung subagent that would otherwise
  // defer forever. .unref()'d so a lone watchdog never keeps the process alive.
  subscribe(callerSessionId: string, targetSessionId: string, timeoutMs?: number): { already: boolean } {
    if (typeof callerSessionId !== 'string' || !callerSessionId) {
      throw new Error('callerSessionId required');
    }
    if (typeof targetSessionId !== 'string' || !targetSessionId) {
      throw new Error('targetSessionId required');
    }
    if (callerSessionId === targetSessionId) {
      throw new Error('cannot subscribe to self');
    }
    // Boundary translation: each sessionId (from the MCP ?caller= / target arg)
    // must resolve to a LIVE (proc-attached) instance; the graph is keyed by the
    // stable instanceId thereafter.
    const callerInstanceId = this.manager.liveForSession(callerSessionId)?.id ?? null;
    if (!callerInstanceId) {
      throw new Error(`caller session not live: ${callerSessionId}`);
    }
    const targetInstanceId = this.manager.liveForSession(targetSessionId)?.id ?? null;
    if (!targetInstanceId) {
      throw new Error(`target session not live: ${targetSessionId}`);
    }
    let subs = this.subscribers.get(targetInstanceId);
    if (!subs) {
      subs = new Map();
      this.subscribers.set(targetInstanceId, subs);
    }
    const already = subs.has(callerInstanceId);
    if (!already) {
      const effTimeout = (typeof timeoutMs === 'number' && isFinite(timeoutMs) && timeoutMs > 0)
        ? timeoutMs
        : DEFAULT_SUBSCRIBE_TIMEOUT_MS;
      const timerId = setTimeout(() => {
        const s = this.subscribers.get(targetInstanceId);
        if (s) {
          s.delete(callerInstanceId);
          if (s.size === 0) {
            this.subscribers.delete(targetInstanceId);
            // No watchers left — a pending idle-drain settle has nothing to
            // deliver to (its fire-time re-check would drop it; this is the
            // eager form so the map stays clean).
            this._cancelSettle(targetInstanceId);
          }
        }
        this.manager.emit('subscription_changed', { targetId: targetInstanceId });
        this.deliver(callerInstanceId, targetInstanceId, { timedOut: true, timeoutMs: effTimeout });
      }, effTimeout);
      timerId.unref?.(); // a lone watchdog must not keep the event loop alive
      subs.set(callerInstanceId, { timerId });
      this.manager.emit('subscription_changed', { targetId: targetInstanceId });
    }
    return { already };
  }

  // Cancel a pending subscription. Idempotent. Clears any watchdog timer.
  // sessionId args are translated to instanceId at the boundary; an endpoint
  // that no longer resolves to a live instance yields removed:false (it was
  // already purged on remove()).
  unsubscribe(callerSessionId: string, targetSessionId: string): { removed: boolean } {
    const callerInstanceId = this.manager.liveForSession(callerSessionId)?.id ?? null;
    const targetInstanceId = this.manager.liveForSession(targetSessionId)?.id ?? null;
    if (!callerInstanceId || !targetInstanceId) return { removed: false };
    const subs = this.subscribers.get(targetInstanceId);
    if (!subs) return { removed: false };
    const entry = subs.get(callerInstanceId);
    if (!entry) return { removed: false };
    clearTimeout(entry.timerId);
    subs.delete(callerInstanceId);
    this._takeDecline(targetInstanceId, callerInstanceId); // this wait is over
    if (subs.size === 0) {
      this.subscribers.delete(targetInstanceId);
      this._cancelSettle(targetInstanceId); // no watchers left
    }
    this.manager.emit('subscription_changed', { targetId: targetInstanceId });
    return { removed: true };
  }

  // Snapshot of the current idle-subscription graph, projected back to
  // sessionIds. Test/debug-only — the honest "which sessions subscribe to which"
  // view (internal keys are instanceIds). Falls back to the raw key if the
  // instance is already gone.
  snapshot(): Record<string, string[]> {
    const sid = (id: string): string => this.manager.byId.get(id)?.sessionId ?? id;
    const out: Record<string, string[]> = {};
    for (const [targetId, callers] of this.subscribers) {
      out[sid(targetId)] = [...callers.keys()].map(sid);
    }
    return out;
  }

  // Drop an instanceId from every subscription map (as caller) AND drop any
  // entry where it was the target. Clears watchdog timers. Called on instance
  // removal so dead instances can't accumulate subscriptions. Guards a falsy id.
  purge(instanceId: string): void {
    if (!instanceId) return;
    this._cancelSettle(instanceId); // as target: drop any pending idle-drain settle
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
      for (const [, { timerId }] of asTarget) clearTimeout(timerId);
      this.subscribers.delete(instanceId);
    }
    for (const [target, subs] of this.subscribers) {
      const entry = subs.get(instanceId);
      if (entry) {
        clearTimeout(entry.timerId);
        subs.delete(instanceId);
        if (subs.size === 0) {
          this.subscribers.delete(target);
          this._cancelSettle(target); // that target lost its last watcher
        }
      }
    }
  }

  // Sever every subscription edge touching a session the overage stop is stopping,
  // and return the instanceIds of the callers that lost a wait on it — the overage
  // stop marks each so its own resume prompt says the callbacks are gone.
  //
  // Keyed on the SUBSCRIPTION graph, not the conducted-ownership graph: subscribe()
  // imposes no ownership check, so a conductor can be waiting on a session it never
  // spawned. Keying on ownership left exactly that case armed — the stopped
  // session's turn_end delivered an `internal:true` wake, which the overage queue
  // intercept deliberately does NOT hold, and the caller started a fresh turn
  // inside the lockout.
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
    // delivered to an already-idle caller. The timeout-watchdog path and the
    // live mid-turn steering path keep the plain pointer stub. Decided here,
    // synchronously, on the caller's status at delivery time.
    // A STALE wake keeps the plain pointer stub too: folding a busy worker's
    // mid-flight output in would read as its finished result.
    const fold = !opts?.timedOut && !opts?.stale && caller.status !== 'turn';
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

  // The plain pointer stub — text for the timeout-watchdog path and the live
  // mid-turn steering path. Tells the caller to go call get_recent_messages.
  // Tagged with the wake marker (body-less, no WAKE_BODY_SEP) so the conductor
  // UI renders it as a wake bubble too — just the summary line, no fold.
  _plainStub(targetSessionId: string, opts?: DeliverOpts): string {
    const summary = opts?.timedOut
      ? `Worker \`${targetSessionId}\` did NOT finish — timed out after ${opts.timeoutMs}ms; ` +
        `it may still be busy or stuck. ` +
        `Call \`mcp__code-conductor__get_recent_messages({sessionId:"${targetSessionId}"})\` ` +
        `to check its current state, then decide whether to resubscribe, ` +
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

  hasSubscriber(instanceId: string): boolean {
    const subs = this.subscribers.get(instanceId);
    return subs != null && subs.size > 0;
  }

  // Returns true when instanceId was the *target* of a subscription that fired
  // this synchronous event-dispatch cycle (populated before subscribers clears).
  wasConsumed(instanceId: string): boolean {
    return this._justConsumed.has(instanceId);
  }

  // Is `callerInstanceId` waiting on `targetInstanceId` right now — either still
  // subscribed, or subscribed at the turn_end being dispatched (this hub's listener
  // runs FIRST, so by the time the renew controller expires a request the delivered
  // subscription is already out of `subscribers`; `_justConsumed` is that record).
  // On the only production trigger — a `turn_end`, where `_onTurnEnd` marks
  // `_justConsumed` with the whole subscriber set before its defer check — the
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
  // caller, unsubscribe, purge), so a recorded note can never linger and mis-report
  // on a later, unrelated wake.
  _takeDecline(targetInstanceId: string, callerInstanceId: string): string | null {
    const notes = this._pendingDeclines.get(targetInstanceId);
    if (!notes) return null;
    const note = notes.get(callerInstanceId) ?? null;
    notes.delete(callerInstanceId);
    if (notes.size === 0) this._pendingDeclines.delete(targetInstanceId);
    return note;
  }

  // Returns true when instanceId is the *caller* (conductor) in any pending
  // subscription — i.e. this instance is actively waiting for a worker to finish.
  isCaller(instanceId: string): boolean {
    for (const callers of this.subscribers.values()) {
      if (callers.has(instanceId)) return true;
    }
    return false;
  }

  // Inverse of snapshot(): the sessionIds of every target that callerInstanceId
  // currently has a pending subscription on. Used by the renewal state block
  // (src/sessionRenew.ts) — instanceId-keyed throughout, since the caller's
  // renewal already has direct instanceId access with no sessionId round-trip.
  subscriptionsOf(callerInstanceId: string): string[] {
    const out: string[] = [];
    for (const [targetId, callers] of this.subscribers) {
      if (callers.has(callerInstanceId)) {
        out.push(this.manager.byId.get(targetId)?.sessionId ?? targetId);
      }
    }
    return out;
  }
}
