// Direct unit pins on the cross-process advisory lock (src/storeLock.ts,
// converted to type-safe TS in round 1). archived-lock-lost-update.test.mjs
// pins the no-lost-update guarantee through the archive store; this file pins
// the lock primitive itself: acquire/release, mutual exclusion, exception
// safety, and dead-owner reclaim.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { promises as fs } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawn } from 'node:child_process';
import { withLock } from '../src/storeLock.ts';

async function tmpDir() {
  return fs.mkdtemp(path.join(os.tmpdir(), 'store-lock-'));
}

function sleep(ms) {
  return new Promise(r => setTimeout(r, ms));
}

test('withLock runs fn under the lock and releases it after', async () => {
  const dir = await tmpDir();
  try {
    const dataFile = path.join(dir, 'store.json');
    let sawLockDuring = false;
    await withLock(dataFile, async () => {
      try { await fs.stat(dataFile + '.lock'); sawLockDuring = true; } catch { /* not yet created */ }
    });
    assert.ok(sawLockDuring, 'lockfile must exist while fn runs');
    await assert.rejects(fs.stat(dataFile + '.lock'), { code: 'ENOENT' }, 'lockfile must be gone after fn');
  } finally {
    await fs.rm(dir, { recursive: true, force: true });
  }
});

test('withLock propagates the fn return value', async () => {
  const dir = await tmpDir();
  try {
    const dataFile = path.join(dir, 'store.json');
    assert.equal(await withLock(dataFile, async () => 42), 42);
  } finally {
    await fs.rm(dir, { recursive: true, force: true });
  }
});

test('withLock propagates an fn throw and still releases the lock', async () => {
  const dir = await tmpDir();
  try {
    const dataFile = path.join(dir, 'store.json');
    await assert.rejects(withLock(dataFile, async () => { throw new Error('boom'); }), /boom/);
    await assert.rejects(fs.stat(dataFile + '.lock'), { code: 'ENOENT' }, 'lock released even on throw');
  } finally {
    await fs.rm(dir, { recursive: true, force: true });
  }
});

test('concurrent withLock calls on one dataFile never run their fns overlapping', async () => {
  const dir = await tmpDir();
  try {
    const dataFile = path.join(dir, 'store.json');
    let active = 0;
    let maxActive = 0;
    const run = () => withLock(dataFile, async () => {
      active++;
      maxActive = Math.max(maxActive, active);
      await sleep(60);
      active--;
    });
    await Promise.all([run(), run(), run()]);
    assert.equal(maxActive, 1, 'two fns ran at once — mutual exclusion broken');
    await assert.rejects(fs.stat(dataFile + '.lock'), { code: 'ENOENT' });
  } finally {
    await fs.rm(dir, { recursive: true, force: true });
  }
});

test('withLock reclaims a lockfile whose owner pid is dead', async () => {
  const dir = await tmpDir();
  try {
    const dataFile = path.join(dir, 'store.json');
    // A real dead pid: a short-lived child that has already exited.
    const dead = spawn(process.execPath, ['-e', '']);
    await new Promise(res => dead.on('exit', res));
    await fs.writeFile(dataFile + '.lock', JSON.stringify({ pid: dead.pid, ts: Date.now(), token: 'stale' }));
    let ran = false;
    await withLock(dataFile, async () => { ran = true; });
    assert.ok(ran, 'fn must run after the dead owner lock is reclaimed');
    await assert.rejects(fs.stat(dataFile + '.lock'), { code: 'ENOENT' });
  } finally {
    await fs.rm(dir, { recursive: true, force: true });
  }
});

test('a released lock can be acquired again', async () => {
  const dir = await tmpDir();
  try {
    const dataFile = path.join(dir, 'store.json');
    await withLock(dataFile, async () => {});
    await withLock(dataFile, async () => {});
  } finally {
    await fs.rm(dir, { recursive: true, force: true });
  }
});
