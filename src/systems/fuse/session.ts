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
import { EVENT_LOG_NAME, RECORD_SCHEMA, fuseEventStore } from './plan.ts';
import { suggestPin } from './tierTable.ts';
import { httpError } from '../../httpError.ts';
import { wrapLaunch, type LaunchWrap } from './wrap.ts';
import { scanProcesses, membersOf, type ProcRow, type RawScan } from './procScan.ts';
import { reclaimProcess, type OrphanReclaim } from './orphans.ts';
import { ControlServer } from './control.ts';
import { localDirSource, type RemoteSource } from './remoteSource.ts';

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
  // Processes still in this session's MOUNT NAMESPACE — the enumeration the
  // clean verdict is actually taken from, which is wider than the recorded set
  // (a Bash forwarder's children are in it and no record names them).
  namespaceMembers: number[];
  // false ⇒ the process scan could not run, so an empty membership proves
  // NOTHING. Anything cc cannot enumerate is a wedge, not a pass.
  enumerated: boolean;
  // What the intent-only path (no mount.json) found and reclaimed by marker.
  markerReclaimed: OrphanReclaim[];
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
  // THE DAEMON'S POLICY EVENTS, harvested from `<rundir>/events.log`
  // IMMEDIATELY BEFORE the run directory is reclaimed — the reclaim is what used
  // to destroy the only record of a fail-closed path. One entry per DISTINCT
  // PATH, in the order the daemon first wrote it — narrower than the harvested
  // ROWS, which are keyed `(path, reason)` because two callers can reach one
  // path with two reasons. This is a path list and its one consumer (the boot
  // sweep) asks only whether it is empty.
  eventPaths: string[];
  notes: string[];
}

// One row of the daemon's event log: `<kind>\t<op>\t<path>\t<reason>`.
export interface PolicyEventRow { kind: string; op: string; path: string; reason: string }

// THE HARVEST. Reads a session's event log and APPENDS it to the store-wide one
// so the evidence outlives the run directory.
//
// `<iso8601>\t<instanceId>\t<kind>\t<op>\t<path>\t<suggested list>\t<suggested entry>`
//
// THE LAST TWO COLUMNS ARE FOR `deny`/`unpinned-fail-closed` ROWS ONLY, and the
// scoping is not cosmetic: a pin does not fix an `unmarked-host-served` row —
// that path already came from the host — so suggesting one would send the reader
// to change the wrong thing.
//
// DEDUPED ON `(path, reason)`, THE DAEMON'S OWN KEY, AND NOT ON THE PATH.
// THE PATH-KEYED VERSION WAS A REAL DEFECT and the reason is worth keeping: the
// daemon writes two rows for one path whenever two CALLERS reach it, which
// happens routinely — `/var` carries `deny`/`unpinned-fail-closed` from the
// marked CLI and `served`/`unmarked-host-served` from an unmarked one, observed
// in real gate runs. A path key kept whichever row was written FIRST, so when
// the `served` row won, the `deny` row was dropped and the store carried NO PIN
// SUGGESTION for a path the CLI's own denial had asked for. Nothing said so; the
// row simply was not there — which defeats the one thing this log is for.
//
// This departs from plan §4a's "one row per distinct path" deliberately (owner,
// recorded on card 2026-0382). Matching the daemon's key is also what makes the
// two artifacts comparable at all.
//
// BEST-EFFORT THROUGHOUT. `runTeardown` never rejects, and a store the harvest
// cannot write is not a reason to abandon a mount.
export function parsePolicyEvents(text: string): PolicyEventRow[] {
  const seen = new Set<string>();
  const out: PolicyEventRow[] = [];
  for (const line of text.split('\n')) {
    if (line === '') continue;
    const [kind, op, p, reason] = line.split('\t');
    if (!kind || !op || !p || !reason) continue;
    const key = `${p}\t${reason}`;
    if (seen.has(key)) continue;
    seen.add(key);
    out.push({ kind, op, path: p, reason });
  }
  return out;
}

export function pinSuggestionFor(row: PolicyEventRow): { list: string; entry: string } | null {
  if (row.kind !== 'deny' || row.reason !== 'unpinned-fail-closed') return null;
  const s = suggestPin(row.path);
  return { list: s.list ?? 'UNDECIDED', entry: s.entry };
}

async function harvestEvents(rundir: string, instanceId: string): Promise<PolicyEventRow[]> {
  const text = await fsp.readFile(path.join(rundir, EVENT_LOG_NAME), 'utf8').catch(() => '');
  const rows = parsePolicyEvents(text);
  if (rows.length === 0) return rows;
  const at = new Date().toISOString();
  const store = fuseEventStore();
  const body = rows.map((r) => {
    const s = pinSuggestionFor(r);
    return [at, instanceId, r.kind, r.op, r.path, s?.list ?? '', s?.entry ?? ''].join('\t');
  }).join('\n') + '\n';
  await fsp.mkdir(path.dirname(store), { recursive: true }).catch(() => {});
  await fsp.appendFile(store, body).catch(() => {});
  return rows;
}

// CAPPED, NEVER COUNTED, and the cap is the whole shape of the sentence. The
// failure this replaces was a real gate report of `unpinned-fail-closed: 60`
// where the 60 were ONE missing library — a count named nothing a maintainer
// could act on. So: up to 20 distinct paths inline, then how many more and where
// the full list is.
const EVENT_LINE_CAP = 20;

export function describePolicyEvents(rows: readonly PolicyEventRow[], storePath = fuseEventStore()): string | null {
  if (rows.length === 0) return null;
  const denials = rows.filter(r => r.kind === 'deny');
  const parts: string[] = [];
  if (denials.length) {
    const shown = denials.slice(0, EVENT_LINE_CAP);
    const more = denials.length - shown.length;
    parts.push(`the daemon refused: ${shown.map(r => r.path).join(', ')}`
      + (more > 0 ? ` (+${more} more; full list at ${storePath})` : ''));
    // THE REPAIR, GROUPED BY THE ARRAY THAT OWNS IT, because that is the edit
    // the reader has to make. `suggestPin` (tierTable.ts) owns the mapping and
    // the restart caveat.
    const byList = new Map<string, string[]>();
    for (const r of shown) {
      const s = pinSuggestionFor(r);
      if (!s) continue;
      if (!byList.has(s.list)) byList.set(s.list, []);
      byList.get(s.list)!.push(s.entry);
    }
    for (const [list, entries] of byList) {
      parts.push(list === 'UNDECIDED'
        ? `no array in src/systems/fuse/tierTable.ts obviously owns ${entries.join(', ')} — decide between LOADER_OBJECTS, ETC_PINS, BOOTSTRAP_CHAIN and the session's localRoots`
        : `add ${entries.join(', ')} to ${list} in src/systems/fuse/tierTable.ts and restart cc`);
    }
  }
  const served = rows.filter(r => r.kind === 'served');
  if (served.length) {
    const shown = served.slice(0, EVENT_LINE_CAP);
    const more = served.length - shown.length;
    // NO PIN SUGGESTED FOR THESE, and the wording says why: the op succeeded.
    parts.push(`served off the tier table (no pin needed — the op succeeded): `
      + shown.map(r => `${r.reason} ${r.path}`).join(', ')
      + (more > 0 ? ` (+${more} more)` : ''));
  }
  parts.push(`full event log at ${storePath}`);
  return `cc-fuse: ${parts.join('; ')}`;
}

interface Sinks {
  emit?: (ev: unknown) => void;
  log?: { warn: (...args: unknown[]) => void };
}

export interface TeardownInput extends Sinks {
  rundir: string;
  driver?: MountDriver;
  // The /proc enumeration seam (procScan.ts). Injected so the clean verdict —
  // including the case where it CANNOT be established — is testable without
  // sudo and without real processes.
  scan?: RawScan;
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

// Deliberately does NOT create the parent directory. It used to, and that made
// the wedge write able to RESURRECT a run directory a concurrent clean pass had
// just reclaimed — an orphan record for a session that no longer exists. The
// only other caller, prepare(), has already created the directory. Absence is
// now an ENOENT the caller decides about, rather than a silent mkdir.
export async function writeJsonAtomic(file: string, value: unknown): Promise<void> {
  const tmp = `${file}.tmp.${process.pid}`;
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
    namespaceMembers: [], enumerated: false, markerReclaimed: [],
    terminalState: 'NO-PID',
    unmounted: [], lazyUnmounted: [],
    abort: 'skipped', minor: null,
    residualMounts: [], strayConnections: 0,
    wedged: false, removedRunDir: false, eventPaths: [], notes,
  };

  // THE MACHINE NEVER REJECTS. Every step below is bounded and has a failure
  // branch, but an UNEXPECTED throw — a malformed record reaching execFile, a
  // driver that raises — would otherwise reject the whole call, and both
  // callers swallow that (`kill()` catches, `_handleExit` fires it with
  // `void`). The daemon, the mounts and the record would all survive with no
  // wedge report at all. So a throw is caught here and converted into the
  // loudest verdict the machine has.
  let record: FuseMountRecord | null = null;
  let schemaViolation = false;
  // The intent path's own enumeration, carried forward to step 7 rather than
  // thrown away — it is the same scan, already paid for.
  const intentRows: ProcRow[] = [];
  try {

  // ── 0. the record, and the pid re-verification ─────────────────────────
  record = await readJson<FuseMountRecord>(recordPath);
  const intent = record ?? await readJson<FuseIntent>(path.join(rundir, 'intent.json'));
  if (record) report.source = 'mount.json';
  else if (intent) { report.source = 'intent.json'; notes.push('NO-RECORD: no mount.json — the bootstrap never completed its handshake'); }
  else notes.push('NO-RECORD: neither mount.json nor intent.json is readable; nothing signalled');
  if (intent) report.instanceId = intent.instanceId ?? report.instanceId;
  report.minor = record?.minor ?? null;

  // ── 0b. SCHEMA VALIDATION of the two fields that reach a root-executed
  //        command line. This is about ROBUSTNESS, not a threat model — the
  //        epic already accepts the chroot is not a security boundary here.
  //        What is unacceptable is the no-adversary variant: a malformed record
  //        makes `execFile` throw mid-state-machine, `runTeardown` rejects, the
  //        kill path swallows it, and the daemon, the mounts and the record all
  //        survive WITH NO WEDGE REPORT. A schema-violating record is a
  //        reported wedge, never a mid-machine throw.
  //
  //        `fusectl` by EXACT equality with the path cc itself chose, not by
  //        prefix; `minor` digits only, on top of the `includes` check the
  //        abort already makes.
  const fusectlOk = record?.fusectl === path.join(rundir, 'fusectl');
  const minorOk = typeof record?.minor === 'string' && /^\d+$/.test(record.minor);
  if (record && !fusectlOk) {
    schemaViolation = true;
    notes.push(`SCHEMA: fusectl '${record.fusectl}' is not ${path.join(rundir, 'fusectl')} — not used`);
  }
  if (record && record.minor !== '' && !minorOk) {
    schemaViolation = true;
    notes.push(`SCHEMA: minor '${record.minor}' is not a decimal number — not used`);
  }

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

  // ── 1b. THE INTENT-ONLY PATH. No mount.json means one of two things, and
  //        BOTH have processes behind them: the bootstrap died after starting
  //        the anchor or the daemon, or it is still mid-handshake — which is
  //        reachable in production every time `_awaitFuseMount` times out and
  //        tears the launch down. This path used to signal nobody and then
  //        delete the run directory, which destroyed the only handle on
  //        whatever was running.
  //
  //        The handle that survives having no record is the marker the
  //        bootstrap's own `execve` put in the environment of everything it
  //        started — including the BOOTSTRAP ITSELF, which is what stops a
  //        mid-handshake write rather than racing it.
  if (!record) {
    const scanned = await scanProcesses({ withEnviron: true }, input.scan);
    report.enumerated = scanned.ok;
    if (!scanned.ok) {
      notes.push('could not enumerate processes — this run directory cannot be declared clean');
    } else {
      for (const row of membersOf(scanned.rows, { rundir })) {
        report.markerReclaimed.push(await reclaimProcess(row, rundir, driver));
      }
      if (report.markerReclaimed.length) {
        notes.push(`reclaimed ${report.markerReclaimed.length} process(es) by marker, with no record naming them`);
      }
    }
    // KEPT, not discarded, and RE-VERIFIED rather than trusted. Step 7 re-scans
    // when there IS a record; on this path it has nothing to compare against
    // and used to substitute an empty row set — which made `members` vacuous
    // exactly where the marker reclaim is the only thing that acted. A marker
    // process that SURVIVED its SIGKILL (`killed: false` — the shape of a
    // bootstrap wedged in `D` inside a hung mount syscall, which SIGKILL cannot
    // touch) then left no trace in the verdict at all, and the machine deleted
    // the run directory over it.
    //
    // The rows are filtered by a fresh liveness check rather than by the
    // reclaim's return value, so the verdict rests on an observation. One
    // /proc/<pid>/stat read each, against a scan already paid for.
    for (const row of scanned.rows) {
      if (await stillOurs(driver, row.pid, row.starttime)) intentRows.push(row);
    }
  }

  // The namespace is reachable through whichever recorded pid is still alive;
  // if none is, its mounts are reached through any surviving MEMBER instead
  // (step 7), and if there is no member either the namespace is gone.
  const nsPid = await pickNsPid(driver, record);
  if (record && nsPid === null) notes.push('no recorded pid is alive — the mount namespace is reachable only through an unrecorded member, if any');

  // ── 2. unmount DEEPEST-FIRST, and BEFORE the abort. The fusectl mount is
  //       held back deliberately: step 3 needs it, and unmounting it here is
  //       what would make the abort a silent no-op.
  if (record && nsPid !== null) {
    const rec = record;
    const mounts = (await driver.readMounts(nsPid)) ?? [];
    const targets = mounts.filter(mp => under(mp, rundir) && !(fusectlOk && mp === rec.fusectl))
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
  if (record && nsPid3 !== null && fusectlOk) {
    const rec = record;
    const conns = await driver.listConnections(nsPid3, rec.fusectl);
    report.strayConnections = conns.filter(c => c !== rec.minor).length;
    if (!rec.minor || !minorOk) { report.abort = 'no-minor'; notes.push('no usable connection minor was recorded at mount time — nothing to abort'); }
    else if (!conns.includes(rec.minor)) { report.abort = 'ABORT-UNAVAILABLE'; notes.push(`no fusectl entry for connection ${rec.minor}`); }
    else if (await driver.abortMinor(nsPid3, rec.fusectl, rec.minor)) report.abort = 'aborted';
    else { report.abort = 'abort-failed'; notes.push(`the write to ${rec.fusectl}/${rec.minor}/abort failed`); }
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
  if (record && nsPid5 !== null && fusectlOk) {
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
  //
  //       AND IT IS TAKEN FROM NAMESPACE MEMBERSHIP, NOT FROM THE RECORDED PID
  //       SET. The recorded set is what the bootstrap wrote down; the namespace
  //       is what is actually there, and the two differ in the ordinary case —
  //       Bash is a real subprocess family and there is deliberately no
  //       process-group kill on this path, so a live worker child holds mounts
  //       open while naming nothing cc recorded. Anything cc cannot enumerate
  //       is a wedge, not a pass.
  const scanned = record ? await scanProcesses({ withEnviron: true }, input.scan) : { ok: report.enumerated, rows: intentRows };
  if (record) report.enumerated = scanned.ok;
  const members = membersOf(scanned.rows, { nsMntId: record?.nsMntId, rundir });
  report.namespaceMembers = members.map(m => m.pid);

  // Mounts are read through every reachable vantage point: cc's own table, pid
  // 1's (the one that says whether anything escaped the private namespace at
  // all), any live recorded pid, and any member the recorded set never named.
  const nsPid6 = await pickNsPid(driver, record);
  const vantage = [process.pid, 1, ...(nsPid6 === null ? [] : [nsPid6]), ...members.map(m => m.pid)];
  const residual = new Set<string>();
  for (const pid of vantage) {
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
  if (members.length) notes.push(`mount namespace still has ${members.length} member(s): ${report.namespaceMembers.join(', ')}`);

  // A record that appeared WHILE this ran means the bootstrap completed its
  // handshake mid-teardown. Never delete over a record that has not been acted
  // on; the sweep converges on the pids it names.
  if (!record && await readJson<FuseMountRecord>(recordPath)) {
    notes.push('mount.json appeared during teardown — the bootstrap finished its handshake; leaving it for the sweep');
    schemaViolation = true; // reuse the force-wedge path; the note says why
  }

  report.wedged = report.residualMounts.length > 0
    || report.terminalState.startsWith('WEDGED')
    || report.survivingPids.length > 0
    || members.length > 0
    // Belt and braces behind the members fix above: a reclaim that reports it
    // did not kill is a wedge whatever the enumeration then says.
    //
    // Today this is redundant — every row the intent path scans is re-verified
    // for liveness, so `members` fires on every state this fires on. THAT
    // EQUIVALENCE IS CONTINGENT: it holds only because everything alive in the
    // intent window (the anchor, the bootstrap) is root-owned and dumpable, and
    // therefore scan-visible. Fork anything credential-changed from
    // bootstrap.sh before its first record write and this disjunct stops being
    // redundant and becomes the only cover.
    || report.markerReclaimed.some(r => !r.killed)
    || !report.enumerated
    || schemaViolation;

  } catch (e) {
    notes.push(`teardown threw and was contained: ${(e as Error).message}`);
    report.wedged = true;
    report.enumerated = false;
  }

  // ── 7b. HARVEST THE EVIDENCE BEFORE THE RECLAIM DESTROYS IT.
  //
  //        `rm -rf <rundir>` below takes the event log with it, and that log is
  //        the ONLY record of a fail-closed path: refusals are not traced
  //        (`tr()` runs only after `route()` returns 0). So the harvest happens
  //        here, before step 8 branches — ONE insertion point covering both the
  //        clean and the wedged path, and covering a session lost to a crash
  //        too, because `sweepFuseSessions` reaches this same function at the
  //        next boot.
  //
  //        OUTSIDE THE try/catch ABOVE ON PURPOSE: the contained-throw path sets
  //        `wedged` and falls through to here, and a session whose teardown threw
  //        is exactly one whose events a maintainer wants.
  try {
    const rows = await harvestEvents(rundir, report.instanceId);
    report.eventPaths = [...new Set(rows.map(r => r.path))];
    const line = describePolicyEvents(rows);
    if (line) {
      // The session's own stream — what an operator watching this session is
      // already looking at — and the orchestrator log, which survives its death.
      try { input.emit?.({ kind: 'system', subtype: 'stderr', data: { line } }); } catch { /* the session may already be gone */ }
      notes.push(line);
    }
  } catch (e) {
    notes.push(`the event log could not be harvested: ${(e as Error).message}`);
  }

  // ── 8. reclaim, or KEEP THE RECORD so the next boot sweep re-reports the
  //       wedge rather than silently rediscovering it.
  if (report.wedged) {
    const line = `cc-fuse: session ${report.instanceId} did not tear down cleanly — ${report.terminalState}`
      + `, daemon pid ${report.daemonPid ?? '?'}, minor ${report.minor ?? '?'}`
      + (report.survivingPids.length ? `, still alive: ${report.survivingPids.join(', ')}` : '')
      + (report.namespaceMembers.length ? `, namespace members still running: ${report.namespaceMembers.join(', ')}` : '')
      + (report.enumerated ? '' : ', AND THE PROCESS SCAN COULD NOT RUN — this verdict is "unknown", not "clean"')
      + (report.residualMounts.length ? `, mounts still present: ${report.residualMounts.join(' ')}` : '');
    // Both surfaces on purpose: the event stream is what an operator watching
    // this session is already looking at, and console.warn survives the
    // session's death and lands in the orchestrator log.
    // BOTH surfaces are guarded, and the second one is not politeness: the
    // machine's contract is that it never rejects, and a custom logger that
    // throws here would reject it AFTER the verdict was computed — which is
    // precisely the class of "a comment asserting an invariant the code does
    // not hold" that has cost this ticket the most.
    try { input.emit?.({ kind: 'system', subtype: 'stderr', data: { line } }); } catch { /* the session may already be gone */ }
    try { (input.log ?? console).warn(line); } catch { /* the operator log is not a reason to fail a teardown */ }
    // The existence check is an optimisation, not the guarantee: writeJsonAtomic
    // no longer creates the parent, so a concurrent clean pass's `rm -rf`
    // landing between the two simply makes the write ENOENT rather than
    // resurrecting the directory. The window is closed by the mechanism, not
    // narrowed by the check.
    if (record && await fsp.stat(rundir).then(() => true, () => false)) {
      await writeJsonAtomic(recordPath, {
        ...record, wedged: true, terminalState: report.terminalState,
        residualMounts: report.residualMounts, survivingPids: report.survivingPids, at: Date.now(),
      }).catch((e: Error) => notes.push(`the wedge record could not be written: ${e.message}`));
    }
  } else {
    // Reached only when the namespace enumeration RAN and came back empty, no
    // recorded pid survives, no mount is left at any vantage point, and no
    // record appeared mid-teardown. That is the whole precondition for
    // destroying the only handle cc has on this session.
    // ONE LAST LOOK, immediately before the irreversible step. The check at the
    // top of step 7 feeds the verdict; this one guards the delete itself, so
    // that any await point a later edit inserts between them cannot reopen the
    // window. Cheap: one stat on a path already in the page cache.
    if (!record && await readJson<FuseMountRecord>(recordPath)) {
      notes.push('mount.json appeared between the verdict and the delete; leaving it for the sweep');
      report.wedged = true;
    } else {
      try { await fsp.rm(rundir, { recursive: true, force: true }); report.removedRunDir = true; }
      catch (e) { notes.push(`could not reclaim ${rundir}: ${(e as Error).message}`); }
    }
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
// Returned instead of a report when teardown has already run for THIS
// lifecycle. Distinguishable on purpose: a caller that cannot tell "already
// torn down" from "there was nothing to do" cannot tell a no-op from a leak.
export interface AlreadyTornDown { alreadyTornDown: true }

export class FuseSession {
  readonly plan: FusePlan;
  readonly #ccBootId: string;
  readonly #driver: MountDriver;
  readonly #scan: RawScan | undefined;
  readonly #sinks: Sinks;
  readonly #deadlines: Deadlines;
  #tornDown = false;
  record: FuseMountRecord | null = null;
  // Resolved by launch() before prepare(), because the compile is async and
  // spawn() is not.
  unionBinary: string | null = null;
  // THE CONTROL SERVER, owned here because its lifetime is exactly this
  // session's: it is listening before the daemon starts and closed before
  // teardown signals anything. `runTeardown` cannot own it — it is a free
  // function the boot sweep also runs, over a rundir belonging to a process
  // that no longer exists.
  #control: ControlServer | null = null;
  readonly #source: RemoteSource;

  // `source` IS REQUIRED, and that is the point: a caller that forgets it now
  // fails to typecheck, where the old default silently mounted a local
  // directory as the remote — the worst outcome this file can produce, because
  // every read succeeds and every one of them is about the wrong machine.
  constructor(opts: { plan: FusePlan; ccBootId: string; driver?: MountDriver; scan?: RawScan; deadlines?: Partial<Deadlines>; source: RemoteSource } & Sinks) {
    this.plan = opts.plan;
    this.#ccBootId = opts.ccBootId;
    this.#driver = opts.driver ?? realMountDriver;
    this.#scan = opts.scan;
    this.#sinks = { emit: opts.emit, log: opts.log };
    this.#deadlines = { ...DEFAULT_DEADLINES, ...opts.deadlines };
    this.#source = opts.source;
  }

  get ccBootId(): string { return this.#ccBootId; }

  // The live control server, or null once torn down. Exposed because the real
  // gate has to kill it MID-TURN to measure that a wedged cc becomes -EIO and a
  // recoverable teardown rather than an unkillable D state (R6) — there is no
  // other way to produce that state without killing cc itself.
  get controlServer(): ControlServer | null { return this.#control; }

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
  // MUTUAL EXCLUSION BETWEEN prepare() AND teardown(), and it is not a
  // tidy-up — the interleaving loses a whole mount.
  //
  // Nothing above serialises them: `_mutating` covers rewind/fork/prune only,
  // and the instance is in `byId` before `launch()` runs, so a `kill()` can
  // reach `teardown()` while `launch()` is inside `prepare()`. Interleaved, a
  // teardown that latches during the `await ControlServer.listen()` leaves
  // prepare() to assign `#control` afterwards — latched WITH A LIVE SERVER —
  // and the final teardown then early-returns on the latch, so `runTeardown`
  // never runs and the mount, the root daemon and the run directory survive to
  // the next boot sweep. A generation stamp would fix the latch and still let
  // the two halves interleave; excluding them is what makes the sequential
  // reasoning that the rest of this class relies on true.
  #gate: Promise<unknown> = Promise.resolve();

  #exclusive<T>(fn: () => Promise<T>): Promise<T> {
    const run = this.#gate.then(fn, fn);
    this.#gate = run.catch(() => {});
    return run;
  }

  prepare(): Promise<void> {
    return this.#exclusive(() => this.#prepare());
  }

  async #prepare(): Promise<void> {
    const p = this.plan;
    // A RELAUNCH INTO THE SAME RUN DIRECTORY IS ORDINARY: rewind and prune both
    // kill the subprocess and call launch() again on the same Instance, so this
    // runs once per lifecycle, not once per session.
    //
    // Two things therefore have to be reset here, and the first was the whole
    // of a leak: the teardown latch, which otherwise made the SECOND kill() a
    // silent no-op — no unmounts, no abort, no signals, and a root daemon plus
    // a private mount surviving until the next orchestrator restart. And the
    // previous lifecycle's record, or awaitHandshake would return it and cc
    // would tear down a mount that no longer exists while the new one runs.
    const stale = await readJson<FuseMountRecord>(p.recordPath);
    if (stale?.wedged) {
      // Mounting a second session over the handle to a wedged first one loses
      // that handle. Fail loudly instead; the run directory is the operator's
      // (and the next boot sweep's) evidence.
      throw httpError(500, `FUSE_PREVIOUS_TEARDOWN_WEDGED: ${p.rundir} still records an unfinished teardown (${stale.terminalState ?? 'wedged'}); refusing to reuse it`, { code: 'FUSE_PREVIOUS_TEARDOWN_WEDGED' });
    }
    await fsp.rm(p.recordPath, { force: true }).catch(() => {});
    this.record = null;
    this.#tornDown = false;
    await fsp.mkdir(p.root, { recursive: true });
    await fsp.mkdir(p.mirror, { recursive: true });
    await fsp.mkdir(p.fusectl, { recursive: true });
    await fsp.writeFile(p.pinsPath, p.pinsText);
    await fsp.writeFile(p.daemonLog, '');
    await fsp.writeFile(p.eventLog, '');
    // Created EMPTY here for the same reason the other two are: the daemon runs
    // as root and appends, so a file cc did not create first would be
    // root-owned and teardown could not reclaim the tree without sudo.
    if (p.tracePath) await fsp.writeFile(p.tracePath, '');
    // LISTENING BEFORE THE SPAWN, because the daemon probes the socket before
    // it mounts and refuses if it cannot connect. A relaunch into the same run
    // directory closes the previous server first — the socket path is the same
    // file and two listeners on it is one listener plus a leak.
    await this.#control?.close().catch(() => {});
    this.#control = await ControlServer.listen({
      socketPath: p.controlSock,
      mirror: p.mirror,
      source: this.#source,
      // THE SAME ARRAY the pins file was rendered from — criterion 15 reaches
      // the control server too, or cc would materialise paths the daemon
      // refuses and the two would disagree about what the session may see.
      tiers: p.tiers,
      log: (line) => this.#sinks.log?.warn(line),
    });
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
  teardown(closeStdin?: () => void): Promise<TeardownReport | AlreadyTornDown> {
    return this.#exclusive(() => this.#teardown(closeStdin));
  }

  async #teardown(closeStdin?: () => void): Promise<TeardownReport | AlreadyTornDown> {
    // CLOSED FIRST, AND OUTSIDE THE LATCH.
    //
    // First, because every remote-tier op blocks on a reply: a daemon thread
    // mid-request would otherwise sit in the kernel until its receive timeout,
    // and dropping the connection turns each blocked call into -EIO at once,
    // which is what lets the worker's threads leave FUSE and be signalled.
    //
    // Outside the latch, because the latch is about not running the teardown
    // STATE MACHINE twice and says nothing about a socket. With `#exclusive`
    // above, a latched teardown can no longer be holding a live server — so
    // this is defence in depth rather than the fix it was described as, and it
    // costs one no-op await. The leak it was credited with was closed by
    // `Instance.kill()`'s no-process arm together with `remove()` going through
    // `kill()` at all; before that pair, `remove()` skipped `kill()` entirely,
    // so kill's own fix was unreachable from there.
    await this.#control?.close().catch(() => {});
    this.#control = null;
    if (this.#tornDown) return { alreadyTornDown: true };
    this.#tornDown = true;
    return runTeardown({
      rundir: this.plan.rundir,
      driver: this.#driver,
      scan: this.#scan,
      deadlines: this.#deadlines,
      closeStdin,
      ...this.#sinks,
    });
  }
}
