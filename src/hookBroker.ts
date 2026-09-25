// Per-instance answerer for the tool-hook http callbacks, plus the JSON
// response helpers, so none of that needs to clutter the Instance class. The
// broker only reaches back into the Instance via the getRedirect() callback
// it's constructed with, keeping the dependency arrow one-way.
//
// It answers two hook events. `PreToolUse`: a local session's calls are all
// allowed; a redirected session's calls follow the SessionRedirect policy —
// allow (optionally with a rewritten input), or deny — and a redirector that
// throws is answered with a deny. `PostToolUse` is registered only for a
// session redirected to another system and has no consumer today: the union
// writes through, so there is nothing to report back. It stays wired because
// the daemon's lazy per-open mirror pushes at `release`, which can fail AFTER
// the tool has already returned success, and `additionalContext` is the only
// channel that can put that in front of the worker in band — a tool result can
// be annotated but never replaced.

import type { Response } from 'express';
import type { RedirectDecision } from './systems/toolRedirect.ts';

interface PreToolUseOutput {
  hookEventName: 'PreToolUse';
  permissionDecision: string;
  permissionDecisionReason?: string;
  // The rewritten tool input. Returned ALONGSIDE the allow, in one response:
  // the CLI runs the tool with this input in place of the worker's own.
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

export interface HookBrokerOptions {
  // The session's redirection policy, or null for a local project. A GETTER
  // because it is attached after the Instance is constructed and dropped when
  // the session ends.
  getRedirect: () => HookRedirector | null;
}

export class HookBroker {
  private readonly _getRedirect: () => HookRedirector | null;

  constructor({ getRedirect }: HookBrokerOptions) {
    if (typeof getRedirect !== 'function') throw new Error('HookBroker requires getRedirect()');
    this._getRedirect = getRedirect;
  }

  // Called by the REST hook-callback handler, for BOTH hook events — the CLI
  // posts them to one URL and `hook_event_name` discriminates.
  //
  // Synchronous entry point over an async body, because the caller is an
  // express handler that has already been handed the response.
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
    respondAllow(res, updatedInput);
  }
}
