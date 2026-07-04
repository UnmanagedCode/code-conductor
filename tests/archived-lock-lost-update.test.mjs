// Regression test for the archived-set subset-loss bug.
//
// Symptom: sessions the user archived silently lose their `archived` flag and
// reappear in the normal list — "most but not all" each time, recurring around
// server restarts. Root cause (src/storeLock.js): the cross-process lock evicted
// a *live but slow* holder on a pure age threshold, letting two writers run the
// read-modify-write concurrently and drop each other's entries (a lost update).
// Under Termux post-restart CPU throttle a live holder is easily starved past
// the old 10 s threshold mid-write; the old + new server overlap during a
// restart is the only window with cross-process contention — hence "recurs
// around restarts."
//
// This test models the storeLock read-modify-write pattern that
// archivedSessions.js uses (strict-load → mutate → atomic write, under withLock)
// with a HOLDER process that acquires the lock, is slow, and whose lock has aged
// past the threshold, while a WAITER process concurrently adds its own entries.
//
//   • FIX (default): live owners are never evicted on age → the waiter waits the
//     holder out → all entries survive. This case FAILS on the pre-fix code
//     (which evicts the aged-but-live lock) and PASSES after the fix.
//   • LEGACY (ORCH_STORE_LOCK_STALE_MS set): age eviction is re-enabled, so the
//     waiter reclaims the live holder's lock and the lost update happens — the
//     entries the losing writer committed are dropped. This reproduces the exact
//     data loss on the current binary.

import { test, after } from 'node:test';
import assert from 'node:assert/strict';
import { promises as fs } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { spawn } from 'node:child_process';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const srcDir = path.join(__dirname, '..', 'src');
const storeLockMod = JSON.stringify('file://' + path.join(srcDir, 'storeLock.js'));

const tmp = await fs.mkdtemp(path.join(os.tmpdir(), 'cc-lock-lu-'));
after(async () => { await fs.rm(tmp, { recursive: true, force: true }); });

// HOLDER: manually plant a lock carrying THIS live process's pid but an aged
// timestamp (simulating a live holder whose lock has aged past a threshold),
// read the data snapshot, signal ready, stall (slow/throttled), then write the
// snapshot back and drop the lock. It does NOT go through acquireLock, so its
// timestamp stays the aged value we plant.
const holderSrc = [
  `import { promises as fs } from 'node:fs';`,
  `const [dataFile, lockFile, readyFile, agedMs, holdMs, ...ids] = process.argv.slice(2);`,
  `const sleep = (ms) => new Promise(r => setTimeout(r, ms));`,
  `async function readItems() { try { return JSON.parse(await fs.readFile(dataFile,'utf8')).items ?? []; } catch { return []; } }`,
  `async function writeItems(items) { const t = dataFile + '.tmp-h'; await fs.writeFile(t, JSON.stringify({items})); await fs.rename(t, dataFile); }`,
  `await fs.writeFile(lockFile, JSON.stringify({ pid: process.pid, ts: Date.now() - Number(agedMs), token: 'holder' }));`,
  `const snapshot = await readItems();`,          // stale snapshot captured while "holding"
  `await fs.writeFile(readyFile, '1');`,          // tell the parent the lock is planted
  `await sleep(Number(holdMs));`,                 // slow holder
  `await writeItems([...snapshot, ...ids]);`,     // commit our snapshot + our ids
  `await fs.unlink(lockFile).catch(() => {});`,   // release
].join('\n');

// WAITER: the real cross-process path — withLock → read-modify-write → write.
const waiterSrc = [
  `import { promises as fs } from 'node:fs';`,
  `const { withLock } = await import(${storeLockMod});`,
  `const [dataFile, readyFile, ...ids] = process.argv.slice(2);`,
  `const sleep = (ms) => new Promise(r => setTimeout(r, ms));`,
  `for (let i = 0; i < 200; i++) { try { await fs.access(readyFile); break; } catch { await sleep(10); } }`,
  `await withLock(dataFile, async () => {`,
  `  let items; try { items = JSON.parse(await fs.readFile(dataFile,'utf8')).items ?? []; } catch { items = []; }`,
  `  items = [...items, ...ids];`,
  `  const t = dataFile + '.tmp-w'; await fs.writeFile(t, JSON.stringify({items})); await fs.rename(t, dataFile);`,
  `});`,
].join('\n');

const holderPath = path.join(tmp, 'holder.mjs');
const waiterPath = path.join(tmp, 'waiter.mjs');
await fs.writeFile(holderPath, holderSrc);
await fs.writeFile(waiterPath, waiterSrc);

function waitExit(proc) {
  return new Promise((resolve, reject) => {
    proc.on('exit', (code) => code === 0 ? resolve() : reject(new Error(`worker exit ${code}`)));
    proc.on('error', reject);
  });
}

// Run one HOLDER + WAITER race. `waiterEnv` lets us flip the storeLock behavior
// (legacy age-eviction) for the WAITER process only.
async function runRace({ waiterEnv = {} } = {}) {
  const dir = await fs.mkdtemp(path.join(tmp, 'race-'));
  const dataFile = path.join(dir, 'store.json');
  const lockFile = dataFile + '.lock';
  const readyFile = path.join(dir, 'ready');

  // Seed a pre-existing archived set — these must never be lost.
  const seed = ['pre-1', 'pre-2', 'pre-3'];
  await fs.writeFile(dataFile, JSON.stringify({ items: seed }));

  const holderIds = ['h-1', 'h-2', 'h-3'];
  const waiterIds = ['w-1', 'w-2', 'w-3'];
  const agedMs = 20_000; // lock looks 20 s old — past the pre-fix 10 s threshold
  const holdMs = 1_200;  // holder is slow while "holding"

  const holder = spawn(process.execPath,
    [holderPath, dataFile, lockFile, readyFile, String(agedMs), String(holdMs), ...holderIds],
    { stdio: 'inherit' });
  const waiter = spawn(process.execPath,
    [waiterPath, dataFile, readyFile, ...waiterIds],
    { stdio: 'inherit', env: { ...process.env, ...waiterEnv } });

  await Promise.all([waitExit(holder), waitExit(waiter)]);

  const { items } = JSON.parse(await fs.readFile(dataFile, 'utf8'));
  return { got: new Set(items), seed, holderIds, waiterIds };
}

// ── The fix: a live-but-slow holder is waited out; no entry is lost. ─────────
// FAILS on pre-fix storeLock.js (evicts the aged-but-live lock → lost update);
// PASSES after the fix (evicts only dead owners).
test('live-but-slow lock holder is never evicted → no lost update', { timeout: 30000 }, async () => {
  const { got, seed, holderIds, waiterIds } = await runRace(); // default env → fix behavior
  for (const id of [...seed, ...holderIds, ...waiterIds]) {
    assert.ok(got.has(id), `entry '${id}' was lost; got [${[...got].join(', ')}]`);
  }
  assert.equal(got.size, seed.length + holderIds.length + waiterIds.length,
    'every entry from both writers plus the pre-existing set must survive');
});

// ── The bug, reproduced on the current binary via the legacy toggle. ─────────
// With age-eviction re-enabled the waiter reclaims the live holder's lock and
// one writer's entries are silently dropped — the exact subset loss.
test('legacy age-eviction reproduces the subset loss (lost update)', { timeout: 30000 }, async () => {
  const { got, seed, holderIds, waiterIds } =
    await runRace({ waiterEnv: { ORCH_STORE_LOCK_STALE_MS: '150' } });
  // The pre-existing set is on disk before either writer runs, so it survives;
  // one of the two concurrent writers' contributions is clobbered.
  for (const id of seed) assert.ok(got.has(id), `pre-existing '${id}' should survive`);
  const holderKept = holderIds.every((id) => got.has(id));
  const waiterKept = waiterIds.every((id) => got.has(id));
  assert.ok(!(holderKept && waiterKept),
    `expected a lost update (one writer's entries dropped); got [${[...got].join(', ')}]`);
});
