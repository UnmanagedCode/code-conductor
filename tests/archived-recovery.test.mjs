// Tests for the archived-sessions store's data-loss hardening.
//
// Bug: `<store>/archived-sessions.json` periodically reset to empty (every
// session un-archived) on a host that OOM-kills / hot-restarts and hits
// low disk. The store is atomic + lock-protected, so a torn write of the
// file itself wasn't the cause — the fragility was: a missing/corrupt read
// silently became an empty set, and a drain-to-empty *unlinked* the only copy
// with no backup. These tests cover the hardening:
//   - rolling `.bak` (last non-empty snapshot, refreshed under the lock)
//   - missing primary → recover from `.bak`; missing primary AND `.bak` = empty
//   - corrupt primary → quarantined to `.corrupt-*` (mutation path) + recovered
//   - drain-to-empty writes `{"sessions":[]}` atomically (never unlink)
//   - only a genuine unrecoverable I/O error aborts a mutation

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { promises as fs } from 'node:fs';
import os from 'node:os';
import path from 'node:path';

// Set a base PROJECTS_ROOT before importing (orchStoreRoot reads the env live,
// so each test can point it at a fresh subdir for isolation).
const tmp = await fs.mkdtemp(path.join(os.tmpdir(), 'cc-arc-rec-'));
process.env.PROJECTS_ROOT = path.join(tmp, 'projects');

const { loadAllArchived, markArchived, unmarkArchived, isArchived } =
  await import('../src/archivedSessions.js');

let testNo = 0;
// Give each test its own store dir so the module-global writeChain + the
// on-disk primary/backup start clean.
async function freshRoot() {
  const root = path.join(tmp, `root-${testNo++}`);
  await fs.mkdir(path.join(root, '.code-conductor'), { recursive: true });
  process.env.PROJECTS_ROOT = root;
  return root;
}
const storeFile = (root) => path.join(root, '.code-conductor', 'archived-sessions.json');
const bakFile = (root) => storeFile(root) + '.bak';
async function readJson(f) { return JSON.parse(await fs.readFile(f, 'utf8')); }
async function listCorrupt(root) {
  const dir = path.join(root, '.code-conductor');
  return (await fs.readdir(dir)).filter(n => n.includes('.corrupt-'));
}
const doc = (...ids) => JSON.stringify({ sessions: ids });

test('corrupt primary is quarantined and recovered from backup on mutation', async () => {
  const root = await freshRoot();
  await fs.writeFile(bakFile(root), doc('a', 'b'));
  await fs.writeFile(storeFile(root), '{ "sessions": [ "a", "b"  '); // truncated/corrupt

  // A mutation recovers a,b from the backup, adds c, and self-heals the primary.
  await markArchived('c');

  const set = await loadAllArchived();
  assert.deepEqual([...set].sort(), ['a', 'b', 'c']);
  assert.deepEqual((await readJson(storeFile(root))).sessions.sort(), ['a', 'b', 'c']);
  const quarantined = await listCorrupt(root);
  assert.equal(quarantined.length, 1, 'corrupt primary should be set aside as .corrupt-*');
});

test('read path serves the backup on a corrupt primary without quarantining', async () => {
  const root = await freshRoot();
  await fs.writeFile(bakFile(root), doc('a', 'b'));
  const corrupt = '{ "sessions": [ "a", "b"  ';
  await fs.writeFile(storeFile(root), corrupt);

  const set = await loadAllArchived();
  assert.deepEqual([...set].sort(), ['a', 'b'], 'read recovers from backup');
  // Read path must not mutate the filesystem.
  assert.equal((await listCorrupt(root)).length, 0, 'read path must not quarantine');
  assert.equal(await fs.readFile(storeFile(root), 'utf8'), corrupt, 'primary left untouched by a read');
});

test('missing primary recovers from backup (ENOENT with backup)', async () => {
  const root = await freshRoot();
  await fs.writeFile(bakFile(root), doc('a', 'b'));
  // no primary written

  assert.equal(await isArchived('a'), true, 'isArchived recovers via backup');
  await markArchived('c');
  assert.deepEqual((await readJson(storeFile(root))).sessions.sort(), ['a', 'b', 'c']);
});

test('missing primary AND backup is a legitimately empty store', async () => {
  const root = await freshRoot();
  const set = await loadAllArchived();
  assert.equal(set.size, 0);

  await markArchived('only');
  assert.deepEqual((await readJson(storeFile(root))).sessions, ['only']);
  assert.deepEqual((await readJson(bakFile(root))).sessions, ['only']);
  assert.equal((await listCorrupt(root)).length, 0, 'a genuine empty store never quarantines');
});

test('drain-to-empty writes {"sessions":[]} atomically and keeps a recoverable backup', async () => {
  const root = await freshRoot();
  await markArchived('a');
  await unmarkArchived('a'); // drains the last entry

  // Primary still exists as an explicit empty doc — never unlinked.
  const primary = await readJson(storeFile(root));
  assert.deepEqual(primary.sessions, [], 'empty primary is an explicit {"sessions":[]}');
  assert.equal((await loadAllArchived()).size, 0, 'empty store reads as empty');

  // Backup retains the last non-empty snapshot.
  assert.deepEqual((await readJson(bakFile(root))).sessions, ['a']);

  // Simulate external loss of the primary → recover the pre-drain snapshot from
  // the backup (recoverable-data preference: never a false wipe).
  await fs.rm(storeFile(root), { force: true });
  assert.deepEqual([...await loadAllArchived()], ['a'], 'external primary loss recovers from backup');
});

test('a stray orphan .tmp (crash mid-write) does not affect reads or writes', async () => {
  const root = await freshRoot();
  await markArchived('a'); // valid primary + backup
  // A crash between writeFile(tmp) and rename leaves an orphan tmp; only rename
  // ever makes a file the primary, so the orphan must be inert.
  await fs.writeFile(storeFile(root) + '.tmp-99999-123', 'garbage not json');

  assert.deepEqual([...await loadAllArchived()], ['a'], 'orphan tmp ignored on read');
  await markArchived('b');
  assert.deepEqual((await readJson(storeFile(root))).sessions.sort(), ['a', 'b']);
});

test('unrecoverable I/O error on the primary aborts the mutation (does not wipe)', async () => {
  const root = await freshRoot();
  await markArchived('a');
  await markArchived('b');
  // Make the primary a directory so readFile fails with EISDIR (a non-ENOENT
  // I/O error) — the strict loader must throw rather than treat it as empty.
  await fs.rm(storeFile(root), { force: true });
  await fs.mkdir(storeFile(root));

  await assert.rejects(markArchived('c'), 'mutation aborts on unrecoverable read error');
  // Backup (the real data) is untouched.
  assert.deepEqual((await readJson(bakFile(root))).sessions.sort(), ['a', 'b']);
  await fs.rm(storeFile(root), { recursive: true, force: true });
});
