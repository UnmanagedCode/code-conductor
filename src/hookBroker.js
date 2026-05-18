// Per-instance broker for the PreToolUse http hook callback. Owns the
// pending-callback map + timeout plumbing + JSON response helpers, so
// none of that needs to clutter the Instance class. The broker only
// reaches back into the Instance via the two callbacks it's
// constructed with — getMode() and emit(ev) — keeping the dependency
// arrow one-way.

// Server-side timeout for a pending interactive hook callback. Must
// be safely under HOOK_HTTP_TIMEOUT_S (in settings.js) so we always
// respond before the CLI gives up — an HTTP timeout on its side =
// non-blocking error = the tool proceeds, which is the opposite of
// what we want here.
export const HOOK_PENDING_TIMEOUT_MS = 540_000;

function hookResponseBody(decision, reason) {
  const out = { hookSpecificOutput: { hookEventName: 'PreToolUse', permissionDecision: decision } };
  if (reason) out.hookSpecificOutput.permissionDecisionReason = reason;
  return out;
}

function respondAllow(res) {
  if (!res || res.headersSent) return;
  res.status(200).json(hookResponseBody('allow'));
}

function respondDeny(res, reason) {
  if (!res || res.headersSent) return;
  res.status(200).json(hookResponseBody('deny', reason));
}

export class HookBroker {
  // getMode(): the orchestrator-tracked mode ('plan' | 'ask' | 'bypassPermissions').
  //            The broker auto-allows everything when mode !== 'ask'.
  // emit(ev):  pushes a UI event (typically a permission_request /
  //            permission_resolved card) through the instance's normal
  //            ring + WS path.
  // pendingTimeoutMs: override for tests; defaults to the production value.
  constructor({ getMode, emit, pendingTimeoutMs = HOOK_PENDING_TIMEOUT_MS }) {
    if (typeof getMode !== 'function') throw new Error('HookBroker requires getMode()');
    if (typeof emit !== 'function') throw new Error('HookBroker requires emit()');
    this._getMode = getMode;
    this._emit = emit;
    this._pendingTimeoutMs = pendingTimeoutMs;
    this._pending = new Map(); // toolUseId -> { res, timer, toolName }
  }

  // Called by the REST hook-callback handler. Either auto-allows
  // (non-ask modes / malformed envelope) or holds the response open
  // and emits a permission_request so the UI can render the Allow /
  // Deny card.
  handle(envelope, res) {
    const toolUseId = envelope?.tool_use_id;
    const toolName = envelope?.tool_name;
    const mode = this._getMode();
    if (mode !== 'ask') {
      respondAllow(res);
      return;
    }
    if (!toolUseId) {
      // Defensive — without a tool_use_id we can't correlate a later
      // decision back to this pending response. Auto-allow so the user
      // isn't silently blocked by a malformed hook envelope.
      respondAllow(res);
      return;
    }
    this._emit({
      kind: 'permission_request',
      toolUseId,
      toolName,
      toolInput: envelope?.tool_input ?? {},
    });
    const timer = setTimeout(() => {
      const pending = this._pending.get(toolUseId);
      if (!pending) return;
      this._pending.delete(toolUseId);
      respondDeny(pending.res, 'user did not respond in time');
      this._emit({ kind: 'permission_resolved', toolUseId, allow: false, reason: 'timeout' });
    }, this._pendingTimeoutMs);
    // Don't keep the event loop alive just for this timer — server
    // shutdown should finish even if a permission card is sitting idle.
    if (typeof timer.unref === 'function') timer.unref();
    this._pending.set(toolUseId, { res, timer, toolName });
  }

  // Called when the user clicks Allow / Deny in the UI. Returns true
  // if there was a matching pending callback to resolve, false if not
  // (so the WS hub can ack with an error).
  resolve(toolUseId, allow) {
    const pending = this._pending.get(toolUseId);
    if (!pending) return false;
    clearTimeout(pending.timer);
    this._pending.delete(toolUseId);
    if (allow) respondAllow(pending.res);
    else respondDeny(pending.res, 'user denied via orchestrator UI');
    this._emit({ kind: 'permission_resolved', toolUseId, allow: !!allow });
    return true;
  }

  // Drain every pending callback with a deny. Called when the parent
  // instance exits — the CLI is gone so the tool won't run anyway, but
  // we still need to free the held-open HTTP responses and tell any
  // subscribed UI tabs that the cards are done.
  discardAll(reason = 'instance exited before user responded') {
    for (const [toolUseId, pending] of this._pending) {
      clearTimeout(pending.timer);
      respondDeny(pending.res, reason);
      this._emit({ kind: 'permission_resolved', toolUseId, allow: false, reason: 'exited' });
    }
    this._pending.clear();
  }

  // Test helper — count of in-flight pending callbacks.
  get pendingCount() { return this._pending.size; }
}
