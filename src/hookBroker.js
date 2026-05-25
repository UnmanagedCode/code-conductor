// Per-instance broker for the PreToolUse http hook callback. Owns the
// pending-callback map + timeout plumbing + JSON response helpers, so
// none of that needs to clutter the Instance class. The broker only
// reaches back into the Instance via the callbacks it's constructed
// with — keeping the dependency arrow one-way.
//
// Two flavours of pending callback share the same map (keyed by
// toolUseId):
//
//   - `kind: 'permission'`   — destructive tool (Edit/Write/NotebookEdit
//                              /Bash) gated by ask mode. Resolution shape:
//                              { allow: boolean }.
//   - `kind: 'plan'`         — ExitPlanMode held open until the user
//                              approves / rejects via the UI, or
//                              auto-approve fires server-side. Resolution
//                              shape: { decision: 'approve'|'reject',
//                                       feedback: string }. Approve →
//                              respondAllow + flip orchestrator mode to
//                              bypassPermissions. Reject → respondDeny;
//                              the Instance follows up with a refinement
//                              prompt so the model gets the feedback.

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
  // getMode():              orchestrator-tracked mode ('plan' | 'ask' |
  //                         'bypassPermissions'). Used to gate ask-mode
  //                         destructive tools and to recognise plan
  //                         mode for ExitPlanMode.
  // emit(ev):               pushes a UI event through the instance's
  //                         normal ring + WS path.
  // getAutoApprovePlan():   server-side per-instance flag. When true
  //                         and mode === 'plan', an ExitPlanMode hook
  //                         is allowed without waiting for a click.
  // enterBypassMode():      called when ExitPlanMode is allowed.
  //                         Flips Instance.mode to bypassPermissions
  //                         (and the CLI's permission_mode in lockstep)
  //                         so subsequent destructive tools aren't
  //                         re-gated.
  // enrichPlan(envelope):   returns { plan, planPath } enriched with
  //                         the last `~/.claude/plans/*.md` the model
  //                         wrote, so the UI card shows the actual
  //                         plan text when the model wrote it to a
  //                         file before calling ExitPlanMode.
  // sendRefinement(text):   queues a follow-up user prompt — used when
  //                         the user rejects with feedback so the
  //                         model receives the refinement notes.
  // pendingTimeoutMs:       override for tests; defaults to the
  //                         production 540s.
  constructor({
    getMode, emit,
    getAutoApprovePlan = () => false,
    enterBypassMode = async () => {},
    enrichPlan = () => ({ plan: null, planPath: null }),
    sendRefinement = async () => {},
    pendingTimeoutMs = HOOK_PENDING_TIMEOUT_MS,
  }) {
    if (typeof getMode !== 'function') throw new Error('HookBroker requires getMode()');
    if (typeof emit !== 'function') throw new Error('HookBroker requires emit()');
    this._getMode = getMode;
    this._emit = emit;
    this._getAutoApprovePlan = getAutoApprovePlan;
    this._enterBypassMode = enterBypassMode;
    this._enrichPlan = enrichPlan;
    this._sendRefinement = sendRefinement;
    this._pendingTimeoutMs = pendingTimeoutMs;
    this._pending = new Map(); // toolUseId -> { kind, res, timer, toolName }
  }

  // Called by the REST hook-callback handler. Routes by tool name and
  // mode; either auto-allows, auto-denies, or holds the response open
  // until the user (or auto-approve) decides.
  handle(envelope, res) {
    const toolUseId = envelope?.tool_use_id;
    const toolName = envelope?.tool_name;
    if (toolName === 'ExitPlanMode') {
      this._handleExitPlanMode(envelope, res);
      return;
    }
    // Existing destructive-tool path (Edit/Write/NotebookEdit/Bash).
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
      if (!pending || pending.kind !== 'permission') return;
      this._pending.delete(toolUseId);
      respondDeny(pending.res, 'user did not respond in time');
      this._emit({ kind: 'permission_resolved', toolUseId, allow: false, reason: 'timeout' });
    }, this._pendingTimeoutMs);
    if (typeof timer.unref === 'function') timer.unref();
    this._pending.set(toolUseId, { kind: 'permission', res, timer, toolName });
  }

  _handleExitPlanMode(envelope, res) {
    const toolUseId = envelope?.tool_use_id;
    const mode = this._getMode();
    // ExitPlanMode is only meaningful in plan mode — if we're already
    // out of plan mode (e.g. a stray ExitPlanMode call after auto-
    // approve), allow it as a no-op so the model isn't stuck.
    if (mode !== 'plan') {
      respondAllow(res);
      return;
    }
    if (!toolUseId) {
      respondAllow(res);
      return;
    }
    // Auto-approve: respond allow immediately, flip orchestrator mode,
    // and emit plan_resolved with autoApproved:true so subscribed
    // clients can flip the card without any user interaction.
    if (this._getAutoApprovePlan()) {
      respondAllow(res);
      this._emit({ kind: 'plan_resolved', toolUseId, decision: 'approve', autoApproved: true });
      // Fire-and-forget — even if the mode flip fails we've already
      // allowed the tool, so the model continues either way.
      this._enterBypassMode().catch(() => {});
      return;
    }
    // Manual flow: hold the response open until the user clicks. The
    // parser-emitted plan_request event already painted the card; the
    // broker just owns the resolution side.
    const timer = setTimeout(() => {
      const pending = this._pending.get(toolUseId);
      if (!pending || pending.kind !== 'plan') return;
      this._pending.delete(toolUseId);
      respondDeny(pending.res, 'user did not respond to the plan in time — falling back to manual reprompt');
      // Tell subscribers the hook is gone. The card stays visible and
      // a later approve/reject click goes through the legacy
      // setMode+prompt path on the Instance.
      this._emit({ kind: 'plan_resolved', toolUseId, decision: 'timeout' });
    }, this._pendingTimeoutMs);
    if (typeof timer.unref === 'function') timer.unref();
    this._pending.set(toolUseId, { kind: 'plan', res, timer, toolName: 'ExitPlanMode' });
  }

  // Called when the user clicks Allow / Deny in the UI for an
  // ask-mode destructive tool. Returns true if there was a matching
  // pending callback to resolve, false if not (so the WS hub can ack
  // with an error).
  resolve(toolUseId, allow) {
    const pending = this._pending.get(toolUseId);
    if (!pending || pending.kind !== 'permission') return false;
    clearTimeout(pending.timer);
    this._pending.delete(toolUseId);
    if (allow) respondAllow(pending.res);
    else respondDeny(pending.res, 'user denied via orchestrator UI');
    this._emit({ kind: 'permission_resolved', toolUseId, allow: !!allow });
    return true;
  }

  // Called when the user (or auto-approve) decides on a held-open
  // ExitPlanMode hook. `decision` is 'approve' or 'reject';
  // `feedback` rides along on reject so the Instance can send a
  // refinement prompt afterwards. Returns true if a pending hook was
  // resolved, false if the hook already timed out (caller's signal to
  // fall back to the legacy setMode+prompt path).
  resolvePlan(toolUseId, decision, feedback = '') {
    const pending = this._pending.get(toolUseId);
    if (!pending || pending.kind !== 'plan') return false;
    clearTimeout(pending.timer);
    this._pending.delete(toolUseId);
    if (decision === 'approve') {
      respondAllow(pending.res);
      this._emit({ kind: 'plan_resolved', toolUseId, decision: 'approve' });
      this._enterBypassMode().catch(() => {});
    } else {
      respondDeny(pending.res, 'user rejected the plan via orchestrator UI');
      this._emit({ kind: 'plan_resolved', toolUseId, decision: 'reject' });
      // Send the refinement notes as a user prompt so the model gets
      // to see what the user wanted changed. The Instance is the
      // right place to format the prompt — we just hand off the text.
      const trimmed = typeof feedback === 'string' ? feedback.trim() : '';
      const refinementText = trimmed
        ? `I'd like to revise the plan. Refinement notes:\n${trimmed}`
        : "I'd like to revise the plan. Please refine it.";
      this._sendRefinement(refinementText).catch(() => {});
    }
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
      if (pending.kind === 'plan') {
        this._emit({ kind: 'plan_resolved', toolUseId, decision: 'exited' });
      } else {
        this._emit({ kind: 'permission_resolved', toolUseId, allow: false, reason: 'exited' });
      }
    }
    this._pending.clear();
  }

  // Test helper — count of in-flight pending callbacks.
  get pendingCount() { return this._pending.size; }
}
