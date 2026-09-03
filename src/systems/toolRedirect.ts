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
//                   (src/systems/bashForwarder.ts). Which agent asked selects
//                   the cwd the command starts from, keyed off the `agent_id`
//                   the hook carries.
//   Read/Write/    — PULL-THEN-PUSH through src/systems/fileBridge.ts, at the
//   Edit/Notebook    path the CLI is about to open. Never rewritten.
//   Glob/Grep     — removed from the tool registry by the injected settings
//                   (src/settings.ts), because a result cannot be substituted.
// A file tool aimed anywhere else is refused unless the path is one cc KNOWS is
// local (an attachment under the store, a plan under `~/.claude`).
//
// This module is composition and policy only. The shell framing lives in
// src/systems/providerShell.ts, the file transfer in src/systems/fileBridge.ts,
// and the prefix rule in src/systems/sessionRoot.ts.

import path from 'node:path';
import { FileBridge } from './fileBridge.ts';
import { excludedRefusal, type MirrorScope } from './mirror.ts';
import { SystemError } from './protocol.ts';
import { ProviderShell, type ShellHost } from './providerShell.ts';
import { SessionPathMap } from './sessionRoot.ts';
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
  // Non-null exactly once after the shell had to be restarted (R5).
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
// R5 notice must precede the command's own output rather than be mixed into it.
export interface ForwardSink {
  notice(text: string): void;
  out(text: string): void;
  err(text: string): void;
}

// The tools whose file_path this module owns. NotebookEdit carries its path
// under a different key, which is the only reason the map is not a set.
//
// EXPORTED so a test can enumerate it rather than transcribe it: the refusals
// below have to cover every entry, and a fifth tool added here must fail that
// test instead of quietly escaping the boundary.
export const FILE_TOOLS: Record<string, string> = {
  Read: 'file_path', Write: 'file_path', Edit: 'file_path', NotebookEdit: 'notebook_path',
};
const READ_ONLY_FILE_TOOLS = new Set(['Read']);

// Refused by name, whatever the injected settings did. `permissions.deny`
// already asks the CLI to remove these (src/settings.ts) and measurably does on
// the profiles where they exist at all — but that is undocumented surface, and
// the invariant it protects is the one the whole feature rests on. If either
// tool ever reaches this hook, it is answering about cc's session root rather
// than the system, and a refusal naming the alternative is the honest reply.
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

// The main agent's shell key. Every subagent's is `agent:<id>`, and the prefix
// is namespacing rather than decoration: a bare `agentId ?? 'main'` would put an
// agent whose id is literally `main` on the MAIN agent's shell.
const MAIN_SHELL_KEY = 'main';

function shellKey(agentId: string | null): string {
  return agentId ? `agent:${agentId}` : MAIN_SHELL_KEY;
}

const FORWARDER = path.join(path.dirname(new URL(import.meta.url).pathname), 'bashForwarder.ts');

export interface SessionRedirectOptions {
  system: RedirectableSystem;
  systemId: string;
  // The project's — or worktree's — root ON the system. The shell's cwd, the
  // needle the Bash annotation looks for, and the tree the out-of-boundary
  // refusal names.
  //
  // IT IS NOT THE FAR END OF THE PREFIX RULE. That is the mirror root below,
  // which is the same path only when the provider advertises nothing. The two
  // were one field until P7, and widening it would silently have re-based every
  // agent's shell on the mirror root and matched the annotation against
  // essentially all output.
  systemPath: string;
  // The LOCAL IMAGE of the mirror root. The CLI's cwd is `sessionRoot +
  // mirror.offset`, which this derives rather than takes, so the two cannot
  // disagree.
  sessionRoot: string;
  // How much of the system this session mirrors, and what it must not carry
  // (src/systems/mirror.ts). `noMirror(systemPath)` is the no-advertisement
  // scope and the only spelling of it.
  mirror: MirrorScope;
  forwarderUrl: string;
  // Absolute LOCAL prefixes that are legitimately not the system's business. A
  // file tool aimed outside both these and the session root is refused.
  //
  // EACH ONE IS A SPECIFIC DIRECTORY, and the caller owes that. This list is a
  // read AND write grant on the orchestrator's own filesystem, so a broad entry
  // is a broad grant: `orchStoreRoot()` was one, and it handed a worker cc's
  // whole store — app settings, the convention store, every other project's
  // metadata, every session sidecar, and other sessions' task output. The
  // caller's own comment (src/instances.ts, attachRedirect) names what each
  // entry is for; this module only tests containment.
  localRoots: string[];
  emit: (ev: unknown) => void;
  shellCommandTimeoutMs?: number;
  maxOutputBytes?: number;
}

export class SessionRedirect {
  map: SessionPathMap;
  readonly systemId: string;
  // The PROJECT, on both sides — distinct from the map, which holds the mirror.
  // Every sentence a worker reads about "this project's tree" names these.
  readonly systemPath: string;
  projectRoot: string;

  readonly #system: RedirectableSystem;
  readonly #bridge: FileBridge;
  readonly #forwarderUrl: string;
  readonly #localRoots: string[];
  readonly #emit: (ev: unknown) => void;
  readonly #shellCommandTimeoutMs: number | undefined;
  readonly #maxOutputBytes: number;

  // Keyed by shellKey(): the main agent's shell plus one per subagent that has
  // run a command. Each holds that agent's cwd and nothing else — no process
  // outlives a command, so an entry costs nothing on the far side.
  readonly #shells = new Map<string, ProviderShell>();

  constructor(opts: SessionRedirectOptions) {
    this.map = new SessionPathMap(opts.sessionRoot, opts.mirror.mirrorRoot, opts.mirror.exclude);
    this.systemId = opts.systemId;
    this.systemPath = opts.systemPath;
    this.projectRoot = path.join(opts.sessionRoot, opts.mirror.offset);
    this.#system = opts.system;
    this.#bridge = new FileBridge(opts.system, this.map);
    this.#forwarderUrl = opts.forwarderUrl;
    this.#localRoots = opts.localRoots;
    this.#emit = opts.emit;
    this.#shellCommandTimeoutMs = opts.shellCommandTimeoutMs;
    this.#maxOutputBytes = opts.maxOutputBytes ?? DEFAULT_MAX_OUTPUT_BYTES;
  }

  // THE ONE WAY a live session's geometry changes. Called by
  // Instance._refreshSessionRoot when the composed cwd has moved, and only
  // there — between launch()'s compose and spawn(), so no CLI is running and
  // there is nothing to rebuild underneath. That is why 2026-0259's "rebuilding
  // a redirect under a running CLI is not possible" is true and does not apply:
  // its warn-don't-refuse is superseded by a third answer, not overturned into a
  // refusal (card 2026-0279).
  //
  // The image ROOT does not move (sessionRootPath keys on project/worktree
  // only); what moves is the mirror root the prefix rule maps against and the
  // offset the project sits at inside the image. `exclude` comes from the same
  // advertisement as the root, because two sources for one scope is how a
  // boundary gets decided two different ways. The far-side shells are NOT
  // touched: they run at `systemPath`, which did not move.
  retarget(root: string, mirror: MirrorScope): void {
    const next = new SessionPathMap(root, mirror.mirrorRoot, mirror.exclude);
    this.#bridge.retarget(next, this.map);
    this.map = next;
    this.projectRoot = path.join(root, mirror.offset);
  }

  // ── PreToolUse ─────────────────────────────────────────────────────

  // `agentId` is the dispatching subagent's `agent_id` off the CLI's hook
  // envelope, or null for the session's main agent (the field is ABSENT on the
  // main agent's payload — measured). It selects which shell the command runs
  // in; nothing else branches on it. Defaulted so a caller that has no agent to
  // name does not have to say so.
  async preToolUse(
    toolName: string,
    toolInput: Record<string, unknown>,
    agentId: string | null = null,
  ): Promise<RedirectDecision> {
    if (UNREDIRECTABLE_TOOLS.has(toolName)) {
      return {
        decision: 'deny',
        reason: `${toolName} searches the orchestrator's filesystem, not system '${this.systemId}' where this `
          + `project's files are. Use \`find\` or \`grep\` through Bash, which runs there.`,
      };
    }
    if (toolName === 'Bash') return this.#redirectBash(toolInput, agentId);
    const key = FILE_TOOLS[toolName];
    if (key === undefined) return { decision: 'allow' };
    return this.#redirectFile(toolName, key, toolInput);
  }

  #redirectBash(toolInput: Record<string, unknown>, agentId: string | null): RedirectDecision {
    const command = typeof toolInput.command === 'string' ? toolInput.command : '';
    if (!command) return { decision: 'allow' };
    // THE TOOL'S OWN `timeout` IS NOT FORWARDED, and that is deliberate. It once
    // became cc's deadline, which killed the command at the same instant the CLI
    // detached the forwarder and handed the agent a pointer to it (card
    // 2026-0305 §4); it then became a wait bound on the shell's queue, and card
    // 2026-0312 removed the queue. The CLI enforces its own tool timeout by
    // KILLING THE FORWARDER, which closes the socket — cc's cancellation channel
    // — so nothing here needs the number.
    const argv = [
      shQuote(process.execPath), shQuote(FORWARDER),
      '--url', shQuote(this.#forwarderUrl),
      // THE ONLY CHANNEL the agent id has. `agent_id` arrives on the hook, but
      // the command does not run there: the CLI later spawns the forwarder as
      // its own process, which POSTs the command back to cc. So the id rides
      // the forwarder's argv and returns on its request body. Omitted entirely
      // for the main agent, so a forwarder invocation and a body without it
      // both mean the same thing.
      ...(agentId ? ['--agent', shQuote(agentId)] : []),
      '--', shQuote(command),
    ];
    // Spread the original: `updatedInput` REPLACES the tool input, so a field
    // dropped here is a field the tool never sees.
    return { decision: 'allow', updatedInput: { ...toolInput, command: argv.join(' ') } };
  }

  async #redirectFile(toolName: string, key: string, toolInput: Record<string, unknown>): Promise<RedirectDecision> {
    const p = toolInput[key];
    // REFUSED, not passed through. The CLI was measured resolving every file
    // path to an absolute one before the hook fires, so this is unreachable
    // today — but allowing it made the two halves disagree: PreToolUse skipped
    // the pull while postToolUse would still have resolved and PUSHED the path,
    // so an Edit could reach the system from a base that was never fetched. cc
    // does not get to guess which machine a relative path means, and the
    // invariant should not rest on an undocumented CLI behaviour staying put.
    if (typeof p !== 'string' || !path.isAbsolute(p)) {
      return {
        decision: 'deny',
        reason: `cc: ${toolName} needs an absolute path on a project hosted on system `
          + `'${this.systemId}' — ${JSON.stringify(p)} could name a file on either machine. `
          + `Use a path under ${this.projectRoot}.`,
      };
    }

    const verdict = this.map.classify(p);
    if (verdict.kind === 'outside') {
      // ORDER IS LOAD-BEARING, and a wide mirror is what makes it so. With
      // `mirrorRoot: '/'` every absolute path has a local counterpart, so
      // #outsideReason's translating clause would happily hand an attachment or
      // a `~/.claude` plan file a system path. #isKnownLocal first is what stops
      // that, and reordering these two lines is a boundary leak.
      if (this.#isKnownLocal(p)) return { decision: 'allow' };
      return { decision: 'deny', reason: this.#outsideReason(p) };
    }
    if (verdict.kind === 'excluded') {
      return { decision: 'deny', reason: excludedRefusal(verdict.systemPath, this.systemId, verdict.excludedBy) };
    }

    const writing = !READ_ONLY_FILE_TOOLS.has(toolName);
    // Checked BEFORE the pull, because a pull resyncs the local copy and would
    // clear the very divergence this refusal exists to report.
    if (writing) {
      const diverged = this.#bridge.dirtyReason(p);
      if (diverged) {
        return { decision: 'deny', reason: `${diverged}. Read the file again to resync it from ${this.systemId}, then re-apply the change.` };
      }
    }

    try {
      const r = await this.#bridge.pull(p);
      if (r.kind === 'refused') return { decision: 'deny', reason: `cc cannot carry this file across the boundary to system '${this.systemId}': ${r.reason}` };
      return { decision: 'allow' };
    } catch (e) {
      // R9: mid-session the system can go away. A hooked tool DENIES naming the
      // system rather than letting the CLI answer from whatever is on cc's disk.
      return { decision: 'deny', reason: `cc could not reach system '${this.systemId}' to fetch ${p}: ${errMsg(e)}` };
    }
  }

  #isKnownLocal(p: string): boolean {
    return this.#localRoots.some(root => within(p, root));
  }

  // The base sentence names the PROJECT's tree, which is what a worker
  // overwhelmingly wants. When the path it was handed does have a local
  // counterpart — always true under a wide mirror, and true of any in-project
  // system path even without one — the refusal TRANSLATES rather than merely
  // declining, which delivers the recovery one tool call earlier.
  //
  // Deliberately UNGATED on mirror width (D-P7-9): one wording, always
  // exercised, beats two of which the load-bearing one is the rare branch.
  #outsideReason(p: string): string {
    const base = `'${p}' is not a path this session can use. This project's tree is at `
      + `${this.systemPath} on system '${this.systemId}'; its files are read and edited at their `
      + `paths under ${this.projectRoot}. Use Bash for anything else on the system — a file written `
      + `anywhere else would land on the orchestrator's machine, where no command here can see it.`;
    const local = this.map.toLocal(p);
    if (local === null) return base;
    return `${base} '${p}' is a path on '${this.systemId}': this session reaches that same file at `
      + `${local} — use that path.`;
  }

  // ── PostToolUse ────────────────────────────────────────────────────

  // Returns the note to attach to the tool result, or null. A note is the ONLY
  // channel available: a tool result cannot be substituted, only annotated, so
  // cc can say where a write landed but can never rewrite a `/app` path inside
  // a command's output into its local counterpart.
  async postToolUse(toolName: string, toolInput: Record<string, unknown>, toolResponse: unknown): Promise<string | null> {
    if (toolName === 'Bash') return this.#annotateBash(toolResponse);
    const key = FILE_TOOLS[toolName];
    if (key === undefined || READ_ONLY_FILE_TOOLS.has(toolName)) return null;
    const p = toolInput[key];
    // The ABSOLUTE check matches #redirectFile's refusal exactly, so the two
    // halves cannot disagree about which paths they handle: `toSystem` would
    // resolve a relative path against the session root and push a file
    // PreToolUse never pulled.
    if (typeof p !== 'string' || !path.isAbsolute(p)) return null;
    if (this.map.classify(p).kind !== 'mapped') return null;
    try {
      await this.#bridge.push(p);
      return `Saved to ${this.map.toSystem(p)} on system '${this.systemId}'.`;
    } catch (e) {
      // HARD AND LOUD, never best-effort. The operator gets an error event and
      // the worker gets the divergence in band; the path is already marked, so
      // the next write to it is refused.
      const why = errMsg(e);
      this.#emit({ kind: 'system', subtype: 'stderr', data: { line: `systems: ${why}` } });
      return `WRITE-BACK FAILED — ${why}. The local copy and system '${this.systemId}' now differ, and further writes to this path are refused until you Read it again.`;
    }
  }

  // R2's targeted annotation: attached ONLY when the output actually contains
  // the PROJECT's path on the system, which is the moment the two coordinate
  // systems become visible to the worker and the only moment a note earns its
  // cost. Never the MIRROR root: under `mirrorRoot: '/'` that needle matches
  // essentially every command's output, and an annotation on every Bash call is
  // not a targeted one.
  #annotateBash(toolResponse: unknown): string | null {
    const r = toolResponse as { stdout?: unknown; stderr?: unknown } | null;
    const text = `${typeof r?.stdout === 'string' ? r.stdout : ''}${typeof r?.stderr === 'string' ? r.stderr : ''}`;
    if (!text.includes(this.systemPath)) return null;
    return `Paths under ${this.systemPath} in that output are on system '${this.systemId}', where the command ran. `
      + `The same files are read and edited here under ${this.projectRoot}.`;
  }

  // ── The forwarded command ──────────────────────────────────────────

  // Run one command in the shell belonging to the AGENT that asked for it —
  // `agentId` null for the session's main agent. Called by the forwarder's HTTP
  // request, which carries the id back from the rewrite.
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
  async runForwarded(command: string, { signal, sink, agentId }: { signal?: AbortSignal; sink?: ForwardSink; agentId?: string | null } = {}): Promise<ForwardedResult> {
    let notice: string | null = null;
    try {
      const shell = this.#ensureShell(shellKey(agentId ?? null));
      // THE NOTICE IS TAKEN AT ACQUISITION, not here. A command may queue behind
      // others, and the shell it eventually runs on is not necessarily the one
      // that existed when its request arrived — reading the reason now attaches
      // it to the wrong command, leaving the one that actually ran on the fresh
      // shell saying nothing about the state it lost. R5's rule is about the
      // command that runs.
      const onStart = () => {
        const reason = shell.takeResetReason();
        if (!reason) return;
        notice = this.#resetNotice(shell, reason);
        // FIRST, ahead of the command's own output: a shell that lost its exports
        // has to say so before output that may be wrong because of it.
        sink?.notice(notice);
      };
      // The CLI kills the forwarder on a tool timeout or an interrupt, which
      // closes the socket. That is cc's only signal that the worker no longer
      // wants THIS command, and it reaches the far side as a `signal` on this
      // command's own `exec` id — so nothing else is disturbed.
      const r = await shell.run(command, {
        onStart,
        ...(signal ? { signal } : {}),
        ...(sink ? { onOut: (t: string) => sink.out(t), onErr: (t: string) => sink.err(t) } : {}),
      });
      return { stdout: r.stdout, stderr: r.stderr, code: r.code, notice };
    } catch (e) {
      // Through the SINK as well: the route has already streamed and will not
      // write the aggregate, so a diagnostic that only landed in the return
      // value would reach the worker as an empty result. Whatever reset the
      // shell has already recorded its own reason on it, so the NEXT command to
      // acquire the shell is the one that reports it.
      const stderr = `cc: ${errMsg(e)}\n`;
      sink?.err(stderr);
      return { stdout: '', stderr, code: 1, notice };
    }
  }

  // The agent's shell, created on first use. A NEW AGENT'S SHELL IS SEEDED FROM
  // THE PROJECT ROOT with no inherited environment, exactly as the main agent's
  // is: exports live inside the parent's shell PROCESS and reading them means
  // running a command in it, which serialises behind whatever it is doing and
  // races its next command — and carrying the cwd alone while the environment
  // silently did not come along is the invisible divergence R5 exists to forbid.
  // Locally a subagent inherits nothing from its parent either.
  #ensureShell(key: string): ProviderShell {
    const existing = this.#shells.get(key);
    if (existing) return existing;
    const shell = new ProviderShell(this.#system, {
      // THE PROJECT, never the mirror root: a wide mirror must not start every
      // agent's shell at `/`.
      cwd: this.systemPath,
      maxOutputBytes: this.#maxOutputBytes,
      ...(this.#shellCommandTimeoutMs === undefined ? {} : { commandTimeoutMs: this.#shellCommandTimeoutMs }),
    });
    this.#shells.set(key, shell);
    return shell;
  }

  // R5: a reconnected shell TELLS the worker. Restoring only the cwd and
  // saying nothing hands it something that looks continuous while the rest of
  // the state is silently gone — the invisible divergence that costs a session
  // its trust in its own results.
  #resetNotice(shell: ProviderShell, reason: string): string {
    const cwd = shell.cwd;
    return `[cc] the shell on system '${this.systemId}' was restarted (${reason}). `
      + `Its working directory is still ${cwd}, but exported variables, shell functions and `
      + `background jobs from earlier commands are gone.`;
  }

  // ── @mention pre-hydration ─────────────────────────────────────────

  // The CLI expands an `@path` mention itself, with no hook — measured — so a
  // file that is not already in the session root is simply absent from the
  // turn. cc owns the one site the prompt is written from, so it pulls the
  // named files first.
  //
  // BEST EFFORT BY DESIGN: a mention that names nothing on the system, or one
  // cc cannot fetch, must not stop the prompt. The CLI's own "file not found"
  // for the mention is a better answer than a refused turn.
  async hydrateMentions(text: string): Promise<void> {
    for (const spec of parseMentions(text)) {
      // Against the CLI's OWN cwd — a mention is written relative to where the
      // worker is, which is the project's directory inside the image, not the
      // image root.
      const local = path.resolve(this.projectRoot, spec);
      if (this.map.classify(local).kind !== 'mapped') continue;
      try { await this.#bridge.pull(local); } catch { /* the CLI reports the miss */ }
    }
  }

  // ── Lifecycle ──────────────────────────────────────────────────────

  // Drop every agent's shell. Called on instance exit, kill and discardAll.
  // Idempotent.
  async close(): Promise<void> {
    this.#shells.clear();
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
