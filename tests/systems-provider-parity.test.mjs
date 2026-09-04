// The two implementations of `System` must be OBSERVATIONALLY EQUIVALENT.
//
// The whole point of Phase 1's seam is that a caller neither knows nor cares
// which one it holds; the whole point of Phase 3's gate is that the entire app
// runs over either. So every scenario here runs twice — once against the
// in-process LocalSystem, once against a ProviderSystem over the reference
// provider — on its own identical temp tree, and the two answers are compared.
//
// This is what catches a divergence the app's own tests would not: an option
// that means something slightly different on the wire, an error code that only
// one side produces, a cap applied at the wrong end.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { promises as fs } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { LocalSystem } from '../src/systems/localSystem.ts';
import { CAPABILITY_CONFIGS, makeProviderSystem } from './referenceProviderHarness.mjs';
import { rmrf } from './rmrf.mjs';

// Fields that cannot match by construction: wall-clock duration, and the roots
// the two runs were given.
function normalise(r, root) {
  const scrub = (s) => (typeof s === 'string' ? s.split(root).join('<ROOT>') : s);
  return {
    code: r.code,
    stdout: scrub(r.stdout),
    stderr: scrub(r.stderr),
    output: scrub(r.output),
    timedOut: r.timedOut,
    truncated: r.truncated,
    spawnError: scrub(r.spawnError),
  };
}

// Run one scenario against both implementations and return both answers.
// Each gets its OWN tree, built by `setup`, so a scenario can write freely.
async function both(setup, scenario) {
  const out = [];
  const local = new LocalSystem();
  const provider = makeProviderSystem([]);
  try {
    for (const sys of [local, provider]) {
      const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'cc-parity-'));
      const root = await fs.realpath(dir);
      try {
        await setup?.(root);
        out.push(await scenario(sys, root));
      } finally { await rmrf(dir); }
    }
  } finally { provider.dispose(); }
  return out;
}

// `code`/`message` only: the two implementations report the same FAILURE, not
// necessarily the same prose (one has a node errno, the other a tool's stderr).
async function codeOf(fn) {
  try { await fn(); return { ok: true }; }
  catch (e) { return { ok: false, code: e.code }; }
}

test('exec: the ordinary results agree — streams, exit code, cwd and env', async () => {
  const [a, b] = await both(null, async (sys, root) => ({
    echo: normalise(await sys.exec({ argv: ['echo', 'hello'] }, { cwd: root }), root),
    shell: normalise(await sys.exec({ shell: 'echo out; echo err >&2; exit 5' }, { cwd: root }), root),
    cwd: normalise(await sys.exec({ argv: ['pwd'] }, { cwd: root }), root),
    // A caller-named `env` REPLACES on both. THE DEFAULT IS NOT COMPARED HERE,
    // and co-location is not the reason it would agree: a caller that mutates
    // `process.env` after the provider launched now makes the two DISAGREE on
    // this very machine. The deleted `exec sends the CALLER's environment` test
    // was built on exactly that scenario and, under the old default, asserted
    // the opposite — that both implementations saw the late value. This
    // scenario mutates nothing, so both sides read one unchanging environment.
    //
    // Where the default is pinned instead, on the two-half split the env
    // suite's header sets out: the LIVE half (a late mutation) in
    // tests/systems-exec-env.test.mjs, the STATIC half (what the two
    // environments contain) in tests/systems-docker-boundary.real.test.mjs,
    // since on one machine those contents coincide. The field's ABSENCE on the
    // wire is pinned in the env suite too, and is a claim about the frame
    // rather than about either environment's contents.
    env: normalise(await sys.exec({ argv: ['sh', '-c', 'echo "[$CC_PARITY]"'] }, {
      cwd: root, env: { CC_PARITY: 'v', PATH: process.env.PATH },
    }), root),
  }));
  assert.deepEqual(a, b);
  assert.equal(a.cwd.stdout, '<ROOT>\n');
});

test('exec: a command that cannot start reports the same failure shape on both', async () => {
  const [a, b] = await both(null, async (sys, root) => ({
    missing: normalise(await sys.exec({ argv: ['cc-definitely-not-a-binary'] }, { cwd: root }), root),
    // spawn throws SYNCHRONOUSLY for a NUL byte in an argv entry — a different
    // path from a missing binary, and one both implementations must still turn
    // into a result rather than a throw.
    nul: normalise(await sys.exec({ argv: ['echo', 'a\u0000b'] }, { cwd: root }), root),
    badCwd: normalise(await sys.exec({ argv: ['echo', 'x'] }, { cwd: path.join(root, 'no-such-dir') }), root),
  }));
  for (const key of ['missing', 'nul', 'badCwd']) {
    assert.equal(a[key].code, 1, key);
    assert.equal(a[key].timedOut, false, key);
    assert.ok(a[key].spawnError, `${key}: a failure to launch is a spawnError on both`);
    assert.ok(b[key].spawnError, key);
    assert.equal(a[key].stderr, a[key].spawnError, `${key}: the message fills the empty diagnostic fields`);
    assert.equal(b[key].stderr, b[key].spawnError, key);
  }
  assert.match(a.missing.spawnError, /ENOENT/);
  assert.match(b.missing.spawnError, /ENOENT/);
  assert.match(a.nul.spawnError, /null bytes/);
  assert.match(b.nul.spawnError, /null bytes/);
});

test('exec: the three output controls truncate, drain and fence identically', async () => {
  const spew = { shell: 'for i in $(seq 1 400); do echo 0123456789012345678901234567890123456789; done' };
  const [a, b] = await both(null, async (sys, root) => ({
    tail: normalise(await sys.exec(spew, { cwd: root, cap: 137 }), root),
    head: normalise(await sys.exec(spew, { cwd: root, headCapBytes: 137 }), root),
    fence: normalise(await sys.exec(spew, { cwd: root, maxBufferBytes: 600 }), root),
    // A command that has ALREADY EXITED 0 when its output crosses the fence:
    // the overflow must still be reported as a failure, or a caller that parses
    // output whole reads a clipped parse as the truth.
    fenceAfterSuccess: normalise(await sys.exec({ shell: 'echo abcdefghij' }, { cwd: root, maxBufferBytes: 3 }), root),
    plain: normalise(await sys.exec(spew, { cwd: root }), root),
  }));
  assert.deepEqual(a.tail, b.tail);
  assert.deepEqual(a.plain, b.plain);
  assert.equal(a.tail.stdout.length, 137);
  assert.equal(a.fence.code, 1);
  assert.equal(b.fence.code, 1);
  assert.deepEqual(a.fence.stderr, b.fence.stderr, 'the overflow diagnostic is the same text on both');
  assert.deepEqual(a.fenceAfterSuccess, b.fenceAfterSuccess);
  assert.equal(a.fenceAfterSuccess.code, 1,
    'an overflow is a FAILURE even when the command itself exited 0');
  assert.equal(a.fenceAfterSuccess.truncated, true);
  assert.equal(a.head.truncated, true);
  assert.equal(b.head.truncated, true);
  // The head cap retains WHOLE chunks, so how much lands past the budget
  // depends on chunk arrival — equal exactly is not a property either
  // implementation promises. What both promise is: at least the budget, marked
  // truncated, and the command still ran to completion.
  for (const r of [a.head, b.head]) {
    assert.ok(r.stdout.length >= 137);
    assert.equal(r.code, 0);
  }
});

test('exec: a timeout is 124 + timedOut on both, and stdin:ignore closes stdin on both', async () => {
  const [a, b] = await both(null, async (sys, root) => ({
    timeout: normalise(await sys.exec({ argv: ['sleep', '10'] }, { cwd: root, timeoutMs: 250 }), root),
    ignored: normalise(await sys.exec({ argv: ['cat'] }, { cwd: root, stdin: 'ignore', timeoutMs: 2_000 }), root),
  }));
  assert.deepEqual(a, b);
  assert.equal(a.timeout.code, 124);
  assert.equal(a.timeout.timedOut, true);
  assert.equal(a.ignored.timedOut, false);
});

test('the file operations agree on results AND on error codes', async () => {
  const [a, b] = await both(
    async (root) => {
      await fs.mkdir(path.join(root, 'dir/sub'), { recursive: true });
      await fs.writeFile(path.join(root, 'dir/file'), 'contents\n');
      await fs.symlink(path.join(root, 'dir/file'), path.join(root, 'link'));
      await fs.symlink(path.join(root, 'gone'), path.join(root, 'broken'));
    },
    async (sys, root) => {
      const p = (rel) => path.join(root, rel);
      const st = await sys.stat(p('dir/file'));
      return {
        statFile: { kind: st.kind, size: st.size, mode: st.mode },
        statDir: (await sys.stat(p('dir'))).kind,
        statMissing: await sys.stat(p('nope')),
        statBroken: await sys.stat(p('broken')),
        statLink: (await sys.stat(p('link'))).kind,
        readDir: (await sys.readDir(p('dir'))).sort((x, y) => x.name.localeCompare(y.name)),
        readDirOnFile: await codeOf(() => sys.readDir(p('dir/file'))),
        readDirMissing: await codeOf(() => sys.readDir(p('nope'))),
        realpath: (await sys.realpath(p('link'))).replace(root, '<ROOT>'),
        realpathMissing: await codeOf(() => sys.realpath(p('nope'))),
        readFile: await sys.readFile(p('dir/file')),
        readFileBytes: (await sys.readFileBytes(p('dir/file'), { length: 4 })).toString('utf8'),
        readFileMissing: await codeOf(() => sys.readFile(p('nope'))),
        readFileDir: await codeOf(() => sys.readFile(p('dir'))),
        mkdirNested: await codeOf(() => sys.mkdir(p('x/y'))),
        mkdirRecursive: await codeOf(() => sys.mkdir(p('x/y'), { recursive: true })),
        mkdirTwice: await codeOf(() => sys.mkdir(p('x/y'))),
        writeExclusive: await codeOf(() => sys.writeFile(p('dir/file'), 'x', { exclusive: true })),
        unlinkMissing: await codeOf(() => sys.unlink(p('nope'))),
        removeTreeMissing: await codeOf(() => sys.removeTree(p('nope'))),
      };
    },
  );
  assert.deepEqual(a, b);
  // …and the answers are the RIGHT ones, not merely the same wrong ones.
  assert.equal(a.statMissing, null);
  assert.equal(a.statBroken, null);
  assert.equal(a.statLink, 'file');
  assert.equal(a.readDirOnFile.code, 'ENOTDIR');
  assert.equal(a.readFileDir.code, 'EISDIR');
  assert.equal(a.mkdirNested.code, 'ENOENT');
  assert.equal(a.mkdirTwice.code, 'EEXIST');
  assert.equal(a.writeExclusive.code, 'EEXIST');
  assert.equal(a.unlinkMissing.code, 'ENOENT');
  assert.equal(a.removeTreeMissing.ok, true, 'a forced removal of a missing path is a success on both');
});

test('writeFile agrees on plain, atomic and exclusive, and on what lands on disk', async () => {
  const [a, b] = await both(null, async (sys, root) => {
    const p = (rel) => path.join(root, rel);
    await sys.writeFile(p('plain'), 'one');
    await sys.writeFile(p('plain'), 'two');
    await sys.writeFile(p('atomic'), 'a', { atomic: true });
    await sys.writeFile(p('atomic'), 'b', { atomic: true });
    await sys.writeFile(p('excl'), 'only', { exclusive: true });
    // An atomic write creates the parent, matching writeFileAtomic.
    await sys.writeFile(p('deep/er/file'), 'nested', { atomic: true });
    return {
      plain: await fs.readFile(p('plain'), 'utf8'),
      atomic: await fs.readFile(p('atomic'), 'utf8'),
      excl: await fs.readFile(p('excl'), 'utf8'),
      nested: await fs.readFile(p('deep/er/file'), 'utf8'),
      leftovers: (await fs.readdir(root)).filter(n => n.includes('.tmp')),
      pair: await codeOf(() => sys.writeFile(p('plain'), 'x', { atomic: true, exclusive: true })),
    };
  });
  assert.deepEqual(a, b);
  assert.deepEqual(a.leftovers, [], 'an atomic write leaves no temp file behind');
  assert.equal(a.pair.ok, false, 'both refuse the meaningless combination');
});

test('every capability configuration is observationally equal to the local system', async () => {
  // The gate runs the whole app over each of these; this is the same claim at
  // the unit level, so a divergence names the operation rather than a failing
  // app test three layers up.
  const scenario = async (sys, root) => {
    const p = (rel) => path.join(root, rel);
    await sys.mkdir(p('d'), { recursive: true });
    await sys.writeFile(p('d/f'), 'payload');
    return {
      exec: normalise(await sys.exec({ shell: 'echo a; echo b >&2; exit 3' }, { cwd: root }), root),
      stat: (await sys.stat(p('d/f'))).size,
      read: await sys.readFile(p('d/f')),
      dir: await sys.readDir(p('d')),
      missing: await codeOf(() => sys.readFile(p('nope'))),
    };
  };
  const run = async (sys) => {
    const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'cc-parity-caps-'));
    const root = await fs.realpath(dir);
    try { return await scenario(sys, root); } finally { await rmrf(dir); }
  };
  const expected = await run(new LocalSystem());
  for (const config of CAPABILITY_CONFIGS) {
    const sys = makeProviderSystem(config.flags);
    try {
      await sys.connect();
      assert.deepEqual(await run(sys), expected, config.name);
    } finally { sys.dispose(); }
  }
});
