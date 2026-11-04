// Direct unit pins on the cross-process advisory lock (src/storeLock.ts,
// converted to type-safe TS in round 1). archived-lock-lost-update.test.mjs
// pins the no-lost-update guarantee through the archive store; this file pins
// the lock primitive itself: acquire/release, mutual exclusion, exception
// safety, and dead-owner reclaim.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { promises as fs } from 'node:fs';
import path from 'node:path';
import { spawn } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { withLock, createLockFileSync, releaseLockSync, mintLockToken, stageLockFileSync, publishLockFileSync, LINK_PROBE_PREFIX } from '../src/storeLock.ts';
import { linkSync } from 'node:fs';
import { mkdtemp } from './tmpRegistry.mjs';

const __dirname = path.dirname(fileURLToPath(import.meta.url));

async function tmpDir() {
  return mkdtemp('store-lock-');
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

// ── release ordering ──────────────────────────────────────────────────────────

// Returns true if `lockPath` disappears within `budgetMs`, false if it is still
// there when the budget runs out. Polls rather than sleeping a fixed span so the
// FAILING direction is fast; only the passing direction pays the full budget.
async function lockVanishesWithin(lockPath, budgetMs) {
  const deadline = Date.now() + budgetMs;
  for (;;) {
    try { await fs.stat(lockPath); } catch { return true; }
    if (Date.now() >= deadline) return false;
    await sleep(10);
  }
}

// The lock must stay held until fn's BODY settles — not merely until fn returns
// a promise. `withLock` does `return await fn()` inside try/finally: that `await`
// is what suspends inside the `try`, so `finally`'s releaseLock runs only once
// the body is done. Weakening it to `return fn()` makes `finally` run at the
// return statement itself, unlinking the lockfile while the body is still in
// flight — every caller of this shared primitive (the session store's
// read-modify-write, the FUSE union build) would then run its critical section
// UNLOCKED, silently reopening the cross-process race the lock exists to close.
//
// The test above ('runs fn under the lock and releases it after') cannot catch
// that: its body never parks, so its own `fs.stat` races the erroneous release.
// Nor is a timing-interleaved extra writer the answer — that buys flakiness.
// Here the body parks on a gate only this test can open, so "the body is in
// flight" is a fact rather than a timing guess. A correct implementation can
// NEVER release during that window, so this cannot fail spuriously; the mutant
// releases within a few ms of the return.
test("withLock holds the lock until fn's body settles, not just until fn returns", async () => {
  const dir = await tmpDir();
  try {
    const dataFile = path.join(dir, 'store.json');
    const lockPath = dataFile + '.lock';

    let openGate;
    const gate = new Promise(r => { openGate = r; });
    let markEntered;
    const entered = new Promise(r => { markEntered = r; });

    const call = withLock(dataFile, async () => {
      markEntered();
      await gate; // parked: the body is unambiguously mid-flight from here
      return 'done';
    });

    try {
      await entered;

      // Forcing assertion: without a lockfile actually on disk the check below
      // would "pass" for the wrong reason (nothing to observe vanishing).
      await fs.stat(lockPath);

      const releasedEarly = await lockVanishesWithin(lockPath, 750);
      assert.equal(releasedEarly, false, 'lock was released while fn body was still in flight');
    } finally {
      // Always un-park, so a failed assertion above ends the test instead of
      // leaving `call` pending forever.
      openGate();
      await call.catch(() => {});
    }

    assert.equal(await call, 'done');
    await assert.rejects(fs.stat(lockPath), { code: 'ENOENT' }, 'lock must be released once the body settles');
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

// ── The sync create/release the projects-root lock shares (src/rootLock.ts) ──

test('createLockFileSync creates a complete record, and returns false on an existing file without touching it', async () => {
  const dir = await tmpDir();
  try {
    const lockPath = path.join(dir, 'x.lock');
    assert.equal(createLockFileSync(lockPath, '{"token":"a"}'), true);
    assert.equal(await fs.readFile(lockPath, 'utf8'), '{"token":"a"}');
    assert.equal(createLockFileSync(lockPath, '{"token":"b"}'), false);
    assert.equal(await fs.readFile(lockPath, 'utf8'), '{"token":"a"}', 'the holder\'s record is untouched');
  } finally {
    await fs.rm(dir, { recursive: true, force: true });
  }
});

test('createLockFileSync throws on a failure other than EEXIST', async () => {
  const dir = await tmpDir();
  try {
    assert.throws(() => createLockFileSync(path.join(dir, 'no-such-dir', 'x.lock'), '{}'), { code: 'ENOENT' });
  } finally {
    await fs.rm(dir, { recursive: true, force: true });
  }
});

test('releaseLockSync removes only a lockfile carrying our token; a successor\'s survives', async () => {
  const dir = await tmpDir();
  try {
    const lockPath = path.join(dir, 'x.lock');
    const mine = mintLockToken();
    const successor = mintLockToken();
    assert.notEqual(mine, successor, 'every minted token is unique');
    createLockFileSync(lockPath, JSON.stringify({ pid: process.pid, token: successor }));
    releaseLockSync(lockPath, mine);
    assert.equal(JSON.parse(await fs.readFile(lockPath, 'utf8')).token, successor, 'a successor\'s lock survives');
    releaseLockSync(lockPath, successor);
    await assert.rejects(fs.stat(lockPath), { code: 'ENOENT' }, 'our own lock is removed');
    assert.doesNotThrow(() => releaseLockSync(lockPath, successor), 'releasing a vanished lock is a no-op');
  } finally {
    await fs.rm(dir, { recursive: true, force: true });
  }
});

test('mintLockToken carries CSPRNG bytes beyond pid, time and counter', () => {
  const tails = [mintLockToken(), mintLockToken()].map((tok) => tok.split('-').at(-1));
  for (const tail of tails) assert.match(tail, /^[0-9a-f]{16}$/);
  assert.notEqual(tails[0], tails[1]);
});

test('a staged lockfile is invisible at its path until published; publishing a taken path fails and cleans up', async () => {
  const dir = await tmpDir();
  try {
    const lockPath = path.join(dir, 'x.lock');
    const staged = stageLockFileSync(lockPath, '{"token":"a"}');
    await assert.rejects(fs.stat(lockPath), { code: 'ENOENT' }, 'nothing at the lock path while staged');
    assert.equal(publishLockFileSync(staged, lockPath), true);
    assert.equal(await fs.readFile(lockPath, 'utf8'), '{"token":"a"}', 'published whole');
    const second = stageLockFileSync(lockPath, '{"token":"b"}');
    assert.equal(publishLockFileSync(second, lockPath), false);
    assert.equal(await fs.readFile(lockPath, 'utf8'), '{"token":"a"}');
    assert.deepEqual(await fs.readdir(dir), ['x.lock'], 'no staging file survives a publish or a refusal');
  } finally {
    await fs.rm(dir, { recursive: true, force: true });
  }
});

// ── The no-hard-links fallback ────────────────────────────────────────────────

const linkFailing = (code) => () => { throw Object.assign(new Error(`link ${code}`), { code }); };
function recordingLog() {
  const log = { info: [], warn: [] };
  return { log, deps: (link) => ({ link, log: { info: (m) => log.info.push(m), warn: (m) => log.warn.push(m) } }) };
}

for (const code of ['EPERM', 'ENOTSUP', 'EOPNOTSUPP', 'ENOSYS', 'EXDEV']) {
  test(`a probe link failing ${code} selects the in-place create, which is exclusive and leaves no temp file`, async () => {
    const dir = await tmpDir();
    try {
      const { log, deps } = recordingLog();
      let links = 0;
      const d = deps((...a) => { links++; linkFailing(code)(...a); });
      const lockPath = path.join(dir, 'x.lock');
      assert.equal(createLockFileSync(lockPath, '{"token":"a"}', d), true);
      assert.equal(createLockFileSync(lockPath, '{"token":"b"}', d), false, 'exclusive');
      assert.equal(await fs.readFile(lockPath, 'utf8'), '{"token":"a"}');
      assert.equal(createLockFileSync(path.join(dir, 'y.lock'), '{}', d), true);
      assert.equal(links, 1, 'probed once for the directory; the in-place create never links');
      assert.deepEqual((await fs.readdir(dir)).sort(), ['x.lock', 'y.lock'], 'no staging or probe file left');
      assert.equal(log.warn.length, code === 'EXDEV' ? 2 : 1, 'the fallback is logged once (EXDEV with an extra warning)');
      assert.equal(log.info.length, 0);
    } finally {
      await fs.rm(dir, { recursive: true, force: true });
    }
  });
}

for (const code of ['EACCES', 'EROFS', 'ENOSPC', 'EIO', 'EMLINK']) {
  test(`a probe link failing ${code} is a real failure: it propagates and is not cached`, async () => {
    const dir = await tmpDir();
    try {
      const { deps } = recordingLog();
      const lockPath = path.join(dir, 'x.lock');
      assert.throws(() => createLockFileSync(lockPath, '{}', deps(linkFailing(code))), { code });
      assert.deepEqual(await fs.readdir(dir), [], 'nothing created, no probe file left');
      assert.equal(createLockFileSync(lockPath, '{"token":"a"}', deps(linkSync)), true, 'the next create probes again');
      assert.deepEqual(await fs.readdir(dir), ['x.lock'], 'and publishes by link');
    } finally {
      await fs.rm(dir, { recursive: true, force: true });
    }
  });
}

test('the link mode is probed and logged once per directory', async () => {
  const dir = await tmpDir();
  try {
    const { log, deps } = recordingLog();
    const probes = [];
    const d = deps((a, b) => { if (path.basename(a).startsWith(LINK_PROBE_PREFIX)) probes.push(a); linkSync(a, b); });
    assert.equal(createLockFileSync(path.join(dir, 'a.lock'), '{}', d), true);
    assert.equal(createLockFileSync(path.join(dir, 'b.lock'), '{}', d), true);
    assert.equal(probes.length, 1);
    assert.equal(log.info.length, 1);
    assert.equal(log.warn.length, 0);
  } finally {
    await fs.rm(dir, { recursive: true, force: true });
  }
});

// A child with withLock's retries cut short (the knobs are read at module load).
function runShortRetries(src, args) {
  return new Promise((resolve, reject) => {
    const p = spawn(process.execPath, ['--input-type=module', '-e', src, '--', ...args], {
      env: { ...process.env, ORCH_STORE_LOCK_RETRY_MAX: '2', ORCH_STORE_LOCK_RETRY_BASE_MS: '1' },
      stdio: ['ignore', 'pipe', 'inherit'],
    });
    let stdout = '';
    p.stdout.on('data', (d) => { stdout += String(d); });
    p.on('exit', (code) => (code === 0 ? resolve(stdout) : reject(new Error(`exit ${code}: ${stdout}`))));
    p.on('error', reject);
  });
}
const tryWithLockSrc = [
  `const { withLock } = await import(${storeLockMod});`,
  `const [dataFile] = process.argv.slice(1).filter((a) => a !== '--');`,
  `let ran = false;`,
  `try { await withLock(dataFile, async () => { ran = true; }); console.log('ACQUIRED'); }`,
  `catch (e) { console.log('REJECTED:' + e.message); }`,
  `console.log('RAN:' + ran);`,
].join('\n');

test('withLock waits out an empty lockfile (one being written in place) and never steals it', async () => {
  const dir = await tmpDir();
  try {
    const dataFile = path.join(dir, 'store.json');
    await fs.writeFile(dataFile + '.lock', '');
    const out = await runShortRetries(tryWithLockSrc, [dataFile]);
    assert.match(out, /REJECTED:storeLock: could not acquire store\.json\.lock after/);
    assert.match(out, /RAN:false/);
    assert.equal(await fs.readFile(dataFile + '.lock', 'utf8'), '', 'the empty lockfile is left alone');
  } finally {
    await fs.rm(dir, { recursive: true, force: true });
  }
});

async function deadPid() {
  const dead = spawn(process.execPath, ['-e', '']);
  await new Promise((res) => dead.on('exit', res));
  return dead.pid;
}

test('a live reclaimer\'s marker is respected: the dead owner\'s lock is not reclaimed past it', async () => {
  const dir = await tmpDir();
  try {
    const dataFile = path.join(dir, 'store.json');
    const owner = JSON.stringify({ pid: await deadPid(), ts: Date.now(), token: 'dead' });
    await fs.writeFile(dataFile + '.lock', owner);
    await fs.writeFile(dataFile + '.lock.reclaim', JSON.stringify({ pid: process.pid, ts: Date.now(), token: 'live' }));
    const out = await runShortRetries(tryWithLockSrc, [dataFile]);
    assert.match(out, /RAN:false/);
    assert.equal(await fs.readFile(dataFile + '.lock', 'utf8'), owner, 'only the marker\'s holder may unlink');
    assert.ok(JSON.parse(await fs.readFile(dataFile + '.lock.reclaim', 'utf8')).token === 'live');
  } finally {
    await fs.rm(dir, { recursive: true, force: true });
  }
});

test('a reclaim marker left by a dead reclaimer is cleared, and the dead owner is then reclaimed', async () => {
  const dir = await tmpDir();
  try {
    const dataFile = path.join(dir, 'store.json');
    const pid = await deadPid();
    await fs.writeFile(dataFile + '.lock', JSON.stringify({ pid, ts: Date.now(), token: 'dead' }));
    await fs.writeFile(dataFile + '.lock.reclaim', JSON.stringify({ pid, ts: Date.now(), token: 'dead-reclaimer' }));
    let ran = false;
    await withLock(dataFile, async () => { ran = true; });
    assert.ok(ran);
    assert.deepEqual(await fs.readdir(dir), [], 'lock and marker both gone');
  } finally {
    await fs.rm(dir, { recursive: true, force: true });
  }
});

test('two waiters reclaiming one dead owner: the later reclaim never deletes the earlier one\'s fresh lock', async () => {
  const dir = await tmpDir();
  try {
    const dataFile = path.join(dir, 'store.json');
    const lockPath = dataFile + '.lock';
    await fs.writeFile(lockPath, JSON.stringify({ pid: await deadPid(), ts: Date.now(), token: 'dead' }));
    const gate = () => { let open; const p = new Promise((r) => { open = r; }); return { p, open }; };
    const bothJudged = gate();
    const aInside = gate();
    const bReclaimed = gate();
    let judged = 0;
    const judge = () => { if (++judged === 2) bothJudged.open(); };
    let inside = 0;
    let maxInside = 0;
    let lockWhileBReclaimed;
    const a = withLock(dataFile, async () => {
      inside++; maxInside = Math.max(maxInside, inside);
      aInside.open();
      await bReclaimed.p;
      lockWhileBReclaimed = await fs.readFile(lockPath, 'utf8').catch(() => null);
      inside--;
    }, { beforeReclaim: async () => { judge(); await bothJudged.p; } });
    const b = withLock(dataFile, async () => {
      inside++; maxInside = Math.max(maxInside, inside);
      inside--;
    }, {
      // B judged the same dead owner, and reclaims only once A is inside fn.
      beforeReclaim: async () => { judge(); await bothJudged.p; await aInside.p; },
      afterReclaim: async () => { bReclaimed.open(); },
    });
    await Promise.all([a, b]);
    assert.equal(maxInside, 1, 'never two in fn at once');
    assert.ok(lockWhileBReclaimed !== null, 'A\'s lock survived B\'s reclaim');
    assert.notEqual(JSON.parse(lockWhileBReclaimed).token, 'dead');
  } finally {
    await fs.rm(dir, { recursive: true, force: true });
  }
});
