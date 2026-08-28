// The System interface — the seam every PROJECT-SCOPED operation goes through.
//
// A System is a remote EXECUTION ENVIRONMENT, not a remote filesystem
// (docs/systems-design.md). cc's own store, the Claude CLI and everything under
// `~/.claude/` are always local; what a System owns is the project tree: its
// git repo, its files, and shell commands run inside it.
//
// The provider contract has exactly three MUST primitives — `exec`, `readFile`,
// `writeFile` (§4.2) — and everything else here is DERIVED from `exec` on the
// far side (`stat -c`, `find`, `mkdir -p`, `rm -rf`, `unlink`, `realpath`,
// `chmod` — §4.6). They are cc-side helpers rather than provider surface, which
// is why they live on this interface but will not appear in the wire protocol:
// a provider implements three operations, this interface exposes the shapes cc
// actually calls. `LocalSystem` implements each one natively, so routing
// through it is exactly today's behaviour.
//
// The one implementation of this interface today is LocalSystem; the process-
// backed ProviderSystem arrives with the wire protocol in Phase 3.

// `argv` runs the binary directly; `shell` runs a command string through a
// login-ish shell (which is what a user-authored hook/start command expects —
// it may contain pipes, `&&`, or rely on shell PATH).
export type ExecSpec = { argv: string[] } | { shell: string };

export interface ExecOptions {
  cwd: string;
  env?: NodeJS.ProcessEnv;
  timeoutMs?: number;
  // Per-stream TAIL cap in characters. Omit for unbounded (git porcelain output
  // is already small and callers parse it whole).
  cap?: number;
  // Total HEAD cap in bytes across both streams: retain the first N bytes and
  // keep draining. The opposite end from `cap`, and the two are exclusive —
  // project_bash truncates what is *shown* while letting the command run
  // (src/mcp/handlers.ts), which a tail cap cannot express.
  headCapBytes?: number;
  onChunk?: (text: string) => void;
  killGraceMs?: number;
  // 'ignore' hands the command a closed stdin, so an interactive command sees
  // EOF instead of hanging until the timeout. Load-bearing for project_bash and
  // for the redirected Bash framing (§4.5 rule 3).
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
}

export type SystemEntryKind = 'file' | 'dir' | 'symlink' | 'other';

// What `stat -c '%F %s %f %Y'` carries back, minus the parsing. ABSENCE IS A
// VALUE, NOT AN ERROR: `stat()` resolves to null for a path that does not
// exist (§4.7), matching resolveProjectDir's ENOENT→null contract. Every other
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
  atomic?: boolean;
  // Fail with EEXIST rather than overwriting. The caller catching EEXIST is the
  // point — it is how "create if absent" stays safe against a concurrent writer.
  exclusive?: boolean;
}

export interface System {
  // Stable id, unique across registered systems. The built-in in-process
  // system is `local`.
  readonly id: string;

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

  // ── Derived from exec on the far side (§4.6) ───────────────────────
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
  // is the user's own repo: the realpath must never reach removeTree
  // (docs/systems-design.md §5.4).
  unlink(p: string): Promise<void>;
  chmod(p: string, mode: number): Promise<void>;
}
