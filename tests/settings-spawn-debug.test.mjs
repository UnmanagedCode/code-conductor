import { test } from 'node:test';
import assert from 'node:assert/strict';
import { promises as fs } from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import { bootServer, api } from './helpers.mjs';
import { getDebugByDefault, setDebugByDefault } from '../src/appSettings.js';

async function mkTmp() {
  return fs.mkdtemp(path.join(os.tmpdir(), 'cc-settings-spawn-'));
}

test('GET /api/settings/spawn defaults debugByDefault to false', async () => {
  const { baseUrl, close } = await bootServer();
  try {
    const r = await api(baseUrl, 'GET', '/api/settings/spawn');
    assert.equal(r.status, 200);
    assert.equal(r.body.debugByDefault, false);
  } finally { await close(); }
});

test('POST /api/settings/spawn/prefs persists debugByDefault', async () => {
  const { baseUrl, close } = await bootServer();
  try {
    const post = await api(baseUrl, 'POST', '/api/settings/spawn/prefs', { debugByDefault: true });
    assert.equal(post.status, 200);
    assert.equal(post.body.debugByDefault, true);
    const g = await api(baseUrl, 'GET', '/api/settings/spawn');
    assert.equal(g.body.debugByDefault, true);
    const off = await api(baseUrl, 'POST', '/api/settings/spawn/prefs', { debugByDefault: false });
    assert.equal(off.body.debugByDefault, false);
  } finally { await close(); }
});

test('appSettings getDebugByDefault/setDebugByDefault round-trip without clobbering other namespaces', async () => {
  const root = await mkTmp(); // PROJECTS_ROOT — where settings.json lives
  const saved = process.env.PROJECTS_ROOT;
  process.env.PROJECTS_ROOT = root;
  try {
    assert.equal(getDebugByDefault(), false);
    await setDebugByDefault(true);
    assert.equal(getDebugByDefault(), true);
  } finally {
    if (saved === undefined) delete process.env.PROJECTS_ROOT; else process.env.PROJECTS_ROOT = saved;
    await fs.rm(root, { recursive: true, force: true });
  }
});
