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
import { runTeardown, DEFAULT_DEADLINES } from '../src/systems/fuse/session.ts';
import { buildTierTable, renderPinsFile, binaryPins, resolveOnPath, resolveTierEntry, BIND_MOUNTS } from '../src/systems/fuse/tierTable.ts';
import { wrapLaunch } from '../src/systems/fuse/wrap.ts';
import { assertFuseAvailable, REQUIRED_BINARIES } from '../src/systems/fuse/preflight.ts';
import { parseProcStat, unescapeMountPath } from '../src/systems/fuse/driver.ts';
import { reclaimOrphanProcesses } from '../src/systems/fuse/orphans.ts';
import { parseScan, membersOf, orphansUnder } from '../src/systems/fuse/procScan.ts';
import { FuseSession } from '../src/systems/fuse/session.ts';
import { tierFixtureInput } from './tierFixture.mjs';

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
  // BEFORE the abort. Both halves matter — a set assertion would pass on the
  // ordering that made S2's own abort a no-op.
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

  // PINS: S3 §A5 — a count of fusectl entries is not a count of live daemons.
  // Stale minors are COUNTED and never aborted.
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
  // failed launch leaves, and the one that used to signal nothing at all.
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
    refusalLog: '/store/run/inst-1/refusals.log',
    controlSock: '/store/run/inst-1/control.sock',
    markPath: '/usr/local/bin/claude',
    cwdInside: '/srv/app', mountOpts: 'allow_other,attr_timeout=0',
    tiers: [], pinsText: '', uid: 1000, gid: 1000,
    fakeRemoteRoot: '/',
  };
  const wrapped = () => wrapLaunch(
    { command: 'claude', args: ['-p', 'a prompt\nwith a newline', '--model', 'x'], cwd: '/store/sessions/foo', env: { HOME: '/home/node', PATH: '/opt/bin:/usr/bin' } },
    { plan, unionBinary: '/store/bin/union-abc', ccBootId: 'boot-9', spawnedAt: 5 },
  );

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
    assert.equal(w.env.HOME, '/home/node');
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

  // PINS: the three things the daemon REFUSES TO MOUNT without, carried by
  // name. `bootstrap.sh` renames each into the daemon's own CC_UNION_* prefix,
  // and a missing one is a launch that dies in the mount-wait loop rather than
  // at a named refusal.
  test('carries the control socket, the mark path and the refusal log', () => {
    const w = wrapped();
    assert.equal(w.env.CC_FUSE_CONTROL, plan.controlSock);
    assert.equal(w.env.CC_FUSE_MARK_PATH, plan.markPath);
    assert.equal(w.env.CC_FUSE_REFUSAL_LOG, plan.refusalLog);
  });
});

describe('the tier table', () => {
  // `localRoots` are DECLARATIONS now (S2 §4.2): each carries the bit the hook
  // reads. Every one is still host-pinned for the daemon whatever the bit says,
  // which is what the first test below asserts.
  const input = {
    localRoots: [
      { prefix: '/store/attachments/app', access: 'allow', why: 'uploads' },
      { prefix: '/store/session-tmp/inst-1', access: 'allow', why: 'own tmp' },
      { prefix: '/home/node/.claude/plans', access: 'allow', why: 'plan mode writes here' },
      { prefix: '/home/node/.claude', access: 'deny', why: 'the CLI\'s own state' },
      { prefix: '/home/node/.claude/projects', access: 'deny', why: 'every session\'s transcripts' },
      { prefix: '/opt/plugins/p1', access: 'allow', why: 'a plugin root' },
    ],
    claudeCommand: '/usr/local/share/npm-global/bin/claude',
    execPath: '/usr/local/bin/node',
    selfProjectDir: '/workspaces/cc-projects/code-conductor',
    projectsRoot: '/workspaces/cc-projects',
    homeDir: '/home/node',
    runDir: '/workspaces/cc-projects/.code-conductor/systems/fuse/run/inst-1',
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
    assert.equal(tierOf(t, '/workspaces/cc-projects'), 'host');
    assert.equal(tierOf(t, '/workspaces/cc-projects/code-conductor'), 'host');
    assert.equal(tierOf(t, '/home/node'), 'host');
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

  // ── A11/A12: the epic's "two mechanisms, never one list" ──────────────────
  //
  // DELIBERATELY INVERTED FROM S1, which asserted `tierOf(t, b) === undefined`.
  // S1 kept BIND_MOUNTS out of the table because the frozen daemon had no kind
  // for them; S2 has to tell the daemon those three paths exist as directories,
  // because `bootstrap.sh` binds OVER them and a `mount --bind` onto a target
  // the daemon answers -ENOENT for kills the launch (S2 §4.3, §13 K4). The
  // never-merge rule is unchanged and is now asserted as what it always was —
  // a claim about DERIVATION, not about absence: each kind comes from exactly
  // one source and no input to one moves the other.
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
    const t = buildTierTable({ ...input, localRoots: [...input.localRoots, { prefix: '/home/node', access: 'allow', why: 'a second spelling of the home pin' }] });
    assert.deepEqual(t.filter(e => e.prefix === '/home/node').length, 1);
    assert.equal(tierOf(t, '/home/node'), 'host');
  });

  // PINS: the interpreter chain bootstrap.sh execs INSIDE the union as root,
  // before the privilege drop. Deleting the loop that adds these leaves every
  // other assertion in this file green.
  test("the bootstrap's interpreter chain is host-pinned, in every spelling", () => {
    const t = buildTierTable(input);
    for (const p of ['/bin/sh', '/usr/bin/sh', '/bin/dash', '/usr/bin/dash',
      '/bin/bash', '/usr/bin/bash', '/usr/bin/setpriv', '/bin/setpriv']) {
      assert.equal(tierOf(t, p), 'host', p);
    }
  });

  // PINS one layer further down: the ELF interpreter baked into those binaries
  // and setpriv's own NEEDED set. On a merged-usr host `/lib` and `/lib64` are
  // symlinks to `/usr/lib` and `/usr/lib64`, but the table matches PATH
  // STRINGS — so the `/lib64` spelling the ELF header actually requests has to
  // be named, not merely implied by the `/usr/lib64` one.
  test('the loader is pinned in the spelling the ELF header requests', () => {
    const t = buildTierTable(input);
    for (const p of [
      '/lib64/ld-linux-x86-64.so.2',            // the requested program interpreter
      '/usr/lib64/ld-linux-x86-64.so.2',
      '/lib/x86_64-linux-gnu/libc.so.6',
      '/usr/lib/x86_64-linux-gnu/libc.so.6',
      '/lib/x86_64-linux-gnu/libcap-ng.so.0',   // setpriv's, and in no earlier list
      '/usr/lib/x86_64-linux-gnu/libcap-ng.so.0',
    ]) {
      assert.equal(tierOf(t, p), 'host', p);
    }
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
describe('the mount literals', () => {
  // A16 — PINS the sha pin as a DELIBERATE-EDIT LATCH. `union.c` is a fork of
  // the frozen spike instrument and diverges from it by design, one PROVENANCE.md
  // ledger row at a time; editing it without regenerating the pin in the same
  // commit is the undisclosed drift this catches. Needs no compiler, so it runs
  // everywhere — and it iterates the pin file's ROWS, so it covers `policy.h`
  // the moment Phase B adds a second line.
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
  // chroot and has no spelling inside it. `rundir` is tiered `hide`, so the
  // union answers -ENOENT for its own backing store; moving `mirror` under
  // `root` would put the remote tier's backing store inside the tree it backs.
  test('A18: the mirror is under rundir, not under root, and rundir is hidden', async () => {
    const { buildFusePlan, fuseRunDir } = await import('../src/systems/fuse/plan.ts');
    const plan = buildFusePlan({
      instanceId: 'inst-a18', cwdInside: '/srv/app',
      fakeRemoteRoot: '/', markPath: '/usr/bin/claude',
      tiers: buildTierTable(tierFixtureInput({ runDir: fuseRunDir('inst-a18') })),
    });
    assert.equal(path.dirname(plan.mirror), plan.rundir);
    assert.equal(path.dirname(plan.root), plan.rundir);
    assert.equal(plan.mirror.startsWith(plan.root + path.sep), false, 'the mirror is inside the chroot');
    assert.equal(plan.tiers.find(e => e.prefix === plan.rundir)?.tier, 'hide');
    // And nothing inside the chroot can name it: the pins file's only mention of
    // the run directory is the `hide` rule itself.
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
  // and reads it from `<fakeRemoteRoot>/P`. Where the mirror lies inside the
  // source root, some P resolves back into the mirror and cc serves its own
  // staging area to the worker as remote content.

  // Arm (b). Mutation it must die under: deleting the containment check.
  test('A20b: a non-/ remote root containing the mirror is refused', async () => {
    const { buildFusePlan, fuseRunDir } = await import('../src/systems/fuse/plan.ts');
    const rundir = fuseRunDir('inst-x');
    assert.throws(() => buildFusePlan({ ...planArgs, fakeRemoteRoot: path.dirname(path.dirname(rundir)) }), (e) => {
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
    const plan = buildFusePlan({ ...planArgs, fakeRemoteRoot: '/srv/app' });
    assert.equal(plan.fakeRemoteRoot, '/srv/app');
  });

  // Arm (a). THE DEFAULT ROOT, and it is the arm that makes the exemption
  // provable: `/` contains the mirror like it contains everything, so without
  // this a mutant deleting the `/` exemption would survive untouched — and
  // every default launch would 501.
  //
  // Mutation it must die under: `input.fakeRemoteRoot === '/' ? null : …`
  // collapsed to the bare containment check.
  test('A20a: the default remote root / is accepted', async () => {
    const { buildFusePlan, resolveFakeRemoteRoot } = await import('../src/systems/fuse/plan.ts');
    assert.equal(resolveFakeRemoteRoot(), '/', 'the default is the host filesystem standing in for the remote');
    const plan = buildFusePlan({ ...planArgs, fakeRemoteRoot: resolveFakeRemoteRoot() });
    assert.equal(plan.fakeRemoteRoot, '/');
  });

  // AND WHY `/` IS SAFE, as data rather than as prose. At root `/`,
  // `<fakeRemoteRoot>/P` IS P, so cc reads the mirror only for a P at or inside
  // the mirror. Every such P resolves `hide`, and `route()` answers -ENOENT for
  // a `hide` path before any control frame is sent — so no such P ever reaches
  // cc. Asserted at the WIDEST advertised mirror root, `/`, which is the only
  // setting under which the question is live at all.
  //
  // Mutation it must die under: dropping the `hide` pin on `runDir` from
  // buildTierTable — the mirror then resolves `project` under the `/` pin and
  // becomes a path cc would be asked to materialise from itself.
  test('A20: at root /, no path cc could be asked about resolves into the mirror', async () => {
    const { fuseRunDir } = await import('../src/systems/fuse/plan.ts');
    const runDir = fuseRunDir('inst-a20');
    const mirror = path.join(runDir, 'mirror');
    const tiers = buildTierTable(tierFixtureInput({ runDir, mirrorRoot: '/' }));
    const at = (p) => resolveTierEntry(tiers, p)?.tier ?? 'fail';

    // The mirror, its parent, and anything inside it: hide, so no frame is sent.
    for (const p of [runDir, mirror, path.join(mirror, 'srv'), path.join(mirror, 'srv/app/x.txt'), path.join(mirror, 'etc')]) {
      assert.equal(at(p), 'hide', p);
    }
    // The chain from the projects root down to the run directory is `host`, so
    // no LIST ever names the mirror's parent as a child either. (`/` and the
    // directory holding the projects root DO stay `project` — that is not the
    // hazard: a LIST materialises one level of entries and never descends.)
    const projectsRoot = tierFixtureInput().projectsRoot;
    for (let p = path.dirname(runDir); p.startsWith(projectsRoot); p = path.dirname(p)) {
      assert.equal(at(p), 'host', p);
    }
    assert.equal(at('/'), 'project', 'the widest advertised mirror root is remote-tier');
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
  // mid-handshake — has processes behind it, and used to signal NOBODY and then
  // delete the directory. The handle that survives having no record is the
  // marker the bootstrap's own execve put in their environments.
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
    refusalLog: path.join(rundir, 'refusals.log'),
    controlSock: path.join(rundir, 'control.sock'),
    markPath: '/usr/local/bin/claude',
    cwdInside: '/srv/app', mountOpts: 'o', tiers: [], pinsText: '# pins\n',
    uid: 1000, gid: 1000, fakeRemoteRoot: '/',
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

  test('a live session id is never signalled', async () => {
    const rundir = await mkdtemp('cc-fuse-orphan-');
    const id = path.basename(rundir);
    const driver = fakeDriver({ procs: { 903: { starttime: '999', state: 'S' } }, mounts: { 903: [] } });
    const out = await reclaimOrphanProcesses(path.dirname(rundir), {
      driver, log: { warn() {} }, liveIds: [id], scan: scanOf(row(903, '999', 'mnt:[9]', id, rundir)),
    });
    assert.deepEqual(out.reclaimed, []);
    assert.deepEqual(driver.calls.filter(c => c[0] === 'signal'), []);
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
  const emptyScan = async () => ({ ok: true, raw: '' });

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
  test('skips a live session id entirely', async () => {
    const { sweepFuseSessions } = await import('../src/systems/fuse/sweep.ts');
    const dir = await seedEntry('live-1');
    const driver = fakeDriver();
    const reports = await sweepFuseSessions({ driver, scan: emptyScan, liveIds: ['live-1'], log: { warn() {} } });
    assert.deepEqual(reports, []);
    await fs.stat(path.join(dir, 'mount.json'));
    assert.deepEqual(driver.calls, [], 'a live session was touched');
    await fs.rm(dir, { recursive: true, force: true });
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
