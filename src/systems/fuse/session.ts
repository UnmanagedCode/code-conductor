// One session's mount record and THE teardown state machine.
//
// There is exactly one implementation of teardown, it is here, and it is the
// same code the boot sweep runs. `bootstrap.sh` owns none of it: it execs into
// `claude` and ceases to exist as a supervisor, and a shell trap cannot survive
// SIGKILL, so a copy there would be a second, weaker one.
//
// TWO RECORDS, both atomic tmp+rename:
//   intent.json  written by cc BEFORE spawn — what makes a crash between spawn
//                and the handshake recoverable BY NAME rather than by search.
//   mount.json   written by the bootstrap while the mount exists, carrying the
//                daemon pid, the bootstrap (== worker) pid, both starttimes,
//                and the connection minor captured from mountinfo AT MOUNT TIME.
//
// WHY `wait(2)` IS NEVER CALLED, so it is not optimised back in: it blocks on
// the whole thread group, a thread stuck in FUSE I/O never leaves the kernel,
// and an orphan reparented to pid 1 cannot be waited on at all (ECHILD) — which
// is the shape a production supervisor is actually in (S3 §A3 W-ORPHAN). cc is
// never the daemon's parent in any case: the daemon is started by the bootstrap
// and reparents to pid 1 when the bootstrap's pid execs on. So `REAPED` is not
// a state cc can produce, and a single-threaded zombie is reported as
// ZOMBIE-ORPHAN rather than reaped.

import path from 'node:path';
import { promises as fsp } from 'node:fs';
import type { MountDriver } from './driver.ts';
import { realMountDriver } from './driver.ts';
import type { FuseIntent, FuseMountRecord, FusePlan } from './plan.ts';
import { RECORD_SCHEMA } from './plan.ts';
import { wrapLaunch, type LaunchWrap } from './wrap.ts';

export interface Deadlines {
  // Per-step bounds. Every one of them is a BOUND, not a wait: a step that
  // times out is reported and the next step runs anyway.
  workerTermMs: number;
  workerKillMs: number;
  daemonTermMs: number;
  daemonReapMs: number;
  handshakeMs: number;
  pollMs: number;
}

export const DEFAULT_DEADLINES: Deadlines = {
  workerTermMs: 1000,
  workerKillMs: 1000,
  daemonTermMs: 300,
  daemonReapMs: 4000,
  handshakeMs: 15_000,
  pollMs: 50,
};

export type AbortOutcome = 'aborted' | 'abort-failed' | 'ABORT-UNAVAILABLE' | 'no-minor' | 'skipped';

export interface TeardownReport {
  instanceId: string;
  // 'NO-RECORD' when neither record could be read: nothing is signalled, by
  // construction — there is no pid to re-verify.
  source: 'mount.json' | 'intent.json' | 'NO-RECORD';
  workerPid: number | null;
  workerStopped: boolean;
  daemonPid: number | null;
  anchorPid: number | null;
  // Recorded pids still alive and still OURS when teardown finished. Non-empty
  // is a wedge by definition: the record may not be destroyed while a process
  // it names is running.
  survivingPids: string[];
  // GONE | ZOMBIE-ORPHAN | NO-PID | WEDGED(threads=n states=…)
  terminalState: string;
  // In the order the unmounts were ISSUED — deepest-first is an ordering claim,
  // not a set claim, so the report has to preserve it.
  unmounted: string[];
  lazyUnmounted: string[];
  abort: AbortOutcome;
  minor: string | null;
  residualMounts: string[];
  // fusectl entries with no record of ours. REPORTED, NEVER ACTED ON: S3 §A5
  // measured stale minors that freed nothing, survived abort and were inert, so
  // a count of fusectl entries is not a count of live daemons.
  strayConnections: number;
  wedged: boolean;
  removedRunDir: boolean;
  notes: string[];
}

interface Sinks {
  emit?: (ev: unknown) => void;
  log?: { warn: (...args: unknown[]) => void };
}

export interface TeardownInput extends Sinks {
  rundir: string;
  driver?: MountDriver;
  deadlines?: Partial<Deadlines>;
  // Called once, before the signalling ladder — the Instance's stdin EOF. A
  // graceful close is the cheapest way for the CLI to go, and it costs nothing
  // when it does not work.
  closeStdin?: () => void;
}

async function readJson<T>(file: string): Promise<T | null> {
  try { return JSON.parse(await fsp.readFile(file, 'utf8')) as T; }
  catch { return null; }
}

export async function writeJsonAtomic(file: string, value: unknown): Promise<void> {
  const tmp = `${file}.tmp.${process.pid}`;
  await fsp.mkdir(path.dirname(file), { recursive: true });
  await fsp.writeFile(tmp, JSON.stringify(value, null, 2));
  await fsp.rename(tmp, file);
}

// A pid is "ours" only while /proc/<pid>/stat field 22 still equals what was
// recorded at spawn. A mismatch means the number has been recycled onto an
// unrelated process: it is reported GONE and NEVER signalled.
async function stillOurs(driver: MountDriver, pid: number | null | undefined, start: string | undefined): Promise<boolean> {
  if (!pid || pid <= 1) return false;
  const stat = await driver.readProcStat(pid);
  if (!stat) return false;
  // A record written by an older bootstrap with no starttime cannot be
  // re-verified, and an unverifiable pid is not signalled.
  if (!start) return false;
  return stat.starttime === start;
}

async function waitGone(driver: MountDriver, pid: number, start: string, budgetMs: number, pollMs: number): Promise<boolean> {
  const deadline = driver.now() + budgetMs;
  for (;;) {
    if (!(await stillOurs(driver, pid, start))) return true;
    if (driver.now() >= deadline) return false;
    await driver.sleep(pollMs);
  }
}

// THE KILL PATH's terminal classification. Bounded, and it never waits.
async function reapBounded(driver: MountDriver, pid: number, start: string, budgetMs: number, pollMs: number): Promise<string> {
  const deadline = driver.now() + budgetMs;
  for (;;) {
    const stat = await driver.readProcStat(pid);
    if (!stat || stat.starttime !== start) return 'GONE';
    const tasks = await driver.readTaskDir(pid);
    if (tasks === null) return 'GONE';
    if (driver.now() >= deadline) {
      const states: string[] = [];
      for (const t of tasks) {
        // A thread id has its own /proc/<tid>/stat, readable directly even
        // though it is not listed under /proc.
        states.push((await driver.readProcStat(Number(t)))?.state ?? '?');
      }
      // A single-threaded zombie is NOT wedged: its threads are down to the
      // leader and pid 1 will reap it. Distinguished from WEDGED because the
      // remedy differs — one is a report, the other is residue to re-examine.
      if (stat.state === 'Z' && tasks.length <= 1) return 'ZOMBIE-ORPHAN';
      return `WEDGED(threads=${tasks.length} states=${states.join('')})`;
    }
    await driver.sleep(pollMs);
  }
}

function under(mp: string, root: string): boolean {
  return mp === root || mp.startsWith(root.endsWith('/') ? root : root + '/');
}

// ── THE STATE MACHINE ───────────────────────────────────────────────────────
export async function runTeardown(input: TeardownInput): Promise<TeardownReport> {
  const driver = input.driver ?? realMountDriver;
  const d = { ...DEFAULT_DEADLINES, ...input.deadlines };
  const rundir = input.rundir;
  const recordPath = path.join(rundir, 'mount.json');

  const notes: string[] = [];
  const report: TeardownReport = {
    instanceId: path.basename(rundir),
    source: 'NO-RECORD',
    workerPid: null, workerStopped: false, daemonPid: null, anchorPid: null, survivingPids: [],
    terminalState: 'NO-PID',
    unmounted: [], lazyUnmounted: [],
    abort: 'skipped', minor: null,
    residualMounts: [], strayConnections: 0,
    wedged: false, removedRunDir: false, notes,
  };

  // ── 0. the record, and the pid re-verification ─────────────────────────
  const record = await readJson<FuseMountRecord>(recordPath);
  const intent = record ?? await readJson<FuseIntent>(path.join(rundir, 'intent.json'));
  if (record) report.source = 'mount.json';
  else if (intent) { report.source = 'intent.json'; notes.push('NO-RECORD: no mount.json — the bootstrap never completed its handshake'); }
  else notes.push('NO-RECORD: neither mount.json nor intent.json is readable; nothing signalled');
  if (intent) report.instanceId = intent.instanceId ?? report.instanceId;
  report.minor = record?.minor ?? null;

  const workerLive = await stillOurs(driver, record?.bootstrapPid, record?.bootstrapStart);
  const daemonLive0 = await stillOurs(driver, record?.daemonPid, record?.daemonStart);
  if (record) {
    report.workerPid = record.bootstrapPid ?? null;
    report.daemonPid = record.daemonPid ?? null;
    report.anchorPid = record.anchorPid ?? null;
    if (record.bootstrapPid && !workerLive) notes.push(`worker pid ${record.bootstrapPid} is gone or recycled (starttime mismatch) — not signalled`);
    if (record.daemonPid && !daemonLive0) notes.push(`daemon pid ${record.daemonPid} is gone or recycled (starttime mismatch) — not signalled`);
  }

  // ── 1. stop the worker: bounded, and NON-BLOCKING. A worker wedged in `D`
  //       on the mount cannot be signalled at all until the connection is
  //       aborted (step 3) — abort is the universal solvent — so failing here
  //       must not stop the machine.
  try { input.closeStdin?.(); } catch { /* the pipe is already gone */ }
  if (record && workerLive) {
    const pid = record.bootstrapPid, start = record.bootstrapStart;
    await driver.signal(pid, 'SIGTERM', { privileged: false });
    if (!await waitGone(driver, pid, start, d.workerTermMs, d.pollMs)) {
      await driver.signal(pid, 'SIGKILL', { privileged: false });
      await waitGone(driver, pid, start, d.workerKillMs, d.pollMs);
    }
    report.workerStopped = !(await stillOurs(driver, pid, start));
    if (!report.workerStopped) notes.push(`worker pid ${pid} survived SIGKILL — continuing to the abort, which is what frees a D-state caller`);
  } else {
    report.workerStopped = true;
  }

  // The namespace is reachable through whichever of the two is still alive; if
  // neither is, the namespace is gone and its mounts went with it.
  const nsPid = await pickNsPid(driver, record);
  if (record && nsPid === null) notes.push('neither recorded pid is alive — the mount namespace is gone and its mounts with it');

  // ── 2. unmount DEEPEST-FIRST, and BEFORE the abort. The fusectl mount is
  //       held back deliberately: step 3 needs it, and unmounting it here is
  //       what would make the abort a silent no-op.
  if (record && nsPid !== null) {
    const mounts = (await driver.readMounts(nsPid)) ?? [];
    const targets = mounts.filter(mp => under(mp, rundir) && mp !== record.fusectl)
      .sort((a, b) => b.length - a.length);
    for (const mp of targets) {
      if (await driver.umountIn(nsPid, mp, { lazy: false })) { report.unmounted.push(mp); continue; }
      if (await driver.umountIn(nsPid, mp, { lazy: true })) { report.unmounted.push(mp); report.lazyUnmounted.push(mp); continue; }
      notes.push(`could not unmount ${mp}, even lazily`);
    }
  }

  // ── 3. abort the FUSE connection BY THE MINOR CAPTURED AT MOUNT TIME.
  //       Only ever a minor this session recorded.
  const nsPid3 = await pickNsPid(driver, record);
  if (record && nsPid3 !== null) {
    const conns = await driver.listConnections(nsPid3, record.fusectl);
    report.strayConnections = conns.filter(c => c !== record.minor).length;
    if (!record.minor) { report.abort = 'no-minor'; notes.push('no connection minor was recorded at mount time — nothing to abort'); }
    else if (!conns.includes(record.minor)) { report.abort = 'ABORT-UNAVAILABLE'; notes.push(`no fusectl entry for connection ${record.minor}`); }
    else if (await driver.abortMinor(nsPid3, record.fusectl, record.minor)) report.abort = 'aborted';
    else { report.abort = 'abort-failed'; notes.push(`the write to ${record.fusectl}/${record.minor}/abort failed`); }
  }

  // ── 4. and only now the daemon. ────────────────────────────────────────
  if (record && await stillOurs(driver, record.daemonPid, record.daemonStart)) {
    await driver.signal(record.daemonPid, 'SIGTERM', { privileged: true });
    if (!await waitGone(driver, record.daemonPid, record.daemonStart, d.daemonTermMs, d.pollMs)) {
      await driver.signal(record.daemonPid, 'SIGKILL', { privileged: true });
    }
  }

  // ── 5. bounded poll of /proc/<daemonPid>/task. REPORTED, never blocked on.
  if (record?.daemonPid && record.daemonStart) {
    report.terminalState = await reapBounded(driver, record.daemonPid, record.daemonStart, d.daemonReapMs, d.pollMs);
  }

  // The fusectl mount, held back for step 3, goes last.
  const nsPid5 = await pickNsPid(driver, record);
  if (record && nsPid5 !== null) {
    const mounts = (await driver.readMounts(nsPid5)) ?? [];
    if (mounts.includes(record.fusectl)) {
      if (await driver.umountIn(nsPid5, record.fusectl, { lazy: false })) report.unmounted.push(record.fusectl);
      else if (await driver.umountIn(nsPid5, record.fusectl, { lazy: true })) { report.unmounted.push(record.fusectl); report.lazyUnmounted.push(record.fusectl); }
    }
  }

  // ── 6. the anchor goes LAST. It is the only thing still holding the mount
  //       namespace open, and a namespace whose last process has gone takes
  //       every mount in it with it — which is the second, independent
  //       guarantee behind step 2: a mount cc could not unmount still cannot
  //       survive this.
  if (record && await stillOurs(driver, record.anchorPid, record.anchorStart)) {
    await driver.signal(record.anchorPid, 'SIGKILL', { privileged: true });
    await waitGone(driver, record.anchorPid, record.anchorStart, d.workerKillMs, d.pollMs);
    if (await stillOurs(driver, record.anchorPid, record.anchorStart)) {
      notes.push(`namespace anchor pid ${record.anchorPid} survived SIGKILL — the mount namespace is still open`);
    }
  }

  // ── 7. CONFIRM DEATH, POSITIVELY, and assert clean in BOTH tables.
  //       /proc/1/mounts is the one that says whether anything escaped the
  //       private namespace at all.
  //
  //       THE RECORD IS THE LAST THING DESTROYED, AND ONLY ONCE EVERY PID IT
  //       NAMES IS CONFIRMED GONE BY A POSITIVE CHECK — never by having issued a
  //       signal. cc's teardown and its boot sweep both iterate RECORDS, so a
  //       record deleted while a process it names is alive makes that process
  //       permanently unreclaimable by name. Measured as a real leak: a root
  //       `sleep infinity` holding a live private mount namespace, orphaned to
  //       pid 1, with its run directory already removed. Neither half of the
  //       old leak check could see it — its namespace is private so it can
  //       never appear in /proc/1/mounts, and its record was gone so it was in
  //       no recorded set to re-verify.
  const nsPid6 = await pickNsPid(driver, record);
  const residual = new Set<string>();
  for (const pid of [process.pid, 1, ...(nsPid6 === null ? [] : [nsPid6])]) {
    for (const mp of (await driver.readMounts(pid)) ?? []) if (under(mp, rundir)) residual.add(mp);
  }
  report.residualMounts = [...residual].sort();
  if (record) {
    for (const [what, pid, start] of [
      ['worker', record.bootstrapPid, record.bootstrapStart],
      ['daemon', record.daemonPid, record.daemonStart],
      ['anchor', record.anchorPid, record.anchorStart],
    ] as const) {
      if (await stillOurs(driver, pid, start)) report.survivingPids.push(`${what} pid ${pid}`);
    }
  }
  report.wedged = report.residualMounts.length > 0
    || report.terminalState.startsWith('WEDGED')
    || report.survivingPids.length > 0;

  // ── 8. reclaim, or KEEP THE RECORD so the next boot sweep re-reports the
  //       wedge rather than silently rediscovering it.
  if (report.wedged) {
    const line = `cc-fuse: session ${report.instanceId} did not tear down cleanly — ${report.terminalState}`
      + `, daemon pid ${report.daemonPid ?? '?'}, minor ${report.minor ?? '?'}`
      + (report.survivingPids.length ? `, still alive: ${report.survivingPids.join(', ')}` : '')
      + (report.residualMounts.length ? `, mounts still present: ${report.residualMounts.join(' ')}` : '');
    // Both surfaces on purpose: the event stream is what an operator watching
    // this session is already looking at, and console.warn survives the
    // session's death and lands in the orchestrator log.
    try { input.emit?.({ kind: 'system', subtype: 'stderr', data: { line } }); } catch { /* the session may already be gone */ }
    (input.log ?? console).warn(line);
    if (record) {
      await writeJsonAtomic(recordPath, {
        ...record, wedged: true, terminalState: report.terminalState,
        residualMounts: report.residualMounts, survivingPids: report.survivingPids, at: Date.now(),
      }).catch(() => {});
    }
  } else {
    // Safe to destroy the record ONLY because of the invariant bootstrap.sh
    // step 2a enforces: nothing it starts precedes the record that names it. So
    // an intent-only run directory (no mount.json at all) means the bootstrap
    // died before it started anything, and there is nothing here to orphan.
    try { await fsp.rm(rundir, { recursive: true, force: true }); report.removedRunDir = true; }
    catch (e) { notes.push(`could not reclaim ${rundir}: ${(e as Error).message}`); }
  }
  return report;
}

// The pid whose /proc/<pid>/ns/mnt cc enters the namespace through.
//
// THE ANCHOR FIRST, and that ordering is a measured requirement rather than a
// preference: the daemon calls setfsuid per request and the worker is
// setpriv'd, so both are non-dumpable within milliseconds of the mount coming
// up, and opening a non-dumpable process's ns/* needs CAP_SYS_PTRACE, which is
// not in this container's bounding set even for uid 0 (bootstrap.sh step 2b).
// The other two are kept as fallbacks because they are correct wherever that
// capability IS available, and because a record from a run whose anchor died
// early still has somewhere to point.
async function pickNsPid(driver: MountDriver, record: FuseMountRecord | null): Promise<number | null> {
  if (!record) return null;
  if (await stillOurs(driver, record.anchorPid, record.anchorStart)) return record.anchorPid;
  if (await stillOurs(driver, record.daemonPid, record.daemonStart)) return record.daemonPid;
  if (await stillOurs(driver, record.bootstrapPid, record.bootstrapStart)) return record.bootstrapPid;
  return null;
}

// ── the per-instance handle ─────────────────────────────────────────────────
export class FuseSession {
  readonly plan: FusePlan;
  readonly #ccBootId: string;
  readonly #driver: MountDriver;
  readonly #sinks: Sinks;
  readonly #deadlines: Deadlines;
  #tornDown = false;
  record: FuseMountRecord | null = null;
  // Resolved by launch() before prepare(), because the compile is async and
  // spawn() is not.
  unionBinary: string | null = null;

  constructor(opts: { plan: FusePlan; ccBootId: string; driver?: MountDriver; deadlines?: Partial<Deadlines> } & Sinks) {
    this.plan = opts.plan;
    this.#ccBootId = opts.ccBootId;
    this.#driver = opts.driver ?? realMountDriver;
    this.#sinks = { emit: opts.emit, log: opts.log };
    this.#deadlines = { ...DEFAULT_DEADLINES, ...opts.deadlines };
  }

  get ccBootId(): string { return this.#ccBootId; }

  // The launcher seam's transform for THIS session. A getter rather than a
  // stored closure so a caller that reaches for it before the binary is
  // resolved fails loudly instead of spawning an unwrapped CLI — which would
  // run the worker on the orchestrator's own root filesystem.
  get wrap(): LaunchWrap {
    const unionBinary = this.unionBinary;
    if (!unionBinary) throw new Error('cc: FuseSession.wrap read before the union binary was resolved');
    return (spec) => wrapLaunch(spec, {
      plan: this.plan, unionBinary, ccBootId: this.#ccBootId, spawnedAt: Date.now(),
    });
  }

  // Everything cc owns is created HERE, before the spawn, so that every file
  // under the run directory is cc-owned and teardown can reclaim the tree
  // without sudo — a root-created intermediate directory would need root to
  // remove. It is also what makes a crash before the handshake recoverable by
  // name: the directory exists and intent.json says whose it is.
  async prepare(): Promise<void> {
    const p = this.plan;
    await fsp.mkdir(p.root, { recursive: true });
    await fsp.mkdir(p.mirror, { recursive: true });
    await fsp.mkdir(p.fusectl, { recursive: true });
    if (p.standInAt) await fsp.mkdir(p.standInAt, { recursive: true });
    await fsp.writeFile(p.pinsPath, p.pinsText);
    await fsp.writeFile(p.daemonLog, '');
    const intent: FuseIntent = {
      schema: RECORD_SCHEMA,
      instanceId: p.instanceId,
      ccBootId: this.#ccBootId,
      rundir: p.rundir,
      root: p.root,
      mirror: p.mirror,
      fusectl: p.fusectl,
      spawnedAt: Date.now(),
    };
    await writeJsonAtomic(p.intentPath, intent);
  }

  // The bootstrap's handshake. Absence past the deadline WITH a live process is
  // a refusal; absence with a dead one lets the caller surface the captured
  // stderr, which is where the bootstrap's own named refusal lands.
  async awaitHandshake(isAlive: () => boolean): Promise<FuseMountRecord | null> {
    const deadline = this.#driver.now() + this.#deadlines.handshakeMs;
    for (;;) {
      // `stage: 'mounted'` and not merely "the file exists": the record is
      // written from the moment the bootstrap has a pid to name (step 2a), so
      // its presence says processes exist, not that the union is up.
      const rec = await readJson<FuseMountRecord>(this.plan.recordPath);
      if (rec?.stage === 'mounted') { this.record = rec; return rec; }
      // Kept even when incomplete, so a caller that has to tear the failed
      // launch down has the pids the bootstrap already recorded.
      if (rec) this.record = rec;
      if (!isAlive()) return null;
      if (this.#driver.now() >= deadline) return null;
      await this.#driver.sleep(this.#deadlines.pollMs);
    }
  }

  // Idempotent: the crash path (_handleExit) and the commanded path (kill())
  // both reach it, and on a normal kill_instance both fire.
  async teardown(closeStdin?: () => void): Promise<TeardownReport | null> {
    if (this.#tornDown) return null;
    this.#tornDown = true;
    return runTeardown({
      rundir: this.plan.rundir,
      driver: this.#driver,
      deadlines: this.#deadlines,
      closeStdin,
      ...this.#sinks,
    });
  }
}
