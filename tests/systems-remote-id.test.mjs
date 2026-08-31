// ONE SYSTEM, MANY TARGETS: the `remotes` capability, the `remoteId` field, and
// the refusals that keep a wrong-target operation from looking like success.
//
// The trap this file exists to avoid: the reference provider runs on cc's OWN
// machine, so an operation that lands on the wrong remote still finds the file,
// still runs the command and still goes green. Showing that something SUCCEEDED
// proves nothing about which remote served it. So every routing claim here is
// made positively, against something only the intended remote could have
// produced — the `CC_REMOTE` the provider injects into the child's environment,
// and the per-remote root that refuses a path belonging to a different one.
//
// The claims about what cc must NOT send are measured on the wire itself, by
// recording every client frame (tests/fixtures/recordingProvider.mjs). A
// capability gate asserted from cc's side would pass whether or not the field
// stayed home.

import { test, describe, beforeEach, afterEach } from 'node:test';
import assert from 'node:assert/strict';
import { promises as fs } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { freshProjectsRoot, rmrf } from './helpers.mjs';
import { mkdtemp } from './tmpRegistry.mjs';
import { bindRemoteSystem, referenceLaunch } from './remoteSystem.mjs';
import { addSystem } from '../src/appSettings.ts';
import { disposeSystemHandles, systemById } from '../src/systems/registry.ts';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const RECORDER = path.join(__dirname, 'fixtures', 'recordingProvider.mjs');

// Every client frame the provider was sent, as decoded objects. The instrument
// for "cc never sends this" — the only evidence for a negative that is not
// itself a restatement of the code under test.
async function wire(file) {
  let raw = '';
  try { raw = await fs.readFile(file, 'utf8'); } catch (e) { if (e.code !== 'ENOENT') throw e; }
  return raw.split('\n').filter(l => l.trim()).map(l => JSON.parse(l));
}

const alive = (pid) => { try { process.kill(pid, 0); return true; } catch { return false; } };

async function settle(pred, ms = 3_000) {
  const until = Date.now() + ms;
  while (Date.now() < until) {
    if (pred()) return true;
    await new Promise(r => setTimeout(r, 20));
  }
  return pred();
}

describe('remoteId: one system, many targets', () => {
  let home, rootA, rootB;
  beforeEach(async () => {
    ({ home } = await freshProjectsRoot());
    rootA = await fs.realpath(await mkdtemp('cc-remote-a-'));
    rootB = await fs.realpath(await mkdtemp('cc-remote-b-'));
  });
  afterEach(async () => { disposeSystemHandles(); await rmrf(home); });

  // ── Capability negotiation ───────────────────────────────────────────

  // PINS: `remotes` is advertised only by a provider actually configured to
  // serve named targets — the flag is what the capability means, not decoration.
  test('the remotes capability tracks the provider configuration', async () => {
    const bare = await bindRemoteSystem({ id: 'bare' });
    const withRemotes = await bindRemoteSystem({ id: 'boxes', flags: ['--remote', `a=${rootA}`] });

    const a = await systemById(bare.id, null, 'test');
    const b = await systemById(withRemotes.id, null, 'test');
    assert.equal(a.handshake.capabilities.remotes, false);
    assert.equal(b.handshake.capabilities.remotes, true);
  });

  // ── The A2 matrix, row 3: capability absent + remoteId set ───────────

  // PINS: a project naming a remote on a provider that does not serve remotes
  // is refused BY NAME at resolution, and the field never reaches the wire —
  // an older provider handed one would ignore the unknown key and answer from
  // its default target, which is a misroute reported as success.
  test('no capability + a remoteId is SYSTEM_NO_REMOTES, and the field never goes out', async () => {
    const rec = path.join(home, 'wire.ndjson');
    await addSystem({ id: 'oldbox', label: 'Old', launch: ['node', RECORDER, '--record', rec] });

    await assert.rejects(
      () => systemById('oldbox', 'a', `project 'p'`),
      (e) => e.statusCode === 501 && e.code === 'SYSTEM_NO_REMOTES' && e.systemRefusal === true,
    );

    const frames = await wire(rec);
    assert.ok(frames.length > 0, 'the provider was really launched and spoken to');
    assert.equal(frames.some(f => 'remoteId' in f), false,
      'a provider that does not advertise `remotes` is never handed one');
  });

  // PINS: row 4 of the matrix — no capability and no remoteId is byte-identical
  // to a system with no remotes at all. This is what makes the feature free for
  // every provider that never opts in.
  test('no capability + no remoteId is unchanged traffic', async () => {
    const rec = path.join(home, 'wire.ndjson');
    await addSystem({ id: 'oldbox', label: 'Old', launch: ['node', RECORDER, '--record', rec] });

    const sys = await systemById('oldbox', null, `project 'p'`);
    assert.equal(sys.remoteId, null);
    const r = await sys.exec({ argv: ['printf', 'ok'] }, { cwd: rootA });
    assert.equal(r.stdout, 'ok');

    const frames = await wire(rec);
    assert.equal(frames.some(f => 'remoteId' in f), false);
  });

  // ── Row 1: bound ─────────────────────────────────────────────────────

  // PINS: a bound handle stamps its remote on all three request frames, and on
  // nothing else — follow-on frames inherit the binding through the id.
  test('a bound handle stamps remoteId on exec, readFile and writeFile', async () => {
    const rec = path.join(home, 'wire.ndjson');
    await addSystem({
      id: 'boxes', label: 'Boxes',
      launch: ['node', RECORDER, '--record', rec, '--remote', `a=${rootA}`],
    });
    const sys = await systemById('boxes', 'a', `project 'p'`);
    assert.equal(sys.remoteId, 'a');

    await sys.writeFile(path.join(rootA, 'f.txt'), 'hi');
    assert.equal(await sys.readFile(path.join(rootA, 'f.txt')), 'hi');
    await sys.exec({ argv: ['true'] }, { cwd: rootA });

    const frames = await wire(rec);
    for (const type of ['exec', 'readFile', 'writeFile']) {
      const sent = frames.filter(f => f.type === type);
      assert.ok(sent.length > 0, `a ${type} frame was sent`);
      for (const f of sent) assert.equal(f.remoteId, 'a', `${type} carries the binding`);
    }
    // `data`/`end` carry the write's payload and `hello` opens the channel;
    // neither is a request, so neither names a remote.
    for (const f of frames.filter(f => ['data', 'end', 'hello'].includes(f.type))) {
      assert.equal('remoteId' in f, false, `a '${f.type}' frame inherits its binding through the id`);
    }
  });

  // ── One connection, many targets ─────────────────────────────────────

  // PINS: two remotes on one system SHARE one provider process. That is the
  // whole point of the card — one endpoint, many targets — and it is measured
  // on the far side (the pid that parented each command), not inferred from
  // cc-side object identity.
  test('two remotes are served by one provider process', async () => {
    const remote = await bindRemoteSystem({
      id: 'boxes', flags: ['--remote', `a=${rootA}`, '--remote', `b=${rootB}`],
    });
    const a = await systemById(remote.id, 'a', 'test');
    const b = await systemById(remote.id, 'b', 'test');
    assert.notEqual(a, b, 'each remote is its own bound view');

    const pidA = (await a.exec({ shell: 'echo $PPID' }, { cwd: rootA })).stdout.trim();
    const pidB = (await b.exec({ shell: 'echo $PPID' }, { cwd: rootB })).stdout.trim();
    assert.ok(Number(pidA) > 0, 'both remotes really answered');
    assert.equal(pidA, pidB, 'one provider process parented both commands');
  });

  // PINS: which remote served a command is observable on the far side. Without
  // this every routing assertion in this file would be "it worked", which the
  // wrong remote would also produce.
  test('the child of a bound exec is told which remote it is on', async () => {
    const remote = await bindRemoteSystem({
      id: 'boxes', flags: ['--remote', `a=${rootA}`, '--remote', `b=${rootB}`],
    });
    const a = await systemById(remote.id, 'a', 'test');
    const b = await systemById(remote.id, 'b', 'test');
    assert.equal((await a.exec({ shell: 'echo "$CC_REMOTE"' }, { cwd: rootA })).stdout.trim(), 'a');
    assert.equal((await b.exec({ shell: 'echo "$CC_REMOTE"' }, { cwd: rootB })).stdout.trim(), 'b');
  });

  // PINS: a provider serving remotes refuses an UNBOUND request rather than
  // quietly answering from a default target — the misroute-as-success this
  // whole design exists to prevent.
  test('an unbound request to a remotes-serving provider is refused', async () => {
    const remote = await bindRemoteSystem({ id: 'boxes', flags: ['--remote', `a=${rootA}`] });
    const sys = await systemById(remote.id, null, 'test');
    const r = await sys.exec({ argv: ['true'] }, { cwd: rootA });
    assert.equal(r.spawnErrorCode, 'ENOREMOTE');
    assert.equal(r.transportFailure, undefined, 'the provider ANSWERED — the channel is fine');
  });

  // ── Refusals at resolution ───────────────────────────────────────────

  // PINS: a remote the provider does not serve is REMOTE_NOT_FOUND at
  // resolution — a 502 because the far side answered, distinct from the 501
  // that says the provider cannot do remotes at all.
  test('an unknown remote refuses REMOTE_NOT_FOUND', async () => {
    const remote = await bindRemoteSystem({ id: 'boxes', flags: ['--remote', `a=${rootA}`] });
    await assert.rejects(
      () => systemById(remote.id, 'typo', `project 'p'`),
      (e) => e.statusCode === 502 && e.code === 'REMOTE_NOT_FOUND' && e.systemRefusal === true
        && /typo/.test(e.message),
    );
  });

  // ── assertRemoteKnown: one question, one answer ──────────────────────

  // PINS: the probe runs ONCE per connection generation, and again after the
  // provider is replaced. Memoised on the handshake object's identity, so a
  // restart re-asks and nothing else does — counted on the wire, because a
  // cc-side counter would be a restatement of the implementation.
  test('the remote is probed once per connection, and re-probed after a restart', async () => {
    const rec = path.join(home, 'wire.ndjson');
    await addSystem({
      id: 'boxes', label: 'Boxes',
      launch: ['node', RECORDER, '--record', rec, '--remote', `a=${rootA}`],
    });
    const probes = async () => (await wire(rec)).filter(
      f => f.type === 'exec' && Array.isArray(f.argv) && f.argv.length === 1 && f.argv[0] === 'true' && f.cwd === '/',
    ).length;

    const sys = await systemById('boxes', 'a', 'test');
    assert.equal(await probes(), 1, 'resolution asks the provider whether it serves this remote');
    await systemById('boxes', 'a', 'test');
    await systemById('boxes', 'a', 'test');
    assert.equal(await probes(), 1, 'a second resolution over the same connection does not re-ask');

    const pid = Number((await sys.exec({ shell: 'echo $PPID' }, { cwd: rootA })).stdout.trim());
    process.kill(pid, 'SIGKILL');
    await settle(() => !alive(pid));

    await systemById('boxes', 'a', 'test');
    assert.equal(await probes(), 2, 'a new connection generation is a new question');
  });

  // PINS: the probe asks ONE question — "do you serve this remote?" — and
  // ENOREMOTE is its only failure. Every other answer, including a refusal, is
  // the provider answering ABOUT that remote, which is itself proof it serves
  // it. Asserted head-on so that "fixing" the ignored refusal breaks a test
  // that says why.
  test('a probe the provider REFUSES still resolves — only ENOREMOTE is a no', async () => {
    const rec = path.join(home, 'wire.ndjson');
    await addSystem({
      id: 'boxes', label: 'Boxes',
      // The remote is real; its root refuses the probe's `/` cwd. That is an
      // answer about the remote, so it is a pass.
      launch: ['node', RECORDER, '--record', rec, '--remote', `a=${rootA}`],
    });
    const sys = await systemById('boxes', 'a', 'test');
    assert.equal(sys.remoteId, 'a');
    const probe = (await wire(rec)).find(f => f.type === 'exec' && f.cwd === '/');
    assert.ok(probe, 'the probe really ran');
    assert.equal(probe.remoteId, 'a', 'and it asked about THIS remote');
  });
});
