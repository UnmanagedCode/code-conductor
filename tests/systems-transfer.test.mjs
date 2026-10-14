// THE TRANSFER ENGINE (src/systems/transfer.ts), against BOTH implementations of
// the System it is written over: the in-process LocalSystem and a ProviderSystem
// over the reference provider in each capability configuration. The engine sees
// only the System interface, so an invariant that holds on one and not the other
// is a member answering differently — which is what running the battery twice
// catches.
//
// Fault injection wraps a REAL handle in a delegating Proxy whose methods are
// bound to the target. Never `Object.create(sys)`: both classes keep `#private`
// state, and a method called on a prototype-chained wrapper throws TypeError.

import { test, describe, before, after, beforeEach } from 'node:test';
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { promises as fs } from 'node:fs';
import { execFileSync } from 'node:child_process';
import path from 'node:path';
import { mkdtemp } from './tmpRegistry.mjs';
import { CAPABILITY_CONFIGS, makeProviderSystem } from './referenceProviderHarness.mjs';
import { LocalSystem } from '../src/systems/localSystem.ts';
import { MAX_FILE_BYTES } from '../src/systems/protocol.ts';
import { transferFile } from '../src/systems/transfer.ts';

const sha = (buf) => createHash('sha256').update(buf).digest('hex');

// Every byte value, a run of NULs, and sequences no UTF-8 decoder round-trips.
const NASTY = Buffer.concat([
  Buffer.from(Array.from({ length: 256 }, (_, i) => i)),
  Buffer.alloc(64),
  Buffer.from([0xff, 0xfe, 0xc3, 0x28, 0xa0, 0xa1, 0xe2, 0x28, 0xa1, 0xf0, 0x28, 0x8c, 0xbc]),
]);

function wrap(sys, overrides) {
  return new Proxy(sys, {
    get: (t, k) => overrides[k] ?? (typeof t[k] === 'function' ? t[k].bind(t) : t[k]),
  });
}

async function exists(p) {
  try { await fs.lstat(p); return true; } catch { return false; }
}

const SYSTEMS = [
  { name: 'local', make: () => new LocalSystem() },
  ...CAPABILITY_CONFIGS.map(c => ({ name: c.name, make: () => makeProviderSystem(c.flags) })),
];

for (const { name, make } of SYSTEMS) {
  describe(`transferFile [${name}]`, () => {
    let sys, root;
    before(() => { sys = make(); });
    after(() => { sys.dispose?.(); });
    beforeEach(async () => { root = await fs.realpath(await mkdtemp('cc-transfer-')); });

    const ep = (p, s = sys) => ({ sys: s, path: p });
    const run = (from, to, opts = {}, s = sys, d = sys) =>
      transferFile(ep(from, s), ep(to, d), { move: false, overwrite: false, ...opts });

    test('bytes arrive verbatim: all 256 byte values, NULs and invalid UTF-8 are hash-identical', async () => {
      const src = path.join(root, 'src.bin');
      await fs.writeFile(src, NASTY);
      const r = await run(src, path.join(root, 'dst.bin'));
      assert.equal(r.ok, true, JSON.stringify(r));
      assert.equal(r.bytes, NASTY.length);
      assert.equal(r.moved, false);
      assert.equal(sha(await fs.readFile(path.join(root, 'dst.bin'))), sha(NASTY));
      assert.equal(sha(await fs.readFile(src)), sha(NASTY), 'a copy leaves the source');
    });

    test('an empty file transfers as zero bytes', async () => {
      const src = path.join(root, 'empty');
      await fs.writeFile(src, '');
      const r = await run(src, path.join(root, 'out'));
      assert.equal(r.ok, true, JSON.stringify(r));
      assert.equal(r.bytes, 0);
      const st = await fs.lstat(path.join(root, 'out'));
      assert.ok(st.isFile());
      assert.equal(st.size, 0);
    });

    test("the source's rwx bits carry over; setuid/setgid/sticky are dropped", async () => {
      for (const [mode, want, label] of [[0o755, 0o755, '0755'], [0o4755, 0o755, '0755'], [0o2640, 0o640, '0640'], [0o1600, 0o600, '0600']]) {
        const src = path.join(root, `m${mode.toString(8)}`);
        await fs.writeFile(src, 'x');
        await fs.chmod(src, mode);
        const dst = path.join(root, `out-${mode.toString(8)}`);
        const r = await run(src, dst);
        assert.equal(r.ok, true, JSON.stringify(r));
        assert.equal(r.mode, label, `mode string for 0${mode.toString(8)}`);
        assert.equal((await fs.stat(dst)).mode & 0o7777, want, `bits for 0${mode.toString(8)}`);
      }
    });

    test("the destination's parent directories are created", async () => {
      const src = path.join(root, 'f');
      await fs.writeFile(src, 'deep');
      const dst = path.join(root, 'a', 'b', 'c', 'f');
      const r = await run(src, dst);
      assert.equal(r.ok, true, JSON.stringify(r));
      assert.equal(await fs.readFile(dst, 'utf8'), 'deep');
    });

    test('an existing destination is refused DEST_EXISTS and left byte-identical', async () => {
      const src = path.join(root, 'f');
      await fs.writeFile(src, 'new');
      const dst = path.join(root, 'existing');
      await fs.writeFile(dst, 'old');
      const r = await run(src, dst);
      assert.equal(r.ok, false);
      assert.equal(r.code, 'DEST_EXISTS', JSON.stringify(r));
      assert.equal(await fs.readFile(dst, 'utf8'), 'old');

      // A DANGLING symlink is something at the destination too.
      const link = path.join(root, 'dangling');
      await fs.symlink(path.join(root, 'nowhere'), link);
      const r2 = await run(src, link);
      assert.equal(r2.code, 'DEST_EXISTS', JSON.stringify(r2));
      assert.equal(await fs.readlink(link), path.join(root, 'nowhere'));
      assert.equal(await exists(path.join(root, 'nowhere')), false, 'nothing was written through the link');
    });

    test('overwrite:true replaces an existing file', async () => {
      const src = path.join(root, 'f');
      await fs.writeFile(src, 'new');
      const dst = path.join(root, 'existing');
      await fs.writeFile(dst, 'old and longer');
      const r = await run(src, dst, { overwrite: true });
      assert.equal(r.ok, true, JSON.stringify(r));
      assert.equal(await fs.readFile(dst, 'utf8'), 'new');
    });

    test('overwrite never replaces a directory: DEST_NOT_A_FILE', async () => {
      const src = path.join(root, 'f');
      await fs.writeFile(src, 'x');
      const dst = path.join(root, 'adir');
      await fs.mkdir(dst);
      await fs.writeFile(path.join(dst, 'child'), 'kept');
      const r = await run(src, dst, { overwrite: true });
      assert.equal(r.ok, false);
      assert.equal(r.code, 'DEST_NOT_A_FILE', JSON.stringify(r));
      assert.ok((await fs.lstat(dst)).isDirectory());
      assert.equal(await fs.readFile(path.join(dst, 'child'), 'utf8'), 'kept');
    });

    test('a destination symlink is replaced, never written through', async () => {
      const src = path.join(root, 'f');
      await fs.writeFile(src, 'payload');
      const target = path.join(root, 'target');
      await fs.writeFile(target, 'untouched');
      const link = path.join(root, 'link');
      await fs.symlink(target, link);
      const r = await run(src, link, { overwrite: true });
      assert.equal(r.ok, true, JSON.stringify(r));
      assert.equal(await fs.readFile(target, 'utf8'), 'untouched', "the link's target is unchanged");
      assert.ok((await fs.lstat(link)).isFile(), 'the link itself was replaced by a regular file');
      assert.equal(await fs.readFile(link, 'utf8'), 'payload');
    });

    test('a symlinked source is followed for its bytes', async () => {
      const real = path.join(root, 'real');
      await fs.writeFile(real, NASTY);
      const link = path.join(root, 'link');
      await fs.symlink(real, link);
      const dst = path.join(root, 'out');
      const r = await run(link, dst);
      assert.equal(r.ok, true, JSON.stringify(r));
      assert.ok((await fs.lstat(dst)).isFile(), 'the destination is a file, not a copied link');
      assert.equal(sha(await fs.readFile(dst)), sha(NASTY));
    });

    test('a directory source is NOT_A_FILE and nothing is written', async () => {
      const src = path.join(root, 'adir');
      await fs.mkdir(src);
      const dst = path.join(root, 'out');
      const r = await run(src, dst);
      assert.equal(r.ok, false);
      assert.equal(r.code, 'NOT_A_FILE', JSON.stringify(r));
      assert.match(r.reason, /dir/);
      assert.equal(await exists(dst), false);
    });

    test('a fifo source is NOT_A_FILE and is never opened', async () => {
      const fifo = path.join(root, 'pipe');
      execFileSync('mkfifo', [fifo]);
      const dst = path.join(root, 'out');
      // No writer ever opens the fifo, so a read of it would block forever: the
      // guard turns that hang into a failure instead of a stuck suite.
      let timer;
      const guard = new Promise((_, rej) => { timer = setTimeout(() => rej(new Error('transfer opened the fifo and hung')), 10_000); });
      try {
        const r = await Promise.race([run(fifo, dst), guard]);
        assert.equal(r.ok, false);
        assert.equal(r.code, 'NOT_A_FILE', JSON.stringify(r));
      } finally { clearTimeout(timer); }
      assert.equal(await exists(dst), false);
    });

    test('a missing source is SOURCE_NOT_FOUND and nothing is written', async () => {
      const dst = path.join(root, 'out');
      const r = await run(path.join(root, 'absent'), dst);
      assert.equal(r.ok, false);
      assert.equal(r.code, 'SOURCE_NOT_FOUND', JSON.stringify(r));
      // A non-directory component on the way is absence too.
      await fs.writeFile(path.join(root, 'plain'), 'x');
      const r2 = await run(path.join(root, 'plain', 'below'), dst);
      assert.equal(r2.code, 'SOURCE_NOT_FOUND', JSON.stringify(r2));
      assert.equal(await exists(dst), false);
    });

    test('a source above MAX_FILE_BYTES is EFBIG and is never read', async () => {
      const big = path.join(root, 'big');
      const fh = await fs.open(big, 'w');
      try { await fh.truncate(MAX_FILE_BYTES + 1); } finally { await fh.close(); }
      let reads = 0;
      const spy = wrap(sys, { readFileBytes: (...a) => { reads++; return sys.readFileBytes(...a); } });
      const dst = path.join(root, 'out');
      const r = await run(big, dst, {}, spy, sys);
      assert.equal(r.ok, false);
      assert.equal(r.code, 'EFBIG', JSON.stringify(r));
      assert.equal(reads, 0, 'refused before any byte moved');
      assert.equal(await exists(dst), false);
    });

    test('the same entry is SAME_FILE, also through a symlinked parent, and a move keeps it', async () => {
      const realDir = path.join(root, 'real');
      await fs.mkdir(realDir);
      const f = path.join(realDir, 'f');
      await fs.writeFile(f, NASTY);
      await fs.symlink(realDir, path.join(root, 'alias'));

      const literal = await run(f, f);
      assert.equal(literal.code, 'SAME_FILE', JSON.stringify(literal));

      const aliased = await run(f, path.join(root, 'alias', 'f'), { move: true, overwrite: true });
      assert.equal(aliased.ok, false);
      assert.equal(aliased.code, 'SAME_FILE', JSON.stringify(aliased));
      assert.equal(sha(await fs.readFile(f)), sha(NASTY), 'the file survives a move onto itself');
    });

    test('a source whose stat or read fails with a code is READ_FAILED with that errno, and nothing is written', async () => {
      const src = path.join(root, 'f');
      await fs.writeFile(src, 'x');
      const dst = path.join(root, 'out');
      const eacces = () => { throw Object.assign(new Error('EACCES: permission denied'), { code: 'EACCES' }); };
      for (const [member, what] of [['stat', 'the stat'], ['readFileBytes', 'the read']]) {
        const r = await run(src, dst, { move: true }, wrap(sys, { [member]: async () => eacces() }), sys);
        assert.equal(r.ok, false, what);
        assert.equal(r.code, 'READ_FAILED', `${what}: ${JSON.stringify(r)}`);
        assert.equal(r.errno, 'EACCES', what);
        assert.equal(r.written, undefined, what);
        assert.equal(await exists(dst), false, `${what}: nothing is written`);
        assert.equal(await fs.readFile(src, 'utf8'), 'x', `${what}: the source is kept`);
      }
    });

    test('overwrite never replaces a special file: a fifo destination is DEST_NOT_A_FILE and survives', async () => {
      const src = path.join(root, 'f');
      await fs.writeFile(src, 'x');
      const fifo = path.join(root, 'pipe');
      execFileSync('mkfifo', [fifo]);
      const r = await run(src, fifo, { overwrite: true });
      assert.equal(r.ok, false);
      assert.equal(r.code, 'DEST_NOT_A_FILE', JSON.stringify(r));
      assert.ok((await fs.lstat(fifo)).isFIFO(), 'the fifo is still a fifo');
    });

    test('a move removes the source only after the write', async () => {
      const src = path.join(root, 'f');
      await fs.writeFile(src, NASTY);
      const dst = path.join(root, 'moved', 'f');
      // The source is still present at the moment the destination is written.
      let srcAtWrite = null;
      const spy = wrap(sys, {
        writeFileBytes: async (...a) => { srcAtWrite = await exists(src); return sys.writeFileBytes(...a); },
      });
      const r = await run(src, dst, { move: true }, sys, spy);
      assert.equal(r.ok, true, JSON.stringify(r));
      assert.equal(r.moved, true);
      assert.equal(srcAtWrite, true);
      assert.equal(await exists(src), false, 'the source is gone');
      assert.equal(sha(await fs.readFile(dst)), sha(NASTY));
    });

    test('a failed write keeps the source: WRITE_FAILED', async () => {
      const src = path.join(root, 'f');
      await fs.writeFile(src, 'keep me');
      await fs.writeFile(path.join(root, 'plain'), 'x');
      const r = await run(src, path.join(root, 'plain', 'sub', 'out'), { move: true });
      assert.equal(r.ok, false);
      assert.equal(r.code, 'WRITE_FAILED', JSON.stringify(r));
      assert.equal(typeof r.errno, 'string');
      assert.equal(r.written, undefined);
      assert.equal(await fs.readFile(src, 'utf8'), 'keep me');
    });

    test('a move whose destination does not verify keeps the source: DEST_UNVERIFIED', async () => {
      const src = path.join(root, 'f');
      await fs.writeFile(src, 'keep me');
      const dst = path.join(root, 'out');
      const liar = wrap(sys, { writeFileBytes: async () => {} });
      const r = await run(src, dst, { move: true }, sys, liar);
      assert.equal(r.ok, false);
      assert.equal(r.code, 'DEST_UNVERIFIED', JSON.stringify(r));
      assert.equal(r.written, true);
      assert.equal(await fs.readFile(src, 'utf8'), 'keep me');
    });

    test('a move whose destination holds a different size keeps the source: DEST_UNVERIFIED', async () => {
      const src = path.join(root, 'f');
      await fs.writeFile(src, 'keep me');
      const dst = path.join(root, 'out');
      // The destination exists as a regular file — only its size is wrong.
      const shortWriter = wrap(sys, {
        writeFileBytes: (p, data, opts) => sys.writeFileBytes(p, data.subarray(0, data.length - 1), opts),
      });
      const r = await run(src, dst, { move: true }, sys, shortWriter);
      assert.equal(r.ok, false);
      assert.equal(r.code, 'DEST_UNVERIFIED', JSON.stringify(r));
      assert.equal(r.written, true);
      assert.ok((await fs.lstat(dst)).isFile(), 'premise: the destination is a regular file');
      assert.equal(await fs.readFile(src, 'utf8'), 'keep me');
    });

    test('a source rewritten in place at the same length during a move is kept: SOURCE_CHANGED by mtime', async () => {
      const src = path.join(root, 'f');
      await fs.writeFile(src, 'original');
      // Explicit, distinct mtimes: the change does not depend on clock resolution.
      const before = new Date('2001-01-01T00:00:00Z');
      const after = new Date('2002-02-02T00:00:00Z');
      await fs.utimes(src, before, before);
      const dst = path.join(root, 'out');
      const racer = wrap(sys, {
        writeFileBytes: async (...a) => {
          await fs.writeFile(src, 'REWRITES');
          await fs.utimes(src, after, after);
          return sys.writeFileBytes(...a);
        },
      });
      const r = await run(src, dst, { move: true }, sys, racer);
      assert.equal(r.ok, false);
      assert.equal(r.code, 'SOURCE_CHANGED', JSON.stringify(r));
      assert.equal(r.written, true);
      assert.equal(await fs.readFile(src, 'utf8'), 'REWRITES', 'the rewritten source survives');
      assert.equal(await fs.readFile(dst, 'utf8'), 'original');
    });

    test('a source changed during a move is kept: SOURCE_CHANGED, written:true', async () => {
      const src = path.join(root, 'f');
      await fs.writeFile(src, 'original');
      const dst = path.join(root, 'out');
      const racer = wrap(sys, {
        writeFileBytes: async (...a) => { await fs.appendFile(src, ' + appended'); return sys.writeFileBytes(...a); },
      });
      const r = await run(src, dst, { move: true }, sys, racer);
      assert.equal(r.ok, false);
      assert.equal(r.code, 'SOURCE_CHANGED', JSON.stringify(r));
      assert.equal(r.written, true);
      assert.equal(await fs.readFile(src, 'utf8'), 'original + appended', 'the new bytes survive');
      assert.equal(await fs.readFile(dst, 'utf8'), 'original');
    });

    test('a source that grows during a move with its mtime restored is kept: SOURCE_CHANGED by size', async () => {
      const src = path.join(root, 'f');
      await fs.writeFile(src, 'original');
      // Explicit mtime, restored after the append: only the size moves.
      const stamp = new Date('2001-01-01T00:00:00Z');
      await fs.utimes(src, stamp, stamp);
      const dst = path.join(root, 'out');
      const racer = wrap(sys, {
        writeFileBytes: async (...a) => {
          await fs.appendFile(src, ' + appended');
          await fs.utimes(src, stamp, stamp);
          return sys.writeFileBytes(...a);
        },
      });
      const r = await run(src, dst, { move: true }, sys, racer);
      assert.equal(r.ok, false);
      assert.equal(r.code, 'SOURCE_CHANGED', JSON.stringify(r));
      assert.equal(r.written, true);
      assert.equal((await fs.stat(src)).mtimeMs, stamp.getTime(), 'premise: the mtime is the original');
      assert.equal(await fs.readFile(src, 'utf8'), 'original + appended', 'the appended bytes survive');
      assert.equal(await fs.readFile(dst, 'utf8'), 'original');
    });

    test('a short read writes nothing: SOURCE_CHANGED', async () => {
      const src = path.join(root, 'f');
      await fs.writeFile(src, 'twelve bytes');
      const dst = path.join(root, 'out');
      const short = wrap(sys, {
        readFileBytes: async (p, o) => (await sys.readFileBytes(p, o)).subarray(0, 11),
      });
      const r = await run(src, dst, {}, short, sys);
      assert.equal(r.ok, false);
      assert.equal(r.code, 'SOURCE_CHANGED', JSON.stringify(r));
      assert.equal(r.written, undefined);
      assert.equal(await exists(dst), false);
    });

    test('a source that cannot be removed is SOURCE_NOT_REMOVED, written:true', async () => {
      const src = path.join(root, 'f');
      await fs.writeFile(src, 'stuck');
      const dst = path.join(root, 'out');
      const locked = wrap(sys, {
        unlink: async () => { throw Object.assign(new Error('EACCES: permission denied'), { code: 'EACCES' }); },
      });
      const r = await run(src, dst, { move: true }, locked, sys);
      assert.equal(r.ok, false);
      assert.equal(r.code, 'SOURCE_NOT_REMOVED', JSON.stringify(r));
      assert.equal(r.errno, 'EACCES');
      assert.equal(r.written, true);
      assert.equal(await fs.readFile(src, 'utf8'), 'stuck');
      assert.equal(await fs.readFile(dst, 'utf8'), 'stuck');
    });

    test('moving a symlinked source removes the link, never its target', async () => {
      const real = path.join(root, 'real');
      await fs.writeFile(real, 'target bytes');
      const link = path.join(root, 'link');
      await fs.symlink(real, link);
      const dst = path.join(root, 'out');
      const r = await run(link, dst, { move: true });
      assert.equal(r.ok, true, JSON.stringify(r));
      assert.equal(await exists(link), false, 'the link is gone');
      assert.equal(await fs.readFile(real, 'utf8'), 'target bytes', 'its target is not');
      assert.equal(await fs.readFile(dst, 'utf8'), 'target bytes');
    });

    test('an error without a code is rethrown, not converted', async () => {
      const src = path.join(root, 'f');
      await fs.writeFile(src, 'x');
      const broken = wrap(sys, { stat: async () => { throw new Error('a cc defect'); } });
      await assert.rejects(run(src, path.join(root, 'out'), {}, broken, sys), /a cc defect/);
    });
  });
}

describe('transferFile across two handles', () => {
  let local, remote, root;
  before(() => { local = new LocalSystem(); remote = makeProviderSystem(CAPABILITY_CONFIGS[0].flags); });
  after(() => { remote.dispose(); });
  beforeEach(async () => { root = await fs.realpath(await mkdtemp('cc-transfer-x-')); });

  test('cross-handle: local → provider and provider → local are hash-identical', async () => {
    const src = path.join(root, 'src');
    await fs.writeFile(src, NASTY);
    const there = await transferFile({ sys: local, path: src }, { sys: remote, path: path.join(root, 'there') }, { move: false, overwrite: false });
    assert.equal(there.ok, true, JSON.stringify(there));
    const back = await transferFile({ sys: remote, path: path.join(root, 'there') }, { sys: local, path: path.join(root, 'back') }, { move: true, overwrite: false });
    assert.equal(back.ok, true, JSON.stringify(back));
    assert.equal(sha(await fs.readFile(path.join(root, 'back'))), sha(NASTY));
    assert.equal(await exists(path.join(root, 'there')), false, 'the move removed the provider-side source');
  });

  // Two TARGETS of one system: the same id, different remoteIds, distinct
  // storage at the same absolute path — two containers behind one provider.
  // Each handle maps its paths under its own prefix and unmaps realpath's
  // answer, so the two answer identically about `/p/f` while the bytes live
  // apart; only the remoteId tells the endpoints apart.
  function targetOf(remoteId, prefix) {
    const map = (p) => prefix + p;
    return {
      id: 'boxes', remoteId,
      stat: (p) => local.stat(map(p)),
      lstat: (p) => local.lstat(map(p)),
      realpath: async (p) => (await local.realpath(map(p))).slice(prefix.length) || '/',
      readFileBytes: (p, o) => local.readFileBytes(map(p), o),
      writeFileBytes: (p, d, o) => local.writeFileBytes(map(p), d, o),
      unlink: (p) => local.unlink(map(p)),
    };
  }

  test('the same path on two targets of one system is two endpoints, not SAME_FILE', async () => {
    const prefixA = path.join(root, 'a');
    const prefixB = path.join(root, 'b');
    const a = targetOf('a', prefixA);
    const b = targetOf('b', prefixB);
    await fs.mkdir(path.join(prefixA, 'p'), { recursive: true });
    await fs.mkdir(path.join(prefixB, 'p'), { recursive: true });
    await fs.writeFile(path.join(prefixA, 'p', 'f'), NASTY);
    await fs.writeFile(path.join(prefixB, 'p', 'f'), 'b holds something else');
    assert.equal(await a.realpath('/p'), await b.realpath('/p'), 'premise: the realpath answers coincide');

    // The destination exists, so the SAME_FILE check runs; overwrite carries past DEST_EXISTS.
    const copied = await transferFile({ sys: a, path: '/p/f' }, { sys: b, path: '/p/f' }, { move: false, overwrite: true });
    assert.equal(copied.ok, true, JSON.stringify(copied));
    assert.equal(sha(await fs.readFile(path.join(prefixB, 'p', 'f'))), sha(NASTY));

    await fs.writeFile(path.join(prefixB, 'p', 'f'), 'b again');
    const moved = await transferFile({ sys: a, path: '/p/f' }, { sys: b, path: '/p/f' }, { move: true, overwrite: true });
    assert.equal(moved.ok, true, JSON.stringify(moved));
    assert.equal(moved.moved, true);
    assert.equal(sha(await fs.readFile(path.join(prefixB, 'p', 'f'))), sha(NASTY));
    assert.equal(await exists(path.join(prefixA, 'p', 'f')), false, 'the source on target a is gone');
  });

  // Local only: the boundary is inclusive, and 32 MiB of base64 per gate row
  // buys nothing the provider tests above do not already prove.
  test('a file exactly at MAX_FILE_BYTES transfers', async () => {
    const src = path.join(root, 'cap');
    const fh = await fs.open(src, 'w');
    try { await fh.truncate(MAX_FILE_BYTES); } finally { await fh.close(); }
    const r = await transferFile({ sys: local, path: src }, { sys: local, path: path.join(root, 'cap-out') }, { move: false, overwrite: false });
    assert.equal(r.ok, true, JSON.stringify(r));
    assert.equal(r.bytes, MAX_FILE_BYTES);
    assert.equal((await fs.stat(path.join(root, 'cap-out'))).size, MAX_FILE_BYTES);
  });
});
