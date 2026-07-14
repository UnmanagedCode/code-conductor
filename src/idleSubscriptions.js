// Idle-subscription graph, extracted from InstanceManager as a composed
// collaborator. This is the orchestrator's dispatch-and-wake lifeline: a
// conductor calls `subscribe_to_idle` (MCP) on a worker's sessionId, and when
// that worker's next `turn_end` fires, a wake-stub user prompt is injected into
// the conductor so it re-wakes and inspects the result. An idle conductor gets
// the worker's recent output folded into the stub; a conductor that is itself
// mid-turn gets a plain stub delivered live into its running turn as a steering
// callback.
//
// Keyed internally by the stable `instanceId` (NOT the rotating sessionId): the
// event stream carries the instanceId, and an in-place `/clear` rotates a
// session's sessionId while keeping its instanceId, so instanceId keying needs
// no migration across a rotation. sessionId lives only at the boundary — the
// MCP-supplied args to subscribe()/unsubscribe() (translated to instanceId on
// entry), the sessionId woven into the wake stub in deliver(), and the
// sessionId-shaped debug view from snapshot(). A subscription is NOT persisted
// and is purged on remove(), so there is nothing to "survive a restart."
// One-shot: a subscription is consumed when it fires — by whichever of THREE
// trigger paths lands first:
//   1. turn_end (the classic path — see _onTurnEnd and its defer gate),
//   2. the idle task-drain settle (_onTaskEvent/_fireSettle — a background
//      task finishing while the worker is already idle, with NO re-invocation
//      turn ever coming, e.g. a nested Monitor whose completion is the last
//      thing the stream says),
//   3. the timeout watchdog.
// Cross-instance lookups (idsForSession / byId / liveForSession) and event
// emission go through the owning InstanceManager passed in at construction.

import { buildRecentMessages } from './mcp/handlers.js';
import { flattenPayload } from './mcp/content.js';
import { buildWakeStub, markPlainStub } from '../public/wakeCallback.js';

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

export class IdleSubscriptionHub {
  constructor(manager) {
    this.manager = manager;
    // One-shot idle subscriptions: when target hits turn_end, deliver
    // a stub user prompt to every registered caller and clear the set.
    // Keyed by targetInstanceId → Map<callerInstanceId, { timerId: Timeout | null }>.
    this.subscribers = new Map();
    // Short-lived set of targetInstanceIds populated in _onTurnEnd() BEFORE
    // subscribers is cleared, so the synchronously-following wsHub
    // turn_notification handler can read it. A queueMicrotask cleanup runs after
    // both synchronous listeners complete. turn_end-ONLY by contract: the settle
    // path never touches it (a settle fires while the worker is idle with a
    // frozen stream, so no worker turn_notification exists to suppress).
    this._justConsumed = new Set();
    // Pending idle task-drain settles, keyed by targetInstanceId →
    // { timerId, proc, armSeq }. `proc` pins the arm to a specific subprocess
    // run (respawn/rewind reuse the Instance AND its instanceId but mint a new
    // proc and reset the ring, so seq comparisons across runs are meaningless);
    // `armSeq` is the ring's nextSeq at arm time, so `nextSeq === armSeq` at
    // fire time means literally zero events of any kind arrived since the
    // arming task event.
    this._pendingSettles = new Map();
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
  onEvent({ id, ev }) {
    if (ev?.kind === 'turn_end') {
      this._onTurnEnd(id);
    } else if (ev?.kind === 'system'
        && (ev.subtype === 'task_updated' || ev.subtype === 'task_notification')) {
      this._onTaskEvent(id);
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
  //      instances.js) means the notification is still queued and the CLI WILL
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
  _onTurnEnd(targetInstanceId) {
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
    // (registered after this one in server.js: new InstanceManager() then
    // attachWsHub()) can still detect that the target had a watcher when its
    // turn_end fired — on the deferred intermediate turn_end as well as the
    // final one, so the worker's turn_notification stays suppressed across the
    // whole deferral.
    this._justConsumed.add(targetInstanceId);
    queueMicrotask(() => this._justConsumed.delete(targetInstanceId));
    // Defer while background subagents are still running OR an unconsumed
    // mid-turn task notification means a re-invocation turn is still owed —
    // keep the subscription and its watchdog armed; a later turn_end with both
    // clear delivers. `target` is a live Instance here (a falsy `subs` above
    // already returned when it was absent), so the getters are always present.
    if (target.activeAgentTaskCount > 0 || target.taskNotificationPending) return;
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
  _onTaskEvent(targetInstanceId) {
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
  _fireSettle(targetInstanceId) {
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

  // Cancel the pending settle for a target instance, if any. Idempotent.
  _cancelSettle(targetInstanceId) {
    const pending = this._pendingSettles.get(targetInstanceId);
    if (!pending) return;
    clearTimeout(pending.timerId);
    this._pendingSettles.delete(targetInstanceId);
  }

  // Drop every pending settle. Test teardown hook — suites that reach into
  // the subscriber map directly need a way to also drop the (unref'd) timers
  // so a stale settle can't fire into a later test's manager state.
  _cancelAllSettles() {
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
  subscribe(callerSessionId, targetSessionId, timeoutMs) {
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
  unsubscribe(callerSessionId, targetSessionId) {
    const callerInstanceId = this.manager.liveForSession(callerSessionId)?.id ?? null;
    const targetInstanceId = this.manager.liveForSession(targetSessionId)?.id ?? null;
    if (!callerInstanceId || !targetInstanceId) return { removed: false };
    const subs = this.subscribers.get(targetInstanceId);
    if (!subs) return { removed: false };
    const entry = subs.get(callerInstanceId);
    if (!entry) return { removed: false };
    clearTimeout(entry.timerId);
    subs.delete(callerInstanceId);
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
  snapshot() {
    const sid = (id) => this.manager.byId.get(id)?.sessionId ?? id;
    const out = {};
    for (const [targetId, callers] of this.subscribers) {
      out[sid(targetId)] = [...callers.keys()].map(sid);
    }
    return out;
  }

  // Drop an instanceId from every subscription map (as caller) AND drop any
  // entry where it was the target. Clears watchdog timers. Called on instance
  // removal so dead instances can't accumulate subscriptions. Guards a falsy id.
  purge(instanceId) {
    if (!instanceId) return;
    this._cancelSettle(instanceId); // as target: drop any pending idle-drain settle
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

  deliver(callerInstanceId, targetInstanceId, opts) {
    // Resolve the live caller instance directly by instanceId.
    const caller = this.manager.byId.get(callerInstanceId);
    if (!caller || !caller.proc) return; // caller gone — drop silently.
    // Boundary: the stub names the worker by sessionId and points at
    // get_recent_messages (sessionId-addressed), so translate the target's
    // CURRENT sessionId here (a /clear-rotated target resolves to its new id).
    const targetSessionId = this.manager.byId.get(targetInstanceId)?.sessionId ?? targetInstanceId;
    // Fold the worker's recent output into the stub ONLY on a real turn_end
    // delivered to an already-idle caller. The timeout-watchdog path and the
    // live mid-turn steering path keep the plain pointer stub. Decided here,
    // synchronously, on the caller's status at delivery time.
    const fold = !opts?.timedOut && caller.status !== 'turn';
    const deliver = async () => {
      try {
        if (!caller.proc) return;
        const stub = fold
          ? await this._buildFoldedStub(targetSessionId)
          : this._plainStub(targetSessionId, opts);
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
          data: { line: `idle-callback delivery failed: ${err.message}` },
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
  _plainStub(targetSessionId, opts) {
    const summary = opts?.timedOut
      ? `Worker \`${targetSessionId}\` did NOT finish — timed out after ${opts.timeoutMs}ms; ` +
        `it may still be busy or stuck. ` +
        `Call \`mcp__code-conductor__get_recent_messages({sessionId:"${targetSessionId}"})\` ` +
        `to check its current state, then decide whether to resubscribe, ` +
        `call interrupt_turn, or escalate.`
      : `Worker \`${targetSessionId}\` finished its turn. ` +
        `Call \`mcp__code-conductor__get_recent_messages({sessionId:"${targetSessionId}"})\` ` +
        `to inspect the result.`;
    return markPlainStub(summary);
  }

  // The folded stub — reuses buildRecentMessages (the SAME selection/bonding a
  // default get_recent_messages call runs) and flattens it inline so the caller
  // doesn't need the follow-up MCP round-trip. Falls back to the plain stub on a
  // soft-refusal (e.g. the worker went away between turn_end and delivery).
  async _buildFoldedStub(targetSessionId) {
    const r = await buildRecentMessages({ sessionId: targetSessionId }, { instances: this.manager });
    if (r.soft) return this._plainStub(targetSessionId);
    return buildWakeStub({ targetSessionId, payloadText: flattenPayload(r.meta, r.bodies) });
  }

  hasSubscriber(instanceId) {
    const subs = this.subscribers.get(instanceId);
    return subs != null && subs.size > 0;
  }

  // Returns true when instanceId was the *target* of a subscription that fired
  // this synchronous event-dispatch cycle (populated before subscribers clears).
  wasConsumed(instanceId) {
    return this._justConsumed.has(instanceId);
  }

  // Returns true when instanceId is the *caller* (conductor) in any pending
  // subscription — i.e. this instance is actively waiting for a worker to finish.
  isCaller(instanceId) {
    for (const callers of this.subscribers.values()) {
      if (callers.has(instanceId)) return true;
    }
    return false;
  }
}
