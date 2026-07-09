// Tests for cross-process safety of tempSessions.js.
// The core bug: during a hot restart the old process fires unmarkTemp()
// fire-and-forget while the new process boots and marks fresh temps — two
// independent writeChains racing on the same file, last-writer-wins. On top
// of that, the old non-strict load returned an empty Set on any transient
// read error, so a bad read wiped the whole file on the next write.
// The fix: a cross-process O_EXCL lockfile around each mutation, with a
// strict re-read under the lock so stale/corrupt/empty loads never clobber
// live data. Mirrors tests/archived-concurrent.test.mjs.

import { test, after } from 'node:test';
import assert from 'node:assert/strict';
import { promises as fs } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { spawn } from 'node:child_process';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const srcDir = path.join(__dirname, '..', 'src');

// Isolate within-process tests under a single tmp PROJECTS_ROOT. The module
// is cached after the first import, so PROJECTS_ROOT must be set first.
const tmp = await fs.mkdtemp(path.join(os.tmpdir(), 'cc-temp-conc-'));
process.env.PROJECTS_ROOT = path.join(tmp, 'projects');

const { markTemp, unmarkTemp, loadAllTemps } =
  await import('../src/tempSessions.js');

after(async () => {
  await fs.rm(tmp, { recursive: true, force: true });
});

function storeFile() {
  return path.join(process.env.PROJECTS_ROOT, '.code-conductor', 'temp-sessions.json');
}
function lockFile() {
  return storeFile() + '.lock';
}

function waitForExit(proc) {
  return new Promise((resolve, reject) => {
    proc.on('exit', code => {
      if (code === 0) resolve();
      else reject(new Error(`Worker exited with code ${code}`));
    });
    proc.on('error', reject);
  });
}

// ── Test 1: within-process concurrent writes ─────────────────────────────────

test('concurrent within-process markTemp preserves all entries', async () => {
  await fs.rm(storeFile(), { force: true });

  const ids = Array.from({ length: 10 }, (_, i) => `wp-${i}`);
  await Promise.all(ids.map(id => markTemp(id)));

  const set = await loadAllTemps();
  assert.equal(set.size, 10, 'all 10 concurrent writes should survive');
  for (const id of ids) assert.ok(set.has(id), `missing: ${id}`);

  await fs.rm(storeFile(), { force: true });
});

// ── Test 2: interleaved mark + unmark — other entries must not be clobbered ──

test('unmarkTemp under concurrent writes does not clobber other entries', async () => {
  await fs.rm(storeFile(), { force: true });

  const toKeep = ['keep-1', 'keep-2', 'keep-3'];
  const toRemove = 'to-remove';
  await Promise.all([...toKeep, toRemove].map(id => markTemp(id)));

  // Concurrently remove one entry while adding new ones
  const extra = ['extra-1', 'extra-2'];
  await Promise.all([
    unmarkTemp(toRemove),
    ...extra.map(id => markTemp(id)),
  ]);

  const set = await loadAllTemps();
  assert.ok(!set.has(toRemove), 'removed entry must be gone');
  for (const id of [...toKeep, ...extra]) {
    assert.ok(set.has(id), `expected ${id} in set; got [${[...set].join(', ')}]`);
  }

  await fs.rm(storeFile(), { force: true });
});

// ── Test 3: two concurrent child processes — the actual hot-restart race ─────

test('two concurrent child processes both markTemp → all entries preserved', { timeout: 30000 }, async () => {
  const xTmp = await fs.mkdtemp(path.join(os.tmpdir(), 'cc-temp-xproc-'));
  const xRoot = path.join(xTmp, 'projects');

  // Worker script: sets PROJECTS_ROOT from env, imports tempSessions.js via
  // absolute path (relative imports inside the module still resolve from
  // the module's own location in src/), marks each argv session ID.
  const workerPath = path.join(xTmp, 'worker.mjs');
  const tempMod = JSON.stringify('file://' + path.join(srcDir, 'tempSessions.js'));
  await fs.writeFile(workerPath, [
    `const { markTemp } = await import(${tempMod});`,
    `for (const id of process.argv.slice(2)) { await markTemp(id); }`,
  ].join('\n'));

  const idsA = ['pa-1', 'pa-2', 'pa-3', 'pa-4', 'pa-5'];
  const idsB = ['pb-1', 'pb-2', 'pb-3', 'pb-4', 'pb-5'];

  const env = { ...process.env, PROJECTS_ROOT: xRoot };
  const p1 = spawn(process.execPath, [workerPath, ...idsA], { env, stdio: 'inherit' });
  const p2 = spawn(process.execPath, [workerPath, ...idsB], { env, stdio: 'inherit' });

  await Promise.all([waitForExit(p1), waitForExit(p2)]);

  // Read the file directly (can't reuse the cached module with a different root)
  const tempFile = path.join(xRoot, '.code-conductor', 'temp-sessions.json');
  const { sessions } = JSON.parse(await fs.readFile(tempFile, 'utf8'));
  const got = new Set(sessions);

  for (const id of [...idsA, ...idsB]) {
    assert.ok(got.has(id), `missing ${id}; got [${[...got].join(', ')}]`);
  }
  assert.equal(got.size, 10, 'no entries should be lost or duplicated');

  await fs.rm(xTmp, { recursive: true, force: true });
});

// ── Test 4: stale lock file is detected and cleared ──────────────────────────

test('stale lock file does not block markTemp', async () => {
  await fs.rm(storeFile(), { force: true });
  await fs.rm(lockFile(), { force: true });
  await fs.mkdir(path.dirname(lockFile()), { recursive: true });

  // Stale: unreachable PID, so it must be reclaimed regardless of age.
  await fs.writeFile(lockFile(), JSON.stringify({ pid: 999_999_999, ts: Date.now() - 20_000 }));

  await markTemp('stale-test-sid');

  const set = await loadAllTemps();
  assert.ok(set.has('stale-test-sid'), 'entry written despite stale lock');

  // Lock file released (cleaned up by the normal finally path after acquisition)
  await assert.rejects(
    fs.access(lockFile()),
    { code: 'ENOENT' },
    'lock file should have been removed after acquisition',
  );

  await fs.rm(storeFile(), { force: true });
});

// ── Test 5: corrupt on-disk file aborts the mutation instead of wiping it ────

test('corrupt temp-sessions.json aborts markTemp instead of silently wiping entries', async () => {
  await fs.rm(storeFile(), { force: true });

  // Seed valid entries the corrupt read must not clobber.
  await markTemp('seed-1');
  await markTemp('seed-2');

  // Corrupt the file directly (simulates a torn/partial write).
  await fs.writeFile(storeFile(), '{not valid json');

  await assert.rejects(
    markTemp('new-id'),
    'markTemp must reject on corrupt JSON rather than overwrite the store',
  );

  // The corrupt file must be left untouched — no overwrite happened.
  const raw = await fs.readFile(storeFile(), 'utf8');
  assert.equal(raw, '{not valid json', 'corrupt file must not be overwritten by the aborted mutation');

  // Restore valid JSON; subsequent mutations must recover normally, keeping
  // the seed entries alongside the new one.
  await fs.writeFile(storeFile(), JSON.stringify({ sessions: ['seed-1', 'seed-2'] }));
  await markTemp('new-id');

  const set = await loadAllTemps();
  assert.ok(set.has('seed-1'), 'seed-1 preserved after recovery');
  assert.ok(set.has('seed-2'), 'seed-2 preserved after recovery');
  assert.ok(set.has('new-id'), 'new-id added after recovery');
  assert.equal(set.size, 3);

  await fs.rm(storeFile(), { force: true });
});
