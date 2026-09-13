// The boot sweep, modelled exactly on sweepSessionTmpDirs and licensed by the
// same argument: an instance id is a fresh uuid per process, so ANY record left
// under `systems/fuse/run/` at boot is dead by construction.
//
// This is LOAD-BEARING, not defence in depth. Nothing about a running process
// is persisted anywhere else in cc, and `scheduleRestart` fires
// `instances.shutdown()` and then `process.exit(0)` ~50 ms later — so the
// in-process teardown provably does not finish, and the two synchronous
// shutdown paths (shutdownTempSync, shutdownForResumeSync) cannot run it at all
// because it is async. This is what covers all three.
//
// Best-effort throughout: a directory cc cannot reclaim must never stop a boot.

import { promises as fsp } from 'node:fs';
import path from 'node:path';
import { fuseRunDirName, fuseRunRoot } from './plan.ts';
import { runTeardown, type TeardownReport } from './session.ts';
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
  // Present for symmetry with sweepSessionTmpDirs; at boot there are no live
  // sessions, and the sweep is only ever called there.
  liveIds?: Iterable<string>;
}

export async function sweepFuseSessions(opts: SweepOptions = {}): Promise<TeardownReport[]> {
  const log = opts.log ?? console;
  // TWO SETS OVER THE SAME IDS, BECAUSE THE TWO PASSES BELOW ARE KEYED
  // DIFFERENTLY. The readdir loop compares DIRECTORY NAMES, so it goes through
  // `fuseRunDirName` (plan.ts); the orphan backstop matches
  // `CC_FUSE_INSTANCE_ID` off `/proc/<pid>/environ`, which is the whole id.
  // `fuseRunDirName` is the identity today — DERIVED rather than assumed
  // equal, because the two passes ask different questions and only the
  // derivation survives the name shape being revisited.
  const liveIds = new Set(opts.liveIds ?? []);
  const keep = new Set([...liveIds].map(fuseRunDirName));
  const root = fuseRunRoot();
  let entries: string[];
  try { entries = await fsp.readdir(root); }
  catch { return []; } // never created on an install with no FUSE-backed workers
  // Records first, orphans second — an orphan whose run directory still exists
  // is this pass's business, and the backstop skips it rather than racing it.

  const reports: TeardownReport[] = [];
  for (const name of entries) {
    if (keep.has(name)) continue;
    try {
      const report = await runTeardown({ rundir: path.join(root, name), driver: opts.driver, scan: opts.scan, log });
      reports.push(report);
      // Every non-GONE terminal state is reported. A wedged record is LEFT IN
      // PLACE by runTeardown, so the next boot re-reports it rather than
      // silently rediscovering it.
      // KEYED ON THE VERDICT, not on the terminal state. `wedged` already means
      // "something is still there"; `terminalState` describes the daemon alone,
      // and `NO-PID` — a record that never named one — is an ordinary clean
      // reclaim rather than an anomaly worth alarming an operator about.
      if (report.wedged) {
        log.warn(`cc-fuse sweep: ${name} → ${report.terminalState}`
          + `${report.residualMounts.length ? `, mounts still present: ${report.residualMounts.join(' ')}` : ''}`
          + `${report.notes.length ? ` — ${report.notes.join('; ')}` : ''}`);
      } else {
        log.warn(`cc-fuse sweep: reclaimed ${name} (daemon ${report.daemonPid ?? '?'} ${report.terminalState}, unmounted ${report.unmounted.length}, reclaimed by marker ${report.markerReclaimed.length})`);
      }
      // WHAT THE DAEMON REFUSED, ON THE OPERATOR LOG. A session lost to a crash
      // never reached `runTeardown`'s own emit — its event stream is gone — so
      // this boot is the only place its policy events are ever read aloud.
      // `runTeardown` has already appended them to the store-wide log and put
      // the sentence on `notes`; the wedged arm above prints notes, the clean one
      // does not, so this covers the clean path without printing twice.
      if (!report.wedged && report.eventPaths.length) {
        log.warn(`cc-fuse sweep: ${name} — ${report.notes.filter(n => n.startsWith('cc-fuse: ')).join(' | ')}`);
      }
      // Reported, NEVER acted on: stale minors free nothing, survive abort and
      // are inert. A count of fusectl
      // entries is not a count of live daemons, so aborting an unrecorded one
      // would be aborting somebody else's filesystem on a guess.
      if (report.strayConnections > 0) {
        log.warn(`cc-fuse sweep: ${name} — ${report.strayConnections} fusectl connection(s) with no record of ours; NOT aborted`);
      }
    } catch (e) {
      log.warn(`cc-fuse sweep: ${name} could not be swept: ${(e as Error).message}`);
    }
  }
  // THE RECORD-INDEPENDENT BACKSTOP. The ordering guarantees above should leave
  // nothing for it; it runs so that "nothing was left" is a check rather than an
  // argument, and so a leak whose record was destroyed is discoverable at all —
  // a private namespace never appears in /proc/1/mounts, and a destroyed record
  // is in no set to re-verify.
  try {
    const backstop = await reclaimOrphanProcesses(root, { driver: opts.driver, scan: opts.scan, liveIds, log });
    if (!backstop.enumerated) log.warn('cc-fuse sweep: could not enumerate processes — this boot cannot claim the store is clean');
  } catch (e) { log.warn(`cc-fuse sweep: the orphan-process backstop failed: ${(e as Error).message}`); }
  return reports;
}
