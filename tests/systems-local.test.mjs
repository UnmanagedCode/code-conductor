// The `local` System: the contract every call site now depends on, and the
// `.conduct` pin.
//
// Phase 1 of Systems (docs/systems-design.md) routes every project-scoped
// operation through a System handle. LocalSystem is the only implementation,
// and its job is to be indistinguishable from the direct fs/spawn calls it
// replaced — so the semantics asserted here are the ones the call sites were
// written against, not new ones: absence is a value (not a throw), a broken
// installation still throws, `unlink` never follows a symlink, and an `exec`
// head cap truncates what is SHOWN while the command runs to completion.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { promises as fs } from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import { rmrf } from './rmrf.mjs';
import { localSystem, resolveSystem, CONDUCT_PROJECT_NAME, LOCAL_SYSTEM_ID } from '../src/systems/registry.ts';

function tmpdir() {
  return fs.mkdtemp(path.join(os.tmpdir(), 'cc-systems-local-'));
}

// VACUOUS UNTIL PHASE 2, AND DELIBERATELY KEPT ANYWAY. In Phase 1 there is no
// record that could name another system, so every project resolves local and
// deleting the pin from resolveSystem changes nothing this test can see —
// verified, not assumed. It pins the CONTRACT so the pin has an assertion to
// grow into: the test that can fail lands with P2's record reads, where a
// `.conduct` record naming a system must still resolve local.
test('resolveSystem pins `.conduct` to the local system', async () => {
  const sys = await resolveSystem(CONDUCT_PROJECT_NAME);
  assert.equal(sys.id, LOCAL_SYSTEM_ID);
  assert.equal(sys, localSystem(), 'the pin returns THE local handle, not a second one');
});

test('resolveSystem hands every caller the one local handle', async () => {
  // One System instance per process: a handle is a connection, not a value, so
  // two `local` handles would be two identities for one machine.
  const a = await resolveSystem('some-project');
  const b = await resolveSystem('another-project');
  assert.equal(a, b);
  assert.equal(a, localSystem());
  assert.equal(a.id, LOCAL_SYSTEM_ID);
});

test('stat reports absence as a value and a real fault as a throw', async () => {
  const dir = await tmpdir();
  try {
    const sys = localSystem();
    assert.equal(await sys.stat(path.join(dir, 'nope')), null,
      'a missing path is `null`, matching resolveProjectDir ENOENT to null');

    const file = path.join(dir, 'f.txt');
    await fs.writeFile(file, 'hello');
    const st = await sys.stat(file);
    assert.equal(st.kind, 'file');
    assert.equal(st.size, 5);
    assert.equal((await sys.stat(dir)).kind, 'dir');

    // ENOTDIR: a path THROUGH a file. Not absence — a caller told "no such
    // file" would hunt for something that is really a broken layout.
    await assert.rejects(() => sys.stat(path.join(file, 'under-a-file')),
      (e) => e.code === 'ENOTDIR',
      'a non-ENOENT stat failure must surface, not read as absent');
  } finally { await rmrf(dir); }
});

test('unlink removes the link, never what it points at', async () => {
  // The invariant deleteProject's external branch rests on
  // (docs/systems-design.md 5.4): the interface itself must guarantee that the
  // single-entry removal cannot reach the target.
  const dir = await tmpdir();
  try {
    const target = path.join(dir, 'target');
    await fs.mkdir(target);
    await fs.writeFile(path.join(target, 'payload.txt'), 'keep me');
    const link = path.join(dir, 'link');
    await fs.symlink(target, link);

    await localSystem().unlink(link);

    await assert.rejects(() => fs.lstat(link), 'the link is gone');
    assert.equal(await fs.readFile(path.join(target, 'payload.txt'), 'utf8'), 'keep me',
      'the target is untouched');
  } finally { await rmrf(dir); }
});

test('removeTree is the recursive, forced removal — and only it is', async () => {
  const dir = await tmpdir();
  try {
    const tree = path.join(dir, 'tree');
    await fs.mkdir(path.join(tree, 'nested'), { recursive: true });
    await fs.writeFile(path.join(tree, 'nested', 'f.txt'), 'x');

    // unlink refuses a directory; that difference is the whole point of having
    // two removal shapes rather than one.
    await assert.rejects(() => localSystem().unlink(tree));
    assert.ok((await fs.stat(tree)).isDirectory());

    await localSystem().removeTree(tree);
    assert.equal(await localSystem().stat(tree), null);
    // Forced: removing what is already gone is not an error.
    await localSystem().removeTree(tree);
  } finally { await rmrf(dir); }
});

test('writeFile: exclusive refuses an existing file, atomic creates parents and replaces', async () => {
  const dir = await tmpdir();
  try {
    const sys = localSystem();
    const f = path.join(dir, 'once.txt');
    await sys.writeFile(f, 'first', { exclusive: true });
    await assert.rejects(() => sys.writeFile(f, 'second', { exclusive: true }),
      (e) => e.code === 'EEXIST',
      'EEXIST is what ensureConventionsImport branches on — it must not be swallowed');
    assert.equal(await fs.readFile(f, 'utf8'), 'first');

    const nested = path.join(dir, 'a', 'b', 'atomic.txt');
    await sys.writeFile(nested, 'body', { atomic: true });
    assert.equal(await fs.readFile(nested, 'utf8'), 'body', 'atomic write creates missing parents');
    await sys.writeFile(nested, 'body2', { atomic: true });
    assert.equal(await fs.readFile(nested, 'utf8'), 'body2');
    // No temp file left behind by a successful write.
    assert.deepEqual((await fs.readdir(path.dirname(nested))).sort(), ['atomic.txt']);

    // A plain write overwrites.
    await sys.writeFile(f, 'third');
    assert.equal(await fs.readFile(f, 'utf8'), 'third');
  } finally { await rmrf(dir); }
});

test('readFileBytes reads only the requested prefix', async () => {
  const dir = await tmpdir();
  try {
    const f = path.join(dir, 'big.txt');
    await fs.writeFile(f, 'abcdefghij');
    assert.equal((await localSystem().readFileBytes(f, { length: 4 })).toString('utf8'), 'abcd');
    assert.equal((await localSystem().readFileBytes(f)).toString('utf8'), 'abcdefghij');
  } finally { await rmrf(dir); }
});

test('readDir reports the entry kind without following a symlink', async () => {
  const dir = await tmpdir();
  try {
    await fs.mkdir(path.join(dir, 'sub'));
    await fs.writeFile(path.join(dir, 'file.txt'), '');
    await fs.symlink(path.join(dir, 'sub'), path.join(dir, 'link'));
    const byName = new Map((await localSystem().readDir(dir)).map(e => [e.name, e.kind]));
    assert.equal(byName.get('sub'), 'dir');
    assert.equal(byName.get('file.txt'), 'file');
    assert.equal(byName.get('link'), 'symlink',
      'listProjects tells an adopted symlink from a worktree directory by exactly this');
  } finally { await rmrf(dir); }
});

test('exec with stdin:ignore hands the command EOF instead of hanging', async () => {
  const dir = await tmpdir();
  try {
    // `cat` with no argument reads stdin. With a pipe nobody writes to it would
    // block until the timeout; with 'ignore' it sees EOF and exits at once.
    // The assertion is on the EXIT, not on elapsed time: a wall-clock threshold
    // would be a race on a loaded machine, while a timed-out run is reported.
    const r = await localSystem().exec({ argv: ['cat'] }, { cwd: dir, timeoutMs: 5000, stdin: 'ignore' });
    assert.equal(r.timedOut, false, 'stdin was not closed — the command waited for input');
    assert.equal(r.code, 0);
    assert.equal(r.stdout, '');
  } finally { await rmrf(dir); }
});

test('exec headCapBytes keeps the HEAD of the output and still runs to completion', async () => {
  const dir = await tmpdir();
  try {
    const marker = path.join(dir, 'finished');
    const r = await localSystem().exec(
      { shell: `for i in $(seq 1 400); do echo "line-$i"; done; touch ${JSON.stringify(marker)}` },
      { cwd: dir, headCapBytes: 100 },
    );
    assert.equal(r.truncated, true);
    assert.match(r.output, /^line-1\n/, 'the FIRST bytes are kept — a tail cap would show the end instead');
    assert.ok(!r.output.includes('line-400'), 'output past the cap is dropped');
    assert.ok(r.output.length < 4000, `retained far more than the cap: ${r.output.length}`);
    assert.ok((await fs.stat(marker)).isFile(),
      'the command must run to completion — the cap truncates what is shown, not the work');
  } finally { await rmrf(dir); }
});

test('exec maxBufferBytes FAILS past the ceiling rather than truncating successfully', async () => {
  const dir = await tmpdir();
  try {
    // The fence behind runGit. Its callers parse git output whole, so the one
    // outcome that must never happen is a short read reported as success —
    // that is a wrong answer, where a failure is merely a failure.
    const r = await localSystem().exec(
      { shell: `for i in $(seq 1 20000); do echo "line-$i-padding-padding-padding"; done` },
      { cwd: dir, maxBufferBytes: 4096 },
    );
    assert.equal(r.code, 1, 'past the ceiling the call FAILS — a truncated success would be read as the truth');
    assert.equal(r.timedOut, false, 'the ceiling is not a timeout');
    assert.match(r.stderr, /exceeded the 4096-byte limit/,
      'the diagnostic lands in stderr, which is where the `stderr || stdout` callers read it');
    assert.match(r.stdout, /^line-1-/, 'the output that arrived first is retained');
    assert.ok(r.stdout.length > 0 && r.stdout.length <= 4096,
      `the failure carries exactly the output under the fence, kept ${r.stdout.length} bytes`);
  } finally { await rmrf(dir); }
});

test('a command that finishes before the kill lands still FAILS past the ceiling', async () => {
  const dir = await tmpdir();
  try {
    // The fence has two independent halves and only one of them is the kill.
    // `head` writes 8 KB into the pipe (well under its capacity, so it never
    // blocks) and exits 0 before a signal could change anything — so the exit
    // code cc sees is the command's own success. Without the explicit
    // overflow-to-failure mapping the result would be `{code: 0}` carrying a
    // 1 KB prefix of an 8 KB answer: a truncated success, the one outcome a
    // parse-whole caller cannot detect. Measured deterministic over 30 runs.
    const r = await localSystem().exec({ argv: ['head', '-c', '8192', '/dev/zero'] },
      { cwd: dir, maxBufferBytes: 1024 });
    assert.equal(r.code, 1, 'a self-terminating command must not report success with clipped output');
    assert.equal(r.stdout.length, 1024, 'and it still carries exactly the output under the fence');
  } finally { await rmrf(dir); }
});

test('exec under the ceiling is untouched by it', async () => {
  const dir = await tmpdir();
  try {
    const r = await localSystem().exec({ shell: 'echo small' }, { cwd: dir, maxBufferBytes: 4096 });
    assert.equal(r.code, 0);
    assert.equal(r.stdout, 'small\n');
    assert.equal(r.stderr, '', 'no diagnostic is invented for output that fits');
    assert.equal(r.truncated, false);
  } finally { await rmrf(dir); }
});

test('exec never rejects, even when spawn throws synchronously', async () => {
  const dir = await tmpdir();
  try {
    // A NUL byte in an argv entry makes Node's spawn throw SYNCHRONOUSLY rather
    // than emit 'error'. project_bash interpolates the caller's command string
    // into argv, so this input is reachable from the API, and the runner's
    // "never rejects" contract is what turns it into a reported result instead
    // of an exception out of the tool call.
    const r = await localSystem().exec({ argv: ['echo', 'a\u0000b'] }, { cwd: dir });
    assert.equal(r.code, 1);
    assert.ok(r.spawnError, 'the synchronous throw is reported as a spawnError');
    assert.equal(r.timedOut, false);
    assert.equal(r.output, r.spawnError, 'the diagnostic reaches an output-reading caller');
  } finally { await rmrf(dir); }
});
