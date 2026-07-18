// Migration 0018: reshape the session-backends sidecar from the set form
// {sessions:[sid,…]} (0017's output) to the map form {sessions:{sid: model|null}}.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { promises as fs } from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import * as m0018 from '../migrations/0018-session-backends-carry-model.mjs';

async function mkTmp() { return fs.mkdtemp(path.join(os.tmpdir(), 'cc-mig18-')); }
function sidecarFile(root) { return path.join(root, '.code-conductor', 'session-backends.json'); }
async function writeJson(file, obj) { await fs.mkdir(path.dirname(file), { recursive: true }); await fs.writeFile(file, JSON.stringify(obj, null, 2)); }
async function readJson(file) { return JSON.parse(await fs.readFile(file, 'utf8')); }

test('set form → map with null tags (key-sorted); idempotent', async () => {
  const root = await mkTmp();
  await writeJson(sidecarFile(root), { sessions: ['sid-b', 'sid-a'] });

  const res = await m0018.run({ root, log: () => {} });
  assert.equal(res.applied, true);
  assert.deepEqual(res.summary, { sessions: 2 });

  const sc = await readJson(sidecarFile(root));
  assert.deepEqual(sc, { sessions: { 'sid-a': null, 'sid-b': null } });
  assert.deepEqual(Object.keys(sc.sessions), ['sid-a', 'sid-b']); // sorted

  // Idempotent — second run sees the map form and no-ops.
  const res2 = await m0018.run({ root, log: () => {} });
  assert.equal(res2.applied, false);

  await fs.rm(root, { recursive: true, force: true });
});

test('already map form → no-op (preserves tags)', async () => {
  const root = await mkTmp();
  await writeJson(sidecarFile(root), { sessions: { 'sid-a': 'deepseek-v4-flash:cloud' } });
  const res = await m0018.run({ root, log: () => {} });
  assert.equal(res.applied, false);
  const sc = await readJson(sidecarFile(root));
  assert.deepEqual(sc, { sessions: { 'sid-a': 'deepseek-v4-flash:cloud' } });
  await fs.rm(root, { recursive: true, force: true });
});

test('absent sidecar → no-op', async () => {
  const root = await mkTmp();
  const res = await m0018.run({ root, log: () => {} });
  assert.equal(res.applied, false);
  await fs.rm(root, { recursive: true, force: true });
});
