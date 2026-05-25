// Builds the inline `--settings` JSON the orchestrator passes to every
// claude subprocess. PreToolUse hooks:
//
//   1. A static `command` deny on AskUserQuestion: the CLI auto-errors
//      this tool in stream-json --print mode anyway (no canUseTool
//      callback to satisfy), so we deny with a friendlier reason and
//      let the orchestrator collect the answers via the regular UI
//      card + feed them as the next user prompt.
//
//   2. (When hookCallbackUrl is provided) An interactive `http` hook
//      on the destructive tools *and* ExitPlanMode. The orchestrator's
//      hook-callback endpoint auto-allows for the destructive tools in
//      non-ask modes, surfaces a permission_request in ask mode, and
//      holds open / auto-approves / awaits user click for ExitPlanMode.
//      Routing by tool name lives in src/hookBroker.js.
//
//   3. Fallback when hookCallbackUrl is null (rare — primarily test
//      edge cases): ExitPlanMode is added to the command-deny matcher
//      so the model doesn't actually exit plan mode without
//      orchestrator awareness.
//
// All inputs are pure JS values — no Instance state involved.

const HOOK_DENY_REASON_BLOCKING_TOOL =
  'Awaiting user input via the orchestrator UI — please stop and wait for the next user message.';

// Tools gated by the interactive PreToolUse http hook. Edit/Write/
// NotebookEdit/Bash are gated only in ask mode; ExitPlanMode is gated
// in plan mode (held open until the user approves or auto-approve
// fires). Reads (Read|Glob|Grep|LS|WebFetch|WebSearch) are NOT gated
// so the model can explore freely without a prompt per call.
const HTTP_HOOK_TOOL_MATCHER = 'Edit|Write|NotebookEdit|Bash|ExitPlanMode';

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
  // AskUserQuestion always goes through the static command-deny path:
  // the CLI cannot run an interactive question in --print mode, so
  // there's nothing the http hook could buy us.
  const commandDenyMatcher = hookCallbackUrl
    ? 'AskUserQuestion'
    : 'AskUserQuestion|ExitPlanMode';
  const preToolUse = [{
    matcher: commandDenyMatcher,
    hooks: [{
      type: 'command',
      timeout: 5,
      command: buildBlockingToolHookCommand(),
    }],
  }];
  if (hookCallbackUrl) {
    preToolUse.push({
      matcher: HTTP_HOOK_TOOL_MATCHER,
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
  HTTP_HOOK_TOOL_MATCHER,
  buildBlockingToolHookCommand,
};
