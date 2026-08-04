// Migration 0023: bump a persisted models.conductorCompactWindowK below the
// new COMPACT_K_MIN (100) up to 100, since a lower value was already a
// silent no-op once it reached the Claude Code CLI's own 100k floor.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { promises as fs } from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import * as m0023 from '../migrations/0023-clamp-compact-window-floor.mjs';
import { getConductorCompactWindow } from '../src/appSettings.ts';

async function mkTmp() { return fs.mkdtemp(path.join(os.tmpdir(), 'cc-mig23-')); }
function settingsFile(root) { return path.join(root, '.code-conductor', 'settings.json'); }
async function writeJson(file, obj) { await fs.mkdir(path.dirname(file), { recursive: true }); await fs.writeFile(file, JSON.stringify(obj, null, 2)); }
async function readJson(file) { return JSON.parse(await fs.readFile(file, 'utf8')); }

async function withEnv(overrides, fn) {
  const keys = Object.keys(overrides);
  const saved = Object.fromEntries(keys.map(k => [k, process.env[k]]));
  for (const k of keys) {
    if (overrides[k] === undefined) delete process.env[k];
    else process.env[k] = overrides[k];
  }
  try { return await fn(); }
  finally {
    for (const k of keys) {
      if (saved[k] === undefined) delete process.env[k];
      else process.env[k] = saved[k];
    }
  }
}

test('bumps a stale sub-100 conductorCompactWindowK to 100, and getConductorCompactWindow reads it back clamped', async () => {
  const root = await mkTmp();
  try {
    await writeJson(settingsFile(root), {
      models: { conductorCompactWindowEnabled: true, conductorCompactWindowK: 50 },
    });

    const res = await m0023.run({ root, log: () => {} });
    assert.equal(res.applied, true);
    assert.deepEqual(res.summary, { from: 50, to: 100 });

    const m = (await readJson(settingsFile(root))).models;
    assert.equal(m.conductorCompactWindowK, 100);

    await withEnv({ PROJECTS_ROOT: root, CLAUDE_CODE_AUTO_COMPACT_WINDOW: undefined }, async () => {
      const cw = getConductorCompactWindow();
      assert.equal(cw.enabled, true);
      assert.equal(cw.value, 100);
    });

    // Idempotent — second run is a no-op.
    const res2 = await m0023.run({ root, log: () => {} });
    assert.equal(res2.applied, false);
  } finally { await fs.rm(root, { recursive: true, force: true }); }
});

test('a value already at or above 100 is left untouched', async () => {
  const root = await mkTmp();
  try {
    await writeJson(settingsFile(root), {
      models: { conductorCompactWindowEnabled: true, conductorCompactWindowK: 400 },
    });

    const res = await m0023.run({ root, log: () => {} });
    assert.equal(res.applied, false);

    const m = (await readJson(settingsFile(root))).models;
    assert.equal(m.conductorCompactWindowK, 400);
  } finally { await fs.rm(root, { recursive: true, force: true }); }
});

test('no-op when the key is absent, or models/settings.json itself is missing', async () => {
  const root = await mkTmp();
  try {
    await writeJson(settingsFile(root), { models: { conductorCompactWindowEnabled: false } });
    assert.equal((await m0023.run({ root, log: () => {} })).applied, false);
  } finally { await fs.rm(root, { recursive: true, force: true }); }

  const emptyRoot = await mkTmp();
  try {
    assert.equal((await m0023.run({ root: emptyRoot, log: () => {} })).applied, false);
  } finally { await fs.rm(emptyRoot, { recursive: true, force: true }); }
});
