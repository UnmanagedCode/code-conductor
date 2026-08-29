// THE CONFORMANCE SUITE: this file is the definition of a valid provider.
//
// docs/systems-protocol.md is what a provider author reads; this is what their
// provider has to survive. It drives the reference provider through the three
// MUST primitives, the full `exec` frame lifecycle including process-group
// signalling, capability negotiation, multiplexed ids, every error code and
// every derivation — in ALL THREE capability configurations, so neither
// fallback is a flag nobody has run.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { promises as fs } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import {
  CHUNK_BYTES, FS_ERROR_CODES, MAX_FILE_BYTES, PROTOCOL_ERROR_CODES, PROTOCOL_VERSION,
} from '../src/systems/protocol.ts';
import { ProviderConnection } from '../src/systems/providerConnection.ts';
import { parseFindLines } from '../src/systems/providerSystem.ts';
import {
  CAPABILITY_CONFIGS, IS_REFERENCE_PROVIDER, makeProviderSystem, providerArgv,
} from './referenceProviderHarness.mjs';
import { rmrf } from './rmrf.mjs';

// Every taxonomy code this file provokes for real. The last test checks the
// union against the exported lists, so a new code cannot be added to the
// protocol without something producing it.
const produced = new Set();
function expectCode(e, code, what) {
  assert.equal(e.code, code, `${what}: expected ${code}, got ${e.code} (${e.message})`);
  produced.add(code);
  return true;
}

async function withSystem(flags, fn) {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'cc-conformance-'));
  const root = await fs.realpath(dir);
  const sys = makeProviderSystem(flags);
  try {
    await sys.connect();
    return await fn(sys, root);
  } finally {
    sys.dispose();
    await rmrf(dir);
  }
}

const alive = (pid) => { try { process.kill(pid, 0); return true; } catch { return false; } };

async function settle(pred, ms = 3_000) {
  const until = Date.now() + ms;
  while (Date.now() < until) {
    if (pred()) return true;
    await new Promise(r => setTimeout(r, 25));
  }
  return pred();
}

for (const config of CAPABILITY_CONFIGS) {
  const tag = `[${config.name}]`;

  // ── Handshake and capability negotiation ─────────────────────────

  test(`${tag} the handshake carries the protocol version, the provider name, the capabilities and the system`, async () => {
    await withSystem(config.flags, async (sys) => {
      const hs = sys.handshake;
      assert.deepEqual(hs.capabilities, config.caps, 'the flags the provider was launched with are what it advertises');
      assert.match(hs.provider, /^\S+\/\S+$/, 'a provider names and versions itself');
      if (IS_REFERENCE_PROVIDER) assert.match(hs.provider, /^reference-local\//);
      assert.equal(hs.system.pathSep, path.sep);
      assert.ok(hs.system.shell.startsWith('/'), 'the far side names the shell cc opens for a redirected Bash');
      assert.ok(hs.system.home.length > 0);
      assert.equal(PROTOCOL_VERSION, 1);
    });
  });

  // ── exec: the primitive ──────────────────────────────────────────

  test(`${tag} exec runs argv and shell forms, and reports stdout, stderr and the exit code`, async () => {
    await withSystem(config.flags, async (sys, root) => {
      const a = await sys.exec({ argv: ['echo', 'hello'] }, { cwd: root });
      assert.deepEqual(
        { code: a.code, stdout: a.stdout, stderr: a.stderr, timedOut: a.timedOut, spawnError: a.spawnError },
        { code: 0, stdout: 'hello\n', stderr: '', timedOut: false, spawnError: null },
      );
      const b = await sys.exec({ shell: 'echo out; echo err >&2; exit 5' }, { cwd: root });
      assert.equal(b.code, 5);
      assert.equal(b.stdout, 'out\n');
      assert.equal(b.stderr, 'err\n');
      assert.equal(b.output.includes('out'), true, 'output carries both streams in arrival order');
      assert.equal(b.output.includes('err'), true);
      const c = await sys.exec({ argv: ['pwd'] }, { cwd: root });
      assert.equal(c.stdout.trim(), root, 'cwd on the frame is where the command runs');
      const d = await sys.exec({ argv: ['sh', '-c', 'echo "$CC_PROBE"'] }, { cwd: root, env: { CC_PROBE: 'from-frame', PATH: process.env.PATH } });
      assert.equal(d.stdout.trim(), 'from-frame', 'env on the frame REPLACES the environment, as spawn does');
    });
  });

  test(`${tag} exec NEVER rejects — a command that cannot start is a spawnError, not a throw`, async () => {
    await withSystem(config.flags, async (sys, root) => {
      const r = await sys.exec({ argv: ['definitely-not-a-real-binary-xyz'] }, { cwd: root });
      assert.equal(r.code, 1);
      assert.ok(r.spawnError, 'the caller distinguishes "failed to launch" from "ran and exited 1"');
      assert.equal(r.stderr, r.spawnError, 'the message fills the fields callers read diagnostics from');
      assert.equal(r.output, r.spawnError);
      assert.equal(r.timedOut, false);
    });
  });

  test(`${tag} a timeout is exit 124 with timedOut set`, async () => {
    await withSystem(config.flags, async (sys, root) => {
      const r = await sys.exec({ argv: ['sleep', '10'] }, { cwd: root, timeoutMs: 250 });
      assert.equal(r.timedOut, true);
      assert.equal(r.code, 124, "124 is timeout(1)'s convention, which cc's callers already branch on");
      assert.ok(r.durationMs < 9_000, 'the command really was killed, not waited out');
    });
  });

  test(`${tag} process-group signalling: the capability decides whether grandchildren are reachable`, async () => {
    await withSystem(config.flags, async (sys, root) => {
      const pidFile = path.join(root, 'grandchild.pid');
      // bash is the direct child; `sleep` is the grandchild that outlives it
      // unless the whole GROUP is signalled — the orphaned-`npm ci` failure.
      // The grandchild's own stdout goes to /dev/null so it does not hold the
      // command's pipes open after the direct child dies; what is under test is
      // the SIGNAL's reach, not how long an orphan keeps a pipe.
      const r = await sys.exec(
        { shell: `sleep 30 >/dev/null 2>&1 & echo $! > ${pidFile}; wait` },
        { cwd: root, timeoutMs: 300 },
      );
      assert.equal(r.timedOut, true);
      assert.ok(r.durationMs < 3_000,
        'the exit frame came from the provider, not from cc\'s wedge backstop');
      const pid = Number((await fs.readFile(pidFile, 'utf8')).trim());
      assert.ok(pid > 0, 'the grandchild recorded its pid');
      try {
        if (config.caps.processGroupSignal) {
          assert.equal(r.descendantsMaySurvive, undefined,
            'with group reach the result claims nothing was left behind');
          assert.equal(await settle(() => !alive(pid)), true,
            'and the grandchild really is gone — one kill reached the whole group');
        } else {
          // Asserted on the FLAG, not on a race against real process death.
          assert.equal(r.descendantsMaySurvive, true,
            'without group reach the result SAYS grandchildren may survive');
        }
      } finally {
        try { process.kill(pid, 'SIGKILL'); } catch { /* already gone */ }
      }
    });
  });

  test(`${tag} concurrent execs are multiplexed by id and never mix their output`, async () => {
    await withSystem(config.flags, async (sys, root) => {
      const started = Date.now();
      const tags = ['alpha', 'beta', 'gamma', 'delta', 'epsilon'];
      const rs = await Promise.all(tags.map(t =>
        sys.exec({ shell: `sleep 0.25; echo ${t}; echo ${t}-err >&2` }, { cwd: root })));
      rs.forEach((r, i) => {
        assert.equal(r.stdout, `${tags[i]}\n`, 'each id got exactly its own stdout');
        assert.equal(r.stderr, `${tags[i]}-err\n`);
        assert.equal(r.code, 0);
      });
      assert.ok(Date.now() - started < 1_000,
        'five 250ms commands finished together — the ids really are open concurrently');
    });
  });

  test(`${tag} the exec output caps behave identically to the local runner`, async () => {
    await withSystem(config.flags, async (sys, root) => {
      const spew = { shell: 'for i in $(seq 1 500); do echo 0123456789012345678901234567890123456789; done' };
      const tail = await sys.exec(spew, { cwd: root, cap: 200 });
      assert.equal(tail.truncated, true);
      assert.equal(tail.stdout.length, 200, 'a tail cap keeps the LAST bytes');
      assert.ok(tail.stdout.endsWith('0123456789\n'));
      const head = await sys.exec(spew, { cwd: root, headCapBytes: 200 });
      assert.equal(head.truncated, true);
      assert.ok(head.stdout.length >= 200, 'a head cap keeps the FIRST bytes and keeps draining');
      assert.equal(head.code, 0, 'the command still ran to completion under a head cap');
      const fenced = await sys.exec(spew, { cwd: root, maxBufferBytes: 500 });
      assert.equal(fenced.code, 1, 'the max-buffer fence is a FAILURE, not a truncated success');
      assert.match(fenced.stderr, /exceeded the 500-byte limit/);
      assert.ok(fenced.stdout.length > 0, 'the output that arrived first is kept');
      assert.ok(fenced.stdout.length < 5_000, 'and retention stops at the fence');
    });
  });

  test(`${tag} stdin:'ignore' hands the command a closed stdin instead of a wait`, async () => {
    await withSystem(config.flags, async (sys, root) => {
      const r = await sys.exec({ argv: ['cat'] }, { cwd: root, stdin: 'ignore', timeoutMs: 2_000 });
      assert.equal(r.timedOut, false, 'an interactive command sees EOF rather than hanging to the timeout');
      assert.equal(r.code, 0);
    });
  });

  // ── readFile / writeFile: the other two primitives ────────────────

  test(`${tag} readFile and writeFile round-trip, including a payload past one chunk`, async () => {
    await withSystem(config.flags, async (sys, root) => {
      const p = path.join(root, 'note.txt');
      await sys.writeFile(p, 'hello — héllo\n');
      assert.equal(await fs.readFile(p, 'utf8'), 'hello — héllo\n');
      assert.equal(await sys.readFile(p), 'hello — héllo\n');

      const big = path.join(root, 'big.bin');
      const payload = 'x'.repeat(CHUNK_BYTES * 3 + 17);
      await sys.writeFile(big, payload);
      assert.equal((await sys.readFile(big)).length, payload.length, 'chunking is transparent in both directions');
      const head = await sys.readFileBytes(big, { length: 10 });
      assert.equal(head.toString('utf8'), 'x'.repeat(10), 'the ranged read is bounded');
      assert.equal((await sys.readFileBytes(big)).length, payload.length, 'and unbounded without a length');
    });
  });

  test(`${tag} writeFile honours atomic and exclusive, and refuses the pair`, async () => {
    await withSystem(config.flags, async (sys, root) => {
      const p = path.join(root, 'x.txt');
      await sys.writeFile(p, 'first', { exclusive: true });
      await assert.rejects(() => sys.writeFile(p, 'second', { exclusive: true }),
        (e) => expectCode(e, 'EEXIST', 'exclusive write over an existing file'));
      assert.equal(await fs.readFile(p, 'utf8'), 'first', 'the refusal left the file alone');
      await sys.writeFile(p, 'third', { atomic: true });
      assert.equal(await fs.readFile(p, 'utf8'), 'third', 'an atomic write overwrites — it ends in a rename');
      await assert.rejects(() => sys.writeFile(p, 'x', { atomic: true, exclusive: true }),
        /mutually exclusive/, 'the combination has no honest meaning, on either implementation');
    });
  });

  test(`${tag} readFile reports absence, a directory, and an unreadable file`, async () => {
    await withSystem(config.flags, async (sys, root) => {
      await assert.rejects(() => sys.readFile(path.join(root, 'nope')),
        (e) => expectCode(e, 'ENOENT', 'readFile of a missing path'));
      await assert.rejects(() => sys.readFile(root),
        (e) => expectCode(e, 'EISDIR', 'readFile of a directory'));
      if (process.getuid?.() !== 0) {
        const locked = path.join(root, 'locked');
        await fs.writeFile(locked, 'secret');
        await fs.chmod(locked, 0o000);
        try {
          await assert.rejects(() => sys.readFile(locked),
            (e) => expectCode(e, 'EACCES', 'readFile of an unreadable file'));
        } finally { await fs.chmod(locked, 0o600); }
      }
    });
  });

  test(`${tag} a read above the protocol's per-file cap is refused, not streamed`, async () => {
    await withSystem(config.flags, async (sys, root) => {
      const p = path.join(root, 'small');
      await fs.writeFile(p, 'small');
      await assert.rejects(() => sys.readFileBytes(p, { length: MAX_FILE_BYTES + 1 }),
        (e) => expectCode(e, 'EFBIG', 'a read past the per-file cap'));
    });
  });

  // ── The derivations (everything that is not a primitive) ─────────

  test(`${tag} stat is derived from exec and matches what fs.stat reports`, async () => {
    await withSystem(config.flags, async (sys, root) => {
      const f = path.join(root, 'f');
      await fs.writeFile(f, 'abcdef');
      const real = await fs.stat(f);
      const got = await sys.stat(f);
      assert.equal(got.kind, 'file');
      assert.equal(got.size, 6);
      assert.equal(got.mode, real.mode, 'the RAW mode, type bits and all — the same number fs.Stats carries');
      assert.ok(Math.abs(got.mtimeMs - real.mtimeMs) < 1.5, 'mtime keeps millisecond precision');
      assert.equal((await sys.stat(root)).kind, 'dir');
      assert.equal(await sys.stat(path.join(root, 'nope')), null,
        'ABSENCE IS A VALUE: a missing path is null, matching resolveProjectDir');
      await fs.symlink(f, path.join(root, 'link'));
      assert.equal((await sys.stat(path.join(root, 'link'))).kind, 'file', 'stat follows symlinks, like fs.stat');
      await fs.symlink(path.join(root, 'gone'), path.join(root, 'broken'));
      assert.equal(await sys.stat(path.join(root, 'broken')), null, 'a broken link is absent, not an error');
    });
  });

  test(`${tag} readDir is derived from exec, reports kinds, and refuses a file`, async () => {
    await withSystem(config.flags, async (sys, root) => {
      const dir = path.join(root, 'd');
      await fs.mkdir(path.join(dir, 'sub'), { recursive: true });
      await fs.writeFile(path.join(dir, 'a file with spaces'), 'x');
      await fs.symlink(path.join(dir, 'sub'), path.join(dir, 'lnk'));
      const entries = (await sys.readDir(dir)).sort((x, y) => x.name.localeCompare(y.name));
      assert.deepEqual(entries, [
        { name: 'a file with spaces', kind: 'file' },
        { name: 'lnk', kind: 'symlink' },
        { name: 'sub', kind: 'dir' },
      ], 'a symlink is reported as one, matching fs.readdir(withFileTypes)');
      await assert.rejects(() => sys.readDir(path.join(dir, 'a file with spaces')),
        (e) => expectCode(e, 'ENOTDIR', 'readDir of a file'),
        'a file must not read as an empty directory');
      await assert.rejects(() => sys.readDir(path.join(root, 'nope')),
        (e) => expectCode(e, 'ENOENT', 'readDir of a missing path'));
    });
  });

  test(`${tag} a filename containing a newline is an ERROR, never a silently dropped entry`, async () => {
    await withSystem(config.flags, async (sys, root) => {
      const dir = path.join(root, 'weird');
      await fs.mkdir(dir);
      await fs.writeFile(path.join(dir, 'plain'), 'x');
      await fs.writeFile(path.join(dir, 'two\nlines'), 'x');
      await assert.rejects(() => sys.readDir(dir),
        (e) => expectCode(e, 'EUNKNOWN', 'a listing cc cannot parse'),
        'a listing that quietly drops an entry is indistinguishable from one that does not have it');
    });
  });

  test(`${tag} realpath, mkdir, removeTree, unlink and chmod are derived and behave like fs`, async () => {
    await withSystem(config.flags, async (sys, root) => {
      const target = path.join(root, 'real');
      await fs.mkdir(target);
      await fs.symlink(target, path.join(root, 'alias'));
      assert.equal(await sys.realpath(path.join(root, 'alias')), target);
      await assert.rejects(() => sys.realpath(path.join(root, 'nope')),
        (e) => expectCode(e, 'ENOENT', 'realpath of a missing path'),
        'realpath -e requires every component to exist, exactly as fs.realpath does');

      await sys.mkdir(path.join(root, 'one'));
      assert.equal((await sys.stat(path.join(root, 'one'))).kind, 'dir');
      await assert.rejects(() => sys.mkdir(path.join(root, 'one')),
        (e) => expectCode(e, 'EEXIST', 'a non-recursive mkdir over an existing dir'));
      await sys.mkdir(path.join(root, 'a/b/c'), { recursive: true });
      assert.equal((await sys.stat(path.join(root, 'a/b/c'))).kind, 'dir');
      await assert.rejects(() => sys.mkdir(path.join(root, 'x/y/z')),
        (e) => expectCode(e, 'ENOENT', 'a non-recursive mkdir with no parent'));

      const file = path.join(root, 'chmodme');
      await fs.writeFile(file, 'x');
      await fs.chmod(file, 0o644);
      // The mode a caller has in hand comes from stat and carries the file-type
      // bits; chmod must mask them rather than reject.
      const st = await sys.stat(file);
      await sys.chmod(file, st.mode | 0o111);
      assert.equal((await fs.stat(file)).mode & 0o777, 0o755);

      await sys.unlink(file);
      assert.equal(await sys.stat(file), null);
      await assert.rejects(() => sys.unlink(file), (e) => expectCode(e, 'ENOENT', 'unlink of a missing entry'));
      // unlink removes ONE entry and never follows it — the shape the
      // `.external/<name>` record is deleted with.
      await sys.unlink(path.join(root, 'alias'));
      assert.equal((await sys.stat(target)).kind, 'dir', 'the symlink went, the target stayed');

      await sys.removeTree(path.join(root, 'a'));
      assert.equal(await sys.stat(path.join(root, 'a')), null);
      await sys.removeTree(path.join(root, 'never-existed'));
    });
  });
}

// ── Cases that do not vary by capability ─────────────────────────────

test('a provider that does not advertise persistentShell refuses to be written to', async () => {
  // The capability IS "cc may keep writing into a live child". Both halves are
  // asserted: cc refuses to ask, and a provider refuses to be asked.
  const sys = makeProviderSystem(['--no-persistent-shell']);
  try {
    await sys.connect();
    await assert.rejects(
      () => sys.openStream({ argv: ['cat'] }, { cwd: os.tmpdir() }, {
        onStdout() {}, onStderr() {}, onExit() {}, onDown() {},
      }),
      (e) => expectCode(e, 'EUNSUPPORTED', 'openStream without the capability'),
    );
  } finally { sys.dispose(); }

  const conn = new ProviderConnection({ launch: { argv: providerArgv(['--no-persistent-shell']) } });
  try {
    await conn.ensureUp();
    const id = conn.nextId('e');
    const refusal = await new Promise((resolve) => {
      conn.open(id, { frame: (f) => { if (f.type === 'error') resolve(f); }, down: resolve });
      conn.send({ type: 'exec', id, cwd: os.tmpdir(), argv: ['cat'] });
      conn.send({ type: 'stdin', id, dataB64: Buffer.from('hi').toString('base64') });
    });
    expectCode(refusal, 'EUNSUPPORTED', 'a stdin frame sent to a provider without the capability');
  } finally { conn.dispose(); }
});

test('a provider refuses a corrupted write payload — it never lands a partial file', async () => {
  // The other direction of the same rule. `Buffer.from(s,'base64')` would keep
  // the readable prefix, so a doc-conforming provider that decoded leniently
  // would answer `writeFileResult ok` having written a TRUNCATED file: a
  // success report for a wrong answer, which is the one outcome the taxonomy
  // exists to prevent.
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'cc-badb64-'));
  const target = path.join(await fs.realpath(dir), 'must-not-exist');
  const conn = new ProviderConnection({ launch: { argv: providerArgv() } });
  try {
    await conn.ensureUp();
    const id = conn.nextId('w');
    const refusal = await new Promise((resolve) => {
      conn.open(id, { frame: (f) => { if (f.type === 'error' || f.type === 'writeFileResult') resolve(f); }, down: resolve });
      conn.send({ type: 'writeFile', id, path: target });
      conn.send({ type: 'data', id, seq: 0, dataB64: Buffer.from('HELLO').toString('base64') });
      // Valid JSON, valid line, unusable payload.
      conn.send({ type: 'data', id, seq: 1, dataB64: 'V09STEQ=!!corrupted' });
      conn.send({ type: 'end', id });
    });
    assert.notEqual(refusal.type, 'writeFileResult', 'a corrupted payload must not report success');
    expectCode(refusal, 'EPROTO', 'a writeFile payload that is not valid base64');
    assert.equal(await fs.stat(target).then(() => 'exists', () => 'absent'), 'absent',
      'and no partial file was left behind');
  } finally {
    conn.dispose();
    await rmrf(dir);
  }
});

test('parseFindLines refuses a malformed entry rather than skipping it', () => {
  assert.deepEqual(parseFindLines('f\ta\nd\tb\n', '/d'), [
    { name: 'a', kind: 'file' }, { name: 'b', kind: 'dir' },
  ]);
  assert.deepEqual(parseFindLines('p\tfifo\n', '/d'), [{ name: 'fifo', kind: 'other' }],
    'an entry that is neither file, dir nor symlink is "other", not a parse failure');
  assert.throws(() => parseFindLines('f\tone\nstray line\n', '/d'), (e) => e.code === 'EUNKNOWN');
});

test('a write above the protocol cap is refused before a byte reaches the wire', async () => {
  // Outside the per-configuration loop: this allocates the cap, and the refusal
  // is cc-side, identical whatever the provider advertises.
  const sys = makeProviderSystem([]);
  try {
    await sys.connect();
    await assert.rejects(() => sys.writeFile(path.join(os.tmpdir(), 'cc-never-written'), 'a'.repeat(MAX_FILE_BYTES + 1)),
      (e) => expectCode(e, 'EFBIG', 'a write past the per-file cap'));
    assert.equal(await sys.stat(path.join(os.tmpdir(), 'cc-never-written')), null, 'nothing was written');
  } finally { sys.dispose(); }
});

// ── Completeness ─────────────────────────────────────────────────────

test('every code in the taxonomy is produced by a real failure somewhere in this suite', () => {
  // The codes this file provokes live, plus the ones whose failure modes belong
  // to another file. Naming the file is the point: a code added to the protocol
  // with nowhere to produce it fails here.
  const elsewhere = {
    EPROTO: 'tests/systems-protocol-codec.test.mjs + tests/systems-provider-supervision.test.mjs',
    ETRANSPORT: 'tests/systems-provider-supervision.test.mjs',
    ETIMEDOUT: 'tests/systems-provider-supervision.test.mjs + tests/systems-shell-framing.test.mjs',
    EBUSY: 'tests/systems-shell-framing.test.mjs',
    ESHELLGONE: 'tests/systems-shell-framing.test.mjs',
    // The one code no test can provoke without filling a disk; its classifier
    // row is asserted in tests/systems-protocol-codec.test.mjs.
    ENOSPC: 'tests/systems-protocol-codec.test.mjs (classifier only)',
  };
  const covered = new Set([...produced, ...Object.keys(elsewhere)]);
  const all = [...PROTOCOL_ERROR_CODES, ...FS_ERROR_CODES];
  assert.deepEqual(all.filter(c => !covered.has(c)), [], 'every named code must have a producer');
  assert.deepEqual(Object.keys(elsewhere).filter(c => !all.includes(c)), [],
    'and the cross-reference must not name a code the taxonomy no longer has');
});
