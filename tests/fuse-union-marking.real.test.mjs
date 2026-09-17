// ══ WHO IS MARKED, AND WHEN ═══════════════════════════════════════════════
//
// R12, R13w, R14L, R16 — the CLI's own marking event and the bootstrap chain
// that precedes it, the unmarked chain at a wide `mirrorRoot`, a backend
// launcher's host-pinned handoff, and a symlinked launcher marking on the LINK
// before its realpath is walked marked.
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
import { api, waitFor } from './helpers.mjs';
import { mkdtemp } from './tmpRegistry.mjs';
import { fuseRunDir } from '../src/systems/fuse/plan.ts';
import { resolveTierEntry } from '../src/systems/fuse/tierTable.ts';
import {
  ENABLED, setupFuseGate, spawnWorker, snapshot, readRecord, assertNoResidue,
  sh, inNs, inside, eventsOf, HERE, TURN_TIMEOUT_MS,
} from './fuseGateCase.mjs';

// The handles every test body below reads. Bound inside the harness's own
// `before`, which is the only place they are guaranteed booted — see
// setupFuseGate() in ./fuseGateCase.mjs.
let baseUrl, instances, box, runRoot, fakeRemote;

describe('a worker inside a FUSE-union chroot: marking and the bootstrap chain', { skip: !ENABLED }, () => {
  setupFuseGate('union-marking', c => { ({ baseUrl, instances, box, runRoot, fakeRemote } = c); });

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
  // `CC_UNION_TRACE`, which no channel carries into the launch: cc hands sudo
  // no environment at all, so the daemon's is composed from the plan file.
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

  // ── R13w ─────────────────────────────────────────────────────────────────
  // THE BOOTSTRAP CHAIN IS UNMARKED AND IS SERVED THE ORCHESTRATOR, AT THE
  // GEOMETRY WHERE THAT IS THE DIFFERENCE BETWEEN A LAUNCH AND A DEATH.
  //
  // `mirrorRoot: '/'` is the geometry that decides it. A mark fired anywhere
  // ahead of the CLI puts the chroot'd shell, `setpriv` and the backend launch
  // command in `VIEW_CLI`, where every unpinned path they touch is `project`
  // tier with no host fallback — measured as `deny getattr
  // /usr/local/bin/<launcher> remote-absent comm=setpriv`, and a launch that
  // dies `setpriv: failed to execute`.
  //
  // WHAT IT PINS, and the second is the one this arm exists for:
  //
  //   1. AN UNMARKED PROBE READS THE ORCHESTRATOR'S OWN BYTES at `/bin/sh`, at
  //      the `setpriv` binary and at a `/usr/bin` entry, with no `deny` row for
  //      any of them.
  //   2. NO MARKED OP NAMES A PATH UNDER `/usr/bin` AT ALL. That is the claim
  //      licensing the bootstrap chain to carry no pin: a pin exists only for a
  //      path a MARKED caller reads. If the CLI ever grows a marked read under
  //      `/usr/bin`, this dies and those pins are load-bearing again.
  //   3. AND THE CONTRAST, which is (1)'s non-vacuity: the SAME three paths to
  //      a MARKED caller are NOT the orchestrator's. Nothing pins them, so at
  //      `mirrorRoot: '/'` they resolve `project` — the remote tier, which has
  //      no host fallback and (in this fixture's mirror, directories only)
  //      holds no such file. Without this, (1) would be satisfied by a table
  //      that served every caller the host, and the view would be proving
  //      nothing.
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
        'A MARKED CALLER READ A PATH UNDER /usr/bin. The bootstrap chain carrying no pin is '
        + 'justified by exactly this not happening — a pin there is load-bearing again, and its '
        + 'absence puts this path in the remote tier for the CLI');

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

      // (3) THE CONTRAST, LAST, AND IT IS THE INVERSE OF (1). Nothing pins
      // these three paths, so a MARKED caller resolves them in the REMOTE tier
      // at `mirrorRoot: '/'` — no host fallback, and this fixture's mirror
      // carries directories only — and `cmp` cannot read the union spelling at
      // all. That the two probes DISAGREE is what makes (1) a statement about
      // the VIEW rather than about a table that happens to serve everyone the
      // host.
      //
      // MARK-THEN-`exec`: `[ -e ]` is a shell BUILTIN, so the marking getattr
      // is the shell's own thread group, and `exec` keeps the tgid the daemon
      // validates. The `cmp` binary itself is named at its HOST path, outside
      // the union, so the probe's own image is never the thing under test.
      for (const bin of probes) {
        const r = await inNs(record.anchorPid, '[ -e "$1" ]; exec /usr/bin/cmp -s "$2" "$3"',
          inside(record, inst._fuse.plan.markPath), inside(record, bin), bin);
        assert.equal(r.ok, false,
          `A MARKED CALLER WAS SERVED THE ORCHESTRATOR'S OWN ${bin} at a wide mirror root. `
          + `Something pins it host again — which would make (2) above the only thing standing `
          + `between the bootstrap chain and a reinstated pin set: ${r.stdout} ${r.stderr}`);
      }
      // AND THE DAEMON SAID SO, by name: the refusal is the tier answering, not
      // the probe failing for some unrelated reason. Re-read, because `events`
      // above was snapshotted before these probes ran.
      const afterProbes = await eventsOf(inst.id);
      const markedDenied = new Set(afterProbes.filter(r => r[0] === 'deny').map(r => r[2]));
      for (const bin of probes)
        assert.ok(markedDenied.has(bin),
          `the marked probe of ${bin} produced no deny row, so its failure is unattributed: `
          + JSON.stringify([...markedDenied]));

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
  // exercised nowhere else in the family.
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
});
