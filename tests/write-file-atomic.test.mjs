// Pins for src/projects.ts's writeFileAtomic (board 2026-0156).
//
// The bug: writeFileAtomic named its tmp file `${filePath}.${pid}.tmp` — one
// name shared by every same-process writer to a given target. Two concurrent
// writers collided on that name; the winner's rename deleted the loser's
// still-in-flight tmp file, and the loser threw ENOENT on a file it wrote
// itself. At the observed ENOENT, `destDirExists=true` and `tmpExists=false`
// — the target directory was never gone, so a future reader who sees this
// ENOENT again should not re-litigate a vanished-root theory; it's a stolen
// tmp name. The fix adds a per-call monotonic counter to the tmp name.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { promises as fsp } from 'node:fs';
import path from 'node:path';
import { mkdtemp } from './tmpRegistry.mjs';
import { writeFileAtomic } from '../src/projects.ts';

// Forces concurrent writeFileAtomic() calls on `targetPath` to all reach the
// write→rename boundary before any of them is allowed to rename. Scoped to
// `targetPath`'s own tmp files only (never a bare ".tmp" match) so it can't
// hold up an unrelated writeFileAtomic call elsewhere in the same process.
// src/projects.ts does `import { promises as fs } from 'node:fs'`, so
// patching a method on that same shared object is what it observes.
function installBarrier(targetPath, n) {
  const origWriteFile = fsp.writeFile;
  const origRename = fsp.rename;
  const prefix = targetPath + '.';
  const tmpPaths = [];
  let arrived = 0;
  let renamesBeforeRelease = 0;
  let released = false;
  let resolveGate;
  const gate = new Promise((resolve) => { resolveGate = resolve; });
  // Safety valve: if a writer never arrives, release anyway so a structural
  // regression fails on the arrived/renamesBeforeRelease assertions instead
  // of hanging the suite (node:test has no default per-test timeout).
  const safety = setTimeout(() => { released = true; resolveGate(); }, 8000);

  fsp.writeFile = async function (file, data, ...rest) {
    const f = String(file);
    if (f.startsWith(prefix)) {
      tmpPaths.push(f);
      arrived++;
      const result = await origWriteFile.call(this, file, data, ...rest);
      if (arrived >= n && !released) { released = true; clearTimeout(safety); resolveGate(); }
      await gate;
      return result;
    }
    return origWriteFile.call(this, file, data, ...rest);
  };
  fsp.rename = async function (oldPath, newPath) {
    if (String(oldPath).startsWith(prefix) && !released) renamesBeforeRelease++;
    return origRename.call(this, oldPath, newPath);
  };

  return {
    restore() {
      clearTimeout(safety);
      fsp.writeFile = origWriteFile;
      fsp.rename = origRename;
    },
    get arrived() { return arrived; },
    get tmpPaths() { return tmpPaths; },
    get renamesBeforeRelease() { return renamesBeforeRelease; },
  };
}

test('concurrent same-process writes to one target never share a tmp path', async () => {
  const dir = await mkdtemp('atomic-race-');
  const target = path.join(dir, 'data.json');
  const barrier = installBarrier(target, 3);
  try {
    const payloads = ['{"w":1}', '{"w":2}', '{"w":3}'];
    const results = await Promise.allSettled(payloads.map((p) => writeFileAtomic(target, p)));

    // Forcing asserted first: if the patch stopped intercepting (a rewrite to
    // a write stream, fs.open, a renamed tmp suffix), these fail loudly
    // instead of leaving a test that passes for no reason.
    assert.equal(barrier.arrived, 3, 'all three writers must reach the write→rename boundary');
    assert.equal(barrier.renamesBeforeRelease, 0, 'no writer may rename before every writer arrived');

    assert.equal(new Set(barrier.tmpPaths).size, 3, 'each call must use a distinct tmp path');
    // The tmp name must not end in `.jsonl`: the session-dir scanners
    // (projects.ts:678 listSessionsForCwdWithCounts, :980 summarizeSessions) select
    // entries by `name.endsWith('.jsonl')`, so a tmp carrying that suffix is
    // transiently listable as a bogus session row. 2026-0159 moved
    // sessionPrune/sessionEdit onto this helper off exactly such a name.
    assert.ok(barrier.tmpPaths.every((p) => p.endsWith('.tmp')), 'every tmp path must carry the .tmp suffix');
    assert.equal(results.filter((r) => r.status === 'fulfilled').length, 3, 'all three writers must succeed');
    const finalContent = await fsp.readFile(target, 'utf8');
    assert.ok(payloads.includes(finalContent), 'the surviving content must be one of the three payloads');
    const entries = await fsp.readdir(dir);
    assert.ok(!entries.some((e) => e.endsWith('.tmp')), 'no tmp file left behind');
  } finally {
    barrier.restore();
  }
});

test('a failed atomic write leaves no tmp file behind', async () => {
  const dir = await mkdtemp('atomic-leak-');
  const target = path.join(dir, 'data.json');
  // A non-empty directory at the target path makes the final rename fail
  // deterministically (measured: EISDIR), with no timing dependency.
  await fsp.mkdir(target);
  await fsp.writeFile(path.join(target, 'placeholder'), 'x');

  await assert.rejects(writeFileAtomic(target, '{}'));

  const entries = await fsp.readdir(dir);
  assert.ok(!entries.some((e) => e.endsWith('.tmp')), 'the failed write must not leak its tmp file');
});

test('a write that cannot complete rejects with its original error code', async () => {
  const dir = await mkdtemp('atomic-code-');
  const target = path.join(dir, 'data.json');
  await fsp.mkdir(target);
  await fsp.writeFile(path.join(target, 'placeholder'), 'x');

  await assert.rejects(writeFileAtomic(target, '{}'), (e) => e.code === 'EISDIR');
});

test('a vanished parent directory is recreated, not an error', async () => {
  const dir = await mkdtemp('atomic-mkdir-');
  const nested = path.join(dir, 'nested', 'sub');
  const target = path.join(nested, 'data.json');
  await fsp.mkdir(nested, { recursive: true });
  await fsp.rm(nested, { recursive: true, force: true });

  await writeFileAtomic(target, '{"ok":true}');

  const content = await fsp.readFile(target, 'utf8');
  assert.equal(content, '{"ok":true}');
});
