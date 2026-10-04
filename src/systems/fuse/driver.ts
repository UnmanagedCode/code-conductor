// THE SEAM the teardown state machine depends on: every observation of, and
// every signal to, a process or a mount. Narrow on purpose — a fake driver
// backed by in-memory tables is what lets the ordering, the pid-reuse arm and
// the wedge branch be tested with no sudo, no FUSE and no real process.
//
// PID DISCIPLINE, and it binds every implementation of this interface:
// `signal` may only ever be handed a numeric pid the caller captured itself,
// and the caller re-verifies it against /proc/<pid>/stat field 22 (starttime)
// immediately before signalling. There is no kill-by-name anywhere behind this
// interface — no pkill, no killall, no pattern of any kind. A forked subshell
// inherits its parent's argv, so a `pgrep -f <pattern>` matches the very shell
// running it, and in a container a broad kill reaches PID 1.

import { promises as fsp, readFileSync } from 'node:fs';
import { execFile } from 'node:child_process';

export interface ProcStat {
  // /proc/<pid>/stat field 22 — the only identity that cannot collide across
  // incarnations of a pid.
  starttime: string;
  // field 3.
  state: string;
}

// `not-mounted`: `root` is not attached on `minor`, so the minor is not
// provably this session's; `no-entry`: fusectl has no `<minor>/abort`.
export type AbortOwnResult = 'aborted' | 'not-mounted' | 'no-entry' | 'failed';

// THE OWNERSHIP CHECK AND THE WRITE, IN ONE SHELL.
// `$1` fusectl, `$2` minor, `$3` the union root, `$4` the mountinfo to read
// (`/proc/self/mountinfo` of the shell itself, inside the namespace). A minor
// is this session's exactly while its union root is attached on it: some
// mountinfo line has mountpoint `$3` (field 5) and a dev (field 3) whose minor,
// `*:` stripped as bootstrap.sh step 6 strips it, is `$2`. Exit 3 when not,
// 4 when fusectl has no entry for it, else the write's own status.
export const ABORT_OWN_CONNECTION_SH = `awk -v p="$3" -v m="$2" '$5 == p { d = $3; sub(/^[^:]*:/, "", d); if (d == m) f = 1 } END { exit !f }' "$4" || exit 3
[ -e "$1/$2/abort" ] || exit 4
printf 1 > "$1/$2/abort"`;

export interface MountDriver {
  // Mountpoints listed in /proc/<pid>/mounts, in file order. Null when the pid
  // is gone. NEVER `mountpoint -q`: it stat()s the path and reports "not
  // mounted" for exactly the stale-transport case cleanup exists for.
  readMounts(pid: number): Promise<string[] | null>;
  readProcStat(pid: number): Promise<ProcStat | null>;
  // The thread ids in /proc/<pid>/task. Null when the pid is gone.
  readTaskDir(pid: number): Promise<string[] | null>;
  // `nsenter --mount=/proc/<nsPid>/ns/mnt -- umount [-l] <mp>`, as root.
  umountIn(nsPid: number, mountpoint: string, opts: { lazy: boolean }): Promise<boolean>;
  // `echo 1 > <fusectl>/<minor>/abort`, as root, inside the namespace — but
  // ONLY while `root` is attached in that namespace on connection `minor`,
  // checked in the same root shell as the write (ABORT_OWN_CONNECTION_SH).
  // There is deliberately no unverified abort: a fusectl entry carries no
  // owner, and once this session's superblock is gone its minor is any other
  // session's to reuse.
  abortOwnConnection(nsPid: number, fusectl: string, minor: string, root: string): Promise<AbortOwnResult>;
  // The connection minors listed under <fusectl> inside the namespace.
  listConnections(nsPid: number, fusectl: string): Promise<string[]>;
  // `privileged` routes through sudo, for the root-owned daemon; the worker has
  // had privilege dropped back to cc's own uid and is signalled directly.
  signal(pid: number, sig: 'SIGTERM' | 'SIGKILL', opts: { privileged: boolean }): Promise<void>;
  now(): number;
  sleep(ms: number): Promise<void>;
}

// /proc/<pid>/mounts escapes space, tab, newline and backslash as octal.
export function unescapeMountPath(s: string): string {
  return s.replace(/\\(0[0-7][0-7])/g, (_, oct: string) => String.fromCharCode(parseInt(oct, 8)));
}

export function parseProcStat(raw: string): ProcStat | null {
  // The comm field is parenthesised and may itself contain spaces and
  // parentheses, so fields are counted from the LAST ')'.
  const close = raw.lastIndexOf(')');
  if (close < 0) return null;
  const rest = raw.slice(close + 2).split(' ');
  // rest[0] is field 3 (state); field 22 is rest[19].
  if (rest.length < 20) return null;
  return { state: rest[0], starttime: rest[19] };
}

function run(cmd: string, args: string[], timeoutMs: number): Promise<boolean> {
  return new Promise((resolve) => {
    const child = execFile(cmd, args, { timeout: timeoutMs }, (err) => resolve(!err));
    child.on('error', () => resolve(false));
  });
}

// A command's exit status: null when it could not be run to an exit at all
// (spawn failure, timeout, signal).
export type StatusRunner = (cmd: string, args: string[], timeoutMs: number) => Promise<number | null>;

// `run`, keeping the exit status.
export function runStatus(cmd: string, args: string[], timeoutMs: number): Promise<number | null> {
  return new Promise((resolve) => {
    const child = execFile(cmd, args, { timeout: timeoutMs }, (err) => {
      if (!err) { resolve(0); return; }
      const code = (err as { code?: unknown }).code;
      resolve(typeof code === 'number' ? code : null);
    });
    child.on('error', () => resolve(null));
  });
}

function capture(cmd: string, args: string[], timeoutMs: number): Promise<string | null> {
  return new Promise((resolve) => {
    const child = execFile(cmd, args, { timeout: timeoutMs, maxBuffer: 1 << 20 }, (err, stdout) => resolve(err ? null : String(stdout)));
    child.on('error', () => resolve(null));
  });
}

// The starttime of a live pid, or null. SYNCHRONOUS, because the two
// shutdown-before-exit paths (shutdownTempSync, shutdownForResumeSync) are and
// cannot be otherwise, and they still may not signal a pid they have not
// re-verified.
export function procStartSync(pid: number): string | null {
  try { return parseProcStat(readFileSync(`/proc/${pid}/stat`, 'utf8'))?.starttime ?? null; }
  catch { return null; }
}

// IS THIS PID STILL RUNNING? `kill(pid, 0)` raises ESRCH when the process is
// gone and
// EPERM when it is alive but not ours to signal — and EPERM is REACHABLE here,
// because a FUSE-wrapped worker is root until the bootstrap's setpriv runs and
// the anchor and the daemon are root for their whole lives. A catch-all reads
// EPERM as death and stops waiting for a process that is very much alive.
//
// ONLY ESRCH IS DEATH. Anything else — EPERM, an unknown errno, an error with
// no code at all — means "still there, or not known to be gone", which is the
// same answer for a caller deciding whether it may stop waiting.
//
// Synchronous because its callers are: the two shutdown-before-exit paths in
// instances.ts cannot await.
export function pidIsAlive(pid: number, kill: (p: number, sig: number) => void = process.kill): boolean {
  try { kill(pid, 0); return true; }
  catch (e) { return (e as NodeJS.ErrnoException)?.code !== 'ESRCH'; }
}

// `exec` is the runner the abort path's one command goes through. Injectable so
// a test can run the shipping argv — the ownership-checked script, its
// positionals and the exit mapping — against files standing in for a
// namespace's mountinfo and fusectl, with no sudo.
export function createRealMountDriver({ exec = runStatus }: { exec?: StatusRunner } = {}): MountDriver {
  return {
    async readMounts(pid) {
      let raw: string;
      try { raw = await fsp.readFile(`/proc/${pid}/mounts`, 'utf8'); }
      catch { return null; }
      return raw.split('\n').filter(Boolean).map(l => unescapeMountPath(l.split(' ')[1] ?? '')).filter(Boolean);
    },
    async readProcStat(pid) {
      try { return parseProcStat(await fsp.readFile(`/proc/${pid}/stat`, 'utf8')); }
      catch { return null; }
    },
    async readTaskDir(pid) {
      try { return await fsp.readdir(`/proc/${pid}/task`); }
      catch { return null; }
    },
    umountIn(nsPid, mountpoint, { lazy }) {
      const args = ['-n', 'nsenter', `--mount=/proc/${nsPid}/ns/mnt`, '--', 'umount'];
      if (lazy) args.push('-l');
      args.push(mountpoint);
      return run('sudo', args, 10_000);
    },
    async abortOwnConnection(nsPid, fusectl, minor, root) {
      // The write is done by a shell inside the namespace: fusectl's `abort` is a
      // procfs-style file, and only a write of any byte to it has the effect.
      const status = await exec('sudo', ['-n', 'nsenter', `--mount=/proc/${nsPid}/ns/mnt`, '--',
        '/bin/sh', '-c', ABORT_OWN_CONNECTION_SH, 'sh', fusectl, minor, root, '/proc/self/mountinfo'], 10_000);
      return status === 0 ? 'aborted' : status === 3 ? 'not-mounted' : status === 4 ? 'no-entry' : 'failed';
    },
    async listConnections(nsPid, fusectl) {
      const out = await capture('sudo', ['-n', 'nsenter', `--mount=/proc/${nsPid}/ns/mnt`, '--',
        '/bin/sh', '-c', 'ls "$1" 2>/dev/null || true', 'sh', fusectl], 10_000);
      return (out ?? '').split('\n').map(s => s.trim()).filter(Boolean);
    },
    async signal(pid, sig, { privileged }) {
      if (privileged) { await run('sudo', ['-n', 'kill', `-${sig.slice(3)}`, String(pid)], 10_000); return; }
      // Swallowed deliberately, and NOT read as death: EPERM lands here too (a
      // FUSE worker is root until the bootstrap's setpriv runs). Nothing here
      // concludes anything from the throw — every caller re-verifies the pid
      // positively afterwards, which is what makes that safe.
      try { process.kill(pid, sig); } catch { /* gone, or not ours to signal */ }
    },
    now() { return Date.now(); },
    sleep(ms) { return new Promise(r => setTimeout(r, ms)); },
  };
}

export const realMountDriver: MountDriver = createRealMountDriver();
