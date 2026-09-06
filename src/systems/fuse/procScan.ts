// ENUMERATING A SESSION'S PROCESSES BY SOMETHING THEY CARRY.
//
// THE PRINCIPLE THIS MODULE EXISTS TO SERVE: a teardown's "clean" verdict must
// be established from NAMESPACE MEMBERSHIP, not from the recorded pid set. The
// recorded set is what the bootstrap happened to write down; the namespace is
// what is actually there. Three separate defects on this ticket were the same
// flaw wearing different clothes — a leaked anchor whose record had been
// deleted, an intent-only teardown that signalled nobody, and a live worker
// child holding mounts open that no recorded pid named. Anything cc cannot
// enumerate is a WEDGE, not a pass.
//
// TWO IDENTITIES, BOTH CARRIED BY THE PROCESS, NEITHER A NAME OR A PATTERN:
//   * `/proc/<pid>/ns/mnt` — the mount namespace itself, compared against the
//     `nsMntId` the bootstrap recorded. This is membership by definition, and
//     it sees processes no record names (a Bash forwarder's children, say).
//   * `CC_FUSE_INSTANCE_ID` / `CC_FUSE_RUNDIR` in `/proc/<pid>/environ`, put
//     there by `execve` before the bootstrap forked anything, so they are in
//     the exec image of everything it starts. This is the only handle left
//     when a record is gone or was never written.
// There is no match on comm, on cmdline, or on any name or pattern anywhere:
// `sleep infinity` is about as generic a needle as exists on a Linux box, and
// a pattern match here is the mechanism that once killed this devcontainer.
//
// WHY TWO UID PASSES. `/proc/<pid>/ns/*` and `/proc/<pid>/environ` are both
// governed by `ptrace_may_access`, which on a host without `CAP_SYS_PTRACE`
// (this container: not even in the bounding set) grants access only when the
// caller's uid equals the target's. So cc as itself sees the worker and its
// children (uid 1000), and cc through `sudo` sees the bootstrap and the anchor
// (uid 0) — and neither sees the other's. Both passes run and their results are
// unioned by pid. The union daemon is invisible to both, because `setfsuid`
// makes it non-dumpable; the record is the only handle on it, which is why the
// record's ordering guarantee is the primary mechanism and this is the check.
//
// IT FAILS CLOSED, and the failure is REPORTED rather than swallowed: a scan
// that could not run yields `ok: false`, and a caller that cannot enumerate
// must treat the namespace as non-empty.

import { execFile } from 'node:child_process';

export interface ProcRow {
  pid: number;
  // /proc/<pid>/stat field 22 — the only identity that cannot collide across
  // incarnations of a pid.
  starttime: string;
  // `mnt:[…]`, or '' where it could not be read.
  nsMnt: string;
  instanceId: string;
  rundir: string;
}

export interface ScanResult {
  // false ⇒ NOTHING was enumerated, and a caller must not read an empty
  // `rows` as "nothing is there".
  ok: boolean;
  rows: ProcRow[];
}

// `withEnviron` is off by default because it is the expensive half — one extra
// read per pid — and the common caller (the membership verdict) already has an
// `nsMntId` to compare against. The intent-only path and the boot sweep's
// backstop have no record to compare against, and turn it on.
export interface ScanOptions { withEnviron?: boolean }

// One pass over /proc. Emits `pid \t starttime \t nsMnt \t instanceId \t rundir`,
// every field best-effort and empty where unreadable; the parser fails closed on
// the ones a given caller needs.
function scanScript(withEnviron: boolean): string {
  return `
for d in /proc/[0-9]*; do
  st=$(awk '{ q = index($0, ")"); split(substr($0, q + 2), f, " "); print f[20] }' "$d/stat" 2>/dev/null)
  [ -n "$st" ] || continue
  ns=$(readlink "$d/ns/mnt" 2>/dev/null || echo "")
  id=""; rd=""
${withEnviron ? `  if [ -r "$d/environ" ]; then
    id=$(tr '\\0' '\\n' < "$d/environ" 2>/dev/null | sed -n 's/^CC_FUSE_INSTANCE_ID=//p' | head -1)
    rd=$(tr '\\0' '\\n' < "$d/environ" 2>/dev/null | sed -n 's/^CC_FUSE_RUNDIR=//p' | head -1)
  fi` : ''}
  printf '%s\\t%s\\t%s\\t%s\\t%s\\n' "\${d#/proc/}" "$st" "$ns" "$id" "$rd"
done
printf 'canary\\t%s\\n' "$$"
`;
}

// THE CANARY. `ok` must mean "this pass enumerated", not "the command exited
// 0". On a host missing `awk`, `sed` or `tr` every row is skipped by the
// `[ -n "$st" ] || continue` guard, the shell still exits 0, and zero rows
// would read as an empty namespace with everything in it still alive — the
// same "clean because nothing was seen" that this ticket has produced five
// times. The scanning shell is itself a process in /proc, so a pass that
// cannot see its OWN pid saw nothing.
export function passEnumerated(raw: string): boolean {
  let canary: number | null = null;
  for (const line of raw.split('\n')) {
    if (line.startsWith('canary\t')) canary = Number(line.slice(7).trim());
  }
  if (canary === null || !Number.isInteger(canary)) return false;
  return parseScan(raw).some(r => r.pid === canary);
}

function run(cmd: string, args: string[]): Promise<string | null> {
  return new Promise((resolve) => {
    const child = execFile(cmd, args, { timeout: 60_000, maxBuffer: 16 << 20 },
      (err, stdout) => resolve(err ? null : String(stdout)));
    child.on('error', () => resolve(null));
  });
}

export type RawScan = (opts: ScanOptions) => Promise<{ ok: boolean; raw: string }>;

// Both uid passes, unioned by pid. `ok` is true only if BOTH ran: a missing
// half is a blind spot, and a blind spot is not an empty result.
export const realProcScan: RawScan = async ({ withEnviron = false } = {}) => {
  const script = scanScript(withEnviron);
  const [own, root] = await Promise.all([
    run('/bin/sh', ['-c', script]),
    run('sudo', ['-n', '/bin/sh', '-c', script]),
  ]);
  // BOTH passes must have enumerated. Exiting 0 is not enough (the canary), and
  // a missing half is a blind spot rather than an empty result.
  const ok = own !== null && root !== null && passEnumerated(own) && passEnumerated(root);
  return { ok, raw: `${own ?? ''}\n${root ?? ''}` };
};

export function parseScan(raw: string): ProcRow[] {
  const byPid = new Map<number, ProcRow>();
  for (const line of raw.split('\n')) {
    if (!line) continue;
    const [pidStr, starttime, nsMnt = '', instanceId = '', rundir = ''] = line.split('\t');
    const pid = Number(pidStr);
    // Fail closed on the two fields every consumer needs.
    if (!Number.isInteger(pid) || pid <= 1 || !starttime) continue;
    const prev = byPid.get(pid);
    // Union: the pass that could read a field wins over the one that could not.
    byPid.set(pid, {
      pid, starttime,
      nsMnt: nsMnt || prev?.nsMnt || '',
      instanceId: instanceId || prev?.instanceId || '',
      rundir: rundir || prev?.rundir || '',
    });
  }
  return [...byPid.values()].sort((a, b) => a.pid - b.pid);
}

export async function scanProcesses(opts: ScanOptions = {}, scan: RawScan = realProcScan): Promise<ScanResult> {
  const { ok, raw } = await scan(opts);
  return { ok, rows: parseScan(raw) };
}

function underPath(inner: string, outer: string): boolean {
  return inner === outer || inner.startsWith(outer.endsWith('/') ? outer : outer + '/');
}

// Every process in the given mount namespace, or carrying the given run
// directory in its environment. Either identity qualifies: the namespace id is
// the definitional one, and the run directory covers the case where there is no
// recorded namespace id yet.
export function membersOf(rows: readonly ProcRow[], opts: { nsMntId?: string; rundir?: string }): ProcRow[] {
  return rows.filter(r =>
    (!!opts.nsMntId && r.nsMnt === opts.nsMntId)
    || (!!opts.rundir && !!r.rundir && r.rundir === opts.rundir));
}

// Every process attributable to ANY session under this store's run root.
export function orphansUnder(rows: readonly ProcRow[], runRoot: string): ProcRow[] {
  return rows.filter(r => r.instanceId && r.rundir && underPath(r.rundir, runRoot));
}
