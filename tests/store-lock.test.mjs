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
import { fileURLToPath } from 'node:url';
import { withLock } from '../src/storeLock.ts';

const __dirname = path.dirname(fileURLToPath(import.meta.url));

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

// ── fail-closed guard ─────────────────────────────────────────────────────────

// The acquire loop's tail (src/storeLock.ts:129) is reachable in production
// only after all 25 retries elapse with a live owner that dies during the last
// backoff window: the reclaim's `continue` on the final iteration exits the loop
// without re-acquiring, and acquireLock throws rather than letting withLock run
// fn with NO lock held (the round-1 latent-bug fix). archived-lock-lost-update
// never reaches that tail — its holder releases after 1200 ms, so the waiter
// acquires on an early retry. This test constructs the tail deterministically
// instead of waiting out the real 25 retries: a fractional retry max (< 1) makes
// the planted stale lock's reclaim happen on the FIRST iteration, which is
// therefore also the FINAL one, so the loop exits with no token. The env is set
// in a child process because the retry constants are read at module load.
const storeLockMod = JSON.stringify('file://' + path.join(__dirname, '..', 'src', 'storeLock.ts'));
const waiterSrc = [
  `import { promises as fs } from 'node:fs';`,
  `const { withLock } = await import(${storeLockMod});`,
  `const [dataFile, lockFile, sentinelFile, deadPid] = process.argv.slice(2);`,
  // Plant a stale lock owned by a pid that no longer exists (reclaimable).
  `await fs.writeFile(lockFile, JSON.stringify({ pid: Number(deadPid), ts: Date.now(), token: 'stale' }));`,
  `let fnRan = false;`,
  `try {`,
  `  await withLock(dataFile, async () => { fnRan = true; await fs.writeFile(sentinelFile, '1'); });`,
  `  console.log('ACQUIRED');`,
  `} catch (e) {`,
  `  console.log('REJECTED:' + e.message);`,
  `}`,
  `console.log('FNRAN:' + fnRan);`,
  `process.exit(0);`,
].join('\n');

test('withLock fails closed when the acquire loop exits without a token', async () => {
  const dir = await tmpDir();
  try {
    const dataFile = path.join(dir, 'store.json');
    const lockFile = dataFile + '.lock';
    const sentinelFile = path.join(dir, 'fn-ran');
    const waiterPath = path.join(dir, 'waiter.mjs');
    await fs.writeFile(waiterPath, waiterSrc);

    // A real dead pid: a short-lived child that has already exited.
    const dead = spawn(process.execPath, ['-e', '']);
    await new Promise(res => dead.on('exit', res));

    const out = await new Promise((resolve, reject) => {
      const p = spawn(process.execPath, [waiterPath, dataFile, lockFile, sentinelFile, String(dead.pid)], {
        env: { ...process.env, ORCH_STORE_LOCK_RETRY_MAX: '0.5', ORCH_STORE_LOCK_RETRY_BASE_MS: '1' },
        stdio: ['ignore', 'pipe', 'inherit'],
      });
      let stdout = '';
      p.stdout.on('data', d => { stdout += String(d); });
      p.on('exit', code => code === 0 ? resolve(stdout) : reject(new Error(`waiter exit ${code}: ${stdout}`)));
      p.on('error', reject);
    });

    assert.match(out, /REJECTED:storeLock: acquire loop exited without a token/, `withLock must reject (got: ${out})`);
    assert.match(out, /FNRAN:false/, `fn must not run when no token was acquired (got: ${out})`);
    await assert.rejects(fs.stat(sentinelFile), { code: 'ENOENT' }, 'fn must not have written the sentinel');
  } finally {
    await fs.rm(dir, { recursive: true, force: true });
  }
});
