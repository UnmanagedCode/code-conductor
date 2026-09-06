// The redirection policy for one worker session on a remote system: which tool
// call crosses to the system, which is refused, and what the worker is told.
//
// THE ONE INVARIANT, and everything here is in service of it: THE BOUNDARY IS
// CONSISTENT. Every tool that can observe or mutate the system's tree is either
// fully redirected or refused by name. A half-redirected boundary — a path
// visible from one side and not the other — is measurably the worst outcome
// available: against a clean boundary a worker does the task and notices
// nothing, and against a leaky one it burns exploratory calls, distrusts its
// own tool results and reports the environment as broken. That is not a
// hypothesis; it was reproduced on demand by leaking.
//
// So the three tool families are handled, and nothing is left to fall through:
//   Bash          — REWRITTEN into a local forwarder that runs the command on
//                   the system as its own `exec`, one per command
//                   (src/systems/bashForwarder.ts). Nothing outlives a command,
//                   so no command's state reaches any later one and there is
//                   nothing to keep one agent's commands apart from another's.
//   Read/Write/    — PULL-THEN-PUSH through src/systems/fileBridge.ts, at the
//   Edit/Notebook    path the CLI is about to open. Never rewritten.
//   Glob/Grep     — removed from the tool registry by the injected settings
//                   (src/settings.ts), because a result cannot be substituted.
// A file tool aimed anywhere else is refused unless the path is one cc KNOWS is
// local (an attachment under the store, a plan under `~/.claude`).
//
// This module is composition and policy only. The shell framing lives in
// src/systems/providerShell.ts, the file transfer in src/systems/fileBridge.ts,
// and the deny surface below.

import path from 'node:path';
import { SystemError } from './protocol.ts';
import { ProviderShell, type ShellHost } from './providerShell.ts';
import type { System } from './system.ts';

// A System cc can run one command on. Every non-local system is one
// (registry.ts resolves a non-local id to a ProviderSystem); the type says so
// structurally rather than naming the class, so a test can drive this with a
// fake host.
//
// THE PROBE IS `execOneShot`, and the choice is load-bearing in both
// directions: it is declared on ProviderSystem and NOT on the base `System`
// interface, so a bare System (LocalSystem) is correctly refused while every
// provider-backed one is accepted. Re-basing it on `exec` — which `System` does
// have — would make every local project look redirectable
// (card 2026-0312 §2 D-a). src/instances.ts reads this to refuse
// 501 WORKER_SESSIONS_NEED_A_SHELL.
export type RedirectableSystem = System & ShellHost;

export function isRedirectable(sys: System): sys is RedirectableSystem {
  return typeof (sys as Partial<ShellHost>).execOneShot === 'function';
}

export interface RedirectDecision {
  decision: 'allow' | 'deny';
  reason?: string;
  // Present only for Bash. REPLACES the tool input, so it carries every field
  // the original had.
  updatedInput?: Record<string, unknown>;
}

export interface ForwardedResult {
  stdout: string;
  stderr: string;
  code: number;
  // Non-null when the command ended somewhere other than the project root, and
  // its `cd` is therefore about to be discarded. See #cwdNotice.
  notice: string | null;
}

// Where a forwarded command's output goes AS IT ARRIVES. The route hands one of
// these to `runForwarded` and turns each call into a frame on the open HTTP
// response, which the forwarder replays onto its own stdout/stderr — so the
// worker sees a long command's output while it is still running instead of at
// exit.
//
// The three are separate rather than one interleaved callback because the
// forwarder has to write each to a different file descriptor, and because the
// notice has to be separable from the command's own stderr rather than mixed
// into it.
export interface ForwardSink {
  notice(text: string): void;
  out(text: string): void;
  err(text: string): void;
}

// STILL REFUSED BY NAME under the chroot, and this is not a leftover.
// `permissions.deny` already asks the CLI to remove these (src/settings.ts) and
// measurably does on the profiles where they exist at all — but that is
// undocumented surface, and the invariant it protects is the one the whole
// feature rests on.
//
// A marked CLI's `Grep` spawns an UNMARKED `rg`, which the union routes by the
// caller rule as a stranger — so it would search the wrong side and return
// silently wrong results rather than failing. Re-enabling them needs mark
// inheritance, which is measured CLOSED (handover §5, S3 §B3): cc's plumbing IS
// the worker's process subtree, so no ancestry cut separates them.
const UNREDIRECTABLE_TOOLS = new Set(['Glob', 'Grep']);

// THE OUTPUT FENCE for one redirected command, and the reason the redirected
// Bash cannot be the one `exec` path with no bound.
//
// cc accumulates a framed command's bytes in its own heap while the command
// runs, so `head -c 40M /dev/zero | base64` — a plausible accident, not an
// attack — was measured taking cc's server heap from 29MB to 822MB and would
// take EVERY session on the host with it. A fence turns that into one command's
// named failure. 8 MiB is far above any output a model can usefully read and
// far below what threatens the process.
const DEFAULT_MAX_OUTPUT_BYTES = 8 * 1024 * 1024;

const FORWARDER = path.join(path.dirname(new URL(import.meta.url).pathname), 'bashForwarder.ts');

export interface SessionRedirectOptions {
  system: RedirectableSystem;
  systemId: string;
  // The project's — or worktree's — root ON the system, which under the chroot
  // is also the CLI's own working directory. The shell's cwd, and the tree the
  // out-of-boundary refusal names.
  systemPath: string;
  forwarderUrl: string;
  emit: (ev: unknown) => void;
  shellCommandTimeoutMs?: number;
  maxOutputBytes?: number;
}

export class SessionRedirect {
  readonly systemId: string;
  // The project's path on its system — which, under the chroot, is ALSO the
  // CLI's own working directory. There is no second spelling any more.
  readonly systemPath: string;

  readonly #system: RedirectableSystem;
  readonly #forwarderUrl: string;
  readonly #emit: (ev: unknown) => void;
  readonly #shellCommandTimeoutMs: number | undefined;
  readonly #maxOutputBytes: number;

  // ONE for the whole session, built on first use. It holds configuration only —
  // the project root, the fence, the ceiling — because no command's state
  // reaches any later command, so there is nothing left for a per-agent one to
  // keep apart (card 2026-0312 §3a).
  #shell: ProviderShell | null = null;

  // WHAT `close()` PULLS. There is no shell process to close any more, so
  // teardown needs its own lever on the commands still running: this is aborted,
  // and every command combines it with its caller's own signal. Without it a
  // command survives its session and runs to completion on someone else's
  // machine with nobody left to read the result — measured, and reachable in
  // production before this card on any provider without `persistentShell`
  // (card 2026-0312 §3c F-3).
  //
  // REPLACED ON EVERY close(), NOT ABORTED ONCE, and this is load-bearing:
  // `close()` is NOT terminal for a redirect. Instance exit and DELETE never
  // touch it again, but a REWIND/RESPAWN also calls it — the CLI's prefix is
  // rewritten, so whatever was running belongs to a conversation the worker no
  // longer has — and the SAME redirect then serves the next turn. A single
  // controller left aborted makes every later command fail ECANCELLED the
  // instant it is issued.
  #abort = new AbortController();

  constructor(opts: SessionRedirectOptions) {
    this.systemId = opts.systemId;
    this.systemPath = opts.systemPath;
    this.#system = opts.system;
    this.#forwarderUrl = opts.forwarderUrl;
    this.#emit = opts.emit;
    this.#shellCommandTimeoutMs = opts.shellCommandTimeoutMs;
    this.#maxOutputBytes = opts.maxOutputBytes ?? DEFAULT_MAX_OUTPUT_BYTES;
  }

  // ── PreToolUse ─────────────────────────────────────────────────────

  async preToolUse(
    toolName: string,
    toolInput: Record<string, unknown>,
  ): Promise<RedirectDecision> {
    if (UNREDIRECTABLE_TOOLS.has(toolName)) {
      return {
        decision: 'deny',
        reason: `${toolName} searches the orchestrator's filesystem, not system '${this.systemId}' where this `
          + `project's files are. Use \`find\` or \`grep\` through Bash, which runs there.`,
      };
    }
    // FILE TOOLS ARE NOT HOOKED AT ALL any more. The filesystem decides which
    // bytes appear at a path, so there is nothing for a PreToolUse pull to do —
    // and no local counterpart to translate to, because a file has ONE spelling
    // whichever tool names it.
    if (toolName === 'Bash') return this.#redirectBash(toolInput);
    return { decision: 'allow' };
  }

  #redirectBash(toolInput: Record<string, unknown>): RedirectDecision {
    const command = typeof toolInput.command === 'string' ? toolInput.command : '';
    if (!command) return { decision: 'allow' };
    // THE TOOL'S OWN `timeout` IS NOT FORWARDED, and cc needs it for nothing. It
    // once became cc's deadline, which killed the command at the same instant the
    // CLI DETACHED the forwarder and handed the agent a pointer to it (card
    // 2026-0305 §4); it then became a wait bound on the shell's queue, and card
    // 2026-0312 removed the queue.
    //
    // AT THE TOOL TIMEOUT THE CLI DETACHES, IT DOES NOT KILL, and hands the
    // agent a background task — measured at CLI 2.1.258, for a rewritten
    // forwarder command and for the same command left un-rewritten alike, and
    // whether its output was flowing or silent (card 2026-0310 §1.2). The
    // command keeps running, bounded by cc's ceiling, which is why that ceiling
    // sits above the documented max rather than at it. What the CLI DOES kill
    // the forwarder for — an interrupt, or a background task the worker stops —
    // closes the socket, and that is cc's cancellation channel; it carries no
    // number either.
    const argv = [
      shQuote(process.execPath), shQuote(FORWARDER),
      '--url', shQuote(this.#forwarderUrl),
      '--', shQuote(command),
    ];
    // Spread the original: `updatedInput` REPLACES the tool input, so a field
    // dropped here is a field the tool never sees.
    return { decision: 'allow', updatedInput: { ...toolInput, command: argv.join(' ') } };
  }

  // ── PostToolUse ────────────────────────────────────────────────────

  // Returns the note to attach to the tool result, or null. A note is the ONLY
  // channel available: a tool result cannot be substituted, only annotated, so
  // cc can say where a write landed but can never rewrite a `/app` path inside
  // a command's output into its local counterpart.
  // A NO-OP TODAY, AND DELIBERATELY STILL WIRED. It used to push the local file
  // back to the system and report where it landed; the union writes through, so
  // there is nothing to push and nothing to say.
  //
  // The hook stays registered (REDIRECT_POST_TOOL_MATCHER, src/settings.ts)
  // because S3's write-back needs exactly this seam: a lazy per-open mirror
  // pushes at `release`, which can fail after the tool has already returned
  // success, and a failed push has to reach the worker in band rather than be
  // logged. Deleting the wiring now means re-deriving it then.
  async postToolUse(_toolName: string, _toolInput: Record<string, unknown>, _toolResponse: unknown): Promise<string | null> {
    return null;
  }

  // ── The forwarded command ──────────────────────────────────────────

  // Run one command on the system. Called by the forwarder's HTTP request.
  //
  // EVERY COMMAND OF A SESSION GENUINELY OVERLAPS EVERY OTHER — nothing
  // serialises. That holds because the layers below are multiplexed, which was
  // measured rather than assumed: each `exec` owns its own never-reused id on
  // the connection, every frame is routed by that id BEFORE any decoder sees the
  // bytes, and each command owns its own parser — so two commands' bytes never
  // enter one parser even though a single read from the provider was observed
  // carrying frames for both. The per-command nonce defends something else
  // (forgery within one stream) and is not what makes this safe.
  //
  // WHAT BOUNDS cc's HEAP WITH N IN FLIGHT (card 2026-0312 §G-4): the output
  // fence below is PER COMMAND, so the exposure is `N × maxOutputBytes`. N is
  // whatever the CLI's own Bash concurrency is — realistically 1-10, since the
  // model issues Bash calls one turn at a time and a wide fan-out is a handful
  // of subagents each issuing one — i.e. 8 MiB to 80 MiB. It is UNBOUNDED IN
  // PRINCIPLE and small in practice, and it is strictly better than what it
  // replaced: the old ceiling was `17 × fence` (the main agent plus the
  // 16-subagent cap), ~136 MiB, and cc had no say in it either.
  //
  // NEVER REJECTS. Every failure — a command that destroyed its own framing, a
  // dead provider, a deadline — comes back as a non-zero exit with the reason on
  // stderr, because that is the channel the worker actually reads. A rejected
  // HTTP request would reach it as an opaque forwarder crash instead.
  async runForwarded(command: string, { signal, sink }: { signal?: AbortSignal; sink?: ForwardSink } = {}): Promise<ForwardedResult> {
    let notice: string | null = null;
    // TWO REASONS A COMMAND STOPS, relayed into the one signal `exec` takes.
    // Declared OUT here rather than inside the try, because the `finally` is
    // what detaches them and it has to reach them however the call ended.
    // The caller's is the socket closing — the CLI kills the forwarder when the
    // worker interrupts or stops a background task, and that is cc's only signal
    // that the worker no longer wants THIS command. It reaches the far side as a
    // `close` on this command's own `exec` id, so nothing else is disturbed. The
    // session's own teardown is the other, and it reaches every command at once.
    //
    // A PER-CALL CONTROLLER WITH EXPLICIT REMOVAL, and NOT `AbortSignal.any`.
    // `any` retains per-call state on the LONGEST-LIVED input for as long as
    // that input lives, which here is the session controller: measured on node
    // v24.18.0, heapUsed climbed linearly with the number of commands a session
    // had ever run, while this shape and a bare per-call signal both stayed
    // flat. The `removeEventListener` in the `finally` is what makes it flat —
    // the identical shape WITHOUT it grows just as `any` does, measured.
    //
    // WHAT IS AUDITABLE AND WHAT IS NOT, because the two halves differ and an
    // earlier wording here claimed neither was:
    //   * THE RELAY BELOW IS AUDITABLE. It is an ordinary `addEventListener`, so
    //     `getEventListeners(sig, 'abort')` reads 1 while it is attached and 0
    //     once the `finally` removes it — and deleting that removal is caught by
    //     a test, not only by a heap profile
    //     (tests/systems-tool-redirect.test.mjs).
    //   * `any` IS NOT. It attaches through internals `getEventListeners` does
    //     not enumerate: it reads 0 on a signal with a thousand live combined
    //     signals hanging off it. So the `any`-versus-manual COMPARISON is the
    //     part that can only be a heap measurement, and that measurement is what
    //     this comment records.
    // MEASURE WITH THE EVENT-NAME FORM EITHER WAY. The no-name form,
    // `getEventListeners(sig)`, reads 0 for all three cases above, so a reader
    // reaching for it measures 0/0/0 and concludes this comment miscounts.
    const call = new AbortController();
    const relay = () => call.abort();
    const sources = signal ? [signal, this.#abort.signal] : [this.#abort.signal];
    for (const s of sources) {
      if (s.aborted) call.abort();
      else s.addEventListener('abort', relay, { once: true });
    }
    try {
      const shell = this.#ensureShell();
      const r = await shell.run(command, {
        signal: call.signal,
        ...(sink ? { onOut: (t: string) => sink.out(t), onErr: (t: string) => sink.err(t) } : {}),
      });
      // LAST, after the command has settled: where it ended cannot be known
      // before then, so it arrives after the command's own output rather than
      // ahead of it.
      notice = this.#cwdNotice(r.cwd);
      if (notice) sink?.notice(notice);
      return { stdout: r.stdout, stderr: r.stderr, code: r.code, notice };
    } catch (e) {
      // Through the SINK as well: the route has already streamed and will not
      // write the aggregate, so a diagnostic that only landed in the return
      // value would reach the worker as an empty result.
      const stderr = `cc: ${errMsg(e)}\n`;
      sink?.err(stderr);
      return { stdout: '', stderr, code: 1, notice };
    } finally {
      // However the command ended. `{once:true}` already detaches a listener
      // that FIRED; this is for the ordinary case, where neither source ever
      // fires and the session controller would otherwise hold one per command
      // for the life of the session.
      for (const s of sources) s.removeEventListener('abort', relay);
    }
  }

  // The session's shell, built on first use.
  #ensureShell(): ProviderShell {
    if (this.#shell) return this.#shell;
    this.#shell = new ProviderShell(this.#system, {
      // THE PROJECT, never the mirror root: a wide mirror must not start every
      // command at `/`.
      cwd: this.systemPath,
      maxOutputBytes: this.#maxOutputBytes,
      ...(this.#shellCommandTimeoutMs === undefined ? {} : { commandTimeoutMs: this.#shellCommandTimeoutMs }),
    });
    return this.#shell;
  }

  // THE CWD-RESET PARITY NOTICE, and the only thing standing between a
  // redirected agent and a `cd` that silently vanishes. Every command runs in
  // its own shell, so a `cd` reaches nothing after it — exactly as it does
  // LOCALLY, where the CLI's own harness announces the same thing (measured on
  // CLI 2.1.258, which prints its own `Shell cwd was reset to <root>` line;
  // cc's wording is its own and claims no byte-identity with it).
  //
  // ONLY WHEN THE COMMAND ACTUALLY MOVED, matching local's silence: a notice on
  // every command is noise, and noise is itself a divergence from a local
  // session, where nothing is said unless the cwd moved.
  //
  // NO DOUBLE EMISSION. The CLI emits its own line only when ITS OWN shell's cwd
  // moved; a subshell's `cd` and a child process's `chdir` both leave it silent
  // (measured). The forwarder is exactly that shape — a child the CLI's shell
  // spawns — so cc's notice is the only one a worker sees.
  //
  // THE COMPARISON IS BYTE-EXACT, and a real transport can break the silence
  // half on that alone. The sentinel reports the shell's own `$PWD`, so a
  // provider whose interpreter canonicalises it — a symlinked project root, or
  // anything with `pwd -P` semantics — returns a path that never equals
  // `systemPath` and every command gets a notice, which is the noise divergence
  // this guard exists to avoid. The reference provider passes `cwd` through
  // unchanged, so no test here can see it.
  //
  // ADVERTISING CANNOT FIX IT, so do not reach for the mirror advertisement: the
  // comparison is against `systemPath`, the REGISTERED spelling, which no
  // advertisement changes — and a `mirrorRoot` that does not contain the
  // registered project path is refused MIRROR_ROOT_EXCLUDES_PROJECT outright, so
  // advertising a differing canonical root is refused rather than effective. A
  // provider whose interpreter canonicalises `$PWD` should serve its targets at
  // already-canonical paths, so the registered spelling and the shell's answer
  // agree.
  #cwdNotice(endedAt: string): string | null {
    if (!endedAt || endedAt === this.systemPath) return null;
    return `[cc] the command ended in ${endedAt}; the next command starts at ${this.systemPath} `
      + `on system '${this.systemId}', because each command runs in its own shell.`;
  }

  // ── Lifecycle ──────────────────────────────────────────────────────

  // Stop everything this session has running ON THE SYSTEM, not merely abandon
  // it, and drop the shell. Called on instance exit, kill, discardAll AND on a
  // rewind/respawn — see #abort above for why the controller is replaced rather
  // than left aborted. Idempotent: a second call aborts a controller with
  // nothing attached to it.
  async close(): Promise<void> {
    this.#abort.abort();
    this.#abort = new AbortController();
    this.#shell = null;
  }
}

// `@` followed by a path-ish token. Deliberately narrow: an email address or a
// decorator is not a mention, and pulling for one costs a round trip and can
// only ever miss.
function parseMentions(text: string): string[] {
  const out: string[] = [];
  for (const m of text.matchAll(/(?:^|\s)@([^\s@]+)/g)) {
    const spec = m[1].replace(/[.,;:)\]]+$/, '');
    if (spec && !spec.startsWith('/') && !spec.startsWith('~')) out.push(spec);
  }
  return out;
}

// POSIX single-quoting: everything inside is literal, and the only character
// that has to be escaped is the quote itself. The rewritten command is run by
// the CLI through a shell, so this is what carries a command containing quotes,
// newlines or `$` through unchanged.
function shQuote(s: string): string {
  return `'${s.split("'").join(`'\\''`)}'`;
}

function within(inner: string, outer: string): boolean {
  const rel = path.relative(outer, inner);
  return rel === '' || (!path.isAbsolute(rel) && rel !== '..' && !rel.startsWith(`..${path.sep}`));
}

function errMsg(e: unknown): string {
  return e instanceof Error ? e.message : String(e);
}
