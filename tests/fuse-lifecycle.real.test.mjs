// THE GATE. Skipped by default — opt in with `RUN_FUSE_LIFECYCLE=1`, which
// needs `sudo -n`, /dev/fuse, fusectl, gcc and libfuse3 headers.
//
//   RUN_FUSE_LIFECYCLE=1 node tests/run.mjs tests/fuse-lifecycle.real.test.mjs
//
// Real sudo, real unshare, real FUSE, real mounts, real pids — and a FAKE
// claude binary (`bootServer({realProcess:true})`), because the question is
// about mounts and pids, not about tools. No tokens and no network.
//
// The one question this file exists to answer, and the one that can stop the
// whole effort: can cc spawn a worker inside a private mount namespace with the
// union mounted, and tear it down through its EXISTING lifecycle —
// `kill_instance`, a `kill -9` crash, and an orchestrator restart — leaving no
// mount in /proc/1/mounts and no orphaned daemon?
//
// EVERY ARM CAPTURES A `BEFORE` SNAPSHOT AND ASSERTS A DELTA, so what the run
// leaked is distinguished from what it inherited. This host carries inherited
// FUSE residue from the spikes (S3 §A5: minors 56 and 59, inert, freeing
// nothing), and an absolute assertion would either fail on it or hide a leak
// under it.
//
// PID DISCIPLINE. Every signal in this file targets a numeric pid read out of
// the session's OWN mount.json, re-verified against /proc/<pid>/stat field 22
// immediately before signalling, via killPids (tests/procTree.mjs). There is no
// pkill, no killall, no pgrep, and no pattern of any kind anywhere in this file
// — a previous worker on this ticket killed the devcontainer with a broad kill
// by process name.

import { test, describe, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { promises as fs, readFileSync, existsSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { execFile } from 'node:child_process';
import { bootServer, api, freshProjectsRoot, rmrf, waitFor } from './helpers.mjs';
import { seedRepo } from './remoteSystem.mjs';
import { mkdtemp } from './tmpRegistry.mjs';
import { killPids } from './procTree.mjs';
import { adoptProject } from '../src/projects.ts';
import { addSystem } from '../src/appSettings.ts';
import { disposeSystemHandles } from '../src/systems/registry.ts';
import { EVENT_LOG_NAME, fuseRunDir, fuseRunRoot } from '../src/systems/fuse/plan.ts';
import { scanProcesses, orphansUnder } from '../src/systems/fuse/procScan.ts';
import { assertFuseAvailable } from '../src/systems/fuse/preflight.ts';

const ENABLED = process.env.RUN_FUSE_LIFECYCLE === '1';
const FIXTURE = path.join(path.dirname(fileURLToPath(import.meta.url)), 'fixtures', 'mirrorFixtureProvider.mjs');
const HERE = path.dirname(fileURLToPath(import.meta.url));
// bootServer({realProcess:true}) DELETES FAKE_CLAUDE_SCENARIO unless a scenario
// is given, and fake-claude then exits 2 — which makes every teardown arm pass
// vacuously against a worker that never started.
const SCENARIO = path.join(HERE, 'fixtures', 'scenario-basic.json');

// ── observation helpers. All read-only; none of them selects a pid. ──────────

const mountsOf = (pid) => {
  try { return readFileSync(`/proc/${pid}/mounts`, 'utf8').split('\n').filter(Boolean).map(l => l.split(' ')[1]); }
  catch { return null; }
};
const mountsUnder = (pid, prefix) => (mountsOf(pid) ?? []).filter(m => m === prefix || m.startsWith(prefix + '/'));
// /proc/<pid>/stat field 22 — the identity killPids re-verifies before signalling.
const startOf = (pid) => {
  try {
    const raw = readFileSync(`/proc/${pid}/stat`, 'utf8');
    return raw.slice(raw.lastIndexOf(')') + 2).split(' ')[19];
  } catch { return null; }
};
const alive = (pid, start) => startOf(pid) === start;
const sh = (cmd, args) => new Promise(r => execFile(cmd, args, { timeout: 30_000 }, (e, so, se) =>
  r({ ok: !e, stdout: String(so ?? ''), stderr: String(se ?? '') })));

// The whole-machine snapshot each arm deltas against.
function snapshot(runRoot) {
  return {
    pid1Total: (mountsOf(1) ?? []).length,
    pid1UnderRun: mountsUnder(1, runRoot),
    selfUnderRun: mountsUnder(process.pid, runRoot),
  };
}

async function readRecord(instanceId) {
  try { return JSON.parse(await fs.readFile(path.join(fuseRunDir(instanceId), 'mount.json'), 'utf8')); }
  catch { return null; }
}

// What every teardown arm must be able to say afterwards, stated once.
function assertNoResidue(before, runRoot, record, label) {
  const after = snapshot(runRoot);
  // Printed, not just asserted: the delta IS the evidence this file exists to
  // produce, and a passing assertion shows no numbers.
  console.log(`fuse gate [${label}] /proc/1/mounts ${before.pid1Total} → ${after.pid1Total}`
    + ` (under the run root ${before.pid1UnderRun.length} → ${after.pid1UnderRun.length})`
    + (record ? `; recorded pids worker=${record.bootstrapPid}@${record.bootstrapStart}`
      + ` daemon=${record.daemonPid}@${record.daemonStart} anchor=${record.anchorPid}@${record.anchorStart}`
      + ` minor=${record.minor} → all gone` : ''));
  assert.equal(after.pid1UnderRun.length, before.pid1UnderRun.length,
    `${label}: /proc/1/mounts gained ${JSON.stringify(after.pid1UnderRun)} under the run root`);
  assert.equal(after.pid1Total, before.pid1Total,
    `${label}: /proc/1/mounts line count moved ${before.pid1Total} → ${after.pid1Total}`);
  assert.deepEqual(after.selfUnderRun, before.selfUnderRun, `${label}: cc's own mount table gained entries`);
  if (record) {
    for (const [what, pid, start] of [
      ['daemon', record.daemonPid, record.daemonStart],
      ['anchor', record.anchorPid, record.anchorStart],
      ['worker', record.bootstrapPid, record.bootstrapStart],
    ]) {
      assert.equal(alive(pid, start), false, `${label}: the ${what} (pid ${pid}) is still alive`);
    }
    assert.equal(mountsUnder(record.daemonPid, runRoot).length, 0, `${label}: mounts remain in the daemon's table`);
  }
  return after;
}

describe('a worker inside a FUSE-union chroot: the lifecycle gate', { skip: !ENABLED }, () => {
  let ctx, baseUrl, instances, home, box, runRoot, fakeRemote, prevFakeRemote;
  // Reported, not asserted on: the wall time of a spawn and of one turn, inside
  // the chroot and outside it. S3's "Not measured" section names the cost of
  // attr_timeout=0/entry_timeout=0 as the more important of its two unmeasured
  // costs, and the union serves every page of the CLI binary with no kernel
  // cache. RECORD IT, DO NOT TUNE IT — if it is unusable that is the report,
  // not a reason to reach for kernel_cache.
  const timings = { chroot: [], control: [] };

  before(async () => {
    // Fail loudly and by name rather than producing a red gate that is really a
    // missing dependency. ASSERT, NEVER INSTALL.
    const { ensureUnionBinary } = await import('../src/systems/fuse/build.ts');
    const { realProbes } = await import('../src/systems/fuse/preflight.ts');
    await assertFuseAvailable({ ...realProbes, ensureBinary: ensureUnionBinary });

    // No switch to set: `bootServer({realProcess:true})` injects the REAL
    // launcher, and the union is mandatory for a remote-backed worker on it.
    ctx = await bootServer({ realProcess: true, scenarioPath: SCENARIO });
    ({ baseUrl, instances } = ctx);
    ({ home } = await freshProjectsRoot());
    runRoot = fuseRunRoot();

    // The fake remote is DELIBERATELY NARROW: one project tree and nothing
    // else. The frozen daemon's `default` tier is remote-first (union.c:940),
    // so a wide fake remote would shadow host paths that S1 does not pin —
    // measured in S3 §B2, where a `create` at tier=default landed on the remote
    // and was absent from the host.
    box = await fs.realpath(await mkdtemp('cc-fuse-box-'));
    await seedRepo(path.join(box, 'app'));
    await fs.writeFile(path.join(box, 'app', 'remote-marker.txt'), 'HOST-SIDE-COPY\n');

    // THE FAKE REMOTE, AND ITS BYTES DIFFER FROM THE HOST'S AT THE SAME PATH.
    // That is the whole reason the override exists: S1's bind-mount stand-in
    // made the two identical, and criteria 3 and 4 are only checkable when a
    // reader can tell which side answered. The tree MIRRORS the host layout, so
    // `<fakeRemote>/<projectPath>` is the project's own path on "the system".
    fakeRemote = await fs.realpath(await mkdtemp('cc-fuse-remote-'));
    await fs.mkdir(path.join(fakeRemote, box, 'app'), { recursive: true });
    await fs.writeFile(path.join(fakeRemote, box, 'app', 'remote-marker.txt'), 'SYSTEM-SIDE-PROJECT-FILE\n');
    // R3's non-vacuity control writes here — a project-tier directory that
    // really is writable, so an EROFS elsewhere is the node's answer.
    await fs.mkdir(path.join(fakeRemote, box), { recursive: true });
    prevFakeRemote = process.env.CC_FUSE_SOURCE_OVERRIDE_ROOT;
    process.env.CC_FUSE_SOURCE_OVERRIDE_ROOT = fakeRemote;

    await addSystem({ id: 'fusebox', label: 'fusebox', launch: ['node', FIXTURE] });
    assert.equal((await adoptProject('app', path.join(box, 'app'), { system: 'fusebox' })).ok, true);
  });

  // THE LEAK CHECK THAT DOES NOT READ A RECORD, and the reason there is one: a
  // /proc/1/mounts delta cannot see a private namespace, and re-verifying the
  // pids in mount.json cannot see a leak whose record was deleted. Both halves
  // of the original check were blind to a leaked anchor by construction, and
  // one leaked.
  //
  // Attribution is on an identity the process CARRIES — CC_FUSE_INSTANCE_ID and
  // CC_FUSE_RUNDIR in /proc/<pid>/environ, scoped to THIS run's run root — never
  // on comm or cmdline. `sleep infinity` is as generic a needle as exists here.
  async function attributableProcesses() {
    const { ok, rows } = await scanProcesses({ withEnviron: true });
    // A scan that could not run is a FAILURE, not an empty result — that
    // distinction is the whole point of the control in arm 4.
    assert.equal(ok, true, 'the process scan could not run; no emptiness below is evidence');
    return orphansUnder(rows, runRoot);
  }

  after(async () => {
    // Runs before the shutdown below, so a process this suite leaked is still
    // there to be found rather than reaped by it.
    const leaked = await attributableProcesses().catch(() => []);
    if (leaked.length) console.log(`fuse gate: LEAKED ${JSON.stringify(leaked)}`);
    for (const [where, rows] of Object.entries(timings)) {
      if (!rows.length) continue;
      const f = (k) => rows.map(r => r[k]).join('/');
      console.log(`fuse gate timing [${where}] n=${rows.length} spawn→idle ms: ${f('spawnMs')} | turn ms: ${f('turnMs')}`);
    }
    if (prevFakeRemote === undefined) delete process.env.CC_FUSE_SOURCE_OVERRIDE_ROOT;
    else process.env.CC_FUSE_SOURCE_OVERRIDE_ROOT = prevFakeRemote;
    if (ctx) await ctx.instances.shutdown();
    disposeSystemHandles();
    if (home) await rmrf(home);
    if (ctx) await ctx.close();
  });

  // A worker that has COMPLETED A TURN, which is the causal barrier every arm
  // needs. `status === 'idle'` is not one: spawn() reports idle as soon as the
  // subprocess is alive and stdin is writable, and under this chroot the
  // bootstrap is still executing its bind mounts and its chroot at that point
  // — the recorded pid is still `/bin/sh` running as root, not the CLI.
  //
  // The wait is generous because it is measuring something real: every page of
  // the CLI binary is faulted in through the union with attr_timeout=0,
  // entry_timeout=0 and no kernel cache. See TURN_TIMEOUT_MS.
  const TURN_TIMEOUT_MS = 120_000;
  async function spawnWorker(where = 'chroot') {
    const tSpawn = Date.now();
    const r = await api(baseUrl, 'POST', '/api/instances', { project: 'app', mode: 'bypassPermissions' });
    assert.equal(r.status, 201, JSON.stringify(r.body));
    const inst = instances.get(r.body.id);
    await waitFor(() => inst.status === 'idle', { timeout: TURN_TIMEOUT_MS });
    const spawnMs = Date.now() - tSpawn;
    const t0 = Date.now();
    // helpers.driveTurn's barrier, with a bound this environment needs: its own
    // waitFor is fixed at 10 s.
    const seqOf = () => inst.ringSnapshot().filter(e => e.kind === 'turn_end').at(-1)?._seq ?? -1;
    const before = seqOf();
    await inst.prompt('hello');
    await waitFor(() => seqOf() > before, { timeout: TURN_TIMEOUT_MS });
    timings[where].push({ spawnMs, turnMs: Date.now() - t0 });
    return inst;
  }

  // ── ARM 1 ────────────────────────────────────────────────────────────────
  // PINS: the mount happens, it is INSIDE the private namespace, and the worker
  // really is chrooted. `/proc/1/mounts` staying clean is criterion 5's whole
  // subject; the worker's `/proc/<pid>/root` differing from `/` is what says
  // the chroot took rather than the wrap silently degrading to a plain spawn.
  test('arm 1 — a spawned worker is mounted, chrooted, and invisible to /proc/1/mounts', async () => {
    const before = snapshot(runRoot);
    const inst = await spawnWorker();
    const record = await readRecord(inst.id);
    assert.ok(record, 'no mount.json handshake was written');

    assert.ok(alive(record.daemonPid, record.daemonStart), 'the daemon is not running');
    assert.ok(alive(record.anchorPid, record.anchorStart), 'the namespace anchor is not running');
    assert.ok(mountsUnder(record.daemonPid, runRoot).includes(record.root),
      `the union root is not mounted in the daemon's namespace: ${JSON.stringify(mountsUnder(record.daemonPid, runRoot))}`);
    assert.deepEqual(mountsUnder(1, runRoot), before.pid1UnderRun,
      'a mount escaped the private namespace into /proc/1/mounts');

    // The worker's root really is the union. Read from OUTSIDE the chroot, so
    // this cannot be answered by the thing under test.
    // Readable to cc because the worker is cc's own uid by then: setpriv
    // dropped privilege before exec'ing the CLI, and a process that has NOT
    // reached that point is still root and answers EACCES here — which is what
    // makes this an assertion about the whole bootstrap chain rather than about
    // the chroot alone.
    const workerRoot = await fs.readlink(`/proc/${record.bootstrapPid}/root`);
    assert.ok(workerRoot && workerRoot !== '/', `the worker's root is ${workerRoot}, i.e. not chrooted`);
    assert.equal(workerRoot, record.root);

    // What a project path answers, and to WHOM, is R2's subject — an nsenter
    // process is unmarked by construction and criterion 6 denies it there.

    await instances.remove(inst.id);
    assertNoResidue(before, runRoot, record, 'arm 1 cleanup');
  });

  // ── ARM 2 ────────────────────────────────────────────────────────────────
  // PINS: the COMMANDED teardown path — kill_instance → InstanceManager.remove()
  // → Instance.kill(). Under the wrap `proc.pid` is sudo's, which cannot forward
  // SIGKILL, so a kill that only signalled it would leave the worker, the
  // daemon and the mounts behind.
  test('arm 2 — kill_instance leaves no mount and no daemon', async () => {
    const before = snapshot(runRoot);
    const inst = await spawnWorker();
    const record = await readRecord(inst.id);
    assert.ok(record);

    await instances.remove(inst.id);

    assertNoResidue(before, runRoot, record, 'arm 2');
    await assert.rejects(() => fs.stat(fuseRunDir(inst.id)), 'the run directory was not reclaimed');
  });

  // ── ARM 3 ────────────────────────────────────────────────────────────────
  // PINS: the CRASH path. `_handleExit`'s terminal latch fires however the
  // process died, and it is the only thing that unmounts when nobody commanded
  // anything. The pid signalled is the one the bootstrap RECORDED, re-verified
  // by starttime — killing `inst.pid` (sudo) would not model a crash at all.
  test('arm 3 — a kill -9 of the recorded worker pid leaves no mount and no daemon', async () => {
    const before = snapshot(runRoot);
    const inst = await spawnWorker();
    const record = await readRecord(inst.id);
    assert.ok(record);

    const killed = killPids([{ pid: record.bootstrapPid, ident: record.bootstrapStart }],
      { identOf: startOf });
    assert.deepEqual(killed, [record.bootstrapPid], 'the recorded worker pid was not signalled');

    await waitFor(() => inst.proc === null, { timeout: 15_000 });
    // _handleExit fires teardown WITHOUT AWAITING it — it is a crash path, not
    // a commanded one — so the assertion waits for the state it must reach. The
    // run directory going away is teardown's LAST action, so it is the barrier
    // that covers every earlier step including the anchor's kill.
    await waitFor(() => !existsSync(fuseRunDir(inst.id)), { timeout: 30_000 });
    assertNoResidue(before, runRoot, record, 'arm 3');
  });

  // ── ARM 4 ────────────────────────────────────────────────────────────────
  // PINS: the ORCHESTRATOR-RESTART path, which is the one nothing in-process
  // covers. `shutdownForResumeSync` cannot run the mount teardown — it is async
  // and `scheduleRestart` calls `process.exit(0)` ~50 ms later — so a restart
  // genuinely leaves a LIVE daemon, a LIVE anchor and LIVE mounts behind, owned
  // by nothing. Only the boot sweep, reading the on-disk record, can reclaim
  // them.
  //
  // cc's death is modelled by dropping the in-memory handle BEFORE the shutdown,
  // which is what a `process.exit` does to it: without that, `_handleExit`'s
  // fire-and-forget teardown races the sweep and the arm silently degrades into
  // a second copy of arm 3. The sweep then runs in a FRESH PROCESS, because
  // that is the only thing that proves it works from the record alone.
  test('arm 4 — an orchestrator restart leaves a live mount, and the boot sweep reclaims it', async () => {
    const before = snapshot(runRoot);
    const inst = await spawnWorker();
    const record = await readRecord(inst.id);
    assert.ok(record);

    // cc's memory of the mount, gone with the process. A REAL restart takes
    // cc's whole process with it, so the control socket goes with the fd table;
    // this arm keeps the process alive, so it has to release by hand what dying
    // would have released — otherwise it leaves a listening server behind for
    // the rest of the file. The daemon survives it either way: a dropped
    // control channel makes project ops -EIO, which is what the sweep then
    // reclaims around.
    await inst._fuse.controlServer?.close();
    inst._fuse = null;
    instances.shutdownForResumeSync();
    instances.byId.delete(inst.id);
    await waitFor(() => inst.proc === null, { timeout: 20_000 });

    // NON-VACUITY: the restart really did leave residue for the sweep to find.
    // Without this the arm would pass against an already-clean machine.
    assert.ok(alive(record.daemonPid, record.daemonStart), 'the daemon did not survive the restart shutdown');
    assert.ok(alive(record.anchorPid, record.anchorStart), 'the anchor did not survive the restart shutdown');
    assert.ok(mountsUnder(record.anchorPid, runRoot).includes(record.root), 'the union was already unmounted');

    // THE POSITIVE CONTROL FOR ARM 7. That arm asserts ZERO rows from a scan
    // that fails closed at every step, so a `hidepid` mount option, a sudoers
    // change or a broken privileged pass would blind it and it would pass for
    // ever. Here the anchor is KNOWN to be alive, so the scan must see it —
    // and arm 7's emptiness is only evidence because this ran first.
    const seen = await attributableProcesses();
    assert.ok(seen.some(r => r.pid === record.anchorPid),
      `the process scan cannot see a live anchor (pid ${record.anchorPid}); arm 7's zero is not evidence: ${JSON.stringify(seen)}`);
    console.log(`fuse gate [arm 4 control] the scan sees ${seen.length} live process(es) of this session, including the anchor`);

    const sweeper = await sh(process.execPath, ['--experimental-strip-types',
      path.join(HERE, 'fixtures', 'fuseSweepProbe.mjs'), fuseRunRoot()]);
    assert.ok(sweeper.ok, `the sweep probe failed: ${sweeper.stderr}`);
    const reported = JSON.parse(sweeper.stdout.trim().split('\n').pop());
    const mine = reported.find(r => r.instanceId === inst.id);
    assert.ok(mine, `the sweep did not report ${inst.id}: ${sweeper.stdout}`);
    assert.equal(mine.wedged, false, JSON.stringify(mine));
    assert.equal(mine.removedRunDir, true, JSON.stringify(mine));
    assert.ok(mine.unmounted.includes(record.root), `the sweep did not unmount the union: ${JSON.stringify(mine.unmounted)}`);
    console.log(`fuse gate: boot sweep reclaimed ${inst.id} → ${mine.terminalState}`
      + `, unmounted ${mine.unmounted.length} (lazily ${mine.lazyUnmounted.length}), abort=${mine.abort}`
      + `, fusectl entries with no record of ours: ${mine.strayConnections} (reported, never aborted)`);

    assertNoResidue(before, runRoot, record, 'arm 4');
    await assert.rejects(() => fs.stat(fuseRunDir(inst.id)));
  });

  // ── ARM 5 ────────────────────────────────────────────────────────────────
  // PINS: teardown is BOUNDED and leaves no residue when a mount cannot be
  // unmounted in place. The holder is a process inside the namespace with a
  // working directory inside the union, so `umount` returns EBUSY and the lazy
  // fallback is the only thing that clears it.
  //
  // WHAT THIS ARM DOES **NOT** CONSTRUCT, stated so it is not read as more than
  // it is: a FUSE-level deadlock (S3 §A3's W-D1/W-D2). Under S2's geometry
  // there is no route to one left to construct. A remote-tier op is answered
  // from `<rundir>/mirror`, a SIBLING of the mountpoint, whose contents cc
  // materialises over the control socket — so no path the daemon serves is
  // backed by the union itself. And cc's handler runs OUTSIDE the namespace,
  // where the mount does not exist at all, so it cannot re-enter it however the
  // source root is configured. The self-recursion guard survives as a liveness
  // precondition for a caller in the daemon's own thread group, not as the
  // thing standing between this arm and a deadlock. So what is pinned here is
  // the WEDGE class — a busy mount, bounded, reported, then swept — and the
  // deadlock class is pinned by the deterministic suite's fake driver and by
  // S3's own measurement of the abort, not here.
  test('arm 5 — a live unrecorded namespace member is a bounded, reported wedge the sweep then clears', async () => {
    const before = snapshot(runRoot);
    const inst = await spawnWorker();
    const record = await readRecord(inst.id);
    assert.ok(record);

    const ns = `--mount=/proc/${record.anchorPid}/ns/mnt`;
    let holderPid = null, holderStart = null;
    try {
      // A process whose cwd is inside the union: `umount <root>` is EBUSY while
      // it lives. Its pid is ours — this test started it — and it is the only
      // thing this arm ever signals.
      // UID 1000, not root — which is both what a real Bash-forwarder child is
      // and what lets this test signal it without sudo. A root-owned holder
      // gives cc EPERM on `kill`, and killPids swallows that as "already gone".
      const started = await sh('sudo', ['-n', 'nsenter', ns, '--',
        'setpriv', `--reuid=${process.getuid()}`, `--regid=${process.getgid()}`, '--init-groups', '--',
        '/bin/sh', '-c',
        // stdio detached, or `sudo` waits on the backgrounded process's
        // inherited stdout for the whole 300 s.
        // `/usr` inside the chroot is a SYNTHETIC node, 0555 and traversable —
        // and under the fail-closed tier an unpinned `/srv` no longer exists at
        // all, which is what this arm used before S2.
        'cd "$1" && { sleep 300 </dev/null >/dev/null 2>&1 & echo $!; }', 'sh', path.join(record.root, 'usr')]);
      holderPid = Number(started.stdout.trim());
      holderStart = startOf(holderPid);
      assert.ok(holderPid > 1 && holderStart, `the holder did not start: ${started.stderr}`);

      // NON-VACUITY: the mount really is busy, so the plain umount really does
      // have to fail before the lazy one runs.
      const busy = await sh('sudo', ['-n', 'nsenter', ns, '--', 'umount', record.root]);
      assert.equal(busy.ok, false, 'the union unmounted plainly — the holder did not make it busy');
      assert.match(busy.stderr, /busy/i, busy.stderr);

      const t0 = Date.now();
      await instances.remove(inst.id);
      const elapsed = Date.now() - t0;
      // BOUNDED. The number is generous: what is pinned is that it terminates
      // at all, not how fast.
      assert.ok(elapsed < 120_000, `teardown took ${elapsed}ms`);
      console.log(`fuse gate: busy-mount teardown took ${elapsed}ms`);
    } finally {
      if (holderPid && holderStart) {
        killPids([{ pid: holderPid, ident: holderStart }], { identOf: startOf });
        // A causal barrier, not politeness: SIGKILL is asynchronous, and the
        // sweep below must run against a namespace the holder has actually
        // left — otherwise it correctly re-wedges and the assertion that it
        // clears the record is testing the race, not the sweep.
        await waitFor(() => !alive(holderPid, holderStart), { timeout: 15_000 });
      }
      if (instances.byId.has(inst.id)) await instances.remove(inst.id).catch(() => {});
    }

    // THE VERDICT IS TAKEN FROM NAMESPACE MEMBERSHIP, and here that is the
    // whole point: the holder is alive in the session's namespace at teardown
    // time and NO record names it, so a verdict taken from the recorded pid set
    // would have called this clean and destroyed the record over a live
    // namespace. It must be a reported wedge whose record survives.
    const kept = await readRecord(inst.id);
    console.log(`fuse gate: busy-mount arm → ${kept ? `record kept, terminalState=${kept.terminalState}, survivingPids=${JSON.stringify(kept.survivingPids)}, residual=${JSON.stringify(kept.residualMounts)}` : 'teardown finished clean'}`);
    assert.ok(kept, 'a live unrecorded namespace member did not keep the record');
    assert.equal(kept.wedged, true, 'a kept record must say it is wedged');
    assert.deepEqual(kept.survivingPids, [], 'a RECORDED pid survived, so this arm would pass for the wrong reason');
    assert.ok(typeof kept.terminalState === 'string' && kept.terminalState.length > 0);

    // …and the follow-up sweep, with the holder now dead, clears it.
    const sweeper = await sh(process.execPath, ['--experimental-strip-types',
      path.join(HERE, 'fixtures', 'fuseSweepProbe.mjs'), fuseRunRoot()]);
    assert.ok(sweeper.ok, sweeper.stderr);
    await assert.rejects(() => fs.stat(fuseRunDir(inst.id)), 'the sweep did not clear the wedged record');
    assertNoResidue(before, runRoot, record, 'arm 5');
  });

  // ── THE CONTROL MEASUREMENT ──────────────────────────────────────────────
  // Not an assertion. The same project, the same provider and the same fake CLI
  // with the chroot disengaged, so the only variable between the two rows
  // printed by `after` is the union and its zero-caching mount options.
  //
  // Disengaged through the LAUNCHER's own exemption rather than an environment
  // switch, because there is no longer a switch: the union is mandatory for a
  // remote-backed worker on a launcher that spawns a process. The stand-in
  // still spawns a real child — it is the production launcher with the one
  // marker flipped — so the comparison stays like-for-like.
  test('control — the same turn with the chroot disengaged, for the cost comparison', async () => {
    const real = instances._claudeLauncher;
    instances._claudeLauncher = {
      inProcess: true,
      launch: (spec) => real.launch(spec),
    };
    try {
      for (let i = 0; i < 3; i++) {
        const inst = await spawnWorker('control');
        assert.equal(inst._fuse, null, 'the control worker was wrapped after all');
        await instances.remove(inst.id);
      }
    } finally { instances._claudeLauncher = real; }
  });

  // ── ARM 6 ────────────────────────────────────────────────────────────────
  // PINS: criterion 9 end to end — the refusal reaches the CALLER, and it
  // refuses BEFORE anything exists: no run directory, no mount, no daemon. A
  // check placed after spawn() would surface as a dead subprocess instead.
  test('arm 6 — a stubbed-absent dependency refuses the spawn with nothing created', async () => {
    const before = snapshot(runRoot);
    const runDirsBefore = (await fs.readdir(runRoot).catch(() => [])).sort();
    const preflight = await import('../src/systems/fuse/preflight.ts');
    const realDevFuse = preflight.realProbes.devFuseIsCharDevice;
    preflight.realProbes.devFuseIsCharDevice = async () => false;
    let id = null;
    try {
      const r = await api(baseUrl, 'POST', '/api/instances', { project: 'app', mode: 'bypassPermissions' });
      id = r.body?.id ?? null;
      assert.equal(r.status, 501, JSON.stringify(r.body));
      assert.match(String(r.body.error ?? r.body.message ?? ''), /FUSE_UNAVAILABLE.*\/dev\/fuse/s);
    } finally {
      preflight.realProbes.devFuseIsCharDevice = realDevFuse;
      if (id && instances.byId.has(id)) await instances.remove(id).catch(() => {});
    }
    const after = snapshot(runRoot);
    assert.deepEqual(after.pid1UnderRun, before.pid1UnderRun);
    // Nothing was created: the run root holds no NEW directory. A delta, for
    // the same reason every other arm uses one — an absolute assertion would
    // report an earlier arm's residue as this one's leak.
    const runDirsAfter = (await fs.readdir(runRoot).catch(() => [])).sort();
    assert.deepEqual(runDirsAfter, runDirsBefore,
      `the refused spawn created ${JSON.stringify(runDirsAfter.filter(d => !runDirsBefore.includes(d)))}`);
  });
  // ══ S2's ARMS ═════════════════════════════════════════════════════════════
  //
  // R1-R6 (plan 2026-0355 §11.3). These need a real mount, a real chroot and a
  // real second process in the namespace, so they cannot be deterministic. The
  // policy split does not retire them: it moved what CAN be proven without a
  // mount into `tests/fuse-union-policy.test.mjs`, and what is left here is
  // exactly the remainder that table names.

  // A command run INSIDE the namespace, at uid 1000, in ONE process — which is
  // what makes marking observable at all. `[ -e ]` and `read` are shell
  // BUILTINS, so both the marking stat and the subsequent open are made by the
  // shell's own thread group; a `cat` would be a child with its own tgid and
  // would answer the unmarked question instead.
  const inNs = (anchorPid, script, ...args) => sh('sudo', ['-n', 'nsenter',
    `--mount=/proc/${anchorPid}/ns/mnt`, '--',
    'setpriv', `--reuid=${process.getuid()}`, `--regid=${process.getgid()}`, '--init-groups', '--',
    '/bin/sh', '-c', script, 'sh', ...args]);

  // The same, as ROOT. `default_permissions` makes the KERNEL check the caller
  // against the node's own mode before the daemon is ever asked, and a
  // synthetic node is 0555 root:root — so a uid-1000 probe gets EACCES from the
  // kernel and never reaches the arm the daemon owns. Root passes that check,
  // which is what makes the daemon's own answer observable.
  const inNsRoot = (anchorPid, script, ...args) => sh('sudo', ['-n', 'nsenter',
    `--mount=/proc/${anchorPid}/ns/mnt`, '--', '/bin/sh', '-c', script, 'sh', ...args]);

  // nsenter does NOT chroot, so a probe names every path from OUTSIDE, under
  // `record.root`. The union sees the suffix, which is the spelling the pins
  // and the mark path are written in.
  const inside = (record, p) => path.join(record.root, p);

  // THE DAEMON'S POLICY EVENT LOG, split into `[kind, op, path, reason]`. The
  // KIND is the first column and every filter below derives from it rather than
  // from a hand-maintained list of reason strings — `self-recursion` and
  // `pinned-children-truncated` are `served` rows, so a reason enumeration was
  // already wrong here.
  const eventsOf = async (instanceId) =>
    (await fs.readFile(path.join(fuseRunDir(instanceId), EVENT_LOG_NAME), 'utf8').catch(() => ''))
      .split('\n').filter(Boolean).map(l => l.split('\t'));

  // ── R1 ───────────────────────────────────────────────────────────────────
  // PINS criterion 1: ONE PATH SPELLING. The CLI's cwd inside the chroot, the
  // path a file tool may name, and the directory the forwarded Bash tool lands
  // in are the same string — the whole point of host pins keeping their exact
  // spelling and of the project tier being mounted at its real remote path.
  //
  // WHAT THIS ARM DOES NOT DO, stated so it is not read as more: it does not
  // drive the CLI's own tool calls. The fake CLI emits tool_use events and
  // never executes a tool, so the file-tool half is asserted through the same
  // `classifyForTool` the hook calls, and the Bash half through the same
  // forwarder a real Bash tool would reach.
  test('R1 — the CLI cwd, the file-tool path and Bash’s pwd are one spelling', async () => {
    const before = snapshot(runRoot);
    const inst = await spawnWorker();
    try {
      const p = path.join(box, 'app');
      assert.equal(inst.cwd, p, 'the CLI cwd is not the project’s path on its system');

      // The FILE-TOOL half, from the one artifact the hook decides from.
      const { classifyForTool } = await import('../src/systems/fuse/tierTable.ts');
      const redirect = inst._redirect;
      const decision = classifyForTool(redirect.tiers, {
        exclude: [], mirrorRoot: p, systemId: 'fusebox', systemPath: p,
      }, path.join(p, 'remote-marker.txt'));
      assert.equal(decision.decision, 'allow', JSON.stringify(decision));

      // The BASH half, through the forwarder — it execs on the system, so its
      // `pwd` is the answer about the machine the worker is asking about.
      // The BASH half runs on the SYSTEM, through the same `execOneShot` the
      // forwarder reaches, at the same cwd — so `pwd` there and the CLI's cwd
      // here are one string or the arm fails.
      const system = inst._redirectPlacement.system;
      assert.equal(inst._redirectPlacement.systemPath, p, 'the forwarder’s cwd is not the CLI’s');
      const out = await system.execOneShot({ shell: 'pwd' }, { cwd: p, timeoutMs: 30_000, stdin: 'ignore' });
      assert.match(String(out.stdout ?? ''), new RegExp(`(^|\n)${p}(\n|$)`),
        `Bash’s pwd is ${JSON.stringify(out.stdout)} (${out.stderr})`);

      // And the same path answers inside the chroot, to a MARKED caller.
      const record = await readRecord(inst.id);
      const seen = await inNs(record.anchorPid,
        '[ -e "$1" ]; read l < "$2" || exit 7; echo "$l"',
        inside(record, inst._fuse.plan.markPath), inside(record, path.join(p, 'remote-marker.txt')));
      assert.match(seen.stdout, /SYSTEM-SIDE-PROJECT-FILE/, `${seen.stdout} ${seen.stderr}`);
    } finally {
      await instances.remove(inst.id);
    }
    assertNoResidue(before, runRoot, null, 'R1');
  });

  // ── R2 ───────────────────────────────────────────────────────────────────
  // PINS criteria 3 and 6 end to end, and it is only checkable because the fake
  // remote's bytes DIFFER from the host's at the same path.
  //
  //   a marked caller at a project path  → the SYSTEM's bytes
  //   an unmarked caller at the same one → -ENOENT. Never the remote's copy,
  //                                        and never a host fallback.
  //   either caller at a host pin        → the HOST's bytes, alike.
  test('R2 — a project path answers the system to a marked caller and ENOENT to an unmarked one', async () => {
    const before = snapshot(runRoot);
    const inst = await spawnWorker();
    try {
      const record = await readRecord(inst.id);
      const projFile = inside(record, path.join(box, 'app', 'remote-marker.txt'));
      const mark = inside(record, inst._fuse.plan.markPath);

      const marked = await inNs(record.anchorPid,
        '[ -e "$1" ]; read l < "$2" || exit 7; echo "$l"', mark, projFile);
      assert.match(marked.stdout, /SYSTEM-SIDE-PROJECT-FILE/,
        `a marked caller did not get the system’s bytes: ${marked.stdout} ${marked.stderr}`);
      assert.doesNotMatch(marked.stdout, /HOST-SIDE-COPY/,
        'the HOST’s copy surfaced inside the project tier');

      // THE SAME COMMAND WITHOUT THE MARKING STAT. One token of difference, so
      // the deny cannot be attributed to anything else about the caller.
      const unmarked = await inNs(record.anchorPid, 'read l < "$1" || exit 7; echo "$l"', projFile);
      assert.equal(unmarked.ok, false, `an unmarked caller was served: ${unmarked.stdout}`);
      assert.doesNotMatch(unmarked.stdout, /SYSTEM-SIDE-PROJECT-FILE|HOST-SIDE-COPY/,
        'an unmarked caller got bytes from one side or the other');

      // …and a HOST PIN is served to that same unmarked caller.
      // A REAL host pin — ETC_PINS names /etc/hosts, and a path that merely
      // looks host-ish (/etc/hostname) is `fail` like anything unpinned, which
      // would make this arm pass for the wrong reason.
      const hostPin = inside(record, '/etc/hosts');
      const both = await inNs(record.anchorPid, 'read l < "$1" || exit 7; echo "$l"', hostPin);
      assert.equal(both.ok, true, `a host pin was denied to an unmarked caller: ${both.stderr}`);
      assert.equal(both.stdout.trim(), (await fs.readFile('/etc/hosts', 'utf8')).split('\n')[0].trim(),
        'the host pin did not answer with the orchestrator’s own file');

      // And the denial is in the log, by name.
      const events = await eventsOf(inst.id);
      assert.ok(events.some(r => r[0] === 'deny' && r[3] === 'unmarked-project-denied'),
        `no deny/unmarked-project-denied entry: ${JSON.stringify(events)}`);
    } finally {
      await instances.remove(inst.id);
    }
    assertNoResidue(before, runRoot, null, 'R2');
  });

  // ── R3 ───────────────────────────────────────────────────────────────────
  // PINS the pin-derivation gate AND risk K4: under `T_FAIL` at enum index 0
  // the mount comes up at all, and `bootstrap.sh`'s three `mount --bind`s land
  // on SYNTHETIC mountpoints. A `mount --bind` onto a FUSE synthetic node that
  // the kernel refused would kill every launch, and the named contingency was
  // to render the three as `host` pins of empty directories instead.
  test('R3 — the mount comes up fail-closed and the three binds land on synthetic nodes', async () => {
    const before = snapshot(runRoot);
    const inst = await spawnWorker();
    try {
      const record = await readRecord(inst.id);
      const nsMounts = mountsOf(record.daemonPid) ?? [];
      for (const b of ['/proc', '/sys', '/dev']) {
        assert.ok(nsMounts.includes(path.join(record.root, b)),
          `${b} was not bind-mounted onto its synthetic node: ${JSON.stringify(nsMounts.filter(m => m.startsWith(record.root)))}`);
      }
      // The synthetic node answers ITS OWN fixed attributes, not the host
      // directory's — the assertion the unit driver cannot make because it
      // cannot reach pt_getattr. `/usr` exists on the host with a real mtime
      // and 0755; inside the chroot it is a scaffold.
      const st = await inNs(record.anchorPid, 'stat -c "%a %u %g %Y" "$1"', inside(record, '/usr'));
      assert.equal(st.ok, true, st.stderr);
      assert.equal(st.stdout.trim(), '555 0 0 0',
        `the synthetic /usr answered the host’s attributes: ${st.stdout}`);
      // And it is READ-ONLY, with EROFS rather than EACCES — AS ROOT, because
      // at uid 1000 `default_permissions` answers EACCES from the kernel before
      // the daemon is consulted and the arm under test is never reached.
      const wr = await inNsRoot(record.anchorPid, 'rmdir "$1" 2>&1 || true', inside(record, '/usr'));
      assert.match(wr.stdout, /[Rr]ead-only file system/, `a synthetic node accepted a mutation: ${wr.stdout}`);
      // A CHILD of a synthetic dir is a different answer, and worth pinning
      // beside it: unpinned, so fail-closed -ENOENT rather than EROFS. The two
      // together say the synthetic tree is a scaffold and not a writable one.
      const child = await inNsRoot(record.anchorPid, 'mkdir "$1" 2>&1 || true', inside(record, '/usr/nope'));
      assert.match(child.stdout, /No such file or directory/, `an unpinned path under a synthetic dir was created: ${child.stdout}`);
      // THE CONTROL THAT MAKES BOTH NON-VACUOUS: a write at a PROJECT path
      // succeeds, so EROFS and ENOENT above are those nodes' answers and not a
      // blanket read-only mount.
      //
      // It has to be a shell REDIRECTION, not `mkdir`: `mkdir` is an external
      // binary and therefore its own thread group, which the `[ -e ]` before it
      // did not mark — so it would be denied for the right reason and read as
      // the union refusing everything.
      const probe = path.join(box, 'app', 'writable-probe');
      // AT UID 1000, like the worker itself: the two probes above need root
      // only to get past `default_permissions` on a 0555 node, and a write into
      // the project tier has no such obstacle — the mirror is cc-owned.
      const wok = await inNs(record.anchorPid,
        '[ -e "$1" ]; echo PUSHED > "$2" && echo MADE',
        inside(record, inst._fuse.plan.markPath), inside(record, probe));
      if (!/MADE/.test(wok.stdout)) {
        const rl = (await eventsOf(inst.id)).map(r => r.join('\t')).join('\n');
        const mdir = await fs.readdir(path.join(fuseRunDir(inst.id), 'mirror', box, 'app')).catch(e => String(e));
        assert.fail(`the union refused a project write: ${wok.stdout} ${wok.stderr}\nevents:\n${rl}\nmirror <box>/app: ${JSON.stringify(mdir)}`);
      }

      // AND THE PUSH LANDED ON THE SYSTEM. `pt_release` sends DIRTY for a
      // handle that was opened writable, and cc copies the mirror's copy back
      // to the source — criterion 8's second half, end to end. READY means cc
      // took ownership of the push, so the await here is for the copy, not for
      // an acknowledgement the frame does not carry.
      const onSystem = path.join(fakeRemote, probe);
      await waitFor(async () => await fs.readFile(onSystem, 'utf8').then(t => t.includes('PUSHED')).catch(() => false),
        { timeout: 15_000 });
    } finally {
      await instances.remove(inst.id);
    }
    assertNoResidue(before, runRoot, null, 'R3');
  });

  // ── R4 ───────────────────────────────────────────────────────────────────
  // PINS the acceptance the spike used and the loop plan §13 K1 iterates
  // against: after a full turn the event log DENIES nothing the CLI NEEDED.
  //
  // "Needed" is made falsifiable rather than left to judgement: no DENIAL may
  // name a path the worker went on to fail over — the turn completed — and no
  // denial may carry a reason that means cc could not answer
  // (`control-unavailable`) or would not (`control-refused`). Denials that
  // remain are negative lookups, which answer identically pinned or not, and
  // every row is PRINTED so the next derivation iteration has its input.
  //
  // BOTH FILTERS ARE `deny`-SCOPED, AND THAT IS THE KIND COLUMN EARNING ITS
  // KEEP rather than tidiness. `self-recursion` is a `served` row that fires
  // ONLY at the project tier, so it sits inside the project tree by
  // construction — under the old reason-blind project-tree filter it would have
  // read as "a project path was refused" when the op in fact succeeded from
  // `host_fd`. The exclusion is structural now: no reader here enumerates
  // reason strings to decide what is a denial.
  test('R4 — after a full turn the event log denies nothing the worker needed', async () => {
    const before = snapshot(runRoot);
    const inst = await spawnWorker();
    try {
      const events = await eventsOf(inst.id);
      console.log(`fuse gate [R4] event log after one turn (${events.length} rows):\n`
        + events.map(r => '  ' + r.join('\t')).join('\n'));
      const denials = events.filter(r => r[0] === 'deny');
      const fatal = denials.filter(r => r[3] === 'control-unavailable' || r[3] === 'control-refused');
      assert.deepEqual(fatal, [], `cc failed to answer for: ${JSON.stringify(fatal)}`);
      // A fail-closed path INSIDE the project tree would mean the tier table
      // and the mirror root disagree, which is the one class the loop cannot
      // dismiss as a negative lookup.
      const inProject = denials.filter(r => r[2].startsWith(path.join(box, 'app')));
      assert.deepEqual(inProject, [], `a project path was denied: ${JSON.stringify(inProject)}`);
      // EVERY ROW CARRIES ONE OF THE TWO KINDS, so a third kind — which would
      // silently fall out of the `deny` filter above and stop being checked at
      // all — reds here.
      const kinds = [...new Set(events.map(r => r[0]))].sort();
      assert.deepEqual(kinds.filter(k => k !== 'deny' && k !== 'served'), [],
        `the event log carries a kind that is neither deny nor served: ${JSON.stringify(kinds)}`);
      // NON-VACUITY: the log is a live instrument, not an empty file that would
      // satisfy every filter above. R2 proves it records; here it must exist.
      await fs.access(path.join(fuseRunDir(inst.id), EVENT_LOG_NAME));
    } finally {
      await instances.remove(inst.id);
    }
    assertNoResidue(before, runRoot, null, 'R4');
  });

  // ── R5 ───────────────────────────────────────────────────────────────────
  // PINS criterion 9: the per-session mirror is OUTSIDE the chroot and has NO
  // spelling inside it, and it goes with the session. A18 pins the geometry
  // deterministically; this pins that the daemon actually answers -ENOENT for
  // it, which is the half a plan file cannot establish.
  test('R5 — the run directory is unreachable from inside the chroot and dies with the session', async () => {
    const before = snapshot(runRoot);
    const inst = await spawnWorker();
    const rundir = fuseRunDir(inst.id);
    try {
      const record = await readRecord(inst.id);
      // Its own spelling, from inside: the chroot re-roots at record.root, so
      // the rundir's absolute path is asked of the union as-is.
      for (const hidden of [rundir, path.join(rundir, 'mirror'), path.join(rundir, 'control.sock')]) {
        const probe = await inNs(record.anchorPid,
          '[ -e "$1" ] && echo PRESENT || echo ABSENT', inside(record, hidden));
        assert.match(probe.stdout, /ABSENT/, `${hidden} is reachable from inside the chroot`);
      }
      // NON-VACUITY: the mirror really was populated on the outside, so ABSENT
      // above is the tier answering rather than an empty tree. The CLI's own
      // `cd` into the project is what materialised this directory.
      await fs.access(path.join(rundir, 'mirror', box, 'app'));
    } finally {
      await instances.remove(inst.id);
    }
    await assert.rejects(() => fs.stat(rundir), 'the mirror outlived the session');
    assertNoResidue(before, runRoot, null, 'R5');
  });

  // ── R6 ───────────────────────────────────────────────────────────────────
  // PINS risk K3: cc's control server dying mid-session surfaces -EIO and NOT a
  // wedge. Without the bounded receive timeout and the connection drop, a
  // daemon thread blocked on a reply sits in an uninterruptible FUSE wait and
  // the mount is only recoverable by aborting the connection.
  //
  // AND IT MUST NOT BE A HOST FALLBACK: a daemon that cannot reach cc serving
  // the host looks exactly like a containment success.
  test('R6 — killing cc’s control server surfaces EIO, not a wedge, and teardown is still clean', async () => {
    const before = snapshot(runRoot);
    const inst = await spawnWorker();
    const record = await readRecord(inst.id);
    try {
      const mark = inside(record, inst._fuse.plan.markPath);
      const projFile = inside(record, path.join(box, 'app', 'remote-marker.txt'));
      // Warm it first, so the failure below is attributable to the close and
      // not to the path never having worked.
      const warm = await inNs(record.anchorPid, '[ -e "$1" ]; read l < "$2" || exit 7; echo "$l"', mark, projFile);
      assert.match(warm.stdout, /SYSTEM-SIDE-PROJECT-FILE/, warm.stderr);

      await inst._fuse.controlServer.close();

      const t0 = Date.now();
      // A DIFFERENT path, so the daemon's resolution cache cannot answer it.
      const dead = await inNs(record.anchorPid, '[ -e "$1" ]; read l < "$2" || exit 7; echo "$l"',
        mark, inside(record, path.join(box, 'app', 'README.md')));
      const elapsed = Date.now() - t0;
      assert.equal(dead.ok, false, `a project path answered with no control channel: ${dead.stdout}`);
      // BOUNDED, and far under CONTROL_TIMEOUT_MS (120 s): the close drops the
      // connection, so the blocked call returns at once rather than sitting out
      // the receive timeout.
      assert.ok(elapsed < 30_000, `the op took ${elapsed}ms — it waited out the timeout instead of failing`);
      assert.doesNotMatch(dead.stdout, /HOST-SIDE-COPY/, 'a dead channel fell back to the host');
      assert.match(dead.stderr, /I\/O error|Input\/output error/i, `expected EIO, got: ${dead.stderr}`);

      // The daemon is still alive and the mount is still there — an -EIO is an
      // op failing, not the filesystem going away.
      assert.ok(alive(record.daemonPid, record.daemonStart), 'the daemon died instead of answering EIO');
    } finally {
      await instances.remove(inst.id);
    }
    // AND TEARDOWN IS STILL CLEAN, which is the half that says it was not a wedge.
    assertNoResidue(before, runRoot, record, 'R6');
    await assert.rejects(() => fs.stat(fuseRunDir(inst.id)), 'the run directory was not reclaimed');
  });

  // ── R7 ───────────────────────────────────────────────────────────────────
  // PINS M1's bar: NO PROJECT-TIER MUTATION SILENTLY SUCCEEDS. Either it lands
  // on the source or it refuses.
  //
  // THE TECHNIQUE, and it buys a second thing: `exec` REPLACES the process,
  // keeping its pid, thread group and start time — so a shell that marks itself
  // with `[ -e "$MARK" ]` and then `exec`s into `mkdir` hands the mark to an
  // external binary. Without it every probe here would be an unmarked child
  // answering -ENOENT for the right reason and reading as the wrong one.
  //
  // It therefore also measures criterion 5's STICKINESS ACROSS EXEC, which the
  // unit driver cannot reach (it has no exec) and nothing else pins: the CLI's
  // own launch depends on it, because bootstrap.sh marks the shell that later
  // execs into the CLI.
  test('R7 — every project-tier mutation lands on the system or refuses', async () => {
    const before = snapshot(runRoot);
    const inst = await spawnWorker();
    try {
      const record = await readRecord(inst.id);
      const mark = inside(record, inst._fuse.plan.markPath);
      const onSystem = (rel) => path.join(fakeRemote, box, 'app', rel);
      const inChroot = (rel) => inside(record, path.join(box, 'app', rel));
      // `$1` is always the mark path; the op is exec'd so it inherits the mark.
      const marked = (script, ...args) => inNs(record.anchorPid,
        `[ -e "$1" ]; ${script}`, mark, ...args);

      // THE PRECONDITION THIS WHOLE ARM RESTS ON, asserted first: the mark
      // really does survive the exec. Without it every result below is the
      // unmarked answer and the arm proves nothing.
      const survives = await marked('exec cat "$2"', inChroot('remote-marker.txt'));
      assert.match(survives.stdout, /SYSTEM-SIDE-PROJECT-FILE/,
        `the mark did not survive exec, so no probe below is marked: ${survives.stderr}`);

      // mkdir LANDS.
      const md = await marked('exec mkdir "$2"', inChroot('r7-dir'));
      assert.equal(md.ok, true, `mkdir refused: ${md.stderr}`);
      await waitFor(async () => (await fs.lstat(onSystem('r7-dir')).catch(() => null))?.isDirectory() === true,
        { timeout: 15_000 });

      // unlink LANDS — and this is the case the bar was written for: `rm`
      // reporting success while the file resurrected on the next read.
      await fs.writeFile(onSystem('r7-doomed.txt'), 'ON THE SYSTEM\n');
      const rm = await marked('exec rm "$2"', inChroot('r7-doomed.txt'));
      assert.equal(rm.ok, true, `rm refused: ${rm.stderr}`);
      await waitFor(async () => await fs.access(onSystem('r7-doomed.txt')).then(() => false, () => true),
        { timeout: 15_000 });
      // …and it does not come back. A fresh marked read must not find it.
      const gone = await marked('exec cat "$2"', inChroot('r7-doomed.txt'));
      assert.equal(gone.ok, false, `the deleted file resurrected: ${gone.stdout}`);

      // rename LANDS at both ends.
      await fs.writeFile(onSystem('r7-from.txt'), 'MOVED\n');
      const mv = await marked('exec mv "$2" "$3"', inChroot('r7-from.txt'), inChroot('r7-to.txt'));
      assert.equal(mv.ok, true, `mv refused: ${mv.stderr}`);
      await waitFor(async () =>
        (await fs.readFile(onSystem('r7-to.txt'), 'utf8').catch(() => '')).includes('MOVED')
        && await fs.access(onSystem('r7-from.txt')).then(() => false, () => true),
        { timeout: 15_000 });

      // chmod LANDS, executable bit and all.
      await fs.writeFile(onSystem('r7-mode.sh'), '#!/bin/sh\n');
      await fs.chmod(onSystem('r7-mode.sh'), 0o644);
      const cm = await marked('exec chmod 755 "$2"', inChroot('r7-mode.sh'));
      assert.equal(cm.ok, true, `chmod refused: ${cm.stderr}`);
      await waitFor(async () => ((await fs.stat(onSystem('r7-mode.sh'))).mode & 0o777) === 0o755,
        { timeout: 15_000 });

      // AND THE THREE THE RECONCILE CANNOT EXPRESS REFUSE, rather than
      // succeeding against the mirror and reaching the system never.
      await fs.writeFile(onSystem('r7-link-src.txt'), 'x\n');
      // EOPNOTSUPP, not EPERM: the truth is that this filesystem cannot
      // REPRESENT an alias, and EPERM would send the caller hunting a
      // privilege that would not change the answer.
      const ln = await marked('exec ln "$2" "$3" 2>&1', inChroot('r7-link-src.txt'), inChroot('r7-link-dst.txt'));
      assert.match(ln.stdout, /Operation not supported/, `a hard link was accepted: ${ln.stdout} ${ln.stderr}`);
      await assert.rejects(() => fs.access(onSystem('r7-link-dst.txt')),
        'the hard link reached the system as a second file');

      // mknod KEEPS EPERM, deliberately: a container refusing a device node is
      // what a caller already expects, and the permissions reading is right
      // there. The two errnos differing is the assertion, not an accident.
      const mk = await marked('exec mkfifo "$2" 2>&1', inChroot('r7-fifo'));
      assert.match(mk.stdout, /Operation not permitted/, `a fifo was accepted: ${mk.stdout}`);
      await assert.rejects(() => fs.access(onSystem('r7-fifo')));

      // chown needs root to get past the kernel's own check, so it runs there.
      const ch = await inNsRoot(record.anchorPid, '[ -e "$1" ]; exec chown 0:0 "$2" 2>&1',
        mark, inChroot('remote-marker.txt'));
      assert.match(ch.stdout, /Operation not supported/, `chown was accepted: ${ch.stdout}`);

      // AND THE TWO XATTR MUTATIONS, which round 3 found changing the mirror
      // and reaching the system never — they were in neither enumeration, so
      // both guards were vacuous for exactly them.
      // NOT CONDITIONAL ON THE BINARY EXISTING. A silent skip here is
      // indistinguishable from a pass, so an absent `setfattr` is named.
      const haveSetfattr = (await sh('sh', ['-c', 'command -v setfattr'])).ok;
      let sx = { stdout: '' };
      if (haveSetfattr) {
        sx = await marked('exec setfattr -n user.cc -v x "$2" 2>&1', inChroot('remote-marker.txt'));
        assert.match(sx.stdout, /Operation not supported/, `setxattr was accepted: ${sx.stdout}`);
      } else {
        console.log('fuse gate [R7]: setfattr absent — the xattr refusal is NOT covered on this host');
      }

      // A DIRECTORY RENAME REFUSES, and the control below is what makes it a
      // rule about directories rather than about renames: the file rename
      // above landed.
      await fs.mkdir(onSystem('r7-dir-from'), { recursive: true });
      await fs.writeFile(path.join(onSystem('r7-dir-from'), 'child.txt'), 'INSIDE\n');
      const dmv = await marked('exec mv "$2" "$3" 2>&1',
        inChroot('r7-dir-from'), inChroot('r7-dir-to'));
      assert.match(dmv.stdout, /Operation not supported/,
        `a directory rename was accepted: ${dmv.stdout} ${dmv.stderr}`);
      // AND THE SUBTREE IS INTACT — the refusal happens BEFORE the mirror is
      // touched, so the source keeps both the directory and its children.
      assert.equal(await fs.readFile(path.join(onSystem('r7-dir-from'), 'child.txt'), 'utf8'), 'INSIDE\n');
      await assert.rejects(() => fs.access(onSystem('r7-dir-to')));

      // CRITERION 10 AT THE SYSCALL. A reconcile that cannot land must not
      // report success — and the kernel DISCARDS `release`'s return value, so
      // the push lives in `flush`, which is what `close(2)` reports. Nothing
      // proved the worker ever sees it until this arm.
      //
      // THE OPEN MUST SUCCEED AND ONLY THE RECONCILE FAIL, or the arm passes
      // on an EACCES the daemon never sent and proves nothing. Permissions
      // cannot separate the two — cc copies the source's mode onto the mirror,
      // so anything that stops cc's push stops the worker's open as well.
      // What does separate them is TIME: the handle stays open while the test
      // removes the mirror entry cc is holding for it, so the push finds
      // nothing to copy, refuses EIO, and `flush` answers that to close(2).
      //
      // `node` rather than a shell: a shell does not report a redirect's close
      // error, and close(2) is the whole point of this arm.
      const NODE_PROBE = [
        'const fs=require("fs");',
        'const fd=fs.openSync(process.argv[1],"w");',
        'fs.writeSync(fd,"NEW\\n");',
        'const t=Date.now(); while(Date.now()-t<4000);',
        'try{fs.closeSync(fd)}catch(e){console.log("CLOSE_ERR:"+e.code);process.exit(3)}',
        'console.log("CLOSE_OK")',
      ].join('');
      const eioPath = path.join(box, 'app', 'r7-eio.txt');
      await fs.writeFile(onSystem('r7-eio.txt'), 'ORIGINAL\n');
      const mirrorCopy = path.join(fuseRunDir(inst.id), 'mirror', eioPath);
      const writer = inNs(record.anchorPid,
        '[ -e "$1" ]; exec "$3" -e "$4" "$2"',
        mark, inChroot('r7-eio.txt'), inside(record, inst._fuse.plan.markPath), NODE_PROBE);
      // Wait until the handle is genuinely open with its bytes in the mirror,
      // then take the mirror entry away while it is still held.
      await waitFor(async () =>
        (await fs.readFile(mirrorCopy, 'utf8').catch(() => '')).includes('NEW'), { timeout: 15_000 });
      await fs.rm(mirrorCopy);
      const w = await writer;
      assert.match(w.stdout, /CLOSE_ERR:EIO/,
        `close(2) did not report the refused reconcile: ${w.stdout} ${w.stderr}`);
      assert.equal(await fs.readFile(onSystem('r7-eio.txt'), 'utf8'), 'ORIGINAL\n',
        'the system copy changed even though the reconcile refused');

      // Each refusal is in the log by name, so the pin-derivation instrument
      // sees them rather than only the caller.
      const events = await eventsOf(inst.id);
      const notReconcilable = events.filter(r => r[0] === 'deny' && r[3] === 'not-reconcilable').map(r => r[1]);
      const want = ['chown', 'link', 'mknod', 'rename'];
      if (haveSetfattr) want.push('setxattr');
      assert.deepEqual([...new Set(notReconcilable)].sort(), want.sort());
    } finally {
      await instances.remove(inst.id);
    }
    assertNoResidue(before, runRoot, null, 'R7');
  });

  // ── R8 ───────────────────────────────────────────────────────────────────
  // THE ACCEPTANCE GATE FOR 2026-0373: a spawn-time chdir from an UNMARKED
  // thread group resolves the project ROOT and nothing inside it.
  //
  // THE PROBE REPRODUCES THE DEFECT'S OWN MECHANISM rather than a shell's `cd`:
  // `node -e` + `spawnSync(..., { cwd })` is libuv's chdir-in-the-FORKED-CHILD,
  // which is precisely what the CLI's Bash spawn does and precisely what R1
  // cannot see (R1 calls `system.execOneShot({shell:'pwd'}, {cwd})` directly,
  // which is why R1 passed while every child the CLI spawned at its own cwd
  // died). The `node` binary is named by its HOST path, so it never routes
  // through the union and is never marked; its spawned child is a further new
  // thread group, also unmarked — two levels of unmarked, exactly like reality.
  const R8_PROBE = [
    'const {spawnSync}=require("child_process");',
    'const [root,sub,file]=process.argv.slice(1);',
    'const run=(bin,args,cwd)=>{const r=spawnSync(bin,args,{cwd,encoding:"utf8"});',
    'return {status:r.status,err:r.error?r.error.code:null,',
    'out:(r.stdout||"").trim(),se:(r.stderr||"").trim()};};',
    'console.log(JSON.stringify({',
    'a:run("/bin/sh",["-c","pwd -P"],root),',
    'b:run("/bin/sh",["-c","pwd -P"],sub),',
    'c:run("/bin/cat",[file],"/"),',
    'd:run("/usr/bin/stat",["-c","%a %u %g",root],"/"),',
    'e:run("/bin/ls",[root],"/")}));',
  ].join('');

  test('R8 — an unmarked spawn resolves the project root, and nothing inside it', async () => {
    const before = snapshot(runRoot);
    const proj = path.join(box, 'app');
    const SUB = 'cwd-sub';
    // IN THE FAKE REMOTE, so it genuinely exists on "the system": a refusal at
    // a path the source does not have would prove absence, not policy.
    await fs.mkdir(path.join(fakeRemote, proj, SUB), { recursive: true });
    // (e) reads the daemon's OWN output, through the PRODUCT'S OWN TRACE
    // SWITCH. `resolveTraceEnabled()` keys exactly on '1' and is read by
    // `buildFusePlan` IN THIS PROCESS at spawn time (instances.ts:4965), so
    // the switch is set before `spawnWorker()` and restored in the `finally`.
    const prevTrace = process.env.CC_FUSE_TRACE;
    process.env.CC_FUSE_TRACE = '1';
    let inst;
    try {
      inst = await spawnWorker();
      const record = await readRecord(inst.id);
      const out = await inNs(record.anchorPid, 'exec "$1" -e "$2" "$3" "$4" "$5"',
        process.execPath, R8_PROBE,
        inside(record, proj), inside(record, path.join(proj, SUB)),
        inside(record, path.join(proj, 'remote-marker.txt')));
      assert.ok(out.stdout.trim().startsWith('{'),
        `the probe did not run: ${out.stdout} ${out.stderr}`);
      const res = JSON.parse(out.stdout.trim());

      // (a) THE ROOT RESOLVES. Without the exemption the chdir happens in the
      // forked child, which is a brand-new and therefore unmarked thread group,
      // and the process dies before its own image runs.
      assert.equal(res.a.err, null, `the spawn at the project root failed: ${JSON.stringify(res.a)}`);
      assert.equal(res.a.status, 0, `the spawn at the project root failed: ${JSON.stringify(res.a)}`);
      assert.equal(res.a.out, inside(record, proj), JSON.stringify(res.a));

      // (b) A PROJECT-TIER DIRECTORY THAT IS NOT THE ROOT STAYS DENIED. The
      // ruling is the exact project pin and nothing under it.
      assert.equal(res.b.err, 'ENOENT', `a spawn inside the project tree survived: ${JSON.stringify(res.b)}`);

      // (c) A FILE IN THE PROJECT TREE STAYS DENIED — and this is also the
      // arm's NON-VACUITY CONTROL: it can only fail this way for an unmarked
      // caller, so it proves the probe's thread group really is unmarked. R2
      // owns the marked/unmarked pair for a file; this is the same denial
      // reached from the probe that (a) and (b) run in.
      assert.notEqual(res.c.status, 0, `an unmarked caller read a project file: ${JSON.stringify(res.c)}`);
      assert.match(res.c.se, /No such file or directory/, JSON.stringify(res.c));

      // (d) THE MODE IS THE RULING. `d--x--x--x` says "you may enter, you may
      // not read", so `stat` answers and a listing does not.
      assert.equal(res.d.out, '111 0 0', `the project root is not the traverse-only node: ${JSON.stringify(res.d)}`);
      assert.notEqual(res.e.status, 0, `an unmarked caller listed the project root: ${JSON.stringify(res.e)}`);
      assert.equal(res.e.out, '', `a child name reached an unmarked caller: ${JSON.stringify(res.e)}`);

      // (e) THE DAEMON SAID SO ITSELF, rather than the decision being read off
      // a shell's exit code: the routed tier is in the trace, and the root is
      // NOT in the refusal log while the two paths under it are.
      // THE PLAN'S OWN PATH, not one this arm chose: `buildFusePlan` puts the
      // trace at `<rundir>/trace.log` (plan.ts:233) and `wrapLaunch` hands
      // exactly that to the worker as `CC_FUSE_TRACE_LOG` (wrap.ts:88). Read
      // HERE, inside the `try` — the `finally`'s `remove` reclaims the rundir
      // and takes the trace with it, which is also why this arm leaves no
      // temp directory of its own behind.
      const tracePath = path.join(fuseRunDir(inst.id), 'trace.log');
      const trace = await fs.readFile(tracePath, 'utf8').catch(() => '');
      const rows = trace.split('\n').filter(Boolean);
      // THE TWO WAYS THIS CAN GO RED ARE DIFFERENT FINDINGS, so they are
      // distinguished rather than collapsed — but only REACHABLE causes are
      // named. THE PRODUCT TURNS THE TRACE ON and this arm asks it to, over a
      // chain of four explicit links: `CC_FUSE_TRACE=1` →
      // `resolveTraceEnabled()` (plan.ts:144) → `plan.tracePath` =
      // `<rundir>/trace.log` (plan.ts:233) → `wrapLaunch` emitting
      // `CC_FUSE_TRACE_LOG` (wrap.ts:88) → bootstrap.sh exporting
      // `CC_UNION_TRACE` from it (bootstrap.sh:146).
      //
      // AN AMBIENT `CC_UNION_TRACE` IS NOT A CHANNEL, and must not become one
      // again: bootstrap.sh's `else` arm unsets it exactly so that `sudo -E`,
      // which carries the orchestrator's whole environment, cannot leak
      // tracing into a spawn cc chose none for. That hardening is pinned
      // (single assignment site) in `tests/fuse-lifecycle.test.mjs`.
      //
      // NOT sudoers, and that is checked rather than assumed: cc's preflight
      // already probes this exact `sudo -n -E` form with a sentinel
      // (`sudoPreservesEnv`, preflight.ts) and REFUSES the spawn before any
      // arm runs, so a host that does not preserve the environment dies at
      // `spawnWorker` and never reaches this line. The only sudoers channel
      // left is a value-content rule (`env_check`-style) that could
      // discriminate this PATH-valued variable from preflight's plain
      // sentinel — remote enough to name last.
      //
      // Nor is it the daemon failing to OPEN the file: `union.c` refuses to
      // mount when it cannot (`cc-union: trace <path>: …`, then `return 1`),
      // which surfaces as a failed spawn, not as an empty trace here.
      //
      // Still an assertion and never a skip: a guard that skips when its
      // instrument is missing is not a guard.
      assert.ok(rows.length > 0,
        'THE TRACE INSTRUMENT DID NOT RUN — no rows were written, so the assertion below could '
        + 'not be made. In likelihood order: the product\'s trace chain broke a link '
        + '(`resolveTraceEnabled` in plan.ts, `plan.tracePath`, `wrapLaunch` emitting '
        + 'CC_FUSE_TRACE_LOG in wrap.ts, or bootstrap.sh exporting CC_UNION_TRACE from it); '
        + 'this arm\'s own set/restore of process.env.CC_FUSE_TRACE; or — remotely — a sudoers '
        + 'value-content rule filtering a path-valued variable that preflight\'s plain sentinel '
        + 'does not catch. '
        + `A failed fopen is NOT a cause: the daemon refuses to mount instead. Expected rows at ${tracePath}.`);
      const esc = (s) => s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
      assert.ok(rows.some(l => new RegExp(`^getattr\t${esc(proj)}\ttier=cwd .*\\bmark=0\\b`).test(l)),
        `THE DAEMON RAN AND EMITTED NO unmarked tier=cwd ROW for ${proj} — the exemption did not `
        + `fire, or route() assigned another tier (${rows.length} rows traced): `
        + rows.filter(l => l.includes(proj)).slice(-8).join(' | '));
      const events = await eventsOf(inst.id);
      assert.deepEqual(events.filter(r => r[2] === proj && r[3] === 'unmarked-project-denied'), [],
        'the project root was refused to the unmarked caller after all');
      for (const denied of [path.join(proj, SUB), path.join(proj, 'remote-marker.txt')]) {
        assert.ok(events.some(r => r[0] === 'deny' && r[2] === denied && r[3] === 'unmarked-project-denied'),
          `no deny/unmarked-project-denied for ${denied}: ${JSON.stringify(events)}`);
      }
    } finally {
      // NESTED, so a throw from `remove` cannot leave CC_FUSE_TRACE set for
      // every arm after this one. Cross-arm env leakage is how a flake gets
      // manufactured later.
      try {
        if (inst) await instances.remove(inst.id);
      } finally {
        if (prevTrace === undefined) delete process.env.CC_FUSE_TRACE;
        else process.env.CC_FUSE_TRACE = prevTrace;
      }
    }
    assertNoResidue(before, runRoot, null, 'R8');
  });

  // ── R9 ───────────────────────────────────────────────────────────────────
  // THE TWO-CHANGE CAUSATION, as a STANDING ARM rather than a one-off
  // measurement, and stated at a project-tier directory that is NOT the root so
  // both halves stay live after the exemption lands.
  //
  //   cwd is the variable, mark fixed unmarked — `/` spawns, the subdirectory
  //   does not ⇒ moving the session cwd onto a project-tier path is one
  //   precondition of the defect.
  //   mark is the variable, cwd fixed at the subdirectory — unmarked denied,
  //   MARKED served ⇒ the project tier's unmarked denial is the other.
  const R9_PROBE = [
    'const {spawnSync}=require("child_process");',
    'const run=(cwd)=>{const r=spawnSync("/bin/sh",["-c","pwd -P"],{cwd,encoding:"utf8"});',
    'return {status:r.status,err:r.error?r.error.code:null,out:(r.stdout||"").trim()};};',
    'console.log(JSON.stringify({root:run(process.argv[1]),sub:run(process.argv[2])}));',
  ].join('');

  test('R9 — the spawn dies of the cwd AND of the mark, and of neither alone', async () => {
    const before = snapshot(runRoot);
    const proj = path.join(box, 'app');
    const SUB = 'cwd-sub';
    await fs.mkdir(path.join(fakeRemote, proj, SUB), { recursive: true });
    const inst = await spawnWorker();
    try {
      const record = await readRecord(inst.id);
      const sub = inside(record, path.join(proj, SUB));

      // HALF ONE: the mark is held fixed at unmarked and only the cwd moves.
      const out = await inNs(record.anchorPid, 'exec "$1" -e "$2" "$3" "$4"',
        process.execPath, R9_PROBE, '/', sub);
      assert.ok(out.stdout.trim().startsWith('{'), `the probe did not run: ${out.stdout} ${out.stderr}`);
      const res = JSON.parse(out.stdout.trim());
      assert.equal(res.root.status, 0, `the same spawn at / failed: ${JSON.stringify(res.root)}`);
      assert.equal(res.root.out, '/', JSON.stringify(res.root));
      assert.equal(res.sub.err, 'ENOENT', `the unmarked spawn inside the project tree survived: ${JSON.stringify(res.sub)}`);

      // HALF TWO: the cwd is held fixed at the subdirectory and only the mark
      // moves. R7's technique verbatim — `[ -e ]` and `cd` are both BUILTINS,
      // so the marking stat and the chdir are made by ONE thread group; a
      // `cat` or a spawn would be an unmarked child and would answer half one's
      // question again.
      const marked = await inNs(record.anchorPid,
        '[ -e "$1" ] || exit 9; cd "$2" || exit 8; pwd -P',
        inside(record, inst._fuse.plan.markPath), sub);
      assert.equal(marked.ok, true,
        `a MARKED caller could not chdir into the project tree: ${marked.stdout} ${marked.stderr}`);
      assert.equal(marked.stdout.trim(), sub, `${marked.stdout} ${marked.stderr}`);
    } finally {
      await instances.remove(inst.id);
    }
    assertNoResidue(before, runRoot, null, 'R9');
  });

  // ── R10 ──────────────────────────────────────────────────────────────────
  // MODE PRESERVATION AT THE REAL MOUNT, through the syscall sequence an
  // atomic edit actually makes.
  //
  // THE NUMBERING, stated precisely because the short version is ambiguous.
  // Plan 2026-0356 §8.7 gives this arm's CONTENT the label R9. The label R9 in
  // this file is already taken — by the merged card 2026-0373's cwd/mark arm,
  // which is different work that happens to have landed on that number first.
  // So: R10 here is the plan's R9 by content, and R11 here is the plan's R10
  // and R11 merged, because they are one state (see R11's own header).
  //
  // WHY IT WORKS THROUGH A RENAME AND NOT ONLY THROUGH A WRITE: `pt_rename`
  // routes the DESTINATION with FOR_CREATE|FOR_WRITE, so cc FETCHes the 0755
  // target and records its mode against the mirror inode carrying it. The
  // rename then replaces that inode with the tmp file's, cc sees the inode
  // change on the reconcile, and restores. Nothing here tells cc a mode — the
  // ledger is populated by the ordinary open, which is what makes the
  // mechanism inode-driven rather than hint-driven.
  test('R10 — an atomic rename over a 0755 target leaves the system copy 0755', async () => {
    const before = snapshot(runRoot);
    const inst = await spawnWorker();
    try {
      const record = await readRecord(inst.id);
      const mark = inside(record, inst._fuse.plan.markPath);
      const onSystem = (rel) => path.join(fakeRemote, box, 'app', rel);
      const inChroot = (rel) => inside(record, path.join(box, 'app', rel));
      const marked = (script, ...args) => inNs(record.anchorPid,
        `[ -e "$1" ]; ${script}`, mark, ...args);

      await fs.writeFile(onSystem('r10-mode.sh'), '#!/bin/sh\necho one\n');
      await fs.chmod(onSystem('r10-mode.sh'), 0o755);

      // ONE MARKED SHELL, ONE REDIRECTION. `>` is performed by the shell's own
      // thread group, so the create is marked; the new file takes the shell's
      // umask, which is what strips the mode in the first place.
      const mk = await marked('echo two > "$2"', inChroot('r10-tmp'));
      assert.equal(mk.ok, true, `the marked create refused: ${mk.stderr}`);
      const tmpMode = (await fs.stat(onSystem('r10-tmp'))).mode & 0o777;
      assert.notEqual(tmpMode, 0o755,
        `the tmp file already came out 0755 (${tmpMode.toString(8)}), so there is nothing to restore `
        + 'and this arm cannot fail');

      // A SECOND MARKED SHELL, exec\'ing into `mv` — R7 proves the mark
      // survives exec, which is what makes an external binary marked here.
      const mv = await marked('exec mv "$2" "$3"', inChroot('r10-tmp'), inChroot('r10-mode.sh'));
      assert.equal(mv.ok, true, `the marked rename refused: ${mv.stdout} ${mv.stderr}`);

      await waitFor(async () =>
        (await fs.readFile(onSystem('r10-mode.sh'), 'utf8').catch(() => '')).includes('two'),
        { timeout: 15_000 });
      assert.equal((await fs.stat(onSystem('r10-mode.sh'))).mode & 0o777, 0o755,
        'the atomic rename stripped the system copy\'s executable bit');
      // AND THE TMP END IS GONE FROM THE SYSTEM, so the rename landed as a move
      // rather than as a copy that left its scratch file behind.
      await assert.rejects(() => fs.access(onSystem('r10-tmp')),
        'the tmp file is still on the system — the from-end reconcile did not land');
    } finally {
      await instances.remove(inst.id);
    }
    assertNoResidue(before, runRoot, null, 'R10');
  });

  // ── R11 ──────────────────────────────────────────────────────────────────
  // CRITERION 10 END TO END WITH A REAL PUSH FAILURE, and the fault surface it
  // produces. The plan's R10 and R11, in one arm because they are one state:
  // the divergence has to exist before the tool refusal can be asked about.
  //
  // THE WEDGE IS A NON-EMPTY DIRECTORY AT THE SOURCE PATH, and it is the one
  // shape that fails and STAYS failed: `push`'s wrong-kind repair calls
  // `rmdir`, which refuses ENOTEMPTY, so the reconcile cannot recover. A
  // permission wedge would not separate the open from the push (cc copies the
  // source mode onto the mirror, so anything stopping the push stops the open),
  // and R7's mirror-removal wedge is a DIFFERENT branch — cc deliberately does
  // not record a fault for it, because that refusal's wording promises an
  // intact local copy and there is none.
  //
  // NOT R7's ARM AGAIN: R7 pins that close(2) reports EIO. This pins what
  // happens AFTERWARDS — the fault is recorded, the worker's bytes survive, and
  // the tool surface refuses the next write by name.
  test('R11 — a push that cannot land diverges the path, and the tool surface refuses it by name', async () => {
    const before = snapshot(runRoot);
    const inst = await spawnWorker();
    try {
      const record = await readRecord(inst.id);
      const mark = inside(record, inst._fuse.plan.markPath);
      const onSystem = (rel) => path.join(fakeRemote, box, 'app', rel);
      const inChroot = (rel) => inside(record, path.join(box, 'app', rel));
      const unionPath = path.join(box, 'app', 'r11-diverge.txt');

      await fs.writeFile(onSystem('r11-diverge.txt'), 'ORIGINAL\n');

      // Open, write, hold — then wedge the SOURCE while the handle is still
      // open, so the open succeeded and only the reconcile fails.
      const NODE_PROBE = [
        'const fs=require("fs");',
        'const fd=fs.openSync(process.argv[1],"w");',
        'fs.writeSync(fd,"WORKER BYTES\\n");',
        'const t=Date.now(); while(Date.now()-t<4000);',
        'try{fs.closeSync(fd)}catch(e){console.log("CLOSE_ERR:"+e.code);process.exit(3)}',
        'console.log("CLOSE_OK")',
      ].join('');
      const mirrorCopy = path.join(fuseRunDir(inst.id), 'mirror', unionPath);
      const writer = inNs(record.anchorPid,
        '[ -e "$1" ]; exec "$3" -e "$4" "$2"',
        mark, inChroot('r11-diverge.txt'), inside(record, inst._fuse.plan.markPath), NODE_PROBE);
      await waitFor(async () =>
        (await fs.readFile(mirrorCopy, 'utf8').catch(() => '')).includes('WORKER BYTES'),
        { timeout: 15_000 });
      await fs.rm(onSystem('r11-diverge.txt'));
      await fs.mkdir(path.join(onSystem('r11-diverge.txt'), 'occupied'), { recursive: true });
      await fs.writeFile(path.join(onSystem('r11-diverge.txt'), 'occupied', 'x'), 'y\n');

      const w = await writer;
      assert.match(w.stdout, /CLOSE_ERR:EIO/,
        `close(2) did not report the refused reconcile: ${w.stdout} ${w.stderr}`);

      // 1. THE FAULT IS RECORDED, on the session's own control server.
      const fault = inst._fuse.controlServer.faultAt(unionPath);
      assert.ok(fault, 'the push failed and the session recorded no fault');
      assert.equal(fault.kind, 'diverged');

      // 2. THE WORKER'S BYTES SURVIVE. The claim is kept, so cc's own cache
      //    management cannot re-shape the mirror entry away — and a marked
      //    READ of the path still serves them.
      const read = await inNs(record.anchorPid, '[ -e "$1" ]; read L < "$2"; echo "$L"',
        mark, inChroot('r11-diverge.txt'));
      assert.match(read.stdout, /WORKER BYTES/,
        `a diverged path stopped serving the bytes the refusal promises: ${read.stdout} ${read.stderr}`);

      // 3. A SECOND WRITE OPEN IS REFUSED AT THE SYSCALL.
      const REOPEN = [
        'const fs=require("fs");',
        'try{fs.closeSync(fs.openSync(process.argv[1],"w"))}catch(e){console.log("OPEN_ERR:"+e.code);process.exit(3)}',
        'console.log("OPEN_OK")',
      ].join('');
      const again = await inNs(record.anchorPid,
        '[ -e "$1" ]; exec "$3" -e "$4" "$2"',
        mark, inChroot('r11-diverge.txt'), inside(record, inst._fuse.plan.markPath), REOPEN);
      assert.match(again.stdout, /OPEN_ERR:EIO/,
        `a diverged path accepted a second write: ${again.stdout} ${again.stderr}`);

      // 4. THE FAULT SURFACE, AT THE HOOK, TWO-DIRECTIONALLY. `Read` is
      //    ALLOWED — which is only possible because the tier gate allows this
      //    path — and `Write` at the SAME path is refused by the fault, naming
      //    the file. That pair is the proof the plan asks for: a path
      //    `classifyForTool` allows, refused by `preToolUse`.
      const redirect = inst._redirect;
      assert.ok(redirect, 'the session has no redirect, so the hook surface cannot be asked');
      assert.deepEqual(await redirect.preToolUse('Read', { file_path: unionPath }),
        { decision: 'allow' },
        'the tier gate denies this path, so a Write denial below would prove nothing about faults');
      const d = await redirect.preToolUse('Write', { file_path: unionPath });
      assert.equal(d.decision, 'deny');
      assert.match(d.reason, new RegExp(unionPath.replace(/[.*+?^$()|[\]\\]/g, '\\$&')),
        'the refusal does not name the file');
      assert.match(d.reason, /have diverged/);
      assert.match(d.reason, /Bash runs ON SYSTEM 'fusebox'/,
        'the refusal does not point at Bash on the system');

      // 5. AND THE SAME SENTENCE REACHES THE WORKER IN BAND, through the only
      //    channel a post-return failure has.
      const note = await redirect.postToolUse('Write', { file_path: unionPath }, { ok: true });
      assert.match(String(note), /have diverged/,
        'a reconcile that failed after the tool returned reached the worker nowhere');

      // 6. THE SYSTEM COPY WAS NEVER OVERWRITTEN — the wedge is still there,
      //    intact, which is what "cc will not overwrite the system's copy"
      //    means.
      assert.equal(await fs.readFile(path.join(onSystem('r11-diverge.txt'), 'occupied', 'x'), 'utf8'), 'y\n');
    } finally {
      await instances.remove(inst.id);
    }
    assertNoResidue(before, runRoot, null, 'R11');
  });

  // ── ARM 7 ────────────────────────────────────────────────────────────────
  // PINS: nothing this run started is still running, established WITHOUT
  // reading mount.json. Ordered last in the file so it sees every earlier arm's
  // residue; node:test runs the tests in a file sequentially.
  test('arm 7 — no process attributable to this run survives it (record-independent)', async () => {
    const leaked = await attributableProcesses();
    console.log(`fuse gate [arm 7] processes carrying CC_FUSE_RUNDIR under ${runRoot}: ${leaked.length}`);
    assert.deepEqual(leaked, [], `this run leaked ${JSON.stringify(leaked)}`);
  });
});
