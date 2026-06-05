// Unit tests for migration 0005 (rename the durable worker-session marker
// sidecar conductor-sessions.json → conducted-sessions.json). Verifies the
// rename branch, the union-merge branch (both files present), and idempotency.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { promises as fs } from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import * as m0005 from '../migrations/0005-rename-conducted-marker.mjs';

async function mkTmp() {
  return fs.mkdtemp(path.join(os.tmpdir(), 'cc-rename-conducted-'));
}

async function exists(p) {
  try { await fs.lstat(p); return true; } catch { return false; }
}

async function writeSet(file, sessions) {
  await fs.mkdir(path.dirname(file), { recursive: true });
  await fs.writeFile(file, JSON.stringify({ sessions }, null, 2) + '\n');
}

async function readSessions(file) {
  return JSON.parse(await fs.readFile(file, 'utf8')).sessions;
}

test('renames legacy conductor-sessions.json → conducted-sessions.json, preserving markers', async () => {
  const root = await mkTmp();
  const store = path.join(root, '.code-conductor');
  const oldFile = path.join(store, 'conductor-sessions.json');
  const newFile = path.join(store, 'conducted-sessions.json');
  await writeSet(oldFile, ['sid-a', 'sid-b']);

  const res = await m0005.run({ root, log: () => {} });
  assert.equal(res.applied, true);
  assert.deepEqual(res.summary, { renamed: true });
  assert.equal(await exists(oldFile), false, 'old file removed');
  assert.deepEqual(await readSessions(newFile), ['sid-a', 'sid-b'], 'markers survive the rename');
});

test('unions both sets when a new file already exists (no marker lost)', async () => {
  const root = await mkTmp();
  const store = path.join(root, '.code-conductor');
  const oldFile = path.join(store, 'conductor-sessions.json');
  const newFile = path.join(store, 'conducted-sessions.json');
  await writeSet(oldFile, ['sid-a', 'sid-shared']);
  await writeSet(newFile, ['sid-shared', 'sid-c']);

  const res = await m0005.run({ root, log: () => {} });
  assert.equal(res.applied, true);
  assert.equal(res.summary.merged, 3, 'union de-dups the shared sid');
  assert.equal(await exists(oldFile), false, 'old file removed after merge');
  assert.deepEqual(await readSessions(newFile), ['sid-a', 'sid-c', 'sid-shared'], 'sorted union of both sets');
});

test('idempotent no-op when the legacy file is absent', async () => {
  const root = await mkTmp();
  const res = await m0005.run({ root, log: () => {} });
  assert.equal(res.applied, false);

  // Re-running after a successful migration is also a no-op.
  const store = path.join(root, '.code-conductor');
  await writeSet(path.join(store, 'conducted-sessions.json'), ['sid-x']);
  const res2 = await m0005.run({ root, log: () => {} });
  assert.equal(res2.applied, false, 'no legacy file → nothing to do');
});
