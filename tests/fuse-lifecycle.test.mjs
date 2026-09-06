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
import { promises as fs } from 'node:fs';
import path from 'node:path';
import { mkdtemp } from './tmpRegistry.mjs';
import { runTeardown, DEFAULT_DEADLINES } from '../src/systems/fuse/session.ts';
import { buildTierTable, renderPinsFile, binaryPins, BIND_MOUNTS } from '../src/systems/fuse/tierTable.ts';
import { wrapLaunch } from '../src/systems/fuse/wrap.ts';
import { assertFuseAvailable, REQUIRED_BINARIES } from '../src/systems/fuse/preflight.ts';
import { parseProcStat, unescapeMountPath } from '../src/systems/fuse/driver.ts';

// ── the fake driver ─────────────────────────────────────────────────────────
//
// `procs` maps pid → { starttime, state, threads }. A pid absent from the map
// is gone. `mounts` maps pid → the mountpoints in that pid's namespace.
// Everything is recorded in `calls` in issue order, which is what lets the
// ORDERING claims below be assertions rather than set comparisons.
function fakeDriver({ procs = {}, mounts = {}, conns = [], umountFails = new Set(), abortOk = true, undead = new Set() } = {}) {
  let clock = 0;
  const calls = [];
  const rec = (op, ...args) => calls.push([op, ...args]);
  const d = {
    calls,
    procs,
    mounts,
    // Keyed on the mount table, not on liveness: pid 1's table is readable
    // whether or not pid 1 is in the process fixture.
    async readMounts(pid) { return mounts[pid] ?? null; },
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
      if (umountFails.has(mp) && !lazy) return false;
      if (umountFails.has(mp) && lazy) return false;
      for (const list of Object.values(mounts)) {
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
  };
  return d;
}

// The pids and starttimes every fixture below shares. Distinct starttimes so a
// mismatch is unambiguous.
const WORKER = 4242, WORKER_START = '111111';
const DAEMON = 4243, DAEMON_START = '222222';

async function seedRun(overrides = {}, { intentOnly = false, noRecords = false } = {}) {
  const rundir = await mkdtemp('cc-fuse-run-');
  const record = {
    schema: 1, instanceId: path.basename(rundir), ccBootId: 'boot-1',
    rundir, root: path.join(rundir, 'root'), mirror: path.join(rundir, 'mirror'),
    fusectl: path.join(rundir, 'fusectl'),
    nsMntId: 'mnt:[4026533000]',
    bootstrapPid: WORKER, bootstrapStart: WORKER_START,
    daemonPid: DAEMON, daemonStart: DAEMON_START,
    minor: '77', spawnedAt: 1, mountedAt: 2,
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

const liveBoth = () => ({
  [WORKER]: { starttime: WORKER_START, state: 'S' },
  [DAEMON]: { starttime: DAEMON_START, state: 'S', threads: ['1', '2'] },
});

describe('FUSE teardown state machine (fake driver, virtual clock)', () => {
  // PINS: unmounts are issued deepest-first, and every one of them is issued
  // BEFORE the abort. Both halves matter — a set assertion would pass on the
  // ordering that made S2's own abort a no-op.
  test('unmounts deepest-first, and all of them before the abort', async () => {
    const { rundir, record } = await seedRun();
    const procs = liveBoth();
    const driver = fakeDriver({ procs, mounts: { [DAEMON]: healthyMounts(record), [WORKER]: [], 1: [] }, conns: ['77'] });
    await runTeardown({ rundir, driver, log: { warn() {} } });

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
    const driver = fakeDriver({ procs, mounts: { [DAEMON]: healthyMounts(record), 1: [] }, conns: ['77'], undead: new Set([DAEMON]) });
    await runTeardown({ rundir, driver, log: { warn() {} } });
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
    const driver = fakeDriver({ procs: liveBoth(), mounts: { [DAEMON]: healthyMounts(record), 1: [] }, conns: ['91', '12'] });
    const report = await runTeardown({ rundir, driver, log: { warn() {} } });
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
    const driver = fakeDriver({ procs, mounts: { [DAEMON]: healthyMounts(record), [WORKER]: [], 1: [] }, conns: ['77'], undead: new Set([WORKER]) });
    const report = await runTeardown({ rundir, driver, log: { warn() {} } });
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
      const driver = fakeDriver({ procs, mounts: { [DAEMON]: healthyMounts(record), 1: [] }, conns: ['77'], undead: new Set([DAEMON]) });
      const report = await runTeardown({ rundir, driver, log: { warn() {} } });
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
      mounts: { [WORKER]: healthyMounts(record), [DAEMON]: healthyMounts(record), 1: [] },
      conns: ['77'],
    });
    const report = await runTeardown({ rundir, driver, log: { warn() {} } });
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
      procs, mounts: { [DAEMON]: healthyMounts(record), 1: [] }, conns: ['77'],
      // The daemon outlives its SIGKILL, which is what keeps the mount
      // namespace — and therefore the stuck mount — in existence. A namespace
      // whose last process has gone takes its mounts with it, so a wedge with
      // no surviving process is not residue at all.
      umountFails: new Set([stuck]), undead: new Set([DAEMON]),
    });
    const emitted = [], warned = [];
    const report = await runTeardown({
      rundir, driver, emit: ev => emitted.push(ev), log: { warn: (...a) => warned.push(a.join(' ')) },
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
    const driver = fakeDriver({ procs, mounts: { [DAEMON]: healthyMounts(record), 1: [] }, conns: ['77'] });
    const report = await runTeardown({ rundir, driver, log: { warn() {} } });
    assert.equal(report.wedged, false);
    assert.equal(report.removedRunDir, true);
    await assert.rejects(() => fs.stat(rundir));
  });

  // PINS: the two degraded record shapes. Neither may signal anything — with
  // no verified pid there is nothing it would be safe to signal.
  test('mount.json absent falls back to intent.json; both absent is NO-RECORD, and neither signals', async () => {
    const only = await seedRun({}, { intentOnly: true });
    const d1 = fakeDriver({ procs: liveBoth(), mounts: { 1: [] } });
    const r1 = await runTeardown({ rundir: only.rundir, driver: d1, log: { warn() {} } });
    assert.equal(r1.source, 'intent.json');
    assert.deepEqual(d1.calls.filter(c => c[0] === 'signal'), []);
    assert.deepEqual(d1.calls.filter(c => c[0] === 'abort'), []);

    const none = await seedRun({}, { noRecords: true });
    const d2 = fakeDriver({ procs: liveBoth(), mounts: { 1: [] } });
    const r2 = await runTeardown({ rundir: none.rundir, driver: d2, log: { warn() {} } });
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
    const driver = fakeDriver({ procs, mounts: { [DAEMON]: healthyMounts(record), 1: [] }, conns: ['56', '59', '77'] });
    const report = await runTeardown({ rundir, driver, log: { warn() {} } });
    assert.equal(report.strayConnections, 2);
    assert.deepEqual(driver.calls.filter(c => c[0] === 'abort'), [['abort', '77']]);
  });

  // PINS: the abort is not attempted when the connection is not listed — that
  // is ABORT-UNAVAILABLE, a note, and the machine carries on.
  test('a minor with no fusectl entry is ABORT-UNAVAILABLE and does not stop teardown', async () => {
    const { rundir, record } = await seedRun();
    const procs = liveBoth();
    delete procs[WORKER];
    const driver = fakeDriver({ procs, mounts: { [DAEMON]: healthyMounts(record), 1: [] }, conns: ['56'] });
    const report = await runTeardown({ rundir, driver, log: { warn() {} } });
    assert.equal(report.abort, 'ABORT-UNAVAILABLE');
    assert.deepEqual(driver.calls.filter(c => c[0] === 'abort'), []);
    assert.ok(driver.calls.some(c => c[0] === 'signal' && c[1] === DAEMON), 'the daemon ladder did not run');
  });

  // PINS: the daemon is signalled through sudo (it is root-owned and is not
  // cc's child); the worker is signalled directly (privilege was dropped back
  // to cc's uid before the CLI was exec'd).
  test('the daemon is signalled privileged and the worker is not', async () => {
    const { rundir, record } = await seedRun();
    const driver = fakeDriver({ procs: liveBoth(), mounts: { [DAEMON]: healthyMounts(record), [WORKER]: [], 1: [] }, conns: ['77'] });
    await runTeardown({ rundir, driver, log: { warn() {} } });
    const sigs = driver.calls.filter(c => c[0] === 'signal');
    for (const [, pid, , mode] of sigs) {
      assert.equal(mode, pid === DAEMON ? 'sudo' : 'direct', `pid ${pid} signalled ${mode}`);
    }
    assert.ok(sigs.some(c => c[1] === DAEMON), 'the daemon was never signalled');
  });

  // PINS: /proc/1/mounts is checked, not just the namespace's own table — it is
  // the one that says whether anything escaped the private namespace at all.
  test('a mount visible in pid 1 is residue even when the namespace table is clean', async () => {
    const { rundir, record } = await seedRun();
    const procs = liveBoth();
    delete procs[WORKER];
    const escaped = path.join(record.root, 'sys');
    const driver = fakeDriver({ procs, mounts: { [DAEMON]: [], 1: [escaped] }, conns: ['77'] });
    const report = await runTeardown({ rundir, driver, log: { warn() {} } });
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
    cwdInside: '/srv/app', mountOpts: 'allow_other,attr_timeout=0',
    tiers: [], pinsText: '', uid: 1000, gid: 1000,
    standInSource: '/srv/app', standInAt: '/store/run/inst-1/mirror/srv/app',
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

  // PINS: no stand-in ⇒ no stand-in variables, so the bootstrap's bind is
  // skipped rather than run against an empty path.
  test('omits the stand-in variables when there is no stand-in source', () => {
    const w = wrapLaunch({ command: 'claude', args: [], cwd: '/x', env: {} },
      { plan: { ...plan, standInSource: null, standInAt: null }, unionBinary: '/b', ccBootId: 'b', spawnedAt: 0 });
    assert.equal(w.env.CC_FUSE_STANDIN_SRC, undefined);
    assert.equal(w.env.CC_FUSE_STANDIN_AT, undefined);
  });
});

describe('the tier table', () => {
  const input = {
    localRoots: ['/store/attachments/app', '/store/session-tmp/inst-1', '/home/node/.claude', '/home/node/.claude/projects', '/opt/plugins/p1'],
    claudeCommand: '/usr/local/share/npm-global/bin/claude',
    execPath: '/usr/local/bin/node',
    selfProjectDir: '/workspaces/cc-projects/code-conductor',
    projectsRoot: '/workspaces/cc-projects',
    homeDir: '/home/node',
    runDir: '/workspaces/cc-projects/.code-conductor/systems/fuse/run/inst-1',
    systemPath: '/srv/app',
  };
  const tierOf = (entries, prefix) => entries.find(e => e.prefix === prefix)?.tier;

  // PINS: the three pins whose absence is a behaviour change under the frozen
  // daemon's remote-first `default` arm — every one of them would otherwise be
  // answered by whatever the remote happens to hold.
  test('node, the projects root and every localRoot are host-pinned', () => {
    const t = buildTierTable(input);
    assert.equal(tierOf(t, '/usr/local/bin/node'), 'host');
    assert.equal(tierOf(t, '/workspaces/cc-projects'), 'host');
    assert.equal(tierOf(t, '/workspaces/cc-projects/code-conductor'), 'host');
    assert.equal(tierOf(t, '/home/node'), 'host');
    for (const r of input.localRoots) assert.equal(tierOf(t, r), 'host', r);
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

  // PINS: the epic's "two mechanisms, never one list". Both directions.
  test('the bind-mount set is not in the table, and no input changes it', () => {
    const t = buildTierTable(input);
    for (const b of BIND_MOUNTS) assert.equal(tierOf(t, b), undefined, `${b} appears as a tier`);
    assert.deepEqual([...BIND_MOUNTS], ['/proc', '/sys', '/dev']);
    // A provider that excludes nothing, and one that excludes something odd,
    // leave the bind set identical — it is a constant, not a derivation.
    const before = [...BIND_MOUNTS];
    buildTierTable({ ...input, systemPath: '/var/lib/secrets' });
    assert.deepEqual([...BIND_MOUNTS], before);
  });

  // PINS: a prefix appearing twice keeps its FIRST decision, so the table's
  // meaning cannot depend on construction order.
  test('a duplicate prefix keeps its first tier', () => {
    const t = buildTierTable({ ...input, localRoots: [...input.localRoots, '/home/node'] });
    assert.deepEqual(t.filter(e => e.prefix === '/home/node').length, 1);
    assert.equal(tierOf(t, '/home/node'), 'host');
  });

  // PINS: the npm-global chain. Pinning the leaves alone left every parent
  // directory in the chain falling back on a getattr.
  test('a binary pins its install prefix, not just the leaf', () => {
    const pins = binaryPins('/usr/local/share/npm-global/bin/claude');
    assert.ok(pins.includes('/usr/local/share/npm-global/bin/claude'));
    // The install prefix is the common ancestor of the launcher and its target;
    // with no symlink to follow it is the bin directory itself.
    assert.ok(pins.some(p => p === '/usr/local/share/npm-global/bin' || p === '/usr/local/share/npm-global'), pins.join(' '));
    assert.deepEqual(binaryPins('claude'), [], 'a non-absolute command pins nothing');
  });

  // PINS: the rendered file is what union.c's pins_load actually parses —
  // `<tier>\t<prefix>` with `#` comments.
  test('renders one tab-separated rule per line, with comments', () => {
    const text = renderPinsFile([{ tier: 'host', prefix: '/etc/passwd', why: 'identity' }, { tier: 'hide', prefix: '/run/x', why: 'scaffolding' }]);
    const rules = text.split('\n').filter(l => l && !l.startsWith('#'));
    assert.deepEqual(rules, ['host\t/etc/passwd', 'hide\t/run/x']);
    assert.ok(text.split('\n').some(l => l.startsWith('# identity')));
  });
});

describe('the criterion-9 refusal', () => {
  const ok = {
    devFuseIsCharDevice: async () => true,
    sudoNonInteractive: async () => true,
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

  // PINS: a remote root that CONTAINS the mount must be refused BEFORE anything
  // is mounted. It deadlocks in VFS path resolution before the daemon is
  // consulted, so no daemon-side guard can ever catch it.
  test('refuses a stand-in source that contains the mountpoint', async () => {
    const { buildFusePlan, fuseRunDir } = await import('../src/systems/fuse/plan.ts');
    const rundir = fuseRunDir('inst-x');
    const args = { instanceId: 'inst-x', cwdInside: '/srv/app', systemPath: '/srv/app', localRoots: [], claudeCommand: 'claude' };
    assert.throws(() => buildFusePlan({ ...args, standInSource: path.dirname(path.dirname(rundir)) }), (e) => {
      assert.equal(e.code, 'FUSE_MIRROR_CONTAINS_MOUNT');
      assert.equal(e.statusCode, 501);
      return true;
    });
    // The same call with a stand-in that does NOT contain the mountpoint is the
    // control: without it the refusal above could be unconditional.
    const plan = buildFusePlan({ ...args, standInSource: '/srv/app' });
    assert.equal(plan.standInAt, path.join(plan.mirror, '/srv/app'));
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
