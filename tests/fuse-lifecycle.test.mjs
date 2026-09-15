// The FUSE-union chroot's lifecycle, WITHOUT sudo, without FUSE and without a
// real process: the teardown state machine drives an injected MountDriver whose
// fixtures are in-memory tables and whose clock is virtual, so every deadline
// in the machine is exercised in microseconds and no assertion depends on wall
// time.
//
// Nothing in this file signals a real pid. The fake driver's `signal` records
// the call; it does not call process.kill.
//
// The real end-to-end gate — real sudo, real unshare, real FUSE, a fake claude
// binary — is tests/fuse-lifecycle.real.test.mjs behind RUN_FUSE_LIFECYCLE=1.

import { test, describe, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { promises as fs, rmSync } from 'node:fs';
import path from 'node:path';
import { mkdtemp } from './tmpRegistry.mjs';
import { runTeardown, DEFAULT_DEADLINES, describePolicyEvents, parsePolicyEvents } from '../src/systems/fuse/session.ts';
import { buildTierTable, renderPinsFile, binaryPins, installPins, resolveOnPath, resolveTierEntry, suggestPin, BIND_MOUNTS } from '../src/systems/fuse/tierTable.ts';
import { wrapLaunch } from '../src/systems/fuse/wrap.ts';
import { assertFuseAvailable, REQUIRED_BINARIES } from '../src/systems/fuse/preflight.ts';
import { parseProcStat, unescapeMountPath } from '../src/systems/fuse/driver.ts';
import { reclaimOrphanProcesses } from '../src/systems/fuse/orphans.ts';
import { parseScan, membersOf, orphansUnder } from '../src/systems/fuse/procScan.ts';
import { FuseSession } from '../src/systems/fuse/session.ts';
import { Instance, InstanceManager } from '../src/instances.ts';
import { tierFixtureInput } from './tierFixture.mjs';
import { padPathTo } from './helpers.mjs';
import { randomUUID } from 'node:crypto';

// ── the fake driver ─────────────────────────────────────────────────────────
//
// `procs` maps pid → { starttime, state, threads }. A pid absent from the map
// is gone. `mounts` maps pid → the mountpoints in that pid's namespace.
// Everything is recorded in `calls` in issue order, which is what lets the
// ORDERING claims below be assertions rather than set comparisons.
// `nsMounts` is the PRIVATE NAMESPACE's mount table, shared by every process in
// it — modelling it per-pid would let a fixture disagree with itself about
// which pid teardown happens to enter through, and that choice is exactly what
// the anchor changed. `hostMounts` is pid 1's and cc's own.
// `umountFails` fails BOTH plain and lazy; `lazyOnly` fails plain and succeeds
// lazily, which is the only way to reach the lazy-success branch — without it
// that branch can be deleted and the whole suite stays green.
function fakeDriver({ procs = {}, nsMounts = [], hostMounts = [], mounts = {}, conns = [],
  umountFails = new Set(), lazyOnly = new Set(), abortOk = true, undead = new Set(),
  nsMntId = NS, scanOk = true } = {}) {
  let clock = 0;
  const calls = [];
  const rec = (op, ...args) => calls.push([op, ...args]);
  const d = {
    calls,
    procs,
    mounts,
    async readMounts(pid) {
      if (mounts[pid]) return mounts[pid];                 // an explicit per-pid override
      if (pid === 1 || pid === process.pid) return hostMounts;
      return procs[pid] ? nsMounts : null;                 // gone ⇒ no table at all
    },
    async readProcStat(pid) {
      const p = procs[pid];
      return p ? { starttime: p.starttime, state: p.state } : null;
    },
    async readTaskDir(pid) {
      const p = procs[pid];
      return p ? (p.threads ?? [String(pid)]) : null;
    },
    async umountIn(nsPid, mp, { lazy }) {
      rec('umount', mp, lazy ? 'lazy' : 'plain');
      if (umountFails.has(mp)) return false;                 // neither works
      if (lazyOnly.has(mp) && !lazy) return false;            // plain fails, lazy will do
      for (const list of [nsMounts, hostMounts, ...Object.values(mounts)]) {
        const i = list.indexOf(mp);
        if (i >= 0) list.splice(i, 1);
      }
      return true;
    },
    async abortMinor(nsPid, fusectl, minor) { rec('abort', minor); return abortOk; },
    async listConnections() { return conns; },
    // A signalled process dies, unless the fixture marks it `undead` — which
    // is how the wedged shapes (a `D`-state worker, a zombie leader with a live
    // sibling thread) are built.
    async signal(pid, sig, { privileged }) {
      rec('signal', pid, sig, privileged ? 'sudo' : 'direct');
      if (!undead.has(pid)) delete procs[pid];
    },
    now() { return clock; },
    async sleep(ms) { clock += ms; },
    advance(ms) { clock += ms; },
    // The /proc enumeration seam. One row per LIVE process, so a fixture that
    // kills something also removes it from the namespace — which is what the
    // clean verdict is taken from.
    scan: async ({ withEnviron = false } = {}) => {
      if (!scanOk) return { ok: false, raw: '' };
      const rows = Object.entries(procs).map(([pid, p]) => [
        pid, p.starttime, p.ns ?? nsMntId,
        withEnviron ? (p.instanceId ?? '') : '',
        withEnviron ? (p.rundir ?? '') : '',
      ].join('\t'));
      return { ok: true, raw: rows.join('\n') };
    },
  };
  return d;
}

// The pids and starttimes every fixture below shares. Distinct starttimes so a
// mismatch is unambiguous.
const WORKER = 4242, WORKER_START = '111111';
const DAEMON = 4243, DAEMON_START = '222222';
const ANCHOR = 4244, ANCHOR_START = '333333';
// The session's mount namespace. Membership in it — not the recorded pid set —
// is what every clean verdict below is taken from.
const NS = 'mnt:[4026533000]';

async function seedRun(overrides = {}, { intentOnly = false, noRecords = false } = {}) {
  const rundir = await mkdtemp('cc-fuse-run-');
  const record = {
    schema: 1, instanceId: path.basename(rundir), ccBootId: 'boot-1',
    rundir, root: path.join(rundir, 'root'), mirror: path.join(rundir, 'mirror'),
    fusectl: path.join(rundir, 'fusectl'),
    nsMntId: 'mnt:[4026533000]',
    bootstrapPid: WORKER, bootstrapStart: WORKER_START,
    daemonPid: DAEMON, daemonStart: DAEMON_START,
    anchorPid: ANCHOR, anchorStart: ANCHOR_START,
    stage: 'mounted', minor: '77', spawnedAt: 1, mountedAt: 2,
    ...overrides,
  };
  if (!noRecords) {
    const intent = { schema: 1, instanceId: record.instanceId, ccBootId: 'boot-1', rundir, root: record.root, mirror: record.mirror, fusectl: record.fusectl, spawnedAt: 1 };
    await fs.writeFile(path.join(rundir, 'intent.json'), JSON.stringify(intent));
    if (!intentOnly) await fs.writeFile(path.join(rundir, 'mount.json'), JSON.stringify(record));
  }
  return { rundir, record };
}

// The mount table a healthy session has, in the arbitrary order /proc/<pid>/mounts
// hands it back — deliberately NOT deepest-first, so the ordering assertion is
// about the machine's sort and not about the fixture.
function healthyMounts(record) {
  return [
    record.root,
    path.join(record.root, 'dev', 'pts'),
    record.fusectl,
    path.join(record.root, 'proc'),
    path.join(record.mirror, 'srv', 'app'),
    path.join(record.root, 'dev'),
    path.join(record.root, 'sys'),
  ];
}

// The three recorded processes of a healthy session, all alive.
const liveBoth = () => ({
  [WORKER]: { starttime: WORKER_START, state: 'S' },
  [DAEMON]: { starttime: DAEMON_START, state: 'S', threads: ['1', '2'] },
  [ANCHOR]: { starttime: ANCHOR_START, state: 'S' },
});

describe('FUSE teardown state machine (fake driver, virtual clock)', () => {
  // PINS: unmounts are issued deepest-first, and every one of them is issued
  // BEFORE the abort. Both halves matter — a set assertion would pass on an
  // ordering that makes the abort a no-op.
  test('unmounts deepest-first, and all of them before the abort', async () => {
    const { rundir, record } = await seedRun();
    const procs = liveBoth();
    const driver = fakeDriver({ procs, nsMounts: healthyMounts(record), conns: ['77'] });
    await runTeardown({ rundir, driver, scan: driver.scan, log: { warn() {} } });

    const abortAt = driver.calls.findIndex(c => c[0] === 'abort');
    assert.ok(abortAt >= 0, 'the abort was issued');
    // Deepest-first: every unmount before the abort is at least as long as the
    // one after it.
    const beforeAbort = driver.calls.slice(0, abortAt).filter(c => c[0] === 'umount').map(c => c[1]);
    for (let i = 1; i < beforeAbort.length; i++) {
      assert.ok(beforeAbort[i].length <= beforeAbort[i - 1].length,
        `not deepest-first: ${beforeAbort[i]} came after ${beforeAbort[i - 1]}`);
    }
    // Every mount under the run dir EXCEPT fusectl is unmounted before the
    // abort; fusectl is held back because the abort is written through it.
    for (const mp of healthyMounts(record)) {
      if (mp === record.fusectl) continue;
      assert.ok(beforeAbort.includes(mp), `${mp} was not unmounted before the abort`);
    }
    assert.ok(!beforeAbort.includes(record.fusectl), 'fusectl was unmounted before the abort, which makes the abort a no-op');
    // Nothing is unmounted after the daemon dies here, because the mount
    // namespace goes with its last process. The held-back fusectl mount IS
    // unmounted when something is still in the namespace — next test.
  });

  // PINS: fusectl is held back for the abort and then unmounted, so the
  // held-back case is not a permanent leak.
  test('the held-back fusectl mount is unmounted once the abort has been issued', async () => {
    const { rundir, record } = await seedRun();
    const procs = liveBoth();
    delete procs[WORKER];
    const driver = fakeDriver({ procs, nsMounts: healthyMounts(record), conns: ['77'], undead: new Set([DAEMON]) });
    await runTeardown({ rundir, driver, scan: driver.scan, log: { warn() {} } });
    const seq = driver.calls.filter(c => c[0] === 'umount' || c[0] === 'abort');
    const abortAt = seq.findIndex(c => c[0] === 'abort');
    const fusectlAt = seq.findIndex(c => c[0] === 'umount' && c[1] === record.fusectl);
    assert.ok(fusectlAt > abortAt && abortAt >= 0, `fusectl at ${fusectlAt}, abort at ${abortAt}`);
  });

  // PINS: the abort names the minor RECORDED AT MOUNT TIME. Re-resolving it
  // from mountinfo during teardown is a silent no-op, because the mount is
  // already gone by then.
  test('aborts the minor captured at mount time', async () => {
    const { rundir, record } = await seedRun({ minor: '91' });
    const driver = fakeDriver({ procs: liveBoth(), nsMounts: healthyMounts(record), conns: ['91', '12'] });
    const report = await runTeardown({ rundir, driver, scan: driver.scan, log: { warn() {} } });
    assert.deepEqual(driver.calls.filter(c => c[0] === 'abort'), [['abort', '91']]);
    assert.equal(report.abort, 'aborted');
    assert.equal(report.minor, '91');
  });

  // PINS: a `D`-state worker that survives SIGKILL does not stop the machine —
  // the abort is what frees it, so blocking here would deadlock the only remedy.
  test('a D-state worker that will not die does not block the unmounts or the abort', async () => {
    const { rundir, record } = await seedRun();
    const procs = liveBoth();
    procs[WORKER].state = 'D';
    const driver = fakeDriver({ procs, nsMounts: healthyMounts(record), conns: ['77'], undead: new Set([WORKER]) });
    const report = await runTeardown({ rundir, driver, scan: driver.scan, log: { warn() {} } });
    assert.equal(report.workerStopped, false);
    assert.deepEqual(driver.calls.filter(c => c[0] === 'signal' && c[1] === WORKER).map(c => c[2]), ['SIGTERM', 'SIGKILL']);
    assert.ok(driver.calls.some(c => c[0] === 'umount'), 'no unmount was issued past the undead worker');
    assert.ok(driver.calls.some(c => c[0] === 'abort'), 'no abort was issued past the undead worker');
  });

  // PINS: `state == Z` alone is the trap. A zombie leader with a second thread
  // still in the kernel is WEDGED and is never reaped; down to one thread it is
  // a plain orphan, which pid 1 will collect.
  test('a zombie with a live sibling thread is WEDGED; a single-threaded one is ZOMBIE-ORPHAN', async () => {
    for (const [threads, expected] of [[['1', '2'], 'WEDGED'], [['1'], 'ZOMBIE-ORPHAN']]) {
      const { rundir, record } = await seedRun();
      const procs = liveBoth();
      delete procs[WORKER];
      procs[DAEMON] = { starttime: DAEMON_START, state: 'Z', threads };
      // The daemon is `undead`: the point of the case is what the machine
      // REPORTS about a process that outlives its SIGKILL, not that it dies.
      const driver = fakeDriver({ procs, nsMounts: healthyMounts(record), conns: ['77'], undead: new Set([DAEMON]) });
      const report = await runTeardown({ rundir, driver, scan: driver.scan, log: { warn() {} } });
      assert.ok(report.terminalState.startsWith(expected), `${threads.length} thread(s) → ${report.terminalState}`);
      if (expected === 'WEDGED') assert.match(report.terminalState, /threads=2 states=/);
    }
  });

  // PINS: pid reuse. A recorded pid whose starttime no longer matches is a
  // stranger wearing the number; it is reported gone and NEVER signalled.
  test('a pid whose starttime no longer matches is not signalled', async () => {
    const { rundir, record } = await seedRun();
    const driver = fakeDriver({
      // Both numbers are live — but as different processes.
      procs: { [WORKER]: { starttime: '999999', state: 'S' }, [DAEMON]: { starttime: '888888', state: 'S' } },
      nsMounts: healthyMounts(record),
      conns: ['77'],
    });
    const report = await runTeardown({ rundir, driver, scan: driver.scan, log: { warn() {} } });
    assert.deepEqual(driver.calls.filter(c => c[0] === 'signal'), [], 'a recycled pid was signalled');
    assert.equal(report.terminalState, 'GONE');
    assert.ok(report.notes.some(n => n.includes(`worker pid ${WORKER}`) && n.includes('starttime mismatch')));
    assert.ok(report.notes.some(n => n.includes(`daemon pid ${DAEMON}`) && n.includes('starttime mismatch')));
  });

  // PINS: the wedge branch is a REPORTABLE state — the record survives with the
  // verdict written into it, and the same line lands on both surfaces.
  test('a wedge keeps the record, rewrites it with wedged:true, and reports on both surfaces', async () => {
    const { rundir, record } = await seedRun();
    const stuck = path.join(record.root, 'proc');
    const procs = liveBoth();
    delete procs[WORKER];
    const driver = fakeDriver({
      procs, nsMounts: healthyMounts(record), conns: ['77'],
      // The daemon outlives its SIGKILL, which is what keeps the mount
      // namespace — and therefore the stuck mount — in existence. A namespace
      // whose last process has gone takes its mounts with it, so a wedge with
      // no surviving process is not residue at all.
      umountFails: new Set([stuck]), undead: new Set([DAEMON]),
    });
    const emitted = [], warned = [];
    const report = await runTeardown({
      rundir, driver, scan: driver.scan, emit: ev => emitted.push(ev), log: { warn: (...a) => warned.push(a.join(' ')) },
    });

    assert.equal(report.wedged, true);
    assert.deepEqual(report.residualMounts, [stuck]);
    assert.equal(report.removedRunDir, false);
    const written = JSON.parse(await fs.readFile(path.join(rundir, 'mount.json'), 'utf8'));
    assert.equal(written.wedged, true);
    assert.deepEqual(written.residualMounts, [stuck]);
    assert.equal(written.terminalState, report.terminalState);
    assert.equal(written.minor, '77', 'the original record was replaced rather than amended');
    assert.equal(emitted.length, 1);
    assert.equal(emitted[0].kind, 'system');
    assert.equal(emitted[0].subtype, 'stderr');
    assert.ok(emitted[0].data.line.includes(stuck));
    assert.ok(warned.some(w => w.includes(stuck)), 'the wedge did not reach console.warn');
  });

  // PINS: the run directory is reclaimed on a CLEAN teardown, which is the
  // other half of "keeps the record on a wedge".
  test('a clean teardown reclaims the run directory', async () => {
    const { rundir, record } = await seedRun();
    const procs = liveBoth();
    delete procs[WORKER];
    const driver = fakeDriver({ procs, nsMounts: healthyMounts(record), conns: ['77'] });
    const report = await runTeardown({ rundir, driver, scan: driver.scan, log: { warn() {} } });
    assert.equal(report.wedged, false);
    assert.equal(report.removedRunDir, true);
    await assert.rejects(() => fs.stat(rundir));
  });

  // PINS: the two degraded record shapes. Neither may signal anything — with
  // no verified pid there is nothing it would be safe to signal.
  test('mount.json absent falls back to intent.json; both absent is NO-RECORD, and neither signals', async () => {
    const only = await seedRun({}, { intentOnly: true });
    const d1 = fakeDriver({ procs: liveBoth(), nsMounts: [] });
    const r1 = await runTeardown({ rundir: only.rundir, driver: d1, scan: d1.scan, log: { warn() {} } });
    assert.equal(r1.source, 'intent.json');
    assert.deepEqual(d1.calls.filter(c => c[0] === 'signal'), []);
    assert.deepEqual(d1.calls.filter(c => c[0] === 'abort'), []);

    const none = await seedRun({}, { noRecords: true });
    const d2 = fakeDriver({ procs: liveBoth(), nsMounts: [] });
    const r2 = await runTeardown({ rundir: none.rundir, driver: d2, scan: d2.scan, log: { warn() {} } });
    assert.equal(r2.source, 'NO-RECORD');
    assert.equal(r2.terminalState, 'NO-PID');
    assert.deepEqual(d2.calls, []);
  });

  // PINS: a count of fusectl entries is not a count of live daemons. Stale
  // minors are COUNTED and never aborted.
  test('a fusectl minor with no record of ours is counted, never aborted', async () => {
    const { rundir, record } = await seedRun();
    const procs = liveBoth();
    delete procs[WORKER];
    const driver = fakeDriver({ procs, nsMounts: healthyMounts(record), conns: ['56', '59', '77'] });
    const report = await runTeardown({ rundir, driver, scan: driver.scan, log: { warn() {} } });
    assert.equal(report.strayConnections, 2);
    assert.deepEqual(driver.calls.filter(c => c[0] === 'abort'), [['abort', '77']]);
  });

  // PINS: the abort is not attempted when the connection is not listed — that
  // is ABORT-UNAVAILABLE, a note, and the machine carries on.
  test('a minor with no fusectl entry is ABORT-UNAVAILABLE and does not stop teardown', async () => {
    const { rundir, record } = await seedRun();
    const procs = liveBoth();
    delete procs[WORKER];
    const driver = fakeDriver({ procs, nsMounts: healthyMounts(record), conns: ['56'] });
    const report = await runTeardown({ rundir, driver, scan: driver.scan, log: { warn() {} } });
    assert.equal(report.abort, 'ABORT-UNAVAILABLE');
    assert.deepEqual(driver.calls.filter(c => c[0] === 'abort'), []);
    assert.ok(driver.calls.some(c => c[0] === 'signal' && c[1] === DAEMON), 'the daemon ladder did not run');
  });

  // PINS: the ROOT-OWNED processes — the daemon and the namespace anchor — are
  // signalled through sudo; the worker is signalled directly, because setpriv
  // dropped it back to cc's own uid before exec'ing the CLI. Getting this
  // backwards is silent: an unprivileged signal at a root process is EPERM,
  // which `process.kill` throws and every caller here swallows as "gone".
  test('the root-owned processes are signalled privileged and the worker is not', async () => {
    const { rundir, record } = await seedRun();
    const driver = fakeDriver({ procs: liveBoth(), nsMounts: healthyMounts(record), conns: ['77'] });
    await runTeardown({ rundir, driver, scan: driver.scan, log: { warn() {} } });
    const sigs = driver.calls.filter(c => c[0] === 'signal');
    for (const [, pid, , mode] of sigs) {
      assert.equal(mode, (pid === DAEMON || pid === ANCHOR) ? 'sudo' : 'direct', `pid ${pid} signalled ${mode}`);
    }
    for (const pid of [WORKER, DAEMON, ANCHOR]) {
      assert.ok(sigs.some(c => c[1] === pid), `pid ${pid} was never signalled`);
    }
  });


  // PINS THE LEAKED-ANCHOR DEFECT: the record may not be destroyed while a pid
  // it names is still alive. The old machine derived `wedged` from mounts and
  // the daemon poll ONLY, so a surviving anchor — whose namespace is private
  // and therefore can never show in /proc/1/mounts — deleted its own record and
  // became permanently unreclaimable by name.
  test('a surviving recorded pid keeps the record, whatever the mounts say', async () => {
    for (const survivor of ['bootstrapPid', 'daemonPid', 'anchorPid']) {
      const { rundir, record } = await seedRun();
      const procs = liveBoth();
      // Everything unmounts and everything dies EXCEPT the one under test, so
      // the only thing that can keep the record is the death confirmation.
      const driver = fakeDriver({
        procs, nsMounts: healthyMounts(record),
        conns: ['77'], undead: new Set([record[survivor]]),
      });
      const report = await runTeardown({ rundir, driver, scan: driver.scan, log: { warn() {} } });

      assert.deepEqual(report.residualMounts, [], `${survivor}: the fixture left mounts, so this would pass for the wrong reason`);
      assert.equal(report.wedged, true, `${survivor} survived and the teardown still called itself clean`);
      assert.equal(report.removedRunDir, false, `${survivor}: the record was destroyed while it was alive`);
      assert.equal(report.survivingPids.length, 1, JSON.stringify(report.survivingPids));
      assert.match(report.survivingPids[0], new RegExp(`pid ${record[survivor]}$`));
      const written = JSON.parse(await fs.readFile(path.join(rundir, 'mount.json'), 'utf8'));
      assert.equal(written.wedged, true);
      assert.deepEqual(written.survivingPids, report.survivingPids);
    }
  });

  // PINS the other half: the anchor is signalled at all, and LAST — after the
  // daemon's terminal poll, because it is the handle everything before it needs.
  test('the anchor is killed, and killed after the daemon', async () => {
    const { rundir, record } = await seedRun();
    const driver = fakeDriver({ procs: liveBoth(), nsMounts: healthyMounts(record), conns: ['77'] });
    const report = await runTeardown({ rundir, driver, scan: driver.scan, log: { warn() {} } });
    const sigs = driver.calls.filter(c => c[0] === 'signal').map(c => c[1]);
    assert.ok(sigs.includes(record.anchorPid), 'the anchor was never signalled');
    assert.ok(sigs.lastIndexOf(record.anchorPid) > sigs.lastIndexOf(DAEMON), `order was ${sigs.join(',')}`);
    assert.deepEqual(report.survivingPids, []);
    assert.equal(report.removedRunDir, true);
  });

  // PINS: a record whose bootstrap never finished mounting still names the pids
  // it had already started, and teardown acts on them. This is the shape a
  // failed launch leaves, and the one a teardown keyed on a finished mount
  // signals nothing at all for.
  test('a stage:starting record is still torn down', async () => {
    const { rundir, record } = await seedRun({ stage: 'starting', minor: '', mountedAt: 0 });
    const driver = fakeDriver({ procs: liveBoth(), nsMounts: healthyMounts(record), conns: [] });
    const report = await runTeardown({ rundir, driver, scan: driver.scan, log: { warn() {} } });
    assert.equal(report.abort, 'no-minor');
    const sigs = driver.calls.filter(c => c[0] === 'signal').map(c => c[1]);
    for (const pid of [record.daemonPid, record.anchorPid]) assert.ok(sigs.includes(pid), `pid ${pid} not signalled`);
    assert.deepEqual(report.survivingPids, []);
    assert.equal(report.removedRunDir, true);
  });

  // PINS: /proc/1/mounts is checked, not just the namespace's own table — it is
  // the one that says whether anything escaped the private namespace at all.
  test('a mount visible in pid 1 is residue even when the namespace table is clean', async () => {
    const { rundir, record } = await seedRun();
    const procs = liveBoth();
    delete procs[WORKER];
    const escaped = path.join(record.root, 'sys');
    const driver = fakeDriver({ procs, nsMounts: [], hostMounts: [escaped], conns: ['77'] });
    const report = await runTeardown({ rundir, driver, scan: driver.scan, log: { warn() {} } });
    assert.equal(report.wedged, true);
    assert.deepEqual(report.residualMounts, [escaped]);
  });
});

describe('wrapLaunch — the pure argv/env/cwd transform', () => {
  const plan = {
    instanceId: 'inst-1', rundir: '/store/run/inst-1',
    root: '/store/run/inst-1/root', mirror: '/store/run/inst-1/mirror',
    fusectl: '/store/run/inst-1/fusectl', pinsPath: '/store/run/inst-1/pins.txt',
    intentPath: '/store/run/inst-1/intent.json', recordPath: '/store/run/inst-1/mount.json',
    daemonLog: '/store/run/inst-1/daemon.log',
    eventLog: '/store/run/inst-1/events.log',
    controlSock: '/store/run/inst-1/control.sock',
    markPath: '/usr/local/bin/claude',
    cwdInside: '/srv/app', mountOpts: 'allow_other,attr_timeout=0',
    tiers: [], pinsText: '', uid: 1000, gid: 1000,
    sourceOverrideRoot: '', tracePath: '',
  };
  const wrapped = () => wrapLaunch(
    { command: 'claude', args: ['-p', 'a prompt\nwith a newline', '--model', 'x'], cwd: '/store/sessions/foo', env: { HOME: '/home/wk', PATH: '/opt/bin:/usr/bin' } },
    { plan, unionBinary: '/store/bin/union-abc', ccBootId: 'boot-9', spawnedAt: 5 },
  );

  // ── THE TRACE SWITCH, PINNED AT THE PRODUCER ────────────────────────────
  //
  // A20t below drives `buildFusePlan` — the CONSUMER of the operator's switch —
  // and is green against every mutant of what follows, because the defect this
  // pins lives in what `wrapLaunch` EMITS. A produce-vs-consume gap is exactly
  // where a defect hides from the consumer's own tests.
  //
  // THE DEFECT IT RULES OUT: `CC_FUSE_TRACE` naming BOTH cc's on/off switch and
  // the worker-side path. `instances.ts` builds the worker env as
  // `{...process.env}` and the spread at the top of `wrapLaunch`'s object runs
  // FIRST, so an orchestrator started with `CC_FUSE_TRACE=0` — the natural way
  // to turn a thing off — put `"0"` into the path slot, the bootstrap's
  // non-emptiness test read it as ON, and the daemon got `CC_UNION_TRACE="0"`.

  // PINS: what `wrapLaunch` emits for the worker-side trace path is decided by
  // `plan.tracePath` ALONE, and an inherited value never survives it.
  // DIES UNDER: reverting to a spread that omits rather than deletes; keying
  // the emitted variable on anything in `spec.env`; renaming one end only.
  test('the worker-side trace path is emitted only when the plan has one, and an inherited one is STRIPPED', () => {
    const inherited = {
      HOME: '/home/wk', PATH: '/opt/bin',
      // Every spelling an operator might have in their own environment. Each
      // is a value the OLD non-emptiness test on the bootstrap side accepted.
      CC_FUSE_TRACE: '0', CC_FUSE_TRACE_LOG: '/somewhere/stale.log',
    };
    const call = (tracePath) => wrapLaunch(
      { command: 'claude', args: [], cwd: '/x', env: inherited },
      { plan: { ...plan, tracePath }, unionBinary: '/b', ccBootId: 'b', spawnedAt: 1 },
    ).env;

    const off = call('');
    assert.equal('CC_FUSE_TRACE_LOG' in off, false,
      'an inherited trace path rode through a launch cc decided was untraced');
    // The KEY is gone, not merely undefined: `spawn` would omit an undefined
    // value, but a reader of this object would still see the key and disagree
    // with the child.
    assert.equal(Object.prototype.hasOwnProperty.call(off, 'CC_FUSE_TRACE_LOG'), false);
    // The operator's own switch DOES ride through, and that is correct rather
    // than overlooked: the worker inherits the orchestrator's environment
    // wholesale, and stripping one inert variable out of it would be a rule
    // with no reader. What makes it inert is asserted on the other side —
    // bootstrap.sh reads `CC_FUSE_TRACE_LOG` and nothing else.
    assert.equal(off.CC_FUSE_TRACE, '0');

    const on = call('/store/run/inst-1/trace.log');
    assert.equal(on.CC_FUSE_TRACE_LOG, '/store/run/inst-1/trace.log');
  });

  // PINS: the two ends are keyed on DIFFERENT NAMES, so the operator's flag
  // cannot land in the path slot — over every value that distinguishes the
  // exact `=== '1'` test from the non-emptiness one.
  // DIES UNDER: collapsing the two names back into one; loosening
  // `resolveTraceEnabled` to a truthiness test.
  test("the operator's switch is exactly '1', and it never reaches the worker as a path", async () => {
    const { buildFusePlan, resolveTraceEnabled, fuseRunDir } = await import('../src/systems/fuse/plan.ts');
    const prev = process.env.CC_FUSE_TRACE;
    const planArgs = { instanceId: 'inst-t', cwdInside: '/srv/app', sourceOverrideRoot: null,
      markPath: '/usr/bin/claude', tiers: [] };
    try {
      for (const [value, wantOn] of [[undefined, false], ['', false], ['0', false], ['yes', false], ['1', true]]) {
        if (value === undefined) delete process.env.CC_FUSE_TRACE;
        else process.env.CC_FUSE_TRACE = value;
        assert.equal(resolveTraceEnabled(), wantOn, `CC_FUSE_TRACE=${JSON.stringify(value)}`);
        const p = buildFusePlan(planArgs);
        assert.equal(p.tracePath, wantOn ? path.join(fuseRunDir('inst-t'), 'trace.log') : '',
          `CC_FUSE_TRACE=${JSON.stringify(value)}`);
        // AND THROUGH THE PRODUCER, with the operator's own value inherited —
        // the whole path the defect took.
        const env = wrapLaunch(
          { command: 'claude', args: [], cwd: '/x', env: { ...(value === undefined ? {} : { CC_FUSE_TRACE: value }) } },
          { plan: { ...plan, tracePath: p.tracePath }, unionBinary: '/b', ccBootId: 'b', spawnedAt: 1 },
        ).env;
        assert.equal('CC_FUSE_TRACE_LOG' in env, wantOn, `CC_FUSE_TRACE=${JSON.stringify(value)}`);
      }
    } finally {
      if (prev === undefined) delete process.env.CC_FUSE_TRACE;
      else process.env.CC_FUSE_TRACE = prev;
    }
  });

  // PINS the OTHER end of the same handoff, in bootstrap.sh — a SOURCE-SHAPE
  // assertion, in the idiom this suite already uses for the daemon's own
  // producer side (A16, and the `pt_release` partition pin): the block that
  // composes the daemon's environment cannot be observed from a deterministic
  // fixture, and running the bootstrap needs sudo and a real mount.
  //
  // Both arms are asserted, because the `else` is not tidiness: `sudo -E`
  // carries the orchestrator's whole environment through, so an ambient
  // `CC_UNION_TRACE` reaches the daemon on an untraced spawn unless this
  // clears it.
  // DIES UNDER: keying the guard on `CC_FUSE_TRACE` again; dropping the `else`.
  test("bootstrap.sh keys the daemon's trace on the PATH, and clears an ambient one", async () => {
    const { readFile } = await import('node:fs/promises');
    const { fileURLToPath } = await import('node:url');
    const src = await readFile(
      path.join(path.dirname(fileURLToPath(import.meta.url)), '..', 'src', 'systems', 'fuse', 'bootstrap.sh'), 'utf8');
    const guard = /if \[ -n "\$\{CC_FUSE_TRACE_LOG:-\}" \]; then\n\texport CC_UNION_TRACE="\$CC_FUSE_TRACE_LOG"\nelse\n\tunset CC_UNION_TRACE \|\| :\nfi/;
    assert.match(src, guard, 'the daemon trace guard is not the shape this test pins — re-anchor or repair');
    // NOTHING ELSE MAY SET IT. A second assignment anywhere would be a second
    // mechanism, and the guard above would stop being the whole answer.
    assert.deepEqual(src.match(/CC_UNION_TRACE=/g), ['CC_UNION_TRACE='],
      'CC_UNION_TRACE is assigned in more than one place');
    // And the operator's own flag is read NOWHERE here: cc is its only reader.
    assert.equal(/\$\{?CC_FUSE_TRACE[^_]/.test(src), false,
      "bootstrap.sh reads cc's operator switch, which is how the two names collapsed before");
  });

  // PINS: the namespace is private and the mount namespace is new. Losing
  // `--propagation private` would let the mount escape into /proc/1/mounts,
  // which is the exact condition criterion 5 forbids.
  test('enters a private mount namespace under non-interactive sudo', () => {
    const w = wrapped();
    assert.equal(w.command, 'sudo');
    const j = w.args.join(' ');
    assert.ok(j.startsWith('-n -E unshare --mount --propagation private --'), j);
  });

  // PINS: the CLI's own argv rides through positionally and untouched, INCLUDING
  // an argument containing a newline.
  test('carries the CLI argv through verbatim, newline and all', () => {
    const w = wrapped();
    const i = w.args.indexOf('claude');
    assert.ok(i > 0, 'the CLI command is not in the wrapped argv');
    assert.deepEqual(w.args.slice(i), ['claude', '-p', 'a prompt\nwith a newline', '--model', 'x']);
  });

  // PINS: the cwd is rewritten to `/`. The CLI's real cwd may not exist on the
  // host at all, and spawn() would fail with ENOENT before the bootstrap ran.
  test('rewrites cwd to / and carries the real cwd in the environment', () => {
    const w = wrapped();
    assert.equal(w.cwd, '/');
    assert.equal(w.env.CC_FUSE_CWD, '/srv/app');
  });

  // PINS: spawnEnv rides through. Every cc-managed variable (HOME,
  // CLAUDE_CODE_TMPDIR, the context-window pair) is delivered this way, and the
  // whole host-pin design rests on those paths keeping their spelling.
  test('preserves the caller environment and carries the plan in CC_FUSE_*', () => {
    const w = wrapped();
    assert.equal(w.env.HOME, '/home/wk');
    assert.equal(w.env.CC_FUSE_ROOT, plan.root);
    assert.equal(w.env.CC_FUSE_PINS, plan.pinsPath);
    assert.equal(w.env.CC_FUSE_BIN, '/store/bin/union-abc');
    assert.equal(w.env.CC_FUSE_RECORD, plan.recordPath);
    assert.equal(w.env.CC_FUSE_MOUNT_OPTS, plan.mountOpts);
    assert.equal(w.env.CC_FUSE_UID, '1000');
    assert.equal(w.env.CC_FUSE_INSTANCE_ID, 'inst-1');
    assert.equal(w.env.CC_FUSE_BOOT_ID, 'boot-9');
    // sudo's secure_path replaces PATH even under -E, so the CLI's PATH travels
    // under a name sudo does not know about.
    assert.equal(w.env.CC_FUSE_PATH, '/opt/bin:/usr/bin');
  });

  // PINS: the things the daemon REFUSES TO MOUNT without, carried by name.
  // `bootstrap.sh` renames each into the daemon's own CC_UNION_* prefix, and a
  // missing one is a launch that dies in the mount-wait loop rather than at a
  // named refusal. The EVENT LOG is not one of those — the daemon mounts
  // without it and simply records nothing — but it rides the same channel and a
  // missing one costs the whole pin-derivation instrument.
  test('carries the control socket, the mark path, the cwd and the event log', () => {
    const w = wrapped();
    assert.equal(w.env.CC_FUSE_CONTROL, plan.controlSock);
    assert.equal(w.env.CC_FUSE_MARK_PATH, plan.markPath);
    assert.equal(w.env.CC_FUSE_EVENT_LOG, plan.eventLog);
    // THE CWD IS A MOUNT PRECONDITION TOO (`CC_UNION_CWD`): it is the whole
    // domain of the floor and of the overlay, so without it nothing is floored,
    // no overlay node exists, and the launch dies at the `cd`. It rides as
    // `CC_FUSE_CWD`, which `wrapLaunch` already set for the bootstrap's own
    // `cd`.
    assert.equal(w.env.CC_FUSE_CWD, plan.cwdInside);
  });
});

describe('the tier table', () => {
  // `localRoots` are DECLARATIONS: each carries the bit the hook reads. Every one is still host-pinned for the daemon whatever the bit says,
  // which is what the first test below asserts.
  const input = {
    localRoots: [
      { prefix: '/store/attachments/app', access: 'allow', why: 'uploads' },
      { prefix: '/store/session-tmp/inst-1', access: 'allow', why: 'own tmp' },
      { prefix: '/home/wk/.claude/plans', access: 'allow', why: 'plan mode writes here' },
      { prefix: '/home/wk/.claude', access: 'deny', why: 'the CLI\'s own state' },
      { prefix: '/home/wk/.claude/projects', access: 'deny', why: 'every session\'s transcripts' },
      { prefix: '/opt/plugins/p1', access: 'allow', why: 'a plugin root' },
    ],
    claudeCommand: '/usr/local/share/npm-global/bin/claude',
    execPath: '/usr/local/bin/node',
    selfProjectDir: '/home/wk/cc',
    projectsRoot: '/home/wk/cc-projects',
    homeDir: '/home/wk',
    runDir: '/home/wk/cc-projects/.cc-store/systems/fuse/run/inst-1',
    systemPath: '/srv/app',
    mirrorRoot: '/srv/app',
    exclude: [],
  };
  const tierOf = (entries, prefix) => entries.find(e => e.prefix === prefix)?.tier;
  const lines = (entries) => renderPinsFile(entries).split('\n').filter(l => l && !l.startsWith('#'));

  // PINS: the three pins whose absence is a behaviour change under the frozen
  // daemon's remote-first `default` arm — every one of them would otherwise be
  // answered by whatever the remote happens to hold.
  test('node, the projects root and every localRoot are host-pinned', () => {
    const t = buildTierTable(input);
    assert.equal(tierOf(t, '/usr/local/bin/node'), 'host');
    assert.equal(tierOf(t, '/home/wk/cc-projects'), 'host');
    assert.equal(tierOf(t, '/home/wk/cc'), 'host');
    assert.equal(tierOf(t, '/home/wk'), 'host');
    for (const r of input.localRoots) assert.equal(tierOf(t, r.prefix), 'host', r.prefix);
  });

  // PINS: the run directory is HIDDEN, so the union never serves its own
  // backing store — and it wins over the host pin above it, which is a
  // longest-prefix claim about union.c's tier_of.
  test('the run directory is hidden, and is longer than the projects-root host pin', () => {
    const t = buildTierTable(input);
    assert.equal(tierOf(t, input.runDir), 'hide');
    assert.ok(input.runDir.length > input.projectsRoot.length);
    assert.ok(input.runDir.startsWith(input.projectsRoot + '/'));
  });

  test('the project is the only `project` entry', () => {
    const t = buildTierTable(input);
    assert.deepEqual(t.filter(e => e.tier === 'project').map(e => e.prefix), ['/srv/app']);
  });

  // ── THE STRICT-ANCESTOR GEOMETRY, WHICH NOTHING BUILT BEFORE ─────────────
  //
  // PINS the CONFIGURATION half of the bug: under a `mirrorRoot`
  // that is a STRICT ANCESTOR of `systemPath`, `buildTierTable` emits TWO
  // `project` entries, and the shallower one covers every directory between
  // them by prefix — which is what made the orchestrator's own `/srv` resolve
  // the remote tier and killed every spawn in chdir(). The daemon's half is the
  // view (`b38`/`b39`); this is the half that says the geometry the view is
  // invariant to is really the geometry the product builds.
  //
  // The M arm of that discriminator had never been exercised by any test: every
  // fixture before this one set `mirrorRoot === systemPath`.
  test('a mirrorRoot that is a strict ancestor emits two project entries, the shallower exact', () => {
    const t = buildTierTable(tierFixtureInput({ systemPath: '/srv/app', mirrorRoot: '/srv' }));
    const project = t.filter(e => e.tier === 'project').map(e => e.prefix);
    assert.deepEqual(project, ['/srv', '/srv/app'],
      'the remote tier\'s boundary first, the project inside it second');
    // AN EXACT ENTRY ON THE ANCESTOR, not merely coverage: it is what makes
    // `/srv` itself — and everything under it that is not the project — resolve
    // T_PROJECT for the marked CLI.
    assert.ok(t.some(e => e.tier === 'project' && e.prefix === '/srv'),
      '/srv carries an exact project pin, so the space between it and the project is remote');
    // AND `/` IS STILL NOT ONE, so the W arm is a different table again.
    assert.equal(t.filter(e => e.tier === 'project' && e.prefix === '/').length, 0);
  });

  // AND THE WIDEST ARM: `mirrorRoot: '/'` pins the root itself, which is what
  // removes `/` from the derived ancestor set in the daemon (anc_build drops any
  // ancestor carrying an exact pin) and is why `b38` has to assert the unmarked
  // answer at `/` is the same as it is at the narrow root.
  test('a mirrorRoot of / pins the root itself as project', () => {
    const t = buildTierTable(tierFixtureInput({ systemPath: '/srv/app', mirrorRoot: '/' }));
    assert.deepEqual(t.filter(e => e.tier === 'project').map(e => e.prefix), ['/', '/srv/app']);
  });

  // ── A11/A12: "two mechanisms, never one list" ─────────────────────────────
  //
  // BIND_MOUNTS ARE IN THE TABLE, not absent from it: the daemon has to be told
  // those three paths exist as directories, because `bootstrap.sh` binds OVER
  // them and a `mount --bind` onto a target the daemon answers -ENOENT for
  // kills the launch. The never-merge rule is therefore asserted as a claim
  // about DERIVATION, not about absence: each kind comes from exactly one
  // source and no input to one moves the other.
  //
  // PINS: `bind` is derived only from the constant; `fail` only from the
  // advertisement's excludes.
  test('bind is derived only from the constant, and no exclude changes it', () => {
    const t = buildTierTable(input);
    for (const b of BIND_MOUNTS) assert.equal(tierOf(t, b), 'bind', b);
    // A TRIPWIRE, not coverage: this literal exists so that changing the bind
    // set is a deliberate two-place edit rather than a silent one, and so a
    // later reader who merges it with the tier table has to delete an assertion
    // that says not to. It proves nothing about behaviour by itself.
    assert.deepEqual([...BIND_MOUNTS], ['/proc', '/sys', '/dev']);
    // CLEARING the excludes leaves every bind line — a provider that excludes
    // nothing must not lose /proc bind-mounting.
    const none = lines(buildTierTable({ ...input, exclude: [] }));
    for (const b of BIND_MOUNTS) assert.ok(none.includes(`bind\t${b}`), `${b} lost its bind line`);
    // A provider that excludes nothing, and one that excludes something odd,
    // leave the bind set identical — it is a constant, not a derivation.
    const before = [...BIND_MOUNTS];
    buildTierTable({ ...input, systemPath: '/var/lib/secrets', exclude: ['/var/lib/secrets'] });
    assert.deepEqual([...BIND_MOUNTS], before);
  });

  // PINS: an exclude adds a `fail` line and NOTHING to the bind set — the other
  // direction of the same rule.
  test('an exclude inside the mirror root adds a fail line and no bind line', () => {
    const t = buildTierTable({ ...input, mirrorRoot: '/', exclude: ['/var/lib/secrets'] });
    assert.equal(tierOf(t, '/var/lib/secrets'), 'fail');
    const rendered = lines(t);
    assert.ok(rendered.includes('fail\t/var/lib/secrets'), rendered.join(' '));
    assert.ok(!rendered.includes('bind\t/var/lib/secrets'));
    // And it did not become a fourth bind mount.
    assert.deepEqual(rendered.filter(l => l.startsWith('bind\t')), ['bind\t/proc', 'bind\t/sys', 'bind\t/dev']);
  });

  // PINS: excluded AND bind-mounted keeps `bind` — the daemon needs the
  // directory to exist so `bootstrap.sh`'s bind succeeds, and the bind then
  // shadows the union there anyway. Inverting the two `add` loops in
  // buildTierTable turns this line into `fail /proc` and kills the launch.
  test('an exclude that is also a bind mount keeps its bind line', () => {
    const rendered = lines(buildTierTable({ ...input, mirrorRoot: '/', exclude: ['/proc'] }));
    assert.ok(rendered.includes('bind\t/proc'), rendered.join(' '));
    assert.ok(!rendered.includes('fail\t/proc'), 'the fail spelling shadowed the bind one');
  });

  // PINS criterion 4's third clause: an exclude OUTSIDE the mirror root is
  // INERT — it renders nothing. `resolveMirrorScope` has already reported it on
  // the session's stream; turning it into a `fail` pin would make an
  // "inert, no effect" diagnostic a lie and -ENOENT a path the union never
  // served in the first place.
  test('an exclude outside the mirror root renders nothing', () => {
    const t = buildTierTable({ ...input, mirrorRoot: '/srv/app', exclude: ['/var/lib/secrets'] });
    assert.equal(tierOf(t, '/var/lib/secrets'), undefined);
    assert.ok(!lines(t).some(l => l.startsWith('fail\t')), 'an inert exclude reached the pins file');
  });

  // PINS: a prefix appearing twice keeps its FIRST decision, so the table's
  // meaning cannot depend on construction order.
  test('a duplicate prefix keeps its first tier', () => {
    const t = buildTierTable({ ...input, localRoots: [...input.localRoots, { prefix: '/home/wk', access: 'allow', why: 'a second spelling of the home pin' }] });
    assert.deepEqual(t.filter(e => e.prefix === '/home/wk').length, 1);
    assert.equal(tierOf(t, '/home/wk'), 'host');
  });

  // PINS THE INVERSE: the interpreter chain bootstrap.sh execs INSIDE the union
  // carries NO pin, in any spelling. `bootstrap.sh` fires no marking event, so
  // the chroot'd shell and `setpriv` resolve in `VIEW_HOST` at every geometry,
  // where an unpinned path is served from the orchestrator anyway.
  //
  // THE LICENCE IS REAL GATE `R13w`, which asserts at `mirrorRoot: '/'` that no
  // marked op names a path under `/usr/bin` at all. If the CLI ever grows a
  // marked read there, `R13w` fails and these pins are load-bearing again —
  // this assertion is what a reinstating change has to delete.
  test("the bootstrap's interpreter chain is NOT pinned, in any spelling", () => {
    const t = buildTierTable(input);
    for (const p of ['/bin/sh', '/usr/bin/sh', '/bin/dash', '/usr/bin/dash',
      '/bin/bash', '/usr/bin/bash', '/usr/bin/setpriv', '/bin/setpriv']) {
      assert.equal(tierOf(t, p), undefined, `${p} carries a pin again`);
    }
    // NON-VACUITY: the table really is populated, so "no entry" is a decision
    // and not an empty build.
    assert.equal(tierOf(t, '/etc/passwd'), 'host');
  });

  // PINS one layer further down: the ELF interpreter baked into the CLI's own
  // binaries and glibc's dlopen closure. On a merged-usr host `/lib` and
  // `/lib64` are symlinks to `/usr/lib` and `/usr/lib64`, but the table matches
  // PATH STRINGS — so the `/lib64` spelling the ELF header actually requests
  // has to be named, not merely implied by the `/usr/lib64` one.
  test('the loader is pinned in the spelling the ELF header requests', () => {
    const t = buildTierTable(input);
    for (const p of [
      '/lib64/ld-linux-x86-64.so.2',            // the requested program interpreter
      '/usr/lib64/ld-linux-x86-64.so.2',
      '/lib/x86_64-linux-gnu/libc.so.6',
      '/usr/lib/x86_64-linux-gnu/libc.so.6',
      '/lib/x86_64-linux-gnu/libcap.so.2',      // libsystemd's, via the libnss_systemd dlopen closure the MARKED CLI drives
      '/usr/lib/x86_64-linux-gnu/libcap.so.2',
    ]) {
      assert.equal(tierOf(t, p), 'host', p);
    }
    // AND `libcap-ng.so.0` IS NOT THERE — it is `setpriv`'s alone, and
    // `setpriv` runs unmarked. Adjacent to `libcap.so.2` above, similarly
    // named, opposite class: the two must not be reinstated together.
    for (const p of ['/lib/x86_64-linux-gnu/libcap-ng.so.0', '/usr/lib/x86_64-linux-gnu/libcap-ng.so.0'])
      assert.equal(tierOf(t, p), undefined, `${p} carries a pin again`);
  });

  // PINS: the npm-global chain. Pinning the leaves alone left every parent
  // directory in the chain falling back on a getattr.
  test('a binary pins its install prefix, not just the leaf', () => {
    const pins = binaryPins('/usr/local/share/npm-global/bin/claude');
    assert.ok(pins.includes('/usr/local/share/npm-global/bin/claude'));
    // The install prefix is the common ancestor of the launcher and its target;
    // with no symlink to follow it is the bin directory itself.
    assert.ok(pins.some(p => p === '/usr/local/share/npm-global/bin' || p === '/usr/local/share/npm-global'), pins.join(' '));
    // A BARE NAME IS RESOLVED AGAINST PATH, and that stopped being cosmetic
    // when T_FAIL reached enum index 0: `resolveClaudeBin()` returns a bare
    // `claude` by default, an unpinned launcher is now -ENOENT rather than a
    // host fallback, and the CLI could not exec at all.
    assert.deepEqual(binaryPins('cc-no-such-command-anywhere'), [],
      'a name PATH cannot resolve pins nothing');
    const shPins = binaryPins('sh');
    assert.ok(shPins.length > 0 && path.isAbsolute(shPins[0]),
      `a bare name on PATH resolves to an absolute pin, got ${JSON.stringify(shPins)}`);
    assert.equal(resolveOnPath('/already/absolute'), '/already/absolute');
    assert.equal(resolveOnPath('cc-no-such-command-anywhere'), '');
  });

  // ── THE `/usr`-PREFIX GEOMETRY, AS PATH ARITHMETIC ───────────────────────
  //
  // PINS: where the launcher and its realpath share only a TWO-component
  // ancestor, `installPins` emits the REALPATH's ancestor chain from the floor
  // down, and never `/usr` or `/`.
  //
  // PATH STRINGS ARE THE FIXTURE, and they have to be: the defect is that the
  // common ancestor has exactly two ABSOLUTE components, and any `mkdtemp` root
  // is far deeper — so under a temp tree the fallback branch can never fire.
  // T2 below drives the same function from a real symlinked tree and therefore
  // covers only the single-prefix branch; this is the chain branch's one home.
  //
  // THE ASYMMETRY IS DELIBERATE AND IS ASSERTED, because it is what a reader
  // would otherwise "fix" back to symmetry: the mark fires at the daemon's
  // resolution of the COMMAND spelling, so the command's own ancestors are
  // walked to reach it — before the marking event, by an unmarked caller
  // `VIEW_HOST` serves from the orchestrator with no pin. Everything the VFS
  // walks after (the readlink, the realpath, that realpath's ancestors) is
  // resolved by an already-marked thread group. `R16` measures both halves at a
  // real mount.
  test('installPins chains the realpath side when the common ancestor is below the floor', () => {
    // The `/usr`-prefix host: npm prefix `/usr`, globals under
    // `/usr/lib/node_modules`. The common ancestor is `/usr` — two components,
    // below the floor — so the chain is the realpath's, from the floor down.
    const usr = installPins('/usr/bin', '/usr/lib/node_modules/@anthropic-ai/claude-code/bin');
    assert.deepEqual(usr, [
      '/usr/lib',
      '/usr/lib/node_modules',
      '/usr/lib/node_modules/@anthropic-ai',
      '/usr/lib/node_modules/@anthropic-ai/claude-code',
      '/usr/lib/node_modules/@anthropic-ai/claude-code/bin',
    ]);
    // THE COMMAND SIDE IS ABSENT, and that is the asymmetry above.
    assert.ok(!usr.includes('/usr/bin'), usr.join(' '));
    // THE FLOOR, and this assertion is the ONLY thing in the suite pinning its
    // invariant: the install-prefix arm in the test above is disjunctive (the
    // bin directory OR the prefix) and passes under any floor at all.
    assert.ok(!usr.includes('/usr') && !usr.includes('/'), usr.join(' '));

    // THE HEALTHY LAYOUT, unchanged: a 4-component common ancestor clears the
    // floor, so one prefix is emitted and no chain is derived. The regression
    // guard for every host whose npm prefix is not `/usr`.
    assert.deepEqual(
      installPins('/usr/local/share/npm-global/bin',
        '/usr/local/share/npm-global/lib/node_modules/@anthropic-ai/claude-code/bin'),
      ['/usr/local/share/npm-global']);

    // NO SYMLINK TO FOLLOW: the common ancestor is the directory itself, which
    // is what still puts `/usr/bin` in the table through `binaryPins(execPath)`
    // on a host where node is `/usr/bin/node`.
    assert.deepEqual(installPins('/usr/bin', '/usr/bin'), ['/usr/bin']);

    // A COMMAND SIDE THAT SHARES ONLY `/` WITH ITS TARGET: the realpath's
    // directory is emitted and the command's is not.
    assert.deepEqual(installPins('/bin', '/usr/bin'), ['/usr/bin']);
  });

  // PINS, from a real symlinked tree rather than from arithmetic: `binaryPins`
  // emits the launcher's own path, ITS REALPATH, and the install prefix — and
  // resolves a bare name against PATH to the same set.
  //
  // THE REALPATH ENTRY IS ASSERTED UNCONDITIONALLY. Nothing else in the suite
  // does: in the `/usr`-prefix geometry the common ancestor is below the floor,
  // so the realpath row is the only pin covering the launcher's actual script,
  // and a `binaryPins` that dropped it left every other assertion green.
  //
  // THE SINGLE-PREFIX BRANCH BY CONSTRUCTION: a `mkdtemp` root always clears
  // the 3-component floor, so the common ancestor here is never rejected and
  // the chain branch is unreachable from this fixture. T1 owns that branch.
  test('binaryPins carries the realpath and the install prefix, from a real symlink', async () => {
    const root = await mkdtemp('cc-binpins-');
    const binDir = path.join(root, 'bin');
    const pkgBin = path.join(root, 'lib', 'node_modules', 'pkg', 'bin');
    await fs.mkdir(binDir, { recursive: true });
    await fs.mkdir(pkgBin, { recursive: true });
    const real = path.join(pkgBin, 'claude.exe');
    const link = path.join(binDir, 'claude');
    await fs.writeFile(real, '#!/bin/sh\nexit 0\n', { mode: 0o755 });
    await fs.symlink(real, link);

    const pins = binaryPins(link);
    assert.ok(pins.includes(link), `the launcher's own spelling: ${pins.join(' ')}`);
    assert.ok(pins.includes(real),
      `THE REALPATH IS NOT PINNED. The union follows the symlink and the target has its own `
      + `tier, so an unpinned target is a fail-tier -ENOENT at the second hop: ${pins.join(' ')}`);
    assert.ok(pins.includes(root), `the install prefix: ${pins.join(' ')}`);

    // THE SAME SET FROM A BARE NAME ON PATH — `resolveClaudeBin()` returns a
    // bare `claude` by default, so this is the production spelling.
    const savedPath = process.env.PATH;
    process.env.PATH = `${binDir}${path.delimiter}${savedPath}`;
    try {
      assert.deepEqual(binaryPins('claude'), pins);
    } finally {
      if (savedPath === undefined) delete process.env.PATH;
      else process.env.PATH = savedPath;
    }
  });

  // PINS: the rendered file is what union.c's pins_load actually parses —
  // `<tier>\t<prefix>` with `#` comments.
  test('renders one tab-separated rule per line, with comments', () => {
    const text = renderPinsFile([{ tier: 'host', prefix: '/etc/passwd', why: 'identity', toolAccess: 'deny' }, { tier: 'hide', prefix: '/run/x', why: 'scaffolding', toolAccess: 'deny' }]);
    const rules = text.split('\n').filter(l => l && !l.startsWith('#'));
    assert.deepEqual(rules, ['host\t/etc/passwd', 'hide\t/run/x']);
    assert.ok(text.split('\n').some(l => l.startsWith('# identity')));
  });
});

// ── the three literals the daemon's behaviour rests on ─────────────────────
//
// Each of these is a value cc renders or hands to a frozen daemon, where the
// consequence of a drift is invisible from every other assertion in the suite.
// ── FROM A LOGGED DENIAL TO A PIN ENTRY ────────────────────────────────────
//
// The daemon's event log is the instrument the pin list is DERIVED from, and
// `runTeardown` `rm -rf`s it with the run directory — so it has to be harvested
// first. These pin the harvest, the suggestion and the wording.
describe('the policy event harvest', () => {
  let prev, storeRoot;
  before(async () => {
    prev = process.env.PROJECTS_ROOT;
    storeRoot = path.join(await mkdtemp('cc-fuse-events-'), 'projects');
    process.env.PROJECTS_ROOT = storeRoot;
  });
  after(() => { if (prev === undefined) delete process.env.PROJECTS_ROOT; else process.env.PROJECTS_ROOT = prev; });

  // THE DAEMON'S OWN EIGHT COLUMNS, header line included. `\\0` is the argv
  // separator and `\\t` an escaped tab, both written the way `policy_escape`
  // writes them — a fixture in a shape the daemon cannot produce would let the
  // parser drift away from the producer unnoticed.
  const EVENT_HEADER = '# cc-union events v2\tkind\top\tpath\treason\tpid\ttgid\tcomm\tcmdline'
    + " — identity is sampled at POLICY TIME; the process may have exec'd since.";
  const EVENTS = [
    EVENT_HEADER,
    'deny\tgetattr\t/lib/x86_64-linux-gnu/libtinfo.so.6\tunpinned-fail-closed\t4243\t4242\tclaude\tclaude\\0--print',
    'deny\topen\t/etc/machine-id\tunpinned-fail-closed\t4242\t4242\tclaude\tclaude\\0--print',
    'deny\tgetattr\t/usr/bin/git\tunpinned-fail-closed\t4242\t4242\tclaude\tclaude\\0--print',
    'deny\tgetattr\t/var/opt/thing\tunpinned-fail-closed\t4242\t4242\tclaude\tclaude\\0--print',
    'served\tgetattr\t/run/user/1000\tunmarked-host-served\t5100\t5100\tsh\t/bin/sh\\0-c\\0echo\\thi',
    'deny\tgetattr\t/srv/app/f.txt\tunmarked-project-denied\t5100\t5100\t\\!gone\t\\!gone',
  ].join('\n') + '\n';

  // PINS: `suggestPin` names the array that OWNS each shape of path, and the
  // loader entry is the `/usr/`-prefixed spelling.
  //
  // THE CANONICALISATION IS LOAD-BEARING, NOT COSMETIC. `LOADER_PINS` derives
  // the `/lib` spelling AND the realpath from whatever is in `LOADER_OBJECTS`,
  // so an entry added in the `/lib` spelling leaves the closure open — which is
  // exactly the `libcap-ng.so.0.0.0` failure tierTable.ts's own comment records.
  // DIES UNDER: dropping the `/usr/` canonicalisation; collapsing two lists into
  // one; guessing a list for a path no array owns.
  test('suggestPin names the owning array, and the loader entry is the /usr/ spelling', () => {
    assert.deepEqual(suggestPin('/lib/x86_64-linux-gnu/libtinfo.so.6'),
      { list: 'LOADER_OBJECTS', entry: '/usr/lib/x86_64-linux-gnu/libtinfo.so.6', note: suggestPin('/lib/x86_64-linux-gnu/libtinfo.so.6').note });
    assert.equal(suggestPin('/lib64/ld-linux-x86-64.so.2').entry, '/usr/lib64/ld-linux-x86-64.so.2');
    // Already canonical: unchanged, never double-prefixed.
    assert.equal(suggestPin('/usr/lib/x86_64-linux-gnu/libm.so.6').entry, '/usr/lib/x86_64-linux-gnu/libm.so.6');
    // A `.so` by NAME anywhere, and a loader-dir path by LOCATION even with no
    // `.so` suffix — `gconv` is a directory and carries none.
    assert.equal(suggestPin('/opt/vendor/libfoo.so.3.1').list, 'LOADER_OBJECTS');
    assert.equal(suggestPin('/usr/lib/x86_64-linux-gnu/gconv/UTF-16.so').list, 'LOADER_OBJECTS');
    assert.equal(suggestPin('/lib/x86_64-linux-gnu/gconv').list, 'LOADER_OBJECTS');
    assert.equal(suggestPin('/etc/machine-id').list, 'ETC_PINS');
    assert.equal(suggestPin('/etc/machine-id').entry, '/etc/machine-id');
    // A BIN DIRECTORY IS THE NO-GUESS SHAPE TOO, and the note has to say what
    // the denial MEANS: the bootstrap's shell and setpriv are unmarked and
    // host-served with no pin, so a refusal here is the MARKED CLI's. The
    // launcher-closure check comes FIRST, because `binaryPins(claudeCommand)`
    // already pins that and a hand-added entry there would be a second source.
    for (const b of ['/bin/tar', '/sbin/ldconfig', '/usr/bin/git', '/usr/sbin/nologin']) {
      assert.equal(suggestPin(b).list, null, b);
      assert.equal(suggestPin(b).entry, b);
      assert.match(suggestPin(b).note, /MARKED CLI/, b);
      const note = suggestPin(b).note;
      assert.ok(note.indexOf('binaryPins(claudeCommand)') < note.indexOf('LOADER_OBJECTS'),
        `the launcher-closure check must be named before the arrays: ${note}`);
    }
    // NO GUESS where no array owns the path — a wrong array is worse than none,
    // because the entry lands where the derivations do not apply and the path
    // stays refused for a reason the log no longer explains.
    assert.equal(suggestPin('/var/opt/thing').list, null);
    assert.match(suggestPin('/var/opt/thing').note, /localRoots/);
    // EVERY SUGGESTION CARRIES THE RESTART CAVEAT, because the pin list is read
    // at the next spawn AFTER an orchestrator restart and nothing else says so.
    for (const p of ['/etc/x', '/lib/x.so', '/bin/x', '/var/x'])
      assert.match(suggestPin(p).note, /restart/, p);
  });

  // PINS: the harvest happens BEFORE the reclaim, so the store-wide log has the
  // rows even though the run directory is gone.
  // DIES UNDER: moving the harvest after `fsp.rm(rundir)`; harvesting only on
  // the wedged path.
  test('the harvest lands in the store BEFORE the run directory is reclaimed', async () => {
    const { rundir, record } = await seedRun();
    await fs.writeFile(path.join(rundir, 'events.log'), EVENTS);
    const driver = fakeDriver({ procs: {}, nsMounts: [], conns: [] });
    const report = await runTeardown({ rundir, driver, scan: driver.scan, log: { warn() {} } });
    // NON-VACUITY: the reclaim really happened, so "the store has the rows" is
    // a statement about ordering rather than about a directory that survived.
    assert.equal(report.removedRunDir, true, `the run directory was not reclaimed: ${JSON.stringify(report)}`);
    await assert.rejects(() => fs.access(path.join(rundir, 'events.log')));

    const { fuseEventStore } = await import('../src/systems/fuse/plan.ts');
    const store = await fs.readFile(fuseEventStore(), 'utf8');
    // FILTERED ON THIS SESSION'S id, because the store is APPEND-ONLY and
    // shared: every test in this block adds to it, and a length assertion over
    // the whole file would depend on the order they ran in. The instance id
    // column is also what makes a harvested row attributable at all.
    const rows = store.split('\n').filter(Boolean).map(l => l.split('\t'))
      .filter(r => r[1] === record.instanceId);
    assert.equal(rows.length, 6, store);
    // `<iso8601> <instanceId> <kind> <op> <path> <pid> <tgid> <comm> <cmdline>
    //  <list> <entry>`
    const libtinfo = rows.find(r => r[4] === '/lib/x86_64-linux-gnu/libtinfo.so.6');
    assert.ok(libtinfo, store);
    assert.match(libtinfo[0], /^\d{4}-\d\d-\d\dT/);
    assert.equal(libtinfo[1], record.instanceId);
    assert.equal(libtinfo[2], 'deny');
    assert.equal(libtinfo[9], 'LOADER_OBJECTS');
    assert.equal(libtinfo[10], '/usr/lib/x86_64-linux-gnu/libtinfo.so.6');
    // THE ACTING PROCESS SURVIVES THE HARVEST — the whole point of the store is
    // that it outlives the run directory, so an identity the session file had
    // and the store dropped would answer "who asked?" nowhere.
    assert.deepEqual([libtinfo[5], libtinfo[6], libtinfo[7]], ['4243', '4242', 'claude']);
    // …in the DAEMON'S OWN ESCAPED SPELLING, so the store is the session format
    // plus its provenance columns and a tab inside an argv cannot split a line.
    assert.equal(libtinfo[8], 'claude\\0--print');
    // …and the report carries the distinct paths, so a caller need not re-read.
    assert.deepEqual(report.eventPaths, [
      '/lib/x86_64-linux-gnu/libtinfo.so.6', '/etc/machine-id', '/usr/bin/git',
      '/var/opt/thing', '/run/user/1000', '/srv/app/f.txt',
    ]);
  });

  // PINS: THE HARVEST DEDUPES ON `(path, reason, tgid)`, EXACTLY AS THE DAEMON
  // DOES — and the daemon really does write two rows for one path, because two
  // CALLERS can reach it. Observed in real gate runs: `/var` carries
  // `deny`/`unpinned-fail-closed` from the marked CLI and
  // `served`/`unmarked-host-served` from an unmarked one.
  //
  // ONE DIMENSION AT A TIME, which is what makes each half attributable: the
  // two rows below differ in the REASON and in NOTHING ELSE (same path, same
  // tgid), and the tgid half of the key gets its own arm underneath with the
  // reason held fixed. Rows that differed in both would be kept apart by either
  // half and would pin neither.
  //
  // A PATH-ONLY KEY DEFEATS THE LOG'S WHOLE PURPOSE, which is why this is a bug
  // and not a tidiness question: `pinSuggestionFor` fires only on
  // `deny`/`unpinned-fail-closed`, so whenever the `served` row happened to be
  // written first the `deny` row was dropped and **the store carried no pin
  // suggestion for a path the CLI's own denial had asked for**. Nothing said so;
  // the row simply was not there.
  //
  // This departs from "one row per distinct path" deliberately, because the
  // log exists so a pin suggestion reaches a
  // human, and a path-keyed row can silently be the wrong one of the two.
  //
  // DIES UNDER: keying the harvest on the path alone (either row order);
  // keying it on `(kind, path, reason)` would NOT die here and is not claimed —
  // see `b13`'s note on why that mutant is semantics-preserving.
  test('the harvest keeps both reasons for one path, as the daemon does', async () => {
    // BOTH ORDERS, in two sessions, because a path-only key keeps whichever row
    // came FIRST — so one order alone passes against the bug half the time.
    for (const [label, rows] of [
      ['served first', ['served\tgetattr\t/var\tunmarked-host-served\t7\t7\tclaude\tclaude',
                        'deny\tgetattr\t/var\tunpinned-fail-closed\t7\t7\tclaude\tclaude']],
      ['deny first', ['deny\tgetattr\t/var\tunpinned-fail-closed\t7\t7\tclaude\tclaude',
                      'served\tgetattr\t/var\tunmarked-host-served\t7\t7\tclaude\tclaude']],
    ]) {
      // The PARSE, where the dedupe lives.
      const parsed = parsePolicyEvents(rows.join('\n') + '\n');
      assert.deepEqual(parsed.map(r => `${r.kind}/${r.reason}`).sort(),
        ['deny/unpinned-fail-closed', 'served/unmarked-host-served'],
        `${label}: the harvest dropped one of the two reasons for /var`);
      // …and a THIRD row repeating a (path, reason) pair is still one row, so
      // this widened the key rather than removing the dedupe.
      const withDup = parsePolicyEvents([...rows, rows[0]].join('\n') + '\n');
      assert.equal(withDup.length, 2, `${label}: the (path, reason, tgid) dedupe is gone`);

      // AND THE CONSEQUENCE, end to end at the store, which is what the bug
      // actually cost: the pin suggestion for /var is present.
      const { rundir, record } = await seedRun();
      await fs.writeFile(path.join(rundir, 'events.log'), rows.join('\n') + '\n');
      const driver = fakeDriver({ procs: {}, nsMounts: [], conns: [] });
      const report = await runTeardown({ rundir, driver, scan: driver.scan, log: { warn() {} } });
      const { fuseEventStore } = await import('../src/systems/fuse/plan.ts');
      const stored = (await fs.readFile(fuseEventStore(), 'utf8')).split('\n').filter(Boolean)
        .map(l => l.split('\t')).filter(r => r[1] === record.instanceId);
      assert.equal(stored.length, 2, `${label}: ${JSON.stringify(stored)}`);
      const deny = stored.find(r => r[2] === 'deny');
      assert.ok(deny, `${label}: the deny row for /var never reached the store`);
      assert.deepEqual([deny[9], deny[10]], ['UNDECIDED', '/var'],
        `${label}: the deny row reached the store with no pin suggestion`);
      // The served row is still there and still carries none.
      const served = stored.find(r => r[2] === 'served');
      assert.deepEqual([served[9], served[10]], ['', ''], label);
      // `eventPaths` stays a DISTINCT-PATH list — it is a path list, and its one
      // consumer (the boot sweep) asks only whether it is empty.
      assert.deepEqual(report.eventPaths, ['/var'], label);
      // And the sentence names the repair, which is the half the bug removed.
      assert.match(report.notes.find(n => n.startsWith('cc-fuse: ')) ?? '',
        /no array in src\/systems\/fuse\/tierTable\.ts obviously owns \/var/, label);
    }
  });

  // PINS: THE OTHER HALF OF THE SAME KEY — the TGID — with the reason and the
  // path held FIXED, so only the caller distinguishes the two rows. The
  // daemon's key carries this half and the harvest has to follow: at
  // `(path, reason)` the first caller to reach a path wins the row
  // and every later one is silently dropped, which would make the identity
  // columns answer "who asked?" with "whoever happened to be first".
  // DIES UNDER: dropping the tgid from the parse key (the second caller's row
  // vanishes); dropping the dedupe entirely (the repeat below survives).
  test('the harvest keeps one path+reason from two callers as two rows', () => {
    const R = (tgid, comm) => `deny\tgetattr\t/var\tunpinned-fail-closed\t${tgid}\t${tgid}\t${comm}\t${comm}`;
    const two = parsePolicyEvents([R(7, 'claude'), R(9, 'sh')].join('\n') + '\n');
    assert.deepEqual(two.map(r => [r.tgid, r.comm.value]), [[7, 'claude'], [9, 'sh']],
      'a second thread group at the same (path, reason) was dropped');
    // …and it is still a DEDUPE: the same caller repeating is one row, so this
    // widened the key rather than removing it.
    const dup = parsePolicyEvents([R(7, 'claude'), R(7, 'claude'), R(9, 'sh')].join('\n') + '\n');
    assert.equal(dup.length, 2, JSON.stringify(dup.map(r => r.tgid)));
    // THE PID IS NOT IN THE KEY, and that is deliberate: one thread group
    // reaching a path from two of its THREADS is one finding, not two.
    const threads = parsePolicyEvents([
      'deny\tgetattr\t/var\tunpinned-fail-closed\t71\t7\tclaude\tclaude',
      'deny\tgetattr\t/var\tunpinned-fail-closed\t72\t7\tclaude\tclaude',
    ].join('\n') + '\n');
    assert.equal(threads.length, 1, JSON.stringify(threads.map(r => r.pid)));
  });

  // PINS: A NON-UTF-8 BYTE SURVIVES THE HARVEST UNCHANGED. `policy_escape`
  // passes `0x80-0xff` through VERBATIM — deliberately, so a UTF-8 path stays
  // readable — which means the session log is a BYTE file and not necessarily
  // valid UTF-8: a latin-1 filename or a binary argument puts a lone high byte
  // in it. Reading it as `utf8` replaces that byte with U+FFFD before
  // `pathRaw`/`comm.raw`/`cmdline.raw` are formed, so the store — the artifact
  // that outlives the session — carries corrupted evidence.
  // DIES UNDER: reading the session log as `utf8`; writing the store body as a
  // string (`appendFile` re-encodes latin1 code units as two UTF-8 bytes).
  test('the harvest carries a non-UTF-8 byte into the store unchanged', async () => {
    const { rundir, record } = await seedRun();
    // 0xff is not valid UTF-8 in ANY position, so a utf8 read cannot preserve it.
    const P = '/lat\xff1/\xfe.so';
    const bytes = Buffer.from(
      `deny\tgetattr\t${P}\tunpinned-fail-closed\t7\t7\tsh\t/bin/sh\\0-c\\0\xff\n`, 'latin1');
    await fs.writeFile(path.join(rundir, 'events.log'), bytes);
    const driver = fakeDriver({ procs: {}, nsMounts: [], conns: [] });
    await runTeardown({ rundir, driver, scan: driver.scan, log: { warn() {} } });
    const { fuseEventStore } = await import('../src/systems/fuse/plan.ts');
    // READ AS BYTES, or this assertion could not see the corruption it is for.
    const stored = await fs.readFile(fuseEventStore(), 'latin1');
    const row = stored.split('\n').filter(Boolean).map(l => l.split('\t'))
      .find(r => r[1] === record.instanceId);
    assert.ok(row, `nothing was harvested: ${stored.slice(-400)}`);
    const hex = (v) => Buffer.from(v, 'latin1').toString('hex');
    assert.equal(hex(row[4]), hex(P), 'the path column lost the high byte');
    assert.equal(hex(row[8]), hex('/bin/sh\\0-c\\0\xff'), 'the cmdline column lost it');
    // NON-VACUITY: 0xff really is in the fixture and really is not valid UTF-8,
    // so `Buffer.from(bytes).toString('utf8')` would have mangled it.
    assert.ok(bytes.includes(0xff), 'the fixture has no high byte to lose');
    assert.notEqual(bytes.toString('utf8').indexOf('�'), -1,
      'the fixture is valid UTF-8, so a utf8 read would not have corrupted it');
  });

  // PINS: a pin is suggested for `deny`/`unpinned-fail-closed` AND FOR NOTHING
  // ELSE. A `served` row's path already came from the host and a
  // project-tier denial is not a pin-list gap, so suggesting a pin for either
  // sends the reader to change the wrong thing.
  // DIES UNDER: dropping the REASON test — `/srv/app/f.txt` is a `deny` row, so
  // it would gain suggestion columns the assertions below require to be empty.
  //
  // NOT `dropping the kind test`, and I claimed it for a round before checking.
  // `pinSuggestionFor`'s kind test is REDUNDANT GIVEN THE INVARIANT: every
  // reason maps to exactly one kind (source-derived, both directions, in
  // tests/fuse-union-policy.test.mjs), and `unpinned-fail-closed` is always
  // `deny` — so no event the daemon can produce has that reason under another
  // kind, and removing the test changes nothing for any input. It stays in the
  // code as a LOCAL contract, so the function's precondition is readable
  // without reaching across files for the invariant; it is not mutation-pinned
  // and is not claimed to be. Same shape as `b13`'s dedupe-key entry.
  test('a pin is suggested only for a deny/unpinned-fail-closed row', async () => {
    const { rundir, record } = await seedRun();
    await fs.writeFile(path.join(rundir, 'events.log'), EVENTS);
    const driver = fakeDriver({ procs: {}, nsMounts: [], conns: [] });
    await runTeardown({ rundir, driver, scan: driver.scan, log: { warn() {} } });
    const { fuseEventStore } = await import('../src/systems/fuse/plan.ts');
    const rows = (await fs.readFile(fuseEventStore(), 'utf8')).split('\n').filter(Boolean)
      .map(l => l.split('\t'))
      .filter(r => r[1] === record.instanceId
        && (r[4] === '/run/user/1000' || r[4] === '/srv/app/f.txt'));
    assert.equal(rows.length, 2, JSON.stringify(rows));
    for (const r of rows)
      assert.deepEqual([r[9], r[10]], ['', ''],
        `${r[2]}/${r[3]} at ${r[4]} was given a pin suggestion, which points at the wrong repair`);
    // And the SENTENCE keeps the same split: the served row appears, without a
    // pin instruction attached to it.
    const line = describePolicyEvents(parsePolicyEvents(EVENTS), '/store/events.log');
    assert.match(line, /no pin needed — the op succeeded/);
    assert.match(line, /unmarked-host-served \/run\/user\/1000/);
    assert.doesNotMatch(line, /add \/run\/user\/1000/);
  });

  // PINS: the emitted line NAMES PATHS. The failure it replaces was a real gate
  // report of `unpinned-fail-closed: 60` where the 60 were ONE missing library —
  // a count named nothing anybody could act on.
  // DIES UNDER: reporting a tally instead of the paths; dropping the store path.
  test('the emitted line names paths and the store file, never a bare count', () => {
    const line = describePolicyEvents(parsePolicyEvents(EVENTS), '/store/events.log');
    assert.match(line, /\/lib\/x86_64-linux-gnu\/libtinfo\.so\.6/);
    assert.match(line, /add \/usr\/lib\/x86_64-linux-gnu\/libtinfo\.so\.6.*to LOADER_OBJECTS in src\/systems\/fuse\/tierTable\.ts and restart cc/);
    assert.match(line, /add \/etc\/machine-id to ETC_PINS/);
    assert.match(line, /full event log at \/store\/events\.log/);
    // Nothing at all is not a line, so a clean session emits nothing.
    assert.equal(describePolicyEvents([], '/store/events.log'), null);
  });

  // PINS: THE `#` HEADER LINE IS SKIPPED, and the field test is not what skips
  // it. The header CONTAINS TABS, so it splits into eight truthy-looking fields
  // and would parse as a row whose "path" is `# cc-union events v2` — carried
  // into `eventPaths`, into the operator sentence and into the store.
  // DIES UNDER: dropping the `startsWith('#')` guard; moving it after the
  // eight-field test (which the header passes).
  test('the parser skips the daemon’s header line', () => {
    const rows = parsePolicyEvents(EVENTS);
    assert.equal(rows.length, 6, JSON.stringify(rows.map(r => r.path)));
    assert.deepEqual(rows.filter(r => r.path.startsWith('#')), []);
    // NON-VACUITY: the header really is in the fixture and really does have
    // eight tab-separated fields, so the guard has something to do.
    assert.ok(EVENTS.startsWith('# cc-union events v2\t'), EVENTS.slice(0, 40));
    assert.ok(EVENT_HEADER.split('\t').length >= 8, EVENT_HEADER);
  });

  // PINS: THE DENIAL SENTENCE NAMES THE ACTING PROCESS as `comm[pid]`, which is
  // the whole of the sentence's point — `deny getattr
  // /bin unpinned-fail-closed` could not tell the bootstrap shell dying at
  // `exec` from a hook subprocess poking around. The PID is the calling thread's,
  // which is what the trace can be joined on.
  // DIES UNDER: dropping the identity from the sentence; printing the cmdline
  // instead (unbounded — the 20-row cap exists to bound this line); printing a
  // recorded absence as a plausible name rather than as its status.
  test('the denial sentence names the acting process, and an absence as an absence', () => {
    const line = describePolicyEvents(parsePolicyEvents(EVENTS), '/store/events.log');
    assert.match(line, /\/lib\/x86_64-linux-gnu\/libtinfo\.so\.6 \(claude\[4243\]\)/, line);
    assert.match(line, /\/usr\/bin\/git \(claude\[4242\]\)/, line);
    // A `\!gone` comm prints its STATUS. Nothing in the sentence may look like
    // a process name the reader could go hunting for.
    assert.match(line, /\/srv\/app\/f\.txt \(gone\[5100\]\)/, line);
    assert.doesNotMatch(line, /\\!gone/, line);
    // AND NOT THE CMDLINE, which is unbounded and is one grep away in the file
    // the sentence already names.
    assert.doesNotMatch(line, /--print/, line);
  });

  // PINS: THE OPERATOR SENTENCE RENDERS ITS BYTE FIELDS AS TEXT. A row's
  // strings are BYTES (`parsePolicyEvents`' input contract), and this sentence
  // is the one place a human reads them — so `describePolicyEvents` reinterprets
  // each one latin1→UTF-8 on the way out. Every other fixture in this file is
  // pure ASCII, where that reinterpretation and the identity coincide, so
  // nothing else can see it.
  //
  // ALL THREE CALL SITES, one per clause of the sentence: the refusal list, the
  // pin instruction (whose entry `suggestPin` derives from the byte path) and
  // the served list.
  // DIES UNDER: dropping `asText`; applying it to the assembled sentence
  // instead of per field (which would corrupt a `storePath` holding characters
  // past U+00FF).
  test('the operator sentence renders a UTF-8 path and comm as text, not as bytes', () => {
    // LATIN-1 CODE UNITS, exactly what a `latin1` read of the daemon's log
    // yields: `\xc2\xb5` are the two bytes of `µ` and `\xc3\xa9` of `é`.
    const HI = [
      'deny\tgetattr\t/lib/x86_64-linux-gnu/lib\xc2\xb5.so\tunpinned-fail-closed\t7\t7\tcaf\xc3\xa9\tcaf\xc3\xa9',
      'served\tgetattr\t/run/\xc2\xb5s\tunmarked-host-served\t9\t9\tsh\t/bin/sh',
    ].join('\n') + '\n';
    const line = describePolicyEvents(parsePolicyEvents(HI), '/store/events.log');
    assert.ok(line.includes('the daemon refused: /lib/x86_64-linux-gnu/libµ.so (café[7])'),
      `the refusal clause did not render as text: ${line}`);
    assert.ok(line.includes('add /usr/lib/x86_64-linux-gnu/libµ.so to LOADER_OBJECTS'),
      `the pin instruction did not render as text: ${line}`);
    assert.ok(line.includes('unmarked-host-served /run/µs'),
      `the served clause did not render as text: ${line}`);
    // THE MOJIBAKE TELL, asserted separately: leaving the bytes uninterpreted
    // prints the lead byte of each sequence as its own latin-1 character.
    assert.doesNotMatch(line, /[ÂÃ]/, `the sentence carries un-decoded bytes: ${line}`);
    // NON-VACUITY: the fixture really is multi-byte, so the two renderings
    // really do differ.
    assert.notEqual('/lib/x86_64-linux-gnu/lib\xc2\xb5.so', '/lib/x86_64-linux-gnu/libµ.so');
  });

  // PINS: the inline list is CAPPED at 20 ROWS and then says how many more and
  // where they are. Bounded output was the owner's requirement; a truncation
  // that did not say it truncated would be the same defect as a count.
  //
  // ROWS, NOT PATHS — the harvest key is `(path, reason, tgid)`, so a path
  // carrying two deny reasons, or one reason from two thread groups, occupies
  // two slots. This fixture gives each row its own
  // path, so the two units coincide here and the assertion reads either way;
  // the wording says rows because that is what the code counts.
  // DIES UNDER: removing the cap; dropping the `+K more` clause.
  test('the line caps the inline rows at 20 and says where the rest are', () => {
    const many = Array.from({ length: 31 }, (_, i) => `deny\tgetattr\t/etc/p${i}\tunpinned-fail-closed\t7\t7\tclaude\tclaude`).join('\n');
    const line = describePolicyEvents(parsePolicyEvents(many), '/store/events.log');
    const named = [...line.matchAll(/\/etc\/p(\d+)/g)].map(m => Number(m[1]));
    // Each of the 20 appears twice — once in the refused list, once in the
    // ETC_PINS instruction — and no 21st appears at all.
    assert.deepEqual([...new Set(named)].sort((a, b) => a - b), Array.from({ length: 20 }, (_, i) => i));
    assert.match(line, /\(\+11 more; full list at \/store\/events\.log\)/);
  });

  // PINS: `_awaitFuseMount` reads the event log BEFORE `fuse.teardown()`, which
  // deletes it. Without that read a spawn that died of a missing pin carries
  // stderr alone, and stderr says "cannot open shared object file" without
  // saying which array to add the object to.
  // DIES UNDER: moving the read after the teardown; dropping the interpolation.
  test('a failed mount names the refused paths and the array to add them to', async () => {
    const rundir = await mkdtemp('cc-fuse-awaitmount-');
    const log = path.join(rundir, 'events.log');
    await fs.writeFile(log, 'deny\tgetattr\t/lib/x86_64-linux-gnu/libtinfo.so.6\tunpinned-fail-closed\t7\t7\tclaude\tclaude\n');
    let tornDown = false;
    const self = {
      id: 'inst-await', proc: null, _stderr: '  libtinfo.so.6: cannot open shared object file  ',
      _fuse: {
        plan: { rundir },
        awaitHandshake: async () => null,
        // THE TEARDOWN REALLY DESTROYS IT, which is what makes the ordering
        // claim falsifiable rather than a comment: read after this and the
        // message carries nothing.
        teardown: async () => { tornDown = true; await fs.rm(log, { force: true }); },
      },
    };
    await assert.rejects(() => Instance.prototype._awaitFuseMount.call(self), (e) => {
      assert.equal(e.code, 'FUSE_MOUNT_FAILED');
      assert.match(e.message, /libtinfo\.so\.6: cannot open shared object file/, 'stderr was dropped');
      assert.match(e.message, /the daemon refused: \/lib\/x86_64-linux-gnu\/libtinfo\.so\.6/, e.message);
      assert.match(e.message, /add \/usr\/lib\/x86_64-linux-gnu\/libtinfo\.so\.6 to LOADER_OBJECTS/, e.message);
      return true;
    });
    assert.equal(tornDown, true, 'the half-built session was not torn down');
  });

  // PINS: `_awaitFuseMount` READS THE EVENT LOG AS BYTES. It is the third
  // reader of a file `policy_escape` passes `0x80-0xff` through verbatim, and
  // the only one whose fixture was pure ASCII — so the byte-file contract went
  // unobserved here even though `harvestEvents`' copy of it is pinned.
  //
  // THE PATH CROSSES BOTH LAYERS, which is why the assertion is on the rendered
  // message: a `utf8` read decodes `\xc2\xb5` to `µ` too early, and
  // `describePolicyEvents`' latin1→UTF-8 reinterpretation then turns that single
  // code unit into U+FFFD. Correct is `µ`; the mutant loses the character
  // entirely rather than merely mis-spelling it.
  // DIES UNDER: reading the log as `utf8` here.
  test('a failed mount renders a UTF-8 path from the byte log, not a replacement char', async () => {
    const rundir = await mkdtemp('cc-fuse-awaitmount-hi-');
    const log = path.join(rundir, 'events.log');
    // WRITTEN AS BYTES, or the fixture could not carry the shape it is for.
    await fs.writeFile(log, Buffer.from(
      'deny\tgetattr\t/lib/x86_64-linux-gnu/lib\xc2\xb5.so\tunpinned-fail-closed\t7\t7\tsh\t/bin/sh\n',
      'latin1'));
    const self = {
      id: 'inst-await-hi', proc: null, _stderr: 'libµ.so: cannot open shared object file',
      _fuse: {
        plan: { rundir },
        awaitHandshake: async () => null,
        teardown: async () => { await fs.rm(log, { force: true }); },
      },
    };
    await assert.rejects(() => Instance.prototype._awaitFuseMount.call(self), (e) => {
      assert.match(e.message, /the daemon refused: \/lib\/x86_64-linux-gnu\/libµ\.so/, e.message);
      assert.doesNotMatch(e.message, /�/,
        `a byte was lost between the read and the sentence: ${e.message}`);
      assert.doesNotMatch(e.message, /[ÂÃ]/, e.message);
      return true;
    });
  });
});

describe('the mount literals', () => {
  // A16 — PINS the sha pin as a DELIBERATE-EDIT LATCH. Editing a build source
  // without regenerating the pin in the same commit is the undisclosed drift
  // this catches. Needs no compiler, so it runs everywhere — and it iterates
  // the pin file's ROWS rather than naming one source, so it covers every
  // source the pin file names: `union.c` and `policy.h` today, and any source
  // a later row adds.
  test('A16: union.c.sha256 matches the source it pins', async () => {
    const { createHash } = await import('node:crypto');
    const dir = path.join(path.dirname(new URL(import.meta.url).pathname), '..', 'src', 'systems', 'fuse');
    const pinned = await fs.readFile(path.join(dir, 'union.c.sha256'), 'utf8');
    const rows = pinned.split('\n').filter(Boolean).map(l => l.trim().split(/\s+/));
    // THE ROW COUNT AND BOTH NAMES ARE ASSERTIONS, not a regenerated file. The
    // loop below is source-agnostic, so it covers any source the pin file names
    // — but only the ones it names. Adding a source to the build address (A19)
    // and forgetting its pin row would otherwise pass this test silently, and
    // the latch would be guarding half of what it claims.
    assert.equal(rows.length, 2, `the pin file must carry one row per build source, got ${rows.length}`);
    assert.deepEqual(rows.map(r => r[1]).sort(), ['policy.h', 'union.c']);
    for (const [want, name] of rows) {
      const buf = await fs.readFile(path.join(dir, name));
      assert.equal(createHash('sha256').update(buf).digest('hex'), want,
        `${name} changed without its sha256 pin being regenerated`);
    }
  });

  // A16b — PINS THE DAEMON'S THREE MOUNT PRECONDITIONS FROM THE SOURCE, beside
  // A16 and for A16's reason: `main()` is not reachable from the POLICY FIXTURE
  // (it needs libfuse, a real socket and a real mount).
  //
  // THE GREP IS NOT THE ENFORCEMENT, and this file is no longer the only layer
  // that can reach these refusals: `tests/fuse-daemon-preconditions.test.mjs`
  // execs the REAL COMPILED DAEMON, which reaches every env refusal in `main()`
  // — they all fire before `pthread_key_create`, `control_connect` and
  // `fuse_main`. This test remains the one that runs without a toolchain.
  //
  // `CC_UNION_CWD` HAS NO DEFAULT, AND THAT ABSENCE IS THE POINT. The chain is
  // the whole domain of the floor and of the overlay, so a missing cwd means no
  // floor, no overlay node, and every unmarked chdir dead at its destination —
  // while looking exactly like a working mount. A default would be worse than
  // the refusal.
  test('A16b: the daemon refuses to mount without the mark path, the control socket or the cwd — and refuses a mark path or cwd it cannot match', async () => {
    const { readFile } = await import('node:fs/promises');
    const dir = path.join(path.dirname(new URL(import.meta.url).pathname), '..', 'src', 'systems', 'fuse');
    const src = await readFile(path.join(dir, 'union.c'), 'utf8');
    for (const v of ['CC_UNION_MARK_PATH', 'CC_UNION_CONTROL', 'CC_UNION_CWD']) {
      assert.match(src, new RegExp(`REFUSED — ${v} is required`),
        `union.c no longer refuses to mount without ${v}`);
    }
    // AND THE CWD IS VALIDATED, NOT ONLY PRESENT — because the failure a
    // non-normalised spelling produces is diagnosable only from inside the
    // chroot. A '//' or a '.'/'..' component matches the INTERMEDIATE
    // components and then fails on the cwd ITSELF, so without this the daemon
    // mounts and the chdir walks the whole chain and dies at its destination. A
    // trailing slash matches every component and is refused on ownership of the
    // input rather than on a broken comparison. `b28` pins both halves; the
    // mount refusal below is what replaces the far-away failure with a named
    // one.
    assert.match(src, /if \(!policy_cwd_normalised\(cwd_path\)\) \{/,
      'union.c no longer validates CC_UNION_CWD at mount time');
    // NO DEFAULT, asserted as the absence of one: `?:` is how union.c spells a
    // default (CC_UNION_HOST_ROOT has one), so a `getenv("CC_UNION_CWD") ?: …`
    // would read as a working mount that silently un-exempts the project root.
    assert.match(src, /cwd_path\s*= getenv\("CC_UNION_CWD"\);/,
      'CC_UNION_CWD is read with a default, or not read into cwd_path at all');
    // AND THE MARK PATH THE SAME WAY, for the reason PRESENCE cannot cover:
    // `getenv` answers a non-NULL "" for a variable exported empty, so the NULL
    // test above passes it and `mark_maybe`'s strcmp then matches no routed
    // path — the mount comes up and marks nobody. The daemon-preconditions file
    // drives both halves through the real binary.
    assert.match(src, /if \(!policy_cwd_normalised\(mark_path\)\) \{/,
      'union.c no longer validates CC_UNION_MARK_PATH at mount time');
    assert.match(src, /mark_path\s*= getenv\("CC_UNION_MARK_PATH"\);/,
      'CC_UNION_MARK_PATH is read with a default, or not read into mark_path at all');
  });

  // 2c — THE BOOTSTRAP FIRES NO MARKING EVENT, PINNED AT THE LAYER THAT
  // ENFORCES IT.
  //
  // THE INVARIANT: the thread group that becomes the CLI reaches the union
  // UNMARKED for the whole of `bootstrap.sh`'s chroot script and for setpriv
  // and the backend launch command it execs. The marking event is the CLI's own
  // `execve` of `$CC_UNION_MARK_PATH` and nothing earlier, so the shell, setpriv
  // and the launcher resolve in `VIEW_HOST` — against the orchestrator, which is
  // the machine they belong to. A mark statement anywhere in this script puts
  // every one of them in `VIEW_CLI`, where a wide `mirrorRoot` puts each of
  // their unpinned paths in the remote tier with no host fallback.
  //
  // THE ENFORCING LAYER FOR A SHELL SCRIPT'S STATEMENT ORDER IS THE SCRIPT
  // TEXT, so this is a source-text test and needs no sudo and no mount. It runs
  // in plain `npm test`, which is where a re-added mark would otherwise go
  // unnoticed until the real gate.
  //
  // THE `cd` IS NOT WHAT NEEDED THE MARK. Each component of the CLI's cwd is
  // traversable to an unmarked caller — `policy_cwd_component` plus
  // `resolve_class`'s `VIEW_HOST` overlay clause (policy.h), driven by
  // `b-cwd-unmarked` in tests/fuse-union-policy.test.mjs.
  //
  // DIES UNDER: re-adding any statement above the `cd`; a mark path reaching the
  // script body at all; a positional-argument drift that makes `$2` something
  // other than the cwd.
  test('2c: bootstrap.sh fires NO marking event — the cd is the first chroot statement', async () => {
    const { readFile } = await import('node:fs/promises');
    const { fileURLToPath } = await import('node:url');
    const src = await readFile(
      path.join(path.dirname(fileURLToPath(import.meta.url)), '..', 'src', 'systems', 'fuse', 'bootstrap.sh'), 'utf8');
    // The single-quoted script body of the final `exec "$CHROOT_BIN" … /bin/sh -c '…'`.
    const at = src.indexOf('exec "$CHROOT_BIN" "$CC_FUSE_ROOT" /bin/sh -c \'');
    assert.ok(at > 0, 'the final chroot exec is not the shape this test pins — re-anchor or repair');
    const open = src.indexOf("'", at);
    const close = src.indexOf("'", open + 1);
    assert.ok(close > open, 'the chroot script body is unterminated');
    const body = src.slice(open + 1, close);
    // Statements only: comments, blank lines and the leading indentation go.
    const stmts = body.split('\n').map(l => l.trim()).filter(l => l && !l.startsWith('#'));
    assert.ok(stmts.length >= 4, `the chroot script body was not parsed: ${JSON.stringify(stmts)}`);
    // 1. NO MARK PATH REACHES THE SCRIPT AT ALL — neither as a positional
    //    argument nor by name. Asserted over the WHOLE body, comments included,
    //    because a re-added stat is the mutant this exists to catch and a
    //    commented-out one is a re-add waiting to happen.
    assert.ok(!/\$\{?5\b/.test(body) && !body.includes('CC_FUSE_MARK_PATH'),
      'the chroot script references a fifth positional argument or the mark path — the marking '
      + 'event is the CLI\'s own execve and nothing in the bootstrap may pre-fire it: '
      + JSON.stringify(body));
    // 2. THE cd IS THE FIRST STATEMENT. Anything above it is one more unmarked
    //    op on the pid that becomes the CLI — harmless today, but the slot a
    //    re-added mark would occupy.
    assert.ok(stmts[0].startsWith('cd "$2"'),
      `the cd is not the FIRST statement of the chroot script: ${JSON.stringify(stmts)}`);
    // 3. AND THE SHIFT MATCHES THE ARGUMENT COUNT. `shift 5` against four
    //    leading arguments silently eats the CLI's own argv[0].
    assert.ok(stmts.includes('shift 4'),
      `the chroot script no longer shifts exactly its four leading arguments: ${JSON.stringify(stmts)}`);
    // 4. THE POSITIONAL ARGUMENTS, EXACTLY — the argument list is what makes
    //    `"$2"` mean the cwd, and a reordering there would still pass (2).
    const argv = src.slice(close + 1).split('\n')[0];
    assert.match(argv, /^ sh "\$SETPRIV_BIN" "\$CC_FUSE_CWD" "\$CC_FUSE_UID" "\$CC_FUSE_GID" "\$@"$/,
      `the chroot script's positional arguments changed, so "$2" is no longer the cwd: ${argv}`);
  });

  // 2c-bis — THE MARK PATH STILL REACHES THE DAEMON, AND IT IS STILL THE CLI
  // LAUNCHER.
  //
  // 2c removed the SHELL's positional copy of the mark path. The DAEMON's copy
  // is a different channel — `CC_FUSE_MARK_PATH` in the worker env, which step 4
  // renames to `CC_UNION_MARK_PATH` on the daemon's own command line, and
  // without which `union.c` refuses to mount. Removing the shell's copy must not
  // take the daemon's with it: that mutant leaves 2c green, `wrapLaunch`'s env
  // test green, and every spawn marking NOBODY — a silently host-only
  // filesystem, which is exactly what the daemon's presence refusal exists to
  // prevent.
  //
  // AND THE VALUE IS THE CLI LAUNCH COMMAND, at the one place it is constructed.
  // That is the standing condition the whole two-view argument rests on: point
  // the mark at a widely-used binary and every process loading it becomes
  // marked, at which point an unmarked caller's `fail → host` is the wrong
  // answer for a caller that CAN reach the remote.
  //
  // DIES UNDER: dropping `CC_UNION_MARK_PATH` from the daemon's environment;
  // pointing `markPath` at anything but the resolved launch command.
  test('2c-bis: the mark path still reaches the daemon, and is still the CLI launcher', async () => {
    const { readFile } = await import('node:fs/promises');
    const { fileURLToPath } = await import('node:url');
    const here = path.dirname(fileURLToPath(import.meta.url));
    const boot = await readFile(path.join(here, '..', 'src', 'systems', 'fuse', 'bootstrap.sh'), 'utf8');
    assert.match(boot, /^CC_UNION_MARK_PATH="\$CC_FUSE_MARK_PATH" \\$/m,
      'bootstrap.sh no longer hands the daemon CC_UNION_MARK_PATH — the mount refuses, or mounts '
      + 'and marks nobody');
    const inst = await readFile(path.join(here, '..', 'src', 'instances.ts'), 'utf8');
    assert.match(inst, /markPath: claudeCommand,/,
      'the single buildFusePlan construction site no longer points markPath at the resolved CLI '
      + 'launch command');
  });

  // A17 — PINS the mount options as LITERALS. Every one is load-bearing and
  // none is observable without a real mount: the daemon runs as root and serves
  // callers of another uid (`allow_other` + `default_permissions`), and FUSE's
  // attribute cache is per-inode rather than per-caller, so a non-zero timeout
  // measurably answered one path 15 bytes to `stat` and 33 to `cat` across the
  // routing boundary.
  test('A17: MOUNT_OPTS carries allow_other, default_permissions and three zero timeouts', async () => {
    const { MOUNT_OPTS } = await import('../src/systems/fuse/plan.ts');
    const opts = MOUNT_OPTS.split(',');
    for (const want of ['allow_other', 'default_permissions',
      'attr_timeout=0', 'entry_timeout=0', 'negative_timeout=0']) {
      assert.ok(opts.includes(want), `${want} missing from ${MOUNT_OPTS}`);
    }
  });

  // A18 — PINS criterion 9's geometry: the per-session mirror is OUTSIDE the
  // chroot and has no spelling inside it THROUGH THE UNION. `rundir` is tiered
  // `hide`, so the union answers -ENOENT for its own backing store; moving
  // `mirror` under `root` would put the remote tier's backing store inside the
  // tree it backs.
  //
  // THE SCOPE IS THE CONJUNCTION'S SECOND HALF, and it is the whole of the
  // correction: "outside the chroot" is true unconditionally, "no spelling
  // inside it" only of paths resolved through the mount. The bind-mounted
  // /proc supplies another spelling — `/proc/<ccpid>/root/<rundir>/mirror` —
  // which resolves today. See the comment on the pins-file assertion below.
  test('A18: the mirror is under rundir, not under root, and rundir is hidden', async () => {
    const { buildFusePlan, fuseRunDir } = await import('../src/systems/fuse/plan.ts');
    const plan = buildFusePlan({
      instanceId: 'inst-a18', cwdInside: '/srv/app',
      sourceOverrideRoot: null, markPath: '/usr/bin/claude',
      tiers: buildTierTable(tierFixtureInput({ runDir: fuseRunDir('inst-a18') })),
    });
    assert.equal(path.dirname(plan.mirror), plan.rundir);
    assert.equal(path.dirname(plan.root), plan.rundir);
    assert.equal(plan.mirror.startsWith(plan.root + path.sep), false, 'the mirror is inside the chroot');
    assert.equal(plan.tiers.find(e => e.prefix === plan.rundir)?.tier, 'hide');
    // And nothing inside the chroot can name it THROUGH THE UNION — which is
    // exactly what this asserts and all it asserts: the pins file's only
    // mention of the run directory is the `hide` rule itself. It says nothing
    // about the bind-mounted /proc, which reaches it.
    const named = plan.pinsText.split('\n').filter(l => !l.startsWith('#') && l.includes(plan.rundir));
    assert.deepEqual(named, [`hide\t${plan.rundir}`]);
  });
});

describe('the criterion-9 refusal', () => {
  const ok = {
    devFuseIsCharDevice: async () => true,
    sudoNonInteractive: async () => true,
    sudoPreservesEnv: async () => true,
    hasBinary: async () => true,
    hasFusectl: async () => true,
    hasFuse3Dev: async () => true,
    ensureBinary: async () => '/store/bin/union',
  };

  test('passes when every probe answers', async () => {
    await assertFuseAvailable({ ...ok });
  });

  // PINS: each of the six probes, stubbed absent one at a time, produces a
  // FUSE_UNAVAILABLE naming what is missing. The message is the deliverable —
  // criterion 9 is "refuses with a message naming the reason", not "refuses".
  const cases = [
    ['devFuseIsCharDevice', /\/dev\/fuse/, { devFuseIsCharDevice: async () => false }],
    ['sudo', /sudo -n true/, { sudoNonInteractive: async () => false }],
    // The host that passes every other probe and then dies inside sudo:
    // NOPASSWD without SETENV. Probed by the exact form the launch uses,
    // because the whole mount plan rides in CC_FUSE_* environment variables.
    ['sudo without SETENV', /sudo -n -E.*SETENV/s, { sudoPreservesEnv: async () => false }],
    ['a binary', /unshare/, { hasBinary: async (n) => n !== 'unshare' }],
    ['fusectl', /fusectl/, { hasFusectl: async () => false }],
    ['gcc', /gcc/, { hasBinary: async (n) => n !== 'gcc' }],
    ['libfuse3-dev', /libfuse3-dev/, { hasFuse3Dev: async () => false }],
    ['the compile', /gcc said/, { ensureBinary: async () => { throw Object.assign(new Error('FUSE_UNAVAILABLE: could not compile. gcc said: boom'), { statusCode: 501, code: 'FUSE_UNAVAILABLE' }); } }],
  ];
  for (const [label, re, override] of cases) {
    test(`names ${label} when it is missing`, async () => {
      await assert.rejects(() => assertFuseAvailable({ ...ok, ...override }), (e) => {
        assert.equal(e.code, 'FUSE_UNAVAILABLE');
        assert.equal(e.statusCode, 501);
        assert.match(e.message, re);
        return true;
      });
    });
  }

  // PINS: order. The message a host gets is the ROOT cause, not a downstream
  // symptom — with everything missing it still names /dev/fuse first.
  test('names the FIRST failure when several are missing', async () => {
    await assert.rejects(() => assertFuseAvailable({
      devFuseIsCharDevice: async () => false, sudoNonInteractive: async () => false,
      sudoPreservesEnv: async () => false,
      hasBinary: async () => false, hasFusectl: async () => false, hasFuse3Dev: async () => false,
      ensureBinary: async () => { throw new Error('never reached'); },
    }), /\/dev\/fuse/);
  });

  // PINS: the required-binary list is the bootstrap chain's, not a subset.
  test('the required binary list covers the whole bootstrap chain', () => {
    for (const b of ['unshare', 'mount', 'umount', 'nsenter', 'chroot', 'setpriv', 'fusermount3']) {
      assert.ok(REQUIRED_BINARIES.includes(b), b);
    }
  });
});

describe('the configuration-time containment refusal', () => {
  let prev;
  before(async () => {
    prev = process.env.PROJECTS_ROOT;
    process.env.PROJECTS_ROOT = path.join(await mkdtemp('cc-fuse-proj-'), 'projects');
  });
  after(() => { if (prev === undefined) delete process.env.PROJECTS_ROOT; else process.env.PROJECTS_ROOT = prev; });

  const planArgs = { instanceId: 'inst-x', cwdInside: '/srv/app', markPath: '/usr/bin/claude', tiers: [] };

  // A20 — PINS `FUSE_REMOTE_ROOT_CONTAINS_MIRROR`, in THREE arms, because two
  // of them are each other's control and the third is what makes the `/`
  // exemption exercised rather than merely present.
  //
  // WHAT THE REFUSAL IS FOR: cc materialises a remote path P at `<mirror>/P`
  // and reads it from `<sourceOverrideRoot>/P`. Where the mirror lies inside the
  // source root, some P resolves back into the mirror and cc serves its own
  // staging area to the worker as remote content. IN PRODUCTION THERE IS NO
  // ROOT AT ALL — a path P from the daemon IS the path on the system — so this
  // guards the override, which is what it always guarded.

  // ── THE CWD, AT CONFIGURATION TIME ────────────────────────────────────────
  //
  // PINS: `buildFusePlan` refuses a non-normalised `cwdInside`, with
  // `FUSE_REMOTE_ROOT_CONTAINS_MIRROR` as the precedent for both the placement
  // and the wording.
  //
  // THE DEFECT IT REPLACES. `plan.cwdInside` becomes the daemon's
  // `CC_UNION_CWD`, and `policy_cwd_component` compares it to each candidate
  // byte for byte at a component boundary. A doubled slash — or a `.`/`..`
  // component — matches every INTERMEDIATE component and then fails on the cwd
  // itself, so the chdir walks the whole chain and dies at its destination,
  // which is the hardest shape to diagnose from outside the chroot.
  //
  // NEITHER LAYER NORMALISES, AND BOTH REFUSE. cc owns this input, so any other
  // spelling is a cc defect; and resolving `..` correctly needs the filesystem,
  // because a component may be a symlink. The daemon's own refusal is pinned by
  // A16b; the driver's predicate by `b28`. This is the layer where the failure
  // is legible — the daemon's arrives inside the bootstrap's mount-wait loop.
  //
  // DIES UNDER: deleting the check; accepting a trailing slash; accepting a
  // `..` component; refusing a dotfile-named component (which would refuse a
  // real cwd, `~/.claude/worktrees/x` being the obvious one).
  //
  // AND THE MESSAGE IS PINNED PER SHAPE, WHICH IS WHY THE OLD ASSERTION WAS NOT
  // ENOUGH. `/component by component/` survived BOTH the false sentence
  // ("a non-normalised spelling matches nothing and every chdir fails") and its
  // correction, so restoring the false one passed every arm. The refused class
  // has THREE mechanisms under `policy_cwd_component` and no clause is true of
  // all of them, so the assertions below check the universal GROUND of refusal
  // plus the mechanism for the shape at hand — and, for the trailing slash,
  // that the message does NOT make the refuted claim.
  const CWD_MECHANISM = {
    '/srv/app/':    /still matches every component/,
    '/srv//app':    /match the INTERMEDIATE components and then fail on the cwd ITSELF/,
    '/srv/./app':   /match the INTERMEDIATE components and then fail on the cwd ITSELF/,
    '/srv/../app':  /match the INTERMEDIATE components and then fail on the cwd ITSELF/,
    'srv/app':      /match NO component of any path except '\/'/,
    '':             /match NO component of any path except '\/'/,
  };
  for (const [bad, mechanism] of Object.entries(CWD_MECHANISM)) {
    test(`A20w: buildFusePlan refuses a non-normalised cwd ${JSON.stringify(bad)}`, async () => {
      const { buildFusePlan } = await import('../src/systems/fuse/plan.ts');
      assert.throws(() => buildFusePlan({ ...planArgs, cwdInside: bad, sourceOverrideRoot: null }), (e) => {
        assert.equal(e.code, 'FUSE_CWD_NOT_NORMALISED');
        assert.equal(e.statusCode, 501);
        assert.ok(e.message.includes(bad === '' ? "''" : bad), e.message);
        // THE UNIVERSAL GROUND, and it is what the false sentence never said:
        // cc owns the value, so the repair is at the caller…
        assert.match(e.message, /cc owns this value/, e.message);
        // …and NOT in the daemon, with the reason. An operator who "fixes" a
        // `//` cwd by normalising in the daemon has written the one repair the
        // design forbids, because `..` cannot be resolved through a symlink.
        assert.match(e.message, /Do NOT normalise it in the daemon/, e.message);
        assert.match(e.message, /may be a symlink/, e.message);
        // THE MECHANISM FOR THIS SHAPE, not an umbrella.
        assert.match(e.message, mechanism, e.message);
        return true;
      });
    });
  }

  // PINS THE REFUTED CLAIM AS REFUTED, at the one shape that disproves it. A
  // trailing slash matches EVERY component — `b28` measures it — so any message
  // saying a non-normalised spelling "matches nothing" or that "every chdir
  // fails" is false here.
  //
  // WHICH ROLLBACK REDS WHAT, counted rather than asserted loosely. APPENDING
  // the false clause to the current message reds THIS ARM ALONE, through its
  // two `doesNotMatch` clauses below — the six per-shape arms above carry only
  // positive mechanism regexes, which still match with a false clause added.
  // RESTORING the whole pre-correction message additionally reds those six,
  // since it contains none of their mechanism wording. So this arm is the only
  // thing standing between the codebase and the additive form of the
  // regression, which is the form three rounds of this ticket actually took.
  test('A20w: the trailing-slash refusal does not claim the comparison breaks', async () => {
    const { buildFusePlan } = await import('../src/systems/fuse/plan.ts');
    assert.throws(() => buildFusePlan({ ...planArgs, cwdInside: '/srv/app/', sourceOverrideRoot: null }), (e) => {
      assert.doesNotMatch(e.message, /matches nothing|matches no component/, e.message);
      assert.doesNotMatch(e.message, /every chdir/, e.message);
      // And it says the true thing instead: nothing downstream fails, which is
      // why the refusal rests on ownership of the input.
      assert.match(e.message, /nothing downstream would fail visibly/, e.message);
      return true;
    });
  });

  // THE POSITIVE CONTROL, without which every arm above passes against an
  // unconditional throw — and the dotfile case, which a naive `.`-component
  // test would wrongly refuse.
  for (const good of ['/', '/srv/app', '/root/.claude/worktrees/x', '/srv/..hidden']) {
    test(`A20w: …and accepts the normalised cwd ${JSON.stringify(good)}`, async () => {
      const { buildFusePlan } = await import('../src/systems/fuse/plan.ts');
      assert.equal(buildFusePlan({ ...planArgs, cwdInside: good, sourceOverrideRoot: null }).cwdInside, good);
    });
  }

  // Arm (b). Mutation it must die under: deleting the containment check.
  test('A20b: a non-/ remote root containing the mirror is refused', async () => {
    const { buildFusePlan, fuseRunDir } = await import('../src/systems/fuse/plan.ts');
    const rundir = fuseRunDir('inst-x');
    assert.throws(() => buildFusePlan({ ...planArgs, sourceOverrideRoot: path.dirname(path.dirname(rundir)) }), (e) => {
      assert.equal(e.code, 'FUSE_REMOTE_ROOT_CONTAINS_MIRROR');
      assert.equal(e.statusCode, 501);
      // It names the mirror, not the mountpoint: the mount is not what is at
      // stake any more and a refusal that named it would send a reader looking
      // for a deadlock that cannot happen.
      assert.match(e.message, /staging mirror/);
      assert.ok(e.message.includes(path.join(rundir, 'mirror')), e.message);
      return true;
    });
  });

  // Arm (c). Mutation it must die under: making the refusal unconditional.
  test('A20c: a non-containing remote root is accepted', async () => {
    const { buildFusePlan } = await import('../src/systems/fuse/plan.ts');
    const plan = buildFusePlan({ ...planArgs, sourceOverrideRoot: '/srv/app' });
    assert.equal(plan.sourceOverrideRoot, '/srv/app');
  });

  // Arm (a). THE TWO ACCEPTED ROOTS, and this is the arm that makes the
  // exemptions provable rather than merely present: `/` contains the mirror
  // like it contains everything, and PRODUCTION has no root to compare at all.
  // Without both a mutant collapsing either exemption survives untouched — and
  // every production launch would 501 on the second.
  //
  // Mutation it must die under: `override === null || override === '/' ? null
  // : …` collapsed to the bare containment check, in EITHER clause.
  test('A20a: no override at all, and an override of /, are both accepted', async () => {
    const { buildFusePlan } = await import('../src/systems/fuse/plan.ts');
    // PRODUCTION. `null` is what `src/instances.ts` passes when
    // CC_FUSE_SOURCE_OVERRIDE_ROOT is unset, which is every ordinary spawn.
    const prod = buildFusePlan({ ...planArgs, sourceOverrideRoot: null });
    assert.equal(prod.sourceOverrideRoot, '', 'no override is recorded as no root, not as "/"');
    const root = buildFusePlan({ ...planArgs, sourceOverrideRoot: '/' });
    assert.equal(root.sourceOverrideRoot, '/');
  });

  // PINS the trace's default AT THE CONSUMER: OFF, and therefore costing the
  // daemon nothing. `tr()` resolves ids per op and reads /proc, so an
  // accidentally-on trace is a per-op cost on every production session.
  //
  // THE CONSUMER IS ONLY HALF THE SWITCH, and this arm cannot see the other:
  // it drives `buildFusePlan`, so it is green whatever `wrapLaunch` and
  // bootstrap.sh do with the answer. The producer end — where an inherited
  // value can survive an untraced launch — is pinned in the `wrapLaunch`
  // describe above.
  //
  // Mutation it must die under: making `tracePath` unconditional; inverting the
  // `CC_FUSE_TRACE === '1'` test.
  test('A20t: the daemon trace is off unless CC_FUSE_TRACE=1, and lands in the run dir when on', async () => {
    const { buildFusePlan } = await import('../src/systems/fuse/plan.ts');
    const prev = process.env.CC_FUSE_TRACE;
    try {
      delete process.env.CC_FUSE_TRACE;
      assert.equal(buildFusePlan({ ...planArgs, sourceOverrideRoot: null }).tracePath, '');
      // Not any truthy value — and `'0'` is the case that mattered: cc's
      // switch is exact, but the bootstrap's end tested NON-EMPTINESS, so an
      // operator's `CC_FUSE_TRACE=0` reached the daemon as a trace path named
      // `0`. Fixed by giving the two ends different names; asserted end to end
      // in the `wrapLaunch` describe.
      for (const loose of ['yes', '0', 'true']) {
        process.env.CC_FUSE_TRACE = loose;
        assert.equal(buildFusePlan({ ...planArgs, sourceOverrideRoot: null }).tracePath, '', loose);
      }
      process.env.CC_FUSE_TRACE = '1';
      const on = buildFusePlan({ ...planArgs, sourceOverrideRoot: null });
      assert.equal(on.tracePath, path.join(on.rundir, 'trace.log'));
    } finally {
      if (prev === undefined) delete process.env.CC_FUSE_TRACE;
      else process.env.CC_FUSE_TRACE = prev;
    }
  });

  // AND WHY `/` IS SAFE, as data rather than as prose. At root `/`,
  // `<sourceOverrideRoot>/P` IS P, so cc reads the mirror only for a P at or inside
  // the mirror. Every such P resolves `hide`, and `route()` answers -ENOENT for
  // a `hide` path before any control frame is sent — so no such P ever reaches
  // cc. Asserted at the WIDEST advertised mirror root, `/`, which is the only
  // setting under which the question is live at all.
  //
  // Mutation it must die under: dropping the `hide` pin on `runDir` from
  // buildTierTable — the mirror then resolves `project` under the `/` pin and
  // becomes a path cc would be asked to materialise from itself.
  test('A20: at root /, no path cc could be asked about resolves into the mirror', async () => {
    // THE FIXTURE'S OWN GEOMETRY, not `fuseRunDir()`'s. This describe repoints
    // PROJECTS_ROOT at a temp dir and `projectsRoot()` reads the env per call,
    // so `fuseRunDir()` lands under /tmp while `tierFixtureInput().projectsRoot`
    // stays its constant — and the host-chain loop below then iterated ZERO
    // times and asserted nothing. One geometry, read from one place.
    const input = tierFixtureInput({ mirrorRoot: '/' });
    const runDir = input.runDir;
    const mirror = path.join(runDir, 'mirror');
    const tiers = buildTierTable(input);
    const at = (p) => resolveTierEntry(tiers, p)?.tier ?? 'fail';

    // The mirror, its parent, and anything inside it: hide, so no frame is sent.
    for (const p of [runDir, mirror, path.join(mirror, 'srv'), path.join(mirror, 'srv/app/x.txt'), path.join(mirror, 'etc')]) {
      assert.equal(at(p), 'hide', p);
    }
    // The chain from the projects root down to the run directory is `host`, so
    // no LIST ever names the mirror's parent as a child either. (`/` and the
    // directory holding the projects root DO stay `project` — that is not the
    // hazard: a LIST materialises one level of entries and never descends.)
    //
    // COMPONENT-BOUNDARY containment, not `startsWith`: `/home/wk/cc-projectsX`
    // is not inside `/home/wk/cc-projects`. And the ITERATION COUNT is
    // asserted, so a future repointing cannot silently empty this loop again —
    // which is exactly how it was empty when it landed.
    const inside = (p, root) => p === root || p.startsWith(root + path.sep);
    let checked = 0;
    for (let p = path.dirname(runDir); inside(p, input.projectsRoot); p = path.dirname(p)) {
      assert.equal(at(p), 'host', p);
      checked++;
    }
    assert.equal(checked, 5,
      `the host chain from ${input.projectsRoot} down to ${path.dirname(runDir)} must be walked, got ${checked} steps`);
    assert.equal(at('/'), 'project', 'the widest advertised mirror root is remote-tier');
  });

  // ── THE STORE ROOT'S DEPTH IS NOT A CONFIGURATION ERROR ─────────────────

  // T1 — PINS: no configuration-time length refusal governs the real socket
  // path any more. The second assertion is the NON-VACUITY CONTROL: without it
  // the test passes on a root that was never over the cliff.
  //
  // Dies under any mutant reinstating the `plan.ts` guard.
  test('T1: a store root longer than sun_path plans without refusal', async () => {
    const { buildFusePlan } = await import('../src/systems/fuse/plan.ts');
    const { SUN_PATH_MAX } = await import('../src/systems/fuse/control.ts');
    const { orchStoreRoot } = await import('../src/projects.ts');
    const saved = process.env.PROJECTS_ROOT;
    try {
      process.env.PROJECTS_ROOT = await padPathTo(await mkdtemp('cc-fuse-deep-'), SUN_PATH_MAX + 1);
      assert.ok(Buffer.byteLength(orchStoreRoot()) > SUN_PATH_MAX,
        `the store root is only ${Buffer.byteLength(orchStoreRoot())} bytes — this test is vacuous`);
      const plan = buildFusePlan({ ...planArgs, instanceId: randomUUID(), sourceOverrideRoot: null });
      assert.ok(Buffer.byteLength(plan.controlSock) > SUN_PATH_MAX,
        `the control socket path is only ${Buffer.byteLength(plan.controlSock)} bytes — the cliff was never crossed`);
    } finally {
      if (saved === undefined) delete process.env.PROJECTS_ROOT; else process.env.PROJECTS_ROOT = saved;
    }
  });

  // T2 — PINS: the run directory carries the WHOLE instance id, which is what
  // restores the sweep's "a uuid per process, so anything left is dead"
  // licence. A REAL 36-char uuid is load-bearing: every other fixture in this
  // file uses a short id (`inst-x`, `live-1`, a mkdtemp basename) under which a
  // truncation is invisible.
  //
  // Dies under any `.slice(0, N)` mutant on `fuseRunDirName`.
  test('T2: the run directory is named with the whole uuid', async () => {
    const { fuseRunDirName, fuseRunDir } = await import('../src/systems/fuse/plan.ts');
    const id = randomUUID();
    assert.equal(id.length, 36, 'the fixture must be a real uuid or truncation is invisible');
    assert.equal(fuseRunDirName(id), id);
    assert.equal(path.basename(fuseRunDir(id)), id);
  });

  // T6 — PINS: the diagnostic SURVIVED the mechanism change, is keyed on the
  // FORMED ADDRESS rather than on any path on disk, and carries the corrected
  // advice. The old message told the operator to move the store root; that is
  // now false, and a message that still said it would send them at a lever
  // that changes nothing.
  //
  // Dies under: deleting the check; checking `opts.socketPath` instead of the
  // formed address; restoring the "move the store root" sentence.
  test('T6: sunPathAddress forms the fd address and refuses only an over-long one', async () => {
    const { sunPathAddress, SUN_PATH_MAX } = await import('../src/systems/fuse/control.ts');
    assert.equal(sunPathAddress(3, 'control.sock'), '/proc/self/fd/3/control.sock');
    assert.ok(Buffer.byteLength(sunPathAddress(3, 'control.sock')) <= SUN_PATH_MAX);
    // KEYED ON THE FORMED ADDRESS, NOT ON THE BASENAME — and only a basename
    // in this band can tell the two apart. The address carries a 16-byte
    // `/proc/self/fd/3/` prefix, so a 100-byte basename is UNDER the 107-byte
    // limit on its own and OVER it once formed. Every real caller passes
    // `control.sock` (12 bytes) and the 200-char case below is refused by a
    // basename-keyed check too, so without this arm a check reading `name`
    // instead of `addr` is invisible.
    assert.throws(() => sunPathAddress(3, 'c'.repeat(100)), (e) => {
      assert.equal(e.code, 'FUSE_CONTROL_SOCK_PATH_TOO_LONG');
      assert.ok(Buffer.byteLength('c'.repeat(100)) <= SUN_PATH_MAX,
        'the discriminating case must have a basename UNDER the limit, or it proves nothing');
      return true;
    });
    assert.throws(() => sunPathAddress(3, 'c'.repeat(200)), (e) => {
      assert.equal(e.code, 'FUSE_CONTROL_SOCK_PATH_TOO_LONG');
      assert.equal(e.statusCode, 501);
      assert.match(e.message, /the address this session would hand bind\(\)\/connect\(\)/);
      // THE CORRECTED ADVICE, asserted as an ABSENCE and a presence: the store
      // root is named only to say it is NOT the lever.
      assert.doesNotMatch(e.message, /move it somewhere shorter/);
      assert.match(e.message, /store root's depth is NOT a factor/);
      return true;
    });
  });
});

// ── the three callers that reclaim a session's mount scaffolding ────────────
//
// `launch()` creates the run directory and starts LISTENING on the control
// socket BEFORE `spawn()`, because the daemon refuses to mount without a socket
// to connect to. So a session can hold a prepared `FuseSession` with no process
// at all — and nothing else reclaims it: `_handleExit` only runs for a process
// that existed. Every caller that drops an instance therefore has to tear the
// mount scaffolding down UNCONDITIONALLY.
//
// Measured as a real leak (a listening `Server@…/control.sock` surviving a
// whole test file); the leak shipped untested, and this is that debt.
// Prototype-only stand-ins, following `tests/instance-liveness.test.mjs`: the
// question is which branch each caller takes, and a booted server would add a
// launch path without adding an assertion.
describe('reclaiming a prepared-but-unspawned session', () => {
  const stubFuse = () => { const f = { torn: 0, teardown: async () => { f.torn++; } }; return f; };

  const stubInstance = (fuse) => {
    const inst = Object.create(Instance.prototype);
    Object.assign(inst, { proc: null, _fuse: fuse, _redirect: null, id: 'inst-x', project: 'p' });
    return inst;
  };

  const stubManager = (insts) => {
    const mgr = Object.create(InstanceManager.prototype);
    Object.assign(mgr, {
      byId: new Map(insts.map(i => [i.id, i])),
      _cancelAutoResume() {}, _purgeIdleFor() {}, emit() {},
      _sessionRenew: { purge() {} },
    });
    return mgr;
  };

  // Dies if `kill()`'s no-process arm returns before the teardown.
  test('Instance.kill() with no process still tears the mount down', async () => {
    const fuse = stubFuse();
    await stubInstance(fuse).kill({ graceMs: 0 });
    assert.equal(fuse.torn, 1, 'kill() returned early and left the control socket listening');
  });

  // Dies if `remove()` gates the kill on `i.proc` again.
  test('InstanceManager.remove() reclaims a session that never spawned', async () => {
    const fuse = stubFuse();
    const inst = stubInstance(fuse);
    await stubManager([inst]).remove('inst-x');
    assert.equal(fuse.torn, 1, 'remove() skipped the kill because there was no process');
  });

  // Dies if `removeAllForProject()` gates the kill on `i.proc` again — the
  // sibling caller the original fix missed.
  test('InstanceManager.removeAllForProject() reclaims one too', async () => {
    const fuse = stubFuse();
    const inst = stubInstance(fuse);
    const n = await stubManager([inst]).removeAllForProject('p');
    assert.equal(n, 1);
    assert.equal(fuse.torn, 1, 'removeAllForProject() skipped the kill because there was no process');
  });
});

describe('/proc parsing', () => {
  // PINS: fields are counted from the LAST ')'. A comm containing spaces and
  // parentheses is what breaks a naive split, and it is attacker-free but
  // entirely ordinary (`(sd-pam)`, `(node) (1)`).
  test('parses a comm containing spaces and parentheses', () => {
    const raw = '4242 (my proc (x)) Z 1 4242 4242 0 -1 4194560 0 0 0 0 0 0 0 0 20 0 2 0 987654 0 0\n';
    assert.deepEqual(parseProcStat(raw), { state: 'Z', starttime: '987654' });
  });
  test('returns null for a truncated stat line', () => {
    assert.equal(parseProcStat('4242 (x) S 1'), null);
  });
  // PINS: /proc/<pid>/mounts octal-escapes space, tab, newline and backslash.
  test('un-escapes an octal-escaped mountpoint', () => {
    assert.equal(unescapeMountPath('/run/a\\040b'), '/run/a b');
  });
});

describe('deadlines', () => {
  // PINS: every deadline is finite. An infinite one turns "reported, never
  // blocked on" into a hang in the path whose job is to let go.
  test('every deadline is a finite positive bound', () => {
    for (const [k, v] of Object.entries(DEFAULT_DEADLINES)) {
      assert.ok(Number.isFinite(v) && v > 0, `${k} = ${v}`);
    }
  });
});


describe('the clean verdict comes from namespace membership, not the recorded set', () => {
  // PINS THE PRINCIPLE. A live process in the session's mount namespace that NO
  // record names — routine, because Bash is a real subprocess family and there
  // is deliberately no process-group kill on this path — holds mounts open. The
  // recorded set is empty, every recorded pid is confirmed dead, and the old
  // verdict called that clean and deleted the record over a live namespace.
  test('an unrecorded namespace member is a wedge, and keeps the record', async () => {
    const { rundir, record } = await seedRun();
    const procs = liveBoth();
    const CHILD = 5555;
    procs[CHILD] = { starttime: '555555', state: 'S' };   // in NS, named by no record
    const driver = fakeDriver({ procs, nsMounts: healthyMounts(record), conns: ['77'] });
    const report = await runTeardown({ rundir, driver, scan: driver.scan, log: { warn() {} } });

    assert.deepEqual(report.survivingPids, [], 'a recorded pid survived, so this would pass for the wrong reason');
    assert.deepEqual(report.namespaceMembers, [CHILD]);
    assert.equal(report.wedged, true, 'a live namespace member did not make it a wedge');
    assert.equal(report.removedRunDir, false, 'the record was destroyed over a live namespace');
    assert.deepEqual(driver.calls.filter(c => c[0] === 'signal').map(c => c[1]).includes(CHILD), false,
      'the unrecorded member was signalled — teardown may only signal pids it recorded');
  });

  // PINS: anything cc cannot enumerate is a wedge, not a pass. A scan that
  // cannot run returns no rows, and an empty result read as "nothing is there"
  // is exactly how the leaked anchor stayed invisible.
  test('a scan that cannot run is a wedge, not a clean pass', async () => {
    const { rundir, record } = await seedRun();
    const procs = liveBoth();
    for (const pid of [WORKER, DAEMON, ANCHOR]) delete procs[pid];   // everything really is gone
    const driver = fakeDriver({ procs, nsMounts: [], conns: [], scanOk: false });
    const report = await runTeardown({ rundir, driver, scan: driver.scan, log: { warn() {} } });

    assert.equal(report.enumerated, false);
    assert.deepEqual(report.survivingPids, []);
    assert.deepEqual(report.residualMounts, []);
    assert.equal(report.wedged, true, 'an unenumerable namespace was declared clean');
    assert.equal(report.removedRunDir, false);
    void record;
  });

  // The control for the case above: the SAME fixture with a working scan is
  // clean, so the wedge above is the scan failing and nothing else.
  test('…and the same state with a working scan is clean', async () => {
    const { rundir } = await seedRun();
    const procs = liveBoth();
    for (const pid of [WORKER, DAEMON, ANCHOR]) delete procs[pid];
    const driver = fakeDriver({ procs, nsMounts: [], conns: [] });
    const report = await runTeardown({ rundir, driver, scan: driver.scan, log: { warn() {} } });
    assert.equal(report.enumerated, true);
    assert.equal(report.wedged, false);
    assert.equal(report.removedRunDir, true);
  });

  // PINS B2: the intent-only path — a bootstrap that died, or is still
  // mid-handshake — has processes behind it, so a teardown reading only the
  // record signals NOBODY and then deletes the directory. The handle when there
  // is no record is the marker the bootstrap's own execve put in their
  // environments.
  test('an intent-only run directory reclaims its processes by marker', async () => {
    const { rundir } = await seedRun({}, { intentOnly: true });
    const BOOTSTRAP = 6001, ANCHOR2 = 6002;
    const procs = {
      [BOOTSTRAP]: { starttime: '600100', state: 'S', instanceId: path.basename(rundir), rundir },
      [ANCHOR2]: { starttime: '600200', state: 'S', instanceId: path.basename(rundir), rundir },
    };
    const driver = fakeDriver({ procs, nsMounts: [path.join(rundir, 'root')], conns: [] });
    const report = await runTeardown({ rundir, driver, scan: driver.scan, log: { warn() {} } });

    assert.equal(report.source, 'intent.json');
    assert.deepEqual(report.markerReclaimed.map(r => r.pid).sort(), [BOOTSTRAP, ANCHOR2].sort());
    for (const r of report.markerReclaimed) assert.equal(r.killed, true, JSON.stringify(r));
    // Unmounted through the process before it was signalled — it is the handle.
    const ops = driver.calls.map(c => c[0]);
    assert.ok(ops.indexOf('umount') >= 0 && ops.indexOf('signal') > ops.indexOf('umount'), ops.join(','));
    assert.equal(report.wedged, false);
    assert.equal(report.removedRunDir, true);
  });

  // PINS the other half of B2: a record that appears WHILE teardown runs means
  // the bootstrap completed its handshake mid-teardown. Deleting over it would
  // strand whatever it names.
  test('a mount.json appearing mid-teardown is never deleted over', async () => {
    const { rundir, record } = await seedRun({}, { intentOnly: true });
    const driver = fakeDriver({ procs: {}, nsMounts: [], conns: [] });
    // The bootstrap finishes its handshake at the moment teardown scans.
    const scan = async (opts) => {
      await fs.writeFile(path.join(rundir, 'mount.json'), JSON.stringify({ ...record, stage: 'mounted' }));
      return driver.scan(opts);
    };
    const report = await runTeardown({ rundir, driver, scan, log: { warn() {} } });
    assert.equal(report.wedged, true);
    assert.equal(report.removedRunDir, false);
    assert.ok(report.notes.some(n => n.includes('appeared during teardown')), report.notes.join(' | '));
    await fs.stat(path.join(rundir, 'mount.json'));   // still there for the sweep
  });

  // PINS F2: a record whose root-executed fields violate the schema is a
  // REPORTED wedge. The failure mode being closed is the no-adversary one — a
  // malformed field reaching execFile throws mid-machine, the caller swallows
  // the rejection, and everything survives with no report at all.
  test('a schema-violating fusectl or minor is refused and reported, never used', async () => {
    for (const [field, bad] of [['fusectl', '/etc'], ['minor', '77; rm -rf /']]) {
      const { rundir, record } = await seedRun({ [field]: bad });
      const procs = liveBoth();
      const driver = fakeDriver({ procs, nsMounts: healthyMounts(record), conns: ['77'] });
      const report = await runTeardown({ rundir, driver, scan: driver.scan, log: { warn() {} } });
      assert.equal(report.wedged, true, `${field}: not reported`);
      assert.equal(report.removedRunDir, false, `${field}: reclaimed anyway`);
      assert.ok(report.notes.some(n => n.startsWith('SCHEMA:')), report.notes.join(' | '));
      if (field === 'fusectl') {
        assert.deepEqual(driver.calls.filter(c => c[0] === 'abort'), [], 'aborted through an unvalidated fusectl path');
      } else {
        assert.equal(report.abort, 'no-minor');
        assert.deepEqual(driver.calls.filter(c => c[0] === 'abort'), [], 'aborted with a non-numeric minor');
      }
    }
  });

  // PINS: the machine never rejects. A driver that throws must still produce a
  // wedge report — both callers swallow a rejection, so a throw would be a
  // silent survival of the daemon, the mounts and the record.
  test('a throwing driver is contained into a wedge report, not a rejection', async () => {
    const { rundir, record } = await seedRun();
    const driver = fakeDriver({ procs: liveBoth(), nsMounts: healthyMounts(record), conns: ['77'] });
    driver.umountIn = async () => { throw new Error('execFile: ENOENT'); };
    const report = await runTeardown({ rundir, driver, scan: driver.scan, log: { warn() {} } });
    assert.equal(report.wedged, true);
    assert.equal(report.removedRunDir, false);
    assert.ok(report.notes.some(n => n.includes('threw and was contained')), report.notes.join(' | '));
  });

  // T1 — PINS the lazy-unmount SUCCESS path. The old fixture failed plain and
  // lazy alike, so this branch was unreachable and deleting it kept the suite
  // green.
  test('a mount that refuses a plain unmount is unmounted lazily, and recorded as such', async () => {
    const { rundir, record } = await seedRun();
    const procs = liveBoth();
    delete procs[WORKER];
    const stubborn = path.join(record.root, 'proc');
    const driver = fakeDriver({
      procs, nsMounts: healthyMounts(record), conns: ['77'], lazyOnly: new Set([stubborn]),
    });
    const report = await runTeardown({ rundir, driver, scan: driver.scan, log: { warn() {} } });
    assert.deepEqual(report.lazyUnmounted, [stubborn]);
    assert.ok(report.unmounted.includes(stubborn), 'a lazily-unmounted path is still an unmount');
    // Plain was tried FIRST and only then lazy — a lazy-first implementation
    // detaches mounts it could have removed properly.
    const tries = driver.calls.filter(c => c[0] === 'umount' && c[1] === stubborn).map(c => c[2]);
    assert.deepEqual(tries, ['plain', 'lazy']);
    assert.equal(report.wedged, false);
  });

  // T4 — PINS the abort-failed branch: the write to `abort` is refused. The
  // fixture has carried the knob for it since the beginning and no case set it.
  test('a refused abort is reported as abort-failed and does not stop the machine', async () => {
    const { rundir, record } = await seedRun();
    const procs = liveBoth();
    delete procs[WORKER];
    const driver = fakeDriver({ procs, nsMounts: healthyMounts(record), conns: ['77'], abortOk: false });
    const report = await runTeardown({ rundir, driver, scan: driver.scan, log: { warn() {} } });
    assert.equal(report.abort, 'abort-failed');
    assert.ok(report.notes.some(n => n.includes('/abort failed')), report.notes.join(' | '));
    assert.ok(driver.calls.some(c => c[0] === 'signal' && c[1] === DAEMON), 'the daemon ladder did not run past a failed abort');
  });
});

describe('FuseSession lifecycle', () => {
  const plan = (rundir) => ({
    instanceId: path.basename(rundir), rundir,
    root: path.join(rundir, 'root'), mirror: path.join(rundir, 'mirror'),
    fusectl: path.join(rundir, 'fusectl'), pinsPath: path.join(rundir, 'pins.txt'),
    intentPath: path.join(rundir, 'intent.json'), recordPath: path.join(rundir, 'mount.json'),
    daemonLog: path.join(rundir, 'daemon.log'),
    eventLog: path.join(rundir, 'events.log'),
    controlSock: path.join(rundir, 'control.sock'),
    markPath: '/usr/local/bin/claude',
    cwdInside: '/srv/app', mountOpts: 'o', tiers: [], pinsText: '# pins\n',
    uid: 1000, gid: 1000, sourceOverrideRoot: '', tracePath: '',
  });

  // T3 / B1 — PINS: the teardown latch is released by a successful prepare().
  // Rewind and prune tear a session down and relaunch it into the SAME run
  // directory (instances.ts rewindToUserMessage / pruneSession), and a latch
  // that never reset made the second kill() a no-op: no unmounts, no abort, no
  // signals, and a root daemon plus a private mount surviving until restart.
  test('prepare() releases the teardown latch, so a relaunched session tears down again', async (t) => {
    const rundir = await mkdtemp('cc-fuse-life-');
    const p = plan(rundir);
    const d = fakeDriver();
    const s = new FuseSession({ plan: p, ccBootId: 'b', driver: d, scan: d.scan, deadlines: { handshakeMs: 0 } });
    t.after(() => s.teardown());

    await s.prepare();
    const first = await s.teardown();
    assert.ok(first && 'wedged' in first, 'the first teardown did not run');

    // The second lifecycle: same session object, same run directory.
    await s.prepare();
    const second = await s.teardown();
    assert.ok(second && 'wedged' in second, 'the second lifecycle was silently skipped — this is the rewind/prune leak');
  });

  // PINS THAT prepare() AND teardown() MAY NOT INTERLEAVE, and what the
  // interleaving costs is not a socket. `_mutating` covers rewind/fork/prune
  // only and the instance is in `byId` before `launch()` runs, so a `kill()`
  // can reach `teardown()` while `launch()` is inside `prepare()`. A teardown
  // that latches during prepare's `await ControlServer.listen()` leaves prepare
  // to assign `#control` afterwards — latched WITH A LIVE SERVER — and the
  // final teardown then early-returns on the latch, so the state machine never
  // runs and the mount, the root daemon and the run directory survive the
  // session.
  test('a teardown that races a prepare does not swallow the next teardown', async (t) => {
    const rundir = await mkdtemp('cc-fuse-life-');
    const d = fakeDriver();
    const s = new FuseSession({ plan: plan(rundir), ccBootId: 'b', driver: d, scan: d.scan, deadlines: { handshakeMs: 0 } });
    t.after(() => s.teardown());

    // Both started before either is awaited — the interleaving itself.
    const prep = s.prepare();
    const racing = s.teardown();
    await Promise.allSettled([prep, racing]);

    // WHICHEVER ORDER THEY TOOK, the session is now either prepared or torn
    // down, never latched-with-a-server. The distinguishing assertion is the
    // NEXT teardown: it must still run the state machine if a prepare was the
    // last thing to complete.
    const after = await s.teardown();
    if (s.controlServer !== null) assert.fail('a control server outlived a teardown');
    // A teardown reports `alreadyTornDown` only when no prepare followed the
    // one that latched. Assert the pair is CONSISTENT rather than guessing the
    // race's winner: if the last completed call was a prepare, the state
    // machine must have run.
    const ranMachine = after && 'wedged' in after;
    assert.equal(ranMachine || after.alreadyTornDown === true, true, JSON.stringify(after));

    // …AND THE ORDER-INDEPENDENT PART, which is the real invariant: a prepare
    // that completes AFTER a teardown always re-arms it. This is the sequence
    // the race produces when teardown wins, run deterministically.
    await s.prepare();
    const second = await s.teardown();
    assert.ok(second && 'wedged' in second,
      'a prepare after a teardown did not re-arm the state machine');
    assert.equal(s.controlServer, null);
  });

  // T3 — PINS: "already torn down" is DISTINGUISHABLE from "nothing to do". A
  // caller that cannot tell them apart cannot tell a no-op from a leak.
  test('a repeated teardown reports that it was already torn down', async (t) => {
    const rundir = await mkdtemp('cc-fuse-life-');
    const d = fakeDriver();
    const s = new FuseSession({ plan: plan(rundir), ccBootId: 'b', driver: d, scan: d.scan });
    t.after(() => s.teardown());
    await s.prepare();
    assert.ok('wedged' in (await s.teardown()));
    assert.deepEqual(await s.teardown(), { alreadyTornDown: true });
  });

  // T3 — PINS the handshake deadline's two arms, which differ in what the
  // caller must do: a LIVE process that never wrote the record is a mount that
  // did not come up, a DEAD one has already put its own named refusal on stderr.
  test('awaitHandshake gives up at the deadline while alive, and immediately once dead', async (t) => {
    const rundir = await mkdtemp('cc-fuse-life-');
    const driver = fakeDriver();
    const s = new FuseSession({ plan: plan(rundir), ccBootId: 'b', driver, scan: driver.scan, deadlines: { handshakeMs: 500, pollMs: 50 } });
    t.after(() => s.teardown());
    await s.prepare();

    const t0 = driver.now();
    assert.equal(await s.awaitHandshake(() => true), null);
    assert.ok(driver.now() - t0 >= 500, `gave up after ${driver.now() - t0}ms of a 500ms deadline`);

    const t1 = driver.now();
    assert.equal(await s.awaitHandshake(() => false), null);
    assert.equal(driver.now() - t1, 0, 'waited out the deadline on a process already known to be dead');
  });

  // PINS: the handshake waits for `stage: mounted`. The record exists from the
  // moment the bootstrap has a pid to name, so its mere presence would report a
  // mount that is not up.
  test('awaitHandshake ignores a stage:starting record and takes the mounted one', async (t) => {
    const rundir = await mkdtemp('cc-fuse-life-');
    const p = plan(rundir);
    const driver = fakeDriver();
    const s = new FuseSession({ plan: p, ccBootId: 'b', driver, scan: driver.scan, deadlines: { handshakeMs: 300, pollMs: 50 } });
    t.after(() => s.teardown());
    await s.prepare();
    await fs.writeFile(p.recordPath, JSON.stringify({ stage: 'starting', anchorPid: 7, daemonPid: 0 }));
    assert.equal(await s.awaitHandshake(() => true), null);
    // …but it is REMEMBERED, so a caller tearing the failed launch down still
    // has the pids the bootstrap had already recorded.
    assert.equal(s.record.anchorPid, 7);

    await fs.writeFile(p.recordPath, JSON.stringify({ stage: 'mounted', anchorPid: 7, daemonPid: 8 }));
    const rec = await s.awaitHandshake(() => true);
    assert.equal(rec.daemonPid, 8);
  });

  // PINS: relaunching into a run directory whose previous teardown WEDGED is
  // refused rather than silently mounting a second session over the handle to
  // the first.
  test('prepare() refuses to reuse a run directory whose last teardown wedged', async (t) => {
    const rundir = await mkdtemp('cc-fuse-life-');
    const p = plan(rundir);
    const d = fakeDriver();
    const s = new FuseSession({ plan: p, ccBootId: 'b', driver: d, scan: d.scan });
    t.after(() => s.teardown());
    await s.prepare();
    await fs.writeFile(p.recordPath, JSON.stringify({ stage: 'mounted', wedged: true, terminalState: 'WEDGED(threads=2 states=DD)' }));
    await assert.rejects(() => s.prepare(), (e) => {
      assert.equal(e.code, 'FUSE_PREVIOUS_TEARDOWN_WEDGED');
      return true;
    });
  });

  // T5. PINS: `#prepare()` refuses a run directory ANOTHER
  // instance owns, and the predicate is OWNERSHIP rather than EXISTENCE.
  //
  // Both arms are needed and neither is the other's restatement. Without the
  // refusal, `mkdir(root, {recursive:true})` adopts the directory silently and
  // the `rm(recordPath)` two lines on destroys the live session's mount
  // record. Without the POSITIVE CONTROL the guard could be "refuse every
  // pre-existing directory", which breaks the ordinary rewind/prune relaunch
  // that the test above depends on.
  test('T5: prepare() refuses a run directory owned by another instance, and relaunches its own', async (t) => {
    const rundir = await mkdtemp('cc-fuse-life-');
    const p = plan(rundir);
    const d = fakeDriver();
    const s = new FuseSession({ plan: p, ccBootId: 'b', driver: d, scan: d.scan });
    t.after(() => s.teardown());

    // THE POSITIVE CONTROL FIRST, and it is a real relaunch: prepare() writes
    // its own intent.json, so the second call reads the record it just left.
    await s.prepare();
    assert.equal(JSON.parse(await fs.readFile(p.intentPath, 'utf8')).instanceId, p.instanceId);
    await s.prepare();

    const foreign = randomUUID();
    assert.notEqual(foreign, p.instanceId);
    await fs.writeFile(p.intentPath, JSON.stringify({ schema: 1, instanceId: foreign, rundir }));
    // THE OTHER SESSION'S MOUNT RECORD, seeded because it is what the guard
    // actually protects and what the ORDERING is about. `#prepare()`'s next
    // act after this guard is `rm(p.recordPath)`, so a guard placed AFTER that
    // rm still throws the right code while having already destroyed the live
    // session's only handle on its daemon, its anchor and its minor.
    //
    // NON-WEDGED ON PURPOSE: `wedged: true` is caught by the earlier
    // FUSE_PREVIOUS_TEARDOWN_WEDGED check and this arm would never reach the
    // ownership guard at all.
    const otherRecord = {
      schema: 1, stage: 'mounted', instanceId: foreign, rundir,
      daemonPid: 4242, anchorPid: 4243, minor: '99',
    };
    await fs.writeFile(p.recordPath, JSON.stringify(otherRecord));

    await assert.rejects(() => s.prepare(), (e) => {
      assert.equal(e.code, 'FUSE_RUN_DIR_FOREIGN');
      assert.equal(e.statusCode, 500);
      // It names BOTH ids: an operator holding one of them has to be able to
      // tell which session is the intruder.
      assert.ok(e.message.includes(foreign) && e.message.includes(p.instanceId), e.message);
      return true;
    });
    // AND IT REFUSED *BEFORE* DESTROYING ANYTHING. The mount record is the
    // load-bearing assertion — `intent.json` alone cannot see this, because
    // prepare() rewrites intent LATER and a prepare that rm'd the record and
    // then threw leaves intent untouched either way.
    assert.deepEqual(JSON.parse(await fs.readFile(p.recordPath, 'utf8')), otherRecord,
      'the foreign session’s mount.json was destroyed before the refusal');
    assert.equal(JSON.parse(await fs.readFile(p.intentPath, 'utf8')).instanceId, foreign);
  });
});

describe('the record-independent orphan backstop', () => {
  const RUN_ROOT = '/store/.code-conductor/systems/fuse/run';
  const row = (pid, start, ns, id, rundir) => `${pid}\t${start}\t${ns}\t${id}\t${rundir}`;
  const scanOf = (...rows) => async () => ({ ok: true, raw: rows.join('\n') });

  // PINS: attribution is on an identity the process CARRIES, and every missing
  // or foreign field fails CLOSED. A row that got through wrongly is a SIGKILL
  // at a stranger.
  test('parses and attributes only complete rows inside this store\'s run root', () => {
    const rows = parseScan([
      row(100, '111', 'mnt:[1]', 'a', `${RUN_ROOT}/a`),                    // ours
      row(101, '222', 'mnt:[1]', 'b', '/other/store/systems/fuse/run/b'),  // another install
      row(102, '333', 'mnt:[1]', '', `${RUN_ROOT}/c`),                     // no instance id
      row(103, '', 'mnt:[1]', 'd', `${RUN_ROOT}/d`),                       // no starttime
      row(104, '444', 'mnt:[1]', 'e', ''),                                 // no rundir
      row(1, '555', 'mnt:[1]', 'f', `${RUN_ROOT}/f`),                      // pid 1 is never ours
      row('nope', '666', 'mnt:[1]', 'g', `${RUN_ROOT}/g`),                 // unparsable pid
      row(105, '777', 'mnt:[1]', 'h', `${RUN_ROOT}-notours/h`),            // prefix, not a path prefix
      'garbage',
      '',
    ].join('\n'));
    assert.deepEqual(orphansUnder(rows, RUN_ROOT).map(r => r.pid), [100]);
  });

  // PINS the union of the two uid passes: the pass that could read a field wins
  // over the one that could not, so a process readable by only one of them is
  // still fully described. Without this the anchor (root-readable) and the
  // worker (cc-readable) can never appear in one enumeration.
  test('unions the two uid passes by pid, field by field', () => {
    const rows = parseScan([
      row(200, '111', '', '', ''),                        // the pass that could not read it
      row(200, '111', 'mnt:[9]', 'x', `${RUN_ROOT}/x`),   // the pass that could
    ].join('\n'));
    assert.equal(rows.length, 1);
    assert.deepEqual(rows[0], { pid: 200, starttime: '111', nsMnt: 'mnt:[9]', instanceId: 'x', rundir: `${RUN_ROOT}/x` });
  });

  // PINS: membership by EITHER identity — the namespace id when there is a
  // record, the run directory when there is not.
  test('membership accepts the namespace id or the run directory, and nothing else', () => {
    const rows = parseScan([
      row(300, '1', 'mnt:[9]', '', ''),                   // in the namespace
      row(301, '1', 'mnt:[8]', 'y', `${RUN_ROOT}/y`),     // elsewhere, but ours by rundir
      row(302, '1', 'mnt:[8]', 'z', `${RUN_ROOT}/z`),     // neither
    ].join('\n'));
    assert.deepEqual(membersOf(rows, { nsMntId: 'mnt:[9]', rundir: `${RUN_ROOT}/y` }).map(r => r.pid), [300, 301]);
    assert.deepEqual(membersOf(rows, {}).map(r => r.pid), [], 'membership with no identity to compare must match nothing');
  });

  test('a scan that could not run reports enumerated:false and signals nothing', async () => {
    const driver = fakeDriver({ procs: { 900: { starttime: '999', state: 'S' } } });
    const out = await reclaimOrphanProcesses(RUN_ROOT, {
      driver, log: { warn() {} }, scan: async () => ({ ok: false, raw: '' }),
    });
    assert.equal(out.enumerated, false);
    assert.deepEqual(out.reclaimed, []);
    assert.deepEqual(driver.calls.filter(c => c[0] === 'signal'), []);
  });

  test('reclaims a record-less orphan: unmount first, then kill, identity re-checked', async () => {
    const rundir = await mkdtemp('cc-fuse-orphan-');
    const runRoot = path.dirname(rundir);
    const driver = fakeDriver({
      procs: { 900: { starttime: '999', state: 'S' } },
      mounts: { 900: [path.join(rundir, 'root'), path.join(rundir, 'root', 'proc')] },
    });
    const out = await reclaimOrphanProcesses(runRoot, {
      driver, log: { warn() {} }, scan: scanOf(row(900, '999', 'mnt:[9]', path.basename(rundir), rundir)),
    });
    assert.equal(out.enumerated, true);
    assert.equal(out.reclaimed[0].killed, true);
    assert.deepEqual(out.reclaimed[0].unmounted, [path.join(rundir, 'root', 'proc'), path.join(rundir, 'root')]);
    const ops = driver.calls.map(c => c[0]);
    assert.ok(ops.indexOf('signal') > ops.lastIndexOf('umount'), `order was ${ops.join(',')}`);
    // Privileged: an orphan may be the root-owned anchor or bootstrap, and an
    // unprivileged signal at one is EPERM, which reads as "already gone".
    assert.equal(driver.calls.find(c => c[0] === 'signal')[3], 'sudo');
  });

  test('a pid whose starttime moved since the scan is NOT signalled', async () => {
    const rundir = await mkdtemp('cc-fuse-orphan-');
    const driver = fakeDriver({ procs: { 901: { starttime: 'DIFFERENT', state: 'S' } }, mounts: { 901: [] } });
    const out = await reclaimOrphanProcesses(path.dirname(rundir), {
      driver, log: { warn() {} }, scan: scanOf(row(901, '999', 'mnt:[9]', path.basename(rundir), rundir)),
    });
    assert.equal(out.reclaimed[0].killed, false);
    assert.match(out.reclaimed[0].note, /recycled/);
    assert.deepEqual(driver.calls.filter(c => c[0] === 'signal'), []);
  });

  test('an orphan whose run directory still has a record is left to the record pass', async () => {
    const rundir = await mkdtemp('cc-fuse-orphan-');
    await fs.writeFile(path.join(rundir, 'mount.json'), '{}');
    const driver = fakeDriver({ procs: { 902: { starttime: '999', state: 'S' } }, mounts: { 902: [] } });
    const out = await reclaimOrphanProcesses(path.dirname(rundir), {
      driver, log: { warn() {} }, scan: scanOf(row(902, '999', 'mnt:[9]', path.basename(rundir), rundir)),
    });
    assert.deepEqual(out.reclaimed, []);
    assert.deepEqual(driver.calls.filter(c => c[0] === 'signal'), []);
  });

  // T4. PINS THE SECOND SET: `liveIds` reaching
  // `reclaimOrphanProcesses` as WHOLE ids, read off `/proc/<pid>/environ`'s
  // `CC_FUSE_INSTANCE_ID` — never through a directory name. BOTH DIRECTIONS:
  // the skip alone is also what a backstop that never fires produces, so the
  // reclaim beside it is its control.
  //
  // WHAT IT DOES *NOT* KILL TODAY, stated because the honest version is the
  // useful one. `fuseRunDirName` is the identity, so `keep` and `liveIds` are
  // equal as sets and a `keep`-shaped derivation leaking into this pass is
  // behaviourally identical — no SIGKILL lands, and no mutant distinguishes
  // the two here. The discrimination becomes real only under a future
  // TRUNCATING name shape, where a `keep`-derived entry would stop matching
  // the whole id this pass compares against and the signal would reach a live
  // worker. The fixture is a real uuid in a run directory of that name so it
  // is ready for that day: the fixture it replaces used a mkdtemp basename —
  // `'cc-fuse-orphan-'` (15) plus 6 mkdtemp characters, ONE 21-character
  // string serving as both id and directory name — under which a prefix
  // applied to either set still matched and the question could not even be
  // asked. T3 is where the dual set's readdir half is killable today.
  test('T4: a live full-uuid session id is never signalled, and the same row without it is', async () => {
    const runRoot = await mkdtemp('cc-fuse-orphan-');
    const id = randomUUID();
    assert.equal(id.length, 36, 'a short id makes truncation invisible');
    // No mount.json: the record pass has nothing here, so this row is the
    // backstop's own business rather than one it defers.
    const rundir = path.join(runRoot, id);
    await fs.mkdir(rundir, { recursive: true });
    const scan = scanOf(row(903, '999', 'mnt:[9]', id, rundir));
    const procs = () => ({ 903: { starttime: '999', state: 'S' } });

    const skipped = fakeDriver({ procs: procs(), mounts: { 903: [] } });
    const out = await reclaimOrphanProcesses(runRoot, {
      driver: skipped, log: { warn() {} }, liveIds: [id], scan,
    });
    assert.deepEqual(out.reclaimed, []);
    assert.deepEqual(skipped.calls.filter(c => c[0] === 'signal'), []);

    const reclaimed = fakeDriver({ procs: procs(), mounts: { 903: [] } });
    const out2 = await reclaimOrphanProcesses(runRoot, {
      driver: reclaimed, log: { warn() {} }, scan,
    });
    assert.equal(out2.reclaimed[0]?.killed, true, JSON.stringify(out2));
    assert.ok(reclaimed.calls.some(c => c[0] === 'signal' && c[1] === 903),
      'the pass never fires at all, so the skip above proves nothing');
  });
});

describe('two teardowns of the same run directory at once', () => {
  // T5 — the boot sweep and an instance can reach the SAME run directory
  // concurrently: `#tornDown` is per-FuseSession and says nothing about a sweep
  // running in this process (or, at boot, in another one). Neither pass may
  // reject, neither may signal a pid that has stopped being ours, and the
  // directory must end up gone exactly once rather than resurrected.
  test('neither rejects, no stranger is signalled, and the directory ends up gone', async () => {
    const { rundir, record } = await seedRun();
    const procs = liveBoth();
    const driver = fakeDriver({ procs, nsMounts: healthyMounts(record), conns: ['77'] });
    const both = await Promise.all([
      runTeardown({ rundir, driver, scan: driver.scan, log: { warn() {} } }),
      runTeardown({ rundir, driver, scan: driver.scan, log: { warn() {} } }),
    ]);
    for (const r of both) assert.equal(r.wedged, false, JSON.stringify(r.notes));
    assert.ok(both.some(r => r.removedRunDir), 'neither pass reclaimed the directory');
    await assert.rejects(() => fs.stat(rundir), 'the run directory survived, or was resurrected');
    // Every signal went at one of the three recorded pids, each of which was
    // starttime-verified immediately before. A second pass finding a pid
    // already dead must not signal the number again.
    for (const [, pid] of driver.calls.filter(c => c[0] === 'signal')) {
      assert.ok([WORKER, DAEMON, ANCHOR].includes(pid), `signalled ${pid}, which this session never recorded`);
    }
  });

  // PINS the resurrection half on its own: a wedge verdict reached after the
  // directory is already gone must not recreate it, because writeJsonAtomic
  // mkdir -p's its parent.
  test('a wedge verdict does not recreate a directory another pass reclaimed', async () => {
    const { rundir, record } = await seedRun();
    const driver = fakeDriver({ procs: liveBoth(), nsMounts: healthyMounts(record), conns: ['77'], undead: new Set([DAEMON]) });
    // The concurrent pass reclaims the directory just as this one starts
    // deciding — modelled by removing it during the enumeration.
    const scan = async (opts) => { await fs.rm(rundir, { recursive: true, force: true }); return driver.scan(opts); };
    const report = await runTeardown({ rundir, driver, scan, log: { warn() {} } });
    assert.equal(report.wedged, true, 'the undead daemon should still be a wedge');
    await assert.rejects(() => fs.stat(rundir), 'the wedge write resurrected the reclaimed directory');
  });
});

describe('round-2: the verdict observes rather than trusts', () => {
  // PINS: on the intent path, a marker process that SURVIVES its SIGKILL is a
  // namespace member and therefore a wedge. `killed:false` is the shape a
  // bootstrap wedged in `D` inside a hung mount syscall has — SIGKILL cannot
  // touch `D` — and reporting clean there deletes the run directory over a live
  // process still holding the namespace.
  test('an intent-path process that survives its kill is a member, and a wedge', async () => {
    const { rundir } = await seedRun({}, { intentOnly: true });
    const UNDEAD = 6100;
    const procs = { [UNDEAD]: { starttime: '610000', state: 'D', instanceId: path.basename(rundir), rundir } };
    const driver = fakeDriver({ procs, nsMounts: [], conns: [], undead: new Set([UNDEAD]) });
    const report = await runTeardown({ rundir, driver, scan: driver.scan, log: { warn() {} } });

    assert.equal(report.markerReclaimed.length, 1);
    assert.equal(report.markerReclaimed[0].killed, false, 'the fixture did not produce an undead marker process');
    assert.deepEqual(report.namespaceMembers, [UNDEAD], 'the intent path threw its own scan rows away');
    assert.equal(report.wedged, true, 'reported clean over a live process holding the namespace');
    assert.equal(report.removedRunDir, false);
    await fs.stat(rundir);
  });

  // The control: the same intent path with the process actually dying is clean
  // and reclaims, so the wedge above is the survival and nothing else.
  test('…and an intent path whose processes really die is still clean', async () => {
    const { rundir } = await seedRun({}, { intentOnly: true });
    const procs = { 6101: { starttime: '610100', state: 'S', instanceId: path.basename(rundir), rundir } };
    const driver = fakeDriver({ procs, nsMounts: [], conns: [] });
    const report = await runTeardown({ rundir, driver, scan: driver.scan, log: { warn() {} } });
    assert.equal(report.markerReclaimed[0].killed, true);
    assert.deepEqual(report.namespaceMembers, []);
    assert.equal(report.wedged, false);
    assert.equal(report.removedRunDir, true);
  });

  // PINS: `ok` must mean "this pass enumerated", not "the command exited 0".
  // On a host missing awk/sed/tr every row is skipped and the shell still exits
  // 0 — zero rows would read as a clean namespace with everything alive. The
  // scanning shell is itself a process in /proc, so a pass that cannot see its
  // OWN pid saw nothing.
  test('realProcScan requires its own pid in its own output', async () => {
    const { passEnumerated } = await import('../src/systems/fuse/procScan.ts');
    assert.equal(passEnumerated('canary\t4242\n4242\t111\tmnt:[1]\t\t\n'), true);
    assert.equal(passEnumerated('canary\t4242\n'), false, 'no data row for the canary pid');
    assert.equal(passEnumerated('4242\t111\tmnt:[1]\t\t\n'), false, 'no canary at all');
    assert.equal(passEnumerated(''), false);
  });

  // PINS: the mid-teardown record re-read happens immediately before the
  // delete, not ~750 ms of scanning earlier. A record written during that
  // window would otherwise be deleted over.
  test('a mount.json appearing after the scan is still not deleted over', async () => {
    const { rundir, record } = await seedRun({}, { intentOnly: true });
    const driver = fakeDriver({ procs: {}, nsMounts: [], conns: [] });
    // The bootstrap finishes its handshake LATE — after the enumeration, during
    // the mount-vantage reads.
    let armed = false;
    const orig = driver.readMounts;
    driver.readMounts = async (pid) => {
      if (armed) { armed = false; await fs.writeFile(path.join(rundir, 'mount.json'), JSON.stringify({ ...record, stage: 'mounted' })); }
      return orig(pid);
    };
    const scan = async (opts) => { armed = true; return driver.scan(opts); };
    const report = await runTeardown({ rundir, driver, scan, log: { warn() {} } });
    assert.equal(report.removedRunDir, false, 'deleted over a record that appeared after the scan');
    await fs.stat(path.join(rundir, 'mount.json'));
  });

  // PINS: the wedge write may not CREATE the run directory. `writeJsonAtomic`
  // mkdir -p's its parent, so a concurrent clean pass's rm landing between the
  // existence check and the write resurrects an orphan record — narrowing that
  // window is not closing it.
  test('a wedge write into a vanished run directory fails rather than recreating it', async () => {
    const { rundir, record } = await seedRun();
    const driver = fakeDriver({ procs: liveBoth(), nsMounts: [], conns: ['77'], undead: new Set([DAEMON]) });
    // Vanishes at the last possible moment: after the verdict, as the wedge is
    // being reported.
    const report = await runTeardown({
      rundir, driver, scan: driver.scan,
      log: { warn() { rmSync(rundir, { recursive: true, force: true }); } },
    });
    void record;
    assert.equal(report.wedged, true);
    await assert.rejects(() => fs.stat(rundir), 'the wedge write resurrected the reclaimed directory');
  });

  // PINS: `survivingPids` ALONE. No fixture reached it while the fake scan
  // enumerated every live process, because a survivor was always also a member.
  // The anchor isolates it: a live DAEMON necessarily also fires terminalState,
  // so it can never be the sole satisfier.
  test('a surviving scan-invisible anchor is a wedge on survivingPids alone', async () => {
    const { rundir } = await seedRun();
    const procs = liveBoth();
    delete procs[WORKER]; delete procs[DAEMON];
    // Alive and recorded, but outside the session's namespace as far as the
    // scan can tell.
    procs[ANCHOR] = { starttime: ANCHOR_START, state: 'S', ns: 'mnt:[elsewhere]' };
    const driver = fakeDriver({ procs, nsMounts: [], conns: [], undead: new Set([ANCHOR]) });
    const report = await runTeardown({ rundir, driver, scan: driver.scan, log: { warn() {} } });

    assert.deepEqual(report.namespaceMembers, [], 'the anchor was visible as a member, so this is not isolated');
    assert.deepEqual(report.residualMounts, []);
    assert.equal(report.enumerated, true);
    assert.equal(report.terminalState, 'GONE', 'terminalState also fired');
    assert.deepEqual(report.markerReclaimed, []);
    assert.deepEqual(report.survivingPids, [`anchor pid ${ANCHOR}`]);
    assert.equal(report.wedged, true);
    assert.equal(report.removedRunDir, false);
  });

  // PINS the production configuration the fake otherwise cannot model: the
  // union daemon is invisible to BOTH scan passes (setfsuid makes it
  // non-dumpable and it never execs afterwards), so a live one is caught only
  // by the recorded-pid check.
  test('a live daemon invisible to the scan is still caught', async () => {
    const { rundir } = await seedRun();
    const procs = liveBoth();
    delete procs[WORKER]; delete procs[ANCHOR];
    procs[DAEMON] = { starttime: DAEMON_START, state: 'S', threads: ['1', '2'], ns: 'mnt:[invisible]' };
    const driver = fakeDriver({ procs, nsMounts: [], conns: [], undead: new Set([DAEMON]) });
    const report = await runTeardown({ rundir, driver, scan: driver.scan, log: { warn() {} } });

    assert.deepEqual(report.namespaceMembers, [], 'the scan saw it, so this does not model the real daemon');
    assert.deepEqual(report.survivingPids, [`daemon pid ${DAEMON}`]);
    assert.equal(report.wedged, true);
    assert.equal(report.removedRunDir, false);
  });

  // PINS: `terminalState` ALONE — the daemon outlives the reap deadline and
  // then dies, which is the interleaving where nothing else fires.
  test('a daemon that outlives its reap deadline and then dies is a wedge on terminalState alone', async () => {
    const { rundir } = await seedRun();
    const procs = liveBoth();
    delete procs[WORKER]; delete procs[ANCHOR];
    procs[DAEMON] = { starttime: DAEMON_START, state: 'S', threads: ['1', '2'], ns: 'mnt:[elsewhere]' };
    const driver = fakeDriver({ procs, nsMounts: [], conns: [], undead: new Set([DAEMON]) });
    // Step 7's scan runs after reapBounded has already returned WEDGED; the
    // daemon finally dies there, so survivingPids is empty.
    const scan = async (opts) => { delete procs[DAEMON]; return driver.scan(opts); };
    const report = await runTeardown({ rundir, driver, scan, log: { warn() {} } });

    assert.match(report.terminalState, /^WEDGED\(threads=2/);
    assert.deepEqual(report.survivingPids, [], 'the daemon was still recorded-alive, so this is not isolated');
    assert.deepEqual(report.namespaceMembers, []);
    assert.deepEqual(report.residualMounts, []);
    assert.equal(report.wedged, true);
    assert.equal(report.removedRunDir, false);
  });

  // PINS: the machine truly never rejects — including through a throwing
  // logger, which sits on the wedge-reporting path after the verdict.
  test('a throwing logger does not reject the machine', async () => {
    const { rundir } = await seedRun();
    const driver = fakeDriver({ procs: liveBoth(), nsMounts: [], conns: ['77'], undead: new Set([DAEMON]) });
    const report = await runTeardown({
      rundir, driver, scan: driver.scan,
      log: { warn() { throw new Error('the operator log is full'); } },
    });
    assert.equal(report.wedged, true);
    assert.equal(report.removedRunDir, false);
  });
});

describe('the boot sweep', () => {
  // The sweep is the backstop for every hard-crash path in this design — the
  // restart, the killed orchestrator, the two synchronous shutdowns that cannot
  // run an async teardown. Its own branches were reached only through the real
  // gate's happy path.
  let prev, runRoot;
  before(async () => {
    prev = process.env.PROJECTS_ROOT;
    process.env.PROJECTS_ROOT = path.join(await mkdtemp('cc-fuse-sweep-'), 'projects');
    const { fuseRunRoot } = await import('../src/systems/fuse/plan.ts');
    runRoot = fuseRunRoot();
  });
  after(() => { if (prev === undefined) delete process.env.PROJECTS_ROOT; else process.env.PROJECTS_ROOT = prev; });

  const seedEntry = async (id, record) => {
    const dir = path.join(runRoot, id);
    await fs.mkdir(dir, { recursive: true });
    await fs.writeFile(path.join(dir, 'mount.json'), JSON.stringify({
      schema: 1, stage: 'mounted', instanceId: id, ccBootId: 'old', rundir: dir,
      root: path.join(dir, 'root'), mirror: path.join(dir, 'mirror'), fusectl: path.join(dir, 'fusectl'),
      nsMntId: NS, bootstrapPid: 0, bootstrapStart: '', anchorPid: 0, anchorStart: '',
      daemonPid: 0, daemonStart: '', minor: '', spawnedAt: 1, mountedAt: 2, ...record,
    }));
    return dir;
  };
  // AN INTENT-ONLY ENTRY — a crash BEFORE the bootstrap's handshake, which is
  // the shape the sweep exists for. It matters here because `runTeardown` then
  // pushes a `NO-RECORD: …` note ALONGSIDE the harvest's `cc-fuse: …` one, and
  // that is the only shape in which the operator line's `cc-fuse: ` filter has
  // two notes to choose between.
  const seedIntentOnly = async (id) => {
    const dir = path.join(runRoot, id);
    await fs.mkdir(dir, { recursive: true });
    await fs.writeFile(path.join(dir, 'intent.json'), JSON.stringify({
      schema: 1, instanceId: id, ccBootId: 'old', rundir: dir,
      root: path.join(dir, 'root'), mirror: path.join(dir, 'mirror'),
      fusectl: path.join(dir, 'fusectl'), spawnedAt: 1,
    }));
    return dir;
  };
  const emptyScan = async () => ({ ok: true, raw: '' });

  // PINS: A CRASHED SESSION'S POLICY EVENTS REACH THE OPERATOR LOG — plan §4b's
  // THIRD surface, and the only one that can serve this case. The other two are
  // the session's own stderr stream and the spawn-failure message, and a
  // session lost to a crash has neither: its stream is gone and no launch is
  // waiting. This boot is the one place its events are ever read aloud.
  //
  // ON THE CLEAN PATH SPECIFICALLY. The wedged arm already prints `notes`, so
  // asserting there would pass against a deleted block; a reclaimed session
  // prints only the `reclaimed …` line unless this fires.
  // DIES UNDER: deleting the `!report.wedged && report.eventPaths.length` block
  // in sweep.ts; dropping the `eventPaths.length` condition (the second arm
  // below counts the lines); dropping the `cc-fuse: ` filter (the THIRD arm,
  // which is the only shape where `notes` carries anything else); moving the
  // harvest after the reclaim (the log would be gone and `eventPaths` empty).
  //
  // NOT `dropping the filter so it prints nothing` — that was claimed for one
  // round and is behaviour-identical wherever `notes` holds the event sentence
  // ALONE, which is every mount.json-backed session. The third arm is what
  // makes the filter's mutant distinguishable at all.
  test('a crashed session’s policy events reach the operator log', async () => {
    const { sweepFuseSessions } = await import('../src/systems/fuse/sweep.ts');
    const EVENTS = 'deny\tgetattr\t/lib/x86_64-linux-gnu/libtinfo.so.6\tunpinned-fail-closed\t7\t7\tclaude\tclaude\n';
    const sweep = async () => {
      const warned = [];
      const reports = await sweepFuseSessions({ driver: fakeDriver(), scan: emptyScan, log: { warn: (...a) => warned.push(a.join(' ')) } });
      return { warned, reports };
    };

    // ── 1. THE LINE EXISTS, ON THE CLEAN PATH, AND CARRIES THE REPAIR ───────
    const dir = await seedEntry('events-1');
    await fs.writeFile(path.join(dir, 'events.log'), EVENTS);
    const a = await sweep();
    // The precondition: this is the CLEAN path, so the wedged arm — which
    // prints `notes` wholesale — is not what produced the line below.
    assert.equal(a.reports[0].wedged, false, JSON.stringify(a.reports[0]));
    assert.equal(a.reports[0].removedRunDir, true);
    const line = a.warned.find(w => w.includes('libtinfo.so.6'));
    assert.ok(line, `no operator-log line named the refused path: ${a.warned.join(' | ')}`);
    // AND IT CARRIES THE REPAIR, not just the path — the whole point of the
    // surface is that stderr already said "cannot open shared object file".
    assert.match(line, /add \/usr\/lib\/x86_64-linux-gnu\/libtinfo\.so\.6 to LOADER_OBJECTS/, line);
    assert.ok(line.includes('events-1'), `the line does not name the session: ${line}`);

    // ── 2. A SESSION WITH NO EVENTS PRINTS EXACTLY ONE LINE ─────────────────
    // COUNTED, not filtered, and that is the difference between this and the
    // control it replaces. Asserting merely that no line mentions
    // `tierTable.ts` passes against a dropped `eventPaths.length` condition,
    // because the emitted line would then be `cc-fuse sweep: <id> — ` with an
    // empty join — present, and matching no content assertion. The COUNT sees
    // it.
    await seedIntentOnly('events-2');
    const b = await sweep();
    const forB = b.warned.filter(w => w.includes('events-2'));
    assert.equal(forB.length, 1,
      `a session with no events should print only its reclaim line: ${JSON.stringify(forB)}`);
    assert.match(forB[0], /reclaimed events-2|events-2 →/, forB[0]);

    // ── 3. THE `cc-fuse: ` FILTER, IN THE ONE SHAPE THAT CAN SEE IT ─────────
    // An INTENT-ONLY directory is a crash before the handshake, and
    // `runTeardown` pushes `NO-RECORD: no mount.json …` for it — so `notes`
    // holds a second entry and the filter has something to exclude. Without the
    // filter that sentence rides into the operator's pin instruction, which is
    // where a reader looks for a path to add to an array.
    const dir3 = await seedIntentOnly('events-3');
    await fs.writeFile(path.join(dir3, 'events.log'), EVENTS);
    const c = await sweep();
    const line3 = c.warned.find(w => w.includes('events-3') && w.includes('libtinfo.so.6'));
    assert.ok(line3, `the intent-only session emitted no event line: ${c.warned.join(' | ')}`);
    // The note really is there to be excluded — asserted on the report, so this
    // arm cannot pass vacuously against a runTeardown that stopped pushing it.
    const report3 = c.reports.find(r => r.instanceId === 'events-3');
    // CLEAN, ASSERTED — and this one is load-bearing rather than tidy: the
    // WEDGED arm joins `notes` WHOLESALE, so a wedged events-3 would emit a
    // line containing both `libtinfo.so.6` and `NO-RECORD`, and the filter
    // assertion below would be reading the wrong line entirely.
    assert.equal(report3.wedged, false, JSON.stringify(report3));
    assert.ok(report3.notes.some(n => n.startsWith('NO-RECORD:')),
      `the intent-only path no longer produces a NO-RECORD note, so the filter has nothing to exclude and this arm proves nothing: ${JSON.stringify(report3.notes)}`);
    assert.doesNotMatch(line3, /NO-RECORD/,
      `the operator line carries an unfiltered note: ${line3}`);
  });

  // PINS: a dead entry is reclaimed and reported. An instance id is a fresh
  // uuid per process, so everything here at boot is dead by construction.
  test('reclaims a dead record and says what it did', async () => {
    const { sweepFuseSessions } = await import('../src/systems/fuse/sweep.ts');
    const dir = await seedEntry('dead-1');
    const warned = [];
    const reports = await sweepFuseSessions({ driver: fakeDriver(), scan: emptyScan, log: { warn: (...a) => warned.push(a.join(' ')) } });
    assert.equal(reports.length, 1);
    assert.equal(reports[0].instanceId, 'dead-1');
    assert.equal(reports[0].removedRunDir, true);
    await assert.rejects(() => fs.stat(dir));
    assert.ok(warned.some(w => w.includes('reclaimed dead-1')), warned.join(' | '));
  });

  // PINS: a LIVE session's directory is not touched. The sweep runs at boot
  // where there are none, but the parameter exists and a sweep that ignored it
  // would tear down a running worker.
  // T3. PINS the readdir loop's `keep.has(name)` keying,
  // where `keep` is derived through `fuseRunDirName`.
  //
  // FULL UUIDS, AND THAT IS THE WHOLE POINT. Under a 6-character id like
  // `'live-1'` the truncated name and the whole id are the SAME STRING, so such
  // a fixture is green against the prefix shape and against the identity alike,
  // and kills neither a truncation mutant nor a mutant deleting the
  // `fuseRunDirName` derivation. With a real uuid a truncated `keep` entry no
  // longer matches the directory on disk and the live session is torn down
  // under itself.
  //
  // TWO ENTRIES, because "skipped" alone passes against a sweep that does
  // nothing at all: B is the control that proves the pass ran.
  test('T3: skips a live session id entirely, and reclaims the dead one beside it', async () => {
    const { sweepFuseSessions } = await import('../src/systems/fuse/sweep.ts');
    const liveId = randomUUID(), deadId = randomUUID();
    assert.equal(liveId.length, 36, 'a short id makes truncation invisible');
    const live = await seedEntry(liveId);
    const dead = await seedEntry(deadId);
    const driver = fakeDriver();
    const reports = await sweepFuseSessions({ driver, scan: emptyScan, liveIds: [liveId], log: { warn() {} } });
    assert.deepEqual(reports.map(r => r.instanceId), [deadId], 'the wrong set of sessions was swept');
    await fs.stat(path.join(live, 'mount.json'));
    assert.equal(await fs.stat(dead).then(() => true, () => false), false, 'the dead session survived the sweep');
    await fs.rm(live, { recursive: true, force: true });
    await fs.rm(dead, { recursive: true, force: true });
  });

  // PINS: a wedged entry is REPORTED and its record KEPT, so the next boot
  // re-reports it rather than silently rediscovering it.
  test('reports a wedged entry and leaves its record in place', async () => {
    const { sweepFuseSessions } = await import('../src/systems/fuse/sweep.ts');
    const dir = await seedEntry('wedged-1', { daemonPid: 7001, daemonStart: '700100', minor: '5' });
    const procs = { 7001: { starttime: '700100', state: 'S', threads: ['1', '2'], ns: 'mnt:[elsewhere]' } };
    const driver = fakeDriver({ procs, nsMounts: [], conns: [], undead: new Set([7001]) });
    const warned = [];
    const reports = await sweepFuseSessions({ driver, scan: driver.scan, log: { warn: (...a) => warned.push(a.join(' ')) } });
    assert.equal(reports[0].wedged, true);
    assert.equal(reports[0].removedRunDir, false);
    const kept = JSON.parse(await fs.readFile(path.join(dir, 'mount.json'), 'utf8'));
    assert.equal(kept.wedged, true);
    assert.ok(warned.some(w => w.includes('wedged-1') && w.includes('WEDGED')), warned.join(' | '));
    await fs.rm(dir, { recursive: true, force: true });
  });

  // PINS: one entry's outcome does not stop the others. The sweep must never
  // let a directory it cannot reclaim cost a boot.
  test('a wedged entry does not stop a clean one beside it', async () => {
    const { sweepFuseSessions } = await import('../src/systems/fuse/sweep.ts');
    const bad = await seedEntry('stuck-2', { daemonPid: 7002, daemonStart: '700200' });
    const good = await seedEntry('clean-2');
    const procs = { 7002: { starttime: '700200', state: 'S', threads: ['1', '2'], ns: 'mnt:[elsewhere]' } };
    const driver = fakeDriver({ procs, nsMounts: [], conns: [], undead: new Set([7002]) });
    const reports = await sweepFuseSessions({ driver, scan: driver.scan, log: { warn() {} } });
    assert.equal(reports.length, 2);
    assert.equal(reports.find(r => r.instanceId === 'clean-2').removedRunDir, true);
    await assert.rejects(() => fs.stat(good));
    await fs.stat(path.join(bad, 'mount.json'));
    await fs.rm(bad, { recursive: true, force: true });
  });

  // PINS: a boot that could not enumerate says so. Silence here is the
  // "clean because nothing was seen" that this whole round is about.
  test('an unenumerable boot warns that it cannot claim the store is clean', async () => {
    const { sweepFuseSessions } = await import('../src/systems/fuse/sweep.ts');
    const warned = [];
    await sweepFuseSessions({
      driver: fakeDriver(), scan: async () => ({ ok: false, raw: '' }),
      log: { warn: (...a) => warned.push(a.join(' ')) },
    });
    assert.ok(warned.some(w => w.includes('cannot claim the store is clean')), warned.join(' | '));
  });

  // PINS: no run root at all — an install that has never spawned a FUSE worker
  // — is not an error and not a warning.
  test('a store with no run root sweeps to nothing, quietly', async () => {
    const { sweepFuseSessions } = await import('../src/systems/fuse/sweep.ts');
    const saved = process.env.PROJECTS_ROOT;
    process.env.PROJECTS_ROOT = path.join(await mkdtemp('cc-fuse-noroot-'), 'nothing-here');
    const warned = [];
    try {
      assert.deepEqual(await sweepFuseSessions({ driver: fakeDriver(), log: { warn: (...a) => warned.push(a.join(' ')) } }), []);
      assert.deepEqual(warned, []);
    } finally { process.env.PROJECTS_ROOT = saved; }
  });
});

describe('the two seams the mutation prover could not reach', () => {
  // PINS: `ok` is false when EITHER uid pass fails. This is the requirement the
  // whole fail-closed verdict rests on, and every injected RawScan double
  // bypasses the line that implements it — so it was unobservable in npm test.
  // Injected one level lower, at the command runner.
  const CANARY = (pid) => `${pid}\t111\tmnt:[1]\t\t\ncanary\t${pid}\n`;
  const cases = [
    ['both passes enumerate', CANARY(11), CANARY(12), true],
    ['the unprivileged pass fails', null, CANARY(12), false],
    ['the privileged pass fails — no sudo', CANARY(11), null, false],
    ['neither pass runs', null, null, false],
    ['a pass exits 0 having enumerated nothing', CANARY(11), '', false],
  ];
  for (const [name, own, root, expected] of cases) {
    test(`realProcScan: ${name} → ok=${expected}`, async () => {
      const { makeProcScan } = await import('../src/systems/fuse/procScan.ts');
      const seen = [];
      const scan = makeProcScan(async (cmd) => { seen.push(cmd); return cmd === 'sudo' ? root : own; });
      const { ok } = await scan({ withEnviron: false });
      assert.equal(ok, expected);
      assert.deepEqual(seen.sort(), ['/bin/sh', 'sudo'], 'both uid passes must be attempted');
    });
  }

  // PINS: EPERM means ALIVE. This is the bug that bit arm 5 for real — an
  // unprivileged `kill(pid, 0)` at a root-owned process raises EPERM, and a
  // catch-all reads it as death and stops waiting for a live process. The two
  // synchronous shutdown paths in instances.ts are the callers.
  test('pidIsAlive: only ESRCH is death', async () => {
    const { pidIsAlive } = await import('../src/systems/fuse/driver.ts');
    const raise = (code) => () => { const e = new Error(code); e.code = code; throw e; };
    assert.equal(pidIsAlive(4242, () => {}), true, 'a signal that lands means alive');
    assert.equal(pidIsAlive(4242, raise('ESRCH')), false, 'ESRCH is the only death');
    assert.equal(pidIsAlive(4242, raise('EPERM')), true, 'EPERM is a live process cc may not signal');
    assert.equal(pidIsAlive(4242, raise('EINVAL')), true, 'an unknown errno is not evidence of death');
    assert.equal(pidIsAlive(4242, () => { throw new Error('no code at all'); }), true);
  });
});
