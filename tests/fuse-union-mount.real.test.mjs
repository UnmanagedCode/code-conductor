// ══ THE MOUNT'S OWN ARMS ══════════════════════════════════════════════════
//
// R1-R7. These need a real mount, a real chroot and a
// real second process in the namespace, so they cannot be deterministic. The
// policy split does not retire them: it moved what CAN be proven without a
// mount into `tests/fuse-union-policy.test.mjs`.
//
// WHICH OF THE REMAINDER LANDS HERE. `policy.h`'s "deliberately not provable
// here" table names three rows; this file carries TWO of them — TIER RESOLUTION
// (that `pt_getattr`/`pt_opendir` call `resolve_class()`, and that `mount
// --bind` succeeds onto a synthetic node) and the FRAME CODEC (the socket
// transport, its blocking behaviour under libfuse's multithreaded loop, and EIO
// on a dead cc). The third, MARKING POLICY, is R12 and R16 in
// `tests/fuse-union-marking.real.test.mjs`.
//
// Skipped by default — opt in with `RUN_FUSE_LIFECYCLE=1`.
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

import { describe, test } from 'node:test';
import assert from 'node:assert/strict';
import { promises as fs } from 'node:fs';
import path from 'node:path';
import { waitFor } from './helpers.mjs';
import { EVENT_LOG_NAME, fuseRunDir } from '../src/systems/fuse/plan.ts';
import {
  ENABLED, setupFuseGate, spawnWorker, snapshot, readRecord, assertNoResidue,
  mountsOf, alive, sh, inNs, inNsRoot, inside, eventsOf,
} from './fuseGateCase.mjs';

// The handles every test body below reads. Bound inside the harness's own
// `before`, which is the only place they are guaranteed booted — see
// setupFuseGate() in ./fuseGateCase.mjs.
let instances, box, runRoot, fakeRemote;

describe('a worker inside a FUSE-union chroot: the mount’s own arms', { skip: !ENABLED }, () => {
  setupFuseGate('union-mount', c => { ({ instances, box, runRoot, fakeRemote } = c); });

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
      // pins (`ETC_PINS` and `LOADER_OBJECTS` both seed `/usr/...`), so it is
      // `T_SYNTH` to this caller.
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
});
