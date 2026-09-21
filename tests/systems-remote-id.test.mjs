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

import { test, describe, before, after, beforeEach, afterEach } from 'node:test';
import assert from 'node:assert/strict';
import { promises as fs } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { bootServer, freshProjectsRoot, rmrf } from './helpers.mjs';
import { mkdtemp } from './tmpRegistry.mjs';
import { bindRemoteSystem, flakyLaunch } from './remoteSystem.mjs';
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

async function settle(pred, ms = 3_000) {
  const until = Date.now() + ms;
  while (Date.now() < until) {
    if (pred()) return true;
    await new Promise(r => setTimeout(r, 20));
  }
  return pred();
}

// A real `tools/call` over POST /mcp — the boundary a remoteId refusal has to
// survive to reach an MCP caller with its code intact.
let nextRpcId = 1;
async function callTool(baseUrl, name, args) {
  const res = await fetch(baseUrl + '/mcp', {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ jsonrpc: '2.0', id: nextRpcId++, method: 'tools/call', params: { name, arguments: args } }),
  });
  const body = await res.json();
  assert.ok(body.result, `tools/call ${name} returned no result; body=${JSON.stringify(body)}`);
  return body.result;
}

describe('remoteId: one system, many targets', () => {
  let ctx, baseUrl, home, rootA, rootB;
  before(async () => { ctx = await bootServer(); ({ baseUrl } = ctx); });
  after(async () => { await ctx.close(); });
  beforeEach(async () => {
    ({ home } = await freshProjectsRoot());
    ctx.projectsRoot = process.env.PROJECTS_ROOT;
    rootA = await fs.realpath(await mkdtemp('cc-remote-a-'));
    rootB = await fs.realpath(await mkdtemp('cc-remote-b-'));
  });
  afterEach(async () => { await ctx.instances.shutdown(); disposeSystemHandles(); await rmrf(home); });

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
  //
  // NOT CLAIMING: anything about the pid this test kills. That pid is the
  // provider BEHIND the recorder, and when it dies is the fixture's business,
  // not cc's — the claim is about the generation cc observes.
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
    // The pid above is the REFERENCE PROVIDER, one level BELOW cc's own child:
    // the recorder wraps it (tests/fixtures/recordingProvider.mjs), so killing
    // it is the STIMULUS and never the signal. The recorder outlives it by the
    // event-loop hop its own `exit` handler costs (recordingProvider.mjs:41),
    // and until cc's child exits the generation is genuinely up — `ensureUp`
    // hands back the same handshake and the memoised probe correctly does not
    // re-ask. Waiting on the wrapped pid therefore raced cc's own observation
    // and lost 1 run in 6 in isolation (card 2026-0270). Wait on the
    // observation itself.
    process.kill(pid, 'SIGKILL');
    assert.equal(await settle(() => sys.handshake === null), true,
      'cc observed the connection die — the generation really ended');

    await systemById('boxes', 'a', 'test');
    assert.equal(await probes(), 2, 'a new connection generation is a new question');
  });

  // PINS: the probe asks ONE question — "do you serve this remote?" — and
  // ENOREMOTE is its only failure. A refusal with any OTHER code is the
  // provider answering ABOUT that remote, which is itself proof it serves it,
  // so resolution proceeds. Asserted head-on, and against a provider that
  // refuses the probe DELIBERATELY, so that "fixing" the ignored refusal into
  // a failure breaks a test that says why.
  test('a probe the provider refuses EACCES still resolves — only ENOREMOTE is a no', async () => {
    await addSystem({
      id: 'boxes', label: 'Boxes',
      launch: flakyLaunch({
        // The probe is the first exec on the connection, and it is the only
        // one that runs `true`.
        errorFrame: '"argv":\\["true"\\]', errorCode: 'EACCES',
        flags: ['--remote', `a=${rootA}`],
      }),
    });
    const sys = await systemById('boxes', 'a', 'test');
    assert.equal(sys.remoteId, 'a', 'a refused probe is not a refused remote');
    assert.equal(sys.id, 'boxes');
  });

  // PINS: the one answer that IS a no. Same fixture, same shape, one code
  // different — so the pair together says the rule rather than one example.
  test('a probe the provider refuses ENOREMOTE does not resolve', async () => {
    await addSystem({
      id: 'boxes', label: 'Boxes',
      launch: flakyLaunch({
        errorFrame: '"argv":\\["true"\\]', errorCode: 'ENOREMOTE',
        flags: ['--remote', `a=${rootA}`],
      }),
    });
    await assert.rejects(
      () => systemById('boxes', 'a', `project 'p'`),
      (e) => e.statusCode === 502 && e.code === 'REMOTE_NOT_FOUND',
    );
  });

  // ── Root scoping: a cross-target operation is refused, not answered ──

  // PINS: a file operation naming a path in ANOTHER target's tree is refused
  // rather than served. On a machine where every target is one filesystem this
  // is what stops a mis-bound read from returning plausible bytes.
  test('a path belonging to another target is refused, not read', async () => {
    const remote = await bindRemoteSystem({
      id: 'boxes', flags: ['--remote', `a=${rootA}`, '--remote', `b=${rootB}`],
    });
    const a = await systemById(remote.id, 'a', 'test');
    const b = await systemById(remote.id, 'b', 'test');
    await fs.writeFile(path.join(rootA, 'marker'), 'A');
    await fs.writeFile(path.join(rootB, 'marker'), 'B');

    assert.equal(await a.readFile(path.join(rootA, 'marker')), 'A');
    assert.equal(await b.readFile(path.join(rootB, 'marker')), 'B');
    await assert.rejects(
      () => b.readFile(path.join(rootA, 'marker')),
      (e) => e.code === 'EACCES',
      "the OTHER target's file is refused rather than answered",
    );
    await assert.rejects(
      () => b.writeFile(path.join(rootA, 'marker'), 'clobbered'),
      (e) => e.code === 'EACCES',
    );
    assert.equal(await fs.readFile(path.join(rootA, 'marker'), 'utf8'), 'A', 'and nothing was written');
  });

  // PINS: a command's cwd is scoped to its target too — EXCEPT the exact path
  // `/`, which is cc's placeholder for a derived command that carries its real
  // target in argv. Fencing that would refuse every stat, realpath and mkdir
  // while buying nothing, since a provider cannot fence argv.
  test("a command's cwd is scoped, and the placeholder / is exempt", async () => {
    const remote = await bindRemoteSystem({
      id: 'boxes', flags: ['--remote', `a=${rootA}`, '--remote', `b=${rootB}`],
    });
    const a = await systemById(remote.id, 'a', 'test');

    const wrong = await a.exec({ argv: ['true'] }, { cwd: rootB });
    assert.equal(wrong.spawnErrorCode, 'EACCES', "another target's directory is not a cwd this remote has");

    const own = await a.exec({ argv: ['true'] }, { cwd: rootA });
    assert.equal(own.code, 0);

    const placeholder = await a.exec({ argv: ['true'] }, { cwd: '/' });
    assert.equal(placeholder.spawnErrorCode, undefined, 'the placeholder cwd is not a reach into anything');
    assert.equal(placeholder.code, 0);
  });

  // PINS: every DERIVED operation's exec frame carries the binding of the
  // handle it was issued through. This is measured on the wire and not inferred
  // from an operation succeeding, because the derivations run at the exempt
  // cwd and carry their real target in argv — which the provider's fence never
  // inspects — so a mis-bound one would otherwise succeed silently against the
  // wrong target.
  test('every derived operation carries its binding on the wire', async () => {
    const rec = path.join(home, 'wire.ndjson');
    await addSystem({
      id: 'boxes', label: 'Boxes',
      launch: ['node', RECORDER, '--record', rec, '--remote', `a=${rootA}`, '--remote', `b=${rootB}`],
    });
    const a = await systemById('boxes', 'a', 'test');

    const dir = path.join(rootA, 'derived');
    const file = path.join(dir, 'f.txt');
    await a.mkdir(dir, { recursive: true });
    await a.writeFile(file, 'x');
    await a.stat(file);
    await a.readDir(dir);
    await a.realpath(dir);
    await a.chmod(file, 0o600);
    await a.unlink(file);
    await a.removeTree(dir);

    const execs = (await wire(rec)).filter(f => f.type === 'exec');
    // `env LC_ALL=C <tool>` is the derivation shape; the probe is the only
    // other exec, and it is bound too.
    const derived = execs.filter(f => Array.isArray(f.argv) && f.argv[0] === 'env');
    const tools = derived.map(f => f.argv[2]);
    for (const tool of ['mkdir', 'stat', 'find', 'realpath', 'chmod', 'unlink', 'rm']) {
      assert.ok(tools.includes(tool), `the ${tool} derivation was issued`);
    }
    for (const f of execs) {
      assert.equal(f.remoteId, 'a', `an exec running ${JSON.stringify(f.argv)} must name its target`);
    }
  });

  // ── The same two refusals, reached by system_bash ────────────────────
  //
  // Both pin that system_bash THREADS `remoteId` into systemById rather than
  // dropping it. The failure they exclude is a tool that silently runs on the
  // provider's default target and reports success — the misroute-as-success
  // this whole file exists to prevent, reached through a tool that names no
  // project at all.

  // PINS: naming a remote on a provider that does not serve remotes is
  // SYSTEM_NO_REMOTES (501) through system_bash. A dropped remoteId would
  // instead run the command on the default target and answer exitCode 0.
  test('system_bash with a remoteId on a remotes-less provider is SYSTEM_NO_REMOTES', async () => {
    const bare = await bindRemoteSystem({ id: 'bare' });
    const r = await callTool(baseUrl, 'system_bash', {
      system: bare.id, remoteId: 'a', command: 'echo hi', cwd: '/',
    });
    assert.equal(r.isError, true, JSON.stringify(r));
    const structured = JSON.parse(r.content[1].text);
    assert.equal(structured.code, 'SYSTEM_NO_REMOTES', JSON.stringify(structured));
    assert.equal(structured.statusCode, 501);
    assert.match(r.content[0].text, /bare/);
  });

  // PINS: `''` is the DEFAULT target even on a provider that does serve named
  // ones — it is not a target name. Without the empty-string normalisation it
  // reaches assertRemoteKnown, which this provider answers ENOREMOTE for, and
  // the caller gets a REMOTE_NOT_FOUND refusal about a remote it never named.
  // The far side still refuses the unbound exec itself (it serves only named
  // targets), but that arrives as the command's own answer in the payload, not
  // as cc refusing to resolve — which is exactly the distinction being pinned.
  test('system_bash treats an empty remoteId as the default target, not a named one', async () => {
    const remote = await bindRemoteSystem({ id: 'boxes', flags: ['--remote', `a=${rootA}`] });
    const r = await callTool(baseUrl, 'system_bash', {
      system: remote.id, remoteId: '', command: 'echo hi', cwd: rootA,
    });
    assert.equal(r.isError, undefined,
      `resolution must not refuse an empty remoteId: ${JSON.stringify(r)}`);
    const meta = JSON.parse(r.content[0].text);
    assert.equal(meta.remoteId, null, 'the metadata reports the default target, not the empty string');
  });

  // PINS: an unknown remote on a remotes-serving provider is REMOTE_NOT_FOUND
  // (502) through system_bash, and — the positive control on the same system —
  // a VALID remoteId runs and is echoed back in the metadata. Without the
  // second half the first would pass on a tool that refuses every remoteId.
  test('system_bash refuses an unknown remoteId and serves a known one', async () => {
    const remote = await bindRemoteSystem({ id: 'boxes', flags: ['--remote', `a=${rootA}`] });

    const bad = await callTool(baseUrl, 'system_bash', {
      system: remote.id, remoteId: 'typo', command: 'echo hi', cwd: rootA,
    });
    assert.equal(bad.isError, true, JSON.stringify(bad));
    const structured = JSON.parse(bad.content[1].text);
    assert.equal(structured.code, 'REMOTE_NOT_FOUND', JSON.stringify(structured));
    assert.equal(structured.statusCode, 502);
    assert.match(bad.content[0].text, /typo/);

    const good = await callTool(baseUrl, 'system_bash', {
      system: remote.id, remoteId: 'a', command: 'echo $CC_REMOTE', cwd: rootA,
    });
    assert.equal(good.isError, undefined, JSON.stringify(good));
    const meta = JSON.parse(good.content[0].text);
    assert.equal(meta.remoteId, 'a', 'the metadata echoes the target that served it');
    assert.equal(meta.exitCode, 0, JSON.stringify(meta));
    // Positively addressed: only the intended remote's child carries CC_REMOTE=a.
    assert.equal(good.content[1].text.trim(), 'a');
  });
});
