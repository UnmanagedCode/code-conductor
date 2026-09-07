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
//
// NOTHING HERE MOUNTS, AND THAT IS MAINTAINED RATHER THAN INHERITED. Two arms
// used to: a spawn that SUCCEEDS attaches `_fuse`, runs the full preflight and
// makes a real mount, so the file reddened on any host without `/dev/fuse` or
// `sudo -n` — the exact hosts this header claims immunity from — and added a
// participant to the only real-mount contention in `npm test` (card 2026-0370).
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
import { ControlServer, encodeRequest, CCU_OP, CCU_STATUS, CCU_FLAG_FOR_WRITE } from '../src/systems/fuse/control.ts';
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
  // never written. **T7b is where the cap is pinned.** Both kills this case
  // used to claim were false, and a claim that cannot fail is worse than an
  // absent one because it is counted.
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
describe('per-open revalidate — the mirror is not re-downloaded for nothing', () => {

  // One request, one reply. Settles on a clean FIN too (card 2026-0371).
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
  async function rig(fn) {
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
        source: systemSource(sys),
        tiers: buildTierTable(tierFixtureInput({ systemPath: src, mirrorRoot: src })),
      });
      sock = await new Promise((res, rej) => {
        const c = net.connect(server.socketPath, () => res(c)); c.once('error', rej);
      });
      const reads = async () => (await frames(log))['c2p:readFile'] ?? 0;
      return await fn({ src, mirror, sock, call: (op, flags, p) => call(sock, op, flags, p), reads });
    } finally {
      sock?.destroy();
      await server?.close();
      sys.dispose();
    }
  }

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
  // default suite, which is the contention shape card 2026-0370 records. The
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
