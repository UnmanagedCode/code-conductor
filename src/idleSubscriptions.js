// Idle-subscription graph, extracted from InstanceManager as a composed
// collaborator. This is the orchestrator's dispatch-and-wake lifeline: a
// conductor calls `subscribe_to_idle` (MCP) on a worker's sessionId, and when
// that worker's next `turn_end` fires, a wake-stub user prompt is injected into
// the conductor so it re-wakes and inspects the result. An idle conductor gets
// the worker's recent output folded into the stub; a conductor that is itself
// mid-turn gets a plain stub delivered live into its running turn as a steering
// callback.
//
// Keyed by sessionId (NOT instanceId) so the graph survives respawn / restart.
// One-shot: a subscription is consumed when it fires (turn_end OR the optional
// timeout watchdog), whichever lands first. Cross-instance lookups
// (idsForSession / byId / liveForSession) and event emission go through the
// owning InstanceManager passed in at construction.

import { buildRecentMessages } from './mcp/handlers.js';
import { flattenPayload } from './mcp/content.js';
import { buildWakeStub, markPlainStub } from '../public/wakeCallback.js';

// Default watchdog for EVERY idle subscription. Delivery is deferred until the
// worker's turn ends AND all its background subagents have finished (see
// onTurnEnd), so a subscription with no explicit timeout could otherwise hang
// forever on a stuck/hung subagent. This guarantees the "always has a timeout"
// safety net — a subscription with no caller-supplied timeoutMs still eventually
// wakes the conductor with the non-completion "did NOT finish" stub. Tunable via
// ORCH_SUBSCRIBE_TIMEOUT_MS; an explicit finite subscribe timeoutMs wins.
const DEFAULT_SUBSCRIBE_TIMEOUT_MS = Number(process.env.ORCH_SUBSCRIBE_TIMEOUT_MS) || 1_800_000;

export class IdleSubscriptionHub {
  constructor(manager) {
    this.manager = manager;
    // One-shot idle subscriptions: when target hits turn_end, deliver
    // a stub user prompt to every registered caller and clear the set.
    // Keyed by targetSessionId → Map<callerSessionId, { timerId: Timeout | null }>.
    // sessionId (not instanceId) so the graph survives respawn / restart.
    this.subscribers = new Map();
    // Short-lived set populated in onTurnEnd() BEFORE subscribers is cleared,
    // so the synchronously-following wsHub turn_notification handler can read it.
    // A queueMicrotask cleanup runs after both synchronous listeners complete.
    this._justConsumed = new Set();
  }

  // Driven by InstanceManager's `event` listener. When a target instance's
  // turn_end fires, deliver to every caller subscribed to its sessionId and
  // consume the subscription set (cancelling each watchdog — turn_end won).
  //
  // Deferral: a backgrounded Agent-tool call resolves its tool_result
  // immediately (isAsync:true), so a worker's turn_end can fire while it still
  // has live subagents (Instance._activeAgentTasks non-empty). We want the wake
  // to mean "the agent AND all its subagents finished," so we DEFER for either
  // of two reasons, keeping the subscription (and its watchdog) armed:
  //   1. activeAgentTaskCount > 0 — a subagent is still running.
  //   2. subagentCompletedThisTurn — a subagent's terminal task_notification
  //      fired DURING the turn now ending. Its completion decrements the count
  //      to 0 before this turn_end, but the CLI still owes the worker an
  //      unprompted re-invocation turn to process the result (an init/turn
  //      nobody prompted). Firing here would wake the caller one turn early
  //      (the observed bug), so we wait for that re-invocation turn's turn_end.
  // A completion between turns (worker idle) does NOT set the flag: the
  // immediate re-invocation turn IS its processing turn, and its turn_end
  // fires the wake correctly. _setStatus resets the flag at each turn start, so
  // it only reflects completions during the turn now ending. A never-finishing
  // (or never-re-invoked) subagent is caught by the watchdog (always armed).
  onTurnEnd({ id: targetInstanceId, ev }) {
    if (ev?.kind !== 'turn_end') return;
    // The event payload carries the instanceId; resolve the live instance and
    // its sessionId, which is what the subscription graph is keyed by.
    const target = this.manager.byId.get(targetInstanceId);
    const tSid = target?.sessionId;
    const subs = tSid && this.subscribers.get(tSid);
    if (!subs || subs.size === 0) return;
    // Mark BEFORE the defer check / clearing so the wsHub 'event' listener
    // (registered after this one in server.js: new InstanceManager() then
    // attachWsHub()) can still detect that tSid had a watcher when its turn_end
    // fired — on the deferred intermediate turn_end as well as the final one, so
    // the worker's turn_notification stays suppressed across the whole deferral.
    this._justConsumed.add(tSid);
    queueMicrotask(() => this._justConsumed.delete(tSid));
    // Defer while background subagents are still running OR one completed during
    // this turn (a re-invocation turn is still owed) — keep the subscription and
    // its watchdog armed; a later turn_end with both clear delivers. `target` is
    // a live Instance here (a falsy `subs` above already returned when it was
    // absent), so the getters are always present.
    if (target.activeAgentTaskCount > 0 || target.subagentCompletedThisTurn) return;
    const entries = [...subs.entries()];
    subs.clear();
    this.subscribers.delete(tSid);
    for (const [callerSid, { timerId }] of entries) {
      clearTimeout(timerId); // cancel watchdog — turn_end arrived first
      this.deliver(callerSid, tSid);
    }
  }

  // Register a one-shot callback: when targetId's next turn_end fires (with no
  // live background subagents — see onTurnEnd), a stub user prompt lands in
  // callerId pointing at get_recent_messages. Re-subscribing the same pair
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
    // Both must resolve to a LIVE (proc-attached) instance.
    const isLive = (sid) => this.manager.idsForSession(sid).some(id => this.manager.byId.get(id)?.proc);
    if (!isLive(callerSessionId)) {
      throw new Error(`caller session not live: ${callerSessionId}`);
    }
    if (!isLive(targetSessionId)) {
      throw new Error(`target session not live: ${targetSessionId}`);
    }
    let subs = this.subscribers.get(targetSessionId);
    if (!subs) {
      subs = new Map();
      this.subscribers.set(targetSessionId, subs);
    }
    const already = subs.has(callerSessionId);
    if (!already) {
      const effTimeout = (typeof timeoutMs === 'number' && isFinite(timeoutMs) && timeoutMs > 0)
        ? timeoutMs
        : DEFAULT_SUBSCRIBE_TIMEOUT_MS;
      const timerId = setTimeout(() => {
        const s = this.subscribers.get(targetSessionId);
        if (s) {
          s.delete(callerSessionId);
          if (s.size === 0) this.subscribers.delete(targetSessionId);
        }
        this.manager.emit('subscription_changed', { targetId: targetSessionId });
        this.deliver(callerSessionId, targetSessionId, { timedOut: true, timeoutMs: effTimeout });
      }, effTimeout);
      timerId.unref?.(); // a lone watchdog must not keep the event loop alive
      subs.set(callerSessionId, { timerId });
      this.manager.emit('subscription_changed', { targetId: targetSessionId });
    }
    return { already };
  }

  // Cancel a pending subscription. Idempotent. Clears any watchdog timer.
  unsubscribe(callerSessionId, targetSessionId) {
    const subs = this.subscribers.get(targetSessionId);
    if (!subs) return { removed: false };
    const entry = subs.get(callerSessionId);
    if (!entry) return { removed: false };
    clearTimeout(entry.timerId);
    subs.delete(callerSessionId);
    if (subs.size === 0) this.subscribers.delete(targetSessionId);
    this.manager.emit('subscription_changed', { targetId: targetSessionId });
    return { removed: true };
  }

  // Snapshot of the current idle-subscription graph. Test-only — gives
  // tests a way to assert that purging on remove() actually happened.
  snapshot() {
    const out = {};
    for (const [target, callers] of this.subscribers) {
      out[target] = [...callers.keys()];
    }
    return out;
  }

  // Drop a sessionId from every subscription map (as caller) AND drop any
  // entry where it was the target. Clears watchdog timers. Called on instance
  // removal so dead sessions can't accumulate subscriptions. Guards null
  // sessionId (an instance may exit before ever minting one).
  purge(sessionId) {
    if (!sessionId) return;
    const asTarget = this.subscribers.get(sessionId);
    if (asTarget) {
      for (const [, { timerId }] of asTarget) clearTimeout(timerId);
      this.subscribers.delete(sessionId);
    }
    for (const [target, subs] of this.subscribers) {
      const entry = subs.get(sessionId);
      if (entry) {
        clearTimeout(entry.timerId);
        subs.delete(sessionId);
        if (subs.size === 0) this.subscribers.delete(target);
      }
    }
  }

  deliver(callerSessionId, targetSessionId, opts) {
    // Resolve the live caller instance from its sessionId.
    const caller = this.manager.liveForSession(callerSessionId);
    if (!caller) return; // caller gone — drop silently.
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

  hasSubscriber(sessionId) {
    const subs = this.subscribers.get(sessionId);
    return subs != null && subs.size > 0;
  }

  // Returns true when sessionId was the *target* of a subscription that fired
  // this synchronous event-dispatch cycle (populated before subscribers clears).
  wasConsumed(sessionId) {
    return this._justConsumed.has(sessionId);
  }

  // Returns true when sessionId is the *caller* (conductor) in any pending
  // subscription — i.e. this session is actively waiting for a worker to finish.
  isCaller(sessionId) {
    for (const callers of this.subscribers.values()) {
      if (callers.has(sessionId)) return true;
    }
    return false;
  }
}
