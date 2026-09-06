// The RECORD-INDEPENDENT backstop, and the reason it exists.
//
// cc's teardown and its boot sweep both iterate RECORDS under
// `systems/fuse/run/`. `bootstrap.sh` (step 2a) and `runTeardown` (step 7)
// between them guarantee the record outlives every process it names, so a
// record-less orphan should not arise. This module is what makes that a
// CHECKABLE claim rather than an argued one: it finds the same processes
// without reading a record at all, so a leak whose record was destroyed —
// which no `/proc/1/mounts` delta can see either, because the namespace is
// private — is discoverable instead of permanent.
//
// HOW A PROCESS IS ATTRIBUTED, and how it is NOT. Selection is on an IDENTITY
// THE PROCESS CARRIES: `CC_FUSE_INSTANCE_ID` and `CC_FUSE_RUNDIR` in
// `/proc/<pid>/environ`, put there by `execve` before the bootstrap forked
// anything, so they are in the exec image of everything it starts. There is NO
// match on comm, on cmdline, or on any name or pattern — `sleep infinity` is
// about as generic a needle as exists on a Linux box, and a pattern match here
// would be the mechanism that once killed this devcontainer.
//
// IT FAILS CLOSED at every step: an unreadable `environ` is not ours, a missing
// field is not ours, a `rundir` outside this store's run root is not ours, and
// a pid whose starttime no longer matches what the scan read is not signalled.
//
// WHAT IT CANNOT SEE, stated so the guarantee is not overstated: `environ` is
// governed by `ptrace_may_access`, so a process that has changed credentials is
// invisible to it on a host without `CAP_SYS_PTRACE` — which is exactly the
// union daemon (it calls `setfsuid` per request) and the worker (it is
// `setpriv`'d). The ANCHOR is visible precisely because it is
// credential-stable, and that is enough: it is the last process holding the
// mount namespace open, and freeing its mounts closes the /dev/fuse connection,
// which is what makes the daemon exit. The record remains the only handle on
// the daemon's pid, which is why the ordering fix — not this module — is the
// actual repair.

import { promises as fsp } from 'node:fs';
import { execFile } from 'node:child_process';
import path from 'node:path';
import type { MountDriver } from './driver.ts';
import { realMountDriver } from './driver.ts';

export interface OrphanProcess {
  pid: number;
  starttime: string;
  instanceId: string;
  rundir: string;
}

// One privileged pass over /proc, emitting `pid \t starttime \t id \t rundir`
// for every process carrying our marker. A single `sudo` invocation rather than
// one per pid: the scan runs at every boot.
const SCAN_SCRIPT = `
for d in /proc/[0-9]*; do
  [ -r "$d/environ" ] || continue
  id=$(tr '\\0' '\\n' < "$d/environ" 2>/dev/null | sed -n 's/^CC_FUSE_INSTANCE_ID=//p' | head -1)
  [ -n "$id" ] || continue
  rd=$(tr '\\0' '\\n' < "$d/environ" 2>/dev/null | sed -n 's/^CC_FUSE_RUNDIR=//p' | head -1)
  [ -n "$rd" ] || continue
  st=$(awk '{ q = index($0, ")"); split(substr($0, q + 2), f, " "); print f[20] }' "$d/stat" 2>/dev/null)
  [ -n "$st" ] || continue
  printf '%s\\t%s\\t%s\\t%s\\n' "\${d#/proc/}" "$st" "$id" "$rd"
done
`;

export type OrphanScan = () => Promise<string>;

export const realOrphanScan: OrphanScan = () => new Promise((resolve) => {
  const child = execFile('sudo', ['-n', '/bin/sh', '-c', SCAN_SCRIPT],
    { timeout: 30_000, maxBuffer: 4 << 20 }, (err, stdout) => resolve(err ? '' : String(stdout)));
  child.on('error', () => resolve(''));
});

export function parseOrphanScan(raw: string, runRoot: string): OrphanProcess[] {
  const out: OrphanProcess[] = [];
  for (const line of raw.split('\n')) {
    const [pidStr, starttime, instanceId, rundir] = line.split('\t');
    const pid = Number(pidStr);
    // Fail closed on every field.
    if (!Number.isInteger(pid) || pid <= 1) continue;
    if (!starttime || !instanceId || !rundir) continue;
    // Only this store's run root. Another install's processes are not ours to
    // signal, and neither is a marker somebody else set.
    if (rundir !== runRoot && !rundir.startsWith(runRoot.endsWith('/') ? runRoot : runRoot + '/')) continue;
    out.push({ pid, starttime, instanceId, rundir });
  }
  return out;
}

export async function findOrphanProcesses(runRoot: string, scan: OrphanScan = realOrphanScan): Promise<OrphanProcess[]> {
  return parseOrphanScan(await scan(), runRoot);
}

export interface OrphanReclaim {
  instanceId: string;
  pid: number;
  unmounted: string[];
  killed: boolean;
  note?: string;
}

// Reclaim the processes a record no longer covers. Called by the boot sweep
// AFTER the record pass, so anything still covered by a live record directory
// is left to that pass rather than raced with it.
export async function reclaimOrphanProcesses(
  runRoot: string,
  opts: { driver?: MountDriver; scan?: OrphanScan; liveIds?: Iterable<string>; log?: { warn: (...a: unknown[]) => void } } = {},
): Promise<OrphanReclaim[]> {
  const driver = opts.driver ?? realMountDriver;
  const log = opts.log ?? console;
  const keep = new Set(opts.liveIds ?? []);
  const out: OrphanReclaim[] = [];

  for (const o of await findOrphanProcesses(runRoot, opts.scan ?? realOrphanScan)) {
    if (keep.has(o.instanceId)) continue;
    // A run directory that still exists is the record pass's business.
    try { await fsp.access(path.join(o.rundir, 'mount.json')); continue; } catch { /* record-less: ours */ }

    const res: OrphanReclaim = { instanceId: o.instanceId, pid: o.pid, unmounted: [], killed: false };
    // Free the mounts through this very process's namespace before signalling
    // it — it is the handle, and killing it first would take the namespace with
    // it before anything could be reported about what was in it.
    for (const mp of ((await driver.readMounts(o.pid)) ?? [])
      .filter(mp => mp === o.rundir || mp.startsWith(o.rundir + '/'))
      .sort((a, b) => b.length - a.length)) {
      if (await driver.umountIn(o.pid, mp, { lazy: false }) || await driver.umountIn(o.pid, mp, { lazy: true })) {
        res.unmounted.push(mp);
      }
    }
    // Re-verify the identity immediately before signalling: the pid may have
    // died and been recycled since the scan read it.
    const stat = await driver.readProcStat(o.pid);
    if (!stat) { res.note = 'gone before it could be signalled'; out.push(res); continue; }
    if (stat.starttime !== o.starttime) { res.note = 'pid recycled since the scan — NOT signalled'; out.push(res); continue; }
    await driver.signal(o.pid, 'SIGKILL', { privileged: true });
    const after = await driver.readProcStat(o.pid);
    res.killed = !after || after.starttime !== o.starttime;
    if (!res.killed) res.note = 'survived SIGKILL';
    out.push(res);
    log.warn(`cc-fuse sweep: reclaimed record-less process ${o.pid} of session ${o.instanceId}`
      + ` (unmounted ${res.unmounted.length}${res.killed ? ', killed' : `, ${res.note}`})`);
  }
  return out;
}
