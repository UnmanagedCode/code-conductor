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
// tests/fuse-transport-bench.mjs) and a real container.
//
// NOTHING HERE MOUNTS, AND THAT IS MAINTAINED RATHER THAN INHERITED. A spawn
// that SUCCEEDS attaches `_fuse`, runs the full preflight and makes a real
// mount, which would redden the file on any host without `/dev/fuse` or
// `sudo -n` — the exact hosts this header claims immunity from — and would add
// a participant to the only real-mount contention in `npm test`.
// The refusal arms are safe and stay: their probe runs BEFORE
// `assertFuseAvailable` and `prepare()`, which is asserted by T16's
// no-run-directory check. Anything needing a SUCCESSFUL spawn is driven at the
// level of the function under test instead.

import { test, describe, before, after } from 'node:test';
import assert from 'node:assert/strict';
import path from 'node:path';
import { promises as fs } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { mkdtemp } from './tmpRegistry.mjs';
import { ProviderSystem } from '../src/systems/providerSystem.ts';
import { REFERENCE_PROVIDER } from './referenceProviderHarness.mjs';
import { systemSource } from '../src/systems/fuse/systemSource.ts';
import { isSourceError, localDirSource } from '../src/systems/fuse/remoteSource.ts';
import { bootServer, api, freshProjectsRoot, rmrf } from './helpers.mjs';
import { seedRepo } from './remoteSystem.mjs';
import { adoptProject } from '../src/projects.ts';
import { addSystem } from '../src/appSettings.ts';
import { disposeSystemHandles } from '../src/systems/registry.ts';

// One line per LIVENESS PROBE the fixture received — see its `--probe-log`.
const probeCount = async (log) =>
  (await fs.readFile(log, 'utf8').catch(() => '')).split('\n').filter(l => l !== '').length;
import { fuseRunRoot } from '../src/systems/fuse/plan.ts';
import { assertRemoteLive } from '../src/systems/registry.ts';
import net from 'node:net';
import { ControlServer, encodeRequest, CCU_OP, CCU_STATUS, CCU_FLAG_FOR_WRITE,
  CCU_FLAG_RELEASE_ONLY } from '../src/systems/fuse/control.ts';
import { buildTierTable } from '../src/systems/fuse/tierTable.ts';
import { tierFixtureInput } from './tierFixture.mjs';
import { MAX_FILE_BYTES } from '../src/systems/protocol.ts';

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

// `{ 'c2p:exec:argv': 3, 'p2c:exit': 3, … }` — what actually crossed the wire.
// The log's columns are `<epoch-ms> <dir> <type> <id>`; only the last three
// matter here, and the timestamp is the bench's and the gate's business.
// An `exec` is tagged `argv` (a derivation) or `shell` (a redirected Bash
// command); see tests/recordingProvider.mjs for why the two must not be one
// count.
async function frames(log) {
  const out = {};
  for (const line of (await fs.readFile(log, 'utf8')).split('\n')) {
    if (line === '') continue;
    const [, dir, type] = line.split('\t');
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
      assert.equal((after['c2p:exec:argv'] ?? 0) - (before['c2p:exec:argv'] ?? 0), 1,
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

  // PINS: the SIZE of an over-cap file is reported honestly and asking for it
  // is not itself a transfer — the input the handler's refusal is made from.
  //
  // A CONTROL, NOT A CAP TEST, and labelled as one after review: no
  // implementation issues a `readFile` from a `stat` on any path, so the frame
  // assertion below holds with the cap check deleted, moved after the read, or
  // never written. **T7b is where the cap is pinned.** This case claims no kill
  // of its own, because a claim that cannot fail is worse than an absent one:
  // it is counted.
  test('T7 control — a stat reports an over-cap size and transfers nothing by itself', async () => {
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
  // mode from the atomic write; a dir or symlink arm that silently no-ops;
  // dropping the wrong-kind retry (the two sources then disagree); widening
  // that retry to a recursive removal (the non-empty arm then succeeds).
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

      // A KIND CHANGE, EVERY DIRECTION, and asserted against `localDirSource`'s
      // answer for the same mirror state rather than against a remembered one.
      // The deterministic suite only stands in for the transport while the two
      // sources agree, and they did not: `mkdir -p` over a file is EEXIST and
      // `ln -sfnT` over a directory is EISDIR, where `localDirSource` removes
      // the wrong-kind entry first and succeeds.
      const localMirror = path.join(box, 'lmirror');
      const localDest = path.join(box, 'ldest');
      await fs.mkdir(localMirror, { recursive: true });
      await fs.mkdir(localDest, { recursive: true });
      const local = localDirSource('/');
      const KIND_CHANGES = [
        ['dirOverFile', async (m, d, n) => {
          await fs.mkdir(path.join(m, n), { recursive: true });
          await fs.writeFile(path.join(d, n), 'was a file');
        }],
        ['fileOverDir', async (m, d, n) => {
          await fs.writeFile(path.join(m, n), 'now a file');
          await fs.mkdir(path.join(d, n), { recursive: true });
        }],
        ['linkOverDir', async (m, d, n) => {
          await fs.symlink('somewhere', path.join(m, n));
          await fs.mkdir(path.join(d, n), { recursive: true });
        }],
        ['linkOverFile', async (m, d, n) => {
          await fs.symlink('elsewhere', path.join(m, n));
          await fs.writeFile(path.join(d, n), 'was a file');
        }],
        // SIX DIRECTIONS, NOT FOUR. These two are the ones nothing fails on,
        // which is why they were missing and why they are the dangerous pair:
        // `mkdir -p` over a symlink-to-directory exits 0 leaving the LINK, and
        // `chmod` then follows it. Both sources reply 'ok', so a result
        // comparison is blind — the landed KIND is the only observable, which
        // is what the assertion below reads.
        ['dirOverSymlink', async (m, d, n) => {
          await fs.mkdir(path.join(m, n), { recursive: true });
          await fs.mkdir(path.join(d, `${n}-target`), { recursive: true });
          await fs.symlink(path.join(d, `${n}-target`), path.join(d, n));
        }],
        ['dirOverSymlinkToFile', async (m, d, n) => {
          await fs.mkdir(path.join(m, n), { recursive: true });
          await fs.writeFile(path.join(d, `${n}-target`), 'x');
          await fs.symlink(path.join(d, `${n}-target`), path.join(d, n));
        }],
      ];
      for (const [name, make] of KIND_CHANGES) {
        await make(mirror, dest, name);
        await make(localMirror, localDest, name);
        const viaSystem = await src.push(path.join(mirror, name), path.join(dest, name));
        const viaLocal = await local.push(path.join(localMirror, name), path.join(localDest, name));
        assert.deepEqual(viaSystem, viaLocal, `${name}: the two sources disagree`);
        assert.equal(viaSystem, 'ok', name);
        // THE LANDED KIND, on both, compared to each other AND to the mirror's.
        // The result is 'ok' on both for every direction here, so it can only
        // be the kind that catches a push that landed the wrong thing — or, in
        // the symlink directions, landed it somewhere else entirely.
        const kindAt = async (base) => {
          const st = await fs.lstat(path.join(base, name));
          return st.isSymbolicLink() ? 'symlink' : st.isDirectory() ? 'dir' : 'file';
        };
        assert.equal(await kindAt(dest), await kindAt(localDest), `${name}: different kind landed`);
        assert.equal(await kindAt(dest), await kindAt(mirror),
          `${name}: the source's kind does not match the mirror's, which is what a reconcile MEANS`);
      }
      // …AND THE ONE THEY BOTH REFUSE: a NON-EMPTY directory. `removeEntry` is
      // non-recursive by contract, so neither may take children the worker
      // never enumerated.
      await fs.writeFile(path.join(mirror, 'busy'), 'a file now');
      await fs.mkdir(path.join(dest, 'busy'), { recursive: true });
      await fs.writeFile(path.join(dest, 'busy', 'kid'), 'x');
      const busy = await src.push(path.join(mirror, 'busy'), path.join(dest, 'busy'));
      assert.ok(typeof busy === 'object' && busy.error, `a non-empty directory was replaced: ${busy}`);
      assert.match(busy.error, /ENOTEMPTY/);
      assert.deepEqual((await fs.readdir(path.join(dest, 'busy'))), ['kid']);

      await fs.writeFile(path.join(dest, 'live'), 'THE SOURCE STILL HAS THIS');
      const got = await src.push(path.join(mirror, 'never-materialised'), path.join(dest, 'live'));
      assert.deepEqual(got, { error: `the mirror holds nothing at '${path.join(dest, 'live')}'` });
      assert.equal(await fs.readFile(path.join(dest, 'live'), 'utf8'), 'THE SOURCE STILL HAS THIS',
        'an absent mirror entry must never be read as a deletion');
    });
  });
});

// ── PER-OPEN REVALIDATE ─────────────────────────────────────────────────────
//
// Before this, EVERY open of a project file copied the whole file: `#shape`
// could skip re-truncating a stub whose size and ms-mtime matched, but the copy
// after it ran unconditionally. Against a local directory that is a `copyFile`;
// across a wire it is the whole file, per open, for the life of the session.
//
// BOTH DIRECTIONS ARE THE TEST, and they are each other's control: a skip that
// is unconditional passes the first arm and fails the second, and a copy that
// is unconditional does the reverse. Asserted on `readFile` FRAMES, because the
// bytes are correct either way and only the wire can tell them apart.
// One request, one reply. Settles on a clean FIN too.
function call(sock, op, flags, p) {
  return new Promise((resolve, reject) => {
    let buf = Buffer.alloc(0);
    const done = (fn, v) => {
      sock.off('data', onData); sock.off('error', onErr);
      sock.off('end', onEnd); sock.off('close', onEnd);
      fn(v);
    };
    const onErr = (e) => done(reject, e);
    const onEnd = () => done(reject, new Error(`control socket closed with no reply to op ${op} '${p}'`));
    const onData = (c) => {
      buf = Buffer.concat([buf, c]);
      if (buf.length < 14) return;
      done(resolve, { status: buf[4], err: buf.readInt32BE(6) });
    };
    sock.on('data', onData); sock.on('error', onErr);
    sock.on('end', onEnd); sock.on('close', onEnd);
    sock.write(encodeRequest(op, flags, p));
  });
}

// A real ControlServer on a real socket, over `systemSource` on a recorded
// reference provider — so a frame count here is the transport's, not a mock's.
//
// `wrapSource` composes over the real `systemSource` — it is how a case drives
// a BOX-SIDE WRITER landing at a chosen instant, which no timing can do
// deterministically. The wrapper's own filesystem writes go straight to the
// source tree (the reference provider's far side IS this filesystem), so they
// cost no provider frame and leave every count in this file the transport's.
async function rig(fn, { wrapSource = (s) => s } = {}) {
  const box = await fs.realpath(await mkdtemp('cc-reval-'));
  const log = path.join(box, 'frames.log');
  const src = path.join(box, 'srv', 'app');
  const mirror = path.join(box, 'mirror');
  await fs.mkdir(src, { recursive: true });
  await fs.mkdir(mirror, { recursive: true });
  const sys = handle({ log });
  let server, sock;
  try {
    await sys.connect();
    server = await ControlServer.listen({
      socketPath: path.join(box, 'control.sock'),
      mirror,
      source: wrapSource(systemSource(sys)),
      tiers: buildTierTable(tierFixtureInput({ systemPath: src, mirrorRoot: src })),
    });
    sock = await new Promise((res, rej) => {
      const c = net.connect(server.socketPath, () => res(c)); c.once('error', rej);
    });
    const reads = async () => (await frames(log))['c2p:readFile'] ?? 0;
    const writes = async () => (await frames(log))['c2p:writeFile'] ?? 0;
    // EVERY cc→provider FRAME, whatever its type. A refusal that claims to
    // have touched the source at all cannot be caught by a per-type count:
    // the derivations ride `exec:argv`, the transfers ride
    // `readFile`/`writeFile`, and "no round trip happened" is a claim about
    // the sum.
    const wire = async () => Object.entries(await frames(log))
      .filter(([k]) => k.startsWith('c2p:'))
      .reduce((n, [, v]) => n + v, 0);
    return await fn({ src, mirror, sock, server,
      call: (op, flags, p) => call(sock, op, flags, p), reads, writes, wire });
  } finally {
    sock?.destroy();
    await server?.close();
    sys.dispose();
  }
}

describe('per-open revalidate — the mirror is not re-downloaded for nothing', () => {


  // PINS: an unchanged source file is fetched ONCE, and a changed one is
  // fetched again. Two arms, each the other's control.
  // DIES UNDER: skipping unconditionally (arm 2 fails); copying
  // unconditionally, i.e. not adding revalidate at all (arm 1 fails).
  test('T9 — a second FETCH of an unchanged file transfers nothing; a changed one transfers again', async () => {
    await rig(async ({ src, mirror, call, reads }) => {
      const p = path.join(src, 'note.txt');
      await fs.writeFile(p, 'FIRST');
      const base = await reads();
      assert.equal((await call(CCU_OP.FETCH, 0, p)).status, CCU_STATUS.READY);
      assert.equal(await reads(), base + 1, 'the cold open must transfer');
      assert.equal(await fs.readFile(path.join(mirror, p), 'utf8'), 'FIRST');

      assert.equal((await call(CCU_OP.FETCH, 0, p)).status, CCU_STATUS.READY);
      assert.equal(await reads(), base + 1, 'the WARM open re-downloaded a file that had not changed');
      assert.equal(await fs.readFile(path.join(mirror, p), 'utf8'), 'FIRST');

      // A source-side change, at a DIFFERENT SIZE and a later mtime — the two
      // fields the fingerprint carries.
      await fs.writeFile(p, 'SECOND WRITE, LONGER');
      assert.equal((await call(CCU_OP.FETCH, 0, p)).status, CCU_STATUS.READY);
      assert.equal(await reads(), base + 2, 'a changed source file was served stale');
      assert.equal(await fs.readFile(path.join(mirror, p), 'utf8'), 'SECOND WRITE, LONGER');
    });
  });

  // PINS: the fingerprint carries the MIRROR INODE, and that is what makes it
  // sound rather than merely fast. Source size and mtime alone would let cc
  // skip a copy for a mirror entry that is no longer the one it recorded —
  // serving whatever now sits at that path as though it were fresh.
  // DIES UNDER: dropping `ino` from the fingerprint.
  test('T10 — a mirror entry replaced under cc is fetched again, though the source never moved', async () => {
    await rig(async ({ src, mirror, call, reads }) => {
      const p = path.join(src, 'note.txt');
      await fs.writeFile(p, 'SOURCE BYTES');
      const base = await reads();
      assert.equal((await call(CCU_OP.FETCH, 0, p)).status, CCU_STATUS.READY);
      assert.equal(await reads(), base + 1);

      // REPLACE the mirror entry at the same path, same size and same mtime,
      // different inode — which is exactly what a rename over it produces.
      const dest = path.join(mirror, p);
      const was = await fs.stat(dest);
      const tmp = `${dest}.other`;
      await fs.writeFile(tmp, 'IMPOSTOR!!!');
      await fs.utimes(tmp, was.atime, was.mtime);
      await fs.rename(tmp, dest);
      assert.notEqual((await fs.stat(dest)).ino, was.ino, 'the fixture did not actually replace the inode');

      assert.equal((await call(CCU_OP.FETCH, 0, p)).status, CCU_STATUS.READY);
      assert.equal(await reads(), base + 2, 'cc served a mirror entry it had not put there as fresh');
      assert.equal(await fs.readFile(dest, 'utf8'), 'SOURCE BYTES');
    });
  });

  // PINS: a file over the protocol cap is refused with NO TRANSFER ATTEMPTED,
  // and the frame count is the assertion rather than the failure — checking
  // after the read also fails, with EFBIG, but only after up to 32 MiB of
  // base64 has crossed the wire to be discarded. `ProviderSystem.#read`'s fence
  // counts what cc KEEPS, not what crosses: the provider streams until cc's
  // accumulation passes the cap and only then does cc send `close`. So the two
  // orderings differ in cost, not in outcome, and only a frame count separates
  // them.
  //
  // THIS IS THE CAP'S ONLY PIN. T7 above is a size control and cannot fail.
  // DIES UNDER: omitting the check; moving it after `source.fetch`; widening
  // the comparison to `>=` (the control below is at exactly the cap).
  //
  // The worker gets EFBIG, which is a NAMED errno rather than the -EIO a
  // generic refusal would produce. The prose refusal that names the cap and
  // points at Bash is Phase B's.
  test('T7b — a FETCH above MAX_FILE_BYTES is refused with no transfer attempted', async () => {
    await rig(async ({ src, call, reads }) => {
      const p = path.join(src, 'huge.bin');
      // Sparse: the SIZE is what is over the cap, and writing 32 MiB of real
      // bytes to prove a refusal would be the slowest case in the suite.
      const fh = await fs.open(p, 'w');
      try { await fh.truncate(MAX_FILE_BYTES + 1); } finally { await fh.close(); }
      const base = await reads();
      const r = await call(CCU_OP.FETCH, 0, p);
      assert.equal(r.status, CCU_STATUS.REFUSED);
      assert.equal(r.err, 27, 'EFBIG — a named errno, not the generic EIO a catch-all refusal gives');
      assert.equal(await reads(), base, 'cc tried to pull a file it had already decided it could not carry');

      // THE BOUNDARY, and it is the control that makes the refusal a CAP
      // rather than a blanket: a file of exactly MAX_FILE_BYTES is carried.
      const edge = path.join(src, 'exactly.bin');
      const fh2 = await fs.open(edge, 'w');
      try { await fh2.truncate(MAX_FILE_BYTES); } finally { await fh2.close(); }
      const at = await reads();
      assert.equal((await call(CCU_OP.FETCH, 0, edge)).status, CCU_STATUS.READY,
        'a file AT the cap must be carried — the comparison is `>`, not `>=`');
      assert.equal(await reads(), at + 1, 'and carrying it is a transfer');
    });
  });

  // PINS: revalidate NEVER reaches a claimed path. `#fetch`'s claim
  // short-circuit precedes `#fetchBody` and therefore precedes every source
  // call, the freshness check included — which is what keeps the new behaviour
  // out of the two-handle window (the plan's §7.2, leg 3).
  // DIES UNDER: moving the freshness check ahead of the claim short-circuit;
  // recording a fingerprint for a claimed path.
  test('T10b — a claimed path reaches no source call at all, freshness check included', async () => {
    await rig(async ({ src, call, reads }) => {
      const p = path.join(src, 'held.txt');
      await fs.writeFile(p, 'ORIGINAL');
      assert.equal((await call(CCU_OP.FETCH, CCU_FLAG_FOR_WRITE, p)).status, CCU_STATUS.READY);
      const held = await reads();
      // Everything about the source changes under the claim; nothing may move.
      await fs.writeFile(p, 'CHANGED UNDER THE CLAIM, MUCH LONGER');
      assert.equal((await call(CCU_OP.FETCH, 0, p)).status, CCU_STATUS.READY);
      assert.equal((await call(CCU_OP.FETCH, CCU_FLAG_FOR_WRITE, p)).status, CCU_STATUS.READY);
      assert.equal(await reads(), held, 'a claimed path was re-materialised over the worker\'s bytes');
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
// NO MOUNT, NO SUDO, NO FUSE. The refusals run before `assertFuseAvailable`
// and `prepare()`, which is what makes the "nothing was created" half
// assertable — and the two arms that needed a SUCCESSFUL probe are driven
// directly rather than through a spawn, because reaching one through
// `POST /api/instances` means a real mount.
// ── THE WRITE PATH'S SEMANTICS ──────────────────────────────────────────────
//
// Mode preservation, the per-path fault record, and the double reconcile. All
// three are driven through a REAL ControlServer over the REAL transport, and
// every one of them is asserted on a value the product PRODUCED — the source
// file's own mode, the frame count on the wire, the fault record read back off
// the server — rather than on a reply status that would be the same either way.
describe("the write path — mode, faults and the double reconcile", () => {

  // Put the source entry at `p` into a shape a push cannot land on, and cannot
  // recover from either. A NON-EMPTY DIRECTORY is the one shape that fails
  // twice: `writeFileBytes(atomic)`'s rename onto a directory is EISDIR, and
  // `systemSource.push`'s single retry then calls the NON-RECURSIVE
  // `removeEntry`, which refuses ENOTEMPTY. A plain directory would be
  // repaired by that retry and the push would SUCCEED.
  //
  // The transport stays up throughout, which is what makes the later
  // "no frame reached the source" assertions non-vacuous — a killed provider
  // would give a frame count of zero for the wrong reason.
  async function wedgeSource(p) {
    await fs.rm(p, { force: true });
    await fs.mkdir(path.join(p, 'child.d'), { recursive: true });
    await fs.writeFile(path.join(p, 'child.d', 'x'), 'occupied');
  }

  const modeOf = async (p) => (await fs.lstat(p)).mode & 0o7777;

  // PINS: mode preservation across the write round trip, AND its counter-arm.
  // A rename over the mirror target REPLACES the inode, so the mode cc is
  // about to push is the tmp file's fresh 0644 — cc restores the source's
  // recorded 0755 first. An explicit chmod KEEPS the inode, so the mirror's
  // mode is the one the worker asked for and cc must push it unchanged.
  // DIES UNDER: removing the inode discriminator; "always restore" (the
  // counter-arm's 0700 comes back 0755); "never restore" (the main arm's 0755
  // comes back 0644); chmod'ing the source instead of the mirror (the mirror
  // assertion fails).
  test('T11 — a rename over the target keeps the source mode; a chmod at the same inode replaces it', async () => {
    await rig(async ({ src, mirror, call }) => {
      const p = path.join(src, 'run.sh');
      await fs.writeFile(p, '#!/bin/sh\necho one\n');
      await fs.chmod(p, 0o755);
      const dest = path.join(mirror, p);

      // ── MAIN ARM: create-write-rename, which is what an atomic Edit is.
      assert.equal((await call(CCU_OP.FETCH, CCU_FLAG_FOR_WRITE, p)).status, CCU_STATUS.READY);
      assert.equal(await modeOf(dest), 0o755, 'the mirror entry did not take the source mode');
      const tmp = `${dest}.tmp`;
      await fs.writeFile(tmp, '#!/bin/sh\necho two\n', { mode: 0o644 });
      await fs.chmod(tmp, 0o644);
      const before = (await fs.lstat(dest)).ino;
      await fs.rename(tmp, dest);
      assert.notEqual((await fs.lstat(dest)).ino, before,
        'the fixture did not replace the mirror inode, so the discriminator is never exercised');
      assert.equal(await modeOf(dest), 0o644,
        'the fixture did not actually strip the mode — there is nothing for cc to restore');

      assert.equal((await call(CCU_OP.DIRTY, 0, p)).status, CCU_STATUS.READY);
      assert.equal(await modeOf(p), 0o755,
        'the atomic write stripped the source file\'s executable bit');
      // AND THE MIRROR, because cc restores the invariant `#shape` maintains
      // rather than bypassing it with a mode passed through `push`.
      assert.equal(await modeOf(dest), 0o755, 'the mirror entry was left carrying the tmp file\'s mode');
      assert.equal(await fs.readFile(p, 'utf8'), '#!/bin/sh\necho two\n', 'the bytes did not land');

      // ── COUNTER-ARM, AND IT IS THE LOAD-BEARING HALF. Same path, same
      // recorded mode, and the ONLY difference is that the inode is unchanged:
      // this is a deliberate chmod by the worker and cc must not undo it.
      assert.equal((await call(CCU_OP.FETCH, CCU_FLAG_FOR_WRITE, p)).status, CCU_STATUS.READY);
      const held = (await fs.lstat(dest)).ino;
      await fs.chmod(dest, 0o700);
      assert.equal((await fs.lstat(dest)).ino, held,
        'chmod changed the inode, which would make this arm a copy of the main one');
      assert.equal((await call(CCU_OP.DIRTY, 0, p)).status, CCU_STATUS.READY);
      assert.equal(await modeOf(p), 0o700,
        'cc restored a mode the worker had deliberately changed at the same inode');
    });
  });

  // PINS: the mode restore fires ONLY for a regular file. `fsp.chmod` FOLLOWS a
  // symlink, so a mirror entry that is now a link at a path cc recorded a file
  // mode against would have its mode landed on the link's TARGET — some other
  // file in the mirror, whose own recorded mode then disagrees with its entry
  // and whose next push carries the wrong one.
  // DIES UNDER: dropping the regular-file test from `#restoreMode` (the
  // target's mode below comes back 0755).
  //
  // WHAT THE INODE DISCRIMINATOR RESTS ON, and WHERE THAT IS ACTUALLY CHECKED.
  // `#restoreMode` compares the RECORDED inode to the mirror entry's CURRENT
  // one, so an alias needs two mirror-entry replacements between the last
  // record and the DIRTY, with the second tmp reusing the first's freed inode.
  // What forecloses it is the RECORD CADENCE: `#record` runs on every copying
  // FETCH and on every landed reconcile (`#adoptWriteMtime`), so the inode a
  // mode is next compared against is the entry that was carrying it.
  //
  // THE KILLERS ARE T14b AND T11'S MAIN ARM — not T11's counter-arm, and an
  // earlier version of this comment claimed otherwise. Traced:
  //   * `#record` dropped from `#adoptWriteMtime` (the natural cadence-breaker)
  //     leaves `#fresh` holding the PRE-push fingerprint, so **T14b**'s trailing
  //     open re-downloads (8 B recorded against a 25 B source ⇒ `reads()+1`).
  //   * `#mode.set` dropped from `#record` leaves no recorded mode at all, so
  //     `#restoreMode` returns early and **T11's MAIN arm** gets 0644 on the
  //     source instead of 0755.
  //
  // AND WHY THE COUNTER-ARM IS NOT ONE, because this is where a prover would
  // otherwise mis-scope: under the first mutant the counter-arm PASSES. The
  // same stale `#fresh` that T14b catches makes the counter-arm's own
  // intervening `FETCH(FOR_WRITE)` miss freshness and COPY — and the copy path
  // re-records, so `#mode` is current again by the time the chmod is compared.
  // What the counter-arm does pin is the DISCRIMINATOR (skip the restore when
  // the inodes are equal), which is a different invariant.
  //
  // ONE PATH LEAVES THE MODE RECORD STALE ON PURPOSE: when the adoption's
  // source-size guard trips (T14c), `#fresh` is dropped and `#mode` is not.
  // WHAT FOLLOWS DEPENDS ON THE INODE, because that is what `#restoreMode`
  // compares — the record being stale is not by itself enough:
  //   * mirror entry REPLACED since the record (a rename) ⇒ the comparison sees
  //     a difference and RESTORES, and only when a push follows before any
  //     copying FETCH refreshes the record. On the CLI's open-per-write cadence
  //     that needs a rename inside a still-held claim between the guard trip
  //     and the next flush.
  //   * mirror entry NOT replaced ⇒ the inodes are equal, the restore is
  //     SKIPPED, and the pushed mode is the mirror's own — which `#shape` set
  //     from the source, so it is right anyway.
  // Both outcomes are the conservative direction; the case only arises on a
  // path that just suffered a racing source write, and it is stated rather
  // than asserted.
  test('T11b — a mirror entry that became a symlink is not chmod\'d through', async () => {
    await rig(async ({ src, mirror, call }) => {
      const p = path.join(src, 'was-a-file');
      const other = path.join(src, 'innocent');
      await fs.writeFile(p, 'ORIGINAL');
      await fs.chmod(p, 0o755);
      await fs.writeFile(other, 'DO NOT TOUCH');
      await fs.chmod(other, 0o600);

      // Both materialised: `p` claimed for write (so its 0755 is in the mode
      // ledger), `other` merely read (so it is in the mirror to be pointed at).
      assert.equal((await call(CCU_OP.FETCH, CCU_FLAG_FOR_WRITE, p)).status, CCU_STATUS.READY);
      assert.equal((await call(CCU_OP.FETCH, 0, other)).status, CCU_STATUS.READY);
      const destOther = path.join(mirror, other);
      assert.equal((await fs.lstat(destOther)).mode & 0o7777, 0o600,
        'the fixture did not materialise the target at 0600, so a 0755 below would prove nothing');

      // The worker replaces the claimed path with a symlink to the other file,
      // BY RENAME. `rm` then `symlink` would make this case VACUOUS: the freed
      // inode number is handed straight back to the new symlink, the recorded
      // inode matches, and the restore never runs — a green that exercises
      // nothing. A rename holds both inodes at once, so the new one cannot be
      // the old one.
      const dest = path.join(mirror, p);
      const wasIno = (await fs.lstat(dest)).ino;
      const tmpLink = `${dest}.link`;
      await fs.symlink(destOther, tmpLink);
      await fs.rename(tmpLink, dest);
      assert.equal((await fs.lstat(dest)).isSymbolicLink(), true);
      assert.notEqual((await fs.lstat(dest)).ino, wasIno,
        'the mirror inode did not change, so the restore is skipped and this arm proves nothing');

      assert.equal((await call(CCU_OP.DIRTY, 0, p)).status, CCU_STATUS.READY);
      assert.equal((await fs.lstat(destOther)).mode & 0o7777, 0o600,
        'the mode restore followed the symlink and landed 0755 on a file nobody named');
    });
  });

  // PINS: a failed push is loud and STICKY, in all four of its halves — the
  // reply is REFUSED/EIO, the fault is RECORDED on the server, the CLAIM IS
  // KEPT so the worker's unpushed bytes survive a following STAT, and a second
  // write open is refused WITHOUT A SINGLE FRAME reaching the source.
  // DIES UNDER: logging without recording the fault (faultAt is null);
  // releasing the claim on failure (the STAT re-shapes and the worker's bytes
  // are destroyed); allowing the second write open; refusing it only after a
  // source call (the wire delta is non-zero).
  test('T12 — a failed push records a diverged fault, keeps the claim, and refuses the next write', async () => {
    await rig(async ({ src, mirror, call, server, wire }) => {
      const p = path.join(src, 'note.txt');
      await fs.writeFile(p, 'ORIGINAL');
      const dest = path.join(mirror, p);
      assert.equal((await call(CCU_OP.FETCH, CCU_FLAG_FOR_WRITE, p)).status, CCU_STATUS.READY);

      // The worker's bytes, in the mirror, unpushed.
      const WORKER = 'BYTES ONLY THIS SESSION HAS';
      await fs.writeFile(dest, WORKER);
      await wedgeSource(p);

      const d = await call(CCU_OP.DIRTY, 0, p);
      assert.equal(d.status, CCU_STATUS.REFUSED, 'a push that could not land reported success');
      assert.equal(d.err, 5, 'EIO — the errno `flush` answers to close(2)');

      // 1. THE FAULT IS RECORDED, read off the server rather than inferred
      //    from the reply — the reply alone is what "logging without
      //    recording" also produces.
      const fault = server.faultAt(p);
      assert.ok(fault, 'the push failed and no fault was recorded');
      assert.equal(fault.kind, 'diverged');
      assert.equal(fault.refuses, 'writes');
      assert.match(fault.detail, /\S/, 'the fault carries no detail, so the refusal can name no cause');

      // 2. THE CLAIM IS KEPT, and the worker's bytes therefore survive cc's
      //    own cache management. A STAT is the exact op that re-shapes a
      //    path cc still manages, and the source is now a DIRECTORY — so a
      //    released claim would replace the file with one.
      assert.equal((await call(CCU_OP.STAT, 0, p)).status, CCU_STATUS.READY);
      assert.equal(await fs.readFile(dest, 'utf8'), WORKER,
        'the only copy of what the worker wrote was destroyed by cc\'s own re-shape');

      // 3. THE NEXT WRITE OPEN IS REFUSED, BEFORE ANY SOURCE CALL.
      const at = await wire();
      const again = await call(CCU_OP.FETCH, CCU_FLAG_FOR_WRITE, p);
      assert.equal(again.status, CCU_STATUS.REFUSED, 'a diverged path accepted a second write');
      assert.equal(again.err, 5);
      assert.equal(await wire(), at,
        'the refusal reached the source anyway — it is not ahead of every source call');
    });
  });

  // PINS: a diverged path stays READABLE, and serves the preserved bytes. That
  // is the recovery channel the refusal wording points at, so refusing all
  // access would destroy the thing the sentence promises.
  // DIES UNDER: refusing every op for a diverged path (`refuses` ignored, or
  // the gate not consulting it).
  test('T13 — a read-only open of a diverged path succeeds and serves the worker\'s bytes', async () => {
    await rig(async ({ src, mirror, call, server }) => {
      const p = path.join(src, 'note.txt');
      await fs.writeFile(p, 'ORIGINAL');
      const dest = path.join(mirror, p);
      assert.equal((await call(CCU_OP.FETCH, CCU_FLAG_FOR_WRITE, p)).status, CCU_STATUS.READY);
      const WORKER = 'RECOVERABLE CONTENT';
      await fs.writeFile(dest, WORKER);
      await wedgeSource(p);
      assert.equal((await call(CCU_OP.DIRTY, 0, p)).status, CCU_STATUS.REFUSED);
      assert.equal(server.faultAt(p)?.kind, 'diverged');

      const r = await call(CCU_OP.FETCH, 0, p);
      assert.equal(r.status, CCU_STATUS.READY, 'a diverged path stopped being readable');
      assert.equal(await fs.readFile(dest, 'utf8'), WORKER,
        'the read succeeded but served something other than the preserved bytes');
    });
  });

  // PINS: CCU_FLAG_RELEASE_ONLY. The releasing frame after a flush that
  // already landed carries NOTHING — so a written file uploads ONCE, not twice
  // — and it still RELEASES the claim, which is the only thing that drops one.
  // DIES UNDER: cc ignoring the flag (two writeFile frames); cc treating a
  // release-only frame as not releasing (the claim survives and the following
  // STAT no longer re-shapes).
  test('T14 — a flush then a RELEASE_ONLY release pushes once and still drops the claim', async () => {
    await rig(async ({ src, mirror, call, writes }) => {
      const p = path.join(src, 'note.txt');
      await fs.writeFile(p, 'ORIGINAL');
      const dest = path.join(mirror, p);
      assert.equal((await call(CCU_OP.FETCH, CCU_FLAG_FOR_WRITE, p)).status, CCU_STATUS.READY);
      await fs.writeFile(dest, 'WRITTEN THROUGH THE UNION');
      const base = await writes();

      // The daemon's `flush`: FOR_WRITE on a DIRTY means the handle is still
      // open, so this reconciles and keeps the claim.
      assert.equal((await call(CCU_OP.DIRTY, CCU_FLAG_FOR_WRITE, p)).status, CCU_STATUS.READY);
      assert.equal(await writes(), base + 1, 'the flush did not push');
      assert.equal(await fs.readFile(p, 'utf8'), 'WRITTEN THROUGH THE UNION');

      // The daemon's `release` for a handle whose flush already landed.
      assert.equal((await call(CCU_OP.DIRTY, CCU_FLAG_RELEASE_ONLY, p)).status, CCU_STATUS.READY);
      assert.equal(await writes(), base + 1,
        'the releasing frame uploaded the whole file a second time');

      // AND THE CLAIM IS GONE, observed the only way it can be from out here:
      // a STAT re-shapes a path cc manages and short-circuits on one it does
      // not. The source is changed to a DIFFERENT SIZE, so the re-shape is
      // observable on the mirror entry.
      await fs.writeFile(p, 'A MUCH LONGER SOURCE FILE THAN BEFORE');
      assert.equal((await call(CCU_OP.STAT, 0, p)).status, CCU_STATUS.READY);
      assert.equal((await fs.lstat(dest)).size, (await fs.lstat(p)).size,
        'the STAT did not re-shape the mirror entry, so the release never dropped the claim');
    });
  });

  // PINS: the post-push mtime adoption costs ONE source round trip for a FILE
  // and NONE for a directory — the kind test is a LOCAL `lstat`, not a remote
  // stat. Asserted as a frame count, because the reconcile succeeds either way
  // and only the wire can tell the two apart.
  // DIES UNDER: dropping the local kind test (the directory arm gains an
  // `exec:argv`); dropping the adoption entirely (the file arm loses one, and
  // the following open re-downloads what the worker just wrote — the second
  // arm below).
  test('T14b — a directory reconcile costs no source stat, and a file write is not re-downloaded', async () => {
    await rig(async ({ src, mirror, call, reads, wire }) => {
      // ── THE DIRECTORY ARM. `mkdir` through the union reconciles a dir.
      const d = path.join(src, 'a-dir');
      await fs.mkdir(d);
      assert.equal((await call(CCU_OP.STAT, 0, d)).status, CCU_STATUS.READY);
      await fs.chmod(path.join(mirror, d), 0o700);
      const beforeDir = await wire();
      assert.equal((await call(CCU_OP.DIRTY, 0, d)).status, CCU_STATUS.READY);
      const dirFrames = (await wire()) - beforeDir;
      // THREE, AND THEY ARE ALL THE PUSH'S OWN: `systemSource.push`'s dir arm
      // is `lstat` (the wrong-kind probe) + `mkdir -p` + `chmod`. A FOURTH
      // would be a source stat taken for a fingerprint only a FILE has — which
      // is what the local kind test in `#adoptWriteMtime` exists to avoid, and
      // what a mutant removing it puts back.
      assert.equal(dirFrames, 3,
        `a directory reconcile cost ${dirFrames} source round trips, not the push's own 3`);

      // ── THE FILE ARM, and the saving it buys. Write through the union, then
      //    open the path again: the source's mtime is FRESH after the atomic
      //    write, so without the adoption the fingerprint misses and the whole
      //    file comes back down.
      const p2 = path.join(src, 'written.txt');
      await fs.writeFile(p2, 'ORIGINAL');
      assert.equal((await call(CCU_OP.FETCH, CCU_FLAG_FOR_WRITE, p2)).status, CCU_STATUS.READY);
      await fs.writeFile(path.join(mirror, p2), 'WRITTEN THROUGH THE UNION');
      // THE DAEMON'S OWN PAIR, in the daemon's own order: `flush` carries
      // FOR_WRITE (union.c `pt_flush`) and `release` carries RELEASE_ONLY once
      // that flush has landed. Sending RELEASE_ONLY first and a flags-0 frame
      // second is not merely mislabelled — it drops the claim before pushing
      // anything, so the push AND the adoption happen on an UNCLAIMED flags-0
      // DIRTY, a different route from the `stillOpen` flush route this arm
      // exists to drive.
      assert.equal((await call(CCU_OP.DIRTY, CCU_FLAG_FOR_WRITE, p2)).status, CCU_STATUS.READY);
      assert.equal((await call(CCU_OP.DIRTY, CCU_FLAG_RELEASE_ONLY, p2)).status, CCU_STATUS.READY);
      const afterPush = await reads();
      assert.equal((await call(CCU_OP.FETCH, 0, p2)).status, CCU_STATUS.READY);
      assert.equal(await reads(), afterPush,
        'the open after a write re-downloaded the file the worker had just written');
      assert.equal(await fs.readFile(path.join(mirror, p2), 'utf8'), 'WRITTEN THROUGH THE UNION');
    });
  });

  // PINS: the post-push fingerprint is only recorded when THE SOURCE STILL
  // HOLDS WHAT CC PUSHED. `#adoptWriteMtime` is the one writer of a `#fresh`
  // fingerprint that does not materialise the bytes it describes — it stats the
  // SOURCE after the push, where every other writer stats before copying — so
  // a box-side writer landing in that window would otherwise pair the MIRROR's
  // bytes with ANOTHER writer's `(size, mtime)`. The next open then matches
  // size, mtime and the mirror inode (which the push never touched), skips the
  // copy, and serves the worker its own stale bytes as the file's content.
  //
  // Criterion 9 — two workers on one remote project — makes that population
  // real, so this is not a theoretical race.
  // DIES UNDER: recording the adoption unconditionally (the second open below
  // transfers nothing and the mirror keeps the worker's bytes).
  test('T14c — a source-side write landing after the push is not fingerprinted as fresh', async () => {
    const OTHER = 'A DIFFERENT WRITER PUT THIS HERE, AND IT IS A DIFFERENT LENGTH';
    const WORKER = 'WORKER BYTES';
    let target = null;
    // A box-side writer that lands IMMEDIATELY AFTER cc's push returns —
    // deterministically, which is the only way to sit inside a window this
    // narrow. Everything else passes straight through.
    const wrapSource = (inner) => ({
      ...inner,
      push: async (from, to) => {
        const r = await inner.push(from, to);
        if (to === target) await fs.writeFile(to, OTHER);
        return r;
      },
    });
    await rig(async ({ src, mirror, call, reads }) => {
      const p = path.join(src, 'contended.txt');
      target = p;
      await fs.writeFile(p, 'ORIGINAL');
      const dest = path.join(mirror, p);
      assert.equal((await call(CCU_OP.FETCH, CCU_FLAG_FOR_WRITE, p)).status, CCU_STATUS.READY);
      await fs.writeFile(dest, WORKER);
      const heldIno = (await fs.lstat(dest)).ino;

      assert.equal((await call(CCU_OP.DIRTY, CCU_FLAG_FOR_WRITE, p)).status, CCU_STATUS.READY);
      // THE FIXTURE REALLY DID RACE THE PUSH, asserted rather than assumed: the
      // source holds the other writer's bytes and the MIRROR inode is untouched
      // — which is exactly the state in which the inode half of the
      // fingerprint cannot help, and a size+mtime match would be believed.
      assert.equal(await fs.readFile(p, 'utf8'), OTHER,
        'the wrapper did not land after the push, so this arm proves nothing');
      assert.equal((await fs.lstat(dest)).ino, heldIno,
        'the mirror inode moved, so the inode half of the fingerprint would catch this anyway');
      assert.equal((await call(CCU_OP.DIRTY, CCU_FLAG_RELEASE_ONLY, p)).status, CCU_STATUS.READY);

      const base = await reads();
      assert.equal((await call(CCU_OP.FETCH, 0, p)).status, CCU_STATUS.READY);
      assert.equal(await reads(), base + 1,
        'the open after a contended push transferred nothing — cc believed a fingerprint it had '
        + 'paired with another writer\'s metadata');
      assert.equal(await fs.readFile(dest, 'utf8'), OTHER,
        'the worker was served its own stale bytes as the file\'s content');
    }, { wrapSource });
  });

  // PINS: a diverged fault is CLEARED by a successful reconcile OF THE SAME
  // PATH, because at that moment the divergence the sentence asserts no longer
  // exists. The reachable sequence is the daemon's own: a `flush` that refuses
  // records the fault and leaves `fd_dirty` set, so the `release` sends a FULL
  // reconcile — and if the source has become writable in between, that one
  // SUCCEEDS. Without the clear, every later write open of a repaired path is
  // refused for the rest of the session by a sentence that is false.
  // DIES UNDER: keeping the fault on a successful push (the FETCH below is
  // refused); clearing it on a FAILED push (T12's second write open stops
  // being refused).
  test('T13b — a successful reconcile of the same path clears its diverged fault', async () => {
    await rig(async ({ src, mirror, call, server }) => {
      const p = path.join(src, 'repaired.txt');
      await fs.writeFile(p, 'ORIGINAL');
      const dest = path.join(mirror, p);
      assert.equal((await call(CCU_OP.FETCH, CCU_FLAG_FOR_WRITE, p)).status, CCU_STATUS.READY);
      await fs.writeFile(dest, 'WORKER BYTES');
      await wedgeSource(p);

      // The flush refuses and records the fault. `fd_dirty` stays set in the
      // daemon, which is why the release below is a FULL reconcile.
      assert.equal((await call(CCU_OP.DIRTY, CCU_FLAG_FOR_WRITE, p)).status, CCU_STATUS.REFUSED);
      assert.equal(server.faultAt(p)?.kind, 'diverged');

      // The obstruction goes; the releasing full reconcile lands.
      await fs.rm(p, { recursive: true, force: true });
      assert.equal((await call(CCU_OP.DIRTY, 0, p)).status, CCU_STATUS.READY);
      assert.equal(await fs.readFile(p, 'utf8'), 'WORKER BYTES',
        'the second reconcile did not actually land, so there is nothing repaired to clear');

      // THE FAULT IS GONE, and the path is writable again.
      assert.equal(server.faultAt(p), null,
        'a repaired path kept a fault whose sentence asserts a divergence that no longer exists');
      assert.equal((await call(CCU_OP.FETCH, CCU_FLAG_FOR_WRITE, p)).status, CCU_STATUS.READY,
        'a repaired path is still refused for writing');
    });
  });

  // PINS: AN ABANDONED CLAIM DOES NOT POISON THE PATH, and the discrimination
  // is the FRAME's rather than a guess about the state.
  //
  // `policy_abandon_claim` fires when a mutating op took a claim and then
  // failed BEFORE mutating (a failed `openat` in `pt_open`/`pt_create`, and the
  // path branches of mkdir/unlink/rmdir/symlink/rename/chmod). The mirror entry
  // is present — the op's own FETCH materialised it — and holds cc's OWN
  // unmodified cache copy, so there is nothing to reconcile. It now carries
  // `RELEASE_ONLY`, which says exactly that.
  //
  // WHY IT CANNOT BE INFERRED INSTEAD, since that was the first proposal: a
  // flagless DIRTY on a path whose claim came from `pt_open` is EITHER an
  // abandon OR the releasing frame of a handle that wrote and never flushed
  // (the killed-process backstop). Same op, same flags, same `createdHere:
  // false`. Suppressing the fault on that signature would have swallowed the
  // second case — T12's exact sequence — and let the next STAT re-shape away
  // the only copy of what the worker wrote. So the daemon declares which it is.
  //
  // DIES UNDER: cc treating a RELEASE_ONLY frame as a reconcile (arm 1 records
  // a fault and the self-heal below never happens); cc treating a FLAGLESS one
  // as an abandon (arm 2 records none, which is the data-loss direction).
  test('T13c — an abandoned claim releases and self-heals; a flagless release still faults', async () => {
    await rig(async ({ src, mirror, call, server }) => {
      // ── ARM 1: THE ABANDON. The mirror holds cc's cache copy, untouched.
      const p = path.join(src, 'abandoned.txt');
      await fs.writeFile(p, 'ORIGINAL');
      const dest = path.join(mirror, p);
      assert.equal((await call(CCU_OP.FETCH, CCU_FLAG_FOR_WRITE, p)).status, CCU_STATUS.READY);
      assert.equal(await fs.readFile(dest, 'utf8'), 'ORIGINAL',
        'the op\'s own FETCH did not materialise the entry, so this is not the abandon shape');
      // The source is made unpushable, so a frame that DID try to reconcile
      // would fail and record a fault. That is what makes arm 1 non-vacuous.
      await wedgeSource(p);
      assert.equal((await call(CCU_OP.DIRTY, CCU_FLAG_RELEASE_ONLY, p)).status, CCU_STATUS.READY);
      assert.equal(server.faultAt(p), null,
        'an abandoned claim poisoned a path the worker never wrote to');

      // AND THE SELF-HEAL IS BACK, which is what the fault had removed: the
      // claim is gone, so cc manages the path as a cache again and the next
      // open re-materialises from the source.
      await fs.rm(p, { recursive: true, force: true });
      await fs.writeFile(p, 'THE SOURCE MOVED ON, AT A DIFFERENT LENGTH');
      assert.equal((await call(CCU_OP.FETCH, CCU_FLAG_FOR_WRITE, p)).status, CCU_STATUS.READY,
        'the path is still refused for writing, so the claim was never released');
      assert.equal(await fs.readFile(dest, 'utf8'), 'THE SOURCE MOVED ON, AT A DIFFERENT LENGTH',
        'the mirror is frozen on a stale copy — cc did not resume managing the path');

      // ── ARM 2: THE CONTROL, and it is the direction that must NOT change.
      // A FLAGLESS release of a handle that wrote is a real reconcile, and its
      // failure is a real divergence.
      const q = path.join(src, 'written.txt');
      await fs.writeFile(q, 'ORIGINAL');
      assert.equal((await call(CCU_OP.FETCH, CCU_FLAG_FOR_WRITE, q)).status, CCU_STATUS.READY);
      await fs.writeFile(path.join(mirror, q), 'WORKER BYTES');
      await wedgeSource(q);
      assert.equal((await call(CCU_OP.DIRTY, 0, q)).status, CCU_STATUS.REFUSED);
      assert.equal(server.faultAt(q)?.kind, 'diverged',
        'a killed handle\'s failed reconcile recorded nothing — the next STAT will destroy its bytes');
    });
  });

  // PINS: the killed-process backstop. A releasing frame from a handle whose
  // `flush` NEVER RAN carries no RELEASE_ONLY bit, and cc must push it — there
  // is no close(2) left to answer and landing the bytes is the whole of what is
  // owed. This is the consumer half of union.c's `fd_dirty[fd] ? 0 : …`.
  // DIES UNDER: cc treating every release as release-only (zero pushes, and
  // the bytes are silently lost).
  test('T15 — a release with no flags pushes, because nothing has landed yet', async () => {
    await rig(async ({ src, mirror, call, writes }) => {
      const p = path.join(src, 'note.txt');
      await fs.writeFile(p, 'ORIGINAL');
      const dest = path.join(mirror, p);
      assert.equal((await call(CCU_OP.FETCH, CCU_FLAG_FOR_WRITE, p)).status, CCU_STATUS.READY);
      await fs.writeFile(dest, 'NEVER FLUSHED');
      const base = await writes();

      assert.equal((await call(CCU_OP.DIRTY, 0, p)).status, CCU_STATUS.READY);
      assert.equal(await writes(), base + 1,
        'a release that had nothing landed before it pushed nothing — the bytes are lost');
      assert.equal(await fs.readFile(p, 'utf8'), 'NEVER FLUSHED');
    });
  });

  // PINS: the over-cap fault is RECORDED where the cap is enforced, so a file
  // tool can be refused by name before the worker ever opens the path — and it
  // refuses BOTH directions, because cc never materialised the file and has
  // nothing to serve a reader either.
  // DIES UNDER: refusing without recording (`faultAt` is null, and the tool
  // refusal has nothing to report); recording it with `refuses: 'writes'` —
  // and for THAT mutant the observable is the WIRE DELTA, not the status: the
  // cap check in `#fetchBody` re-fires and the second read still comes back
  // REFUSED/EFBIG, so only the frame count separates a sticky refusal from a
  // re-derived one.
  test('T12b — an over-cap FETCH records a fault that refuses reads as well as writes', async () => {
    await rig(async ({ src, call, server, wire }) => {
      const p = path.join(src, 'huge.bin');
      const fh = await fs.open(p, 'w');
      try { await fh.truncate(MAX_FILE_BYTES + 1); } finally { await fh.close(); }
      assert.equal((await call(CCU_OP.FETCH, 0, p)).err, 27);

      const fault = server.faultAt(p);
      assert.ok(fault, 'the cap refused and recorded nothing, so no tool can be told why');
      assert.equal(fault.kind, 'over-cap');
      assert.equal(fault.refuses, 'all');
      // THE NUMBERS THE REFUSAL WORDING QUOTES, pinned where they are
      // produced. `cap` is MAX_FILE_BYTES and `size` is the file's own.
      assert.equal(fault.cap, MAX_FILE_BYTES);
      assert.equal(fault.size, MAX_FILE_BYTES + 1);

      // AND IT IS STICKY AND TOTAL: the next open — read OR write — is
      // refused with no frame reaching the source.
      const at = await wire();
      const r = await call(CCU_OP.FETCH, 0, p);
      assert.equal(r.status, CCU_STATUS.REFUSED, 'an over-cap path was served on a second look');
      assert.equal(r.err, 27);
      assert.equal(await wire(), at, 'the second refusal went to the source anyway');
    });
  });
});

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
  async function fixture({ mirrorSub = null, remote = null } = {}) {
    const id = `probe${++n}`;
    const project = `probeapp${n}`;
    const box = await fs.realpath(await mkdtemp('cc-probe-'));
    const root = mirrorSub === null ? box : path.join(box, mirrorSub);
    const projPath = path.join(root, 'app');
    await seedRepo(projPath);
    const deadFile = path.join(box, '.dead');
    const probeLog = path.join(box, 'probes.log');
    await addSystem({
      id, label: id,
      launch: ['node', FIXTURE, '--dead-file', deadFile, '--probe-log', probeLog,
        // A BOUND handle needs the provider to serve that target, or cc refuses
        // on its own side at the handshake and the probe is never reached.
        ...(remote === null ? [] : ['--remote', `${remote}=/`]),
        ...(mirrorSub === null ? [] : ['--advertise-mirror', root])],
    });
    assert.equal((await adoptProject(project, projPath, { system: id, remoteId: remote })).ok, true);
    return { id, project, box, root, projPath, deadFile, probeLog, remote };
  }

  const spawn = (project) => api(baseUrl, 'POST', '/api/instances', { project, mode: 'bypassPermissions' });
  // THE PROBE'S OWN FRAME AND NOTHING ELSE. `assertRemoteLive` runs
  // `env LC_ALL=C true` (registry.ts) — no other operation in a spawn does —
  // so counting it is counting the probe. Counting `error` frames instead
  // counted the mirror-root `lstat` beside it, which the dead file also
  // answers, and the assertion passed on traffic the probe never made.
  //
  // The fixture logs what the provider WROTE, so the probe is counted by the
  // answer it drew: the `exit` frame for a `true` that ran, or the `error`
  // frame for one the dead file refused. Either way, exactly one per probe.

  const runDirs = async () => new Set(await fs.readdir(fuseRunRoot()).catch(() => []));

  // PINS: a box that has gone away refuses the SPAWN by name, before anything
  // is created for it — the refusal's WORDING and its ORDERING.
  //
  // DIES UNDER: running the probe after `prepare()` — caught by the
  // run-directory assertion, which the status code alone would not catch; and
  // any change to the clauses asserted below.
  //
  // IT DOES *NOT* DIE UNDER dropping the live probe, and the earlier comment
  // claiming so was wrong — measured. `_assertRemoteMountable` makes a second
  // call the dead box also refuses (the mirror-root `lstat`), which
  // re-produces this refusal identically: same wording, same 502, same absent
  // run directory. The real killers of the two probe mutants are **T17**,
  // which counts the probe's own frame, and **T16b**, which asserts the clause
  // only the ENOREMOTE branch writes. A stated mechanism that does not hold is
  // what a future editor preserves, so it is named here rather than left.
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
    // THE CONSEQUENCE AND THE REPAIR, because a refusal that names neither
    // leaves the reader to guess what a dead box does to a mounted worker.
    assert.match(r.body.error, /reaches no project file at all/);
    assert.match(r.body.error, /Start it and spawn again/);
    assert.equal(/remote '/.test(r.body.error), false,
      'an UNBOUND handle has no remote to name, and naming one would point at nothing');

    // NOTHING WAS CREATED. The probe sits before `assertFuseAvailable` and
    // therefore before `prepare()`, the only thing that makes a run directory —
    // so this asserts the ORDERING, which the status code alone cannot.
    assert.deepEqual([...await runDirs()].filter(d => !before.has(d)), []);
  });

  // PINS: A PROBE THAT SUCCEEDED DOES NOT SATISFY THE NEXT ONE. That is the
  // whole of the memoisation gap — `connect`, `assertRemoteKnown` and `mirror`
  // each write their memo on the SUCCESS path (`#probedAgainst = hs`), so a
  // case where no probe ever succeeds cannot kill a mutant that copies them.
  //
  // DRIVEN DIRECTLY, NOT THROUGH A SPAWN, and that is what keeps this file
  // mount-free. Reaching a successful probe through `POST /api/instances`
  // requires `_fuse` to be attached, which means a real mount, `sudo -n` and
  // `/dev/fuse` — in a file whose header promises none of them, and in the
  // default suite, which is the real-mount contention shape. The
  // invariant is about `assertRemoteLive` and is asserted on it.
  //
  // DIES UNDER: memoising the answer on the handshake, the way the three
  // memoised probes beside it do.
  test('T17 — a probe that SUCCEEDED does not satisfy the next call', async () => {
    const box = await fs.realpath(await mkdtemp('cc-probe-'));
    const deadFile = path.join(box, '.dead');
    const probeLog = path.join(box, 'probes.log');
    const sys = new ProviderSystem({ id: 'probe-unit', launch: { argv:
      ['node', FIXTURE, '--dead-file', deadFile, '--probe-log', probeLog] } });
    try {
      // 1. A SUCCESSFUL probe, so any memo a mutant would keep is populated by
      //    the path that actually writes one.
      await assertRemoteLive(sys, "project 'p'");
      const after = await probeCount(probeLog);
      assert.equal(after, 1, 'the first call made no probe at all — the case cannot fail');

      // 2. The box goes away on the SAME connection generation: the handshake
      //    object is untouched, which is exactly what the memo is keyed on.
      const generation = sys.handshake;
      await fs.writeFile(deadFile, '');
      await assert.rejects(() => assertRemoteLive(sys, "project 'p'"), /does not serve it|live check|could not run/);
      assert.equal(sys.handshake, generation, 'the connection restarted — this no longer tests the memo');
      assert.ok(await probeCount(probeLog) > after,
        'the second call answered from the memo a successful probe left behind: nothing crossed the wire');
    } finally { sys.dispose(); }
  });

  // THE NON-VACUITY CONTROL for T16/T18, at the same level and for the same
  // reason: a live, correctly-advertised box passes BOTH probes. Without it
  // every refusal above would still pass against a probe that refuses
  // unconditionally.
  test('T16-T18 control — a live box passes both probes', async () => {
    const box = await fs.realpath(await mkdtemp('cc-probe-'));
    const sys = new ProviderSystem({ id: 'probe-live', launch: { argv:
      ['node', FIXTURE, '--dead-file', path.join(box, '.never')] } });
    try {
      await assertRemoteLive(sys, "project 'p'");        // resolves, or throws and fails the case
      assert.notEqual(await sys.lstat(box), null, 'the mirror-root probe found nothing at a path that exists');
      assert.equal(await sys.lstat(path.join(box, 'nope')), null, 'and it can still tell absence');
    } finally { sys.dispose(); }
  });

  // PINS: THE BOUND SPELLING OF BOTH REFUSALS. `_assertRemoteMountable` picks
  // `remote '<id>' of system '<id>'` when the handle names a target, and
  // `assertRemoteLive` has a dedicated ENOREMOTE branch for the same case — and
  // every other case in this file adopts UNBOUND, so a mutant deleting the
  // bound branch, or flattening it to the unbound wording, survived them all.
  // The remote is the thing an operator restarts, so a refusal that named only
  // the system would point at the wrong repair.
  // DIES UNDER: dropping the `remoteId !== null` arm in either place; deleting
  // `assertRemoteLive`'s ENOREMOTE branch (caught by the inner reason, not by
  // the wording — see below).
  test('T16b/T18b — a BOUND handle names its remote in both refusals', async () => {
    const dead = await fixture({ remote: 'ctr-a' });
    await fs.writeFile(dead.deadFile, '');
    const r = await spawn(dead.project);
    assert.equal(r.status, 502, JSON.stringify(r.body));
    assert.match(r.body.error, new RegExp(`remote 'ctr-a' of system '${dead.id}'`),
      'the bound refusal did not name the remote');
    assert.match(r.body.error, /live check/);
    // THE INNER REASON, which is what actually dies with the branch. The
    // wording above is re-interpolated by `_assertRemoteMountable`'s own
    // `target`, so deleting `assertRemoteLive`'s ENOREMOTE arm lets the failure
    // fall through to the generic `spawnError` arm and STILL produce
    // `remote 'ctr-a' of system '…'` and `/live check/` — every assertion above
    // passes while a dedicated refusal and its sentence vanish. This is the one
    // clause only that branch can write.
    assert.match(r.body.error, /does not serve it/,
      "the ENOREMOTE branch's own sentence is gone — the generic arm produced this refusal");

    const absent = await fixture({ remote: 'ctr-b', mirrorSub: 'geometry' });
    await rmrf(absent.root);
    const m = await spawn(absent.project);
    assert.equal(m.status, 501, JSON.stringify(m.body));
    assert.match(m.body.error, new RegExp(`remote 'ctr-b' of system '${absent.id}'`));
    assert.match(m.body.error, /outside the mirror root/);
    assert.match(m.body.error, /Fix the remote's mirror record/);
  });

  // PINS: a box that is UP with nothing at the advertised mirror root is a
  // DIFFERENT refusal, 501 and not 502, because it is a different repair — fix
  // the configuration, not the machine.
  // DIES UNDER: collapsing the two codes into one — 501 vs 502 is what carries
  // the distinction over HTTP, since the shared error handler sends the message
  // alone.
  //
  // NOT claiming to catch a probe of the PROJECT path instead of the mirror
  // root: the fixture nests the project INSIDE the advertised root, so removing
  // the root removes the project with it and both probes answer the same. The
  // nesting is a design invariant — an advertised root that does not contain
  // the project is already refused MIRROR_ROOT_EXCLUDES_PROJECT at create — so
  // the clause is dropped rather than the fixture restructured to fake a
  // geometry the product forbids.
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

});
