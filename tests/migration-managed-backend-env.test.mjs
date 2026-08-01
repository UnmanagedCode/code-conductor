// Unit tests for migration 0024 (drop stored managed-row env overrides from
// models.backends). Managed env is now code-authoritative (empty, from
// MANAGED_BACKENDS), so any persisted {id, env} entry for a managed id is dead
// data this migration strips. Verifies the strip, user-row preservation, and
// idempotency.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { promises as fs } from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import * as m0024 from '../migrations/0024-drop-managed-backend-env-overrides.mjs';

async function mkTmp() {
  return fs.mkdtemp(path.join(os.tmpdir(), 'cc-managed-env-'));
}

async function writeSettings(root, models) {
  const file = path.join(root, '.code-conductor', 'settings.json');
  await fs.mkdir(path.dirname(file), { recursive: true });
  await fs.writeFile(file, JSON.stringify({ models }, null, 2) + '\n');
  return file;
}

async function readBackends(root) {
  const file = path.join(root, '.code-conductor', 'settings.json');
  return JSON.parse(await fs.readFile(file, 'utf8')).models.backends;
}

test('no-op when settings.json does not exist', async () => {
  const root = await mkTmp();
  const res = await m0024.run({ root, log: () => {} });
  assert.equal(res.applied, false);
});

test('no-op when models.backends has no managed entries', async () => {
  const root = await mkTmp();
  const userRow = { id: 'my-proxy', label: 'My Proxy', template: 'proxy {model} --', env: [] };
  await writeSettings(root, { backends: [userRow] });
  const res = await m0024.run({ root, log: () => {} });
  assert.equal(res.applied, false);
  assert.deepEqual(await readBackends(root), [userRow], 'user row untouched');
});

test('strips managed {id, env} overrides, keeps user rows', async () => {
  const root = await mkTmp();
  await writeSettings(root, {
    backends: [
      { id: 'ollama', env: [{ key: 'OLLAMA_HOST', value: 'http://box:11434' }] },
      { id: 'claude', env: [{ key: 'X', value: '1' }] },
      { id: 'my-proxy', label: 'My Proxy', template: 'proxy {model} --', env: [{ key: 'T', value: 'k' }] },
    ],
  });
  const res = await m0024.run({ root, log: () => {} });
  assert.equal(res.applied, true);
  assert.equal(res.summary.dropped, 2);
  assert.deepEqual(await readBackends(root), [
    { id: 'my-proxy', label: 'My Proxy', template: 'proxy {model} --', env: [{ key: 'T', value: 'k' }] },
  ], 'both managed entries dropped, user row survives untouched');
});

test('idempotent: re-running is a no-op', async () => {
  const root = await mkTmp();
  await writeSettings(root, { backends: [{ id: 'ollama', env: [{ key: 'OLLAMA_HOST', value: 'http://box:11434' }] }] });
  await m0024.run({ root, log: () => {} });
  const res2 = await m0024.run({ root, log: () => {} });
  assert.equal(res2.applied, false);
});

test('no-op when models.backends is absent or not an array', async () => {
  const root = await mkTmp();
  await writeSettings(root, { tierBackend: { fast: { backend: 'claude', model: 'haiku' } } });
  const res = await m0024.run({ root, log: () => {} });
  assert.equal(res.applied, false);
});