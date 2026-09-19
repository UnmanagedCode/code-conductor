// THE LIFECYCLE ARMS of the real-FUSE gate. Skipped by default — opt in with
// `RUN_FUSE_LIFECYCLE=1`.
//
//   TEST_CONCURRENCY=1 RUN_FUSE_LIFECYCLE=1 node tests/run.mjs tests/fuse-*.real.test.mjs
//
// THE CAP IS NOT OPTIONAL. These four files each spawn real workers into real
// FUSE mounts, and at the default concurrency they starve each other: measured
// 3 kills in 18 runs of the bare glob, always one arm riding the runner's 60s
// per-test timeout until its whole file died at FILE_KILL_MS. tests/run.mjs has
// no per-file exclusivity, so the cap lives in the invocation. See
// docs/architecture.md -> "The FUSE-union chroot" for the measurements.
//
// One of the four tests/fuse-*.real.test.mjs files. The dependency preflight,
// the server, the three systems, the mirror scaffold, the shared observation
// helpers and the family-wide rules (PID DISCIPLINE, the before/after delta)
// live in ./fuseGateCase.mjs, which lists the family.
//
// The one question this file exists to answer, and the one that can stop the
// whole effort: can cc spawn a worker inside a private mount namespace with the
// union mounted, and tear it down through its EXISTING lifecycle —
// `kill_instance`, a `kill -9` crash, and an orchestrator restart — leaving no
// mount in /proc/1/mounts and no orphaned daemon?

import { describe, test } from 'node:test';
import assert from 'node:assert/strict';
import { promises as fs, existsSync } from 'node:fs';
import { randomUUID } from 'node:crypto';
import path from 'node:path';
import { api, waitFor } from './helpers.mjs';
import { killPids } from './procTree.mjs';
import { fuseRunDir, fuseRunRoot } from '../src/systems/fuse/plan.ts';
import {
  ENABLED, setupFuseGate, spawnWorker, attributableProcesses,
  snapshot, readRecord, assertNoResidue, mountsUnder, startOf, alive, sh, HERE,
} from './fuseGateCase.mjs';

// The handles every test body below reads. Bound inside the harness's own
// `before`, which is the only place they are guaranteed booted — see
// setupFuseGate() in ./fuseGateCase.mjs.
let baseUrl, instances, runRoot;

describe('a worker inside a FUSE-union chroot: the lifecycle gate', { skip: !ENABLED }, () => {
  setupFuseGate('lifecycle', c => { ({ baseUrl, instances, runRoot } = c); });

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

    // THE FARM IS REACHABLE THROUGH THE UNION, and its links resolve. The
    // worker's CLI config directory lives under the store — host-pinned by the
    // `projectsRoot` prefix — while its entries are symlinks into `$HOME`,
    // which is pinned whole and separately. A pin boundary between a link and
    // its target would answer -ENOENT to the marked CLI, and the worker would
    // launch with no settings, no plugins and no skills while reporting
    // nothing: the union serves the link, so the target has to have a tier of
    // its own.
    //
    // Read INSIDE the chroot, at the union's own spelling, because that is the
    // only place the pin boundary exists — a host-side read would pass whatever
    // the tier table said.
    // Read INSIDE the union, at the worker's own spelling, because that is the
    // only place the pin boundary exists — a host-side read would pass whatever
    // the tier table said. `nsenter` into the daemon's namespace and chroot,
    // dropped to cc's uid exactly as the Bash forwarder's children run.
    const cfg = inst._spawnEnv.CLAUDE_CONFIG_DIR;
    assert.ok(cfg, 'a remote-backed worker was launched with no CLAUDE_CONFIG_DIR');
    const inUnion = (script) => sh('sudo', ['-n', 'nsenter', `--mount=/proc/${record.daemonPid}/ns/mnt`, '--',
      'chroot', record.root,
      'setpriv', `--reuid=${process.getuid()}`, `--regid=${process.getgid()}`, '--init-groups', '--',
      '/bin/sh', '-c', script]);

    const seen = await inUnion(`test -r ${JSON.stringify(path.join(cfg, 'settings.json'))}`);
    assert.equal(seen.ok, true,
      `the union did not serve ${cfg}/settings.json to the worker — the farm link or its `
      + `target is unpinned, so the CLI starts with no settings: ${seen.stderr}`);
    // `projects/` is a real directory in the farm, not a link, and the worker
    // must be able to WRITE its transcript there.
    const wrote = await inUnion(`: > ${JSON.stringify(path.join(cfg, 'projects', '.cc-probe'))}`);
    assert.equal(wrote.ok, true,
      `the worker cannot write its own transcript dir under ${cfg}/projects: ${wrote.stderr}`);

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
  // it is: a FUSE-level deadlock. Under this geometry there is no route to one
  // to construct. A remote-tier op is answered
  // from `<rundir>/mirror`, a SIBLING of the mountpoint, whose contents cc
  // materialises over the control socket — so no path the daemon serves is
  // backed by the union itself. And cc's handler runs OUTSIDE the namespace,
  // where the mount does not exist at all, so it cannot re-enter it however the
  // source root is configured. The self-recursion guard survives as a liveness
  // precondition for a caller in the daemon's own thread group, not as the
  // thing standing between this arm and a deadlock. So what is pinned here is
  // the WEDGE class — a busy mount, bounded, reported, then swept — and the
  // deadlock class is pinned by the deterministic suite's fake driver, not
  // here.
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
        // and under the fail-closed tier an unpinned `/srv` does not exist at
        // all, so it cannot be the holder's directory.
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
    // the same reason every other arm in the family uses one — an absolute
    // assertion would report an earlier arm's residue as this one's leak.
    const runDirsAfter = (await fs.readdir(runRoot).catch(() => [])).sort();
    assert.deepEqual(runDirsAfter, runDirsBefore,
      `the refused spawn created ${JSON.stringify(runDirsAfter.filter(d => !runDirsBefore.includes(d)))}`);
  });

  // ── ARM 8 ────────────────────────────────────────────────────────────────
  // PINS: cc's whole sudoers requirement is a plain NOPASSWD rule. Nothing
  // rides through sudo, and the worker's own environment reaches the CLI
  // anyway — over the two 0600 files `wrapLaunch` composes and
  // `FuseSession.wrap` writes into the run directory.
  //
  // THIS IS THE ONLY PLACE THE CLAIM IS OBSERVABLE. The unit suite pins what
  // `wrapLaunch` EMITS; whether a variable emitted into a file actually lands
  // in the CLI's environment is a question about sudo, `unshare`, `chroot` and
  // `setpriv` on a real host, and only a real launch answers it.
  //
  // ORDERED BEFORE ARM 7, which must stay last — it sees every earlier arm's
  // residue.
  test("arm 8 — the launch needs NOPASSWD only: sudo strips the environment here, and the worker's own env arrives anyway", async () => {
    const before = snapshot(runRoot);

    // (1) THE POSITIVE CONTROL, AND IT COMES FIRST. Every assertion below is
    //     evidence only if the environment does NOT cross sudo on THIS host,
    //     which is the condition a NOPASSWD-without-SETENV host is in. On a
    //     host that disables `env_reset` the rest of this arm would pass
    //     whether the file channel works or not.
    const { execFile } = await import('node:child_process');
    const control = await new Promise((res) => execFile('sudo',
      ['-n', '/bin/sh', '-c', 'printf %s "${CC_GATE_SENTINEL-ABSENT}"'],
      { timeout: 30_000, env: { ...process.env, CC_GATE_SENTINEL: 'ok' } },
      (e, so) => res({ ok: !e, out: String(so ?? '') })));
    assert.equal(control.ok, true, 'the control could not run `sudo -n` at all');
    assert.equal(control.out, 'ABSENT',
      'a sentinel exported into this process crossed `sudo -n` on this host, so `env_reset` is '
      + 'disabled here and this arm cannot be run: every assertion below would be satisfied by '
      + 'sudo carrying the environment, which is exactly what the file channel exists to stop '
      + 'depending on. Re-run on a host with sudo\'s default `env_reset`.');

    // (2) A MARKER ONLY THE FILE CHANNEL CAN CARRY. `src/instances.ts` builds
    //     the worker env as `{...process.env}`, so this reaches `spec.env`;
    //     given (1), sudo is not a path it can take.
    const marker = randomUUID();
    const prev = process.env.CC_GATE_MARKER;
    let inst = null;
    let record = null;
    try {
      process.env.CC_GATE_MARKER = marker;
      inst = await spawnWorker();
      record = await readRecord(inst.id);
      assert.ok(record, 'no mount.json handshake was written');

      // Readable to cc for the same reason arm 1's `/proc/<pid>/root` is: by
      // now setpriv has dropped the worker to cc's own uid.
      const raw = await fs.readFile(`/proc/${record.bootstrapPid}/environ`, 'utf8');
      const entries = raw.split('\0').filter(Boolean);
      const value = (name) => {
        const at = entries.find(e => e.startsWith(`${name}=`));
        return at === undefined ? null : at.slice(name.length + 1);
      };

      // (3) THE CLI'S OWN ENVIRONMENT ARRIVED.
      assert.equal(value('CC_GATE_MARKER'), marker,
        "a variable set in cc's process did not reach the CLI. Given the control above, the worker "
        + 'environment file is the only channel from cc to the worker, so this is that channel');

      // (4) AND IT IS CC'S PATH, NOT SUDOERS' `secure_path` — the one variable
      //     sudo replaces rather than drops, and the reason a smuggling alias
      //     existed at all. `tierTable`'s `resolveOnPath` resolves a bare
      //     launcher name against cc's list, and the in-chroot `setpriv` must
      //     resolve it against the same one.
      assert.equal(value('PATH'), process.env.PATH,
        "the worker's PATH is not cc's, so a bare `claude` resolves against a different list "
        + 'inside the chroot than the pins were derived from');
      assert.equal(value('CC_FUSE_PATH'), null,
        'CC_FUSE_PATH is back in the worker environment');

      // (5) AND THE PLAN'S OWN NAMES ARE EXPORTED, WITH THE PLAN'S VALUES.
      //     `procScan.ts` and `sweep.ts` attribute a process by reading exactly
      //     these two out of `/proc/<pid>/environ`; a plan file written without
      //     `export`, or a worker file that overwrote them, blinds the orphan
      //     backstop and the boot sweep with every other arm still green.
      assert.equal(value('CC_FUSE_INSTANCE_ID'), inst.id);
      assert.equal(value('CC_FUSE_RUNDIR'), fuseRunDir(inst.id));

      // (6) AND THE WORKER FILE IS GONE WHILE THE SESSION IS STILL UP. It is
      //     cc's whole environment, API keys included, and step 10's `.` is its
      //     only reader; left behind it would sit in the run directory for the
      //     life of the session, past a wedged teardown until the next boot
      //     sweep, and into any backup of the orch store. The PLAN file is
      //     still there, which is what makes this an unlink rather than a
      //     launch that wrote neither.
      const fusePlan = inst._fuse.plan;
      assert.equal(existsSync(fusePlan.workerEnvPath), false,
        `${fusePlan.workerEnvPath} outlived the launch that read it`);
      assert.equal(existsSync(fusePlan.planEnvPath), true,
        `${fusePlan.planEnvPath} is gone too, so (6) above is satisfied by a launch that wrote `
        + 'neither file rather than by the unlink');
    } finally {
      if (prev === undefined) delete process.env.CC_GATE_MARKER;
      else process.env.CC_GATE_MARKER = prev;
      if (inst) await instances.remove(inst.id);
    }
    assertNoResidue(before, runRoot, record, 'arm 8');
  });

  // ── ARM 7 ────────────────────────────────────────────────────────────────
  // PINS: nothing this file started is still running, established WITHOUT
  // reading mount.json. Ordered last in the file so it sees every earlier arm's
  // residue; node:test runs the tests in a file sequentially.
  //
  // ITS SCOPE IS THIS FILE, not the run: `runRoot` derives from this file's own
  // store root, so the scan can only ever see residue this process created. The
  // same check runs for the other three files in the shared `after()` hook in
  // ./fuseGateCase.mjs — but as a TRIPWIRE, not as coverage: only here does
  // arm 4 hold an attributable process alive and assert the scan SEES it, so
  // only here is a zero known to be a scan that could have found something.
  //
  // ── THE SAME BLINDNESS REACHES THE MOUNT-RESIDUE OBSERVATION ────────────
  //
  // Not just the /proc scan. Every arm in the family that takes a residue delta
  // measures it UNDER `runRoot`, so a `runRoot` that is wrong-but-plausible
  // makes both sides of the delta read empty and the arm passes vacuously — the
  // same shape `mountsUnder` refuses a non-absolute root to prevent, and which
  // nothing here can refuse. MEASURED: publish a valid absolute root that is not this
  // run's (`/opt`) and the mount, routing and marking files all stay green,
  // 7/7, 7/7 and 4/4. `CTX_SHAPE` in ./fuseGateCase.mjs cannot close this — no
  // predicate there distinguishes the true run root from any other absolute
  // path, and the refusal in `mountsUnder` does not either.
  //
  // WHAT DOES CLOSE IT IS IN THIS FILE, AND ONLY THIS FILE: arm 1 and arm 4
  // assert POSITIVE mount membership — that `record.root` IS in the daemon's
  // or the anchor's table under `runRoot` — which a wrong root cannot satisfy.
  // That is why the same `/opt` substitution kills here and nowhere else. So
  // for the other three files, both record-independent observations — the
  // process scan and the mount delta — rest on this file's positive controls
  // holding in a sibling process, and neither is claimed as coverage there.
  test('arm 7 — no process attributable to this run survives it (record-independent)', async () => {
    const leaked = await attributableProcesses();
    console.log(`fuse gate [arm 7] processes carrying CC_FUSE_RUNDIR under ${runRoot}: ${leaked.length}`);
    assert.deepEqual(leaked, [], `this run leaked ${JSON.stringify(leaked)}`);
  });
});
