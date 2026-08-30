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
// - THE INVARIANT, and the one to keep if any line here is ever edited: EVERY
//   sentinel — opening and closing, on BOTH streams — is emitted with an
//   injected leading `\n`, because a sentinel only counts when it STARTS a
//   line. Whatever precedes it may have no trailing newline of its own: a
//   command that ends with `printf err >&2`, or a login profile that prints an
//   unterminated banner. Without the injected newline the marker glues itself
//   to that text, never matches, and the command wedges until its deadline —
//   and in persistent mode the reset reopens the same login shell, which
//   reprints the same banner, so it is a LOOP: one wedge per command for the
//   life of the session.
//   The CLOSING sentinels' newline is stripped back off by the parser, so a
//   blank line is never attributed to the command. The OPENING ones need no
//   strip: everything before them is discarded by definition.
export function frameCommand(nonce: string, command: string): string {
  const s = sentinelFor(nonce);
  const b = beginFor(nonce);
  return `printf '\\n${b}\\n'; printf '\\n${b}\\n' >&2\n`
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

// ── Streaming the same frame, without leaking it ─────────────────────

// The parser above answers "what did this command print" once the whole frame
// has arrived. A redirected `Bash` also has to show output AS IT ARRIVES, which
// means forwarding bytes before the boundary has been seen — and that is the
// one place the framing can leak into a worker's output.
//
// THE CONTRACT, and the only one worth stating: whatever this emits,
// concatenated, is byte-identical to what the parser extracts from the same
// stream. Every rule below is the parser's own, applied incrementally rather
// than at the end, so the streaming and buffered paths cannot disagree:
//
//   * nothing before the OPENING sentinel is the command's (a login shell's
//     profile banner is not this command's stdout);
//   * the closing sentinel only counts when it STARTS a line, so a command that
//     echoes it mid-line is output;
//   * FIRST MATCH WINS, and everything after the boundary is discarded;
//   * cc's injected newline before the sentinel is stripped.
//
// Three things are therefore held back rather than emitted, each until the next
// byte resolves it:
//   1. a tail that is a PREFIX of the sentinel at a line start — it may be the
//      boundary arriving one byte at a time;
//   2. a COMPLETE sentinel at a line start whose line has not ended — its tail
//      decides whether it is the boundary or a forgery, and it has not arrived;
//   3. a trailing newline at the very end of the buffer — it may be the one cc
//      injected before the sentinel, which the parser strips.
// (3) is why a paused command's last line arrives without its newline until the
// next output: emitting it eagerly would put one byte in the stream that the
// buffered result does not contain, and byte-equality is the contract.
//
// One filter per (command, stream): stdout and stderr carry separate sentinels
// and must be filtered separately, which is also what keeps them separable
// downstream.
export class FramedStreamFilter {
  readonly #sentinel: string;
  readonly #begin: string;
  readonly #kind: 'out' | 'err';
  #buf = '';
  #started = false;
  #done = false;
  // Whether the next character of `#buf` sits at the start of a line. Tracked
  // rather than read from `#buf[-1]`, because emitted text has already left the
  // buffer — without it a mid-line `__CC_…` in the next chunk would be read as
  // a line-start sentinel.
  #atLineStart = true;

  constructor(nonce: string, kind: 'out' | 'err') {
    this.#sentinel = sentinelFor(nonce);
    this.#begin = beginFor(nonce);
    this.#kind = kind;
  }

  // True once the boundary has been seen. Nothing more will ever be emitted.
  get done(): boolean { return this.#done; }

  push(delta: string): string {
    if (this.#done || delta === '') return '';
    this.#buf += delta;
    if (!this.#started) {
      const at = afterMarkerLine(this.#buf, this.#begin);
      // Still inside the shell's own preamble: keep buffering it, and emit
      // nothing. It is small and bounded by whatever the login profile prints.
      if (at === -1) return '';
      this.#buf = this.#buf.slice(at);
      this.#started = true;
      this.#atLineStart = true;
    }
    const s = this.#sentinel;
    let from = 0;
    for (;;) {
      const at = this.#buf.indexOf(s, from);
      if (at === -1) break;
      if (!this.#lineStartAt(at)) { from = at + s.length; continue; }
      const nl = this.#buf.indexOf('\n', at);
      // Rule 2: a complete sentinel at a line start whose line has not ended.
      if (nl === -1) return this.#take(this.#withInjectedNewline(at));
      if (this.#matchesTail(this.#buf.slice(at + s.length, nl))) {
        const out = this.#buf.slice(0, this.#withInjectedNewline(at));
        this.#buf = '';
        this.#done = true;
        return out;
      }
      // A forgery. It is the command's own output, so keep scanning — exactly
      // what the parser does.
      from = nl + 1;
    }
    return this.#take(this.#holdFrom());
  }

  // No sentinel can arrive any more — the shell died, or the command's deadline
  // passed. Whatever is still held was held PENDING a boundary, so it is the
  // command's own output and belongs to the worker: the buffered result cannot
  // carry it (there is no frame to parse it out of), which makes this the only
  // way that output is ever seen.
  //
  // Rules 1 and 2 still apply. A shell that died PART WAY THROUGH writing the
  // sentinel leaves a fragment of the framing in the buffer, and "the shell
  // died" is not a licence to leak it.
  flush(): string {
    if (this.#done) return '';
    this.#done = true;
    const b = this.#buf;
    this.#buf = '';
    if (b.length === 0) return '';
    const lineStart = b.lastIndexOf('\n') + 1;
    const tail = b.slice(lineStart);
    const atLineStart = lineStart > 0 || this.#atLineStart;
    if (tail.length > 0 && atLineStart && (this.#sentinel.startsWith(tail) || tail.startsWith(this.#sentinel))) {
      // Drop cc's injected newline with it: a sentinel that was mid-flight is
      // still a sentinel, and the newline before it was never the command's.
      return b.slice(0, lineStart > 0 ? lineStart - 1 : 0);
    }
    return b;
  }

  #matchesTail(tail: string): boolean {
    return this.#kind === 'out' ? /^ (\d+) (\S*)$/.test(tail) : tail === '';
  }

  #lineStartAt(at: number): boolean {
    return at === 0 ? this.#atLineStart : this.#buf[at - 1] === '\n';
  }

  // The index to cut at so cc's injected newline — the one the parser strips —
  // is never emitted.
  #withInjectedNewline(at: number): number {
    return at > 0 && this.#buf[at - 1] === '\n' ? at - 1 : at;
  }

  #holdFrom(): number {
    const b = this.#buf;
    if (b.length === 0) return 0;
    const lineStart = b.lastIndexOf('\n') + 1;
    const tail = b.slice(lineStart);
    // Rule 3: a trailing newline may be the injected one.
    if (tail.length === 0) return b.length - 1;
    // Rule 1: a partial sentinel, but only where a sentinel could legally start.
    const atLineStart = lineStart > 0 || this.#atLineStart;
    if (atLineStart && this.#sentinel.startsWith(tail)) {
      return lineStart > 0 ? lineStart - 1 : 0;
    }
    return b.length;
  }

  #take(cut: number): string {
    if (cut <= 0) return '';
    const out = this.#buf.slice(0, cut);
    this.#buf = this.#buf.slice(cut);
    this.#atLineStart = out.endsWith('\n');
    return out;
  }
}
