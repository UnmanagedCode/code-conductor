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
import { fuseRunDir, fuseRunRoot } from '../src/systems/fuse/plan.ts';
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
  let ctx, baseUrl, instances, home, box, prevFuse, runRoot;
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

    prevFuse = process.env.CC_FUSE_WORKERS;
    process.env.CC_FUSE_WORKERS = '1';
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
    await fs.writeFile(path.join(box, 'app', 'remote-marker.txt'), 'SYSTEM-SIDE-PROJECT-FILE\n');

    await addSystem({ id: 'fusebox', label: 'fusebox', launch: ['node', FIXTURE] });
    assert.equal((await adoptProject('app', path.join(box, 'app'), { system: 'fusebox' })).ok, true);
  });

  after(async () => {
    for (const [where, rows] of Object.entries(timings)) {
      if (!rows.length) continue;
      const f = (k) => rows.map(r => r[k]).join('/');
      console.log(`fuse gate timing [${where}] n=${rows.length} spawn→idle ms: ${f('spawnMs')} | turn ms: ${f('turnMs')}`);
    }
    if (ctx) await ctx.instances.shutdown();
    disposeSystemHandles();
    if (prevFuse === undefined) delete process.env.CC_FUSE_WORKERS; else process.env.CC_FUSE_WORKERS = prevFuse;
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

    // The stand-in remote's bytes are behind the project tier — the mechanism
    // criterion 7 rests on, with NO transport (see plan.ts's stand-in label).
    const seen = await sh('sudo', ['-n', 'nsenter', `--mount=/proc/${record.anchorPid}/ns/mnt`, '--',
      'cat', path.join(record.root, box, 'app', 'remote-marker.txt')]);
    assert.match(seen.stdout, /SYSTEM-SIDE-PROJECT-FILE/, seen.stderr);

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

    inst._fuse = null;               // cc's memory of the mount, gone with the process
    instances.shutdownForResumeSync();
    instances.byId.delete(inst.id);
    await waitFor(() => inst.proc === null, { timeout: 20_000 });

    // NON-VACUITY: the restart really did leave residue for the sweep to find.
    // Without this the arm would pass against an already-clean machine.
    assert.ok(alive(record.daemonPid, record.daemonStart), 'the daemon did not survive the restart shutdown');
    assert.ok(alive(record.anchorPid, record.anchorStart), 'the anchor did not survive the restart shutdown');
    assert.ok(mountsUnder(record.anchorPid, runRoot).includes(record.root), 'the union was already unmounted');

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
  // it is: a FUSE-level deadlock (S3 §A3's W-D1/W-D2). Those need the union's
  // mountpoint to be reachable by walking its own remote tier, and with the
  // frozen daemon's self-recursion guard ON — which is its default, and which
  // this build does not turn off — a remote-side loop is refused by the daemon
  // rather than deadlocking in it: measured here, the probe ANSWERED for both a
  // union-root bind and a self-recursive one. The other route to the shape is
  // the mountpoint lying inside the remote root, and that is refused at
  // CONFIGURATION time (plan.ts, FUSE_MIRROR_CONTAINS_MOUNT). So the deadlock's
  // classification is pinned by the deterministic suite's fake driver and by
  // S3's own measurement of the abort, not here.
  test('arm 5 — a mount that will not unmount in place is torn down bounded, with no residue', async () => {
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
      const started = await sh('sudo', ['-n', 'nsenter', ns, '--', '/bin/sh', '-c',
        // stdio detached, or `sudo` waits on the backgrounded process's
        // inherited stdout for the whole 300 s.
        'cd "$1" && { sleep 300 </dev/null >/dev/null 2>&1 & echo $!; }', 'sh', path.join(record.root, 'srv')]);
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
      if (holderPid && holderStart) killPids([{ pid: holderPid, ident: holderStart }], { identOf: startOf });
      if (instances.byId.has(inst.id)) await instances.remove(inst.id).catch(() => {});
    }

    // Either outcome is acceptable and both must be TRUE: a clean teardown, or
    // a wedge whose record says so and which the sweep then clears.
    const kept = await readRecord(inst.id);
    console.log(`fuse gate: busy-mount arm → ${kept ? `record kept, terminalState=${kept.terminalState}, residual=${JSON.stringify(kept.residualMounts)}` : 'teardown finished clean'}`);
    if (kept) {
      assert.equal(kept.wedged, true, 'a kept record must say it is wedged');
      assert.ok(typeof kept.terminalState === 'string' && kept.terminalState.length > 0);
      const sweeper = await sh(process.execPath, ['--experimental-strip-types',
        path.join(HERE, 'fixtures', 'fuseSweepProbe.mjs'), fuseRunRoot()]);
      assert.ok(sweeper.ok, sweeper.stderr);
    }
    assertNoResidue(before, runRoot, record, 'arm 5');
  });

  // ── THE CONTROL MEASUREMENT ──────────────────────────────────────────────
  // Not an assertion. The same project, the same provider and the same fake CLI
  // with the chroot turned OFF, so the only variable between the two rows
  // printed by `after` is the union and its zero-caching mount options.
  test('control — the same turn with the chroot disengaged, for the cost comparison', async () => {
    delete process.env.CC_FUSE_WORKERS;
    let inst;
    try {
      for (let i = 0; i < 3; i++) {
        inst = await spawnWorker('control');
        assert.equal(inst._fuse, null, 'the control worker was wrapped after all');
        await instances.remove(inst.id);
      }
    } finally { process.env.CC_FUSE_WORKERS = '1'; }
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
});
