// FOLLOWING A MIRROR ADVERTISEMENT THAT MOVED UNDER A LIVE SESSION.
//
// `composeSessionRoot`'s target check compares the manifest's mirror root
// against the live advertisement; card 2026-0273 owns the branch where the
// compose that follows the check FAILS. This file owns the branch where it
// SUCCEEDS: the image root is wiped and re-pulled at the new geometry, and the
// relaunching session's cwd, path map and transcript are MOVED to it
// (card 2026-0279).
//
// THE DISCRIMINATOR IS `offset_old === ''`, NOT THE DIRECTION. Two outcome
// classes on a three-way geometry split:
//   * class A1 — the prior offset was empty, so the old cwd survives the compose
//     and holds no config surface;
//   * class GONE — the prior offset was non-empty, so `pullSessionRoot` recreates
//     only the NEW cwd and the old one does not exist. WIDENING AND NARROWING
//     ARE IN THIS CLASS TOGETHER (T2 narrows, T3 widens).
// A sideways advertisement is not a third direction: the legal mirror roots for
// a fixed `systemPath` are its ancestor chain, and a non-containing root is
// refused 501 MIRROR_ROOT_EXCLUDES_PROJECT before the target check ever runs.
//
// 2026-0259's warn-don't-refuse is SUPERSEDED BY A THIRD ANSWER, not overturned
// into a refusal. Its premise — "rebuilding a redirect under a running CLI is
// not possible" — is true and does not apply: `_refreshSessionRoot` runs inside
// launch() with spawn() on the next line, so there is no CLI to rebuild under.
//
// TWO FIXTURE FACTS THESE TESTS DEPEND ON.
//  1. `bootServer({realProcess:true})` DELETES FAKE_CLAUDE_SCENARIO unless
//     `scenarioPath` is given, and fake-claude then exits 2 — so eventual
//     `status` proves nothing about whether a child started. Every arm here
//     passes `scenario-no-turn.json` and reads `pid` / `spawn_error` as the
//     spawn-happened signal, with `status` secondary.
//  2. RED-RUN CAVEAT: before the fix, the class-GONE arms reach `spawn()` with a
//     deleted cwd and the child never starts — and `Instance.kill()` never
//     resolves after a spawn failure (card 2026-0286), so `instances.shutdown()`
//     hangs. Confirming those baselines needs the instance dropped
//     (`instances.byId.clear()`) instead of shut down. After the fix no arm
//     reaches a spawn failure, so the ordinary teardown below is correct.
//
// SAME-MACHINE TRAP, GUARDED TWO WAYS. The reference provider IS this machine,
// so an assertion must be one a local shortcut cannot satisfy: every location
// check resolves the cc-owned IMAGE ROOT through `sessionRootPath`, independent
// of the instance, while the project tree lives under a temp prefix OUTSIDE
// PROJECTS_ROOT; and every content check is for `SENTINEL-0279`, a byte string
// written only into the project tree's CLAUDE.md on the system.

import { test, describe, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { promises as fs } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { bootServer, api, freshProjectsRoot, rmrf, seedSessionJsonl, waitFor } from './helpers.mjs';
import { seedRepo } from './remoteSystem.mjs';
import { mkdtemp } from './tmpRegistry.mjs';
import { adoptProject } from '../src/projects.ts';
import { addSystem } from '../src/appSettings.ts';
import { disposeSystemHandles } from '../src/systems/registry.ts';
import { sessionRootPath } from '../src/systems/sessionRoot.ts';
import { sessionFilePath } from '../src/projects.ts';

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
  async function fixture({ sub, mirror }) {
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
      launch: ['node', FIXTURE, '--mirror-file', mirrorFile, '--pid-file', pidFile],
    });
    assert.equal((await adoptProject(project, projPath, { system: id })).ok, true);

    const r = await api(baseUrl, 'POST', '/api/instances', { project, mode: 'bypassPermissions' });
    assert.equal(r.status, 201, JSON.stringify(r.body));
    const inst = instances.get(r.body.id);
    await waitFor(() => inst.status === 'idle');
    // Resolved from the module, NOT from the instance: a cwd computed against
    // the project instead of the image root would give a different answer here
    // rather than agreeing by accident.
    const imageRoot = await fs.realpath(sessionRootPath(id, project, null));
    return { id, project, box, projPath, mirrorFile, pidFile, inst, imageRoot };
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

  const exists = (p) => fs.stat(p).then(() => true, () => false);
  const geometryLines = (lines) => (lines ?? []).filter(l => l.includes('now mirrors this project at'));

  // Everything the three moving arms assert in common: the session really moved,
  // its config surface is there, its transcript came with it, and a worker
  // actually started.
  async function assertMoved({ inst, r, oldCwd, newCwd, backingId }) {
    assert.equal(r.res.status, 200, JSON.stringify(r.res.body));
    assert.equal(inst.cwd, newCwd, 'the session did not move to the new geometry');
    assert.match(await fs.readFile(path.join(newCwd, 'CLAUDE.md'), 'utf8'), new RegExp(SENTINEL),
      'the config surface at the new cwd is not this project’s');
    assert.equal(await exists(sessionFilePath(newCwd, backingId)), true, 'the transcript did not come with it');
    assert.equal(await exists(sessionFilePath(oldCwd, backingId)), false, 'the transcript was copied, not moved');
    assert.deepEqual(r.spawnErrors, [], `a child failed to spawn: ${r.spawnErrors.join(', ')}`);
    assert.notEqual(inst.pid, null, 'no worker was started');
    assert.equal(r.replayed, true, 'the conversation was not replayed into the new location');
    assert.equal(geometryLines(r.lines).length, 1,
      `expected exactly one geometry line, got ${JSON.stringify(r.lines)}`);
  }

  // PINS class A1 — a WIDENING from an empty offset, where the old cwd survives
  // the compose holding no config surface. The session, its config surface and
  // its whole transcript LINEAGE (both segments) arrive at the new geometry and a
  // worker starts there.
  //
  // NOT CLAIMING that the real `claude` binary resumes the conversation — the
  // fake engine stands in, and what is pinned is that every input the CLI reads
  // is now at its cwd. NOT CLAIMING anything about the far-side shell (it runs at
  // the project path, which did not move) or about peer sessions (T4).
  test('a widening move carries the session, its config surface and its transcript to the new geometry', async () => {
    const f = await fixture({ sub: 'proj', mirror: '' });
    const oldCwd = f.inst.cwd;
    assert.equal(oldCwd, f.imageRoot, 'the first compose is the project-anchored one (offset "")');
    const backingId = f.inst.backingSessionId;
    // A SECOND SEGMENT, so the lineage — not just the current backing id — is
    // what has to move. A renewed session really does reach two.
    const older = '9746ee72-0000-4000-8000-00000000cccc';
    await seedSessionJsonl(claudeProjectsRoot, oldCwd, backingId);
    await seedSessionJsonl(claudeProjectsRoot, oldCwd, older);
    f.inst._segments = [older, backingId];

    await readvertise(f, '.');
    const r = await relaunch(f.inst);

    const newCwd = path.join(f.imageRoot, 'proj');
    await assertMoved({ inst: f.inst, r, oldCwd, newCwd, backingId });
    assert.equal(await exists(sessionFilePath(newCwd, older)), true, 'the older segment was left behind');
    assert.equal(await exists(sessionFilePath(oldCwd, older)), false, 'the older segment was copied, not moved');
  });

  // PINS class GONE by NARROWING: the old cwd no longer exists after the compose,
  // and no worker is ever started in a directory that is gone. Before this card
  // the relaunch reached `spawn` there and failed ENOENT against the CLI
  // BINARY's own path — a worker that never started, blamed on node.
  //
  // NOT CLAIMING that card 2026-0286's kill hang is fixed: this test simply never
  // reaches a spawn failure any more.
  test('a narrowing move carries it too, and no worker is started in a directory that is gone', async () => {
    const f = await fixture({ sub: 'proj', mirror: '.' });
    const oldCwd = f.inst.cwd;
    assert.equal(oldCwd, path.join(f.imageRoot, 'proj'), 'the first compose put the project one level in');
    const backingId = f.inst.backingSessionId;
    await seedSessionJsonl(claudeProjectsRoot, oldCwd, backingId);

    await readvertise(f, '');
    const r = await relaunch(f.inst);

    await assertMoved({ inst: f.inst, r, oldCwd, newCwd: f.imageRoot, backingId });
    assert.equal(await exists(oldCwd), false, 'the old cwd really was gone (class GONE, not A1)');
  });

  // PINS that the DIRECTION is not the discriminator: this is a WIDENING whose
  // old offset was non-empty, so it lands in class GONE alongside the narrowing
  // above. The card's "widening leaves a config-less cwd, narrowing leaves none"
  // framing holds only for a widening FROM AN EMPTY OFFSET.
  //
  // NOT CLAIMING that B2 (narrowing between two non-empty offsets) is separately
  // covered — it takes the identical `offset_old !== ''` path this arm exercises.
  test('the direction is not the discriminator: a widening whose old cwd is also gone', async () => {
    const f = await fixture({ sub: path.join('nest', 'proj'), mirror: 'nest' });
    const oldCwd = f.inst.cwd;
    assert.equal(oldCwd, path.join(f.imageRoot, 'proj'));
    const backingId = f.inst.backingSessionId;
    await seedSessionJsonl(claudeProjectsRoot, oldCwd, backingId);

    await readvertise(f, '.');
    const r = await relaunch(f.inst);

    await assertMoved({ inst: f.inst, r, oldCwd, newCwd: path.join(f.imageRoot, 'nest', 'proj'), backingId });
    assert.equal(await exists(oldCwd), false, 'a WIDENING left no old cwd behind');
  });

  // CONTROL. PINS that only the RELAUNCHING session moves: the image root is
  // shared per (system, project, worktree), so a peer live session keeps its old
  // working directory — and this card's original defect — until its OWN next
  // relaunch, at which point both converge on one cwd. Convergence is
  // per-relaunch, not instant, which is what the emitted line's last clause says.
  //
  // This is also the arm that stops the relocation becoming a directory rename:
  // a whole-encoded-directory move would strand the peer to un-strand A.
  //
  // NOT CLAIMING that B is usable in the meantime — it is not, and that is the
  // point.
  test('only the relaunching session moves; a peer converges at its own relaunch', async () => {
    const f = await fixture({ sub: 'proj', mirror: '' });
    const oldCwd = f.inst.cwd;
    const rb = await api(baseUrl, 'POST', '/api/instances', { project: f.project, mode: 'bypassPermissions' });
    assert.equal(rb.status, 201, JSON.stringify(rb.body));
    const b = instances.get(rb.body.id);
    await waitFor(() => b.status === 'idle');
    assert.equal(b.cwd, oldCwd, 'both sessions started at the same cwd');

    const aId = f.inst.backingSessionId, bId = b.backingSessionId;
    await seedSessionJsonl(claudeProjectsRoot, oldCwd, aId);
    await seedSessionJsonl(claudeProjectsRoot, oldCwd, bId);

    await readvertise(f, '.');
    const newCwd = path.join(f.imageRoot, 'proj');
    const a = await relaunch(f.inst);
    await assertMoved({ inst: f.inst, r: a, oldCwd, newCwd, backingId: aId });

    // THE PEER, left exactly where it was.
    assert.equal(b.cwd, oldCwd, 'the peer was moved without relaunching');
    assert.equal(await exists(sessionFilePath(oldCwd, bId)), true, 'the peer’s transcript was dragged along');
    assert.equal(await exists(sessionFilePath(newCwd, bId)), false, 'the peer’s transcript was dragged along');
    assert.equal(await exists(path.join(oldCwd, 'CLAUDE.md')), false,
      'the peer is in this card’s original defect: a cwd with no config surface');

    // …and converges at its own next relaunch.
    const second = await relaunch(b);
    await assertMoved({ inst: b, r: second, oldCwd, newCwd, backingId: bId });
    assert.equal(f.inst.cwd, b.cwd, 'both sessions are at one cwd again');
  });

  // PINS that a relocation that CANNOT complete refuses the relaunch and leaves
  // the instance untouched: no worker is started at either location, `this.cwd`
  // is unchanged, and the transcript is still whole at the old cwd. The order —
  // relocate, THEN assign cwd — is what makes that true.
  //
  // NOT CLAIMING which errno a real-world failure carries. A directory planted
  // at the destination gives EISDIR (even when empty, so it never clears on a
  // retry); the invariant is that a non-ENOENT failure refuses rather than
  // half-moving.
  test('a relocation that cannot complete refuses the relaunch and leaves the session untouched', async () => {
    const f = await fixture({ sub: 'proj', mirror: '' });
    const oldCwd = f.inst.cwd;
    const backingId = f.inst.backingSessionId;
    await seedSessionJsonl(claudeProjectsRoot, oldCwd, backingId);

    await readvertise(f, '.');
    const newCwd = path.join(f.imageRoot, 'proj');
    await fs.mkdir(sessionFilePath(newCwd, backingId), { recursive: true });

    // On the LAUNCH call, because the express error handler serialises only
    // `error` — the refusal CODE is on the thrown error, which is where card
    // 2026-0273's own refusal test reads its own.
    await f.inst.kill({ graceMs: 200 });
    await assert.rejects(f.inst.launch({ resume: backingId }), (e) => {
      assert.equal(e.statusCode, 502, e.message);
      assert.equal(e.code, 'SESSION_MOVE_FAILED', e.message);
      assert.match(e.message, /Nothing was moved/);
      return true;
    });
    assert.equal(f.inst.proc, null, 'a worker was started despite the refusal');
    assert.equal(f.inst.cwd, oldCwd, 'the cwd moved even though the relocation did not');
    assert.equal(await exists(sessionFilePath(oldCwd, backingId)), true, 'the transcript did not survive the refusal');

    // And it reaches the operator as a 502 rather than being swallowed by the
    // compose's warn-don't-refuse catch, which this refusal sits outside.
    const res = await api(baseUrl, 'POST', `/api/instances/${f.inst.id}/respawn`);
    assert.equal(res.status, 502, JSON.stringify(res.body));
    assert.match(res.body.error, /now mirrors this project at/);
  });

  // PINS THAT THE LINE IS TRUE FOR A SESSION THAT HAS NO TRANSCRIPT. A worker
  // killed before its first turn — and every fresh spawn until one lands — has
  // nothing at either cwd, `loadHistory` returns silently on ENOENT, and
  // `history_replayed` is never emitted. The move still happens and is still
  // announced, so the announcement must not assert a transcript nobody looked
  // for: that is the same rule as the line's "AND IT NAMES NO FILE", one clause
  // over.
  //
  // NOT CLAIMING that a transcript-less move is different in any other respect —
  // it is the same code path, and the relocation is simply a no-op. NOT CLAIMING
  // that the destination encoded directory stays absent here; the primitive test
  // owns that.
  test('a move announces truthfully for a session that has no transcript at all', async () => {
    const f = await fixture({ sub: 'proj', mirror: '' });
    const oldCwd = f.inst.cwd;
    const backingId = f.inst.backingSessionId;
    // Deliberately NO seedSessionJsonl: the fake engine writes no transcript, so
    // this is the state a session is in until its first turn persists one.

    await readvertise(f, '.');
    const r = await relaunch(f.inst, { awaitReplay: false });
    const newCwd = path.join(f.imageRoot, 'proj');

    // The move happened, and there was genuinely nothing to carry.
    assert.equal(r.res.status, 200, JSON.stringify(r.res.body));
    assert.equal(f.inst.cwd, newCwd, 'the session did not move');
    assert.equal(await exists(sessionFilePath(oldCwd, backingId)), false);
    assert.equal(await exists(sessionFilePath(newCwd, backingId)), false);
    assert.equal(r.replayed, false, 'there was no history, so none can have been replayed');
    assert.notEqual(f.inst.pid, null, 'no worker was started');
    assert.deepEqual(r.spawnErrors, [], `a child failed to spawn: ${r.spawnErrors.join(', ')}`);

    // And the line says so — it hedges the transcript and the replay rather than
    // asserting both unconditionally.
    const [line] = geometryLines(r.lines);
    assert.ok(line, 'the move was not announced');
    assert.match(line, /any transcript it had moved with it/, line);
    assert.match(line, /whatever history it had is replayed/, line);
  });

  // CONTROL. PINS that the fix does not fire on every relaunch: with no provider
  // restart the compose returns the same cwd, nothing is relocated, no line is
  // emitted, and the worker comes back where it was.
  //
  // NOT CLAIMING that no OTHER line is emitted — skipped entries and inert-exclude
  // notes share this stream and are their own tests.
  test('a relaunch at an unchanged geometry moves nothing', async () => {
    const f = await fixture({ sub: 'proj', mirror: '' });
    const oldCwd = f.inst.cwd;
    const backingId = f.inst.backingSessionId;
    await seedSessionJsonl(claudeProjectsRoot, oldCwd, backingId);

    const r = await relaunch(f.inst);

    assert.equal(r.res.status, 200, JSON.stringify(r.res.body));
    assert.equal(f.inst.cwd, oldCwd, 'an unchanged geometry moved the session');
    assert.deepEqual(geometryLines(r.lines), [], 'an unchanged relaunch spoke');
    assert.equal(await exists(sessionFilePath(oldCwd, backingId)), true, 'the transcript was relocated for nothing');
    assert.notEqual(f.inst.pid, null, 'no worker was started');
    assert.deepEqual(r.spawnErrors, [], `a child failed to spawn: ${r.spawnErrors.join(', ')}`);
  });
});
