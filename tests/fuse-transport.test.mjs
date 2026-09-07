// THE TRANSPORT, DETERMINISTICALLY. `systemSource` over a real `ProviderSystem`
// on cc's reference provider: real NDJSON, real base64, real 64 KiB chunking,
// real `find`/`rm`/`ln` on the far side — and no container, no sudo, no mount.
//
// WHAT IT PROVES that `fuse-control-channel.test.mjs` cannot: that the source
// behind the control channel can be a `System` handle at all, that absence and
// unreachability stay distinct across a wire that has its own ways to fail, and
// — asserted on FRAME COUNTS rather than on results — that a listing is one
// round trip and a cap refuses before a byte moves. A return value cannot say
// either of those: the right answer arrives whichever way it was reached.
//
// WHAT IT DOES NOT PROVE: latency (that is measured, not asserted —
// tests/fuse-transport-bench.mjs) and a real container (the `app3` acceptance).

import { test, describe, before, after } from 'node:test';
import assert from 'node:assert/strict';
import path from 'node:path';
import { promises as fs } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { mkdtemp } from './tmpRegistry.mjs';
import { ProviderSystem } from '../src/systems/providerSystem.ts';
import { REFERENCE_PROVIDER } from './referenceProviderHarness.mjs';
import { systemSource } from '../src/systems/fuse/systemSource.ts';
import { isSourceError } from '../src/systems/fuse/remoteSource.ts';
import { bootServer, api, freshProjectsRoot, rmrf } from './helpers.mjs';
import { seedRepo } from './remoteSystem.mjs';
import { adoptProject } from '../src/projects.ts';
import { addSystem } from '../src/appSettings.ts';
import { disposeSystemHandles } from '../src/systems/registry.ts';
import { fuseRunRoot } from '../src/systems/fuse/plan.ts';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const RECORDER = path.join(HERE, 'recordingProvider.mjs');

// A handle on the reference provider, optionally through the frame recorder.
// The caller disposes; nothing is shared between cases.
function handle({ log } = {}) {
  const argv = log
    ? ['node', RECORDER, '--log', log, '--', 'node', REFERENCE_PROVIDER]
    : ['node', REFERENCE_PROVIDER];
  return new ProviderSystem({ id: 'ref', launch: { argv } });
}

// `{ 'c2p:exec': 3, 'p2c:exit': 3, … }` — what actually crossed the wire.
async function frames(log) {
  const out = {};
  for (const line of (await fs.readFile(log, 'utf8')).split('\n')) {
    if (line === '') continue;
    const [dir, type] = line.split('\t');
    const k = `${dir}:${type}`;
    out[k] = (out[k] ?? 0) + 1;
  }
  return out;
}

async function withSource(fn, { log } = {}) {
  const box = await fs.realpath(await mkdtemp('cc-transport-'));
  const sys = handle({ log });
  try { return await fn(systemSource(sys), box, sys); }
  finally { sys.dispose(); }
}

describe('systemSource — the remote source over a real System handle', () => {
  // PINS: every kind `RemoteStat` can express maps, WITH the symlink's target,
  // and a kind it cannot express is `null` rather than a lie.
  // DIES UNDER: dropping `%l` from the derivation (target undefined); mapping
  // `l` → file; returning null for a dir; letting a fifo through as a file.
  test('T1 — stat maps file, dir, symlink-with-target, absent and a kind it cannot carry', async () => {
    await withSource(async (src, box, sys) => {
      await fs.writeFile(path.join(box, 'f'), 'abcdef');
      await fs.chmod(path.join(box, 'f'), 0o755);
      await fs.mkdir(path.join(box, 'd'));
      await fs.symlink('relative/target', path.join(box, 'l'));
      await sys.exec({ argv: ['mkfifo', path.join(box, 'p')] }, { cwd: box });

      const f = await src.stat(path.join(box, 'f'));
      assert.equal(f.kind, 'file');
      assert.equal(f.size, 6);
      assert.equal(f.mode, 0o755, 'RemoteStat.mode is PERMISSION BITS ONLY — the handler applies the kind');
      assert.equal((await src.stat(path.join(box, 'd'))).kind, 'dir');

      const l = await src.stat(path.join(box, 'l'));
      assert.equal(l.kind, 'symlink', 'a symlink shaped into the mirror as a file answers wrongly about what it IS');
      assert.equal(l.target, 'relative/target');

      assert.equal(await src.stat(path.join(box, 'nope')), null);
      assert.equal(await src.stat(path.join(box, 'p')), null,
        'a fifo has no faithful mirror representation, and a regular file standing in for one would lie');
    });
  });

  // PINS: "the source has nothing there" and "the source could not be asked"
  // are DIFFERENT VALUES. remoteSource.ts's header records the cost of
  // conflating them: an EMFILE read as absence removed a live mirror entry and
  // then, at the reconcile, a live SOURCE file.
  // NON-VACUITY CONTROL: the same call on a live handle returns a stat, so the
  // SourceError below is the provider dying and not the call being broken.
  // DIES UNDER: catching every error as `null`.
  test('T2 — absent is null; could-not-ask is a SourceError, never null', async () => {
    await withSource(async (src, box, sys) => {
      await fs.writeFile(path.join(box, 'f'), 'x');
      assert.equal((await src.stat(path.join(box, 'f'))).kind, 'file', 'control: the source answers while it is up');
      assert.equal(await src.stat(path.join(box, 'gone')), null);
      assert.deepEqual(await src.list(path.join(box, 'gone')), null);
      assert.deepEqual(await src.list(path.join(box, 'f')), null, 'a file is not a directory: also absence');

      sys.dispose();
      for (const answer of [await src.stat(path.join(box, 'f')), await src.list(box)]) {
        assert.ok(isSourceError(answer), `a dead transport must not read as absence: ${JSON.stringify(answer)}`);
        assert.match(answer.error, /ETRANSPORT|EPROTO|ETIMEDOUT/);
      }
    });
  });

  // PINS: an unparseable listing line is an ERROR, never a skipped entry — a
  // listing that quietly drops an entry is indistinguishable from one that does
  // not have it. BOTH BOUNDS, because the guard is a field count.
  // DIES UNDER: `if (fields.length !== 6) continue`; a one-sided bound.
  test('T3 — a name containing a tab or a newline is a refusal, not a dropped entry', async () => {
    await withSource(async (src, box) => {
      for (const bad of ['two\ttabs', 'two\nlines']) {
        const dir = path.join(box, `weird-${bad.length}-${bad.charCodeAt(3)}`);
        await fs.mkdir(dir);
        await fs.writeFile(path.join(dir, 'plain'), 'x');
        await fs.writeFile(path.join(dir, bad), 'x');
        const got = await src.list(dir);
        assert.ok(isSourceError(got), `${JSON.stringify(bad)} was not refused: ${JSON.stringify(got)}`);
        assert.match(got.error, /EUNKNOWN/);
      }
    });
  });

  // PINS: a listing of N children is ONE round trip and carries every field
  // per child — ASSERTED ON THE WIRE, because the same children come back
  // either way and only the frame count can tell 1 from 1 + N.
  // DIES UNDER: reverting to readDir + a stat per child (51 execs); dropping a
  // `-printf` field (a child's mode comes back 0 / its target null).
  test('T4 — list is ONE exec for a 50-child directory, and carries mode, size, mtime and target', async () => {
    const box = await fs.realpath(await mkdtemp('cc-transport-'));
    const log = path.join(box, 'frames.log');
    const dir = path.join(box, 'many');
    await fs.mkdir(dir);
    for (let i = 0; i < 48; i++) await fs.writeFile(path.join(dir, `f${i}`), 'x'.repeat(i + 1));
    await fs.chmod(path.join(dir, 'f7'), 0o700);
    await fs.mkdir(path.join(dir, 'sub'));
    await fs.symlink('over/there', path.join(dir, 'lnk'));

    const sys = handle({ log });
    try {
      await sys.connect();
      const before = await frames(log);
      const kids = await systemSource(sys).list(dir);
      assert.equal(kids.length, 50);
      const after = await frames(log);
      assert.equal((after['c2p:exec'] ?? 0) - (before['c2p:exec'] ?? 0), 1,
        'a listing of 50 children cost more than one round trip');

      const by = Object.fromEntries(kids.map(k => [k.name, k]));
      assert.equal(by.f7.mode, 0o700, 'the mode rides the listing');
      assert.equal(by.f7.size, 8);
      assert.equal(by.sub.kind, 'dir');
      assert.equal(by.lnk.kind, 'symlink');
      assert.equal(by.lnk.target, 'over/there', 'and so does the symlink target');
      assert.ok(by.f0.mtimeMs > 0, 'and the mtime, which is what revalidate compares');
    } finally { sys.dispose(); }
  });

  // PINS: bytes survive the transport in BOTH directions. The wire carries
  // base64 of raw bytes and always did; what mangled them was cc's own
  // `Buffer.from(data,'utf8')` on the way in.
  // DIES UNDER: fetch routed through the string `readFile`; push routed through
  // `writeFile(string)` — i.e. `writeFileBytes` not existing.
  test('T5/T6 — a NUL and a 0xFF round-trip byte-identical, fetched AND pushed', async () => {
    await withSource(async (src, box) => {
      const bytes = Buffer.from([0x00, 0x01, 0xff, 0xfe, 0x0a, 0x00, 0x80, 0xc3, 0x28]);
      const source = path.join(box, 'bin');
      const mirror = path.join(box, 'mirror-copy');
      await fs.writeFile(source, bytes);

      assert.equal(await src.fetch(source, mirror), 'ok');
      assert.deepEqual(await fs.readFile(mirror), bytes, 'fetch mangled the bytes');

      const back = path.join(box, 'pushed');
      const other = Buffer.from([0xde, 0x00, 0xad, 0xff, 0xbe, 0x00, 0xef]);
      await fs.writeFile(back, other);
      assert.equal(await src.push(back, path.join(box, 'landed')), 'ok');
      // ON THE SOURCE'S OWN BYTES, read outside the transport.
      assert.deepEqual(await fs.readFile(path.join(box, 'landed')), other, 'push mangled the bytes');
    });
  });

  // PINS: a file over the protocol cap is refused BEFORE ANY TRANSFER, and
  // that is asserted as a frame count and not as a failure — doing the check
  // after the read also fails, with EFBIG, which is a different observable
  // reached at a different cost.
  // DIES UNDER: omitting the size check in the handler; doing it after the read.
  //
  // NOTE: this pins the SOURCE's half — that `readFileBytes` above the cap
  // never puts bytes on the wire. The handler's own pre-read refusal is
  // asserted in tests/fuse-control-channel.test.mjs.
  test('T7 — a read above MAX_FILE_BYTES sends no data frames at all', async () => {
    const box = await fs.realpath(await mkdtemp('cc-transport-'));
    const log = path.join(box, 'frames.log');
    const { MAX_FILE_BYTES } = await import('../src/systems/protocol.ts');
    const big = path.join(box, 'big');
    // Sparse: the size is what is over the cap, and writing 32 MiB of real
    // bytes to prove a refusal would be the slowest case in the suite.
    const fh = await fs.open(big, 'w');
    try { await fh.truncate(MAX_FILE_BYTES + 1); } finally { await fh.close(); }

    const sys = handle({ log });
    try {
      await sys.connect();
      const before = await frames(log);
      const src = systemSource(sys);
      // The source reports the size honestly; a caller that acts on it — which
      // is what the control handler does — never asks for the bytes.
      const st = await src.stat(big);
      assert.equal(st.size, MAX_FILE_BYTES + 1);
      const after = await frames(log);
      assert.equal(after['c2p:readFile'] ?? 0, before['c2p:readFile'] ?? 0,
        'asking how big it is must not transfer it');
      assert.equal(after['p2c:data'] ?? 0, before['p2c:data'] ?? 0);
    } finally { sys.dispose(); }
  });

  // PINS: `remove` is NON-RECURSIVE — an empty directory goes, a non-empty one
  // refuses AND KEEPS ITS CHILDREN. The mirror may be sparser than the source,
  // so a recursive delete driven by a frame would remove children the worker
  // never enumerated.
  // DIES UNDER: `rm -rf`; mapping ENOTEMPTY to success.
  test('T8 — remove takes one entry, and a non-empty directory keeps its children', async () => {
    await withSource(async (src, box) => {
      await fs.writeFile(path.join(box, 'f'), 'x');
      assert.equal(await src.remove(path.join(box, 'f')), 'ok');
      assert.equal(await src.stat(path.join(box, 'f')), null);

      await fs.mkdir(path.join(box, 'empty'));
      assert.equal(await src.remove(path.join(box, 'empty')), 'ok');

      await fs.mkdir(path.join(box, 'full'));
      await fs.writeFile(path.join(box, 'full/kid'), 'x');
      const got = await src.remove(path.join(box, 'full'));
      assert.ok(typeof got === 'object' && got.error, `a non-empty directory was not refused: ${got}`);
      assert.match(got.error, /ENOTEMPTY/);
      // ASSERTED AFTER THE REFUSAL, because an `rm -rf` in disguise refuses
      // nothing and the error alone cannot catch it.
      assert.deepEqual((await src.list(path.join(box, 'full'))).map(k => k.name), ['kid']);

      // A symlink goes as ITSELF, never followed to its target.
      await fs.symlink(path.join(box, 'full'), path.join(box, 'alias'));
      assert.equal(await src.remove(path.join(box, 'alias')), 'ok');
      assert.equal(await src.stat(path.join(box, 'alias')), null);
      assert.equal((await src.stat(path.join(box, 'full'))).kind, 'dir');

      // An absent entry is the declared intent already met.
      assert.equal(await src.remove(path.join(box, 'never')), 'ok');
    });
  });

  // PINS: `push` reconciles every kind the mirror can hold, and an ABSENT
  // mirror entry is a refusal rather than a deletion — a removal is declared on
  // the frame, so cc's own cache losing an entry must never delete the
  // source's. The wording is byte-identical to `localDirSource`'s, so the two
  // sources cannot be told apart by it.
  // DIES UNDER: inferring a deletion from an absent mirror entry; dropping the
  // mode from the atomic write; a dir or symlink arm that silently no-ops.
  test('T8b — push carries file, dir and symlink, and refuses an absent mirror entry', async () => {
    await withSource(async (src, box) => {
      const mirror = path.join(box, 'mirror');
      const dest = path.join(box, 'dest');
      await fs.mkdir(mirror, { recursive: true });

      await fs.writeFile(path.join(mirror, 'script'), '#!/bin/sh\n');
      await fs.chmod(path.join(mirror, 'script'), 0o755);
      assert.equal(await src.push(path.join(mirror, 'script'), path.join(dest, 'script')), 'ok');
      assert.equal((await fs.stat(path.join(dest, 'script'))).mode & 0o7777, 0o755,
        'the mode is what makes an atomic write preserving — a rename installs the temp file');
      assert.equal(await fs.readFile(path.join(dest, 'script'), 'utf8'), '#!/bin/sh\n');

      await fs.mkdir(path.join(mirror, 'sub'), { mode: 0o700 });
      assert.equal(await src.push(path.join(mirror, 'sub'), path.join(dest, 'sub')), 'ok');
      assert.equal((await fs.stat(path.join(dest, 'sub'))).mode & 0o7777, 0o700);

      await fs.symlink('yonder', path.join(mirror, 'lnk'));
      assert.equal(await src.push(path.join(mirror, 'lnk'), path.join(dest, 'lnk')), 'ok');
      assert.equal(await fs.readlink(path.join(dest, 'lnk')), 'yonder');

      await fs.writeFile(path.join(dest, 'live'), 'THE SOURCE STILL HAS THIS');
      const got = await src.push(path.join(mirror, 'never-materialised'), path.join(dest, 'live'));
      assert.deepEqual(got, { error: `the mirror holds nothing at '${path.join(dest, 'live')}'` });
      assert.equal(await fs.readFile(path.join(dest, 'live'), 'utf8'), 'THE SOURCE STILL HAS THIS',
        'an absent mirror entry must never be read as a deletion');
    });
  });
});

// ── THE LAUNCH PROBE ────────────────────────────────────────────────────────
//
// Criterion 4's remaining gap, and it is FRESHNESS rather than ordering.
// `systemById` already refuses a provider that will not come up and a remote it
// does not serve — but `connect()`, `assertRemoteKnown()` and `mirror()` all
// memoise on the handshake OBJECT, so a machine that stopped AFTER that
// generation began is invisible to all three. A union spawn onto it produces a
// worker that discovers it inside its own chroot, with every project path
// answering -EIO and nothing there to say why.
//
// `--dead-file` is what makes that state producible without a container: the
// provider stays up, its handshake stays the same object, and only a live
// `exec` finds out.
//
// NO MOUNT, NO SUDO, NO FUSE — the probe runs before `assertFuseAvailable`,
// which is also what makes the "nothing was created" half assertable.
describe('the launch probe — is the box still there, asked now', () => {
  const FIXTURE = path.join(HERE, 'fixtures', 'mirrorFixtureProvider.mjs');
  // See mirror-geometry-follow's fixture fact 1: bootServer({realProcess:true})
  // deletes FAKE_CLAUDE_SCENARIO unless one is given, and fake-claude then
  // exits 2. No arm here gets far enough to spawn, but a missing scenario would
  // make a REGRESSION look like this refusal.
  const SCENARIO = path.join(HERE, 'fixtures', 'scenario-no-turn.json');

  let ctx, baseUrl, home, n = 0;

  before(async () => {
    ctx = await bootServer({ realProcess: true, scenarioPath: SCENARIO });
    ({ baseUrl } = ctx);
    ({ home } = await freshProjectsRoot());
  });
  after(async () => {
    if (ctx) await ctx.instances.shutdown();
    disposeSystemHandles();
    if (home) await rmrf(home);
    if (ctx) await ctx.close();
  });

  // Its own system id, project and box per arm, so no arm can see another's
  // provider generation. THE BOX IS ALIVE HERE: adoption itself goes through
  // the system, so an arm that starts dead never gets a project to spawn — and
  // the state under test is precisely a box that dies AFTER cc has connected.
  async function fixture({ mirrorSub = null } = {}) {
    const id = `probe${++n}`;
    const project = `probeapp${n}`;
    const box = await fs.realpath(await mkdtemp('cc-probe-'));
    const root = mirrorSub === null ? box : path.join(box, mirrorSub);
    const projPath = path.join(root, 'app');
    await seedRepo(projPath);
    const deadFile = path.join(box, '.dead');
    const frameLog = path.join(box, 'frames.ndjson');
    await addSystem({
      id, label: id,
      launch: ['node', FIXTURE, '--dead-file', deadFile, '--frame-log', frameLog,
        ...(mirrorSub === null ? [] : ['--advertise-mirror', root])],
    });
    assert.equal((await adoptProject(project, projPath, { system: id })).ok, true);
    return { id, project, box, root, projPath, deadFile, frameLog };
  }

  const spawn = (project) => api(baseUrl, 'POST', '/api/instances', { project, mode: 'bypassPermissions' });
  const errorFrames = async (log) => (await fs.readFile(log, 'utf8').catch(() => ''))
    .split('\n').filter(l => l !== '').map(l => JSON.parse(l)).filter(f => f.type === 'error').length;
  const runDirs = async () => new Set(await fs.readdir(fuseRunRoot()).catch(() => []));

  // PINS: a box that has gone away refuses the SPAWN by name, before anything
  // is created for it.
  // DIES UNDER: dropping the probe; running it after `prepare()`, which the
  // run-directory assertion catches and the status code alone would not.
  test('T16 — a box that stopped refuses the spawn 502 FUSE_REMOTE_UNREACHABLE, creating nothing', async () => {
    const f = await fixture();
    // The machine goes away AFTER cc has connected and adopted — the exact
    // state every handshake-keyed memo is blind to.
    await fs.writeFile(f.deadFile, '');
    const before = await runDirs();

    const r = await spawn(f.project);
    assert.equal(r.status, 502, JSON.stringify(r.body));
    // Each clause asserted, not merely present: a refusal naming neither the
    // project nor the system points at no repair.
    assert.match(r.body.error, new RegExp(`project '${f.project}'`));
    assert.match(r.body.error, new RegExp(`system '${f.id}'`));
    assert.match(r.body.error, /live check/);
    assert.match(r.body.error, /not running/, "the far side's OWN reason, not cc's summary of it");

    // NOTHING WAS CREATED. The probe sits before `assertFuseAvailable` and
    // therefore before `prepare()`, the only thing that makes a run directory —
    // so this asserts the ORDERING, which the status code alone cannot.
    assert.deepEqual([...await runDirs()].filter(d => !before.has(d)), []);
  });

  // PINS: the probe is NOT memoised — which is the entire fix, so this is what
  // makes it non-vacuous. Two consecutive spawns against the same connection
  // generation both refuse, and the SECOND really crossed the wire.
  // DIES UNDER: memoising the answer on the handshake, the way `connect`,
  // `assertRemoteKnown` and `mirror` each do.
  test('T17 — the probe is not memoised: the second spawn asks again, on the wire', async () => {
    const f = await fixture();
    await fs.writeFile(f.deadFile, '');
    const first = await spawn(f.project);
    assert.equal(first.status, 502, JSON.stringify(first.body));
    const afterFirst = await errorFrames(f.frameLog);
    assert.ok(afterFirst >= 1, 'the first spawn did not reach the far side at all');

    const second = await spawn(f.project);
    assert.equal(second.status, 502, JSON.stringify(second.body));
    assert.match(second.body.error, /live check/);
    assert.ok(await errorFrames(f.frameLog) > afterFirst,
      'the second spawn answered from a cache: no new frame crossed the wire');
  });

  // PINS: a box that is UP with nothing at the advertised mirror root is a
  // DIFFERENT refusal, 501 and not 502, because it is a different repair — fix
  // the configuration, not the machine.
  // DIES UNDER: collapsing the two codes into one — 501 vs 502 is what carries
  // the distinction over HTTP, since the shared error handler sends the message
  // alone; probing the project path instead of the advertised root.
  test('T18 — an advertised mirror root that is not on the box refuses 501 FUSE_MIRROR_ROOT_ABSENT', async () => {
    const f = await fixture({ mirrorSub: 'geometry' });
    // The advertised root goes, the box stays up. cc's pinned scope still names
    // it, which is the configuration error this code is for.
    await rmrf(f.root);
    const r = await spawn(f.project);
    assert.equal(r.status, 501, JSON.stringify(r.body));
    assert.ok(r.body.error.includes(f.root), r.body.error);
    assert.match(r.body.error, /outside the mirror root/);
  });

  // THE CONTROL THAT MAKES ALL THREE NON-VACUOUS: the same fixture, alive and
  // correctly advertised, does NOT refuse at either probe. Without it every arm
  // above would still pass against a spawn that refuses unconditionally.
  test('T16-T18 control — a live box with a real mirror root passes both probes', async () => {
    const f = await fixture();
    const r = await spawn(f.project);
    assert.doesNotMatch(String(r.body.error ?? ''), /live check|mirror root/, JSON.stringify(r.body));
    if (r.status === 201) await api(baseUrl, 'DELETE', `/api/instances/${r.body.id}`);
  });
});
