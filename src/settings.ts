// Builds the inline `--settings` JSON the orchestrator passes to every
// claude subprocess. A PreToolUse hook is registered (when `hookCallbackUrl` is provided):
//
//   - (Optional, when hookCallbackUrl is provided) An `http` hook on the
//     mutating tools that POSTs back to the orchestrator's hook-callback
//     endpoint. The endpoint's HookBroker allows every local call and
//     applies the redirect policy to a redirected session's calls.
//
// The interactive tools (AskUserQuestion / ExitPlanMode / EnterPlanMode)
// are NO LONGER gated by a static PreToolUse deny hook. Under CLI 2.1.x
// they are enabled via `--permission-prompt-tool stdio` (see Instance.spawn)
// and gated at the `can_use_tool` control-request layer instead: the
// orchestrator answers with a `deny` control_response carrying
// AWAITING_INPUT_MESSAGE, leaving the existing plan_request / user_question card
// + approve_plan/reject_plan drive-forward path unchanged. The deny does not
// reliably end the turn — anything already queued in the CLI's stdin keeps it
// running. See Instance._handleStdoutLine.
//
// All inputs are pure JS values — no Instance state involved.

// Message returned to the model when the orchestrator denies an interactive
// tool's `can_use_tool` request — tells it the request was delivered despite
// the is_error flag, and to end its turn and wait for the reply.
// Shared with the can_use_tool responder in instances.ts.
export const AWAITING_INPUT_MESSAGE =
  'Delivered — the user can see your request in the orchestrator UI now. '
  + 'The tool result is flagged as an error only because the reply arrives asynchronously; the tool worked. '
  + 'Do not repeat the call, do not answer or decide it yourself, and do not start other work. '
  + "End your turn now with no further tool calls and wait for the user's reply; it arrives as a new message.";

// Earlier wordings of AWAITING_INPUT_MESSAGE that appear in persisted
// transcripts. The parser tags a tool_result matching any of them, or the
// current message, exactly as it does the current one.
export const EARLIER_AWAITING_INPUT_MESSAGES: readonly string[] = [
  'Awaiting user input via the orchestrator UI — please stop and wait for the next user message.',
  'Delivered — the user can see your request in the orchestrator UI now. '
    + 'The tool result is flagged as an error only because the reply arrives asynchronously; the tool worked. '
    + 'Do not repeat the call, do not answer or decide it yourself, and do not start other work. '
    + 'End your turn now with no further tool calls unless another message arrives meanwhile — '
    + "handle that one as normal; the user's reply comes as a later message.",
  'Delivered — the user can see your request in the orchestrator UI now. '
    + 'The tool result is flagged as an error only because the reply arrives asynchronously; the tool worked. '
    + 'Do not repeat the call, do not answer or decide it yourself, and do not start other work. '
    + "End your turn now with no further tool calls; the user's reply comes as a later message.",
];

// The mutating tools. Every local session registers the PreToolUse http hook
// on these and the broker allows them; the redirect matchers below build on
// this list.
const MUTATING_TOOL_MATCHER = 'Edit|Write|NotebookEdit|Bash';

// A session on a REMOTE system hooks three tools more. `Glob` and `Grep` are
// here as the SECOND guard described below.
//
// `Read` IS HOOKED, AND NOT TO GATE: the union puts a served path's bytes
// there, so no fetch is needed — but a Read aimed at a path the union does not
// serve to this session must meet cc's refusal rather than an -ENOENT a model
// reads as "the file is absent" (src/systems/fuse/tierTable.ts →
// classifyForTool). It is hooked to REFUSE.
//
// EXPORTED so a test can assert that every FILE_TOOLS key is in it: a fifth
// file tool must fail that assertion rather than silently escape the boundary.
export const REDIRECT_PRE_TOOL_MATCHER = `${MUTATING_TOOL_MATCHER}|Glob|Grep|Read`;

// AND ITS CONSUMER IS `SessionRedirect.postToolUse`, which reports a reconcile
// that refused AFTER the tool already returned success — the push cc issues
// from the daemon's `flush` can fail, and `additionalContext` is the only
// channel that puts that in front of the worker in band rather than in a log.
//
// `Read` IS ABSENT FROM THIS ONE and present in the pre-tool matcher above,
// and the asymmetry is the point: a read-only open pushes nothing, so it has
// no reconcile to report.
const REDIRECT_POST_TOOL_MATCHER = MUTATING_TOOL_MATCHER;

// The two tools that read the filesystem and CANNOT be redirected: a PreToolUse
// hook rewrites input, and there is no channel to substitute a result, so a
// Glob or a Grep would answer about the orchestrator's own filesystem — the
// project's config surface and nothing else. Answering about the wrong machine
// is the leak that costs a worker its trust in every other tool result; the
// model falls back to `find`/`grep` through the redirected Bash unprompted,
// which answers about the right one.
//
// MEASURED (claude 2.1.250, cc's exact launch flags): a headless `-p` session
// does not carry Glob or Grep in its tool registry at all, and `ToolSearch`
// cannot surface them — so today this denial removes nothing. It is kept
// because the tool profile is undocumented surface that has already moved once,
// and the redirection policy denies both BY NAME at the hook as well
// (src/systems/toolRedirect.ts). Two independent guards, because the invariant
// they protect — no tool answers about the wrong machine — is the one that
// makes the whole feature safe rather than merely convenient.
const REDIRECT_DENIED_TOOLS = ['Glob', 'Grep'];

// Per-hook timeout (seconds) for the http hooks. Generous because the redirect
// path needs the headroom: `SessionRedirect.postToolUse` awaits the daemon
// settle, and a CLI-side hook timeout is a non-blocking error — the CLI runs
// the tool with the unrewritten input.
export const HOOK_HTTP_TIMEOUT_S = 660;

// `redirect` marks a worker session whose project lives on another system
// (src/systems/toolRedirect.ts). It widens the hook surface rather than
// replacing it, so a local session's settings are byte-identical to what they
// were.
export function buildSettingsJSON({ hookCallbackUrl, redirect = false }: { hookCallbackUrl?: string; redirect?: boolean } = {}): string {
  const httpHook = (url: string) => [{ type: 'http', url, timeout: HOOK_HTTP_TIMEOUT_S }];
  const preToolUse: unknown[] = [];
  const out: Record<string, unknown> = { hooks: { PreToolUse: preToolUse } };
  if (hookCallbackUrl) {
    preToolUse.push({
      matcher: redirect ? REDIRECT_PRE_TOOL_MATCHER : MUTATING_TOOL_MATCHER,
      hooks: httpHook(hookCallbackUrl),
    });
    if (redirect) {
      (out.hooks as Record<string, unknown>).PostToolUse = [
        { matcher: REDIRECT_POST_TOOL_MATCHER, hooks: httpHook(hookCallbackUrl) },
      ];
    }
  }
  // Not `--disallowedTools`: that flag is variadic and swallows the following
  // prompt argument.
  if (redirect) out.permissions = { deny: REDIRECT_DENIED_TOOLS };
  // THE CLI'S DYNAMIC GIT INSTRUCTIONS, off for a redirected session.
  //
  // IT STAYS OFF. The CLI shells out to run that git itself, unmarked and
  // outside cc's remote-forwarded Bash tool — and an unmarked caller never
  // reaches the REMOTE working tree at all: it resolves in `VIEW_HOST`
  // (src/systems/fuse/policy.h), where the `project` pins are struck, so it is
  // served the ORCHESTRATOR's own file where the orchestrator has one and
  // `-ENOENT` where it has none. Neither is the
  // tree this session is working in, so the answer is wrong either way — and in
  // the shadowed case it is wrong about a DIFFERENT REPOSITORY. Guidance
  // derived from that is worse than none. The cwd chain changes only WHERE that
  // spawn dies: it starts, chdir's into the project root, and dies at its first
  // read of a remote file rather than at its chdir.
  //
  // Chosen over CLAUDE_CODE_DISABLE_GIT_INSTRUCTIONS: 2.1.250 reads that var as
  // `e !== undefined ? !e : settings.includeGitInstructions ?? true`, so "0"
  // disables while an EMPTY STRING re-enables — a footgun the moment anything
  // sets it to a computed value.
  if (redirect) out.includeGitInstructions = false;
  return JSON.stringify(out);
}

// Builds the inline `--mcp-config` JSON the orchestrator passes to every
// claude subprocess so the spawned session sees the orchestrator's own
// MCP server (mounted at POST /mcp) without a prior `claude mcp add`
// step. The server name must stay `code-conductor` — tool names are
// prefixed `mcp__code-conductor__*`, and changing the name would break any
// in-flight transcripts and tool-allowlist patterns.
export function buildMcpConfigJSON({ url, name = 'code-conductor' }: { url?: string; name?: string } = {}): string {
  return JSON.stringify({
    mcpServers: { [name]: { type: 'http', url } },
  });
}
