// Builds the inline `--settings` JSON the orchestrator passes to every
// claude subprocess. One PreToolUse hook is registered:
//
//   - (Optional, when hookCallbackUrl is provided) An interactive
//     `http` hook on the destructive tools that POSTs back to the
//     orchestrator's hook-callback endpoint. The endpoint auto-allows
//     in non-ask modes, or surfaces a permission_request to the UI in
//     ask mode and holds the response open until the user clicks.
//
// The interactive tools (AskUserQuestion / ExitPlanMode / EnterPlanMode)
// are NO LONGER gated by a static PreToolUse deny hook. Under CLI 2.1.x
// they are enabled via `--permission-prompt-tool stdio` (see Instance.spawn)
// and gated at the `can_use_tool` control-request layer instead: the
// orchestrator answers with a `deny` control_response carrying
// AWAITING_INPUT_MESSAGE, which ends the turn so the existing plan_request /
// user_question card + approve_plan/reject_plan drive-forward path is
// unchanged. See Instance._handleStdoutLine.
//
// All inputs are pure JS values — no Instance state involved.

// Message returned to the model when the orchestrator denies an interactive
// tool's `can_use_tool` request — tells it to stop and wait for the user.
// Shared with the can_use_tool responder in instances.js.
export const AWAITING_INPUT_MESSAGE =
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

export function buildSettingsJSON({ hookCallbackUrl } = {}) {
  const preToolUse = [];
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
