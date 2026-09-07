// Reclaiming processes a record does not cover, over the enumeration in
// procScan.ts. Two callers, one mechanism:
//
//   * `runTeardown`, when there is no `mount.json` — the bootstrap died, or is
//     still mid-handshake, and the only handle on what it already started is
//     the marker its own `execve` put in their environments. Without this the
//     intent-only path signalled nobody and then deleted the directory.
//   * `sweepFuseSessions`, as the record-independent backstop, so "nothing was
//     left" is a check rather than an argument.
//
// Attribution, the two uid passes and the fail-closed rules are procScan.ts's;
// this module only decides what to do with a row.

import { promises as fsp } from 'node:fs';
import path from 'node:path';
import type { MountDriver } from './driver.ts';
import { realMountDriver } from './driver.ts';
import { scanProcesses, orphansUnder, type ProcRow, type RawScan } from './procScan.ts';

export interface OrphanReclaim {
  instanceId: string;
  pid: number;
  unmounted: string[];
  killed: boolean;
  note?: string;
}

// Free a process's mounts through it and then signal it, in that order: it is
// the handle, and killing it first takes the namespace with it before anything
// can be reported about what was in it. Identity is re-verified immediately
// before the signal — a pid can have died and been recycled since the scan.
export async function reclaimProcess(
  row: ProcRow, rundir: string, driver: MountDriver,
): Promise<OrphanReclaim> {
  const res: OrphanReclaim = { instanceId: row.instanceId, pid: row.pid, unmounted: [], killed: false };
  for (const mp of ((await driver.readMounts(row.pid)) ?? [])
    .filter(mp => mp === rundir || mp.startsWith(rundir + '/'))
    .sort((a, b) => b.length - a.length)) {
    if (await driver.umountIn(row.pid, mp, { lazy: false }) || await driver.umountIn(row.pid, mp, { lazy: true })) {
      res.unmounted.push(mp);
    }
  }
  const stat = await driver.readProcStat(row.pid);
  if (!stat) { res.note = 'gone before it could be signalled'; return res; }
  if (stat.starttime !== row.starttime) { res.note = 'pid recycled since the scan — NOT signalled'; return res; }
  // Privileged: an orphan may be the root-owned anchor or bootstrap, and an
  // unprivileged signal at one is EPERM, which every caller here would read as
  // "already gone".
  await driver.signal(row.pid, 'SIGKILL', { privileged: true });
  const after = await driver.readProcStat(row.pid);
  res.killed = !after || after.starttime !== row.starttime;
  if (!res.killed) res.note = 'survived SIGKILL';
  return res;
}

export interface OrphanSweepResult {
  // false ⇒ the scan could not run, so an empty `reclaimed` proves nothing.
  enumerated: boolean;
  reclaimed: OrphanReclaim[];
}

export async function reclaimOrphanProcesses(
  runRoot: string,
  opts: { driver?: MountDriver; scan?: RawScan; liveIds?: Iterable<string>; log?: { warn: (...a: unknown[]) => void } } = {},
): Promise<OrphanSweepResult> {
  const driver = opts.driver ?? realMountDriver;
  const log = opts.log ?? console;
  const keep = new Set(opts.liveIds ?? []);
  const { ok, rows } = await scanProcesses({ withEnviron: true }, opts.scan);
  const out: OrphanSweepResult = { enumerated: ok, reclaimed: [] };
  if (!ok) {
    log.warn('cc-fuse sweep: the process scan could not run — an empty orphan set proves nothing here');
    return out;
  }

  for (const row of orphansUnder(rows, runRoot)) {
    if (keep.has(row.instanceId)) continue;
    // A run directory that still holds a record is the record pass's business.
    try { await fsp.access(path.join(row.rundir, 'mount.json')); continue; } catch { /* record-less: ours */ }
    const res = await reclaimProcess(row, row.rundir, driver);
    out.reclaimed.push(res);
    log.warn(`cc-fuse sweep: reclaimed record-less process ${row.pid} of session ${row.instanceId}`
      + ` (unmounted ${res.unmounted.length}${res.killed ? ', killed' : `, ${res.note}`})`);
  }
  return out;
}
