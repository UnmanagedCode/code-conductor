// Builds the inline `--settings` JSON the orchestrator passes to every
// claude subprocess. Two PreToolUse hooks are registered:
//
//   1. A static `command` deny on AskUserQuestion|ExitPlanMode that
//      tells the model to stop and wait for the user. The CLI auto-
//      errors both tools in stream-json --print mode anyway (no SDK
//      `canUseTool` callback to satisfy), so we just give them a
//      friendlier deny reason. The orchestrator surfaces the
//      corresponding UI card and, on the user's decision, drives the
//      conversation forward via the next user prompt (plus, for plan
//      approval, a setMode(bypassPermissions) control_request first).
//
//   2. (Optional, when hookCallbackUrl is provided) An interactive
//      `http` hook on the destructive tools that POSTs back to the
//      orchestrator's hook-callback endpoint. The endpoint auto-allows
//      in non-ask modes, or surfaces a permission_request to the UI in
//      ask mode and holds the response open until the user clicks.
//
// All inputs are pure JS values — no Instance state involved.

const HOOK_DENY_REASON_BLOCKING_TOOL =
  'Awaiting user input via the orchestrator UI — please stop and wait for the next user message.';

// Destructive tools gated by the interactive PreToolUse http hook in
// ask mode. Reads (Read|Glob|Grep|LS|WebFetch|WebSearch) are NOT gated
// so the model can explore freely without a prompt per call.
const ASK_GATED_TOOL_MATCHER = 'Edit|Write|NotebookEdit|Bash';

// Per-hook timeout (seconds) for the interactive http hook. Generous —
// the CLI waits this long for the user to click Allow/Deny in the UI.
// The orchestrator's pending timeout (see hookBroker.js) resolves with
// a synthesised deny well before this fires; the headroom is just
// there to avoid the CLI cutting off a slow human.
export const HOOK_HTTP_TIMEOUT_S = 660;

// printf-friendly literal: single-quote the outer JSON so the shell
// doesn't interpolate, escape internal double-quotes by hand.
function buildBlockingToolHookCommand() {
  const reason = HOOK_DENY_REASON_BLOCKING_TOOL.replace(/"/g, '\\"');
  return `printf '%s' '{"hookSpecificOutput":{"hookEventName":"PreToolUse","permissionDecision":"deny","permissionDecisionReason":"${reason}"}}'`;
}

export function buildSettingsJSON({ hookCallbackUrl } = {}) {
  const preToolUse = [{
    matcher: 'AskUserQuestion|ExitPlanMode',
    hooks: [{
      type: 'command',
      timeout: 5,
      command: buildBlockingToolHookCommand(),
    }],
  }];
  if (hookCallbackUrl) {
    preToolUse.push({
      matcher: ASK_GATED_TOOL_MATCHER,
      hooks: [{
        type: 'http',
        url: hookCallbackUrl,
        timeout: HOOK_HTTP_TIMEOUT_S,
      }],
    });
  }
  return JSON.stringify({ hooks: { PreToolUse: preToolUse } });
}

// Builds the inline `--mcp-config` JSON the orchestrator passes to every
// claude subprocess so the spawned session sees the orchestrator's own
// MCP server (mounted at POST /mcp) without a prior `claude mcp add`
// step. The server name must stay `code-conductor` — tool names are
// prefixed `mcp__code-conductor__*`, and changing the name would break any
// in-flight transcripts and tool-allowlist patterns.
export function buildMcpConfigJSON({ url, name = 'code-conductor' } = {}) {
  return JSON.stringify({
    mcpServers: { [name]: { type: 'http', url } },
  });
}

// Exported for tests that want to assert the deny reason makes it
// into the rendered hookSpecificOutput.
export const _internal = {
  HOOK_DENY_REASON_BLOCKING_TOOL,
  ASK_GATED_TOOL_MATCHER,
  buildBlockingToolHookCommand,
};
