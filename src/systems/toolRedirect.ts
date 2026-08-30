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
//   Bash          — REWRITTEN into a local forwarder that runs the command in
//                   this session's shell on the system (src/systems/bashForwarder.ts).
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
import { ProviderShell, type ShellHost } from './providerShell.ts';
import { SessionPathMap } from './sessionRoot.ts';
import type { System } from './system.ts';

// A System cc can also open a persistent shell on. Every non-local system is
// one (registry.ts resolves a non-local id to a ProviderSystem); the type says
// so structurally rather than naming the class, so a test can drive this with a
// fake host.
export type RedirectableSystem = System & ShellHost;

export function isRedirectable(sys: System): sys is RedirectableSystem {
  return typeof (sys as Partial<ShellHost>).openStream === 'function';
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

// The tools whose file_path this module owns. NotebookEdit carries its path
// under a different key, which is the only reason the map is not a set.
const FILE_TOOLS: Record<string, string> = {
  Read: 'file_path', Write: 'file_path', Edit: 'file_path', NotebookEdit: 'notebook_path',
};
const READ_ONLY_FILE_TOOLS = new Set(['Read']);

// How long a session's shell may sit unused before cc closes it. A worker
// between turns is idle for as long as its user is away, and a shell held open
// for that is a process on someone else's machine doing nothing.
const DEFAULT_IDLE_TTL_MS = 15 * 60_000;

const FORWARDER = path.join(path.dirname(new URL(import.meta.url).pathname), 'bashForwarder.ts');

export interface SessionRedirectOptions {
  system: RedirectableSystem;
  systemId: string;
  // The project's — or worktree's — root ON the system. The shell's cwd, and
  // the far end of the prefix rule.
  systemPath: string;
  sessionRoot: string;
  forwarderUrl: string;
  // Absolute LOCAL prefixes that are legitimately not the system's business:
  // the store (attachments, debug captures), `~/.claude` (plans, user config),
  // the transcript root, cc-managed plugin roots. A file tool aimed outside
  // both these and the session root is refused.
  localRoots: string[];
  emit: (ev: unknown) => void;
  idleTtlMs?: number;
  shellCommandTimeoutMs?: number;
}

export class SessionRedirect {
  readonly map: SessionPathMap;
  readonly systemId: string;

  readonly #system: RedirectableSystem;
  readonly #bridge: FileBridge;
  readonly #forwarderUrl: string;
  readonly #localRoots: string[];
  readonly #emit: (ev: unknown) => void;
  readonly #idleTtlMs: number;
  readonly #shellCommandTimeoutMs: number | undefined;

  #shell: ProviderShell | null = null;
  #idleTimer: NodeJS.Timeout | null = null;
  #closed = false;
  // Set when the shell was restarted, cleared by the command that reports it —
  // so the worker is told ONCE, in band, rather than never or every time.
  #pendingNotice: string | null = null;

  constructor(opts: SessionRedirectOptions) {
    this.map = new SessionPathMap(opts.sessionRoot, opts.systemPath);
    this.systemId = opts.systemId;
    this.#system = opts.system;
    this.#bridge = new FileBridge(opts.system, this.map);
    this.#forwarderUrl = opts.forwarderUrl;
    this.#localRoots = opts.localRoots;
    this.#emit = opts.emit;
    this.#idleTtlMs = opts.idleTtlMs ?? DEFAULT_IDLE_TTL_MS;
    this.#shellCommandTimeoutMs = opts.shellCommandTimeoutMs;
  }

  // True while a shell process is live on the system. Read by the idle-TTL test
  // and by diagnostics; nothing in the policy branches on it.
  get shellOpen(): boolean { return this.#shell?.open === true; }

  // ── PreToolUse ─────────────────────────────────────────────────────

  async preToolUse(toolName: string, toolInput: Record<string, unknown>): Promise<RedirectDecision> {
    if (toolName === 'Bash') return this.#redirectBash(toolInput);
    const key = FILE_TOOLS[toolName];
    if (key === undefined) return { decision: 'allow' };
    return this.#redirectFile(toolName, key, toolInput);
  }

  #redirectBash(toolInput: Record<string, unknown>): RedirectDecision {
    const command = typeof toolInput.command === 'string' ? toolInput.command : '';
    if (!command) return { decision: 'allow' };
    // The tool's own timeout becomes the shell's deadline. Without it a worker
    // that asked for ten minutes would have its shell RESET at cc's default
    // two, losing the session's cwd and exports for a command that was still
    // healthy.
    const timeout = Number(toolInput.timeout);
    const argv = [
      shQuote(process.execPath), shQuote(FORWARDER),
      '--url', shQuote(this.#forwarderUrl),
      ...(Number.isFinite(timeout) && timeout > 0 ? ['--timeout', String(Math.floor(timeout))] : []),
      '--', shQuote(command),
    ];
    // Spread the original: `updatedInput` REPLACES the tool input, so a field
    // dropped here is a field the tool never sees.
    return { decision: 'allow', updatedInput: { ...toolInput, command: argv.join(' ') } };
  }

  async #redirectFile(toolName: string, key: string, toolInput: Record<string, unknown>): Promise<RedirectDecision> {
    const p = toolInput[key];
    // The CLI resolves a Read's path to an absolute one before the hook sees
    // it. A relative path here is therefore not a path into the session — it is
    // the CLI's own business, and rewriting cc's guess of it would be worse
    // than letting the tool answer for itself.
    if (typeof p !== 'string' || !path.isAbsolute(p)) return { decision: 'allow' };

    if (this.map.toSystem(p) === null) {
      if (this.#isKnownLocal(p)) return { decision: 'allow' };
      return { decision: 'deny', reason: this.#outsideReason(p) };
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

  #outsideReason(p: string): string {
    return `'${p}' is not a path this session can use. This project's tree is at `
      + `${this.map.systemPath} on system '${this.systemId}'; its files are read and edited at their `
      + `paths under ${this.map.root}. Use Bash for anything else on the system — a file written `
      + `anywhere else would land on the orchestrator's machine, where no command here can see it.`;
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
    if (typeof p !== 'string' || this.map.toSystem(p) === null) return null;
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
  // the system path, which is the moment the two coordinate systems become
  // visible to the worker and the only moment a note earns its cost.
  #annotateBash(toolResponse: unknown): string | null {
    const r = toolResponse as { stdout?: unknown; stderr?: unknown } | null;
    const text = `${typeof r?.stdout === 'string' ? r.stdout : ''}${typeof r?.stderr === 'string' ? r.stderr : ''}`;
    if (!text.includes(this.map.systemPath)) return null;
    return `Paths under ${this.map.systemPath} in that output are on system '${this.systemId}', where the command ran. `
      + `The same files are read and edited here under ${this.map.root}.`;
  }

  // ── The forwarded command ──────────────────────────────────────────

  // Run one command in this session's shell on the system. Called by the
  // forwarder's HTTP request, one at a time per session — ProviderShell
  // serialises, so a subagent's command queues behind the parent's.
  //
  // NEVER REJECTS. Every failure — a wedged shell, a dead provider, a busy
  // one — comes back as a non-zero exit with the reason on stderr, because that
  // is the channel the worker actually reads. A rejected HTTP request would
  // reach it as an opaque forwarder crash instead.
  async runForwarded(command: string, { timeoutMs, signal }: { timeoutMs?: number; signal?: AbortSignal } = {}): Promise<ForwardedResult> {
    const shell = this.#ensureShell();
    // The idle timer is armed only AFTER the command, never before it: a sweep
    // that fires mid-command would close the shell out from under a command
    // that is still running, which is a reset the worker did not earn.
    this.#disarmIdle();
    // The CLI kills the forwarder on a tool timeout or an interrupt, which
    // closes the socket. That is cc's only signal that the worker no longer
    // wants the command — and the only way to stop it is to close the shell,
    // since the framed command shares the shell's process group and has no exec
    // id of its own to signal.
    const onAbort = () => { void this.#resetShell('the command was interrupted'); };
    signal?.addEventListener('abort', onAbort, { once: true });
    try {
      const r = await shell.run(command, timeoutMs === undefined ? {} : { timeoutMs });
      return { stdout: r.stdout, stderr: r.stderr, code: r.code, notice: this.#takeNotice() };
    } catch (e) {
      // A reset already happened inside ProviderShell for the wedge modes; note
      // it so the NEXT command tells the worker what it lost.
      this.#pendingNotice = this.#resetNotice(errMsg(e));
      return { stdout: '', stderr: `cc: ${errMsg(e)}\n`, code: 1, notice: null };
    } finally {
      signal?.removeEventListener('abort', onAbort);
      this.#armIdle();
    }
  }

  #ensureShell(): ProviderShell {
    if (this.#shell) return this.#shell;
    this.#shell = new ProviderShell(this.#system, {
      cwd: this.map.systemPath,
      ...(this.#shellCommandTimeoutMs === undefined ? {} : { commandTimeoutMs: this.#shellCommandTimeoutMs }),
    });
    return this.#shell;
  }

  #takeNotice(): string | null {
    const n = this.#pendingNotice;
    this.#pendingNotice = null;
    return n;
  }

  // R5: a reconnected shell TELLS the worker. Restoring only the cwd and
  // saying nothing hands it something that looks continuous while the rest of
  // the state is silently gone — the invisible divergence that costs a session
  // its trust in its own results.
  #resetNotice(reason: string): string {
    const cwd = this.#shell?.cwd ?? this.map.systemPath;
    return `[cc] the shell on system '${this.systemId}' was restarted (${reason}). `
      + `Its working directory is still ${cwd}, but exported variables, shell functions and `
      + `background jobs from earlier commands are gone.`;
  }

  async #resetShell(reason: string): Promise<void> {
    if (!this.#shell) return;
    this.#pendingNotice = this.#resetNotice(reason);
    await this.#shell.close();
  }

  #armIdle(): void {
    this.#disarmIdle();
    if (this.#closed) return;
    this.#idleTimer = setTimeout(() => { void this.#shell?.close(); }, this.#idleTtlMs);
    this.#idleTimer.unref?.();
  }

  #disarmIdle(): void {
    if (this.#idleTimer) { clearTimeout(this.#idleTimer); this.#idleTimer = null; }
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
      const local = path.resolve(this.map.root, spec);
      if (this.map.toSystem(local) === null) continue;
      try { await this.#bridge.pull(local); } catch { /* the CLI reports the miss */ }
    }
  }

  // ── Lifecycle ──────────────────────────────────────────────────────

  // Close the session's shell. Called on instance exit, kill and discardAll.
  // Idempotent.
  async close(): Promise<void> {
    this.#closed = true;
    this.#disarmIdle();
    const shell = this.#shell;
    this.#shell = null;
    await shell?.close();
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
