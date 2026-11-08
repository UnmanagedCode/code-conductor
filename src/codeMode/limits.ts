// Every bound code mode owns, in one import-free module so the child process
// (runtimeApi.ts) and the server share one source. docs/code-mode.md → Bounds.

// run_code's wall clock. A sibling of clampBashTimeoutMs, not derived from it:
// the default sits above Claude Code's two-minute background threshold so a
// long script is not cut short, and the max bounds how long a forgotten child
// can live.
export const RUN_CODE_DEFAULT_TIMEOUT_MS = 300_000;
export const RUN_CODE_MAX_TIMEOUT_MS = 1_800_000;

// A non-number, non-finite or non-positive timeout is the default; anything
// above the max is clamped, never refused.
export function clampRunCodeTimeoutMs(timeout: unknown): number {
  if (typeof timeout !== 'number' || !Number.isFinite(timeout) || timeout <= 0) return RUN_CODE_DEFAULT_TIMEOUT_MS;
  return Math.min(timeout, RUN_CODE_MAX_TIMEOUT_MS);
}

// Claude Code aborts an HTTP MCP request whose response headers have not
// arrived within the per-server `timeout` (60 s when none is set). The
// `--mcp-config` entry cc writes carries this one, so cc's own timeout always
// fires first and answers `timedOut`.
export const RUN_CODE_TIMEOUT_GRACE_MS = 60_000;
export const CC_MCP_SERVER_TIMEOUT_MS = RUN_CODE_MAX_TIMEOUT_MS + RUN_CODE_TIMEOUT_GRACE_MS;

// What one run_code result may carry. Their sum plus RUN_META_HEADROOM stays
// inside MCP_RESULT_CHAR_BUDGET (src/mcp/content.ts), so the result backstop
// never fires for it.
export const RUN_RESULT_CAP = 24_000;
export const RUN_LOGS_CAP = 16_384;
export const RUN_ERROR_MESSAGE_CAP = 4_000;
export const RUN_META_HEADROOM = 2_048;

// Progress notifications for a streamed tools/call (src/mcp/callStream.ts).
export const PROGRESS_HEARTBEAT_MS = 30_000;
export const PROGRESS_MIN_INTERVAL_MS = 5_000;
export const PROGRESS_LINE_CAP = 200;

// describe_tools `summary` detail: the first sentence, cut here.
export const SUMMARY_CAP = 300;

// The agent-facing spelling of a millisecond bound, e.g. 300000 → "5 min".
export function describeDuration(ms: number): string {
  if (ms % 60_000 === 0) return `${ms / 60_000} min`;
  return `${Math.round(ms / 1000)} s`;
}
