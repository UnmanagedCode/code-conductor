// THE GEOMETRY MOVING UNDER A LIVE SESSION.
//
// An instance's cwd and its redirect's path map are both fixed at create. A
// provider that changes its mirror advertisement afterwards therefore has the
// session root re-pulled somewhere the running CLI will not look — its config
// surface goes stale in place. Rebuilding a redirect under a running CLI is not
// possible and refusing the relaunch would break a session over a config
// change, so the answer is a NAMED WARNING on the session's event stream.
//
// WHAT CAN AND CANNOT REACH IT. cc memoises `describeRemote` on handshake
// object identity, so a live session re-asks nothing until its provider
// restarts. Changing the system's launch argv announces nothing to a running
// session: its placement keeps the handle captured at create. Only a NEW
// CONNECTION GENERATION that answers differently can move the geometry, which
// is what tests/fixtures/mirrorFixtureProvider.mjs exists to model.
//
// ORDERING NOTE: this is coverage of behaviour that landed in the previous
// commit, so there was nothing to implement after it — no test-first ordering
// was available or claimed. Its non-vacuity rests on the negative probe: an
// implementation that always warned, or that compared the wrong pair of paths,
// fails the first assertion.

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
  // refresh emits exactly one line, and it names both the new location and the
  // one this session is stuck in — an operator cannot act on "something moved".
  //
  // NOT CLAIMING: that the running session recovers. It does not; the line
  // exists because it cannot. Nor that a launch-argv change reaches this — it
  // does not, and that is why this test restarts the provider instead.
  test('a provider restart that answers differently announces exactly once, naming both paths', async () => {
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
    assert.ok(moved[0].includes(path.join(before, path.basename(remote.root))),
      `and where the project is now mirrored: ${moved[0]}`);
    assert.equal(inst.cwd, before, 'and the running session was not silently moved');
  });
});
