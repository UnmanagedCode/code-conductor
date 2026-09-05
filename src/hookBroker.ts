// Per-instance broker for the tool-hook http callbacks. Owns the
// pending-callback map + timeout plumbing + JSON response helpers, so
// none of that needs to clutter the Instance class. The broker only
// reaches back into the Instance via the callbacks it's
// constructed with — getMode(), emit(ev) and getRedirect() — keeping the
// dependency arrow one-way.
//
// It answers two hook events. `PreToolUse` is the original: auto-allow, or hold
// the response open behind an ask-mode permission card. `PostToolUse` exists
// only for a session redirected to another system, and carries the write-back
// note back to the model as `additionalContext` — the only channel there is,
// since a tool result can be annotated but never replaced.

import type { Response } from 'express';
import type { RedirectDecision } from './systems/toolRedirect.ts';

// Server-side timeout for a pending interactive hook callback. Must
// be safely under HOOK_HTTP_TIMEOUT_S (in settings.ts) so we always
// respond before the CLI gives up — an HTTP timeout on its side =
// non-blocking error = the tool proceeds, which is the opposite of
// what we want here.
export const HOOK_PENDING_TIMEOUT_MS = 540_000;

interface PreToolUseOutput {
  hookEventName: 'PreToolUse';
  permissionDecision: string;
  permissionDecisionReason?: string;
  // The rewritten tool input. Returned ALONGSIDE the allow, in one response —
  // which is what lets the ask card show the worker's original command while
  // the tool that actually runs is the redirected one.
  updatedInput?: Record<string, unknown>;
}

function hookResponseBody(
  decision: 'allow' | 'deny',
  reason?: string,
  updatedInput?: Record<string, unknown>,
): { hookSpecificOutput: PreToolUseOutput } {
  const out: { hookSpecificOutput: PreToolUseOutput } = {
    hookSpecificOutput: { hookEventName: 'PreToolUse', permissionDecision: decision },
  };
  if (reason) out.hookSpecificOutput.permissionDecisionReason = reason;
  if (updatedInput) out.hookSpecificOutput.updatedInput = updatedInput;
  return out;
}

function respondAllow(res: Response, updatedInput?: Record<string, unknown>): void {
  if (!res || res.headersSent) return;
  res.status(200).json(hookResponseBody('allow', undefined, updatedInput));
}

function respondDeny(res: Response, reason: string): void {
  if (!res || res.headersSent) return;
  res.status(200).json(hookResponseBody('deny', reason));
}

export interface HookEnvelope {
  hook_event_name?: unknown;
  tool_use_id?: unknown;
  tool_name?: unknown;
  tool_input?: unknown;
  tool_response?: unknown;
}

// What the broker needs from a redirected session, and nothing more. Satisfied
// structurally by SessionRedirect (src/systems/toolRedirect.ts), so the broker
// does not import the Systems layer's machinery to answer a hook.
export interface HookRedirector {
  preToolUse(toolName: string, toolInput: Record<string, unknown>): Promise<RedirectDecision>;
  // The note to attach to the tool result, or null for none.
  postToolUse(toolName: string, toolInput: Record<string, unknown>, toolResponse: unknown): Promise<string | null>;
}

// Tools a REDIRECTED session hooks for a reason other than permission, and
// which must therefore not raise an ask card. `Read` is here because its bytes
// have to be fetched from the system before the CLI opens the file; gating it
// would start prompting on reads that never prompted before. Scoped to
// redirected sessions: with no redirector attached the gate below tests no tool
// name at all. The exemption is this list and nothing else — a tool hooked
// later gates unless it is added here, rather than falling through a hole
// (card 2026-0339).
const REDIRECT_UNGATED_TOOLS = new Set(['Read']);

interface PendingCallback {
  res: Response;
  timer: NodeJS.Timeout;
  toolName: unknown;
  // Carried across the wait so the allow the user's click produces still
  // rewrites the tool input.
  updatedInput?: Record<string, unknown>;
}

export interface HookBrokerOptions {
  getMode: () => string;
  emit: (ev: unknown) => void;
  // The session's redirection policy, or null for a local project. A GETTER
  // because it is attached after the Instance is constructed and dropped when
  // the session ends.
  getRedirect?: () => HookRedirector | null;
  pendingTimeoutMs?: number;
}

export class HookBroker {
  // getMode(): the orchestrator-tracked mode ('plan' | 'ask' | 'bypassPermissions').
  //            The broker auto-allows everything when mode !== 'ask'.
  // emit(ev):  pushes a UI event (typically a permission_request /
  //            permission_resolved card) through the instance's normal
  //            ring + WS path.
  // pendingTimeoutMs: override for tests; defaults to the production value.
  private readonly _getMode: () => string;
  private readonly _emit: (ev: unknown) => void;
  private readonly _getRedirect: () => HookRedirector | null;
  private readonly _pendingTimeoutMs: number;
  private readonly _pending = new Map<unknown, PendingCallback>(); // toolUseId -> { res, timer, toolName }

  constructor({ getMode, emit, getRedirect, pendingTimeoutMs = HOOK_PENDING_TIMEOUT_MS }: HookBrokerOptions) {
    if (typeof getMode !== 'function') throw new Error('HookBroker requires getMode()');
    if (typeof emit !== 'function') throw new Error('HookBroker requires emit()');
    this._getMode = getMode;
    this._emit = emit;
    this._getRedirect = getRedirect ?? (() => null);
    this._pendingTimeoutMs = pendingTimeoutMs;
  }

  // Called by the REST hook-callback handler, for BOTH hook events — the CLI
  // posts them to one URL and `hook_event_name` discriminates.
  //
  // Synchronous entry point over an async body, because the caller is an
  // express handler that has already been handed the response to hold open.
  // Every path here answers `res` exactly once; a thrown redirector is answered
  // with a DENY, never with a fall-through allow, because allowing a rewrite
  // that failed to happen runs the worker's own command on the orchestrator's
  // machine.
  handle(envelope: HookEnvelope | null | undefined, res: Response): void {
    void this._handle(envelope, res).catch((e: unknown) => {
      respondDeny(res, `orchestrator: ${e instanceof Error ? e.message : String(e)}`);
    });
  }

  private async _handle(envelope: HookEnvelope | null | undefined, res: Response): Promise<void> {
    const redirect = this._getRedirect();
    const toolName = typeof envelope?.tool_name === 'string' ? envelope.tool_name : '';
    const toolInput = (envelope?.tool_input ?? {}) as Record<string, unknown>;

    if (envelope?.hook_event_name === 'PostToolUse') {
      // No permission decision exists for a completed tool: the only thing this
      // event can carry back is a note.
      const note = redirect ? await redirect.postToolUse(toolName, toolInput, envelope.tool_response) : null;
      if (!res.headersSent) {
        res.status(200).json(note ? { hookSpecificOutput: { hookEventName: 'PostToolUse', additionalContext: note } } : {});
      }
      return;
    }

    let updatedInput: Record<string, unknown> | undefined;
    if (redirect) {
      const decision = await redirect.preToolUse(toolName, toolInput);
      if (decision.decision === 'deny') {
        respondDeny(res, decision.reason ?? `orchestrator: ${toolName} is not available on this system`);
        return;
      }
      updatedInput = decision.updatedInput;
    }
    this._decide(envelope, res, toolName, !!redirect, updatedInput);
  }

  // The ask-mode gate: auto-allow outside ask mode, else hold the response open
  // behind a permission card. Unchanged in substance for a local session —
  // `redirected` is false there, so the condition below reduces to
  // `mode !== 'ask'` and no tool name is tested, exactly as before redirection
  // existed. The one deliberate difference is the redirect-scoped exemption
  // above, which applies only when a redirector is attached.
  private _decide(
    envelope: HookEnvelope | null | undefined,
    res: Response,
    toolName: string,
    redirected: boolean,
    updatedInput: Record<string, unknown> | undefined,
  ): void {
    const toolUseId = envelope?.tool_use_id;
    const mode = this._getMode();
    if (mode !== 'ask' || (redirected && REDIRECT_UNGATED_TOOLS.has(toolName))) {
      respondAllow(res, updatedInput);
      return;
    }
    if (!toolUseId) {
      // Defensive — without a tool_use_id we can't correlate a later
      // decision back to this pending response. Auto-allow so the user
      // isn't silently blocked by a malformed hook envelope.
      respondAllow(res, updatedInput);
      return;
    }
    // THE PRE-REWRITE INPUT, deliberately. Under redirection every Bash call is
    // rewritten into the same forwarder invocation, so a card built from what
    // the tool will actually run would render every command as one opaque line
    // and no two could be told apart. The broker holds both; the card gets the
    // one the worker asked for.
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
    this._pending.set(toolUseId, { res, timer, toolName, updatedInput });
  }

  // Called when the user clicks Allow / Deny in the UI. Returns true
  // if there was a matching pending callback to resolve, false if not
  // (so the WS hub can ack with an error).
  resolve(toolUseId: unknown, allow: boolean): boolean {
    const pending = this._pending.get(toolUseId);
    if (!pending) return false;
    clearTimeout(pending.timer);
    this._pending.delete(toolUseId);
    if (allow) respondAllow(pending.res, pending.updatedInput);
    else respondDeny(pending.res, 'user denied via orchestrator UI');
    this._emit({ kind: 'permission_resolved', toolUseId, allow: !!allow });
    return true;
  }

  // Drain every pending callback with a deny, for the cases where the parked
  // tool provably will never run: the parent instance exited (the CLI is gone)
  // or its turn was interrupted (Instance._releaseParkedPermissions). Either
  // way the held-open HTTP responses must be freed and subscribed UI tabs told
  // the cards are done. `reason` reaches the CLI as the deny reason; `event` is
  // the slug on the emitted permission_resolved (diagnostics — the client
  // renders the card from `allow` alone), so a reader can tell an exit-time
  // discard from an interrupt-time one.
  discardAll(reason = 'instance exited before user responded', event = 'exited'): void {
    for (const [toolUseId, pending] of this._pending) {
      clearTimeout(pending.timer);
      respondDeny(pending.res, reason);
      this._emit({ kind: 'permission_resolved', toolUseId, allow: false, reason: event });
    }
    this._pending.clear();
  }

  // In-flight pending callbacks. Read by Instance._blockedOnPermission (a tool
  // parked on a permission card must not hold an armed deferred interrupt) and
  // by tests.
  get pendingCount(): number { return this._pending.size; }
}
