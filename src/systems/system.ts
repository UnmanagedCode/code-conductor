import path from 'node:path';
import type { SystemErrorCode } from './protocol.ts';

// The System interface — the seam every PROJECT-SCOPED operation goes through.
//
// A System is a remote EXECUTION ENVIRONMENT, not a remote filesystem. cc's own
// store, the Claude CLI and everything under `~/.claude/` are always local; what
// a System owns is the project tree: its git repo, its files, and shell commands
// run inside it.
//
// The provider contract has exactly three MUST primitives — `exec`, `readFile`
// and `writeFile` — and everything else here is DERIVED from `exec` on the far
// side (`stat -c`, `find`, `mkdir -p`, `rm -rf`, `unlink`, `realpath`,
// `chmod`). They are cc-side helpers rather than provider surface, which
// is why they live on this interface but will not appear in the wire protocol:
// a provider implements three operations, this interface exposes the shapes cc
// actually calls. `LocalSystem` implements each one natively, so routing
// through it is exactly today's behaviour.
//
// Two implementations: the in-process LocalSystem, and ProviderSystem, which
// reaches a system over the wire protocol (docs/systems-protocol.md).

// THE PATH INVARIANT, and it belongs to the CONTRACT rather than to either
// implementation: every path cc hands a System is absolute, on that system.
//
// It is a property of cc's CALLERS, so both implementations enforce it. A
// relative path resolves against wherever the far side happens to be running —
// the provider's process cwd, or cc's own for the in-process system — so a read
// answers about a file nobody asked for and a WRITE lands in a directory nobody
// chose while REPORTING SUCCESS. Both instances found so far came from a call
// site that resolved only the SYSTEM and then composed a path from a project
// that had none, so `path.join('', x)` produced a bare filename.
//
// A relative path arriving here is cc's OWN bug, never a provider's, so it is a
// hard throw and not a returned refusal: `exec` otherwise never rejects, and
// swallowing this as a result the caller inspects is exactly how the class
// stayed invisible. The operation is named in the message because the fault is
// at the call site, not at the boundary that caught it.
export function requireAbsolute(op: string, what: string, p: string): void {
  if (!path.isAbsolute(p)) {
    throw new Error(
      `${op}: ${what} must be absolute, got ${JSON.stringify(p)} — `
      + `cc never sends a relative path to a system (docs/systems-protocol.md)`,
    );
  }
}

// `argv` runs the binary directly; `shell` runs a command string through a
// login-ish shell (which is what a user-authored hook/start command expects —
// it may contain pipes, `&&`, or rely on shell PATH).
export type ExecSpec = { argv: string[] } | { shell: string };

// Which of a command's two output streams a chunk came from.
export type ExecStream = 'out' | 'err';

export interface ExecOptions {
  cwd: string;
  env?: NodeJS.ProcessEnv;
  timeoutMs?: number;
  // Per-stream TAIL cap in characters. Omit for unbounded (git porcelain output
  // is already small and callers parse it whole).
  cap?: number;
  // Total HEAD cap in bytes across both streams: retain the first N bytes and
  // keep draining. The opposite end from `cap` — project_bash truncates what is
  // *shown* while letting the command run (src/mcp/handlers.ts), which a tail
  // cap cannot express. One caller wants one end; setting both is meaningless.
  headCapBytes?: number;
  // Hard ceiling on output bytes. Unlike the two caps, this is a FAILURE, not a
  // truncation: past it the command is killed and the result is `{code: 1}`
  // carrying whatever output arrived first. It exists for callers that parse
  // output WHOLE — a clipped-but-successful parse would be read as the truth,
  // which is worse than a reported failure. runGit is the caller
  // (src/worktrees.ts); omitting it means unbounded retention in this process.
  maxBufferBytes?: number;
  // Called with each decoded chunk AS IT ARRIVES, and with the stream it came
  // from — the streaming hook every caller that shows live output uses. It
  // fires AFTER the caps above have had their say, so a consumer sees exactly
  // what is retained: nothing past `headCapBytes`, and nothing past the
  // `maxBufferBytes` fence.
  //
  // `which` exists because a caller that must keep the two streams apart — the
  // redirected Bash forwards each to the worker's own stdout/stderr — cannot
  // recover the split from an interleaved callback. Every other caller ignores
  // the second argument.
  onChunk?: (text: string, which: ExecStream) => void;
  // Cancel the command. Aborting KILLS it on the far side — the in-process
  // runner signals the process group, the wire one sends `close`, which is the
  // provider's instruction to kill it hard — rather than merely abandoning the
  // promise. Without that, a caller who has gone away leaves a command running
  // on someone else's machine until its own deadline, with nobody to read the
  // result. The result still resolves (exec never rejects), so the caller
  // decides what an aborted command MEANS by re-checking `signal.aborted`.
  signal?: AbortSignal;
  killGraceMs?: number;
  // 'ignore' hands the command a closed stdin, so an interactive command sees
  // EOF instead of hanging until the timeout. Load-bearing for project_bash and
  // for the redirected Bash framing, which runs each command group under
  // `< /dev/null` for the same reason.
  stdin?: 'ignore';
}

export interface ExecResult {
  // Process exit code, 124 on timeout, 1 on spawn error.
  code: number;
  stdout: string;
  stderr: string;
  // stdout + stderr interleaved in arrival order — what a human reads in a log.
  output: string;
  timedOut: boolean;
  // True when a cap clipped the output (so a caller can add a "…truncated" marker).
  truncated: boolean;
  durationMs: number;
  // The spawn error message when the command never started (ENOENT, EACCES),
  // else null. Distinguishes "failed to launch" from "ran and exited 1", which
  // callers surface differently.
  spawnError: string | null;
  // WHOSE failure `spawnError` describes, and the reason it cannot be answered
  // by reading the message.
  //
  // Two different things land in `spawnError`: the far side answering "I could
  // not start that command" (an errno about a real path on a real machine), and
  // the TRANSPORT dying (cc never got an answer at all). The second deliberately
  // embeds the dying provider's stderr TAIL so a refusal can quote why it died —
  // and a provider that dies OF an FS error, or merely logs one, then puts an
  // errno in a message that is not about a command at all. A provider's own
  // fatal() writes to stderr before exiting, and any uncaught Node exception
  // prints `Error: ENOENT: …`, so this is the ordinary case rather than a freak.
  //
  // Classifying that text by substring read the corpse as the diagnosis. So the
  // wire layer, which knows which of its own code paths produced the failure,
  // says so here instead. Set ONLY by ProviderSystem's transport paths —
  // LocalSystem never sets it, because a local spawn error is always about the
  // command.
  transportFailure?: true;
  // The far side's OWN code for a `spawnError` it answered about, when it sent
  // one. Set only from an id-addressed `error` frame — the far side saying "I
  // could not start that" — and therefore never together with
  // `transportFailure`, which is the case where nobody answered at all.
  //
  // It exists because the message is prose and the code is not: a provider that
  // refuses a command for a reason with no errno in its text (an unknown remote,
  // say) would otherwise have that reason re-derived from the wording, or lost.
  // A reader that has this prefers it; classifySpawnError stays the fallback for
  // a provider that sent no usable code.
  spawnErrorCode?: SystemErrorCode;
  // Set only when cc (or the far side, on a timeout) terminated the command on
  // a system whose provider does NOT advertise `processGroupSignal`: the direct
  // child was signalled and its grandchildren may still be running — the
  // orphaned-`npm ci` failure src/groupedCommand.ts's header records. ABSENT is
  // the normal answer, including for every local command, because the local
  // runner always leads its own process group.
  descendantsMaySurvive?: true;
  // The `maxBufferBytes` fence fired: the command was killed for producing too
  // much output. A FLAG rather than something a caller sniffs out of `stderr`,
  // because the redirected shell has to turn it into its own named failure and
  // classifying it by message text is how that drifts.
  outputOverflowed?: true;
}

export type SystemEntryKind = 'file' | 'dir' | 'symlink' | 'other';

// What `stat -c '%F %s %f %Y'` carries back, minus the parsing. ABSENCE IS A
// VALUE, NOT AN ERROR: `stat()` resolves to null for a path that does not
// exist, matching resolveProjectDir's ENOENT→null contract. Every other
// failure — EACCES, ENOTDIR — throws, because reading a broken installation as
// "no such file" turns one fixable fault into a fleet of misses.
export interface SystemStat {
  kind: SystemEntryKind;
  size: number;
  // POSIX mode bits, as `fs.Stats.mode` reports them.
  mode: number;
  mtimeMs: number;
}

export interface SystemDirent {
  name: string;
  kind: SystemEntryKind;
}

export interface WriteFileOptions {
  // Write to a temp file and rename over the target, so a reader never sees a
  // torn write. Mirrors writeFileAtomic (src/projects.ts).
  //
  // It is also the SYMLINK-SAFE write: a rename replaces the link itself, where
  // a plain write follows it to whatever it points at. The write-back path
  // (src/systems/fileBridge.ts) depends on that.
  atomic?: boolean;
  // POSIX permission bits for the written file, as fs.Stats.mode reports them
  // (the file-type bits are ignored). Set it to KEEP a mode: an atomic write
  // ends in a rename, so without this an edited script comes back 0644 and
  // silently stops being executable.
  mode?: number;
  // Fail with EEXIST rather than overwriting. The caller catching EEXIST is the
  // point — it is how "create if absent" stays safe against a concurrent writer.
  exclusive?: boolean;
}

export interface System {
  // Stable id, unique across registered systems. The built-in in-process
  // system is `local`.
  readonly id: string;

  // WHICH TARGET of that system this handle is bound to, or null for the
  // provider's own default (and always null for `local`).
  //
  // It lives on the HANDLE rather than being threaded through every call
  // because the target is a property of the project, not of the operation:
  // ~40 call sites already take a System and none of them should have to learn
  // that one endpoint can serve many machines. A handle knows where it points.
  readonly remoteId: string | null;

  // ── The three MUST primitives ──────────────────────────────────────
  exec(spec: ExecSpec, opts: ExecOptions): Promise<ExecResult>;
  // Whole-file UTF-8 read.
  readFile(filePath: string): Promise<string>;
  // The same primitive's RANGED form: at most `length` bytes from the start,
  // as bytes. The bounded read behind project_read, which must classify a file
  // (text or binary?) without pulling all of it. Omitting `length` reads the
  // whole file. Separate from readFile rather than an option on it because the
  // return type differs, and every caller knows which one it wants.
  readFileBytes(filePath: string, opts?: { length?: number }): Promise<Buffer>;
  writeFile(filePath: string, data: string, opts?: WriteFileOptions): Promise<void>;

  // ── Derived from exec on the far side ──────────────────────────────
  // null when the path does not exist. Follows symlinks, like fs.stat.
  stat(p: string): Promise<SystemStat | null>;
  readDir(p: string): Promise<SystemDirent[]>;
  realpath(p: string): Promise<string>;
  mkdir(p: string, opts?: { recursive?: boolean }): Promise<void>;
  // RECURSIVE, FORCED removal — `rm -rf`. The destructive shape: never call it
  // on a path cc does not own. See `unlink` below.
  removeTree(p: string): Promise<void>;
  // Remove ONE directory entry, never following it and never recursing. This is
  // the shape the `.external/<name>` record is deleted with, because its target
  // is the user's own repo: the realpath must never reach removeTree.
  unlink(p: string): Promise<void>;
  chmod(p: string, mode: number): Promise<void>;
}
