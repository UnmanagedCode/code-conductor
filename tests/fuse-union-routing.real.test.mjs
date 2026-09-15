// ══ WHERE A PATH RESOLVES FOR AN UNMARKED CALLER ══════════════════════════
//
// R8, R15, R9, R10, R11, R13, R14 — the spawn-time chdir, the cwd-chain
// traversal floor and its scope, an atomic rename, a push that cannot land,
// the host substitution, and the wide `mirrorRoot`. Declaration order is
// load-bearing here: R8 seeds host state R9 must not inherit, and R15 runs
// before R14 because it is R15's fixture surviving into R14 that would matter.
//
// Skipped by default — opt in with `RUN_FUSE_LIFECYCLE=1`.
//
//   RUN_FUSE_LIFECYCLE=1 node tests/run.mjs tests/fuse-*.real.test.mjs
//
// One of the four tests/fuse-*.real.test.mjs files. The dependency preflight,
// the server, the three systems, the mirror scaffold, the shared observation
// helpers and the family-wide rules (PID DISCIPLINE, the before/after delta)
// live in ./fuseGateCase.mjs, which lists the family.

import { describe, test } from 'node:test';
import assert from 'node:assert/strict';
import { promises as fs, readFileSync } from 'node:fs';
import path from 'node:path';
import { waitFor } from './helpers.mjs';
import { mkdtemp } from './tmpRegistry.mjs';
import { fuseRunDir } from '../src/systems/fuse/plan.ts';
import { resolveTierEntry } from '../src/systems/fuse/tierTable.ts';
import {
  ENABLED, setupFuseGate, spawnWorker, snapshot, readRecord, assertNoResidue,
  mountsOf, sh, ancestorsOf, inNs, inside, eventsOf,
} from './fuseGateCase.mjs';

// The handles every test body below reads. Bound inside the harness's own
// `before`, which is the only place they are guaranteed booted — see
// setupFuseGate() in ./fuseGateCase.mjs.
let instances, box, runRoot, fakeRemote;

describe('a worker inside a FUSE-union chroot: unmarked path resolution', { skip: !ENABLED }, () => {
  setupFuseGate('union-routing', c => { ({ instances, box, runRoot, fakeRemote } = c); });

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
  // This is one of the family's three wide-root arms — the others are R13w and
  // R14L in tests/fuse-union-marking.real.test.mjs; every arm outside that group
  // runs `mirrorRoot` = the project path. There was
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
});
