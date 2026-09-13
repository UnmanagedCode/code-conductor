// A handle a caller RETAINED across an argv swap must refuse, not respawn.
//
// `disposeSystemHandle` (src/systems/registry.ts) drops the registry's entry,
// but a live worker session holds the handle it was created with and that
// retention is out of the registry's reach. The failure this suite pins out is
// the worst one available on this seam: the retained handle silently relaunches
// the OLD provider command and runs the session's work on the PRE-SWAP machine,
// reporting success.
//
// "It failed" is never the evidence here, and neither is "it succeeded". Two
// roots hold different MARKER bytes and are served by two different launch
// argvs recording to two different transcripts, so every claim is anchored to
// either the bytes that came back or the frames that crossed the pipe.

import { test, describe, before, beforeEach, afterEach, after } from 'node:test';
import assert from 'node:assert/strict';
import { promises as fs } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { bootServer, api, freshProjectsRoot, rmrf, waitFor } from './helpers.mjs';
import { seedRepo } from './remoteSystem.mjs';
import { mkdtemp } from './tmpRegistry.mjs';
import { adoptProject } from '../src/projects.ts';
import { addSystem, updateSystem } from '../src/appSettings.ts';
import { disposeSystemHandles, systemById, systemHandleGeneration } from '../src/systems/registry.ts';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const RECORDER = path.join(__dirname, 'fixtures', 'recordingProvider.mjs');

// Local by design: other suites carry their own copy of this rather than
// sharing one, because what counts as a frame is the test's own claim.
async function wire(file) {
  let raw = '';
  try { raw = await fs.readFile(file, 'utf8'); } catch (e) { if (e.code !== 'ENOENT') throw e; }
  return raw.split('\n').filter(l => l.trim()).map(l => JSON.parse(l));
}

const hellos = async (file) => (await wire(file)).filter(f => f.type === 'hello').length;

describe('a handle retained across an argv swap', () => {
  let home, rootA, rootB, recA, recB;

  beforeEach(async () => {
    ({ home } = await freshProjectsRoot());
    rootA = await fs.realpath(await mkdtemp('cc-stale-a-'));
    rootB = await fs.realpath(await mkdtemp('cc-stale-b-'));
    await fs.writeFile(path.join(rootA, 'marker.txt'), 'MACHINE-A\n');
    await fs.writeFile(path.join(rootB, 'marker.txt'), 'MACHINE-B\n');
    recA = path.join(home, 'wireA.ndjson');
    recB = path.join(home, 'wireB.ndjson');
  });
  afterEach(async () => { disposeSystemHandles(); await rmrf(home); });

  test('T1 — a retained OWNER handle refuses instead of respawning the old argv', async () => {
    const gen1 = ['node', RECORDER, '--record', recA, '--name', 'gen1'];
    const gen2 = ['node', RECORDER, '--record', recB, '--name', 'gen2'];
    await addSystem({ id: 'box', label: 'Box', launch: gen1 });

    const stale = await systemById('box', null, `project 'p'`);
    assert.equal(stale.remoteId, null, 'the retained handle is the OWNER, not a bound view');
    // BASELINE: the handle works, so the refusal below is caused by the swap.
    assert.equal(await stale.readFile(path.join(rootA, 'marker.txt')), 'MACHINE-A\n');

    const genBefore = systemHandleGeneration();
    // Pinned, not just captured: an "unchanged" count over a transcript nothing
    // was ever written to would pass for the wrong reason.
    const hellosBefore = await hellos(recA);
    assert.ok(hellosBefore > 0, 'the gen1 provider really was launched to serve the baseline');

    // THE PRODUCTION EVENT — Settings → Systems edits the provider command.
    await updateSystem('box', { launch: gen2 });
    assert.ok(systemHandleGeneration() > genBefore, 'the registry dropped the handle');

    await assert.rejects(() => stale.readFile(path.join(rootA, 'marker.txt')),
      (e) => e.code === 'ETRANSPORT',
      'the retained owner handle refuses rather than serving the pre-swap machine');

    // THE WIRE FACT, which is the strong one: no second hello on the gen1
    // transcript means the old argv was never relaunched — a refusal that
    // still respawned would be a process cc can no longer reach.
    assert.equal(await hellos(recA), hellosBefore,
      'the gen1 provider command was never launched a second time');

    // CONTROL — the swap really took and the fixture can still see a live
    // provider, so the refusal above is not a broken fixture.
    const fresh = await systemById('box', null, `project 'p'`);
    assert.notEqual(fresh, stale, 'the registry built a new handle');
    assert.equal(await fresh.readFile(path.join(rootB, 'marker.txt')), 'MACHINE-B\n',
      'CONTROL: a freshly resolved handle serves the NEW machine');
  });

  test('T2 — a retained bound VIEW refuses instead of respawning the old argv', async () => {
    const gen1 = ['node', RECORDER, '--record', recA, '--remote', `a=${rootA}`, '--name', 'gen1'];
    const gen2 = ['node', RECORDER, '--record', recB, '--remote', `a=${rootB}`, '--name', 'gen2'];
    await addSystem({ id: 'box', label: 'Box', launch: gen1 });

    const stale = await systemById('box', 'a', `project 'p'`);
    assert.equal(stale.remoteId, 'a', 'the retained handle is a bound VIEW, whose own dispose() is a no-op');
    assert.equal(await stale.readFile(path.join(rootA, 'marker.txt')), 'MACHINE-A\n');

    const genBefore = systemHandleGeneration();
    // Pinned, not just captured: an "unchanged" count over a transcript nothing
    // was ever written to would pass for the wrong reason.
    const hellosBefore = await hellos(recA);
    assert.ok(hellosBefore > 0, 'the gen1 provider really was launched to serve the baseline');

    await updateSystem('box', { launch: gen2 });
    assert.ok(systemHandleGeneration() > genBefore, 'the registry dropped the handle');

    await assert.rejects(() => stale.readFile(path.join(rootA, 'marker.txt')),
      (e) => e.code === 'ETRANSPORT',
      'the retained view refuses rather than serving the pre-swap machine');
    assert.equal(await hellos(recA), hellosBefore,
      'the gen1 provider command was never launched a second time');

    const fresh = await systemById('box', 'a', `project 'p'`);
    assert.notEqual(fresh, stale, 'the registry built a new view');
    assert.equal(await fresh.readFile(path.join(rootB, 'marker.txt')), 'MACHINE-B\n',
      'CONTROL: a freshly resolved view serves the NEW machine');
  });

  // THE FENCE ON THE ORDERING INSIDE `dispose()`. T1-T4 all dispose a
  // connection that is UP, so they cannot tell the flag being set BEFORE
  // `dispose()`'s `if (!c) return` from it being set after. The production
  // shape that can is a provider which ALREADY DIED, then an argv edit: the
  // crash leaves no `#child` to tear down, and `#failures` was reset by the
  // last successful connect, so there is no backoff window to mask a respawn
  // either. Setting the flag after the early return would leave exactly that
  // handle live.
  test('T6 — disposing a connection that is already DOWN is still terminal', async () => {
    const gen1 = ['node', RECORDER, '--record', recA, '--remote', `a=${rootA}`, '--name', 'gen1'];
    const gen2 = ['node', RECORDER, '--record', recB, '--remote', `a=${rootB}`, '--name', 'gen2'];
    await addSystem({ id: 'box', label: 'Box', launch: gen1 });

    const stale = await systemById('box', 'a', `project 'p'`);
    assert.equal(await stale.readFile(path.join(rootA, 'marker.txt')), 'MACHINE-A\n');
    assert.notEqual(stale.handshake, null, 'the connection is UP before the provider is killed');

    // Kill the provider from the far side rather than simulating a death: the
    // reference provider spawns an exec as its own DIRECT child, so `$PPID`
    // inside the shell is the provider process itself. `exec` never rejects,
    // so the transport failure comes back in the result.
    await stale.exec({ argv: ['sh', '-c', 'kill -9 $PPID'] }, { cwd: rootA, stdin: 'ignore' });
    await waitFor(() => stale.handshake === null);

    // THE PRECONDITION THIS TEST EXISTS FOR. Without it a fixture whose
    // provider did not actually die would quietly degrade this into a second
    // copy of T2.
    assert.equal(stale.handshake, null, 'the connection is DOWN when the argv is edited');
    const hellosBefore = await hellos(recA);
    assert.ok(hellosBefore > 0, 'the gen1 provider really was launched to serve the baseline');

    await updateSystem('box', { launch: gen2 });

    // Matched on the DISPOSED guard's own wording, not just the code: a crash
    // that had left a backoff window open would refuse with `ETRANSPORT` too,
    // and would suppress the respawn for a reason that has nothing to do with
    // this fix — masking the very thing the count below is here to catch.
    // (`#failures` is only raised by a failed CONNECT, and this connection's
    // last connect SUCCEEDED, so no window is open — this pins that.)
    await assert.rejects(() => stale.readFile(path.join(rootA, 'marker.txt')),
      (e) => e.code === 'ETRANSPORT' && /was disposed/.test(e.message),
      'a handle disposed while DOWN refuses too, and refuses AS DISPOSED rather than as backed-off');
    assert.equal(await hellos(recA), hellosBefore,
      'and it spawned nothing: the gen1 provider command was never relaunched');
  });
});

describe('a live session across an argv swap', () => {
  let ctx, baseUrl, instances, home, inst, rootA, rootB, recA, recB;

  const gen2Launch = () => ['node', RECORDER, '--record', recB, '--remote', `a=${rootB}`, '--name', 'gen2'];

  before(async () => {
    ctx = await bootServer();
    ({ baseUrl, instances } = ctx);
  });

  beforeEach(async () => {
    ({ home } = await freshProjectsRoot());
    rootA = await fs.realpath(await mkdtemp('cc-stale-sess-a-'));
    rootB = await fs.realpath(await mkdtemp('cc-stale-sess-b-'));
    recA = path.join(home, 'wireA.ndjson');
    recB = path.join(home, 'wireB.ndjson');

    // The SAME project path spelled on two different machines, each holding its
    // own marker. `app` sits at the same relative place on both, so the
    // redirect's fixed systemPath is valid on either — which is exactly what
    // would make a misroute silent rather than an error.
    await seedRepo(path.join(rootA, 'app'));
    await seedRepo(path.join(rootB, 'app'));
    await fs.writeFile(path.join(rootA, 'app', 'MARKER'), 'MACHINE-A\n');
    await fs.writeFile(path.join(rootB, 'app', 'MARKER'), 'MACHINE-B\n');
    await fs.writeFile(path.join(rootA, 'app', 'CLAUDE.md'), '# FROM-MACHINE-A\n');
    await fs.writeFile(path.join(rootB, 'app', 'CLAUDE.md'), '# FROM-MACHINE-B\n');

    await addSystem({
      id: 'box', label: 'Box',
      launch: ['node', RECORDER, '--record', recA, '--remote', `a=${rootA}`, '--name', 'gen1'],
    });
    assert.equal((await adoptProject('app', path.join(rootA, 'app'), { system: 'box', remoteId: 'a' })).ok, true);

    const r = await api(baseUrl, 'POST', '/api/instances', { project: 'app', mode: 'bypassPermissions' });
    assert.equal(r.status, 201, JSON.stringify(r.body));
    inst = instances.get(r.body.id);
    await waitFor(() => inst.status === 'idle');
    assert.ok(inst._redirect, 'the session really got a redirect (it is on a non-local system)');
    // The fake CLI exits at spawn, and that calls `_redirect.close()`, which
    // aborts the in-flight commands and RE-ARMS. Wait that teardown out so the
    // measurement is not racing it.
    await waitFor(async () => (await inst._redirect.runForwarded('true')).code === 0);
  });

  afterEach(async () => {
    await instances.shutdown();
    disposeSystemHandles();
    await rmrf(home);
  });

  after(async () => { if (ctx) await ctx.close(); });

  test('T3 — the session cannot execute on the pre-swap machine after the swap', async () => {
    // BASELINE — the identical call, moments earlier, on the identical cwd.
    const before = await inst._redirect.runForwarded('cat MARKER');
    assert.equal(before.code, 0, JSON.stringify(before));
    assert.match(before.stdout, /MACHINE-A/, 'baseline: the live session reaches MACHINE A');

    const hellosBefore = await hellos(recA);
    assert.ok(hellosBefore > 0, 'the gen1 provider really was launched to serve the baseline');
    await updateSystem('box', { launch: gen2Launch() });

    const after = await inst._redirect.runForwarded('cat MARKER; echo PWD=$PWD');
    assert.doesNotMatch(after.stdout, /MACHINE-A/,
      'the session cannot execute on the pre-swap machine');
    assert.notEqual(after.code, 0, `it failed rather than returning nothing: ${JSON.stringify(after)}`);
    assert.match(after.stderr, /could not start/,
      'the worker is told loudly, on stderr, that the shell could not start');
    assert.equal(await hellos(recA), hellosBefore,
      'the gen1 provider command was never launched a second time');

    // CONTROLS — a re-resolved handle serves MACHINE B and is fenced OUT of
    // machine A, so MACHINE-A bytes could only ever have come from the
    // pre-swap process.
    const fresh = await systemById('box', 'a', `project 'app'`);
    assert.equal(await fresh.readFile(path.join(rootB, 'app', 'MARKER')), 'MACHINE-B\n',
      'CONTROL: a freshly resolved handle serves the NEW machine');
    await assert.rejects(() => fresh.readFile(path.join(rootA, 'app', 'MARKER')),
      (e) => e.code === 'EACCES',
      'CONTROL: the post-swap handle is fenced out of machine A');
  });

  test('T4 — nothing keeps serving after disposeSystemHandles() + the retained handle dispose()', async () => {
    const held = inst._redirectPlacement.system;
    assert.equal(held.remoteId, 'a', 'the retained handle is a bound VIEW, whose own dispose() is a no-op');

    const hellosBefore = await hellos(recA);
    assert.ok(hellosBefore > 0, 'the gen1 provider really was launched to serve the baseline');
    disposeSystemHandles();   // the registry-wide shutdown
    held.dispose();           // and the retained handle's own dispose

    const r = await inst._redirect.runForwarded('cat MARKER');
    assert.doesNotMatch(r.stdout, /MACHINE-A/, 'no connection serves the disposed handle');
    assert.notEqual(r.code, 0, `the command failed rather than returning nothing: ${JSON.stringify(r)}`);
    assert.equal(await hellos(recA), hellosBefore,
      'no new provider process was spawned on the old argv');
  });

  test('T5 — session-root recomposition cannot pull from the pre-swap machine', async () => {
    const hellosBefore = await hellos(recA);
    assert.ok(hellosBefore > 0, 'the gen1 provider really was launched to serve the baseline');
    await updateSystem('box', { launch: gen2Launch() });

    // The advertisement is the first thing a relaunch asks the retained handle
    // for — `launch()`'s re-advertisement check, which is what would otherwise
    // let a session continue against a machine that is no longer the one it
    // started on. It throws at `ensureUp()`, so nothing of the pre-swap
    // machine's answer is used.
    await assert.rejects(() => inst._redirectPlacement.system.mirror(),
      (e) => e.code === 'ETRANSPORT',
      'the retained handle refuses rather than reaching MACHINE A again');
    assert.equal(await hellos(recA), hellosBefore,
      'the gen1 provider command was never launched a second time');
  });
});
