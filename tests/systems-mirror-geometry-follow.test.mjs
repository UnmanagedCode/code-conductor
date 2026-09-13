// A MIRROR ADVERTISEMENT THAT MOVES UNDER A LIVE SESSION IS SESSION-FATAL.
//
// There is no follow machinery: nothing wipes a local image root, re-pulls at
// the new geometry, or moves the session's cwd, its path map or its transcript.
// Under the FUSE-union geometry there is no local image to move — a session's
// cwd is the project's real path on its system, which does not move, and what
// an advertisement changes is the boundary of the union's remote tier.
//
// So a session cannot follow, and the honest answer is a named refusal on the
// next relaunch: continuing at a geometry it did not start under is the silent
// wrong-machine outcome this subsystem exists to prevent.
//
// FIXTURE FACTS THESE TESTS DEPEND ON.
//  1. `bootServer({realProcess:true})` DELETES FAKE_CLAUDE_SCENARIO unless
//     `scenarioPath` is given, and fake-claude then exits 2 — so eventual
//     `status` proves nothing about whether a child started. Every arm here
//     passes `scenario-no-turn.json` and reads `pid` as the spawn signal.
//  2. Only a NEW CONNECTION GENERATION can move the advertisement — cc memoises
//     it on handshake identity, so a live session re-asks nothing until its
//     provider restarts. `readvertise` below is what produces one.

import { test, describe, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { promises as fs } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { bootServer, api, freshProjectsRoot, rmrf, waitFor } from './helpers.mjs';
import { seedRepo } from './remoteSystem.mjs';
import { mkdtemp } from './tmpRegistry.mjs';
import { adoptProject } from '../src/projects.ts';
import { addSystem } from '../src/appSettings.ts';
import { disposeSystemHandles } from '../src/systems/registry.ts';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const FIXTURE = path.join(HERE, 'fixtures', 'mirrorFixtureProvider.mjs');
// A child that stays up. See fixture fact 1 in the header.
const SCENARIO = path.join(HERE, 'fixtures', 'scenario-no-turn.json');
const SENTINEL = 'SENTINEL-0279';

describe('a mirror advertisement that moves under a live session', () => {
  let ctx, baseUrl, instances, home, claudeProjectsRoot;
  let n = 0;

  before(async () => {
    ctx = await bootServer({ realProcess: true, scenarioPath: SCENARIO });
    ({ baseUrl, instances } = ctx);
    ({ home, claudeProjectsRoot } = await freshProjectsRoot());
  });

  after(async () => {
    if (ctx) await ctx.instances.shutdown();
    disposeSystemHandles();
    if (home) await rmrf(home);
    if (ctx) await ctx.close();
  });

  // One fixture per test: its own system id, its own project name, its own box
  // outside PROJECTS_ROOT. `sub` is where the project sits inside the box, so an
  // arm can put it one level down (A1/B1) or two (A2).
  //
  // `mirror` is the FIRST advertisement — empty string means "advertise
  // nothing", which composes the project-anchored geometry (offset '').
  //
  // `exclude` is a list of paths RELATIVE TO THE BOX, advertised as excludes.
  // It exists for the `fail`-pin arm at the end of this file: an exclude inside
  // the mirror root is the ONLY thing that renders a `fail` line, and this is
  // the only fixture in `npm test` that mounts for real.
  async function fixture({ sub, mirror, exclude = [] }) {
    const id = `movable${++n}`;
    const project = `app${n}`;
    const box = await mkdtemp('cc-0279-');
    const projPath = path.join(box, sub);
    await seedRepo(projPath);
    // THE SENTINEL, on the system side only.
    await fs.writeFile(path.join(projPath, 'CLAUDE.md'), `# ${SENTINEL}\n`);

    const mirrorFile = path.join(box, '.mirror');
    const pidFile = path.join(box, '.pid');
    await fs.writeFile(mirrorFile, mirror === '' ? '' : path.join(box, mirror));
    await addSystem({
      id, label: id,
      launch: ['node', FIXTURE, '--mirror-file', mirrorFile, '--pid-file', pidFile,
        ...exclude.flatMap((rel) => ['--advertise-exclude', path.join(box, rel)])],
    });
    assert.equal((await adoptProject(project, projPath, { system: id })).ok, true);

    const r = await api(baseUrl, 'POST', '/api/instances', { project, mode: 'bypassPermissions' });
    assert.equal(r.status, 201, JSON.stringify(r.body));
    const inst = instances.get(r.body.id);
    await waitFor(() => inst.status === 'idle');
    return { id, project, box, projPath, mirrorFile, pidFile, inst };
  }

  // End the provider's connection generation and start a new one that answers
  // differently. Only a new generation can move the geometry — cc memoises
  // `describeRemote` on handshake identity, so a live session re-asks nothing
  // until its provider restarts.
  async function readvertise(f, mirror) {
    await fs.writeFile(f.mirrorFile, mirror === '' ? '' : path.join(f.box, mirror));
    const system = f.inst._redirectPlacement.system;
    const generation = system.handshake;
    const gone = Number(await fs.readFile(f.pidFile, 'utf8'));
    // The fixture IS the provider — one process, no child to orphan.
    process.kill(gone, 'SIGKILL');
    await waitFor(() => { try { process.kill(gone, 0); return false; } catch { return true; } });
    await waitFor(() => system.handshake === null);
    await system.connect();
    assert.notEqual(system.handshake, generation, 'a new connection generation really began');
  }

  // Kill the worker, then relaunch it through the production respawn path. Every
  // spawn_error the relaunch emits is captured, because that — not `status` — is
  // what says whether a child started.
  // `awaitReplay:false` for the arm that has NO transcript: `loadHistory` returns
  // silently on ENOENT and `history_replayed` is inside a `replayedCount > 0`
  // guard, so there is nothing to wait for and waiting would just time out.
  async function relaunch(inst, { awaitReplay = true } = {}) {
    await inst.kill({ graceMs: 200 });
    const out = { spawnErrors: [], lines: [], replayed: false };
    const real = inst._emitUi.bind(inst);
    inst._emitUi = (ev) => {
      if (ev.kind === 'system' && ev.subtype === 'spawn_error') out.spawnErrors.push(ev.data.message);
      if (ev.kind === 'system' && ev.subtype === 'history_replayed') out.replayed = true;
      if (ev.kind === 'system' && ev.subtype === 'stderr') out.lines.push(ev.data.line);
      return real(ev);
    };
    try {
      out.res = await api(baseUrl, 'POST', `/api/instances/${inst.id}/respawn`);
      // `loadHistory` runs in spawn()'s own async tail, so the replay can land
      // AFTER the response — waiting for it here keeps the patch installed long
      // enough to see it rather than racing it.
      // Each wait is gated on the response too: a REFUSED relaunch leaves both
      // `replayed` false and `pid` null forever, so an ungated wait would spin
      // its full timeout and throw instead of handing the caller back the 502 it
      // asked about.
      if (out.res.status !== 200) { /* a refusal has nothing to wait for */ }
      else if (awaitReplay) await waitFor(() => out.replayed);
      else await waitFor(() => inst.pid !== null);
    } finally { inst._emitUi = real; }
    return out;
  }

  // ── the arms ────────────────────────────────────────────────────────

  // PINS: a moved advertisement REFUSES the relaunch, by name, and does not
  // half-apply. The session keeps the cwd it started with — a session that
  // continued at a changed remote-tier boundary would be addressing a different
  // slice of the system than the one it was created against.
  test('a widened advertisement makes the next relaunch refuse, by name', async () => {
    const f = await fixture({ sub: 'proj', mirror: '' });
    const before = f.inst.cwd;
    assert.equal(before, f.projPath, "the session started at the project's own path");

    // '.' joins to the box itself: the provider now advertises a root WIDER
    // than the project. `readvertise` restarts it, which is the only way a live
    // session ever sees a different answer.
    await readvertise(f, '.');

    const r = await relaunch(f.inst, { awaitReplay: false });
    assert.equal(r.res.status, 501, JSON.stringify(r.res.body));
    // The MESSAGE, not the code: the REST error shape carries `error` and drops
    // `code` for this class, and the message is what an operator reads anyway.
    // The manager entry point is asserted on the code below.
    assert.match(r.res.body.error, /changed its mirror advertisement/);
    assert.match(r.res.body.error, new RegExp(f.box.replace(/[.*+?^$()|[\]\\]/g, '\\$&')),
      'the refusal names the geometry it moved to');
    assert.equal(f.inst.cwd, before, 'the session moved anyway');
  });

  // PINS: an UNCHANGED advertisement relaunches normally. The control that makes
  // the refusal above about the change and not about relaunching at all.
  test('a relaunch at an unchanged advertisement is not refused', async () => {
    const f = await fixture({ sub: 'proj', mirror: '' });
    await readvertise(f, '');
    const r = await relaunch(f.inst, { awaitReplay: false });
    assert.equal(r.res.status, 200, JSON.stringify(r.res.body));
    assert.equal(f.inst.cwd, f.projPath);
    assert.notEqual(f.inst.pid, null, 'a worker really started');
  });

  // PINS: a NARROWED advertisement refuses too — the direction is not the
  // discriminator, the change is.
  test('a narrowed advertisement refuses on the same code', async () => {
    // Created under the WIDE root, then narrowed back to the project itself.
    const f = await fixture({ sub: 'a/proj', mirror: '.' });
    await readvertise(f, '');
    // AT THE MANAGER ENTRY POINT, which is what the REST route wraps and what
    // every other relaunch caller (rewind, auto-resume, resume-after-restart)
    // reaches directly — and where the refusal keeps its machine-readable code.
    await f.inst.kill({ graceMs: 200 });
    await assert.rejects(() => instances.respawn(f.inst.id),
      (e) => e.code === 'MIRROR_ADVERTISEMENT_CHANGED' && e.statusCode === 501);
    assert.equal(f.inst.cwd, f.projPath, 'the session moved anyway');
  });

  // ── the `fail` pin arm ──────────────────────────────────────────────
  //
  // PINS THAT THE DAEMON PARSES A `fail` PIN AT ALL, and it lands here because
  // this is the ONLY fixture in `npm test` that mounts for real.
  //
  // WHY IT EXISTS: a mutation round removed `pins_load`'s `fail` arm on its own
  // and the whole suite stayed GREEN — 3 pass, 0 fail. `bind` needs no help,
  // because bind lines render on every mount; `fail` renders only when a
  // provider advertises an exclude INSIDE its mirror root, and no arm above
  // advertises one. So the arm cc added specifically to stop a deployment dying
  // with `unknown kind 'fail'` was itself deletable with a green suite. Fixture
  // GEOMETRY was the gap, not a missing assertion.
  //
  // WHAT IT ASSERTS, and the boundary is deliberate: that a `fail` line really
  // rendered (a cc-side artifact fact), and that THE MOUNT COMES UP. NOTHING
  // about what the daemon then does with that pin. An expectation about routing
  // here would outlive the change that should kill it, so the boundary is held
  // at the artifact and the mount: what `route()` does with a `fail` entry is
  // pinned by `tests/fuse-union-policy.test.mjs`, against the daemon's own
  // source.
  //
  // GEOMETRY: mirror root `<box>/nest`, project `<box>/nest/app`, exclude
  // `<box>/nest/other` — inside the root (so it is active, not inert) and
  // outside the project (so it is not MIRROR_EXCLUDE_COVERS_PROJECT).
  test('a `fail` pin from an advertised exclude still mounts', async () => {
    const f = await fixture({ sub: 'nest/app', mirror: 'nest', exclude: ['nest/other'] });
    const excluded = path.join(f.box, 'nest', 'other');

    // The advertisement really carried it, and cc really kept it active —
    // without this the arm could pass having rendered no `fail` line at all,
    // which is the state that let the mutant survive.
    assert.deepEqual(f.inst._mirrorScope.exclude, [excluded]);
    const rules = f.inst._fuse.plan.pinsText.split('\n').filter((l) => l && !l.startsWith('#'));
    assert.ok(rules.includes(`fail\t${excluded}`),
      `no fail line was rendered, so the daemon never parsed one: ${rules.join(' | ')}`);
    // …and bind lines are there too, so this arm covers both new kinds on one
    // real mount rather than trading one for the other.
    for (const b of ['/proc', '/sys', '/dev']) {
      assert.ok(rules.includes(`bind\t${b}`), `${b} lost its bind line`);
    }

    // THE CLAIM: the daemon accepted the file and the union came up. `fixture`
    // has already asserted the 201 and waited for `idle`; the mount record is
    // the direct evidence, and a parse refusal would have died before it.
    assert.notEqual(f.inst.pid, null, 'no worker started');
    assert.equal(f.inst._fuse.record?.stage, 'mounted',
      'the union never reached the mounted handshake');

    // AND WHAT THE EXCLUSION ACTUALLY WITHHOLDS, now that H5 has landed and
    // this is no longer an expectation that would outlive the change.
    //
    // cc must not SHAPE an excluded child into the mirror. Its size, mode and
    // mtime are exactly what the exclusion holds back, and a stub would put all
    // three on this machine and the name into the parent's listing — `ls` would
    // show it and `cat` would answer -ENOENT, one caller and two answers.
    // Reached as a CHILD of a directory that IS served, which is the path the
    // per-path refusal cannot cover.
    await fs.mkdir(excluded, { recursive: true });
    await fs.writeFile(path.join(excluded, 'secret.txt'), 'EXCLUDED-BYTES');
    await fs.writeFile(path.join(f.box, 'nest', 'ordinary.txt'), 'fine');

    const mirror = f.inst._fuse.plan.mirror;
    // Drive the LIST through the control server the session is already running,
    // at the mirror root — the same frame `opendir` sends.
    const { encodeRequest, CCU_OP } = await import('../src/systems/fuse/control.ts');
    const net = await import('node:net');
    const sock = net.connect(f.inst._fuse.plan.controlSock);
    await new Promise((r, j) => { sock.once('connect', r); sock.once('error', j); });
    try {
      const reply = new Promise((r) => sock.once('data', r));
      sock.write(encodeRequest(CCU_OP.LIST, 0, path.join(f.box, 'nest')));
      await reply;
    } finally { sock.destroy(); }

    const names = await fs.readdir(path.join(mirror, f.box, 'nest'));
    assert.ok(names.includes('ordinary.txt'), `the served sibling is missing: ${names.join(',')}`);
    assert.ok(!names.includes('other'),
      `the excluded name and its metadata reached the mirror: ${names.join(',')}`);
  });
});
