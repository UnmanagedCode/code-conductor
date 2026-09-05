// THE GEOMETRY MOVING UNDER A LIVE SESSION — the announcement, and its prose.
//
// An instance's cwd and its redirect's path map are both fixed at create. A
// provider that changes its mirror advertisement afterwards therefore has the
// session root re-pulled somewhere the session would not look — the config
// surface is ABSENT at the cwd it is running in, not stale in it.
//
// THE ANSWER IS A NAMED MOVE. 2026-0259 read "rebuilding a redirect under a
// running CLI is not possible" as ruling that out; the premise is true and does
// not apply, because the rebuild happens where NOTHING IS RUNNING —
// `_refreshSessionRoot` is called from launch(), with spawn() on the next line.
// So 0259's warn-don't-refuse is superseded by a THIRD answer rather than
// overturned into a refusal: cc follows the geometry, and the line says so
// (card 2026-0279). What the move itself pins lives in
// tests/systems-mirror-geometry-follow.test.mjs; this file owns the line.
//
// WHAT CAN AND CANNOT REACH IT. cc memoises `describeRemote` on handshake
// object identity, so a live session re-asks nothing until its provider
// restarts. Changing the system's launch argv announces nothing to a running
// session: its placement keeps the handle captured at create. Only a NEW
// CONNECTION GENERATION that answers differently can move the geometry, which
// is what tests/fixtures/mirrorFixtureProvider.mjs exists to model.
//
// ORDERING NOTE: the first test predates its implementation's commit, so no
// test-first ordering was available or claimed for it; its non-vacuity rests on
// the negative probe — an implementation that always spoke, or that compared the
// wrong pair of paths, fails it. The other two were rewritten test-first for
// card 2026-0279 and were RED against the unmoved session.

import { test, describe, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { promises as fs } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { bootServer, api, freshProjectsRoot, rmrf, waitFor } from './helpers.mjs';
import { bindRemoteSystem, seedRepo } from './remoteSystem.mjs';
import { mkdtemp } from './tmpRegistry.mjs';
import { adoptProject } from '../src/projects.ts';
import { addSystem } from '../src/appSettings.ts';
import { disposeSystemHandles } from '../src/systems/registry.ts';

const FIXTURE = path.join(path.dirname(fileURLToPath(import.meta.url)), 'fixtures', 'mirrorFixtureProvider.mjs');

describe('a mirror advertisement that changes under a running session', () => {
  let ctx, baseUrl, instances, home, remote, inst, mirrorFile, pidFile;

  before(async () => {
    ctx = await bootServer();
    ({ baseUrl, instances } = ctx);
    ({ home } = await freshProjectsRoot());
    remote = await bindRemoteSystem();
    await seedRepo(remote.root);

    const box = await mkdtemp('cc-mirror-move-');
    mirrorFile = path.join(box, 'mirror');
    pidFile = path.join(box, 'pid');
    // Starts empty: the provider advertises nothing, so the first composition
    // is the ordinary project-anchored one.
    await fs.writeFile(mirrorFile, '');
    await addSystem({
      id: 'movable', label: 'movable',
      launch: ['node', FIXTURE, '--mirror-file', mirrorFile, '--pid-file', pidFile],
    });
    assert.equal((await adoptProject('app', remote.root, { system: 'movable' })).ok, true);

    const r = await api(baseUrl, 'POST', '/api/instances', { project: 'app', mode: 'bypassPermissions' });
    assert.equal(r.status, 201, JSON.stringify(r.body));
    inst = instances.get(r.body.id);
    await waitFor(() => inst.status === 'idle');
  });

  after(async () => {
    if (ctx) await ctx.instances.shutdown();
    disposeSystemHandles();
    if (home) await rmrf(home);
    if (ctx) await ctx.close();
  });

  // Every stderr line one refresh put on the session's event stream.
  async function linesFrom(fn) {
    const seen = [];
    const real = inst._emitUi.bind(inst);
    inst._emitUi = (ev) => {
      if (ev.kind === 'system' && ev.subtype === 'stderr') seen.push(ev.data.line);
      return real(ev);
    };
    try { await fn(); } finally { inst._emitUi = real; }
    return seen;
  }
  const geometryLines = (lines) => lines.filter(l => l.includes('now mirrors this project at'));

  // PINS: a refresh that recomposes the SAME geometry says nothing. The
  // announcement is a change signal, not a heartbeat — a line on every relaunch
  // would train an operator to ignore the one that matters.
  //
  // NOT CLAIMING: that no other line is emitted. Skipped entries and inert-
  // exclude notes share this stream and are their own tests.
  test('a refresh that finds the same geometry announces nothing', async () => {
    const lines = await linesFrom(() => inst._refreshSessionRoot());
    assert.deepEqual(geometryLines(lines), [],
      `an unchanged refresh spoke: ${JSON.stringify(lines)}`);
  });

  // PINS: after a NEW CONNECTION GENERATION answers differently, the next
  // refresh emits exactly one line, it names both the location the session came
  // from and the one it went to — an operator cannot act on "something moved" —
  // and the session really is at the new one afterwards.
  //
  // NOT CLAIMING: that the transcript moved with it, or that a worker started
  // there; both are pinned through the production relaunch in
  // tests/systems-mirror-geometry-follow.test.mjs. Nor that a launch-argv change
  // reaches this — it does not, and that is why this test restarts the provider.
  test('a provider restart that answers differently announces exactly once, and moves the session', async () => {
    const before = inst.cwd;
    // The generation ends here. The next operation re-handshakes, the fixture
    // re-reads its file, and the memo is keyed on a handshake object that no
    // longer exists.
    await fs.writeFile(mirrorFile, path.dirname(remote.root));
    const system = inst._redirectPlacement.system;
    const generation = system.handshake;
    const gone = Number(await fs.readFile(pidFile, 'utf8'));
    // The fixture IS the provider — one process, no child to orphan — so
    // SIGKILL here ends the generation and leaves nothing behind.
    process.kill(gone, 'SIGKILL');
    await waitFor(() => { try { process.kill(gone, 0); return false; } catch { return true; } });
    // The exit has to be OBSERVED before the reconnect, or `ensureUp` hands
    // back the handshake of a process that is already gone. Reconnecting here
    // rather than letting the refresh do it keeps the measured call clean of
    // the transport error the kill itself causes.
    await waitFor(() => system.handshake === null);
    await system.connect();
    assert.notEqual(system.handshake, generation, 'a new connection generation really began');

    const lines = await linesFrom(() => inst._refreshSessionRoot());
    const moved = geometryLines(lines);
    assert.equal(moved.length, 1, `expected exactly one line, got ${JSON.stringify(lines)}`);
    assert.ok(moved[0].includes(before), `it names where this session is running: ${moved[0]}`);
    const movedTo = path.join(before, path.basename(remote.root));
    assert.ok(moved[0].includes(movedTo), `and where the project is now mirrored: ${moved[0]}`);
    assert.equal(inst.cwd, movedTo, 'and the session followed the geometry there');
  });

  // PINS the line's CONTENT against behaviour rather than only against prose,
  // and pins the SECOND consecutive move: a session that has already followed
  // one advertisement follows the next one too. Nothing about the first move
  // makes the instance a special case afterwards — the guard is
  // `composed.cwd !== this.cwd`, which is as true the second time as the first.
  //
  // The prose half is behavioural, not decorative: the line must not call the
  // surface stale (it is not — it is present, at the new cwd), must not say cc
  // cannot carry the conversation (it just did), must not name respawn as a
  // remedy for something that is no longer a problem, and must say that a peer
  // still running is NOT moved — convergence is per-relaunch, not instant.
  //
  // NOT CLAIMING that a peer really stays put; that is measured in
  // tests/systems-mirror-geometry-follow.test.mjs. What is pinned here is that
  // the line tells the operator so rather than leaving it to be inferred. NOT
  // CLAIMING that this third geometry is the last: nothing bounds the count.
  test('the line says cc moved the session, and a session can follow the geometry twice', async () => {
    const cameFrom = inst.cwd;
    // A THIRD geometry, two levels wider — an A2-class widening, where the old
    // offset was already non-empty and the old cwd will not survive the compose.
    const wider = path.dirname(path.dirname(remote.root));
    await fs.writeFile(mirrorFile, wider);
    const system = inst._redirectPlacement.system;
    const generation = system.handshake;
    const gone = Number(await fs.readFile(pidFile, 'utf8'));
    process.kill(gone, 'SIGKILL');
    await waitFor(() => { try { process.kill(gone, 0); return false; } catch { return true; } });
    await waitFor(() => system.handshake === null);
    await system.connect();
    assert.notEqual(system.handshake, generation, 'a new connection generation really began');

    const [line] = geometryLines(await linesFrom(() => inst._refreshSessionRoot()));
    assert.ok(line, 'the line is still emitted');
    assert.notEqual(inst.cwd, cameFrom, 'the session did not follow the geometry a second time');

    // CONTROL, and the half of the old test that is still true: a NEW session on
    // this project starts where the surface now is.
    const fresh = await api(baseUrl, 'POST', '/api/instances', { project: 'app', mode: 'bypassPermissions' });
    assert.equal(fresh.status, 201, JSON.stringify(fresh.body));
    const freshInst = instances.get(fresh.body.id);
    await waitFor(() => freshInst.status === 'idle');
    assert.equal(freshInst.cwd, inst.cwd, 'a new session and the moved one agree on the location');
    assert.match(await fs.readFile(path.join(inst.cwd, 'CLAUDE.md'), 'utf8'), /@CONVENTIONS\.md/);

    // The line says cc MOVED the session, and says nothing the move falsified.
    assert.match(line, /MOVED this session/, line);
    assert.ok(line.includes(cameFrom), `it names where the session came from: ${line}`);
    assert.ok(!/stale/.test(line), `the surface is present at the new cwd, not stale: ${line}`);
    assert.ok(!/cannot/.test(line), `cc just did carry the conversation: ${line}`);
    assert.ok(!/Respawn the session/.test(line), `there is nothing left for a respawn to remedy: ${line}`);
    // The peer clause: another session still running keeps its own cwd until its
    // own next relaunch. Without this the line reads as "live sessions move".
    assert.match(line, /until its own next relaunch/, line);
    // And it names no allow-list file: the list is what a config surface CAN
    // hold, and this fixture is one that has no `.claude/` tree at either
    // location, so enumerating it would assert a file nobody looked for.
    assert.ok(!/CLAUDE\.md|\.claude\//.test(line), `the line names a file it did not observe: ${line}`);
    await assert.rejects(fs.readdir(path.join(inst.cwd, '.claude')),
      'and this fixture really has no .claude/ tree at the new location');
  });
});
