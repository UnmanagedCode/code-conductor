// CC'S HALF OF THE CONTROL CHANNEL, over a real unix socket.
//
// The daemon's half is proven by the compiled policy driver
// (`fuse-union-policy.test.mjs`); this is the other side of the same wire, and
// it is deterministic — a temp source tree, a temp mirror, and frames written
// by hand. What it does NOT cover is the socket under libfuse's multithreaded
// loop and a daemon blocking on a reply, which are real-gate arms (R6).
//
// THE INVARIANT UNDER ALL OF IT: the handler touches the MIRROR and the SOURCE
// ROOT and never the mount. A FUSE thread is blocked on the reply to the frame
// being served, so a handler that stat'd anything under the union would be
// waiting on itself.

import { test, describe, before, after } from 'node:test';
import assert from 'node:assert/strict';
import net from 'node:net';
import path from 'node:path';
import { promises as fs } from 'node:fs';
import { mkdtemp } from './tmpRegistry.mjs';
import { ControlServer, encodeRequest, decodeRequests, encodeReply,
         CCU_OP, CCU_STATUS, CCU_FLAG_FOR_CREATE, CCU_MAGIC, CCU_REPLY_LEN } from '../src/systems/fuse/control.ts';
import { localDirSource } from '../src/systems/fuse/remoteSource.ts';
import { buildTierTable } from '../src/systems/fuse/tierTable.ts';
import { tierFixtureInput } from './tierFixture.mjs';

const ENOENT = 2, EIO = 5, EACCES = 13;

// One request, one reply, on its own connection.
function call(sock, op, flags, p) {
  return new Promise((resolve, reject) => {
    let buf = Buffer.alloc(0);
    // Both listeners come OFF on either outcome — this helper runs once per
    // assertion on one long-lived socket, and a leaked `once('error')` per call
    // trips node's max-listeners warning by the eleventh test.
    const done = (fn, v) => { sock.off('data', onData); sock.off('error', onErr); fn(v); };
    const onErr = (e) => done(reject, e);
    const onData = (c) => {
      buf = Buffer.concat([buf, c]);
      if (buf.length < CCU_REPLY_LEN) return;
      done(resolve, { magic: buf.readUInt32BE(0), status: buf[4], err: buf.readInt32BE(6), raw: buf });
    };
    sock.on('data', onData);
    sock.on('error', onErr);
    sock.write(encodeRequest(op, flags, p));
  });
}

const connect = (p) => new Promise((resolve, reject) => {
  const s = net.connect(p, () => resolve(s));
  s.once('error', reject);
});

describe('the control channel, cc side', () => {
  let box, srcRoot, mirror, sockPath, server, sock, logs, tiers;

  before(async () => {
    box = await mkdtemp('cc-ctl-');
    srcRoot = path.join(box, 'remote');
    mirror = path.join(box, 'mirror');
    sockPath = path.join(box, 'control.sock');
    await fs.mkdir(path.join(srcRoot, 'srv', 'app'), { recursive: true });
    await fs.mkdir(mirror, { recursive: true });
    logs = [];
    // THE PRODUCT'S OWN TABLE, not a transcribed one: the server's job is to
    // materialise exactly what the daemon would serve, and a hand-written table
    // here would let a derivation change pass unnoticed in the test that reads
    // it. `/srv/app/secrets` is an advertised exclude, so it renders `fail`.
    tiers = buildTierTable(tierFixtureInput({
      systemPath: '/srv/app', mirrorRoot: '/srv/app', exclude: ['/srv/app/secrets'],
    }));
    server = await ControlServer.listen({
      socketPath: sockPath, mirror, source: localDirSource(srcRoot), tiers,
      log: (l) => logs.push(l),
    });
    sock = await connect(sockPath);
  });
  after(async () => { sock?.destroy(); await server?.close(); });

  const at = (p) => path.join(srcRoot, p);
  const inMirror = (p) => path.join(mirror, p);

  // PINS: STAT mirrors the METADATA and moves no bytes. A stub `truncate`d to
  // the source's size is sparse, so a `stat` inside the chroot answers
  // truthfully and a directory listing costs no transfer; the bytes arrive on
  // FETCH. Dies if #shape copies content, or drops the size.
  test('STAT shapes a sparse stub with the source size, mode and mtime', async () => {
    await fs.writeFile(at('/srv/app/big.bin'), Buffer.alloc(4096, 7));
    await fs.chmod(at('/srv/app/big.bin'), 0o640);
    const want = await fs.stat(at('/srv/app/big.bin'));

    const r = await call(sock, CCU_OP.STAT, 0, '/srv/app/big.bin');
    assert.equal(r.magic, CCU_MAGIC);
    assert.equal(r.status, CCU_STATUS.READY);
    const got = await fs.stat(inMirror('/srv/app/big.bin'));
    assert.equal(got.size, 4096, 'the stub reports the source size');
    assert.equal(got.mode & 0o777, 0o640, 'and the source mode');
    assert.equal(Math.floor(got.mtimeMs), Math.floor(want.mtimeMs), 'and the source mtime');
    assert.equal((await fs.readFile(inMirror('/srv/app/big.bin'))).every(b => b === 0), true,
      'and NO bytes crossed — the stub is sparse zeroes until FETCH');
  });

  // PINS: an absent source is ABSENT+ENOENT *and* removes the stale mirror
  // entry, so a file deleted on the remote stops being visible locally rather
  // than lingering until the session ends.
  test('STAT on a vanished source is ABSENT and unmirrors the stale entry', async () => {
    await fs.writeFile(at('/srv/app/gone.txt'), 'x');
    await call(sock, CCU_OP.STAT, 0, '/srv/app/gone.txt');
    await fs.access(inMirror('/srv/app/gone.txt'));

    await fs.rm(at('/srv/app/gone.txt'));
    const r = await call(sock, CCU_OP.STAT, 0, '/srv/app/gone.txt');
    assert.equal(r.status, CCU_STATUS.ABSENT);
    assert.equal(r.err, ENOENT, 'cc chooses the errno, not the daemon');
    await assert.rejects(() => fs.access(inMirror('/srv/app/gone.txt')), 'the stale mirror entry survived');
  });

  // PINS: LIST creates the directory, shapes every child, and REMOVES mirror
  // children the source no longer has. Without the removal `readdir` shows
  // ghosts. Dies if the `want` set is dropped.
  test('LIST shapes every child and removes the ones the source lost', async () => {
    await fs.mkdir(at('/srv/app/d'), { recursive: true });
    await fs.writeFile(at('/srv/app/d/a.txt'), 'aa');
    await fs.writeFile(at('/srv/app/d/b.txt'), 'bb');
    await call(sock, CCU_OP.LIST, 0, '/srv/app/d');
    assert.deepEqual((await fs.readdir(inMirror('/srv/app/d'))).sort(), ['a.txt', 'b.txt']);

    await fs.rm(at('/srv/app/d/b.txt'));
    const r = await call(sock, CCU_OP.LIST, 0, '/srv/app/d');
    assert.equal(r.status, CCU_STATUS.READY);
    assert.deepEqual(await fs.readdir(inMirror('/srv/app/d')), ['a.txt'], 'b.txt lingered as a ghost');
  });

  test('LIST of a directory the source does not have is ABSENT', async () => {
    const r = await call(sock, CCU_OP.LIST, 0, '/srv/app/nope');
    assert.equal(r.status, CCU_STATUS.ABSENT);
    assert.equal(r.err, ENOENT);
  });

  // PINS: FETCH always copies, with no revalidation shortcut, so freshness at
  // open is exact — that is the contract S3's per-open revalidate inherits.
  // Dies if FETCH skips the copy when the stub's size already matches.
  test('FETCH copies the bytes, and copies them AGAIN when the source changes', async () => {
    await fs.writeFile(at('/srv/app/f.txt'), 'first');
    await call(sock, CCU_OP.FETCH, 0, '/srv/app/f.txt');
    assert.equal(await fs.readFile(inMirror('/srv/app/f.txt'), 'utf8'), 'first');

    // Same LENGTH, different bytes: a size-and-mtime shortcut would miss it.
    await fs.writeFile(at('/srv/app/f.txt'), 'SECON');
    await fs.utimes(at('/srv/app/f.txt'), new Date(0), new Date(0));
    const r = await call(sock, CCU_OP.FETCH, 0, '/srv/app/f.txt');
    assert.equal(r.status, CCU_STATUS.READY);
    assert.equal(await fs.readFile(inMirror('/srv/app/f.txt'), 'utf8'), 'SECON');
  });

  // PINS: `for_create` asks about the PARENT, because the path itself
  // legitimately does not exist yet — the create is what will make it.
  test('FETCH for_create makes the parent and does not refuse the absent child', async () => {
    const r = await call(sock, CCU_OP.FETCH, CCU_FLAG_FOR_CREATE, '/srv/app/d/new.txt');
    assert.equal(r.status, CCU_STATUS.READY, 'a create into an existing parent must be allowed');
    await fs.access(inMirror('/srv/app/d'));

    const r2 = await call(sock, CCU_OP.FETCH, CCU_FLAG_FOR_CREATE, '/srv/app/no/such/parent.txt');
    assert.equal(r2.status, CCU_STATUS.ABSENT, 'but a create with no parent on the source is not');
  });

  // PINS: DIRTY pushes back CARRYING THE MODE. An atomic write ends in a
  // rename, and a rename hands the replacement fresh permissions — so an
  // edited shell script silently loses its executable bit without this.
  test('DIRTY pushes the mirror copy back, executable bit and all', async () => {
    await fs.writeFile(at('/srv/app/run.sh'), '#!/bin/sh\nold\n');
    await call(sock, CCU_OP.FETCH, 0, '/srv/app/run.sh');
    await fs.writeFile(inMirror('/srv/app/run.sh'), '#!/bin/sh\nnew\n');
    await fs.chmod(inMirror('/srv/app/run.sh'), 0o755);

    const r = await call(sock, CCU_OP.DIRTY, 0, '/srv/app/run.sh');
    assert.equal(r.status, CCU_STATUS.READY);
    assert.equal(await fs.readFile(at('/srv/app/run.sh'), 'utf8'), '#!/bin/sh\nnew\n');
    assert.equal((await fs.stat(at('/srv/app/run.sh'))).mode & 0o777, 0o755, 'the mode did not cross');
  });

  // PINS THE CREATE WINDOW, and it is a defect the real gate found (R3): a file
  // created through the union exists in the MIRROR from `create` and on the
  // SOURCE only once `release` pushes it. libfuse issues a `getattr`
  // immediately after every `create`, so cc is asked about the path inside that
  // window — and answering ABSENT there fails the create AND deletes the file
  // the worker just wrote, because #stat removes what the source no longer has.
  test('a file created through the union survives the getattr before its push', async () => {
    const p = '/srv/app/created.txt';
    // The create: FETCH with for_create, on a path the source does not have.
    const created = await call(sock, CCU_OP.FETCH, CCU_FLAG_FOR_CREATE, p);
    assert.equal(created.status, CCU_STATUS.READY);
    // The daemon then writes it into the mirror, exactly as pt_create does.
    await fs.writeFile(inMirror(p), 'written but not pushed');

    const after = await call(sock, CCU_OP.STAT, 0, p);
    assert.equal(after.status, CCU_STATUS.READY, 'the post-create getattr reported the file absent');
    assert.equal(await fs.readFile(inMirror(p), 'utf8'), 'written but not pushed',
      'the stale-entry removal deleted a file that was never on the source');

    // A LIST of the parent must not reap it as a ghost either.
    await call(sock, CCU_OP.LIST, 0, '/srv/app');
    await fs.access(inMirror(p));

    // And once the push lands, the protection is dropped: the path is now the
    // source's, so a later deletion there is an ordinary stale entry again.
    assert.equal((await call(sock, CCU_OP.DIRTY, 0, p)).status, CCU_STATUS.READY);
    assert.equal(await fs.readFile(at(p), 'utf8'), 'written but not pushed');
    await fs.rm(at(p));
    assert.equal((await call(sock, CCU_OP.STAT, 0, p)).status, CCU_STATUS.ABSENT);
    await assert.rejects(() => fs.access(inMirror(p)), 'the entry stayed protected after its push');
  });

  // PINS the self-healing half: a locally created path whose mirror file has
  // gone leaves nothing to protect, so it must stop being reported present.
  test('a created-then-unlinked path stops being reported present', async () => {
    const p = '/srv/app/ephemeral.txt';
    assert.equal((await call(sock, CCU_OP.FETCH, CCU_FLAG_FOR_CREATE, p)).status, CCU_STATUS.READY);
    await fs.writeFile(inMirror(p), 'x');
    assert.equal((await call(sock, CCU_OP.STAT, 0, p)).status, CCU_STATUS.READY);
    await fs.rm(inMirror(p));                       // as pt_unlink would
    assert.equal((await call(sock, CCU_OP.STAT, 0, p)).status, CCU_STATUS.ABSENT);
  });

  // ── THE RECONCILE ─────────────────────────────────────────────────────────
  //
  // `DIRTY` means "the mirror at P is authoritative — make the source match
  // it", and that generality is what lets every mutating op land through ONE
  // frame instead of a frame per op. These are its branches. Each one is a
  // project-tier mutation that, before this, changed the mirror and reached the
  // system never.

  // mkdir. Dies if the reconcile only handles files.
  test('DIRTY lands a directory the mirror gained', async () => {
    const p = '/srv/app/newdir';
    await fs.mkdir(inMirror(p), { recursive: true });
    await fs.chmod(inMirror(p), 0o750);
    const r = await call(sock, CCU_OP.DIRTY, 0, p);
    assert.equal(r.status, CCU_STATUS.READY);
    const st = await fs.lstat(at(p));
    assert.equal(st.isDirectory(), true, 'the directory never reached the source');
    assert.equal(st.mode & 0o777, 0o750);
  });

  // unlink. Dies if an absent mirror entry is treated as "nothing to do" —
  // which is what let `rm` report success while the file resurrected.
  test('DIRTY lands a deletion the mirror made', async () => {
    const p = '/srv/app/doomed.txt';
    await fs.writeFile(at(p), 'still here');
    await call(sock, CCU_OP.FETCH, 0, p);
    await fs.rm(inMirror(p));                       // as pt_unlink would
    const r = await call(sock, CCU_OP.DIRTY, 0, p);
    assert.equal(r.status, CCU_STATUS.READY);
    await assert.rejects(() => fs.access(at(p)), 'the file survived on the source');
  });

  // rmdir, and the reason the removal is NON-RECURSIVE. The mirror may be
  // sparser than the source, so a source directory with children the worker
  // never saw must refuse rather than be deleted — and the op then fails.
  test('DIRTY refuses to delete a source directory the mirror never fully held', async () => {
    const p = '/srv/app/deep';
    await fs.mkdir(at(p), { recursive: true });
    await fs.writeFile(path.join(at(p), 'unseen.txt'), 'never mirrored');
    await fs.mkdir(inMirror(p), { recursive: true });
    await fs.rmdir(inMirror(p));                    // as pt_rmdir would
    const r = await call(sock, CCU_OP.DIRTY, 0, p);
    assert.equal(r.status, CCU_STATUS.REFUSED, 'a subtree the worker never saw was deleted');
    assert.equal(r.err, EIO);
    await fs.access(path.join(at(p), 'unseen.txt'));
    // …and an EMPTY one does land, so the refusal above is the non-empty case
    // and not a blanket inability.
    const q = '/srv/app/empty';
    await fs.mkdir(at(q), { recursive: true });
    await fs.mkdir(inMirror(q), { recursive: true });
    await fs.rmdir(inMirror(q));
    assert.equal((await call(sock, CCU_OP.DIRTY, 0, q)).status, CCU_STATUS.READY);
    await assert.rejects(() => fs.access(at(q)));
  });

  // rename, which is two reconciles: the old name is absent from the mirror and
  // the new one is present, exactly as `pt_rename` pushes both ends.
  test('DIRTY on both ends lands a rename', async () => {
    const from = '/srv/app/before.txt', to = '/srv/app/after.txt';
    await fs.writeFile(at(from), 'moved bytes');
    await call(sock, CCU_OP.FETCH, 0, from);
    await fs.rename(inMirror(from), inMirror(to));  // as pt_rename would
    assert.equal((await call(sock, CCU_OP.DIRTY, 0, from)).status, CCU_STATUS.READY);
    assert.equal((await call(sock, CCU_OP.DIRTY, 0, to)).status, CCU_STATUS.READY);
    await assert.rejects(() => fs.access(at(from)), 'the old name survived');
    assert.equal(await fs.readFile(at(to), 'utf8'), 'moved bytes');
  });

  // chmod and utimens: the reconcile carries mode AND times, because "make the
  // source match the mirror entry" is what it means.
  test('DIRTY lands a mode and an mtime change', async () => {
    const p = '/srv/app/perm.sh';
    await fs.writeFile(at(p), '#!/bin/sh\n');
    await call(sock, CCU_OP.FETCH, 0, p);
    await fs.chmod(inMirror(p), 0o755);
    await fs.utimes(inMirror(p), new Date(60_000), new Date(60_000));
    assert.equal((await call(sock, CCU_OP.DIRTY, 0, p)).status, CCU_STATUS.READY);
    const st = await fs.stat(at(p));
    assert.equal(st.mode & 0o777, 0o755);
    assert.equal(Math.floor(st.mtimeMs), 60_000);
  });

  // symlink, the fourth kind RemoteStat can express.
  test('DIRTY lands a symlink, and re-points one that moved', async () => {
    const p = '/srv/app/newlink';
    await fs.symlink('one.txt', inMirror(p));
    assert.equal((await call(sock, CCU_OP.DIRTY, 0, p)).status, CCU_STATUS.READY);
    assert.equal(await fs.readlink(at(p)), 'one.txt');
    await fs.rm(inMirror(p)); await fs.symlink('two.txt', inMirror(p));
    assert.equal((await call(sock, CCU_OP.DIRTY, 0, p)).status, CCU_STATUS.READY);
    assert.equal(await fs.readlink(at(p)), 'two.txt');
  });

  // A source entry of the WRONG KIND is replaced, not adjusted — a file that
  // became a directory in the mirror cannot be chmod'd into one on the source.
  test('DIRTY replaces a source entry whose kind changed', async () => {
    const p = '/srv/app/wasfile';
    await fs.writeFile(at(p), 'a file');
    await fs.rm(inMirror(p), { force: true });
    await fs.mkdir(inMirror(p), { recursive: true });
    assert.equal((await call(sock, CCU_OP.DIRTY, 0, p)).status, CCU_STATUS.READY);
    assert.equal((await fs.lstat(at(p))).isDirectory(), true);
  });

  // PINS: a mirror entry of the WRONG KIND is replaced, not adjusted — a
  // directory that became a file on the source cannot be chmod'd into one.
  test('a kind change replaces the mirror entry', async () => {
    await fs.mkdir(at('/srv/app/flip'), { recursive: true });
    await call(sock, CCU_OP.STAT, 0, '/srv/app/flip');
    assert.equal((await fs.lstat(inMirror('/srv/app/flip'))).isDirectory(), true);

    await fs.rmdir(at('/srv/app/flip'));
    await fs.writeFile(at('/srv/app/flip'), 'now a file');
    await call(sock, CCU_OP.STAT, 0, '/srv/app/flip');
    assert.equal((await fs.lstat(inMirror('/srv/app/flip'))).isFile(), true);
  });

  test('a symlink is mirrored as a symlink, and re-pointed when it moves', async () => {
    await fs.symlink('a.txt', at('/srv/app/link'));
    await call(sock, CCU_OP.STAT, 0, '/srv/app/link');
    assert.equal(await fs.readlink(inMirror('/srv/app/link')), 'a.txt');

    await fs.rm(at('/srv/app/link'));
    await fs.symlink('b.txt', at('/srv/app/link'));
    await call(sock, CCU_OP.STAT, 0, '/srv/app/link');
    assert.equal(await fs.readlink(inMirror('/srv/app/link')), 'b.txt');
  });

  // PINS: AN EXCLUDED PATH IS NOT MATERIALISED, NAME OR METADATA. The daemon
  // suppresses a `fail` child from a listing on the way out; this is the half
  // that keeps it from being written to this machine at all — its size, mode
  // and mtime are exactly what the exclusion withholds, and a `#shape`d stub
  // would put all three in the mirror and the name in the parent's readdir.
  //
  // Dies if `#list` drops the tier filter, or if `#handle` stops refusing a
  // non-project path.
  test('an excluded child is neither served nor shaped into the mirror', async () => {
    await fs.mkdir(at('/srv/app/secrets'), { recursive: true });
    await fs.writeFile(at('/srv/app/secrets/key.pem'), 'PRIVATE-KEY-BYTES');
    await fs.writeFile(at('/srv/app/ordinary.txt'), 'fine');

    // Asked about directly: refused, and cc chooses the errno.
    const direct = await call(sock, CCU_OP.STAT, 0, '/srv/app/secrets/key.pem');
    assert.equal(direct.status, CCU_STATUS.REFUSED);
    assert.equal(direct.err, EACCES);

    // And reached as a CHILD of a directory that IS served: the listing must
    // carry the sibling and not the excluded one.
    const listed = await call(sock, CCU_OP.LIST, 0, '/srv/app');
    assert.equal(listed.status, CCU_STATUS.READY);
    const names = await fs.readdir(inMirror('/srv/app'));
    assert.ok(names.includes('ordinary.txt'), names.join(','));
    assert.ok(!names.includes('secrets'), `the excluded name reached the mirror: ${names.join(',')}`);
    await assert.rejects(() => fs.access(inMirror('/srv/app/secrets')));
  });

  // PINS: the serialisation key is the PATH, so a STAT waits on an in-flight
  // FETCH of the same path. With the op in the key it does not, and #shape's
  // truncate re-shapes the mirror copy to the source's size underneath a
  // writable handle — destroying bytes the DIRTY then pushes as a mangled copy.
  test('a STAT waits on an in-flight FETCH of the same path', async () => {
    const p = '/srv/app/slow.txt';
    await fs.writeFile(at(p), 'SOURCE-BYTES');
    // A source whose fetch is slow enough to overlap, wrapping the real one so
    // everything else about it stays the product's.
    const base = localDirSource(srcRoot);
    let fetching = false, overlapped = false;
    const slow = {
      ...base,
      async fetch(q, dest) {
        fetching = true;
        await new Promise(r => setTimeout(r, 60));
        const out = await base.fetch(q, dest);
        fetching = false;
        return out;
      },
      async stat(q) { if (fetching && q === p) overlapped = true; return base.stat(q); },
    };
    const s2 = await ControlServer.listen({
      socketPath: path.join(box, 'ctl2.sock'), mirror, source: slow, tiers, log: (l) => logs.push(l),
    });
    const c2 = await connect(s2.socketPath);
    try {
      const fetch = call(c2, CCU_OP.FETCH, 0, p);
      await new Promise(r => setTimeout(r, 10));
      const stat = await Promise.race([
        call(c2, CCU_OP.STAT, 0, p).then(() => 'stat-first'),
        fetch.then(() => 'fetch-first'),
      ]);
      assert.equal(stat, 'fetch-first', 'a STAT overtook an in-flight FETCH of the same path');
      assert.equal(overlapped, false, 'the STAT reached the source while the FETCH was still running');
    } finally { c2.destroy(); await s2.close(); }
  });

  // PINS: the handler writes ONLY inside the mirror. The daemon's paths come
  // from the kernel and are normalised, so this is a belt on a brace — but the
  // mirror is the one directory cc writes on a worker's behalf.
  test('a path escaping the mirror is REFUSED, not clamped', async () => {
    const r = await call(sock, CCU_OP.STAT, 0, '/../../escape');
    assert.equal(r.status, CCU_STATUS.REFUSED);
    assert.equal(r.err, EACCES);
    await assert.rejects(() => fs.access(path.join(box, 'escape')));
  });

  test('an unknown op is REFUSED with EIO and logged', async () => {
    const before = logs.length;
    const r = await call(sock, 99, 0, '/srv/app');
    assert.equal(r.status, CCU_STATUS.REFUSED);
    assert.equal(r.err, EIO);
    assert.ok(logs.slice(before).some(l => l.includes('unknown op 99')), logs.slice(before).join('|'));
  });

  // PINS: replies leave in REQUEST ORDER even though the handlers are async.
  // A daemon thread reads exactly one reply per request off a stream; reorder
  // them and every answer after the first is attributed to the wrong path.
  test('pipelined requests are answered in order', async () => {
    await fs.writeFile(at('/srv/app/one'), '1');
    await fs.writeFile(at('/srv/app/two'), '22');
    const s2 = await connect(sockPath);
    try {
      const replies = [];
      s2.on('data', (c) => { for (let i = 0; i + CCU_REPLY_LEN <= c.length; i += CCU_REPLY_LEN) replies.push(c[i + 4]); });
      s2.write(Buffer.concat([
        encodeRequest(CCU_OP.STAT, 0, '/srv/app/one'),
        encodeRequest(CCU_OP.STAT, 0, '/srv/app/nope'),
        encodeRequest(CCU_OP.STAT, 0, '/srv/app/two'),
      ]));
      await new Promise((r) => { const t = setInterval(() => { if (replies.length >= 3) { clearInterval(t); r(); } }, 5); });
      assert.deepEqual(replies.slice(0, 3), [CCU_STATUS.READY, CCU_STATUS.ABSENT, CCU_STATUS.READY]);
    } finally { s2.destroy(); }
  });

  // PINS: a frame cc cannot act on kills the CONNECTION. The stream is out of
  // frame, so every later byte would be misread — answering and continuing
  // would serve the worker files it never asked about.
  test('a bad magic drops the connection rather than resyncing', async () => {
    const s3 = await connect(sockPath);
    const closed = new Promise((r) => s3.once('close', r));
    const bad = encodeRequest(CCU_OP.STAT, 0, '/srv/app');
    bad[0] ^= 0xff;
    s3.write(bad);
    await closed;
    assert.ok(logs.some(l => l.includes('bad magic')), logs.join('|'));
    s3.destroy();
  });

  // PINS: the codec's own round trip, so a decode change that happens to match
  // a matching encode change is still caught by the C-side vectors.
  test('a frame split across two writes is reassembled', async () => {
    const s4 = await connect(sockPath);
    try {
      const frame = encodeRequest(CCU_OP.STAT, 0, '/srv/app/one');
      const got = new Promise((r) => s4.once('data', (c) => r(c)));
      s4.write(frame.subarray(0, 5));
      await new Promise((r) => setTimeout(r, 10));
      s4.write(frame.subarray(5));
      const c = await got;
      assert.equal(c[4], CCU_STATUS.READY);
    } finally { s4.destroy(); }
  });

  test('decodeRequests leaves a partial frame in `rest` and refuses an over-long path', () => {
    const frame = encodeRequest(CCU_OP.STAT, 0, '/abc');
    const d = decodeRequests(frame.subarray(0, 6));
    assert.deepEqual(d.frames, []);
    assert.equal(d.rest.length, 6);
    const over = Buffer.alloc(8);
    over.writeUInt32BE(CCU_MAGIC, 0);
    over.writeUInt16BE(65535, 6);
    assert.match(decodeRequests(over).error, /path length 65535 exceeds/);
  });

  test('encodeReply lays the fourteen bytes out big-endian', () => {
    const b = encodeReply(CCU_STATUS.ABSENT, ENOENT);
    assert.equal(b.length, CCU_REPLY_LEN);
    assert.deepEqual([...b], [0x43, 0x43, 0x55, 0x31, 1, 0, 0, 0, 0, 2, 0, 0, 0, 0]);
  });
});

describe('localDirSource — the S2 fake remote', () => {
  let root, box;
  before(async () => {
    box = await mkdtemp('cc-src-');
    root = path.join(box, 'remote');
    await fs.mkdir(path.join(root, 'a'), { recursive: true });
    await fs.writeFile(path.join(root, 'a', 'f'), 'hello');
  });

  // PINS: a path that escapes the root is a REFUSAL, not a clamp. A silent
  // clamp would serve a different file than the one asked about.
  test('a path escaping the root is refused, not clamped', async () => {
    const s = localDirSource(root);
    assert.equal(await s.stat('/../../etc/passwd'), null);
    assert.equal(await s.list('/../..'), null);
    assert.equal(await s.fetch('/../../etc/passwd', path.join(box, 'stolen')), 'refused');
    assert.deepEqual(Object.keys(await s.push(path.join(root, 'a/f'), '/../../escaped')), ['error']);
    await assert.rejects(() => fs.access(path.join(box, 'stolen')));
  });

  test('the root itself is addressable as /', async () => {
    const s = localDirSource(root);
    assert.equal((await s.stat('/')).kind, 'dir');
    assert.deepEqual((await s.list('/')).map(c => c.name), ['a']);
  });

  // PINS: a device, fifo or socket has no faithful mirror representation, and
  // a regular file standing in for one would answer wrongly about what it is.
  test('a kind with no faithful mirror representation is reported absent', async () => {
    const s = localDirSource(root);
    const { execFileSync } = await import('node:child_process');
    execFileSync('mkfifo', [path.join(root, 'pipe')]);
    assert.equal(await s.stat('/pipe'), null);
    assert.deepEqual((await s.list('/')).map(c => c.name).sort(), ['a'], 'and is omitted from a listing');
  });
});
