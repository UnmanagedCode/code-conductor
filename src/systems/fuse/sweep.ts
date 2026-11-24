// The sweep over `systems/fuse/run/`, in two entries sharing one body:
//
//  - THE BOOT SWEEP (`sweepFuseSessions`), modelled exactly on
//    sweepSessionTmpDirs and licensed by the same argument: an instance id is a
//    fresh uuid per process, so ANY record left under `run/` at boot is dead by
//    construction.
//  - THE RUNTIME SWEEP (`requestFuseSweep`), requested after every FuseSession
//    teardown, which retries the run dirs an earlier teardown could not reclaim
//    (a wedge, a failed rescue copy). Nothing else retries them while cc runs.
//
// The boot sweep is LOAD-BEARING, not defence in depth. Nothing about a running
// process is persisted anywhere else in cc, the synchronous shutdown path
// (shutdownForResumeSync, at the end of every restart and shutdown) cannot run
// the async teardown at all, and a killed or crashed cc runs none. This is what
// covers both.
//
// Best-effort throughout: a directory cc cannot reclaim must never stop a boot.

import { promises as fsp } from 'node:fs';
import path from 'node:path';
import { fuseRunDirName, fuseRunRoot } from './plan.ts';
import { fuseRunDirActive, fuseRunDirLock, runTeardown, type TeardownReport } from './session.ts';
import type { MountDriver } from './driver.ts';
import { reclaimOrphanProcesses } from './orphans.ts';
import type { RawScan } from './procScan.ts';

export interface SweepOptions {
  driver?: MountDriver;
  // The /proc enumeration seam (procScan.ts), shared by the record pass's clean
  // verdict and the record-independent backstop. Injected so the fail-closed
  // attribution is testable without sudo.
  scan?: RawScan;
  log?: { warn: (...args: unknown[]) => void };
  // The live instance ids, RE-READ PER ENTRY (inside that entry's run-dir lock),
  // so an instance registered after the readdir is still seen. Empty at boot.
  liveIds?: () => Iterable<string>;
  // The record-independent orphan-process backstop. Default true. Off at
  // runtime: it skips a process only when its run dir holds `mount.json`, so it
  // would SIGKILL a live session that is mid-handshake, and the destroyed record
  // it exists for cannot arise while cc runs.
  backstop?: boolean;
  // Harvest each dir's policy events into the store-wide log. Default true. Off
  // at runtime: each dir was harvested by its own teardown or the boot sweep,
  // and a retry would append duplicate rows.
  harvest?: boolean;
  // Print an entry's report only when it differs from the last one printed for
  // that dir. Runtime only; the boot sweep always prints.
  quietRepeats?: boolean;
}

// The last report text printed per run dir, so a persistent wedge is said once
// at runtime. Deleted when the dir is reclaimed.
const lastReported = new Map<string, string>();

async function sweepOnce(opts: SweepOptions): Promise<TeardownReport[]> {
  const log = opts.log ?? console;
  const liveNow = (): string[] => [...(opts.liveIds?.() ?? [])];
  const root = fuseRunRoot();
  let entries: string[];
  try { entries = await fsp.readdir(root); }
  catch { return []; } // never created on an install with no FUSE-backed workers
  // Records first, orphans second — an orphan whose run directory still exists
  // is this pass's business, and the backstop skips it rather than racing it.

  const reports: TeardownReport[] = [];
  for (const name of entries) {
    const dir = path.join(root, name);
    try {
      // UNDER THE RUN DIR'S LOCK, shared with the owning FuseSession's
      // prepare()/teardown(): the sweep cannot interleave with either.
      await fuseRunDirLock.run(dir, async () => {
        // TWO SETS OVER THE SAME IDS, BECAUSE THE TWO CHECKS ARE KEYED
        // DIFFERENTLY. This compares DIRECTORY NAMES, so it goes through
        // `fuseRunDirName` (plan.ts); the orphan backstop matches
        // `CC_FUSE_INSTANCE_ID` off `/proc/<pid>/environ`, which is the whole id.
        // `fuseRunDirName` is the identity today — DERIVED rather than assumed
        // equal, because the two ask different questions and only the
        // derivation survives the name shape being revisited. Read HERE, per
        // entry, because an instance can register after the readdir.
        const live = new Set(liveNow().map(fuseRunDirName));
        // Never a live dir, and never one between a session's prepare() and
        // teardown() whatever the liveness source says.
        if (live.has(name) || fuseRunDirActive(dir)) return;
        // Reclaimed (by its own session's teardown) since the readdir.
        if (!(await fsp.lstat(dir).then(() => true, () => false))) return;

        // Every line this entry prints is buffered so a repeat can be dropped.
        const lines: string[] = [];
        const buffer = { warn: (...args: unknown[]) => { lines.push(args.join(' ')); } };
        const report = await runTeardown({ rundir: dir, driver: opts.driver, scan: opts.scan, log: buffer, harvest: opts.harvest });
        reports.push(report);
        // Every non-GONE terminal state is reported. A wedged record is LEFT IN
        // PLACE by runTeardown, so the next boot re-reports it rather than
        // silently rediscovering it.
        // KEYED ON THE VERDICT, not on the terminal state. `wedged` already means
        // "something is still there"; `terminalState` describes the daemon alone,
        // and `NO-PID` — a record that never named one — is an ordinary clean
        // reclaim rather than an anomaly worth alarming an operator about.
        if (report.wedged) {
          buffer.warn(`cc-fuse sweep: ${name} → ${report.terminalState}`
            + `${report.residualMounts.length ? `, mounts still present: ${report.residualMounts.join(' ')}` : ''}`
            + `${report.notes.length ? ` — ${report.notes.join('; ')}` : ''}`);
        } else {
          buffer.warn(`cc-fuse sweep: reclaimed ${name} (daemon ${report.daemonPid ?? '?'} ${report.terminalState}, unmounted ${report.unmounted.length}, reclaimed by marker ${report.markerReclaimed.length})`);
        }
        // WHAT THE DAEMON REFUSED, ON THE OPERATOR LOG. A session lost to a crash
        // never reached `runTeardown`'s own emit — its event stream is gone — so
        // this boot is the only place its policy events are ever read aloud.
        // `runTeardown` has already appended them to the store-wide log and put
        // the sentence on `notes`; the wedged arm above prints notes, the clean one
        // does not, so this covers the clean path without printing twice. The
        // rescue line (`cc-fuse rescue: `) is deliberately NOT matched by the
        // `cc-fuse: ` filter: `runTeardown` already warned it.
        if (!report.wedged && report.eventPaths.length) {
          buffer.warn(`cc-fuse sweep: ${name} — ${report.notes.filter(n => n.startsWith('cc-fuse: ')).join(' | ')}`);
        }
        // Reported, NEVER acted on: stale minors free nothing, survive abort and
        // are inert. A count of fusectl
        // entries is not a count of live daemons, so aborting an unrecorded one
        // would be aborting somebody else's filesystem on a guess.
        if (report.strayConnections > 0) {
          buffer.warn(`cc-fuse sweep: ${name} — ${report.strayConnections} fusectl connection(s) with no record of ours; NOT aborted`);
        }

        const text = lines.join('\n');
        if (report.removedRunDir) lastReported.delete(name);
        if (opts.quietRepeats && lastReported.get(name) === text) return;
        if (!report.removedRunDir) lastReported.set(name, text);
        for (const l of lines) log.warn(l);
      });
    } catch (e) {
      log.warn(`cc-fuse sweep: ${name} could not be swept: ${(e as Error).message}`);
    }
  }
  // THE RECORD-INDEPENDENT BACKSTOP. The ordering guarantees above should leave
  // nothing for it; it runs so that "nothing was left" is a check rather than an
  // argument, and so a leak whose record was destroyed is discoverable at all —
  // a private namespace never appears in /proc/1/mounts, and a destroyed record
  // is in no set to re-verify. Boot only (`backstop: false` at runtime).
  if (opts.backstop !== false) {
    try {
      const backstop = await reclaimOrphanProcesses(root, { driver: opts.driver, scan: opts.scan, liveIds: liveNow(), log });
      if (!backstop.enumerated) log.warn('cc-fuse sweep: could not enumerate processes — this boot cannot claim the store is clean');
    } catch (e) { log.warn(`cc-fuse sweep: the orphan-process backstop failed: ${(e as Error).message}`); }
  }
  return reports;
}

// Serialised: one sweep body at a time, boot or runtime, so two never walk the
// same directories at once.
let tail: Promise<unknown> = Promise.resolve();
let queued: Promise<TeardownReport[]> | null = null;

export function sweepFuseSessions(opts: SweepOptions = {}): Promise<TeardownReport[]> {
  const run = tail.then(() => sweepOnce(opts));
  tail = run.catch(() => {});
  return run;
}

// The runtime sweep: never concurrent with itself or the boot sweep; a request
// made while one is queued joins it.
export function requestFuseSweep(opts: {
  liveIds: () => Iterable<string>;
  log?: SweepOptions['log'];
  driver?: MountDriver;
  scan?: RawScan;
}): Promise<TeardownReport[]> {
  if (queued) return queued;
  const run = tail
    .then(() => { queued = null; return sweepOnce({ ...opts, backstop: false, harvest: false, quietRepeats: true }); })
    .catch((e: Error) => { (opts.log ?? console).warn(`cc-fuse runtime sweep failed: ${e.message}`); return [] as TeardownReport[]; });
  queued = run;
  tail = run;
  return run;
}
