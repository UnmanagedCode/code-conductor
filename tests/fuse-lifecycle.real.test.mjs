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
// leaked is distinguished from what it inherited. A host can carry inherited
// FUSE residue — stale minors, inert, freeing nothing — and an absolute
// assertion would either fail on it or hide a leak under it.
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
import { bootServer, api, freshProjectsRoot, padPathTo, rmrf, waitFor } from './helpers.mjs';
import { seedRepo } from './remoteSystem.mjs';
import { mkdtemp } from './tmpRegistry.mjs';
import { killPids } from './procTree.mjs';
import { adoptProject, orchStoreRoot } from '../src/projects.ts';
import { addSystem } from '../src/appSettings.ts';
import { disposeSystemHandles } from '../src/systems/registry.ts';
import { EVENT_LOG_NAME, fuseRunDir, fuseRunRoot } from '../src/systems/fuse/plan.ts';
import { SUN_PATH_MAX } from '../src/systems/fuse/control.ts';
import { resolveTierEntry } from '../src/systems/fuse/tierTable.ts';
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

// THE MIRROR-SOURCE DIRECTORY SCAFFOLD a wide `mirrorRoot` needs — see the
// block in `before()` that calls it for WHY. Directories only, and a symlink to
// a directory becomes a real directory in the mirror (`/bin`, `/lib64` and
// `/sbin` are usrmerge symlinks on this host, and the bootstrap traverses them).
//
// THE VIRTUAL FILESYSTEMS ARE SKIPPED because they are `bind` tier and never
// consult the mirror, and `/tmp` because the seeded project already places
// `<fakeRemote><box>/wide/appw` there and walking it would copy every sibling
// temp dir on the box.
const MIRROR_SCAFFOLD_DEPTH = 4;
const MIRROR_SCAFFOLD_SKIP = new Set(
  ['/proc', '/sys', '/dev', '/run', '/tmp', '/mnt', '/media', '/snap', '/lost+found']);

async function scaffoldMirrorDirs(into, dir, depth) {
  if (depth === 0) return;
  for (const e of await fs.readdir(dir, { withFileTypes: true }).catch(() => [])) {
    const p = path.join(dir, e.name);
    if (MIRROR_SCAFFOLD_SKIP.has(p)) continue;
    if (!(e.isDirectory()
      || (e.isSymbolicLink() && await fs.stat(p).then(st => st.isDirectory(), () => false)))) continue;
    await fs.mkdir(path.join(into, p), { recursive: true }).catch(() => {});
    await scaffoldMirrorDirs(into, p, depth - 1);
  }
}

// Every STRICT ancestor of `p`, root first.
const ancestorsOf = (p) => {
  const out = ['/'];
  const parts = p.split('/').filter(Boolean);
  for (let i = 1; i < parts.length; i++) out.push('/' + parts.slice(0, i).join('/'));
  return out;
};

describe('a worker inside a FUSE-union chroot: the lifecycle gate', { skip: !ENABLED }, () => {
  let ctx, baseUrl, instances, home, box, runRoot, fakeRemote, prevFakeRemote;
  // Reported, not asserted on: the wall time of a spawn and of one turn, inside
  // the chroot and outside it. The cost of attr_timeout=0/entry_timeout=0 is
  // unmeasured and is the one that matters: the union serves every page of the
  // CLI binary with no kernel cache. RECORD IT, DO NOT TUNE IT — if it is unusable that is the report,
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
    // ── THE WHOLE GATE RUNS AT A LONG STORE ROOT ────────────────────────────
    //
    // Addressed by its real path, the control socket would make the store
    // root's depth a spawn-time cliff: past Linux's 107-byte `sun_path`,
    // `bind(2)` answers a bare `EINVAL`. It is addressed through a directory
    // fd instead, and every arm below is the proof — spawn, mount, serve, tear
    // down, sweep — rather than one dedicated arm that would need a second
    // fake-remote scaffold to duplicate.
    //
    // CONSTRUCTED, NEVER REASONED ABOUT. The assertion is on the store root
    // ALONE, so no accounting of what cc adds below it can quietly go slack.
    process.env.PROJECTS_ROOT = await padPathTo(process.env.PROJECTS_ROOT, SUN_PATH_MAX + 1);
    assert.ok(Buffer.byteLength(orchStoreRoot()) > SUN_PATH_MAX,
      `the gate must run at a store root longer than sun_path itself; got ${Buffer.byteLength(orchStoreRoot())} bytes at ${orchStoreRoot()}`);
    runRoot = fuseRunRoot();

    // The fake remote is DELIBERATELY NARROW: one project tree and nothing
    // else. A wide fake remote would shadow host paths the tier table does not
    // pin — measured: a `create` at an unpinned path landed on the remote and
    // was absent from the host.
    box = await fs.realpath(await mkdtemp('cc-fuse-box-'));
    await seedRepo(path.join(box, 'app'));
    await fs.writeFile(path.join(box, 'app', 'remote-marker.txt'), 'HOST-SIDE-COPY\n');

    // THE FAKE REMOTE, AND ITS BYTES DIFFER FROM THE HOST'S AT THE SAME PATH.
    // That is the whole reason the override exists: a bind-mount stand-in
    // makes the two identical, and criteria 3 and 4 are only checkable when a
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

    // ── A SECOND SYSTEM, WHOSE ADVERTISEMENT CARRIES AN `exclude` ───────────
    //
    // R13(a) needs a prefix that is `fail` BY AN EXPLICIT PIN rather than by
    // being unnamed, and an exclude is the only thing that renders one
    // (`buildTierTable`). It has to be a second system: the exclude reaches the
    // table only when the provider advertises the mirror capability at all
    // (`advertises` in mirrorFixtureProvider.mjs is `mirrorRoot !== null ||
    // …`), so switching `fusebox` on would change the mirror-scope source for
    // every arm above.
    //
    // The advertised root is the project's own path — the same value the default
    // resolves to — so the ONLY difference from `fusebox` is the exclude.
    await seedRepo(path.join(box, 'appx'));
    await fs.writeFile(path.join(box, 'appx', 'remote-marker.txt'), 'HOST-SIDE-COPY\n');
    // THE EXCLUDED PREFIX EXISTS ON THE HOST AND NOT ON THE SYSTEM, which is
    // what makes R13(a) non-vacuous: a read that succeeds can only have come
    // from the host, and the marked side has no copy to have served.
    await fs.mkdir(path.join(box, 'appx', 'excluded'), { recursive: true });
    await fs.writeFile(path.join(box, 'appx', 'excluded', 'host.txt'), 'HOST-SIDE-EXCLUDED\n');
    await fs.mkdir(path.join(fakeRemote, box, 'appx'), { recursive: true });
    await fs.writeFile(path.join(fakeRemote, box, 'appx', 'remote-marker.txt'), 'SYSTEM-SIDE-PROJECT-FILE\n');
    await addSystem({ id: 'fuseboxx', label: 'fuseboxx', launch: ['node', FIXTURE,
      '--advertise-mirror', path.join(box, 'appx'),
      '--advertise-exclude', path.join(box, 'appx', 'excluded')] });
    assert.equal((await adoptProject('appx', path.join(box, 'appx'), { system: 'fuseboxx' })).ok, true);

    // ── PROJECT-TIER PATHS THE HOST HAS NOTHING AT ──────────────────────────
    //
    // An unmarked caller is served the HOST wherever the host has an entry,
    // whatever the tier. `before()` deliberately seeds a host tree
    // at each project's OWN absolute spelling — that is how R2 proves "never a
    // host fallback" for a MARKED caller — so every `-ENOENT` assertion below
    // has to move onto a path the host has nothing at, or the host tree answers
    // it and the arm is vacuous.
    //
    // A file AND a directory, because the arms need both: a read that must be
    // denied and a chdir that must be denied.
    for (const app of ['app', 'appx']) {
      await fs.writeFile(path.join(fakeRemote, box, app, 'remote-only.txt'), 'SYSTEM-ONLY-FILE\n');
      await fs.mkdir(path.join(fakeRemote, box, app, 'remote-only-sub'), { recursive: true });
      assert.equal(await fs.stat(path.join(box, app, 'remote-only.txt')).then(() => true, () => false),
        false, `the host has an entry at <box>/${app}/remote-only.txt, so the denial arms are vacuous`);
    }

    // ── THE MIRROR SOURCE HAS TO LOOK LIKE A SYSTEM, NOT LIKE ONE PROJECT ──
    //
    // MEASURED, and it is the fixture precondition a wide root imposes: at
    // `mirrorRoot: '/'` every UNPINNED DIRECTORY becomes `project` tier —
    // including the ancestors of the host pins (`/usr` above
    // `/usr/bin/setpriv`, `/usr/lib/x86_64-linux-gnu` above `libc.so.6`). A
    // MARKED caller resolves those through the control channel, so the mirror
    // SOURCE must have a directory at each of them. A real remote system has
    // them by construction; this fixture's fake remote is deliberately narrow
    // (one project tree), and without this scaffold the bootstrap's
    // `exec /usr/bin/setpriv` died at `/usr` with `remote-absent` — the daemon
    // named the path — and the worker never reached the CLI.
    //
    // DIRECTORIES ONLY, WHICH IS WHY IT DOES NOT REINTRODUCE THE HAZARD the
    // narrow fake remote exists to avoid: an unpinned FILE under one of these
    // is still absent on "the system" and still answers -ENOENT to a marked
    // caller, exactly as it did when the same path was `fail`.
    //
    // R14 CHECKS THIS PRECONDITION AGAINST THE DAEMON'S OWN PIN LIST rather
    // than trusting the depth constant, so a future pin whose ancestors the
    // walk does not reach fails by name instead of as a mystery spawn death.
    for (const p of [orchStoreRoot(), runRoot, home, process.env.CLAUDE_PROJECTS_ROOT])
      // `/tmp` is skipped by the walk below (it holds this run's own store and
      // ~10k sibling temp dirs), so the chains of the run's own roots — the
      // store, the FUSE run root and the CLI's home, which between them carry
      // the DEEPEST pins in the table — are created explicitly.
      await fs.mkdir(path.join(fakeRemote, p), { recursive: true });
    await scaffoldMirrorDirs(fakeRemote, '/', MIRROR_SCAFFOLD_DEPTH);

    // ── A THIRD SYSTEM, ADVERTISING THE WIDE ROOT, AND A PROJECT THE HOST HAS
    //    NOTHING AT ─────────────────────────────────────────────────────────
    //
    // `mirrorRoot: '/'` is the configuration the wide-root pin exists for:
    // `project /` swallows every unpinned intermediate directory and the
    // synthetic scaffold collapses, which without the host-existence
    // substitution kills the unmarked chroot process resolving /bin.
    //
    // THE PROJECT PATH MUST BE ABSENT FROM THE HOST, or every -ENOENT and every
    // overlay-node assertion in R14 is answered by a host tree instead of by
    // policy.
    // Only a WIDE root can have one: `_assertRemoteMountable` lstats the mirror
    // root through this fixture's host-local provider, so a DEFAULT-root project
    // must exist on the host and its cwd chain is host-served end to end.
    //
    // TWO host-absent links, not one, so R14 can decide whether the chain ABOVE
    // the cwd leaf needs traversal at all, which is still open.
    await seedRepo(path.join(box, 'wide', 'appw'));                 // host: for the adopt probe only
    await seedRepo(path.join(fakeRemote, box, 'wide', 'appw'));     // the system's own copy
    await fs.writeFile(path.join(fakeRemote, box, 'wide', 'appw', 'remote-marker.txt'),
      'SYSTEM-SIDE-PROJECT-FILE\n');
    await addSystem({ id: 'fusewide', label: 'fusewide',
      launch: ['node', FIXTURE, '--advertise-mirror', '/'] });
    assert.equal((await adoptProject('appw', path.join(box, 'wide', 'appw'),
      { system: 'fusewide' })).ok, true);
    // AFTER the adopt, BEFORE any spawn. `<box>` and `/tmp` stay on the host, so
    // the chain is host / host / host / ABSENT / ABSENT and the
    // first-host-ancestor bound has something to stop at.
    await fs.rm(path.join(box, 'wide'), { recursive: true, force: true });
    assert.equal(await fs.stat(path.join(box, 'wide')).then(() => true, () => false), false,
      'the host still has an entry at the wide project’s parent, so R14 is vacuous');
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
  async function spawnWorker(where = 'chroot', project = 'app') {
    const tSpawn = Date.now();
    const r = await api(baseUrl, 'POST', '/api/instances', { project, mode: 'bypassPermissions' });
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
    // the same reason every other arm uses one — an absolute assertion would
    // report an earlier arm's residue as this one's leak.
    const runDirsAfter = (await fs.readdir(runRoot).catch(() => [])).sort();
    assert.deepEqual(runDirsAfter, runDirsBefore,
      `the refused spawn created ${JSON.stringify(runDirsAfter.filter(d => !runDirsBefore.includes(d)))}`);
  });
  // ══ THE MOUNT'S OWN ARMS ══════════════════════════════════════════════════
  //
  // R1-R6. These need a real mount, a real chroot and a
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

  // THE DAEMON'S POLICY EVENT LOG, split into
  // `[kind, op, path, reason, pid, tgid, comm, cmdline]`. The KIND is the first
  // column and every filter below derives from it rather than from a
  // hand-maintained list of reason strings — `self-recursion` and
  // `pinned-children-truncated` are `served` rows, so a reason enumeration was
  // already wrong here. The `#` header the daemon writes when it opens the log
  // is dropped: it carries tabs, so it would split into a plausible-looking row.
  const eventsOf = async (instanceId) =>
    (await fs.readFile(path.join(fuseRunDir(instanceId), EVENT_LOG_NAME), 'utf8').catch(() => ''))
      .split('\n').filter(l => l !== '' && !l.startsWith('#')).map(l => l.split('\t'));

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
  //   a marked caller at a project path         → the SYSTEM's bytes, never the
  //                                               host's copy at the same
  //                                               spelling
  //   an unmarked caller where the HOST HAS one → the HOST's bytes, never the
  //                                               system's
  //   an unmarked caller where it has NONE      → -ENOENT, with the row
  //   a MARKED caller at that same path         → the system's bytes, which is
  //                                               the control saying the file
  //                                               exists and the denial is
  //                                               POLICY rather than absence
  //   either caller at a host pin               → the HOST's bytes, alike.
  //
  // THE UNMARKED HOST READ IS DELIBERATE. `before()` writes HOST-SIDE-COPY at
  // the project's own absolute spelling on purpose: a host collision is
  // DIVERGENCE, not a leak — pinned here as intended behaviour rather than left
  // implicit.
  test('R2 — a project path answers the system to a marked caller, and the host to an unmarked one wherever the host has an entry', async () => {
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
      // the answer cannot be attributed to anything else about the caller.
      // THE HOST HAS AN ENTRY HERE, so the unmarked caller gets the HOST's
      // bytes — and never the system's, which is the half that matters.
      const unmarked = await inNs(record.anchorPid, 'read l < "$1" || exit 7; echo "$l"', projFile);
      assert.equal(unmarked.ok, true,
        `an unmarked caller was denied where the host HAS an entry: ${unmarked.stdout} ${unmarked.stderr}`);
      assert.match(unmarked.stdout, /HOST-SIDE-COPY/, `${unmarked.stdout} ${unmarked.stderr}`);
      assert.doesNotMatch(unmarked.stdout, /SYSTEM-SIDE-PROJECT-FILE/,
        'an unmarked caller received REMOTE bytes — the one thing marking protects');

      // …AND WHERE THE HOST HAS NOTHING, THE ANSWER IS STILL -ENOENT.
      // `remote-only.txt` exists in the fake remote and nowhere on the host, so
      // this is the same tier, the same caller and the opposite answer — which
      // is what keeps the answer from being read as a property of this path.
      // THE MECHANISM UNDER IT: host-entry existence is not a discriminator
      // the daemon tests for. The path re-resolves in `VIEW_HOST`, is served
      // the host, and this -ENOENT is the ORCHESTRATOR'S OWN rather than a
      // policy denial — which is what the log assertion below says.
      const remoteOnly = inside(record, path.join(box, 'app', 'remote-only.txt'));
      const denied = await inNs(record.anchorPid, 'read l < "$1" || exit 7; echo "$l"', remoteOnly);
      assert.equal(denied.ok, false, `an unmarked caller was served at a host-absent path: ${denied.stdout}`);
      assert.doesNotMatch(denied.stdout, /SYSTEM-ONLY-FILE|HOST-SIDE-COPY/,
        'an unmarked caller got bytes at a path the host has nothing at');

      // THE CONTROL, so the denial above is POLICY and not absence: the same
      // path, MARKED, really does have the system's file behind it.
      const markedOnly = await inNs(record.anchorPid,
        '[ -e "$1" ]; read l < "$2" || exit 7; echo "$l"', mark, remoteOnly);
      assert.match(markedOnly.stdout, /SYSTEM-ONLY-FILE/,
        `the system has no file at the host-absent path, so the denial proves nothing: `
        + `${markedOnly.stdout} ${markedOnly.stderr}`);

      // …and a HOST PIN is served to that same unmarked caller.
      // A REAL host pin — ETC_PINS names /etc/hosts, and a path that merely
      // looks host-ish (/etc/hostname) is `fail` like anything unpinned, which
      // would make this arm pass for the wrong reason.
      const hostPin = inside(record, '/etc/hosts');
      const both = await inNs(record.anchorPid, 'read l < "$1" || exit 7; echo "$l"', hostPin);
      assert.equal(both.ok, true, `a host pin was denied to an unmarked caller: ${both.stderr}`);
      assert.equal(both.stdout.trim(), (await fs.readFile('/etc/hosts', 'utf8')).split('\n')[0].trim(),
        'the host pin did not answer with the orchestrator’s own file');

      // AND BOTH ANSWERS ARE IN THE LOG, BY NAME AND BY PATH — the substitution
      // is `served` (never `deny`, which would put an ordinary shell startup
      // into R4's fatal filter) and the denial keeps its own reason.
      const events = await eventsOf(inst.id);
      assert.ok(events.some(r => r[0] === 'served' && r[3] === 'unmarked-host-served'
        && r[2] === path.join(box, 'app', 'remote-marker.txt')),
        `no served/unmarked-host-served row for the host-shadowed project file — a `
        + `project-tier path re-resolves in VIEW_HOST and lands on the SAME reason `
        + `as any other fail -> host, rather than on one of its own: `
        + JSON.stringify(events));
      // AND THE HOST-ABSENT ONE IS NOT A POLICY DENIAL AT ALL. It re-resolves
      // in `VIEW_HOST`, is served the host, and the
      // ENOENT the caller sees is the ORCHESTRATOR'S OWN — not a refusal. The
      // read above already proved the bytes are not the remote's; what is
      // asserted here is that the daemon says which rule answered.
      assert.ok(events.some(r => r[0] === 'served' && r[3] === 'unmarked-host-served'
        && r[2] === path.join(box, 'app', 'remote-only.txt')),
        `no served/unmarked-host-served row for the host-absent project file: ${JSON.stringify(events)}`);
      assert.deepEqual(events.filter(r => r[3] === 'unmarked-project-denied'), [],
        `an unmarked caller reached policy_project_route — the project `
        + `tier is not in its view at all, so that denial is structurally unreachable: `
        + JSON.stringify(events));
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
  //
  // AND THE CALLER SPLIT AT ONE REAL PATH: the MARKED
  // CLI meets the synthetic scaffold at `/usr` — fixed attributes, EROFS on a
  // mutation — while an UNMARKED caller meets the orchestrator's own directory
  // at that same spelling. `pt_getattr` is out of the unit driver's reach, so a
  // real mount is the only instrument that can put the two side by side.
  test('R3 — the mount comes up fail-closed to the CLI, the three binds land on synthetic nodes, and the scaffold is the marked caller’s answer alone', async () => {
    const before = snapshot(runRoot);
    const inst = await spawnWorker();
    try {
      const record = await readRecord(inst.id);
      const nsMounts = mountsOf(record.daemonPid) ?? [];
      for (const b of ['/proc', '/sys', '/dev']) {
        assert.ok(nsMounts.includes(path.join(record.root, b)),
          `${b} was not bind-mounted onto its synthetic node: ${JSON.stringify(nsMounts.filter(m => m.startsWith(record.root)))}`);
      }
      // ── THE SCAFFOLD IS THE MARKED CALLER'S ANSWER ALONE ─────────────────
      //
      // STATED RATHER THAN MADE SILENTLY. Under criterion 4 clause (2) an
      // UNMARKED caller is served the orchestrator's own directory at this very
      // path — `/`, `/usr`, `/bin`, `/etc`, `/home`, `/root` are all of them —
      // so a `555 0 0 0` synthetic expectation made by an unmarked shell cannot
      // hold. The INVARIANT is asserted to the MARKED CLI instead, and the
      // unmarked answer is asserted BESIDE it rather than dropped.
      //
      // PINNED HERE AND NOWHERE ELSE: the caller split at ONE real path. The
      // unit driver cannot reach `pt_getattr`, so a real mount is the only place
      // the two answers to one `stat` can be put side by side.
      const marked = inside(record, inst._fuse.plan.markPath);
      const usr = inside(record, '/usr');
      // (a) THE MARKED CLI GETS THE SCAFFOLD: `policy_fixed_dir`'s own fixed
      // `0555 root:root` with mtime 0, not the host's real mode and real mtime.
      // `/usr` carries no pin of its own and is a strict ancestor of many `host`
      // pins (`ETC_PINS`, `LOADER_OBJECTS` and `BOOTSTRAP_CHAIN` all seed
      // `/usr/...`), so it is `T_SYNTH` to this caller.
      //
      // MARK-THEN-`exec`, the idiom R7 already runs and passes on: `[ -e ]` is a
      // shell BUILTIN, so the marking `getattr` is made by the shell's own
      // thread group; `policy_mark_tid` marks the TGID; and `exec` keeps both
      // the TGID and the start time `policy_is_marked_tid` validates against. A
      // FORKED `stat` would be a new thread group and would answer the unmarked
      // question instead — do not drop the `exec`.
      const st = await inNs(record.anchorPid,
        '[ -e "$1" ]; exec /usr/bin/stat -c "%a %u %g %Y" "$2"', marked, usr);
      assert.equal(st.ok, true, st.stderr);
      assert.equal(st.stdout.trim(), '555 0 0 0',
        `the synthetic /usr answered the host’s attributes to the MARKED CLI: ${st.stdout} ${st.stderr}`);
      // (b) AND AN UNMARKED CALLER AT THE SAME PATH GETS THE ORCHESTRATOR'S OWN
      // DIRECTORY, read with `fs.stat` from cc's own process and never a
      // literal. `/usr` is NOT on the CLI's cwd chain — the cwd is `<box>/app`
      // under `/tmp` — so `policy_cwd_component` is false, no traversal floor
      // applies, and the host's raw mode is the whole answer.
      const hostUsr = await fs.stat('/usr');
      const un = await inNs(record.anchorPid, 'exec /usr/bin/stat -c "%a %u %g %Y" "$1"', usr);
      assert.equal(un.ok, true, un.stderr);
      const [uMode, uUid, uGid, uMtime] = un.stdout.trim().split(' ');
      assert.equal(`${uMode} ${uUid} ${uGid}`,
        `${(hostUsr.mode & 0o7777).toString(8)} ${hostUsr.uid} ${hostUsr.gid}`,
        `an unmarked caller did not get the orchestrator's own /usr: ${un.stdout} ${un.stderr}`);
      // `%Y` IS WHAT CARRIES THE SPLIT, AND IT HAS TO BE ASSERTED. Host `/usr` is
      // `root:root` exactly like the fixed node, so uid/gid discriminate nothing
      // here, and a host whose `/usr` happened to be `0555` would make the mode
      // comparison vacuous too. A fixed node always reports mtime 0.
      //
      // AGAINST THE HOST'S OWN mtime, NOT MERELY AGAINST NON-ZERO. A node
      // RECONSTRUCTED from the host stat but carrying a stale or invented
      // `st_mtime` would satisfy both a non-zero check and the mode/uid/gid
      // compare above, which is the one answer this assertion exists to pin.
      // Deterministic here: nothing in the run writes `/usr`.
      assert.equal(uMtime, String(Math.floor(hostUsr.mtimeMs / 1000)),
        `the unmarked /usr did not report the ORCHESTRATOR's own mtime — '0' is the `
        + `fixed node's, and any other value is a node reconstructed from it: ${un.stdout}`);
      // (c) AND THE SCAFFOLD IS READ-ONLY TO THE CLI, with EROFS rather than
      // EACCES — `policy_mutation_check` is the one place that choice is made,
      // and there is nothing behind the node to chmod.
      //
      // MARKED, AND THAT IS NOT COSMETIC. Unmarked, `/usr` is host-served, so an
      // unmarked `rmdir` here would run against the ORCHESTRATOR'S OWN `/usr` —
      // the exact shape of the `/usr/nope` incident recorded just below.
      //
      // AS ROOT, because at uid 1000 `default_permissions` answers EACCES from
      // the kernel against the node's own `0555 root:root` before the daemon is
      // consulted, and the arm under test is never reached.
      //
      // `exec`, AND NO `|| true`: `exec` replaces the shell, so the `||` branch
      // could never run — the assertion is on `.stdout`, as R7's is.
      //
      // `|| exit 9`, NOT `;`, AND THE DIFFERENCE IS BLAST RADIUS. Under `;` a
      // FAILED mark read does not stop the shell: it would exec `rmdir` UNMARKED
      // AND AS ROOT, and unmarked this path is host-served — so the op would run
      // against the ORCHESTRATOR'S OWN `/usr`. It is bounded (`ENOTEMPTY`) and
      // the arm reds either way, but it would red saying "a synthetic node
      // accepted a mutation" over an errno that came from cc's own filesystem.
      // Hard-failing the precondition leaves the match below to red on an empty
      // stdout instead, which is the honest attribution. R9 owns this idiom.
      const wr = await inNsRoot(record.anchorPid,
        '[ -e "$1" ] || exit 9; exec rmdir "$2" 2>&1', marked, usr);
      assert.match(wr.stdout, /[Rr]ead-only file system/, `a synthetic node accepted a mutation: ${wr.stdout}`);
      // A CHILD of a synthetic dir is a different answer, and worth pinning
      // beside it: unpinned, so fail-closed -ENOENT rather than EROFS. The two
      // together say the synthetic tree is a scaffold and not a writable one.
      //
      // MARKED. `fail`-closed is the MARKED CLI's answer alone, so this is the
      // caller that has to make the assertion: an unmarked root shell running
      // `mkdir` here would be a real `mkdir /usr/nope` ON THE ORCHESTRATOR'S
      // HOST — measured, and the directory was there afterwards. R13 pins the
      // unmarked side, where being served the host is the decision rather than
      // a leak.
      //
      // IT HAS TO BE A SHELL REDIRECTION for the same reason the project-write
      // control below does: `mkdir` is an external binary and therefore its own
      // unmarked thread group, so a marked shell cannot lend it the mark. `> `
      // is performed by the shell itself.
      const child = await inNsRoot(record.anchorPid,
        '[ -e "$1" ]; { echo x > "$2"; } 2>&1 || true',
        inside(record, inst._fuse.plan.markPath), inside(record, '/usr/nope'));
      // BOTH WORDINGS, because the probe is a shell REDIRECTION rather than
      // `mkdir` (see above) and dash spells ENOENT on an `open(O_CREAT)` as
      // `Directory nonexistent` while coreutils spells it `No such file or
      // directory`. The ERRNO is the same; the host check below is the oracle
      // that does not depend on either spelling.
      assert.match(child.stdout, /No such file or directory|Directory nonexistent/,
        `an unpinned path under a synthetic dir was created: ${child.stdout}`);
      // AND NOTHING LANDED ON THE ORCHESTRATOR, checked directly rather than
      // inferred from the shell's message: a create that reached the host root
      // would have made `/usr/nope` for real.
      await assert.rejects(() => fs.access('/usr/nope'),
        'the create reached the ORCHESTRATOR\'s own /usr — the marked CLI was served the host at `fail`');
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
  // PINS: after a full turn the event log DENIES nothing the CLI NEEDED.
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
  // spelling inside it THROUGH THE UNION, and it goes with the session. A18
  // pins the geometry deterministically; this pins that the daemon actually
  // answers -ENOENT for it, which is the half a plan file cannot establish.
  //
  // "THROUGH THE UNION" IS EXACTLY WHAT THE PROBE BELOW MEASURES and exactly
  // what the claim may say: every path it tries is `inside(record, …)`, i.e.
  // re-rooted and asked of the mount. It is NOT a reachability claim about the
  // chroot as a whole — the worker runs as cc's own uid and the architecture
  // bind-mounts the orchestrator's real /proc, so
  // `/proc/<ccpid>/root/<rundir>/mirror` is another spelling of the same
  // directory and it resolves (measured).
  test('R5 — the run directory is unreachable through the union from inside the chroot, and dies with the session', async () => {
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
        assert.match(probe.stdout, /ABSENT/, `${hidden} is reachable THROUGH THE UNION from inside the chroot`);
      }
      // NON-VACUITY: the mirror really was populated on the outside, so ABSENT
      // above is the tier answering rather than an empty tree.
      //
      // A MARKED READ IS WHAT MATERIALISES IT, and it has to be made here. The
      // bootstrap's `cd` into the project resolves UNMARKED (`bootstrap.sh`
      // fires no marking event), so it is answered in `VIEW_HOST` and sends no
      // control frame — nothing reaches the mirror on a spawn whose CLI makes
      // no project read, and this gate's CLI is the fake one.
      const marked = await inNs(record.anchorPid,
        '[ -e "$1" ]; read l < "$2" || exit 7; echo "$l"',
        inside(record, inst._fuse.plan.markPath),
        inside(record, path.join(box, 'app', 'remote-marker.txt')));
      assert.match(marked.stdout, /SYSTEM-SIDE-PROJECT-FILE/,
        `the marked read that populates the mirror failed: ${marked.stdout} ${marked.stderr}`);
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
  // A SPAWN-TIME CHDIR FROM AN UNMARKED THREAD GROUP resolves the project
  // ROOT, and inside it only what the HOST has an entry at.
  //
  // `before()` seeds a host tree at the project's own absolute spelling on
  // purpose — it is how R2 proves "never a host fallback" for a MARKED caller —
  // so every `-ENOENT` assertion here sits on `remote-only*`, which exists on
  // the system and nowhere on the host, and each is an explicit pin of the
  // substitution. Both directions are asserted in every sub-arm, which is what
  // keeps them non-vacuous.
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
    'const [root,sub,file,rsub,rfile]=process.argv.slice(1);',
    'const run=(bin,args,cwd)=>{const r=spawnSync(bin,args,{cwd,encoding:"utf8"});',
    'return {status:r.status,err:r.error?r.error.code:null,',
    'out:(r.stdout||"").trim(),se:(r.stderr||"").trim()};};',
    // ITS OWN comm, so (f) below compares the daemon's attribution against
    // something the probe REPORTS rather than against a literal that would go
    // stale the day node renames its main thread. `spawnSync` forks from this
    // thread, and the child keeps this comm until it execs — which is why the
    // (b) denial, taken during the pre-exec chdir, must carry it.
    'const comm=require("fs").readFileSync("/proc/self/comm","utf8").trim();',
    'console.log(JSON.stringify({comm,',
    'a:run("/bin/sh",["-c","pwd -P"],root),',
    'b:run("/bin/sh",["-c","pwd -P"],rsub),',
    'bh:run("/bin/sh",["-c","pwd -P"],sub),',
    'c:run("/bin/cat",[rfile],"/"),',
    'ch:run("/bin/cat",[file],"/"),',
    'd:run("/usr/bin/stat",["-c","%a %u %g",root],"/"),',
    'e:run("/bin/ls",[root],"/")}));',
  ].join('');

  test('R8 — an unmarked spawn resolves the project root, and inside it only what the host has', async () => {
    const before = snapshot(runRoot);
    const proj = path.join(box, 'app');
    const SUB = 'cwd-sub';
    // THE HOST-ABSENT PAIR, seeded in `before()`: a project-tier directory and
    // a project-tier file the host has nothing at. These are the ONLY paths a
    // `-ENOENT` sub-arm can be stated at — at the project's own spelling the
    // host tree answers.
    const RSUB = 'remote-only-sub';
    const RFILE = 'remote-only.txt';
    // IN THE FAKE REMOTE, so it genuinely exists on "the system": a refusal at
    // a path the source does not have would prove absence, not policy.
    await fs.mkdir(path.join(fakeRemote, proj, SUB), { recursive: true });
    // AND ON THE HOST. `<proj>/cwd-sub` now exists on BOTH sides, which is what
    // makes (b)'s host half a real measurement of the substitution rather than
    // an incidental absence: correct = the chdir succeeds off the HOST's
    // directory, and the denial half moves onto `remote-only-sub`.
    await fs.mkdir(path.join(box, 'app', SUB), { recursive: true });
    // (e) reads the daemon's OWN output, through the PRODUCT'S OWN TRACE
    // SWITCH. `resolveTraceEnabled()` keys exactly on '1' and is read by
    // `buildFusePlan` IN THIS PROCESS at spawn time
    // (`InstanceManager._doCreateResolved`), so
    // the switch is set before `spawnWorker()` and restored in the `finally`.
    const prevTrace = process.env.CC_FUSE_TRACE;
    process.env.CC_FUSE_TRACE = '1';
    let inst;
    try {
      inst = await spawnWorker();
      const record = await readRecord(inst.id);
      const out = await inNs(record.anchorPid, 'exec "$1" -e "$2" "$3" "$4" "$5" "$6" "$7"',
        process.execPath, R8_PROBE,
        inside(record, proj), inside(record, path.join(proj, SUB)),
        inside(record, path.join(proj, 'remote-marker.txt')),
        inside(record, path.join(proj, RSUB)), inside(record, path.join(proj, RFILE)));
      assert.ok(out.stdout.trim().startsWith('{'),
        `the probe did not run: ${out.stdout} ${out.stderr}`);
      const res = JSON.parse(out.stdout.trim());

      // (a) THE ROOT RESOLVES. Without the exemption the chdir happens in the
      // forked child, which is a brand-new and therefore unmarked thread group,
      // and the process dies before its own image runs.
      assert.equal(res.a.err, null, `the spawn at the project root failed: ${JSON.stringify(res.a)}`);
      assert.equal(res.a.status, 0, `the spawn at the project root failed: ${JSON.stringify(res.a)}`);
      assert.equal(res.a.out, inside(record, proj), JSON.stringify(res.a));

      // (b) A PROJECT-TIER DIRECTORY THAT IS NOT ON THE CWD CHAIN AND THAT THE
      // HOST HAS NOTHING AT STAYS DENIED. The exemption widened to the cwd's own
      // directory COMPONENTS, and `<proj>/remote-only-sub` is a CHILD of the
      // cwd rather than an ancestor of it — so the admission does not reach it,
      // and the host has no entry to substitute either.
      assert.equal(res.b.err, 'ENOENT', `a spawn inside the project tree survived: ${JSON.stringify(res.b)}`);
      // …AND THE HOST HALF, WHICH IS THE SAME MECHANISM FROM THE OTHER SIDE:
      // `<proj>/cwd-sub` exists on the host, so the chdir SUCCEEDS and it is the
      // host's directory that answered. Both halves in one arm is what keeps the
      // answer from being read as a property of one path. Both halves are the
      // same rule — the path is served the host either way,
      // and what differs is only whether the orchestrator has anything there.
      assert.equal(res.bh.err, null,
        `the chdir failed where the host HAS the directory: ${JSON.stringify(res.bh)}`);
      assert.equal(res.bh.status, 0, JSON.stringify(res.bh));
      assert.equal(res.bh.out, inside(record, path.join(proj, SUB)), JSON.stringify(res.bh));

      // (c) A FILE IN THE PROJECT TREE THE HOST HAS NOTHING AT STAYS DENIED —
      // and this is also the arm's NON-VACUITY CONTROL: it can only fail this
      // way for an unmarked caller, so it proves the probe's thread group really
      // is unmarked. R2 owns the marked/unmarked pair for a file; this is the
      // same denial reached from the probe that (a) and (b) run in.
      assert.notEqual(res.c.status, 0, `an unmarked caller read a project file: ${JSON.stringify(res.c)}`);
      assert.match(res.c.se, /No such file or directory/, JSON.stringify(res.c));
      // …and where the host HAS the file, the same read returns the HOST's copy
      // and never the system's.
      assert.equal(res.ch.status, 0, `the read failed where the host HAS the file: ${JSON.stringify(res.ch)}`);
      assert.match(res.ch.out, /HOST-SIDE-COPY/, JSON.stringify(res.ch));
      assert.doesNotMatch(res.ch.out, /SYSTEM-SIDE-PROJECT-FILE/,
        'an unmarked caller received REMOTE bytes');

      // (d) THE PROJECT ROOT IS THE HOST'S DIRECTORY HERE, NOT THE OVERLAY NODE.
      // `before()` seeds a real host tree at the project's own spelling, so the
      // orchestrator HAS the path and its own directory is what answers — read
      // with `fs.stat` from cc's own process, never a literal, with the floor's
      // `0111` OR'd in because the project root is the cwd. THE DIVERGENCE,
      // PINNED AS INTENDED rather than left implicit. The overlay node at the
      // real mount is reachable only where the host has nothing on the cwd
      // chain, which is R14's arm and R14's alone.
      const hostProj = await fs.stat(path.join(box, 'app'));
      assert.equal(res.d.out,
        `${((hostProj.mode & 0o7777) | 0o111).toString(8)} ${hostProj.uid} ${hostProj.gid}`,
        `the project root did not report the HOST directory's own attributes with the floor `
        + `applied: ${JSON.stringify(res.d)}`);
      assert.equal(res.e.status, 0, `an unmarked caller could not list the host directory: ${JSON.stringify(res.e)}`);
      assert.ok(res.e.out.split('\n').includes('remote-marker.txt'),
        `the listing is not the HOST directory's children: ${JSON.stringify(res.e)}`);

      // (e) THE DAEMON SAID SO ITSELF, rather than the decision being read off
      // a shell's exit code: the routed tier is in the trace, and the root is
      // NOT in the event log while the two paths under it are.
      // THE PLAN'S OWN PATH, not one this arm chose: `buildFusePlan` puts the
      // trace at `<rundir>/trace.log` (`plan.tracePath`) and `wrapLaunch` hands
      // exactly that to the worker as `CC_FUSE_TRACE_LOG`. Read
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
      // `resolveTraceEnabled()` → `plan.tracePath` = `<rundir>/trace.log`
      // (both in `src/systems/fuse/plan.ts`) → `wrapLaunch` emitting
      // `CC_FUSE_TRACE_LOG` (`src/systems/fuse/wrap.ts`) → bootstrap.sh
      // exporting `CC_UNION_TRACE` from it (its `CC_UNION_TRACE` assignment).
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
      // THE ROUTED TIER, FROM THE DAEMON'S OWN MOUTH. `host` and not `synth`:
      // the orchestrator HAS `<box>/app`, so its own directory answers and only
      // the floor touches the mode. The overlay node is the answer where it has
      // nothing — R14 is where that is reachable.
      assert.ok(rows.some(l => new RegExp(`^getattr\t${esc(proj)}\ttier=host .*\\bmark=0\\b`).test(l)),
        `THE DAEMON RAN AND EMITTED NO unmarked tier=host ROW for ${proj} — the host-existence `
        + `substitution did not fire, or route() assigned another tier (${rows.length} rows traced): `
        + rows.filter(l => l.includes(proj)).slice(-8).join(' | '));
      const events = await eventsOf(inst.id);
      // NO PROJECT-TIER DENIAL ANYWHERE: an unmarked caller
      // resolves in `VIEW_HOST`, where the `project` pins are struck, so
      // `policy_project_route` is unreachable and its reason is never written.
      // The two remote-only paths under the root are served the HOST instead and
      // get the orchestrator's own ENOENT, which the read assertions above
      // already proved is not the remote's content.
      assert.deepEqual(events.filter(r => r[3] === 'unmarked-project-denied'), [],
        `an unmarked caller reached policy_project_route: ${JSON.stringify(events)}`);
      for (const served of [path.join(proj, RSUB), path.join(proj, RFILE)]) {
        assert.ok(events.some(r => r[0] === 'served' && r[2] === served && r[3] === 'unmarked-host-served'),
          `no served/unmarked-host-served for ${served}: ${JSON.stringify(events)}`);
      }
      // (f) AND THE ROW SAYS WHO ASKED. This is the ONLY arm
      // anywhere with a real /proc behind the identity columns: every other
      // layer injects the reader, so "the enrichment compiles" and "the
      // enrichment attributes a real process" are different claims and this is
      // the second one. The probe runs `node` inside the worker's namespace, so
      // its thread group is NOT the bootstrap's — what is asserted is that the
      // row names a LIVE, READABLE process, not a sentinel.
      // ATTRIBUTED ON THE SERVED ROWS: there is no unmarked project denial to
      // attribute. The claim is the same — a row names a LIVE, READABLE process
      // rather than a sentinel — and the rows it reads come from the same probe
      // in the same namespace.
      const denials = events.filter(r => r[3] === 'unmarked-host-served'
        && r[2].startsWith(`${proj}/`));
      assert.ok(denials.length > 0, `no project-path row to attribute: ${JSON.stringify(events)}`);
      for (const r of denials) {
        assert.equal(r.length, 8, `the row is not eight columns: ${JSON.stringify(r)}`);
        assert.match(r[4], /^\d+$/, `pid is not a number: ${JSON.stringify(r)}`);
        assert.match(r[5], /^\d+$/, `tgid is not a number: ${JSON.stringify(r)}`);
        assert.ok(!r[6].startsWith('\\!'),
          `the daemon could not read the caller's comm off a live /proc — the identity `
          + `columns are structurally present and empty, which is the failure mode this arm `
          + `exists to catch: ${JSON.stringify(r)}`);
        assert.ok(!r[7].startsWith('\\!'), `nor its cmdline: ${JSON.stringify(r)}`);
      }
      // …AND IT IS THE RIGHT PROCESS, not merely a readable one. The two
      // denials have DIFFERENT causes and therefore different callers, and this
      // is what a wrong attribution — everything credited to the daemon, to the
      // last caller, or to the parent — cannot survive:
      //   (b) `<proj>/remote-only-sub`   the chdir in the FORKED CHILD, before
      //                                  exec, so it still carries the probe's
      //                                  own comm
      //   (c) `<proj>/remote-only.txt`   read by `/bin/cat` AFTER exec
      const commAt = (p) => (denials.find(r => r[2] === p) ?? [])[6];
      assert.equal(commAt(path.join(proj, RSUB)), res.comm,
        `the pre-exec chdir denial is not attributed to the probe's own thread group `
        + `(expected comm ${JSON.stringify(res.comm)}): ${JSON.stringify(denials)}`);
      assert.equal(commAt(path.join(proj, RFILE)), 'cat',
        `the file read is not attributed to cat: ${JSON.stringify(denials)}`);
      // NON-VACUITY: the two really are different processes, so an attribution
      // that collapsed every row onto one caller could not pass both.
      assert.notEqual(res.comm, 'cat', 'the probe and its child share a comm, so (f) proves nothing');

      // AND THE TRACE CAN BE JOINED TO IT ON THE TGID, which is what makes the
      // two instruments one picture rather than two.
      const tgids = new Set(denials.map(r => r[5]));
      assert.ok(rows.some(l => [...tgids].some(t => new RegExp(`\\btgid=${t}\\b`).test(l))),
        `no traced op shares a thread group with any event row (${[...tgids].join(',')})`);
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

  // ── R15 ────────────────────────────────────────────────────────────────────
  //
  // THE WIDENING AT THE DEFAULT NARROW ROOT, WHICH IS THE ONE THING THE UNIT
  // FIXTURE CANNOT REACH. `b38`–`b48` prove the RESOLUTION; this proves that a
  // real `ls` and a real `mkdir` through a real mount see the consequence.
  //
  // THE SITE IS A HOST DIRECTORY THAT IS AN ANCESTOR OF A PIN. The ancestor
  // table is not consulted in `VIEW_HOST`, so the path falls to `fail` and
  // `fail` means host: the orchestrator's own directory, its own names, its own
  // write surface — not a synthetic `0555` root:root node listing only the pin
  // names below it and answering `EROFS` on every mutation.
  //
  // BOTH HALVES, because either alone is weak. A listing that gained a name
  // could still be a read-only node; a `mkdir` that succeeded could still be
  // hiding names. And the box is one the RUNNER OWNS, so the uid can genuinely
  // write — asserting `mkdir` against a directory nobody may write to would pass
  // for the wrong reason.
  //
  // AND THE TRAVERSAL FLOOR AND ITS SCOPE AT THIS ROOT.
  // `<box>` is on the CLI's cwd chain, so the mode it reports is the host's with
  // `0111` OR'd in; a sibling directory that is NOT on the chain reports its
  // real mode. Both are asserted, because the first alone would pass under an
  // unscoped floor.
  test('R15 — at the default root an unmarked caller gets the orchestrator\'s own directory, names and write surface, and the cwd-chain floor is scoped', async () => {
    const before = snapshot(runRoot);
    // AN ANCESTOR OF A PIN, AND ASSERTED TO BE ONE. `<box>/app` is the project,
    // so `<box>` is a strict ancestor of a `project` pin and carries no pin of
    // its own — exactly the class a synthetic node would cover.
    const anchorDir = box;
    const loose = `cc-r15-unpinned-${process.pid}.txt`;
    await fs.writeFile(path.join(anchorDir, loose), 'ORCHESTRATOR-SIDE\n');
    // THE FLOOR'S SCOPE CONTROL, declared out here so the `finally` can remove
    // it. ITS OWN LEAF NAME rather than R14's `off-chain`, AND THE DIRECTION OF
    // THE COUPLING IS THIS ONE: `box` is shared by every arm in the file, node
    // runs them in declaration order, and THIS ARM RUNS FIRST — so it is R15's
    // copy surviving into R14 that would matter, never R14's reaching back. The
    // `process.pid` suffix and the `finally` removal below are what stop it.
    const offChain = path.join(anchorDir, `cc-r15-off-chain-${process.pid}`);
    let inst;
    try {
      inst = await spawnWorker();
      const record = await readRecord(inst.id);
      const unmarked = (script, ...args) => inNs(record.anchorPid, script, ...args);
      const at = inside(record, anchorDir);

      // THE PIN SET SAYS SO, not this arm: no entry names `<box>`, and one names
      // a path beneath it. Without this the arm could be passing at a host pin.
      const pins = await fs.readFile(path.join(fuseRunDir(inst.id), 'pins.txt'), 'utf8');
      const pinned = pins.split('\n').filter(l => l && !l.startsWith('#'))
        .map(l => l.split('\t')[1]);
      assert.ok(!pinned.includes(anchorDir),
        `<box> carries a pin of its own, so this arm is not testing an ancestor: ${anchorDir}`);
      assert.ok(pinned.some(x => x.startsWith(`${anchorDir}/`)),
        `nothing is pinned beneath <box>, so it is not an ancestor of a pin either: ${pinned}`);

      // (a) THE MODE AND OWNER ARE THE ORCHESTRATOR'S OWN, read with `fs.stat`
      // from cc's own process and never a literal. `0555 0 0` is the synthetic
      // node's signature, and the uid/gid halves are what kill it.
      //
      // WITH THE TRAVERSAL FLOOR'S `0111` OR'd IN, AND SAID OUT LOUD RATHER
      // THAN RELAXED QUIETLY. `<box>` is a component of the CLI's cwd
      // (`<box>/app`), so `policy_cwd_component` holds, `policy_floor_applies`
      // is true in `VIEW_HOST`, and `policy_floor_traversal` ORs `0111` onto
      // the reported mode — criterion 4 clause (3)'s "a traversal floor so
      // every directory it is handed can be entered", verbatim. What keeps this
      // honest is the scope control immediately below, not this equality: a
      // floor-BLIND expectation at this same path would contradict R14's
      // floor-AWARE one.
      const hostDir = await fs.stat(anchorDir);
      // AND THE ON-CHAIN FIXTURE IS `0700`-SHAPED, asserted for the same reason
      // the off-chain one below is. `mkdtemp` gives `<box>` `0700` today, but it
      // is shared by every arm in this file: an arm that chmodded it
      // world-traversable would turn this equality into a floor-BLIND one that
      // still passes, which is exactly the quiet relaxation this arm rules out.
      assert.equal((hostDir.mode & 0o111), 0o100, 'the on-chain fixture is not 0700-shaped');
      const st = await unmarked('exec /usr/bin/stat -c "%a %u %g" "$1"', at);
      assert.equal(st.stdout.trim(),
        `${((hostDir.mode & 0o7777) | 0o111).toString(8)} ${hostDir.uid} ${hostDir.gid}`,
        `an ancestor-of-a-pin ON-CHAIN directory did not report the orchestrator's own `
        + `attributes with the floor applied — '555 0 0' alone would be the synthetic node `
        + `removed: ${st.stdout} ${st.stderr}`);

      // AND THE FLOOR IS SCOPED TO THE CHAIN, AT THE DEFAULT NARROW ROOT. A host
      // directory that is NOT a cwd component keeps its real mode, unfloored.
      // Without this the equality above would pass just as well under an
      // UNSCOPED floor — which would grant traversal the host itself denies, and
      // would make the floor-aware rewrite the quiet relaxation it must not be.
      //
      // R14 CARRIES THE SAME CONTROL AND IT IS NOT A DUPLICATE: R14's is at a
      // WIDE mirror root, and this one is at the DEFAULT root, which is the
      // geometry every worker runs today and where the floor's scope had no
      // real-mount pin at all.
      //
      // AN EXPLICIT `chmod` BESIDE THE `mode:`, because the runner's umask is
      // not this arm's to assume — and the `0700` shape is ASSERTED, so a
      // fixture that came out world-traversable cannot make the check vacuous.
      await fs.mkdir(offChain, { recursive: true, mode: 0o700 });
      await fs.chmod(offChain, 0o700);
      const hostOff = await fs.stat(offChain);
      assert.equal((hostOff.mode & 0o111), 0o100, 'the off-chain fixture is not 0700-shaped');
      const offStat = await unmarked('exec /usr/bin/stat -c "%a %u %g" "$1"', inside(record, offChain));
      assert.equal(offStat.stdout.trim(),
        `${(hostOff.mode & 0o7777).toString(8)} ${hostOff.uid} ${hostOff.gid}`,
        `an OFF-CHAIN host directory was floored, so the floor is unscoped: `
        + `${offStat.stdout} ${offStat.stderr}`);

      // (b) THE LISTING IS THE ORCHESTRATOR'S OWN, INCLUDING AN UNPINNED NAME.
      // The unpinned file is the `ls`/`cat` half: a dirent predicate that is
      // not caller-aware makes it invisible to `ls` while `cat` on it works.
      const ls = await unmarked('exec /bin/ls -a "$1"', at);
      assert.equal(ls.ok, true, `an unmarked caller could not list it: ${ls.stderr}`);
      const names = ls.stdout.split('\n').map(x => x.trim()).filter(Boolean);
      assert.ok(names.includes(loose),
        `the UNPINNED file is missing from the listing — the ls/cat `
        + `disagreement: ${JSON.stringify(names)}`);
      assert.ok(names.includes('app'),
        `the project directory is missing from the listing: ${JSON.stringify(names)}`);
      // AND `cat` AGREES WITH `ls`: a name a caller can open is a name it must
      // see.
      const cat = await unmarked('exec /bin/cat "$1"', inside(record, path.join(anchorDir, loose)));
      assert.match(cat.stdout, /ORCHESTRATOR-SIDE/,
        `the unpinned file is listed but not readable: ${cat.stdout} ${cat.stderr}`);

      // (c) AND THE WRITE SURFACE IS REAL. `mkdir` then `rmdir` inside it both
      // SUCCEED, where a synthetic node answered EROFS on every mutation.
      const made = `cc-r15-mkdir-${process.pid}`;
      const mk = await unmarked('exec /bin/mkdir "$1"', inside(record, path.join(anchorDir, made)));
      assert.equal(mk.ok, true,
        `mkdir inside an ancestor-of-a-pin directory failed — EROFS here would be the `
        + `synthetic node answering: ${mk.stdout} ${mk.stderr}`);
      // SEEN FROM cc's OWN PROCESS, not from the shell's exit code: only the
      // former says the directory really landed on the orchestrator's disk.
      assert.ok((await fs.stat(path.join(anchorDir, made))).isDirectory(),
        'mkdir reported success without creating the directory on the orchestrator');
      const rm = await unmarked('exec /bin/rmdir "$1"', inside(record, path.join(anchorDir, made)));
      assert.equal(rm.ok, true, `rmdir failed: ${rm.stdout} ${rm.stderr}`);
      assert.equal(await fs.stat(path.join(anchorDir, made)).then(() => true, () => false), false,
        'rmdir reported success without removing the directory');
    } finally {
      if (inst) await instances.remove(inst.id);
      await fs.rm(path.join(anchorDir, loose), { force: true });
      await fs.rm(offChain, { recursive: true, force: true });
    }
    assertNoResidue(before, runRoot, null, 'R15');
  });

  test('R9 — the spawn dies of the cwd AND of the mark, and of neither alone', async () => {
    const before = snapshot(runRoot);
    const proj = path.join(box, 'app');
    // ITS OWN SUBDIRECTORY NAME, CREATED IN THE FAKE REMOTE ONLY. R8 runs
    // earlier in this file and leaves a HOST copy of `cwd-sub` behind, and an
    // unmarked caller is served the host wherever the host has an entry — so
    // half one would chdir successfully and the arm would measure nothing. The
    // host-absence is asserted, not assumed.
    const SUB = 'cwd-sub-r9';
    await fs.mkdir(path.join(fakeRemote, proj, SUB), { recursive: true });
    assert.equal(await fs.stat(path.join(proj, SUB)).then(() => true, () => false), false,
      `the host has an entry at <proj>/${SUB}, so half one is answered by the host tree`);
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

  // ── R12 ──────────────────────────────────────────────────────────────────
  // THE PRE-MARK WINDOW IS THE WHOLE BOOTSTRAP CHAIN, AND IT IS HOST-AND-
  // SYNTHETIC ONLY.
  //
  // WHAT IT PINS, in three parts:
  //
  //   1. THE MARKING EVENT IS THE CLI'S OWN. The first traced op carrying
  //      `mark=1` for the CLI's thread group names `plan.markPath` — nothing in
  //      `bootstrap.sh`, in `setpriv` or in the backend launcher pre-fires it.
  //   2. THE WINDOW SPANS THE WHOLE CHAIN. It contains the chroot'd shell's own
  //      interpreter AND the `setpriv` binary — the two links a mark statement
  //      in the bootstrap would put into `VIEW_CLI`.
  //   3. AND IT IS STILL CLEAN. No op in it resolves `project`, `fail` or
  //      `hide`, so no path answers one way to the pre-mark ops and another to
  //      the post-mark ones from one caller. That is a property of the VIEW
  //      rather than of the window's size: an unmarked caller resolves in
  //      `VIEW_HOST`, where `route()`'s `T_HIDE` arm answers -ENOENT before
  //      `tr()` and the remaining tiers can only be `host` or `synth`.
  //
  // THE `cd` IS IN THE WINDOW, and that is the fact `bootstrap.sh` firing no
  // marking event rests on: the project cwd is resolved by the bootstrap shell
  // UNMARKED and the launch lives. `b-cwd-unmarked` (tests/fuse-union-policy.test.mjs)
  // drives the policy; this is the same fact at a real mount.
  //
  // `2c` (tests/fuse-lifecycle.test.mjs, ungated) pins the script text; this
  // pins the CONSEQUENCE at the mount.
  //
  // THE TRACE COMES FROM THE PRODUCT'S OWN SWITCH, `CC_FUSE_TRACE=1`, read by
  // `resolveTraceEnabled()` in THIS process at spawn time — never a raw
  // `CC_UNION_TRACE`, which bootstrap.sh deliberately unsets on an untraced
  // spawn.
  test('R12 — the marking event is the CLI’s own, and the whole bootstrap chain precedes it', async () => {
    const before = snapshot(runRoot);
    const prevTrace = process.env.CC_FUSE_TRACE;
    process.env.CC_FUSE_TRACE = '1';
    let inst;
    try {
      inst = await spawnWorker();
      const record = await readRecord(inst.id);
      const trace = await fs.readFile(path.join(fuseRunDir(inst.id), 'trace.log'), 'utf8').catch(() => '');
      const rows = trace.split('\n').filter(Boolean);
      assert.ok(rows.length > 0,
        'THE TRACE INSTRUMENT DID NOT RUN — see R8 for the four links in the product\'s trace '
        + 'chain and why a failed fopen is not a cause (the daemon refuses to mount instead)');

      // THE CLI'S OWN THREAD GROUP, from the record rather than from a guess:
      // `bootstrapPid` is the pid every link execs into, so it IS the CLI's.
      const mine = rows.filter(l => new RegExp(`\\btgid=${record.bootstrapPid}\\b`).test(l));
      assert.ok(mine.length > 0,
        `no traced op is attributed to the CLI's thread group ${record.bootstrapPid} — `
        + `the record names a pid the trace never saw (${rows.length} rows)`);

      const firstMarked = mine.findIndex(l => /\bmark=1\b/.test(l));
      assert.ok(firstMarked > 0,
        `the marking event never fired for tgid ${record.bootstrapPid}, or fired on its very `
        + `first op — both make the pre-mark window unmeasurable: ${mine.slice(0, 4).join(' | ')}`);
      const pre = mine.slice(0, firstMarked);
      const post = mine.slice(firstMarked);
      const pathOf = (l) => l.split('\t')[1];

      // (1) THE MARKING EVENT IS THE CLI'S OWN READ OF ITS BINARY. Nothing
      //     earlier in the chain resolved the mark path — which is exactly what
      //     `bootstrap.sh`'s deleted `[ -e "$5" ]` did.
      assert.equal(pathOf(mine[firstMarked]), inst._fuse.plan.markPath,
        `the FIRST marked op names ${pathOf(mine[firstMarked])}, not the CLI launcher `
        + `${inst._fuse.plan.markPath} — something ahead of the CLI resolved the mark path and `
        + 'carried the mark into its own lookups');

      // NON-VACUITY, BOTH SIDES. A window of zero would satisfy the tier
      // assertion below trivially, and no post-mark ops would mean the split
      // found the wrong pid.
      assert.ok(pre.length > 0,
        'the pre-mark window is empty, so the tier assertion below is vacuous');
      assert.ok(post.length > 0, 'no post-mark ops — the split is not a split');

      // (2) THE WINDOW CONTAINS THE WHOLE BOOTSTRAP CHAIN. A shell interpreter
      //     AND the setpriv binary — the two links a mark fired ahead of the CLI
      //     puts in `VIEW_CLI`, where a wide `mirrorRoot` gives every unpinned
      //     path they touch to the remote tier with no host fallback.
      const prePaths = new Set(pre.map(pathOf));
      const anyOf = (...cands) => cands.find(c => prePaths.has(c));
      assert.ok(anyOf('/bin/sh', '/usr/bin/sh', '/bin/dash', '/usr/bin/dash'),
        `no shell interpreter in the pre-mark window, so the chroot'd shell is not in it: `
        + JSON.stringify([...prePaths].sort()));
      assert.ok(anyOf('/usr/bin/setpriv', '/bin/setpriv'),
        `SETPRIV IS NOT IN THE PRE-MARK WINDOW. It execs before the CLI, so it can only be `
        + `missing here if something ahead of it fired the mark: ${JSON.stringify([...prePaths].sort())}`);

      // (3) AND THE `cd` IS IN IT: the bootstrap shell resolved the project cwd
      //     UNMARKED and the launch lived. This is the fact removing the
      //     pre-fire rests on, at the mount.
      assert.ok(prePaths.has(inst.cwd),
        `the CLI's cwd ${inst.cwd} was never resolved before the marking event, so the `
        + `bootstrap's own \`cd\` is unaccounted for: ${JSON.stringify([...prePaths].sort())}`);

      // (4) EVERY PRE-MARK OP IS HOST OR SYNTHETIC. `hide` and `fail` cannot
      //     appear — `route()`'s `T_HIDE` arm returns before `tr()`, and `fail`
      //     is substituted to host for an unmarked caller — so what this really
      //     rules out is `project`, i.e. a marked answer inside the window.
      const tierOf = (l) => l.match(/\ttier=([a-z]+) /)?.[1] ?? '?';
      const ALLOWED = new Set(['host', 'synth', 'bind', 'fh']);
      const offside = pre.filter(l => !ALLOWED.has(tierOf(l)));
      assert.deepEqual(offside.map(l => l.split('\t').slice(0, 3).join(' ')), [],
        'A PRE-MARK OP RESOLVED A CALLER-SENSITIVE TIER. The CLI\'s thread group reached '
        + '`project`, `fail` or `hide` BEFORE the marking event: the same path would '
        + 'answer one way to the pre-mark ops and another to the post-mark ones, from one '
        + `caller. This run: ${pre.length} pre-mark, ${post.length} post-mark.`);

      // (5) AND NO LINK OF THE CHAIN WAS DENIED. The observed defect was a
      //     `deny` row naming `setpriv`'s own PATH lookups and the shell's
      //     symlink walk; with the whole chain unmarked there is no denial for
      //     any of it. Attributed by `comm`, which is what `exec(2)` leaves
      //     behind — the tgid is the CLI's for all of them.
      const denied = (await eventsOf(inst.id))
        .filter(r => r[0] === 'deny' && (r[6] === 'sh' || r[6] === 'dash' || r[6] === 'setpriv'
          || r[6] === 'chroot'));
      assert.deepEqual(denied.map(r => `${r[1]} ${r[2]} ${r[3]} comm=${r[6]}`), [],
        'the bootstrap chain was DENIED a path — with nothing pre-firing the mark every link '
        + 'resolves in VIEW_HOST, where an unpinned path is served from the orchestrator');

      console.log(`fuse gate [R12] pre-mark ops ${pre.length} over ${prePaths.size} distinct paths; `
        + `post-mark ${post.length}; tiers `
        + JSON.stringify([...new Set(pre.map(tierOf))].sort()));
      console.log(`fuse gate [R12] pre-mark paths ${JSON.stringify([...prePaths].sort())}`);
    } finally {
      try {
        if (inst) await instances.remove(inst.id);
      } finally {
        if (prevTrace === undefined) delete process.env.CC_FUSE_TRACE;
        else process.env.CC_FUSE_TRACE = prevTrace;
      }
    }
    assertNoResidue(before, runRoot, null, 'R12');
  });

  // ── R13 ──────────────────────────────────────────────────────────────────
  // AN UNMARKED CALLER READS THE HOST WHEREVER THE HOST HAS AN ENTRY, AND NEVER
  // THE REMOTE — at the mount.
  //
  // This arm runs against project `appx`, whose system ADVERTISES AN EXCLUDE —
  // the only way a prefix becomes `fail` by an explicit pin rather than by
  // being unnamed (`buildTierTable`). So (a) and (b) between them cover both
  // origins of `T_FAIL`, which `route()` cannot distinguish and must not.
  //
  //   (a) a host file under an EXPLICITLY EXCLUDED prefix reads
  //   (b) a host file under an UNPINNED prefix reads
  //   (c) the run directory is STILL -ENOENT — `hide` is not substituted
  //   (d) a project-tier file reads the HOST where the host has one, and is
  //       STILL denied where it has none — with a row for each
  //   (e) NO `unpinned-fail-closed` row is attributable to (a) or (b)
  //   (f) A WRITE at an unpinned path LANDS ON THE ORCHESTRATOR
  //
  // (f) IS PINNED BECAUSE IT IS A DECISION AND NOT AN ACCIDENT, AND IT WAS
  // MEASURED HERE RATHER THAN DERIVED. `host` is a passthrough, so `fail →
  // host` gives an unmarked caller the host's WRITE side too — and the host's
  // own permissions at the caller's uid become the ONLY gate, rather than the
  // blanket -ENOENT an unpinned path would otherwise answer to everyone.
  //
  // Both ends of that were measured on this host. As ROOT: R3's own probe — an
  // unmarked root shell — created `/usr/nope` on the orchestrator for real, and
  // the directory was still there afterwards. At UID 1000: a write into a
  // world-writable unpinned temp directory lands, and the file is readable from
  // cc's own process; a write into a 0555 synthetic ancestor does not, because
  // `default_permissions` refuses it before the daemon is asked.
  //
  // So an unprivileged worker's reach into the ORCHESTRATOR's filesystem is
  // exactly "what uid 1000 could write there anyway, at any path cc did not
  // pin". That is a real widening and it is recorded in docs/architecture.md
  // beside the substitution, not left for a reader to derive from this arm.
  //
  // MUTANTS: substitute T_HIDE ⇒ (c) dies; leave T_FAIL unsubstituted ⇒ (a),
  // (b) and (f) die; gate the T_FAIL substitution on host existence ⇒ (f) dies;
  // emit `deny` for a substitution ⇒ (e) dies.
  //
  // THE HOST-EXISTENCE TEST AT T_PROJECT IS GONE AND THE BEHAVIOUR IT WOULD
  // GATE IS UNCONDITIONAL: a project-tier path
  // re-resolves in `VIEW_HOST`, so `<proj>/remote-only.txt` routes to T_HOST,
  // the orchestrator has nothing there, and the caller gets the HOST's own
  // -ENOENT with a `served`/`unmarked-host-served` row and NO
  // `deny`/`unmarked-project-denied` one. (d)'s remote-only half is unchanged —
  // it sees a failed read and neither marker string either way — and (e) reads
  // the log. The invariant (d) and (e) jointly carry is that the bytes are never
  // the remote's, which `b41` now makes structural at unit level.
  test('R13 — an unmarked caller is served the host wherever the host has an entry, and never the remote', async () => {
    const before = snapshot(runRoot);
    const inst = await spawnWorker('chroot', 'appx');
    try {
      const record = await readRecord(inst.id);
      const proj = path.join(box, 'appx');
      // UNMARKED: no `[ -e "$mark" ]`. One token of difference from R2's marked
      // probe, so nothing else about the caller can explain the answers.
      const unmarked = (script, ...args) => inNs(record.anchorPid, script, ...args);

      // (a) AN EXPLICITLY EXCLUDED PREFIX. The host has the file and the fake
      // remote does not, so a successful read can only be the host's — and the
      // MARKED side has nothing there at all, which is why this is not a
      // one-path-two-answers case.
      const excluded = inside(record, path.join(proj, 'excluded', 'host.txt'));
      const a = await unmarked('read l < "$1" || exit 7; echo "$l"', excluded);
      assert.equal(a.ok, true, `an unmarked caller was denied at an EXCLUDED prefix: ${a.stderr}`);
      assert.match(a.stdout, /HOST-SIDE-EXCLUDED/, `${a.stdout} ${a.stderr}`);
      // AND THE TABLE REALLY SAYS `fail` THERE, read off the artifact the
      // daemon parsed rather than assumed from the advertisement.
      const pins = await fs.readFile(path.join(fuseRunDir(inst.id), 'pins.txt'), 'utf8');
      assert.ok(pins.split('\n').includes(`fail\t${path.join(proj, 'excluded')}`),
        `the excluded prefix is not a \`fail\` pin, so (a) proves nothing about the fail tier:\n${pins}`);

      // (b) AN UNPINNED PREFIX. `/var/…` is named by no pin at all, so it is
      // T_FAIL at enum index 0 — the other origin of the same tier.
      const varFile = '/var/lib/dpkg/status';
      const hostVar = await fs.readFile(varFile, 'utf8').catch(() => null);
      assert.ok(hostVar !== null, `${varFile} is missing on this host, so (b) cannot be measured`);
      assert.equal(resolveTierEntry(inst._redirect.tiers, varFile), null,
        `${varFile} is covered by a pin, so it is not the unpinned case this sub-arm needs`);
      const b = await unmarked('read l < "$1" || exit 7; echo "$l"', inside(record, varFile));
      assert.equal(b.ok, true, `an unmarked caller was denied at an UNPINNED prefix: ${b.stderr}`);
      assert.equal(b.stdout.trim(), hostVar.split('\n')[0].trim(),
        'the unpinned path did not answer with the orchestrator’s own file');

      // (c) `hide` IS NOT SUBSTITUTED. The run directory is where the mirror
      // lives — the only place remote bytes exist on this machine — and cc's
      // control socket is its sibling. R5 pins this for its own reasons; here
      // it is the control that says the substitution did not widen past `fail`.
      const hidden = inside(record, fuseRunDir(inst.id));
      const c = await unmarked('[ -e "$1" ] && echo REACHED || echo ENOENT', hidden);
      assert.match(c.stdout, /ENOENT/,
        `the run directory became reachable to an unmarked caller: ${c.stdout} ${c.stderr}`);

      // (d) `project` IS SUBSTITUTED WHERE THE HOST HAS AN ENTRY, AND ONLY
      // THERE — at the mount, in both directions.
      // `before()` seeds HOST-SIDE-COPY at the project's own spelling, so the
      // first half reads the HOST's copy and never the system's; `remote-only.txt`
      // exists on the system and nowhere on the host, so the second half is the
      // same tier, the same caller and the opposite answer.
      const projFile = inside(record, path.join(proj, 'remote-marker.txt'));
      const d = await unmarked('read l < "$1" || exit 7; echo "$l"', projFile);
      assert.equal(d.ok, true,
        `an unmarked caller was denied at a project path the host HAS: ${d.stdout} ${d.stderr}`);
      assert.match(d.stdout, /HOST-SIDE-COPY/, `${d.stdout} ${d.stderr}`);
      assert.doesNotMatch(d.stdout, /SYSTEM-SIDE-PROJECT-FILE/,
        'an unmarked caller received REMOTE bytes at a project path');
      const projOnly = inside(record, path.join(proj, 'remote-only.txt'));
      const d2 = await unmarked('read l < "$1" || exit 7; echo "$l"', projOnly);
      assert.equal(d2.ok, false,
        `an unmarked caller was served where the host has NOTHING: ${d2.stdout}`);
      assert.doesNotMatch(d2.stdout, /SYSTEM-ONLY-FILE|HOST-SIDE-COPY/,
        'an unmarked caller got bytes at a host-absent project path');

      // (e) THE LOG SAYS THE SAME THING. The two host-served paths are `served`
      // rows and NOT `unpinned-fail-closed` — that reason is the marked CLI's
      // alone now — and the project path is a `deny` row by name.
      const events = await eventsOf(inst.id);
      const rowFor = (p) => events.filter(r => r[2] === p);
      for (const [label, p] of [['(a) the excluded file', path.join(proj, 'excluded', 'host.txt')],
        ['(b) the unpinned file', varFile]]) {
        assert.deepEqual(rowFor(p).filter(r => r[3] === 'unpinned-fail-closed'), [],
          `${label} produced an unpinned-fail-closed row, which is the MARKED CLI's reason: ${JSON.stringify(rowFor(p))}`);
        assert.ok(rowFor(p).some(r => r[0] === 'served' && r[3] === 'unmarked-host-served'),
          `${label} produced no served/unmarked-host-served row, so the substitution is unobservable `
          + `to a maintainer: ${JSON.stringify(events)}`);
      }
      assert.ok(rowFor(path.join(proj, 'remote-marker.txt'))
        .some(r => r[0] === 'served' && r[3] === 'unmarked-host-served'),
        `(d)'s host-shadowed half produced no served/unmarked-host-served row — the `
        + `divergence is unobservable to a maintainer: ${JSON.stringify(events)}`);
      assert.ok(rowFor(path.join(proj, 'remote-only.txt'))
        .some(r => r[0] === 'served' && r[3] === 'unmarked-host-served'),
        `(d)'s host-absent half produced no served/unmarked-host-served row — it is served `
        + `the host and gets the orchestrator's own ENOENT, not a policy `
        + `denial: ${JSON.stringify(events)}`);

      // (f) THE WRITE SIDE, MEASURED AT THE ORCHESTRATOR'S OWN FILESYSTEM.
      // `<box>/hostwrite` is under the gate's temp dir and covered by no pin, so
      // it is T_FAIL — and the probe checks the file cc's own process can see,
      // not the shell's exit code, because only the former says the bytes
      // crossed. At uid 1000 into a uid-1000-owned temp dir, which is the reach
      // an unprivileged worker actually has.
      //
      // THE DIRECTORY HAS TO BE GENUINELY UNPINNED, AND `<box>` IS NOT —
      // measured, because it looked like the obvious fixture. `<box>/app` and
      // `<box>/appx` are `project` pins, so `<box>` is a STRICT ANCESTOR and
      // therefore `T_SYNTH`: it reported `555 0 0` and `default_permissions`
      // refused the write at uid 1000 before the daemon was asked. That is the
      // synthetic tier behaving correctly and says nothing about the
      // substitution. A fresh temp dir with no pin under it is `T_FAIL`.
      const openDir = await mkdtemp('cc-r13-hostwrite-');
      await fs.chmod(openDir, 0o777);
      const hostWrite = path.join(openDir, 'landed.txt');
      const f = await unmarked('echo HOST-WRITE-LANDED > "$1" && echo WROTE', inside(record, hostWrite));
      assert.match(f.stdout, /WROTE/,
        `the unmarked write was refused, so \`fail → host\` is not the passthrough (a) and (b) `
        + `read through: ${f.stdout} ${f.stderr}`);
      assert.equal(await fs.readFile(hostWrite, 'utf8'), 'HOST-WRITE-LANDED\n',
        'the write did not reach the ORCHESTRATOR\'s own filesystem, checked from cc\'s own '
        + 'process rather than from the shell\'s exit code — only the former says the bytes crossed');
      // AND IT IS LOGGED, so the reach is observable rather than silent.
      assert.ok((await eventsOf(inst.id)).some(r => r[0] === 'served' && r[2] === hostWrite
        && r[3] === 'unmarked-host-served'),
        'the unmarked write reached the orchestrator with no row naming the path');
      await fs.rm(openDir, { recursive: true, force: true });

      console.log(`fuse gate [R13] ${events.length} event rows; served `
        + JSON.stringify(events.filter(r => r[0] === 'served').map(r => r[2]).slice(0, 24)));
    } finally {
      await instances.remove(inst.id);
    }
    assertNoResidue(before, runRoot, null, 'R13');
  });


  // ── R14 ──────────────────────────────────────────────────────────────────
  // THE WIDE `mirrorRoot`. THIS IS A GATE, NOT AN EXTRA.
  //
  // Every other arm in this file runs `mirrorRoot` = the project path. There was
  // no wide-root arm at all, and the wide root lived only in deterministic tests
  // that pin the TABLE rather than the daemon — which is why the regression
  // (advertise `/`, the worker spawns and dies at `exec chroot`) reached the
  // owner.
  //
  // WHY THE PROJECT PATH IS ABSENT FROM THE HOST HERE, AND ONLY HERE.
  // `Instance._assertRemoteMountable` lstats the mirror root through this
  // fixture's host-local provider, so a DEFAULT-root project must exist on the
  // host and its whole cwd chain is host-served end to end. At `mirrorRoot: '/'`
  // the lstat is of `/`, which always exists — so this is the one arm that can
  // have a host-absent project, and therefore the ONLY place the OVERLAY NODE
  // is reachable at the real mount.
  test('R14 — a wide mirrorRoot spawns, serves the host where it has an entry, and never the remote', async () => {
    const before = snapshot(runRoot);
    const proj = path.join(box, 'wide', 'appw');
    // (1) THE REGRESSION, DIRECTLY. `spawnWorker` waits for `idle` AND for a
    // completed turn, so reaching this line is the claim: with `mirrorRoot: "/"`
    // a worker spawns and reaches the model. Before the host-existence
    // substitution the unmarked `chroot` died resolving /bin (exit 127).
    const inst = await spawnWorker('chroot', 'appw');
    try {
      const record = await readRecord(inst.id);
      const unmarked = (script, ...args) => inNs(record.anchorPid, script, ...args);

      // (2) THE CONFIGURATION REALLY IS THE WIDE ONE — non-vacuity, read off the
      // artifact the daemon parsed rather than off the advertisement. Without
      // this the arm could pass against a narrow table.
      const pins = await fs.readFile(path.join(fuseRunDir(inst.id), 'pins.txt'), 'utf8');
      assert.ok(pins.split('\n').includes('project\t/'),
        `the daemon did not parse a \`project /\` pin, so this is not the wide configuration:\n${pins}`);
      assert.equal(resolveTierEntry(inst._redirect.tiers, '/bin')?.tier, 'project',
        '/bin is not project tier, so the synthetic scaffold did not collapse and the arm is vacuous');

      // THE FIXTURE'S OWN PRECONDITION, CHECKED AGAINST THE DAEMON'S PIN LIST
      // rather than trusted from the walk's depth constant. Every strict
      // ancestor of a non-project pin that is itself `project` tier here must
      // exist as a DIRECTORY in the mirror source, or a MARKED caller cannot
      // traverse to the pin. Without it the arm dies at `/usr`, with the CLI
      // never reaching exec. Named, not mysterious.
      const missing = [];
      for (const row of pins.split('\n')) {
        if (!row || row.startsWith('#')) continue;
        const [kind, p] = row.split('\t');
        if (kind === 'project' || !p?.startsWith('/')) continue;
        for (const anc of ancestorsOf(p)) {
          if (resolveTierEntry(inst._redirect.tiers, anc)?.tier !== 'project') continue;
          if (!await fs.stat(path.join(fakeRemote, anc)).then(st => st.isDirectory(), () => false))
            missing.push(anc);
        }
      }
      assert.deepEqual([...new Set(missing)].sort(), [],
        'the mirror source has no directory at these project-tier ancestors of a host pin, so a '
        + 'MARKED caller cannot traverse to that pin — extend the scaffold in before()');

      // …and the three binds still land, exactly as R3 asserts for the narrow
      // root: a wide `project /` must not stop /proc, /sys and /dev from being
      // bind-mounted onto their nodes.
      const nsMounts = mountsOf(record.daemonPid) ?? [];
      for (const b of ['/proc', '/sys', '/dev'])
        assert.ok(nsMounts.includes(path.join(record.root, b)),
          `${b} was not bind-mounted under a wide mirror root: `
          + JSON.stringify(nsMounts.filter(m => m.startsWith(record.root))));

      // (3) HOST ENTRY PRESENT ⇒ HOST, WHATEVER THE TIER. `/etc/hostname` is
      // project tier here (it is `fail` at the narrow root, and it is not in
      // ETC_PINS), and an unmarked caller gets the ORCHESTRATOR's own bytes.
      const hostname = await fs.readFile('/etc/hostname', 'utf8');
      assert.equal(resolveTierEntry(inst._redirect.tiers, '/etc/hostname')?.tier, 'project',
        '/etc/hostname is not project tier here, so (3) measures the wrong tier');
      const h = await unmarked('read l < "$1" || exit 7; echo "$l"', inside(record, '/etc/hostname'));
      assert.equal(h.ok, true, `an unmarked caller was denied at a host-having project path: ${h.stderr}`);
      assert.equal(h.stdout.trim(), hostname.split('\n')[0].trim(),
        'the host-having project path did not answer with the orchestrator’s own file');
      // AND THE ROW NAMES IT, as `R2` and `R13`(e) require of the default root.
      // OBSERVABILITY AT THE MOUNT, not discrimination: the reason's kind and
      // its per-path emission are pinned at unit level (`b24`, `b25`, `b41`),
      // so no mutant survives this line's absence — what it buys is that a
      // maintainer reading a WIDE-root run's log can see the substitution at a
      // path outside the project at all.
      assert.ok((await eventsOf(inst.id)).some(r => r[0] === 'served'
        && r[2] === '/etc/hostname' && r[3] === 'unmarked-host-served'),
        'no served/unmarked-host-served row for /etc/hostname — the substitution is '
        + 'unobservable at a wide root outside the project tree');

      // (4) HOST ENTRY ABSENT ⇒ -ENOENT, NEVER REMOTE CONTENT.
      const projFile = inside(record, path.join(proj, 'remote-marker.txt'));
      const denied = await unmarked('read l < "$1" || exit 7; echo "$l"', projFile);
      assert.equal(denied.ok, false, `an unmarked caller was served the remote: ${denied.stdout}`);
      assert.doesNotMatch(denied.stdout, /SYSTEM-SIDE-PROJECT-FILE/,
        'an unmarked caller received REMOTE bytes at a wide mirror root');
      // THE CONTROL, so the denial is POLICY and not absence.
      const markedRead = await inNs(record.anchorPid,
        '[ -e "$1" ]; read l < "$2" || exit 7; echo "$l"',
        inside(record, inst._fuse.plan.markPath), projFile);
      assert.match(markedRead.stdout, /SYSTEM-SIDE-PROJECT-FILE/,
        `the system has no file there, so (4) proves nothing: ${markedRead.stdout} ${markedRead.stderr}`);

      // (5) THE OVERLAY NODE — relocated from R8(d)(e), and this is the only
      // place in the gate where it is reachable: `Instance._assertRemoteMountable`
      // lstats the mirror root through this fixture's host-local provider, so a
      // DEFAULT-root project must exist on the host and its whole chain is
      // host-served end to end.
      //
      // `0555`, NOT A TRAVERSE-ONLY `0111`. A traverse-only mode would exist
      // only for a node sitting over a PROJECT path where a listing could name
      // remote content; with the remote struck from an unmarked caller's view
      // the listing is EMPTIED BY THE EMIT'S OWN EXISTENCE CHECK —
      // `policy_table_child_exists` drops every table name the orchestrator
      // does not have, and it has nothing under a path it has nothing at —
      // which is what the `ls` below asserts: it SUCCEEDS and names nothing,
      // where a traverse-only mode would have the kernel refuse it. Both facts
      // are pinned: an empty listing that failed would be indistinguishable
      // from a leak the shell happened to swallow.
      const cwdStat = await unmarked('exec /usr/bin/stat -c "%a %u %g" "$1"', inside(record, proj));
      assert.equal(cwdStat.stdout.trim(), '555 0 0',
        `the project root is not the overlay node: ${cwdStat.stdout} ${cwdStat.stderr}`);
      const cwdLs = await unmarked('exec /bin/ls "$1"', inside(record, proj));
      assert.equal(cwdLs.ok, true, `an unmarked caller could not list the overlay node: ${cwdLs.stderr}`);
      assert.equal(cwdLs.stdout.trim(), '',
        `a child name reached an unmarked caller through the overlay node: ${cwdLs.stdout}`);

      // (6) THE CHAIN, AT THE MOUNT — and there is no traversal BOUND. Every
      // link is answered by one of exactly two things:
      // the orchestrator's own directory where it has one, or the overlay node
      // where it has none. `<box>` is the first — it reports the HOST
      // directory's own mode, read with `fs.stat` from cc's own process and
      // never a literal, with the floor's `0111` bits OR'd in because it is on
      // the chain. `<box>/wide` is the second.
      const hostBox = await fs.stat(box);
      const boxStat = await unmarked('exec /usr/bin/stat -c "%a %u %g" "$1"', inside(record, box));
      assert.equal(boxStat.stdout.trim(),
        `${((hostBox.mode & 0o7777) | 0o111).toString(8)} ${hostBox.uid} ${hostBox.gid}`,
        `<box> did not report the HOST directory's own attributes with the floor applied: `
        + `${boxStat.stdout} ${boxStat.stderr}`);
      // AND THE FLOOR IS SCOPED: a host directory that is NOT on the chain keeps
      // its real mode, unfloored. Without this the arm would pass under an
      // unscoped floor, which grants traversal the host itself denies.
      const offChain = path.join(box, 'off-chain');
      await fs.mkdir(offChain, { recursive: true, mode: 0o700 });
      await fs.chmod(offChain, 0o700);
      const hostOff = await fs.stat(offChain);
      assert.equal((hostOff.mode & 0o111), 0o100, 'the off-chain fixture is not 0700-shaped');
      const offStat = await unmarked('exec /usr/bin/stat -c "%a %u %g" "$1"', inside(record, offChain));
      assert.equal(offStat.stdout.trim(),
        `${(hostOff.mode & 0o7777).toString(8)} ${hostOff.uid} ${hostOff.gid}`,
        `an OFF-CHAIN host directory was floored, so the floor is unscoped: `
        + `${offStat.stdout} ${offStat.stderr}`);
      const wideStat = await unmarked('exec /usr/bin/stat -c "%a %u %g" "$1"',
        inside(record, path.join(box, 'wide')));
      assert.equal(wideStat.stdout.trim(), '555 0 0',
        `<box>/wide is not the overlay node: ${wideStat.stdout} ${wideStat.stderr}`);

      // ── (7) CAPTURE #2 ──────────────────────────────────────────────────
      //
      // Folded into this arm rather than run separately: one spawn, both jobs,
      // and the numbers land in the gate's own output where the next reader
      // finds them.
      //
      // NAMED LIMIT, recorded beside the numbers so neither capture is
      // over-read: RUN_FUSE_LIFECYCLE runs a FAKE CLI, so this answers only for
      // the BOOTSTRAP AND SPAWN POPULATION. The real CLI's own subprocesses
      // (hooks, the shell snapshot, the wrapper around a rewritten Bash command)
      // are visible only under a real-docker gate, which is not run here —
      // that half of the population is recorded OPEN, not assumed either way.
      const events = await eventsOf(inst.id);
      const idOf = (r) => `pid=${r[4]} tgid=${r[5]} comm=${r[6]} cmdline=${r[7]}`;

      // `cwd-traversal-served` IS RETIRED: there is no grant to record, so the
      // question — WHICH LINK did a given process need — is answered by the
      // mode instead, at (5) and (6),
      // and by the absence of any denial below. What is asserted here is that
      // the reason is really gone from the daemon's output, which is the mount's
      // half of the source-derived reason set in fuse-union-policy.test.mjs.
      assert.deepEqual(events.filter(r => r[3] === 'cwd-traversal-served'), [],
        'the daemon still emits cwd-traversal-served — the exemption was reinstated');
      assert.deepEqual(events.filter(r => r[3] === 'unmarked-project-host-served'), [],
        'the daemon still emits unmarked-project-host-served — the project tier regained a '
        + 'substitution rule of its own');

      // DECIDES "the CLI does not die at exec": no remaining denial names a
      // link of the cwd chain.
      const chain = new Set(['/', box, path.join(box, 'wide'), proj]);
      const denials = events.filter(r => r[0] === 'deny');
      for (const r of denials)
        console.log(`fuse gate [R14 capture#2] ${r[0]}\t${r[1]}\t${r[2]}\t${r[3]}\t${idOf(r)}`);
      assert.deepEqual(denials.filter(r => r[3] === 'unmarked-project-denied' && chain.has(r[2])), [],
        'an unmarked caller was denied a link of the cwd chain — the spawn-time chdir dies there');

      // THE HOST-SHADOWING SURFACE, REPORTED AND NOT ASSERTED ON: it is a
      // magnitude, and pinning it would be a tuning assertion.
      const shadow = new Map();
      for (const r of events.filter(r => r[3] === 'unmarked-host-served'))
        shadow.set(r[2], (shadow.get(r[2]) ?? 0) + 1);
      console.log(`fuse gate [R14 capture#2] unmarked-host-served rows by path: `
        + JSON.stringify([...shadow.entries()].sort((a, b) => b[1] - a[1]).slice(0, 40)));
      console.log(`fuse gate [R14 capture#2] ${events.length} rows; distinct tgids `
        + JSON.stringify([...new Set(events.map(r => `${r[5]}:${r[6]}`))].sort()));
    } finally {
      await instances.remove(inst.id);
    }
    assertNoResidue(before, runRoot, null, 'R14');
  });

  // ── R13w ─────────────────────────────────────────────────────────────────
  // THE BOOTSTRAP CHAIN IS UNMARKED AND IS SERVED THE ORCHESTRATOR, AT THE
  // GEOMETRY WHERE THAT IS THE DIFFERENCE BETWEEN A LAUNCH AND A DEATH.
  //
  // `mirrorRoot: '/'` is the geometry that decides it. A mark fired anywhere
  // ahead of the CLI puts the chroot'd shell, `setpriv` and the backend launch
  // command in `VIEW_CLI`, where every unpinned path they touch is `project`
  // tier with no host fallback — measured as `deny getattr
  // /usr/local/sbin/<launcher> remote-absent comm=setpriv`, and a launch that
  // dies `setpriv: failed to execute`.
  //
  // WHAT IT PINS, and the second is the one this arm exists for:
  //
  //   1. AN UNMARKED PROBE READS THE ORCHESTRATOR'S OWN BYTES at `/bin/sh`, at
  //      the `setpriv` binary and at a `/usr/bin` entry, with no `deny` row for
  //      any of them.
  //   2. NO MARKED OP NAMES A PATH UNDER `/usr/bin` AT ALL. That is the claim
  //      licensing `BOOTSTRAP_CHAIN` and the `/usr/bin` install-prefix pin it
  //      derives to be dropped: a pin exists only for a path a MARKED caller
  //      reads. If the CLI ever grows a marked read under
  //      `/usr/bin`, this dies and the pin is load-bearing again.
  //
  // THE TRACE IS SNAPSHOTTED BEFORE THIS ARM'S OWN MARKED PROBE RUNS, because
  // that probe would otherwise supply the very rows (2) rules out.
  test('R13w — the bootstrap chain is unmarked and host-served at a wide mirrorRoot, and nothing marked reads /usr/bin', async () => {
    const before = snapshot(runRoot);
    const prevTrace = process.env.CC_FUSE_TRACE;
    process.env.CC_FUSE_TRACE = '1';
    let inst;
    try {
      inst = await spawnWorker('chroot', 'appw');
      const record = await readRecord(inst.id);
      const unmarked = (script, ...args) => inNs(record.anchorPid, script, ...args);

      // NON-VACUITY: this really is the wide configuration, read off the
      // artifact the daemon parsed.
      const pins = await fs.readFile(path.join(fuseRunDir(inst.id), 'pins.txt'), 'utf8');
      assert.ok(pins.split('\n').includes('project\t/'),
        `the daemon did not parse a \`project /\` pin, so this is not the wide configuration:\n${pins}`);

      // (2) FIRST, before any probe of this arm's own can pollute it.
      const trace = (await fs.readFile(path.join(fuseRunDir(inst.id), 'trace.log'), 'utf8').catch(() => ''))
        .split('\n').filter(Boolean);
      assert.ok(trace.length > 0, 'the trace instrument did not run — see R8');
      const markedUsrBin = trace.filter(l => /\bmark=1\b/.test(l)
        && (l.split('\t')[1] ?? '').startsWith('/usr/bin/'));
      assert.deepEqual(markedUsrBin.map(l => l.split('\t').slice(0, 2).join(' ')), [],
        'A MARKED CALLER READ A PATH UNDER /usr/bin. `BOOTSTRAP_CHAIN` and the `/usr/bin` '
        + 'install-prefix pin it derives are justified by exactly this not happening — they are '
        + 'load-bearing again, and dropping them would put this path in the remote tier for the CLI');

      // (1) THE ORCHESTRATOR'S OWN BYTES, compared at the mount. `nsenter` does
      // NOT chroot, so the union spelling and the host spelling are both
      // nameable from one probe and `cmp` decides.
      const probes = ['/bin/sh', '/usr/bin/setpriv', '/usr/bin/cmp'];
      for (const bin of probes) {
        const r = await unmarked('exec /usr/bin/cmp -s "$1" "$2"', inside(record, bin), bin);
        assert.equal(r.ok, true,
          `an UNMARKED caller did not get the orchestrator's own ${bin} at a wide mirror root: `
          + `${r.stdout} ${r.stderr}`);
      }

      // AND NOTHING IN THE BOOTSTRAP CHAIN WAS DENIED — the observed defect,
      // asserted by the identity `exec(2)` leaves behind rather than by tgid,
      // which is the CLI's for every link.
      const events = await eventsOf(inst.id);
      const chainDenied = events.filter(r => r[0] === 'deny'
        && ['sh', 'dash', 'setpriv', 'chroot', 'cmp'].includes(r[6]));
      assert.deepEqual(chainDenied.map(r => `${r[1]} ${r[2]} ${r[3]} comm=${r[6]}`), [],
        'the bootstrap chain was DENIED a path at a wide mirror root — which is the launch '
        + 'death this card removes, and it means something is firing the mark ahead of the CLI');
      for (const bin of probes)
        assert.deepEqual(events.filter(r => r[0] === 'deny' && r[2] === bin), [],
          `${bin} produced a deny row for an unmarked caller`);

      // THE CONTRAST, LAST: the same three paths to a MARKED caller are still
      // the orchestrator's, because `BOOTSTRAP_CHAIN` and `binaryPins` pin them
      // host at every geometry. That is what makes their removal a review
      // question rather than a guess — today nothing needs them, and this says
      // what they currently do.
      for (const bin of probes) {
        const r = await inNs(record.anchorPid, '[ -e "$1" ]; exec /usr/bin/cmp -s "$2" "$3"',
          inside(record, inst._fuse.plan.markPath), inside(record, bin), bin);
        assert.equal(r.ok, true,
          `a MARKED caller did not get the orchestrator's own ${bin}: ${r.stdout} ${r.stderr}`);
      }

      console.log(`fuse gate [R13w] ${trace.length} traced ops, `
        + `${trace.filter(l => /\bmark=1\b/.test(l)).length} marked; `
        + `${events.length} event rows, ${events.filter(r => r[0] === 'deny').length} deny`);
    } finally {
      try {
        if (inst) await instances.remove(inst.id);
      } finally {
        if (prevTrace === undefined) delete process.env.CC_FUSE_TRACE;
        else process.env.CC_FUSE_TRACE = prevTrace;
      }
    }
    assertNoResidue(before, runRoot, null, 'R13w');
  });

  // ── R14L ─────────────────────────────────────────────────────────────────
  // THE BACKEND LAUNCHER'S HANDOFF TO THE CLI, ACROSS THE MARK BOUNDARY.
  //
  // `setpriv` execs the BACKEND launch command, not the CLI: the template's
  // token 0 (`resolveBackendLaunch`), which then execs the CLI itself. That
  // process runs entirely UNMARKED, so its writes land on the ORCHESTRATOR
  // while the CLI — marked from its own `execve` onward — reads the same
  // spelling in `VIEW_CLI`. Wherever those two views differ, a file handed from
  // the launcher to the CLI is handed to nobody.
  //
  // WHAT IT PINS, both halves, at the geometry where the difference exists:
  //
  //   POSITIVE: a launcher write inside a HOST-PINNED ROOT reaches the CLI
  //   unchanged — the pin is a longer prefix than `project /`, so both views are
  //   the orchestrator's one file. This is the guard under the built-in
  //   templates, whose own state lives in `$HOME` and whose configuration
  //   reaches the CLI through the environment; `$HOME` and the projects root are
  //   the same pin class (`buildTierTable`), and the projects root is the one
  //   this gate can write into.
  //
  //   THE NAMED RESIDUAL: a launcher write OUTSIDE every host-pinned root, under
  //   `mirrorRoot: '/'`, DIVERGES — the bytes land on the orchestrator and a
  //   marked reader gets the system's file at the same spelling. Asserted
  //   explicitly, so the limit on what a backend template may pass through a
  //   file is measured rather than discovered.
  //
  // THE LAUNCHER IS BUILT BY THE TEST. Nothing here reads this host's own
  // backends, and no real launcher is invoked.
  test('R14L — a backend launcher runs unmarked: its host-pinned handoff reaches the CLI, and an unpinned one diverges', async () => {
    const { addBackend, addCustomModel } = await import('../src/appSettings.ts');
    const before = snapshot(runRoot);

    // The two handoff paths. `insidePinned` is under the projects root, which
    // `buildTierTable` host-pins — the same class as `$HOME`, and the one this
    // gate owns; `outside` is under <box>, which a wide mirror root makes
    // `project` tier — and the system has its own, different file there.
    const insidePinned = path.join(process.env.PROJECTS_ROOT, 'r14l-handoff.txt');
    const outside = path.join(box, 'r14l-handoff.txt');
    await fs.mkdir(path.join(fakeRemote, box), { recursive: true });
    await fs.writeFile(path.join(fakeRemote, box, 'r14l-handoff.txt'), 'SYSTEM-SIDE-HANDOFF\n');
    await fs.rm(insidePinned, { force: true });
    await fs.rm(outside, { force: true });

    // THE LAUNCHER: writes both files, then execs what it was handed — which is
    // the CLI, because the template carries the CLI's own argv after its own.
    const launcherDir = await mkdtemp('cc-r14l-launcher-');
    const launcher = path.join(launcherDir, 'launch.sh');
    await fs.writeFile(launcher,
      '#!/bin/sh\n'
      + 'echo LAUNCHER-WROTE > "$CC_R14L_INSIDE" || exit 70\n'
      + 'echo LAUNCHER-WROTE > "$CC_R14L_OUTSIDE" || exit 71\n'
      + 'exec "$@"\n');
    await fs.chmod(launcher, 0o755);

    await addBackend({
      id: 'r14l', label: 'R14L launcher',
      template: `${launcher} ${process.execPath} ${path.join(HERE, 'fake-claude.mjs')}`,
      env: [{ key: 'CC_R14L_INSIDE', value: insidePinned }, { key: 'CC_R14L_OUTSIDE', value: outside }],
    });
    await addCustomModel({ label: 'R14L', model: 'r14l:v1', backend: 'r14l', contextWindow: 200_000 });

    let inst;
    try {
      const r = await api(baseUrl, 'POST', '/api/instances',
        { project: 'appw', mode: 'bypassPermissions', backend: 'r14l', model: 'r14l:v1' });
      assert.equal(r.status, 201, JSON.stringify(r.body));
      inst = instances.get(r.body.id);
      await waitFor(() => inst.status === 'idle', { timeout: TURN_TIMEOUT_MS });
      const seqOf = () => inst.ringSnapshot().filter(e => e.kind === 'turn_end').at(-1)?._seq ?? -1;
      const seq0 = seqOf();
      await inst.prompt('hello');
      await waitFor(() => seqOf() > seq0, { timeout: TURN_TIMEOUT_MS });
      // REACHING HERE IS THE FIRST CLAIM: the launcher exec'd, ran unmarked,
      // wrote, and exec'd a CLI that completed a turn.
      const record = await readRecord(inst.id);

      // BOTH WRITES LANDED ON THE ORCHESTRATOR, read from cc's own process.
      assert.equal(await fs.readFile(insidePinned, 'utf8'), 'LAUNCHER-WROTE\n',
        'the launcher’s host-pinned write did not reach the orchestrator’s filesystem');
      assert.equal(await fs.readFile(outside, 'utf8'), 'LAUNCHER-WROTE\n',
        'the launcher’s unpinned write did not reach the orchestrator’s filesystem');

      // NON-VACUITY OF THE POSITIVE ARM: the path really is host-pinned here,
      // read off the same table the daemon's pins file is rendered from.
      assert.equal(resolveTierEntry(inst._redirect.tiers, insidePinned)?.tier, 'host',
        'the handoff path is not host-pinned, so the positive arm measures nothing');

      // POSITIVE: A MARKED READER — the CLI's own view — gets the same bytes.
      const got = await inNs(record.anchorPid, '[ -e "$1" ]; read l < "$2" || exit 7; echo "$l"',
        inside(record, inst._fuse.plan.markPath), inside(record, insidePinned));
      assert.match(got.stdout, /LAUNCHER-WROTE/,
        `the CLI's view of the launcher's host-pinned handoff is not the launcher's bytes: `
        + `${got.stdout} ${got.stderr}`);

      // THE NAMED RESIDUAL: outside every host pin, under a wide mirror root,
      // the same spelling is the SYSTEM's file to the marked CLI. Non-vacuous
      // by construction — the system's copy carries different bytes.
      assert.equal(resolveTierEntry(inst._redirect.tiers, outside)?.tier, 'project',
        'the unpinned handoff path is not project tier here, so the divergence arm measures nothing');
      const diverged = await inNs(record.anchorPid, '[ -e "$1" ]; read l < "$2" || exit 7; echo "$l"',
        inside(record, inst._fuse.plan.markPath), inside(record, outside));
      assert.match(diverged.stdout, /SYSTEM-SIDE-HANDOFF/,
        `the divergence is not what this arm records: ${diverged.stdout} ${diverged.stderr}`);
      assert.doesNotMatch(diverged.stdout, /LAUNCHER-WROTE/,
        'the marked CLI read the launcher’s own bytes at an unpinned path, so the residual this arm '
        + 'names no longer exists — re-derive it rather than deleting the arm');

      // AND THE LAUNCHER ITSELF WAS NEVER DENIED: it runs unmarked, so its own
      // binary, its interpreter and its writes are the orchestrator's.
      const events = await eventsOf(inst.id);
      assert.deepEqual(events.filter(r => r[0] === 'deny'
        && (r[2] === launcher || r[2] === insidePinned || r[2] === outside))
        .map(r => `${r[1]} ${r[2]} ${r[3]}`), [],
        'the backend launcher was denied its own script or one of its writes');
      console.log(`fuse gate [R14L] launcher ran unmarked; ${events.length} event rows, `
        + `${events.filter(r => r[0] === 'deny').length} deny`);
    } finally {
      if (inst) await instances.remove(inst.id);
      await fs.rm(launcherDir, { recursive: true, force: true });
      await fs.rm(insidePinned, { force: true });
      await fs.rm(outside, { force: true });
    }
    assertNoResidue(before, runRoot, null, 'R14L');
  });

  // ── R16 ──────────────────────────────────────────────────────────────────
  // A SYMLINKED LAUNCHER MARKS ON THE LINK, AND ITS TARGET'S CHAIN IS WALKED
  // MARKED.
  //
  // WHY IT HAS TO BE ITS OWN ARM: the gate's default `CLAUDE_BIN` makes
  // `markPath` the plain `node` binary, which is a regular file — so the
  // symlink geometry, which is the ORDINARY npm-global install of the real CLI
  // (`/usr/bin/claude` → `…/node_modules/@anthropic-ai/claude-code/…`), is
  // exercised nowhere else in this file.
  //
  // WHAT IT PINS, and both halves matter to a different consumer:
  //
  //   THE MARK FIRES ON THE LINK. The daemon uses libfuse's HIGH-LEVEL API, so
  //   it sees the reconstructed path string and symlink resolution happens in
  //   the VFS — the LINK is looked up first, and the link is the spelling cc
  //   registers (`markPath` = the launch command, not its realpath). A mark
  //   moved to `pt_open` would never match it: the link is never opened, only
  //   its target is.
  //
  //   AND THE TARGET'S CHAIN IS MARKED. Everything the VFS walks after the link
  //   — the realpath and its ancestors — is resolved by an ALREADY-MARKED
  //   thread group, which is why `binaryPins` must pin the realpath and not
  //   only the command spelling.
  test('R16 — a symlinked launcher marks on the LINK, and its realpath is then walked marked', async () => {
    const before = snapshot(runRoot);
    const prevTrace = process.env.CC_FUSE_TRACE;
    const prevBin = process.env.CLAUDE_BIN;
    const linkDir = await mkdtemp('cc-r16-link-');
    const link = path.join(linkDir, 'claude');
    // The link's TARGET is a real binary the CLI can actually be: this arm is
    // about the spelling, not about a stand-in.
    await fs.symlink(process.execPath, link);
    const real = await fs.realpath(link);
    assert.notEqual(real, link, 'the fixture did not produce a symlink, so this arm is vacuous');

    process.env.CC_FUSE_TRACE = '1';
    process.env.CLAUDE_BIN = `${link} ${path.join(HERE, 'fake-claude.mjs')}`;
    let inst;
    try {
      inst = await spawnWorker();
      // cc REGISTERS THE COMMAND SPELLING, not the realpath — the standing
      // condition the two-view argument rests on.
      assert.equal(inst._fuse.plan.markPath, link,
        `markPath is ${inst._fuse.plan.markPath}, not the launch command's own spelling ${link}`);

      const record = await readRecord(inst.id);
      const rows = (await fs.readFile(path.join(fuseRunDir(inst.id), 'trace.log'), 'utf8').catch(() => ''))
        .split('\n').filter(Boolean)
        .filter(l => new RegExp(`\\btgid=${record.bootstrapPid}\\b`).test(l));
      assert.ok(rows.length > 0, `no traced op is attributed to tgid ${record.bootstrapPid}`);

      const firstMarked = rows.findIndex(l => /\bmark=1\b/.test(l));
      assert.ok(firstMarked > 0, `the marking event never fired: ${rows.slice(0, 4).join(' | ')}`);
      assert.equal(rows[firstMarked].split('\t')[1], link,
        `the FIRST marked op names ${rows[firstMarked].split('\t')[1]}, not the SYMLINK ${link} — `
        + 'the daemon is matching some other spelling, and cc registers the link');

      // AND THE TARGET IS WALKED MARKED — the fact `binaryPins`' realpath entry
      // and the ancestor pins above it rest on.
      const marked = rows.filter(l => /\bmark=1\b/.test(l)).map(l => l.split('\t')[1]);
      assert.ok(marked.includes(real),
        `the symlink's realpath ${real} was never resolved by a MARKED caller, so this arm does `
        + `not show the target chain being walked marked: ${JSON.stringify([...new Set(marked)].slice(0, 30))}`);
      // The link is resolved BEFORE its target, which is the ordering the whole
      // claim depends on.
      assert.ok(marked.indexOf(link) < marked.indexOf(real),
        'the realpath was resolved before the link, so the mark did not fire on the link');

      console.log(`fuse gate [R16] markPath=${link} → ${real}; `
        + `${marked.length} marked ops over ${new Set(marked).size} paths`);
    } finally {
      try {
        if (inst) await instances.remove(inst.id);
      } finally {
        if (prevTrace === undefined) delete process.env.CC_FUSE_TRACE;
        else process.env.CC_FUSE_TRACE = prevTrace;
        if (prevBin === undefined) delete process.env.CLAUDE_BIN;
        else process.env.CLAUDE_BIN = prevBin;
        await fs.rm(linkDir, { recursive: true, force: true });
      }
    }
    assertNoResidue(before, runRoot, null, 'R16');
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
