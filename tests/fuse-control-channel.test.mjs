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
         CCU_OP, CCU_STATUS, CCU_FLAG_FOR_CREATE, CCU_FLAG_FOR_WRITE, CCU_FLAG_REMOVED, CCU_MAGIC, CCU_REPLY_LEN } from '../src/systems/fuse/control.ts';
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
    const done = (fn, v) => {
      sock.off('data', onData); sock.off('error', onErr);
      sock.off('end', onEnd); sock.off('close', onEnd);
      fn(v);
    };
    const onErr = (e) => done(reject, e);
    // A SERVER-SIDE `destroy()` IS A CLEAN FIN, NOT AN `error` (card 2026-0371).
    // `ControlServer.close()` destroys every live connection, so a frame in
    // flight across a teardown ends this stream with no error event at all —
    // and settling on `data`/`error` alone hangs until the runner's timeout,
    // which reads as a wedged handler rather than as the close it is.
    const onEnd = () => done(reject, new Error(`control socket closed with no reply to op ${op} '${p}'`));
    const onData = (c) => {
      buf = Buffer.concat([buf, c]);
      if (buf.length < CCU_REPLY_LEN) return;
      done(resolve, { magic: buf.readUInt32BE(0), status: buf[4], err: buf.readInt32BE(6), raw: buf });
    };
    sock.on('data', onData);
    sock.on('error', onErr);
    sock.on('end', onEnd);
    sock.on('close', onEnd);
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

  // ── THE FOUR DATA-LOSS ROUTES ─────────────────────────────────────────────
  //
  // All four had one root cause: the mirror is BOTH a cache cc manages and the
  // statement of what the worker did, and cc was inferring the second from the
  // first. Each test names the mutation it must die under, because a route
  // closed by a design change with no test that dies without it is not closed.

  // (a) THE WRITE WINDOW. Writes go straight into the mirror inode through the
  // worker's fd, so between the open's FETCH and the release's DIRTY there is
  // NO FRAME AT THAT PATH — nothing for the per-path queue to order. Any STAT,
  // second FETCH, or LIST of the parent used to re-shape the open inode to the
  // source's size and destroy the unpushed bytes.
  //
  // DIES UNDER: dropping the `#claimHolds` guard from `#stat`, from `#fetch`,
  // or the `#claimed.has(child)` skip from `#list`.
  test('(a) a claimed path is not re-shaped by a STAT, a LIST or a second FETCH', async () => {
    const p = '/srv/app/one.txt';
    await fs.writeFile(at(p), 'SOURCE-SHORT\n');

    // The open: a writable handle takes the claim — AND STILL MATERIALISES.
    // A worker opening an existing file for write needs its current bytes, so
    // the claim check must read the state BEFORE this frame's own claim. If it
    // did not, every write-open would see an empty file.
    await fs.rm(inMirror(p), { force: true });
    assert.equal((await call(sock, CCU_OP.FETCH, CCU_FLAG_FOR_WRITE, p)).status, CCU_STATUS.READY);
    assert.equal(await fs.readFile(inMirror(p), 'utf8'), 'SOURCE-SHORT\n',
      'the taking FETCH short-circuited and never materialised');
    // The worker writes through its fd — more bytes than the source has.
    const written = 'WORKER-WROTE-MUCH-MORE-THAN-THE-SOURCE-HAS\n';
    await fs.writeFile(inMirror(p), written);

    // Every frame that used to clobber it, including a LIST of the parent,
    // which is a DIFFERENT queue key and so never serialised against the write.
    assert.equal((await call(sock, CCU_OP.STAT, 0, p)).status, CCU_STATUS.READY);
    assert.equal((await call(sock, CCU_OP.LIST, 0, '/srv/app')).status, CCU_STATUS.READY);
    assert.equal((await call(sock, CCU_OP.FETCH, 0, p)).status, CCU_STATUS.READY);
    assert.equal(await fs.readFile(inMirror(p), 'utf8'), written,
      'the unpushed bytes were destroyed while the handle was open');

    // …and the release pushes what the worker actually wrote, not a mix.
    assert.equal((await call(sock, CCU_OP.DIRTY, 0, p)).status, CCU_STATUS.READY);
    assert.equal(await fs.readFile(at(p), 'utf8'), written);

    // NON-VACUITY: once the claim is released the cache resumes, so the guard
    // is scoped to the window and not a blanket "never re-shape".
    await fs.writeFile(at(p), 'SOURCE-CHANGED\n');
    assert.equal((await call(sock, CCU_OP.FETCH, 0, p)).status, CCU_STATUS.READY);
    assert.equal(await fs.readFile(inMirror(p), 'utf8'), 'SOURCE-CHANGED\n');
  });

  // (b) A TRANSIENT READ ERROR IS NOT ABSENCE. `stat`/`list` used to swallow
  // every errno into `null`; the handler then unmirrored a live entry and the
  // reconcile deleted the SOURCE file. A single failed `readdir` took the whole
  // directory with it.
  //
  // DIES UNDER: `isSourceError` collapsed back into `null`, in `#stat`,
  // `#list` or `#fetch`.
  test('(b) a source that fails once refuses, and removes nothing', async () => {
    const p = '/srv/app/flaky.txt';
    await fs.writeFile(at(p), 'REAL\n');
    let failStat = 0, failList = 0;
    const base = localDirSource(srcRoot);
    const flaky = {
      ...base,
      stat: async (q) => (failStat-- > 0 ? { error: 'EMFILE: too many open files' } : base.stat(q)),
      list: async (q) => (failList-- > 0 ? { error: 'EMFILE: too many open files' } : base.list(q)),
    };
    const srv = await ControlServer.listen({
      socketPath: path.join(box, 'flaky.sock'), mirror, source: flaky, tiers, log: () => {},
    });
    const c = await connect(srv.socketPath);
    try {
      await call(c, CCU_OP.FETCH, 0, p);                       // materialise it
      assert.equal(await fs.readFile(inMirror(p), 'utf8'), 'REAL\n');

      failStat = 1;
      const r = await call(c, CCU_OP.STAT, 0, p);
      assert.equal(r.status, CCU_STATUS.REFUSED, 'a read error was reported as absence');
      assert.equal(r.err, EIO);
      assert.equal(await fs.readFile(inMirror(p), 'utf8'), 'REAL\n',
        'the mirror entry was removed on a transient read error');

      failList = 1;
      const l = await call(c, CCU_OP.LIST, 0, '/srv/app');
      assert.equal(l.status, CCU_STATUS.REFUSED);
      assert.equal(await fs.readFile(inMirror(p), 'utf8'), 'REAL\n',
        'a failed readdir unmirrored the whole directory');

      // …and the SOURCE file is untouched throughout, which is the loss.
      assert.equal(await fs.readFile(at(p), 'utf8'), 'REAL\n');
    } finally { c.destroy(); await srv.close(); }
  });

  // (c) A RE-MATERIALISE BETWEEN THE MUTATION AND THE RECONCILE. The daemon
  // unlinks `mirror/p` and sends DIRTY; a STAT arriving between them is a
  // separate queue entry and used to re-create `p` as a sparse zero-stub, which
  // the reconcile then copied onto the source — `rm` reporting success, the
  // dirent surviving, the bytes zeroed.
  //
  // DIES UNDER: dropping the `#claimHolds` guard from `#stat`, or inferring the
  // removal from the mirror instead of reading the REMOVED bit.
  test('(c) a STAT between the unlink and its reconcile cannot resurrect the path', async () => {
    const p = '/srv/app/doomed-c.txt';
    await fs.writeFile(at(p), 'REAL-CONTENT\n');
    assert.equal((await call(sock, CCU_OP.FETCH, CCU_FLAG_FOR_WRITE, p)).status, CCU_STATUS.READY);
    await fs.rm(inMirror(p));                                   // as pt_unlink would

    // THE INTERLOPER, and what it must answer: the source still has the file,
    // but the worker has removed it from the mirror, so a claimed path with no
    // mirror entry is ABSENT — reported from the claim, never re-created. A
    // zero-stub here is what the reconcile would then copy onto the source.
    const mid = await call(sock, CCU_OP.STAT, 0, p);
    assert.equal(mid.status, CCU_STATUS.ABSENT);
    await assert.rejects(() => fs.access(inMirror(p)),
      'the claimed path was re-stubbed between the unlink and its reconcile');
    assert.equal(await fs.readFile(at(p), 'utf8'), 'REAL-CONTENT\n',
      'the source was touched before the reconcile said so');

    assert.equal((await call(sock, CCU_OP.DIRTY, CCU_FLAG_REMOVED, p)).status, CCU_STATUS.READY);
    await assert.rejects(() => fs.access(at(p)), 'the deletion did not land');
  });

  // (d) TEARDOWN MUST NOT MANUFACTURE AN ABSENCE. `close()` destroys sockets
  // but does not stop an already-dequeued handler, and teardown's next act is
  // `rm -rf` of the run directory — so a handler running across it saw a mirror
  // that was being deleted.
  //
  // DIES UNDER: dropping the `#inflight` drain from `close()`, or the
  // `#closing` refusal from `#handle`.
  test('(d) close() waits for an in-flight handler and refuses anything after it', async () => {
    const p = '/srv/app/inflight.txt';
    await fs.writeFile(at(p), 'BEFORE\n');
    // `held` is resolved in the `finally` below whatever happens, so a failing
    // assertion cannot leave the handler blocked. It is given a deadline of its
    // own too, so the handler cannot outlive the test even if `release` is
    // somehow never reached.
    // `unref`'d, or the deadline itself keeps the event loop alive after the
    // test returns and the FILE never reports.
    let release; const held = Promise.race([
      new Promise((r) => { release = r; }),
      new Promise((r) => { setTimeout(r, 20_000).unref(); }),
    ]);
    let started; const entered = new Promise((r) => { started = r; });
    let pushed = false;
    const base = localDirSource(srcRoot);
    const slow = {
      ...base,
      push: async (src, q) => { started(); await held; pushed = true; return base.push(src, q); },
    };
    const srv = await ControlServer.listen({
      socketPath: path.join(box, 'slow.sock'), mirror, source: slow, tiers, log: () => {},
    });
    const c = await connect(srv.socketPath);
    const c2 = await connect(srv.socketPath);
    let closing = Promise.resolve();
    try {
      await call(c, CCU_OP.FETCH, CCU_FLAG_FOR_WRITE, p);
      await fs.writeFile(inMirror(p), 'IN FLIGHT\n');
      // Caught at creation: `close()` destroys the socket after the drain, so
      // whether this reply lands is a race the test does not need to win — the
      // assertion is that the HANDLER ran to completion before close returned.
      const inFlight = call(c, CCU_OP.DIRTY, 0, p).catch((e) => e);
      // DETERMINISTIC: wait until the handler is genuinely inside `push`
      // before closing. Racing `close()` against the frame's arrival would
      // pass with an empty in-flight map and prove nothing.
      await entered;

      let closed = false;
      closing = srv.close().then(() => { closed = true; });
      await new Promise((r) => setTimeout(r, 30));

      // THE `#closing` HALF, on a SECOND connection opened before the close.
      // Two earlier cuts were wrong: one connected after `close()` resolved,
      // by which time the listener was gone and the arm was dead code; the
      // other reused `c`, whose reply chain is serialised behind the blocked
      // handler, so the frame could not be dispatched until after the drain.
      // A separate socket dispatches immediately, which is the state that
      // matters — a frame arriving mid-drain must not start against a mirror
      // about to be deleted.
      const late = await call(c2, CCU_OP.STAT, 0, '/srv/app/two.txt').catch(() => null);
      assert.ok(late, 'the late frame got no reply at all');
      assert.equal(late.status, CCU_STATUS.REFUSED, 'a frame ran after close() began');
      assert.equal(late.err, EIO);
      assert.equal(closed, false, 'close() returned while a handler was still running');
      assert.equal(pushed, false);

      release();
      await closing;
      assert.equal(pushed, true, 'the in-flight handler was abandoned rather than drained');
      await inFlight;
      assert.equal(await fs.readFile(at(p), 'utf8'), 'IN FLIGHT\n');


    } finally {
      // RELEASED HERE, NOT ONLY ON THE HAPPY PATH. Any failing assertion above
      // used to skip `release()`, and `srv.close()` then awaited the drain of a
      // handler that could never finish — so the test WEDGED instead of
      // failing, and a mutation prover got TIMEOUT rather than a graded
      // verdict. In CI that hangs rather than reds, which is worse than a
      // failure. A test whose cleanup depends on its own assertions passing
      // cannot fail cleanly.
      release();
      await Promise.race([closing, new Promise((r) => { setTimeout(r, 5000).unref(); })]);
      c.destroy(); c2.destroy();
      await srv.close().catch(() => {});
    }
  });

  // F6 — THE CLAIM SURVIVES A flush, and is released only by the close.
  // `flush` fires once per `close` of a DUPLICATED descriptor while the
  // original handle stays open. Releasing the claim there left the next write
  // batch on that handle unprotected and reopened the whole destruction
  // window — so a DIRTY carrying FOR_WRITE reconciles without releasing.
  //
  // DIES UNDER: `#dirty` releasing unconditionally, or `pt_flush` sending a
  // bare DIRTY.
  test('a flush reconciles without releasing the claim; the close releases it', async () => {
    const p = '/srv/app/dup.log';
    await fs.writeFile(at(p), 'ORIGINAL\n');
    assert.equal((await call(sock, CCU_OP.FETCH, CCU_FLAG_FOR_WRITE, p)).status, CCU_STATUS.READY);

    // The worker writes and a duplicate closes: flush pushes, handle open.
    await fs.writeFile(inMirror(p), 'FIRST BATCH\n');
    assert.equal((await call(sock, CCU_OP.DIRTY, CCU_FLAG_FOR_WRITE, p)).status, CCU_STATUS.READY);
    assert.equal(await fs.readFile(at(p), 'utf8'), 'FIRST BATCH\n');

    // THE CLAIM MUST STILL HOLD: the next write batch goes into the same
    // inode, and a STAT arriving now must not re-shape it.
    await fs.writeFile(inMirror(p), 'FIRST BATCH\nSECOND BATCH\n');
    assert.equal((await call(sock, CCU_OP.STAT, 0, p)).status, CCU_STATUS.READY);
    assert.equal(await fs.readFile(inMirror(p), 'utf8'), 'FIRST BATCH\nSECOND BATCH\n',
      'the second write batch was destroyed — the claim did not survive the flush');

    // The close releases, and pushes what the handle finally held.
    assert.equal((await call(sock, CCU_OP.DIRTY, 0, p)).status, CCU_STATUS.READY);
    assert.equal(await fs.readFile(at(p), 'utf8'), 'FIRST BATCH\nSECOND BATCH\n');

    // NON-VACUITY: released, so the cache is managing the path again.
    await fs.writeFile(at(p), 'SOURCE MOVED ON\n');
    assert.equal((await call(sock, CCU_OP.FETCH, 0, p)).status, CCU_STATUS.READY);
    assert.equal(await fs.readFile(inMirror(p), 'utf8'), 'SOURCE MOVED ON\n');
  });

  // F2 — A CLAIM SURVIVES ONLY A READY. A FETCH that fails must leave none, or
  // the path becomes a blackhole: STAT answers ABSENT from the claim, LIST
  // skips shaping the child, a read-only open short-circuits READY and then
  // fails ENOENT, and a read sends no DIRTY, so nothing ever releases it.
  //
  // DIES UNDER: removing the `reply[4] !== READY` release from `#fetch`.
  test('a FETCH that fails leaves no claim behind', async () => {
    const p = '/srv/app/nodir/new.txt';
    // for_create with an absent PARENT: the frame fails.
    const r = await call(sock, CCU_OP.FETCH, CCU_FLAG_FOR_CREATE | CCU_FLAG_FOR_WRITE, p);
    assert.equal(r.status, CCU_STATUS.ABSENT);

    // The source gains the file later — through any channel.
    await fs.mkdir(path.dirname(at(p)), { recursive: true });
    await fs.writeFile(at(p), 'ARRIVED LATER\n');

    // …and it must be reachable. A leaked claim made this ABSENT for the rest
    // of the session whatever the source held.
    assert.equal((await call(sock, CCU_OP.STAT, 0, p)).status, CCU_STATUS.READY);
    assert.equal((await call(sock, CCU_OP.FETCH, 0, p)).status, CCU_STATUS.READY);
    assert.equal(await fs.readFile(inMirror(p), 'utf8'), 'ARRIVED LATER\n');
  });

  // P1 — A THROW OUT OF THE BODY RELEASES THE CLAIM TOO. The wrapper's whole
  // selling point is that a failure path added later cannot forget, and only
  // its REPLY arm was driven — the `catch` arm was unmeasured, so a throw left
  // the per-path blackhole the wrapper exists to prevent.
  //
  // DIES UNDER: deleting `this.#claimed.delete(p)` from the catch arm.
  test('a FETCH whose source THROWS leaves no claim behind', async () => {
    const p = '/srv/app/thrower.txt';
    await fs.writeFile(at(p), 'REAL\n');
    let boom = 0;
    const base = localDirSource(srcRoot);
    const throwy = {
      ...base,
      // REJECTS rather than returning {error}: an exception is not a value the
      // handler inspects, so it takes a different path out of the body.
      stat: async (q) => { if (boom-- > 0) throw new Error('EIO: source exploded'); return base.stat(q); },
    };
    const srv = await ControlServer.listen({
      socketPath: path.join(box, 'throwy.sock'), mirror, source: throwy, tiers, log: () => {},
    });
    const c = await connect(srv.socketPath);
    try {
      boom = 1;
      const r = await call(c, CCU_OP.FETCH, CCU_FLAG_FOR_WRITE, p);
      assert.equal(r.status, CCU_STATUS.REFUSED, 'a throw was not reported');

      // THE PATH MUST STILL BE REACHABLE. A leaked claim makes STAT answer
      // ABSENT from it whatever the source holds, for the rest of the session.
      assert.equal((await call(c, CCU_OP.STAT, 0, p)).status, CCU_STATUS.READY,
        'the throw leaked a claim — this path is now a blackhole');
      assert.equal((await call(c, CCU_OP.FETCH, 0, p)).status, CCU_STATUS.READY);
      assert.equal(await fs.readFile(inMirror(p), 'utf8'), 'REAL\n');
    } finally { c.destroy(); await srv.close(); }
  });

  // P2 — A LIST OF A CLAIMED DIRECTORY WHOSE SOURCE ENTRY HAS VANISHED must not
  // unmirror it. Route (a) LISTs the PARENT of a claimed file, which is a
  // different guard; this is the arm where the claimed path is the directory
  // being listed, and the mirror entry the worker holds is what gets destroyed.
  //
  // DIES UNDER: dropping `if (this.#claimHeld(p)) return READY;` from #list's
  // `kids === null` arm.
  test('a LIST of a claimed directory the source lost keeps the mirror entry', async () => {
    const d = '/srv/app/claimeddir';
    await fs.mkdir(at(d), { recursive: true });
    await fs.writeFile(path.join(at(d), 'inside.txt'), 'HELD\n');

    // The worker claims the directory, as `rmdir`/`mkdir` on it would.
    assert.equal((await call(sock, CCU_OP.FETCH, CCU_FLAG_FOR_WRITE, d)).status, CCU_STATUS.READY);
    await fs.mkdir(inMirror(d), { recursive: true });
    await fs.writeFile(path.join(inMirror(d), 'worker.txt'), 'UNPUSHED\n');

    // The source loses it out from under the claim.
    await fs.rm(at(d), { recursive: true, force: true });

    const r = await call(sock, CCU_OP.LIST, 0, d);
    assert.equal(r.status, CCU_STATUS.READY, 'a claimed directory was reported absent');
    assert.equal(await fs.readFile(path.join(inMirror(d), 'worker.txt'), 'utf8'), 'UNPUSHED\n',
      'the claimed directory the worker holds was unmirrored');

    // NON-VACUITY: an UNCLAIMED directory the source lost is still unmirrored,
    // so the guard is scoped to the claim and not a blanket "never unmirror".
    const e = '/srv/app/looseddir';
    await fs.mkdir(at(e), { recursive: true });
    assert.equal((await call(sock, CCU_OP.LIST, 0, e)).status, CCU_STATUS.READY);
    await fs.rm(at(e), { recursive: true, force: true });
    assert.equal((await call(sock, CCU_OP.LIST, 0, e)).status, CCU_STATUS.ABSENT);
    await assert.rejects(() => fs.access(inMirror(e)));
  });

  // P3 — THE UNCLAIMED-ABSENT DIRTY ARM, in both directions. It is REACHABLE:
  // a worker that unlinks a file it still holds open (`exec 3>f; rm f; exec
  // 3>&-`) sends DIRTY+REMOVED from the unlink, which releases the claim, and
  // then the close's flush/release send a bit-clear DIRTY at a path that is now
  // absent AND unclaimed. That op's reconcile already landed, so READY is the
  // truthful answer and REFUSED would fail an op that succeeded.
  //
  // The CLAIMED complement is the opposite answer: cc was holding the entry for
  // a worker and has lost it, which is cc's own failure and must refuse.
  //
  // DIES UNDER: swapping either arm's answer for the other's.
  test('a bit-clear DIRTY at an absent mirror entry: READY if unclaimed, REFUSED if claimed', async () => {
    const p = '/srv/app/reclaimed.txt';
    await fs.writeFile(at(p), 'ORIGINAL\n');

    // UNCLAIMED — the unlink already reconciled this path.
    assert.equal((await call(sock, CCU_OP.FETCH, CCU_FLAG_FOR_WRITE, p)).status, CCU_STATUS.READY);
    await fs.rm(inMirror(p));
    assert.equal((await call(sock, CCU_OP.DIRTY, CCU_FLAG_REMOVED, p)).status, CCU_STATUS.READY);
    // …and now the still-open handle closes.
    const late = await call(sock, CCU_OP.DIRTY, 0, p);
    assert.equal(late.status, CCU_STATUS.READY,
      'an op whose reconcile already landed was told it failed');

    // CLAIMED — cc is holding the entry and has lost it. That is cc's failure,
    // and the worker must hear about it rather than believe the write landed.
    const q = '/srv/app/lostbycc.txt';
    await fs.writeFile(at(q), 'ORIGINAL\n');
    assert.equal((await call(sock, CCU_OP.FETCH, CCU_FLAG_FOR_WRITE, q)).status, CCU_STATUS.READY);
    await fs.rm(inMirror(q));
    const held = await call(sock, CCU_OP.DIRTY, 0, q);
    assert.equal(held.status, CCU_STATUS.REFUSED, 'cc losing a claimed entry was reported as success');
    assert.equal(held.err, EIO);
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
    const r = await call(sock, CCU_OP.DIRTY, CCU_FLAG_REMOVED, p);
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
    const r = await call(sock, CCU_OP.DIRTY, CCU_FLAG_REMOVED, p);
    assert.equal(r.status, CCU_STATUS.REFUSED, 'a subtree the worker never saw was deleted');
    assert.equal(r.err, EIO);
    await fs.access(path.join(at(p), 'unseen.txt'));
    // …and an EMPTY one does land, so the refusal above is the non-empty case
    // and not a blanket inability.
    const q = '/srv/app/empty';
    await fs.mkdir(at(q), { recursive: true });
    await fs.mkdir(inMirror(q), { recursive: true });
    await fs.rmdir(inMirror(q));
    assert.equal((await call(sock, CCU_OP.DIRTY, CCU_FLAG_REMOVED, q)).status, CCU_STATUS.READY);
    await assert.rejects(() => fs.access(at(q)));
  });

  // rename, which is two reconciles: the old name is absent from the mirror and
  // the new one is present, exactly as `pt_rename` pushes both ends.
  test('DIRTY on both ends lands a rename', async () => {
    const from = '/srv/app/before.txt', to = '/srv/app/after.txt';
    await fs.writeFile(at(from), 'moved bytes');
    await call(sock, CCU_OP.FETCH, 0, from);
    await fs.rename(inMirror(from), inMirror(to));  // as pt_rename would
    assert.equal((await call(sock, CCU_OP.DIRTY, CCU_FLAG_REMOVED, from)).status, CCU_STATUS.READY);
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
    // AN ERROR, NOT `null`. `null` means the source genuinely has nothing at
    // that path, and the handler removes the mirror entry on it — so an escape
    // answered `null` would unmirror on the way to refusing.
    assert.deepEqual(Object.keys(await s.stat('/../../etc/passwd')), ['error']);
    assert.deepEqual(Object.keys(await s.list('/../..')), ['error']);
    assert.equal(await s.fetch('/../../etc/passwd', path.join(box, 'stolen')), 'refused');
    assert.deepEqual(Object.keys(await s.push(path.join(root, 'a/f'), '/../../escaped')), ['error']);
    assert.deepEqual(Object.keys(await s.remove('/../../escaped')), ['error']);
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
