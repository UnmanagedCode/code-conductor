// Idle-subscription graph, extracted from InstanceManager as a composed
// collaborator. This is the orchestrator's dispatch-and-wake lifeline: a
// conductor calls `subscribe_to_idle` (MCP) on a worker's sessionId, and when
// that worker's next `turn_end` fires, a wake-stub user prompt is injected into
// the conductor so it re-wakes and inspects the result.
//
// Keyed by sessionId (NOT instanceId) so the graph survives respawn / restart.
// One-shot: a subscription is consumed when it fires (turn_end OR the optional
// timeout watchdog), whichever lands first. Cross-instance lookups
// (idsForSession / byId / liveForSession) and event emission go through the
// owning InstanceManager passed in at construction.

import { buildRecentMessages } from './mcp/handlers.js';
import { flattenPayload } from './mcp/content.js';
import { buildWakeStub } from '../public/wakeCallback.js';

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
  onTurnEnd({ id: targetInstanceId, ev }) {
    if (ev?.kind !== 'turn_end') return;
    // The event payload carries the instanceId; resolve its sessionId, which
    // is what the subscription graph is keyed by.
    const tSid = this.manager.byId.get(targetInstanceId)?.sessionId;
    const subs = tSid && this.subscribers.get(tSid);
    if (!subs || subs.size === 0) return;
    const entries = [...subs.entries()];
    // Mark BEFORE clearing so the wsHub 'event' listener (registered after
    // this one in server.js: new InstanceManager() then attachWsHub()) can
    // still detect that tSid had a watcher when its turn_end fired.
    this._justConsumed.add(tSid);
    queueMicrotask(() => this._justConsumed.delete(tSid));
    subs.clear();
    this.subscribers.delete(tSid);
    for (const [callerSid, { timerId }] of entries) {
      clearTimeout(timerId); // cancel watchdog — turn_end arrived first
      this.deliver(callerSid, tSid);
    }
  }

  // Register a one-shot callback: when targetId's next turn_end fires,
  // a stub user prompt lands in callerId pointing at get_recent_messages.
  // Re-subscribing the same pair before the callback fires is a no-op.
  // Optional timeoutMs: arm a watchdog that fires the subscription early
  // (with a timeout-flagged stub) if turn_end hasn't arrived in time.
  // Only armed when timeoutMs is a finite number > 0; ignored otherwise.
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
      const useTimeout = typeof timeoutMs === 'number' && isFinite(timeoutMs) && timeoutMs > 0;
      let timerId = null;
      if (useTimeout) {
        timerId = setTimeout(() => {
          const s = this.subscribers.get(targetSessionId);
          if (s) {
            s.delete(callerSessionId);
            if (s.size === 0) this.subscribers.delete(targetSessionId);
          }
          this.manager.emit('subscription_changed', { targetId: targetSessionId });
          this.deliver(callerSessionId, targetSessionId, { timedOut: true, timeoutMs });
        }, timeoutMs);
      }
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
    // mid-turn (deferred) path keep the plain pointer stub — decided here,
    // synchronously, so the mid-turn deferral is honored even though the caller
    // is idle by the time the deferred send actually fires.
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
        // worker finishes).
        await caller.prompt(stub, [], { internal: true });
      } catch (err) {
        caller._emitUi({
          kind: 'system', subtype: 'stderr',
          data: { line: `idle-callback delivery failed: ${err.message}` },
        });
      }
    };
    if (caller.status === 'turn') {
      // Wait for the caller to finish its own turn before injecting the
      // stub, so we don't try to write to stdin while another turn is
      // in flight. One-shot listener.
      const onStatus = (s) => {
        if (s.status === 'turn' || s.status === 'spawning') return;
        caller.off('status', onStatus);
        if (s.status === 'idle') queueMicrotask(deliver);
        // exited/crashed → drop silently.
      };
      caller.on('status', onStatus);
      return;
    }
    queueMicrotask(deliver);
  }

  // The plain pointer stub — unchanged text for the timeout-watchdog path and
  // the mid-turn deferred path. Tells the caller to go call get_recent_messages.
  _plainStub(targetSessionId, opts) {
    return opts?.timedOut
      ? `Worker \`${targetSessionId}\` did NOT finish — timed out after ${opts.timeoutMs}ms; ` +
        `it may still be busy or stuck. ` +
        `Call \`mcp__code-conductor__get_recent_messages({sessionId:"${targetSessionId}"})\` ` +
        `to check its current state, then decide whether to resubscribe, ` +
        `call interrupt_turn, or escalate.`
      : `Worker \`${targetSessionId}\` finished its turn. ` +
        `Call \`mcp__code-conductor__get_recent_messages({sessionId:"${targetSessionId}"})\` ` +
        `to inspect the result.`;
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
