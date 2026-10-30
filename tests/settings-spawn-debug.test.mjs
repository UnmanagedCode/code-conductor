import { test } from 'node:test';
import assert from 'node:assert/strict';
import { promises as fs } from 'node:fs';
import { bootServer, api } from './helpers.mjs';
import { getDebugByDefault, setDebugByDefault, getTaskToolsEnabled, setTaskToolsEnabled, getTranscribeModel, setTranscribeModel } from '../src/appSettings.ts';
import { mkdtemp } from './tmpRegistry.mjs';

async function mkTmp() {
  return mkdtemp('cc-settings-spawn-');
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
    // Pin a sibling namespace BEFORE touching spawn.debugByDefault, so a
    // future regression that drops the `...cur` spread in setDebugByDefault
    // (clobbering the rest of settings.json) fails this test.
    await setTranscribeModel('base.en-q5_1');
    assert.equal(getDebugByDefault(), false);
    await setDebugByDefault(true);
    assert.equal(getDebugByDefault(), true);
    assert.equal(getTranscribeModel(), 'base.en-q5_1', 'sibling namespace survives the spawn-namespace write');
  } finally {
    if (saved === undefined) delete process.env.PROJECTS_ROOT; else process.env.PROJECTS_ROOT = saved;
    await fs.rm(root, { recursive: true, force: true });
  }
});

test('GET /api/settings/spawn defaults taskTools to false; POST persists it without touching debugByDefault, and vice versa', async () => {
  const { baseUrl, close } = await bootServer();
  try {
    const g0 = await api(baseUrl, 'GET', '/api/settings/spawn');
    assert.equal(g0.body.taskTools, false);
    const on = await api(baseUrl, 'POST', '/api/settings/spawn/prefs', { taskTools: true });
    assert.deepEqual({ t: on.body.taskTools, d: on.body.debugByDefault }, { t: true, d: false });
    assert.equal((await api(baseUrl, 'GET', '/api/settings/spawn')).body.taskTools, true);
    const dbg = await api(baseUrl, 'POST', '/api/settings/spawn/prefs', { debugByDefault: true });
    assert.deepEqual({ t: dbg.body.taskTools, d: dbg.body.debugByDefault }, { t: true, d: true });
    const off = await api(baseUrl, 'POST', '/api/settings/spawn/prefs', { taskTools: false });
    assert.deepEqual({ t: off.body.taskTools, d: off.body.debugByDefault }, { t: false, d: true });
  } finally { await close(); }
});

test('setTaskToolsEnabled round-trips without clobbering spawn.debugByDefault', async () => {
  const root = await mkTmp();
  const saved = process.env.PROJECTS_ROOT;
  process.env.PROJECTS_ROOT = root;
  try {
    await setDebugByDefault(true);
    assert.equal(getTaskToolsEnabled(), false);
    await setTaskToolsEnabled(true);
    assert.equal(getTaskToolsEnabled(), true);
    assert.equal(getDebugByDefault(), true);
  } finally {
    if (saved === undefined) delete process.env.PROJECTS_ROOT; else process.env.PROJECTS_ROOT = saved;
    await fs.rm(root, { recursive: true, force: true });
  }
});
