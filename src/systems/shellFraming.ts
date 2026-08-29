// Sentinel framing for a redirected shell command. CC OWNS THIS, NOT THE
// PROVIDER: the provider gives cc one `exec`, and cc turns that single byte
// stream into a sequence of commands with exit codes and a cwd.
//
// The framing was MEASURED against a real `bash -l` — including how it breaks.
// Driving one shell with `{ <cmd>\n} < /dev/null` plus a sentinel carrying `$?`
// and base64 `$PWD`: `cd` persisted, `export` persisted, exit codes were
// captured, stderr carried its own sentinel. But a command that ECHOED the
// sentinel desynchronised the parser — five stdout frames for four commands,
// the forgery parsed as `rc=999`. The two rules below are the fix, and each is
// exercised by tests/systems-shell-framing.test.mjs.
//
// The same framing serves BOTH modes. With `persistentShell` the script is
// written into one long-lived shell's stdin; without it, the identical script
// runs as a one-shot `exec` with an explicit cwd. One implementation, so the
// fallback cannot parse differently from the path it falls back from.

import { randomBytes } from 'node:crypto';

// RANDOM PER COMMAND, not per shell. A fixed nonce is forgeable — that is the
// measured desync. 128 bits makes accidental collision impossible; deliberate
// self-inspection by the command is out of scope (the operator already has
// arbitrary execution on their own machine).
export function newNonce(): string {
  return randomBytes(16).toString('hex');
}

export function sentinelFor(nonce: string): string {
  return `__CC_${nonce}__`;
}

// The OPENING sentinel. Everything before it on either stream belongs to the
// shell, not to the command: `$SHELL -l` is a LOGIN shell and sources profile
// files, so a box with an MOTD or a `nvm` banner would otherwise hand its first
// command that text as stdout — silently, and on every command in the one-shot
// fallback, where each command gets its own login shell.
//
// It cannot collide with the closing sentinel: `__CC_<n>__` is not a substring
// of `__CC_<n>_BEGIN__` (the character after `_` differs), and neither line
// matches the other's pattern.
export function beginFor(nonce: string): string {
  return `__CC_${nonce}_BEGIN__`;
}

// Index just past the newline of the first line that IS `marker`, or -1.
function afterMarkerLine(text: string, marker: string): number {
  let from = 0;
  for (;;) {
    const at = text.indexOf(marker, from);
    if (at === -1) return -1;
    const nl = text.indexOf('\n', at);
    if (nl === -1) return -1;
    if ((at === 0 || text[at - 1] === '\n') && text.slice(at + marker.length, nl) === '') return nl + 1;
    from = nl + 1;
  }
}

// The script cc writes for one command.
//
// - BRACES, not a subshell: `cd` and `export` must land in the shell itself.
// - `< /dev/null` on the group, matching project_bash's `stdin:'ignore'` and
//   the CLI's own Bash tool, which has no stdin parameter — so it is not a
//   regression. A command genuinely needing stdin runs as its own one-shot
//   exec, at the cost of not sharing shell state.
// - `$PWD` is base64'd because a path may contain spaces or newlines.
// - stderr gets its own sentinel, opening AND closing, so cc knows when both
//   streams are done and where each one's command output starts.
// - The leading `\n` on BOTH closing sentinels guarantees each starts a line
//   even when the command's output has no trailing newline — `printf err >&2`
//   is ordinary, and without it the stderr sentinel lands mid-line, never
//   matches, and the command wedges until its deadline. parseFramed strips
//   exactly that one newline back off, so a blank line is never attributed to
//   the command.
export function frameCommand(nonce: string, command: string): string {
  const s = sentinelFor(nonce);
  const b = beginFor(nonce);
  return `printf '${b}\\n'; printf '${b}\\n' >&2\n`
    + `{ ${command}\n} < /dev/null\n`
    + `__cc_rc=$?; printf '\\n${s} %d %s\\n' "$__cc_rc" "$(printf %s "$PWD" | base64 | tr -d '\\n')"\n`
    + `printf '\\n${s}\\n' >&2\n`;
}

export interface FramedStdout {
  // Everything the command wrote before the sentinel, with cc's injected
  // newline removed.
  text: string;
  code: number;
  cwd: string;
  // Offset just past the sentinel line. Everything from here on belongs to a
  // forgery's own trailing output and is DISCARDED — which is what confines a
  // desync to the one command that caused it.
  consumed: number;
}

// FIRST MATCH WINS, then stop parsing. A forged sentinel can therefore only
// truncate its OWN output; it can never shift the boundary of the next command.
export function parseFramedStdout(text: string, nonce: string): FramedStdout | null {
  // Everything before the OPENING sentinel is the shell's, not the command's.
  const start = afterMarkerLine(text, beginFor(nonce));
  if (start === -1) return null;
  const body = text.slice(start);
  const s = sentinelFor(nonce);
  let from = 0;
  for (;;) {
    const at = body.indexOf(s, from);
    if (at === -1) return null;
    // The sentinel must START a line: a command echoing it mid-line is output,
    // not a frame boundary.
    if (at !== 0 && body[at - 1] !== '\n') { from = at + s.length; continue; }
    const nl = body.indexOf('\n', at);
    if (nl === -1) return null; // the sentinel line is still arriving
    const line = body.slice(at + s.length, nl);
    const m = /^ (\d+) (\S*)$/.exec(line);
    if (!m) { from = nl + 1; continue; }
    // Strip the one newline cc injected before the sentinel.
    const before = at > 0 && body[at - 1] === '\n' ? body.slice(0, at - 1) : body.slice(0, at);
    let cwd = '';
    try { cwd = Buffer.from(m[2], 'base64').toString('utf8'); } catch { cwd = ''; }
    return { text: before, code: Number(m[1]), cwd, consumed: start + nl + 1 };
  }
}

export interface FramedStderr { text: string; consumed: number }

// The stderr sentinel carries no payload — it exists so cc knows the stderr
// stream is done for this command and can attribute later bytes to the next
// one.
export function parseFramedStderr(text: string, nonce: string): FramedStderr | null {
  const start = afterMarkerLine(text, beginFor(nonce));
  if (start === -1) return null;
  const body = text.slice(start);
  const s = sentinelFor(nonce);
  let from = 0;
  for (;;) {
    const at = body.indexOf(s, from);
    if (at === -1) return null;
    if (at !== 0 && body[at - 1] !== '\n') { from = at + s.length; continue; }
    const nl = body.indexOf('\n', at);
    if (nl === -1) return null;
    if (body.slice(at + s.length, nl) !== '') { from = nl + 1; continue; }
    // Strip the one newline cc injected before the sentinel, exactly as the
    // stdout half does.
    const before = at > 0 && body[at - 1] === '\n' ? body.slice(0, at - 1) : body.slice(0, at);
    return { text: before, consumed: start + nl + 1 };
  }
}
