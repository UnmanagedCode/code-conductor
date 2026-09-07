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
        // mtimeMs is dropped for the same reason as in the capability case:
        // two separate trees. The widened-members case asserts it exactly.
        readDir: (await sys.readDir(p('dir'))).sort((x, y) => x.name.localeCompare(y.name))
          .map(({ mtimeMs, ...rest }) => rest),
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
        // A mode a caller has in hand comes from stat and carries the file-type
        // bits; chmod must MASK them on both rather than one of them rejecting.
        chmod: await (async () => {
          await sys.chmod(p('dir/file'), st.mode | 0o111);
          return (await fs.stat(p('dir/file'))).mode & 0o7777;
        })(),
        chmodMissing: await codeOf(() => sys.chmod(p('nope'), 0o644)),
      };
    },
  );
  assert.deepEqual(a, b);
  assert.equal(a.chmod, 0o755);
  assert.equal(a.chmodMissing.code, 'ENOENT');
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
      // Two separate temp trees, so mtimeMs cannot match by construction. Its
      // fidelity is asserted per-implementation in the widened-members case.
      dir: (await sys.readDir(p('d'))).map(({ mtimeMs, ...rest }) => rest),
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

// The same reason the file-operations case above exists, for the members the
// FUSE union's transport added: a symlink the two disagree about, a mode with
// type bits on one side and not the other, or an mtime one of them rounds
// differently is a mirror that answers wrongly about what a file IS.
//
// mtimeMs is NOT in the cross-implementation compare — the two runs build
// separate trees, so the numbers cannot match. It is asserted per run against
// what `fs.lstat` says on that run's own tree (`mtimeExact` below), which is
// the stronger claim anyway: EXACT whole milliseconds, no tolerance.
test('lstat, the widened readDir, readlink, symlink, removeEntry and writeFileBytes agree', async () => {
  const BINARY = Buffer.from([0x00, 0x01, 0xff, 0xfe, 0x0a, 0x00, 0x80]);
  const [a, b] = await both(
    async (root) => {
      await fs.mkdir(path.join(root, 'dir/sub'), { recursive: true });
      await fs.writeFile(path.join(root, 'dir/file'), 'contents\n');
      await fs.chmod(path.join(root, 'dir/file'), 0o755);
      await fs.symlink('relative/target', path.join(root, 'link'));
      await fs.mkdir(path.join(root, 'empty'));
      await fs.mkdir(path.join(root, 'full'));
      await fs.writeFile(path.join(root, 'full/kid'), 'x');
    },
    async (sys, root) => {
      const p = (rel) => path.join(root, rel);
      // A kind cc's own `SystemEntryKind` cannot name, so `%y`'s b/c/p/s all
      // land on 'other' — the case where a raw local mode would carry type
      // bits the derivation cannot see.
      await sys.exec({ argv: ['mkfifo', p('fifo')] }, { cwd: root });
      const scrub = (x) => (x === null ? null : { ...x, mtimeMs: '<ms>' });
      const exact = async (rel) => {
        const got = await sys.lstat(p(rel));
        return got !== null && got.mtimeMs === Math.round((await fs.lstat(p(rel))).mtimeMs);
      };

      const out = {
        lstatFile: scrub(await sys.lstat(p('dir/file'))),
        lstatDir: scrub(await sys.lstat(p('dir'))),
        // THE WHOLE REASON `lstat` EXISTS BESIDE `stat`: a symlink reported as
        // one, with its target, where `stat` answers about what it points at.
        lstatLink: scrub(await sys.lstat(p('link'))),
        lstatFifo: scrub(await sys.lstat(p('fifo'))),
        lstatMissing: await sys.lstat(p('nope')),
        lstatUnderFile: await sys.lstat(p('dir/file/x')),
        mtimeExact: [await exact('dir/file'), await exact('dir'), await exact('link')],

        readDir: (await sys.readDir(p('dir'))).sort((x, y) => x.name.localeCompare(y.name)).map(scrub),

        readlink: await sys.readlink(p('link')),
        readlinkMissing: await codeOf(() => sys.readlink(p('nope'))),

        removeEntryMissing: await codeOf(() => sys.removeEntry(p('nope'))),
        removeEntryEmptyDir: await codeOf(() => sys.removeEntry(p('empty'))),
        removeEntryFullDir: await codeOf(() => sys.removeEntry(p('full'))),
        // ASSERTED AFTER THE REFUSAL, not just the error: an `rm -rf` in
        // disguise refuses nothing and this is what would catch it.
        fullDirKept: (await sys.readDir(p('full'))).map(scrub),
      };

      // A symlink REPLACES whatever is there, on both — over nothing, over a
      // file, and over an existing link.
      await sys.symlink('one', p('sl'));
      out.symlinkFresh = await sys.readlink(p('sl'));
      await sys.symlink('two', p('sl'));
      out.symlinkOverLink = await sys.readlink(p('sl'));
      await fs.writeFile(p('overme'), 'plain');
      await sys.symlink('three', p('overme'));
      out.symlinkOverFile = await sys.readlink(p('overme'));

      // …AND OVER A REAL DIRECTORY, which is the case the three above cannot
      // reach and the only one where the two ever disagreed. MEASURED before
      // the fix: `ln -sfn -- t d` exits 0 having created `d/t`, so the wire
      // side reported SUCCESS having landed the link somewhere nobody asked
      // for, while `LocalSystem` threw. Both must refuse, with the same code,
      // and the directory must be untouched afterwards.
      await fs.mkdir(p('realdir'));
      await fs.writeFile(p('realdir/kid'), 'x');
      out.symlinkOverDir = await codeOf(() => sys.symlink('four', p('realdir')));
      out.dirSurvived = (await sys.lstat(p('realdir'))).kind;
      out.dirKeptKids = (await sys.readDir(p('realdir'))).map(e => e.name);

      // `removeEntry` on a symlink takes the LINK, never the target.
      await sys.symlink(p('dir/file'), p('doomed'));
      await sys.removeEntry(p('doomed'));
      out.linkGoneTargetStayed = [await sys.lstat(p('doomed')), (await sys.lstat(p('dir/file'))).kind];

      // Bytes a UTF-8 round trip does not survive, and the mode that makes an
      // atomic write preserving.
      await sys.writeFileBytes(p('bin'), BINARY, { atomic: true, mode: 0o750 });
      out.binary = (await sys.readFileBytes(p('bin'))).toString('hex');
      out.binaryMode = (await sys.lstat(p('bin'))).mode.toString(8);
      out.binaryPair = await codeOf(() => sys.writeFileBytes(p('bin'), BINARY, { atomic: true, exclusive: true }));
      return out;
    },
  );
  assert.deepEqual(a, b);

  // …and the answers are the RIGHT ones, not merely the same wrong ones.
  assert.deepEqual(a.lstatLink, { kind: 'symlink', size: 15, mode: 0o120777, mtimeMs: '<ms>', target: 'relative/target' });
  assert.equal(a.lstatFile.mode, 0o100755, 'a FULL mode: permission bits plus the type bits the kind implies');
  assert.equal(a.lstatDir.mode & 0o170000, 0o040000);
  assert.equal(a.lstatFifo.kind, 'other');
  assert.equal(a.lstatFifo.mode & 0o170000, 0, 'a kind cc cannot name reports permission bits alone on BOTH sides');
  assert.equal(a.lstatMissing, null);
  assert.equal(a.lstatUnderFile, null, 'a non-directory component is absence, not a failure to look');
  assert.deepEqual(a.mtimeExact, [true, true, true], 'whole-millisecond mtime, exactly, on both');

  assert.deepEqual(a.readDir.map(e => e.name), ['file', 'sub']);
  assert.equal(a.readDir[0].mode, 0o100755, 'the listing carries the mode, so a child costs no second round trip');
  assert.equal(a.readDir[0].size, 9);
  assert.equal(a.readDir[1].kind, 'dir');
  assert.deepEqual(a.readDir.map(e => e.target), [null, null]);

  assert.equal(a.readlink, 'relative/target');
  assert.equal(a.readlinkMissing.code, 'ENOENT');

  assert.equal(a.removeEntryMissing.ok, true, 'an absent entry is the declared intent already met');
  assert.equal(a.removeEntryEmptyDir.ok, true);
  assert.equal(a.removeEntryFullDir.code, 'ENOTEMPTY');
  assert.deepEqual(a.fullDirKept.map(e => e.name), ['kid'], 'the refusal kept the children');

  assert.deepEqual([a.symlinkFresh, a.symlinkOverLink, a.symlinkOverFile], ['one', 'two', 'three']);
  assert.equal(a.symlinkOverDir.ok, false, 'a symlink silently landed INSIDE the directory instead of refusing');
  assert.equal(a.symlinkOverDir.code, 'EISDIR');
  assert.equal(a.dirSurvived, 'dir');
  assert.deepEqual(a.dirKeptKids, ['kid'], 'the refusal left the directory and its children alone');
  assert.deepEqual(a.linkGoneTargetStayed, [null, 'file']);

  assert.equal(a.binary, BINARY.toString('hex'), 'a NUL and a 0xFF survive the wire unmangled');
  assert.equal(a.binaryMode, '100750', 'the mode rides the atomic write, so a rename does not reset it');
  assert.equal(a.binaryPair.ok, false);
});

// REPAIRED RATHER THAN PINNED. `fs.readlink` of a non-symlink is EINVAL, and
// `readlink -v` says "Invalid argument" — the same failure, observed by both
// sides, which for a while cc answered `EUNKNOWN` to on the wire and `EINVAL`
// to locally. The first cut of this file pinned that as a divergence.
//
// THE CLOSED-TAXONOMY ARGUMENT FOR KEEPING IT RAN BACKWARDS: the taxonomy is
// closed SO THAT every error a real call can produce is named, so an errno a
// genuine call produces and cc cannot name is exactly what the closure exists
// to prevent — a caller cannot tell "that is not a symlink" from "the box
// hiccuped". One `FS_ERROR_CODES` entry and one classifier row, and the
// conformance suite's "every code is produced by a real failure" case is
// satisfied by the very call below. A permanent case titled "the one code the
// two do NOT share", inside a suite whose stated invariant is that they agree
// on error codes, was the worse outcome.
test('readlink of a non-symlink is EINVAL on both, not EUNKNOWN on one', async () => {
  const [a, b] = await both(
    async (root) => { await fs.writeFile(path.join(root, 'plain'), 'x'); },
    async (sys, root) => ({
      nonLink: await codeOf(() => sys.readlink(path.join(root, 'plain'))),
      // The control that keeps this about the KIND and not about the path:
      // absence is still ENOENT, and the two must not have collapsed together.
      missing: await codeOf(() => sys.readlink(path.join(root, 'nope'))),
    }),
  );
  assert.deepEqual(a, b);
  assert.equal(a.nonLink.code, 'EINVAL');
  assert.equal(a.missing.code, 'ENOENT');
});

// DERIVED FROM THE PROTOTYPE, NOT TRANSCRIBED. A member added to `System`
// without a parity case fails HERE rather than shipping uncovered — which is
// the failure mode a hand-maintained list of members has by construction.
//
// The value is the title of the case that runs it against BOTH implementations,
// and the titles are checked against this file's own bytes, so a row naming a
// case that does not exist is a failure too.
const PARITY_CASES = {
  exec: 'exec: the ordinary results agree — streams, exit code, cwd and env',
  readFile: 'the file operations agree on results AND on error codes',
  readFileBytes: 'the file operations agree on results AND on error codes',
  writeFile: 'writeFile agrees on plain, atomic and exclusive, and on what lands on disk',
  writeFileBytes: 'lstat, the widened readDir, readlink, symlink, removeEntry and writeFileBytes agree',
  stat: 'the file operations agree on results AND on error codes',
  lstat: 'lstat, the widened readDir, readlink, symlink, removeEntry and writeFileBytes agree',
  readDir: 'lstat, the widened readDir, readlink, symlink, removeEntry and writeFileBytes agree',
  readlink: 'lstat, the widened readDir, readlink, symlink, removeEntry and writeFileBytes agree',
  // (also 'readlink of a non-symlink is EINVAL on both, not EUNKNOWN on one')
  symlink: 'lstat, the widened readDir, readlink, symlink, removeEntry and writeFileBytes agree',
  removeEntry: 'lstat, the widened readDir, readlink, symlink, removeEntry and writeFileBytes agree',
  realpath: 'the file operations agree on results AND on error codes',
  mkdir: 'the file operations agree on results AND on error codes',
  removeTree: 'the file operations agree on results AND on error codes',
  unlink: 'the file operations agree on results AND on error codes',
  chmod: 'the file operations agree on results AND on error codes',
  // cc's own machine advertises nothing unconditionally and NOTHING calls it on
  // a `local` handle (LocalSystem.mirror's own header), so there is no shared
  // behaviour to compare. Its wire half is tests/systems-mirror-advertisement.
  mirror: null,
};

test('every member of System has a parity case, derived from the prototype', async () => {
  const members = Object.getOwnPropertyNames(LocalSystem.prototype)
    .filter(n => n !== 'constructor').sort();
  assert.ok(members.length >= 17, `only ${members.length} members enumerated — re-anchor this test`);
  assert.deepEqual(members.filter(m => !(m in PARITY_CASES)), [],
    'a member of System with no parity case');
  assert.deepEqual(Object.keys(PARITY_CASES).filter(m => !members.includes(m)).sort(), [],
    'a parity case naming a member System no longer has');
  // NON-VACUITY: a row may not name a case that does not exist.
  const self = await fs.readFile(new URL(import.meta.url), 'utf8');
  for (const [member, title] of Object.entries(PARITY_CASES)) {
    if (title === null) continue;
    assert.ok(self.includes(`test('${title}'`), `${member} names a case this file does not define: ${title}`);
  }
});
