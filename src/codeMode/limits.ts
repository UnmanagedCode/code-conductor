// Every bound code mode owns, in one import-free module so the child process
// (runtimeApi.ts) and the server share one source. docs/code-mode.md → Bounds.

// run_code's wall clock. A sibling of clampBashTimeoutMs, not derived from it:
// the default is long enough for a program that chains many calls, and the max
// bounds how long a forgotten child can live.
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

// What one run_code result may carry. The result's cut text is at most
// RUN_RESULT_MAX_CHARS (the cap plus its marker) and the logs RUN_LOGS_CAP; the
// error's message, name and code are capped on their JSON-escaped width (they
// ride in the metadata block). Those four plus RUN_META_HEADROOM stay inside
// MCP_RESULT_CHAR_BUDGET (src/mcp/content.ts), so the result backstop never
// fires for run_code.
export const RUN_RESULT_CAP = 24_000;
export const RUN_LOGS_CAP = 16_384;
export const RUN_ERROR_MESSAGE_CAP = 4_000;
// An error's `name` and `code` are short identifiers; cut at cc's boundary so a
// program posting its own outcome cannot make them large.
export const RUN_ERROR_FIELD_CAP = 200;
export const RUN_META_HEADROOM = 2_048;

// The most a /run-result body can legitimately be: the capped fields with JSON
// escaping at its worst (six bytes per character) plus envelope headroom.
export const RUN_RESULT_BODY_LIMIT_BYTES = 6 * (RUN_RESULT_CAP + RUN_ERROR_MESSAGE_CAP + 2 * RUN_ERROR_FIELD_CAP + 512);

// A cut that never splits a surrogate pair.
export function cutChars(s: string, n: number): string {
  if (s.length <= n) return s;
  const end = n > 0 && s.charCodeAt(n - 1) >= 0xd800 && s.charCodeAt(n - 1) <= 0xdbff ? n - 1 : n;
  return s.slice(0, end);
}

// A cut that keeps the string's JSON-escaped width (what it costs inside the
// metadata block, where a control character is six characters) within `n`.
export function cutEscaped(s: string, n: number): string {
  const width = (t: string) => JSON.stringify(t).length - 2;
  if (width(s) <= n) return s;
  let lo = 0;
  let hi = Math.min(s.length, n);
  while (lo < hi) {
    const mid = Math.ceil((lo + hi) / 2);
    if (width(cutChars(s, mid)) <= n) lo = mid; else hi = mid - 1;
  }
  return cutChars(s, lo);
}

// A result cut at RUN_RESULT_CAP, ending in the marker that says so. `fullChars`
// is the length before the cut.
export function cutResult(text: string, fullChars: number): string {
  return `${cutChars(text, RUN_RESULT_CAP)}… [result cut at ${RUN_RESULT_CAP} of ${fullChars} chars — return less]`;
}

// The longest result string a cut can produce (the cap plus the marker).
export const RUN_RESULT_MAX_CHARS = RUN_RESULT_CAP + 120;

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
