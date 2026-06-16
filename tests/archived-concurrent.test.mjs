// Tests for cross-process safety of archivedSessions.js.
// The core bug: during a hot restart the old process fires markArchived()
// fire-and-forget while the new process boots and calls sweepPendingTempCleanup
// — two independent writeChains racing on the same file, last-writer-wins.
// The fix: a cross-process O_EXCL lockfile around each mutation, with a strict
// re-read under the lock so stale/empty loads never clobber live data.

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
const tmp = await fs.mkdtemp(path.join(os.tmpdir(), 'cc-arc-conc-'));
process.env.PROJECTS_ROOT = path.join(tmp, 'projects');

const { markArchived, unmarkArchived, loadAllArchived } =
  await import('../src/archivedSessions.js');

after(async () => {
  await fs.rm(tmp, { recursive: true, force: true });
});

function storeFile() {
  return path.join(process.env.PROJECTS_ROOT, '.code-conductor', 'archived-sessions.json');
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

test('concurrent within-process markArchived preserves all entries', async () => {
  await fs.rm(storeFile(), { force: true });

  const ids = Array.from({ length: 10 }, (_, i) => `wp-${i}`);
  await Promise.all(ids.map(id => markArchived(id)));

  const set = await loadAllArchived();
  assert.equal(set.size, 10, 'all 10 concurrent writes should survive');
  for (const id of ids) assert.ok(set.has(id), `missing: ${id}`);

  await fs.rm(storeFile(), { force: true });
});

// ── Test 2: interleaved mark + unmark — other entries must not be clobbered ──

test('unmarkArchived under concurrent writes does not clobber other entries', async () => {
  await fs.rm(storeFile(), { force: true });

  const toKeep = ['keep-1', 'keep-2', 'keep-3'];
  const toRemove = 'to-remove';
  await Promise.all([...toKeep, toRemove].map(id => markArchived(id)));

  // Concurrently remove one entry while adding new ones
  const extra = ['extra-1', 'extra-2'];
  await Promise.all([
    unmarkArchived(toRemove),
    ...extra.map(id => markArchived(id)),
  ]);

  const set = await loadAllArchived();
  assert.ok(!set.has(toRemove), 'removed entry must be gone');
  for (const id of [...toKeep, ...extra]) {
    assert.ok(set.has(id), `expected ${id} in set; got [${[...set].join(', ')}]`);
  }

  await fs.rm(storeFile(), { force: true });
});

// ── Test 3: two concurrent child processes — the actual hot-restart race ─────

test('two concurrent child processes both markArchived → all entries preserved', { timeout: 30000 }, async () => {
  const xTmp = await fs.mkdtemp(path.join(os.tmpdir(), 'cc-arc-xproc-'));
  const xRoot = path.join(xTmp, 'projects');

  // Worker script: sets PROJECTS_ROOT from env, imports archivedSessions.js
  // via absolute path (relative imports inside the module still resolve
  // from the module's own location in src/), marks each argv session ID.
  const workerPath = path.join(xTmp, 'worker.mjs');
  const archivedMod = JSON.stringify('file://' + path.join(srcDir, 'archivedSessions.js'));
  await fs.writeFile(workerPath, [
    `const { markArchived } = await import(${archivedMod});`,
    `for (const id of process.argv.slice(2)) { await markArchived(id); }`,
  ].join('\n'));

  const idsA = ['pa-1', 'pa-2', 'pa-3', 'pa-4', 'pa-5'];
  const idsB = ['pb-1', 'pb-2', 'pb-3', 'pb-4', 'pb-5'];

  const env = { ...process.env, PROJECTS_ROOT: xRoot };
  const p1 = spawn(process.execPath, [workerPath, ...idsA], { env, stdio: 'inherit' });
  const p2 = spawn(process.execPath, [workerPath, ...idsB], { env, stdio: 'inherit' });

  await Promise.all([waitForExit(p1), waitForExit(p2)]);

  // Read the file directly (can't reuse the cached module with a different root)
  const archivedFile = path.join(xRoot, '.code-conductor', 'archived-sessions.json');
  const { sessions } = JSON.parse(await fs.readFile(archivedFile, 'utf8'));
  const got = new Set(sessions);

  for (const id of [...idsA, ...idsB]) {
    assert.ok(got.has(id), `missing ${id}; got [${[...got].join(', ')}]`);
  }
  assert.equal(got.size, 10, 'no entries should be lost or duplicated');

  await fs.rm(xTmp, { recursive: true, force: true });
});

// ── Test 4: stale lock file is detected and cleared ──────────────────────────

test('stale lock file does not block markArchived', async () => {
  await fs.rm(storeFile(), { force: true });
  await fs.rm(lockFile(), { force: true });
  await fs.mkdir(path.dirname(lockFile()), { recursive: true });

  // Stale: timestamp 20 s in the past (threshold is 10 s), unreachable PID
  await fs.writeFile(lockFile(), JSON.stringify({ pid: 999_999_999, ts: Date.now() - 20_000 }));

  await markArchived('stale-test-sid');

  const set = await loadAllArchived();
  assert.ok(set.has('stale-test-sid'), 'entry written despite stale lock');

  // Lock file released (cleaned up by the normal finally path after acquisition)
  await assert.rejects(
    fs.access(lockFile()),
    { code: 'ENOENT' },
    'lock file should have been removed after acquisition',
  );

  await fs.rm(storeFile(), { force: true });
});
