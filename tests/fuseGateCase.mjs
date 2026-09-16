// THE REAL-FUSE GATE'S SHARED HARNESS. Skipped by default — opt in with
// `RUN_FUSE_LIFECYCLE=1`, which needs `sudo -n`, /dev/fuse, fusectl, gcc and
// libfuse3 headers.
//
//   TEST_CONCURRENCY=1 RUN_FUSE_LIFECYCLE=1 node tests/run.mjs tests/fuse-*.real.test.mjs
//
// THE CAP IS PART OF THE INVOCATION, NOT A TUNING KNOB. Every file here spawns
// real workers into real FUSE mounts, and at the default concurrency the four
// starve each other: measured 3 kills in 18 runs of the BARE glob, always the
// same shape — one arm rides the runner's 60s per-test timeout, and its whole
// file then dies at FILE_KILL_MS, taking that file's arm names with it. The
// stalled arm varied (R9, R10, R14), so it is contention, not an arm-specific
// bug. The runner's `peak concurrent fake-claude subprocesses` line is a 100ms
// sampler's maximum, not a census, so it is a range: over 11 uncapped runs it
// read 3 ten times and 4 once, and over 10 capped runs it read 1 every time.
// At TEST_CONCURRENCY=1: 10 consecutive runs, 0 kills.
//
// tests/run.mjs has no per-file exclusivity — one `run({files, concurrency})`
// call and a global TEST_CONCURRENCY — so there is nowhere else to put this.
//
// Turning the gate on for a WHOLE-SUITE run is the same hazard by another
// route. TEST_CONCURRENCY=4 is what has been tried there —
//
//   TEST_CONCURRENCY=4 RUN_FUSE_LIFECYCLE=1 node tests/run.mjs
//
// — but it is MEASURED ONCE GREEN AND ONCE RED (a later gate-on baseline at
// that setting red R14L with the same starvation shape, and the marking file
// then passed 4/4 alone at TEST_CONCURRENCY=1), so it carries no rate. Only the
// capped family glob above does.
//
// See docs/architecture.md → "The FUSE-union chroot" for every measurement,
// including what the cap costs in wall.
//
// Real sudo, real unshare, real FUSE, real mounts, real pids — and a FAKE
// claude binary (`bootServer({realProcess:true})`), because the question is
// about mounts and pids, not about tools. No tokens and no network.
//
// The four files of the family, which each import from here — one harness, four
// consumers, so the mount geometry cannot drift between them:
//
//   fuse-lifecycle.real     the spawn, the three teardown paths, the boot
//                           sweep, the busy-mount wedge, the cost control, the
//                           refusal, and the record-independent leak arm
//   fuse-union-mount.real   what the mount itself answers: one path spelling,
//                           marked vs unmarked at a project path, fail-closed
//                           bring-up, the event log, the run directory, EIO on
//                           a dead control server, project-tier mutation
//   fuse-union-routing.real where a path resolves for an UNMARKED caller: the
//                           spawn-time chdir, the cwd-chain floor and its
//                           scope, rename, a push that cannot land, the host
//                           substitution, and the wide `mirrorRoot`
//   fuse-union-marking.real WHO is marked and WHEN: the CLI's own marking
//                           event, the unmarked bootstrap chain at a wide root,
//                           a backend launcher's handoff, and a symlinked
//                           launcher's link-then-realpath walk
//
// SPLIT ACROSS FILES ON PURPOSE. Every arm here is a real spawn, a real mount
// and a real teardown costing ~2.4s, so one file was charged their SUM and sat
// at the hang guard's per-file deadline (FILE_KILL_MS, tests/hangGuardConfig.mjs);
// separate files are charged the MAX. The answer to a file over the deadline is
// more files, not a later deadline — see the FILE_KILL_MS comment there, and
// docs/architecture.md → "The FUSE-union chroot" for this family's own
// before→after figures.
//
// This module is NOT named `*.test.mjs`, so run.mjs's discover() (which globs
// `*.test.mjs`) ignores it — same convention as helpers.mjs / idleWakeCase.mjs.
//
// EVERY ARM CAPTURES A `BEFORE` SNAPSHOT AND ASSERTS A DELTA, so what the run
// leaked is distinguished from what it inherited. A host can carry inherited
// FUSE residue — stale minors, inert, freeing nothing — and an absolute
// assertion would either fail on it or hide a leak under it.
//
// PID DISCIPLINE. Every signal in this family targets a numeric pid read out of
// the session's OWN mount.json, re-verified against /proc/<pid>/stat field 22
// immediately before signalling, via killPids (tests/procTree.mjs). There is no
// pkill, no killall, no pgrep, and no pattern of any kind anywhere in this
// family — a previous worker on this ticket killed the devcontainer with a
// broad kill by process name.

import { before, after } from 'node:test';
import assert from 'node:assert/strict';
import { promises as fs, readFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { execFile } from 'node:child_process';
import { bootServer, api, freshProjectsRoot, padPathTo, rmrf, waitFor } from './helpers.mjs';
import { seedRepo } from './remoteSystem.mjs';
import { mkdtemp } from './tmpRegistry.mjs';
import { adoptProject, orchStoreRoot } from '../src/projects.ts';
import { addSystem } from '../src/appSettings.ts';
import { disposeSystemHandles } from '../src/systems/registry.ts';
import { EVENT_LOG_NAME, fuseRunDir, fuseRunRoot } from '../src/systems/fuse/plan.ts';
import { SUN_PATH_MAX } from '../src/systems/fuse/control.ts';
import { scanProcesses, orphansUnder } from '../src/systems/fuse/procScan.ts';
import { assertFuseAvailable } from '../src/systems/fuse/preflight.ts';

export const ENABLED = process.env.RUN_FUSE_LIFECYCLE === '1';
const FIXTURE = path.join(path.dirname(fileURLToPath(import.meta.url)), 'fixtures', 'mirrorFixtureProvider.mjs');
export const HERE = path.dirname(fileURLToPath(import.meta.url));
// bootServer({realProcess:true}) DELETES FAKE_CLAUDE_SCENARIO unless a scenario
// is given, and fake-claude then exits 2 — which makes every teardown arm pass
// vacuously against a worker that never started.
const SCENARIO = path.join(HERE, 'fixtures', 'scenario-basic.json');

// ── observation helpers. All read-only; none of them selects a pid. ──────────

export const mountsOf = (pid) => {
  try { return readFileSync(`/proc/${pid}/mounts`, 'utf8').split('\n').filter(Boolean).map(l => l.split(' ')[1]); }
  catch { return null; }
};
// A ROOT THAT IS NOT A ROOT IS REFUSED, NOT FILTERED. An `undefined` prefix
// makes the filter test `startsWith('undefined/')`, which matches nothing — so
// BOTH sides of a residue delta read empty and `assertNoResidue` compares an
// empty set with itself and passes.
//
// HOW BLIND THAT LEFT THE FAMILY IS MEASURED, not counted: with a broken root
// and no refusal here, 24 of the 26 arms passed silently. Only arm 1 and arm 4
// noticed, and they notice because they assert POSITIVE mount membership rather
// than a delta. (A hand census of "arms that reach this only through
// `snapshot()`" is the wrong instrument and goes stale as arms move — arm 6, for
// one, is in that set yet would fail anyway, on its own `fs.readdir(runRoot)`.)
// Refuse the input instead.
export const mountsUnder = (pid, prefix) => {
  if (typeof prefix !== 'string' || !prefix.startsWith('/')) {
    throw new TypeError(`mountsUnder needs an absolute root, got ${JSON.stringify(prefix)}`
      + ' — a non-root prefix filters to nothing and turns every residue delta vacuous');
  }
  return (mountsOf(pid) ?? []).filter(m => m === prefix || m.startsWith(prefix + '/'));
};
// /proc/<pid>/stat field 22 — the identity killPids re-verifies before signalling.
export const startOf = (pid) => {
  try {
    const raw = readFileSync(`/proc/${pid}/stat`, 'utf8');
    return raw.slice(raw.lastIndexOf(')') + 2).split(' ')[19];
  } catch { return null; }
};
export const alive = (pid, start) => startOf(pid) === start;
export const sh = (cmd, args) => new Promise(r => execFile(cmd, args, { timeout: 30_000 }, (e, so, se) =>
  r({ ok: !e, stdout: String(so ?? ''), stderr: String(se ?? '') })));

// The whole-machine snapshot each arm deltas against.
export function snapshot(runRoot) {
  return {
    pid1Total: (mountsOf(1) ?? []).length,
    pid1UnderRun: mountsUnder(1, runRoot),
    selfUnderRun: mountsUnder(process.pid, runRoot),
  };
}

export async function readRecord(instanceId) {
  try { return JSON.parse(await fs.readFile(path.join(fuseRunDir(instanceId), 'mount.json'), 'utf8')); }
  catch { return null; }
}

// What every teardown arm must be able to say afterwards, stated once.
export function assertNoResidue(before, runRoot, record, label) {
  const after = snapshot(runRoot);
  // Printed, not just asserted: the delta IS the evidence this family exists
  // to produce, and a passing assertion shows no numbers.
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
export const ancestorsOf = (p) => {
  const out = ['/'];
  const parts = p.split('/').filter(Boolean);
  for (let i = 1; i < parts.length; i++) out.push('/' + parts.slice(0, i).join('/'));
  return out;
};

// The live suite state, as a MUTABLE OBJECT rather than exported bindings: a
// consumer that destructured `runRoot` at import time would capture the
// pre-boot `undefined` forever, since `before` has not run yet.
export const ctx = {};
let server, baseUrl, instances, home, box, runRoot, fakeRemote, prevFakeRemote;
// Reported, not asserted on: the wall time of a spawn and of one turn, inside
// the chroot and outside it. The cost of attr_timeout=0/entry_timeout=0 is
// unmeasured and is the one that matters: the union serves every page of the
// CLI binary with no kernel cache. RECORD IT, DO NOT TUNE IT — if it is unusable that is the report,
// not a reason to reach for kernel_cache.
//
// Only the lifecycle file registers the `control` arm, so only its `[control]`
// row prints; the other three print a `[chroot]` row alone, whose `n=` field
// says how many arms it averages.
const timings = { chroot: [], control: [] };

// THE HANDOFF IS CHECKED ON THE POPULATION SIDE. That is the half this can
// see, and the two halves are disjoint — measured, from where each failure
// lands:
//
//   POPULATION-SIDE (this check). A field this harness stopped publishing, or
//   one it derived to an empty string. `before()` throws here, BEFORE
//   `onReady`, so the failure is at DESCRIBE level and no arm runs at all.
//   Verified in all four files against a bag published with `runRoot: ''`.
//
//   CONSUMER-SIDE (not this check). A typo in a file's own destructure leaves
//   the bag COMPLETE, so this passes silently and the `undefined` travels into
//   that file's arms. What catches it is `mountsUnder`'s refusal one level
//   down, at ARM level. Verified in all four files by dropping `runRoot` from
//   the destructure: every arm that takes a residue delta reds.
//
// So do not read this check as guarding the destructure — it guards what the
// harness itself hands over.
//
// Shape, not just presence: an empty string is as broken as a missing key and
// is what a mis-derived path root looks like. WHAT NO PREDICATE HERE CAN SEE is
// an absolute path that is simply the WRONG root; see the blindness note on
// arm 7 in tests/fuse-lifecycle.real.test.mjs, which covers this observation
// too.
const CTX_SHAPE = {
  baseUrl: (v) => typeof v === 'string' && v.startsWith('http'),
  instances: (v) => typeof v?.get === 'function',
  box: (v) => typeof v === 'string' && v.startsWith('/'),
  runRoot: (v) => typeof v === 'string' && v.startsWith('/'),
  fakeRemote: (v) => typeof v === 'string' && v.startsWith('/'),
  home: (v) => typeof v === 'string' && v.startsWith('/'),
  server: (v) => typeof v?.close === 'function',
};

function assertCtxComplete() {
  const bad = Object.keys(CTX_SHAPE).filter(k => !CTX_SHAPE[k](ctx[k]));
  assert.deepEqual(bad, [], `fuse gate: setupFuseGate is about to publish a ctx whose `
    + `${JSON.stringify(bad)} ${bad.length === 1 ? 'binding is' : 'bindings are'} missing or `
    + `malformed (${JSON.stringify(Object.fromEntries(bad.map(k => [k, ctx[k]])))}). Every file `
    + `destructures these; an undefined one reaches the arms instead of failing here, and an arm `
    + `that only reads it through snapshot() cannot notice.`);
}

// Registers the whole lifecycle on the CALLING FILE's suite. Call it INSIDE the
// `describe`, not at module top level: `{ skip: !ENABLED }` on the describe is
// what keeps these files ~free in the default suite, and a hook registered at
// the root would run there anyway.
//
// `label` names the file in this harness's own console output and in the leak
// assertion's failure message, which fires in a hook and so names no arm.
//
// `onReady` is how each file binds the bare `runRoot` / `box` identifiers its
// test bodies read, and it is a CALLBACK rather than a second `before` in the
// file because node:test does NOT sequence sibling `before` hooks: started in
// registration order, never awaited between. A file-side `before` reading `ctx`
// would therefore see the pre-boot `undefined`. Called here, after the await, it
// cannot.
//
// SETUP IS PARAMETERLESS — all three systems, always, in every file. The mirror
// scaffold is sub-second, so gating it on which arms a file carries buys
// nothing, and omitting a system would give the arms that remain a different
// tier table from the one they were written against.
export function setupFuseGate(label, onReady) {
  before(async () => {
    // Fail loudly and by name rather than producing a red gate that is really a
    // missing dependency. ASSERT, NEVER INSTALL.
    const { ensureUnionBinary } = await import('../src/systems/fuse/build.ts');
    const { realProbes } = await import('../src/systems/fuse/preflight.ts');
    await assertFuseAvailable({ ...realProbes, ensureBinary: ensureUnionBinary });

    // No switch to set: `bootServer({realProcess:true})` injects the REAL
    // launcher, and the union is mandatory for a remote-backed worker on it.
    server = await bootServer({ realProcess: true, scenarioPath: SCENARIO });
    ({ baseUrl, instances } = server);
    ({ home } = await freshProjectsRoot());
    // ── THE WHOLE GATE RUNS AT A LONG STORE ROOT ────────────────────────────
    //
    // Addressed by its real path, the control socket would make the store
    // root's depth a spawn-time cliff: past Linux's 107-byte `sun_path`,
    // `bind(2)` answers a bare `EINVAL`. It is addressed through a directory
    // fd instead, and every arm in the family is the proof — spawn, mount,
    // serve, tear down, sweep — rather than one dedicated arm that would need a
    // second fake-remote scaffold to duplicate.
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
    // every arm in the family.
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
    // `/usr/lib/x86_64-linux-gnu/libc.so.6`, and `/usr/lib/x86_64-linux-gnu`
    // above `libc.so.6` itself). A MARKED caller resolves those through the
    // control channel, so the mirror SOURCE must have a directory at each of
    // them. A real remote system has them by construction; this fixture's fake
    // remote is deliberately narrow (one project tree), and without this
    // scaffold a marked walk dies at `/usr` with `remote-absent` — the daemon
    // names the path — and the worker never reaches the CLI.
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
      'the host still has an entry at the wide project’s parent, so R14 '
      + '(tests/fuse-union-routing.real.test.mjs) is vacuous');

    Object.assign(ctx, { baseUrl, instances, box, runRoot, fakeRemote, home, server });
    assertCtxComplete();
    onReady?.(ctx);
  });

  after(async () => {
    // Runs before the shutdown below, so a process this file leaked is still
    // there to be found rather than reaped by it. The verdict is DEFERRED to
    // the end of the hook so that a leak never costs the file its teardown.
    let leaked = null, scanErr = null;
    try { leaked = await attributableProcesses(); } catch (e) { scanErr = e; }
    if (leaked?.length) console.log(`fuse gate [${label}]: LEAKED ${JSON.stringify(leaked)}`);
    for (const [where, rows] of Object.entries(timings)) {
      if (!rows.length) continue;
      const f = (k) => rows.map(r => r[k]).join('/');
      console.log(`fuse gate timing [${where}] n=${rows.length} spawn→idle ms: ${f('spawnMs')} | turn ms: ${f('turnMs')}`);
    }
    if (prevFakeRemote === undefined) delete process.env.CC_FUSE_SOURCE_OVERRIDE_ROOT;
    else process.env.CC_FUSE_SOURCE_OVERRIDE_ROOT = prevFakeRemote;
    if (server) await server.instances.shutdown();
    disposeSystemHandles();
    if (home) await rmrf(home);
    if (server) await server.close();
    // NOT `.catch(() => [])`: attributableProcesses asserts the scan RAN, and
    // swallowing that turns a scan that could not run into "no leak".
    if (scanErr) throw scanErr;
    assert.deepEqual(leaked, [],
      `fuse gate [${label}]: this file leaked ${leaked?.length} process(es) carrying `
      + `CC_FUSE_RUNDIR under ${runRoot}: ${JSON.stringify(leaked)}. This fired in the shared `
      + `after() hook in tests/fuseGateCase.mjs, so it names no arm — the arms in this file run `
      + `in declaration order and each asserts its own residue delta.`);
  });
}

// THE LEAK CHECK THAT DOES NOT READ A RECORD, and the reason there is one: a
// /proc/1/mounts delta cannot see a private namespace, and re-verifying the
// pids in mount.json cannot see a leak whose record was deleted. Both halves
// of the original check were blind to a leaked anchor by construction, and
// one leaked.
//
// Attribution is on an identity the process CARRIES — CC_FUSE_INSTANCE_ID and
// CC_FUSE_RUNDIR in /proc/<pid>/environ, scoped to THIS run's run root — never
// on comm or cmdline. `sleep infinity` is as generic a needle as exists here.
export async function attributableProcesses() {
  const { ok, rows } = await scanProcesses({ withEnviron: true });
  // A scan that could not run is a FAILURE, not an empty result — that
  // distinction is the whole point of the control in arm 4.
  assert.equal(ok, true, 'the process scan could not run; no emptiness below is evidence');
  return orphansUnder(rows, runRoot);
}

// A worker that has COMPLETED A TURN, which is the causal barrier every arm
// needs. `status === 'idle'` is not one: spawn() reports idle as soon as the
// subprocess is alive and stdin is writable, and under this chroot the
// bootstrap is still executing its bind mounts and its chroot at that point
// — the recorded pid is still `/bin/sh` running as root, not the CLI.
//
// The wait is generous because it is measuring something real: every page of
// the CLI binary is faulted in through the union with attr_timeout=0,
// entry_timeout=0 and no kernel cache. See TURN_TIMEOUT_MS.
export const TURN_TIMEOUT_MS = 120_000;
export async function spawnWorker(where = 'chroot', project = 'app') {
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


// A command run INSIDE the namespace, at uid 1000, in ONE process — which is
// what makes marking observable at all. `[ -e ]` and `read` are shell
// BUILTINS, so both the marking stat and the subsequent open are made by the
// shell's own thread group; a `cat` would be a child with its own tgid and
// would answer the unmarked question instead.
export const inNs = (anchorPid, script, ...args) => sh('sudo', ['-n', 'nsenter',
  `--mount=/proc/${anchorPid}/ns/mnt`, '--',
  'setpriv', `--reuid=${process.getuid()}`, `--regid=${process.getgid()}`, '--init-groups', '--',
  '/bin/sh', '-c', script, 'sh', ...args]);

// The same, as ROOT. `default_permissions` makes the KERNEL check the caller
// against the node's own mode before the daemon is ever asked, and a
// synthetic node is 0555 root:root — so a uid-1000 probe gets EACCES from the
// kernel and never reaches the arm the daemon owns. Root passes that check,
// which is what makes the daemon's own answer observable.
export const inNsRoot = (anchorPid, script, ...args) => sh('sudo', ['-n', 'nsenter',
  `--mount=/proc/${anchorPid}/ns/mnt`, '--', '/bin/sh', '-c', script, 'sh', ...args]);

// nsenter does NOT chroot, so a probe names every path from OUTSIDE, under
// `record.root`. The union sees the suffix, which is the spelling the pins
// and the mark path are written in.
export const inside = (record, p) => path.join(record.root, p);

// THE DAEMON'S POLICY EVENT LOG, split into
// `[kind, op, path, reason, pid, tgid, comm, cmdline]`. The KIND is the first
// column and every filter in the family derives from it rather than from a
// hand-maintained list of reason strings — `self-recursion` and
// `pinned-children-truncated` are `served` rows, so a reason enumeration was
// already wrong here. The `#` header the daemon writes when it opens the log
// is dropped: it carries tabs, so it would split into a plausible-looking row.
export const eventsOf = async (instanceId) =>
  (await fs.readFile(path.join(fuseRunDir(instanceId), EVENT_LOG_NAME), 'utf8').catch(() => ''))
    .split('\n').filter(l => l !== '' && !l.startsWith('#')).map(l => l.split('\t'));
