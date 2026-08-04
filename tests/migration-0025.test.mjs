// Migration 0025: pin an existing install's per-tier / per-role default effort to
// today's behaviour before the new Settings → Models controls could move it —
// tiers to an explicit 'high' (the pre-feature DEFAULT_EFFORT), roles to an
// explicit 'inherit' (which resolves THROUGH those pinned tiers, so migrated
// installs keep following a tier's effort exactly like fresh ones do).

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { promises as fs } from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import * as m0025 from '../migrations/0025-seed-explicit-tier-role-effort.mjs';
import { getTierEffort, getRoleEffort, resolveSpawnEffort } from '../src/appSettings.js';
import { DEFAULT_EFFORT } from '../src/effortLevels.ts';

async function mkTmp() { return fs.mkdtemp(path.join(os.tmpdir(), 'cc-mig25-')); }
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

test('seeds every tier at high and every known role at inherit; idempotent', async () => {
  const root = await mkTmp();
  await writeJson(settingsFile(root), {
    transcribe: { model: 'ggml-small.en-q5_1.bin' },   // untouched neighbour
    models: {
      tierBackend: { balanced: { backend: 'claude', model: 'claude-sonnet-5' } },
      roleBackend: {
        conductor: { kind: 'tier', tier: 'powerful' },
        'p/scribe': { backend: 'claude', model: 'claude-haiku-4-5' }, // plugin override
      },
      customRoles: ['Tester'],
    },
  });

  const res = await m0025.run({ root, log: () => {} });
  assert.equal(res.applied, true);
  assert.equal(res.summary.tiers, 4);
  // conductor + reviewer (built-ins) + p/scribe (stored override) + Tester (custom).
  assert.equal(res.summary.roles, 4);

  const after = await readJson(settingsFile(root));
  assert.deepEqual(after.models.tierEffort,
    { fast: 'high', balanced: 'high', powerful: 'high', frontier: 'high' },
    'tiers pinned to the pre-feature effort, explicitly');
  assert.deepEqual(after.models.roleEffort, {
    conductor: 'inherit', reviewer: 'inherit', 'p/scribe': 'inherit', Tester: 'inherit',
  }, "roles pinned to 'inherit' — NOT to 'high', which would freeze them out of tier inheritance");
  // Nothing else was disturbed.
  assert.deepEqual(after.models.tierBackend, { balanced: { backend: 'claude', model: 'claude-sonnet-5' } });
  assert.deepEqual(after.models.customRoles, ['Tester']);
  assert.equal(after.transcribe.model, 'ggml-small.en-q5_1.bin');

  const res2 = await m0025.run({ root, log: () => {} });
  assert.equal(res2.applied, false, 'second run is a fast no-op');

  await fs.rm(root, { recursive: true, force: true });
});

test('a migrated store still resolves the pre-feature effort everywhere', async () => {
  const root = await mkTmp();
  await writeJson(settingsFile(root), {
    models: { tierBackend: { fast: { backend: 'claude', model: 'claude-haiku-4-5' } } },
  });
  await m0025.run({ root, log: () => {} });

  // Read the migrated file through the REAL store readers: the guarantee is
  // "no silent effort change", so every tier and role must still resolve 'high'.
  await withEnv({ PROJECTS_ROOT: root }, async () => {
    for (const tier of ['fast', 'balanced', 'powerful', 'frontier']) {
      assert.equal(getTierEffort(tier), DEFAULT_EFFORT);
      assert.equal(resolveSpawnEffort({ tier }), DEFAULT_EFFORT);
    }
    for (const role of ['conductor', 'reviewer']) {
      assert.equal(getRoleEffort(role), 'inherit');
      assert.equal(resolveSpawnEffort({ role }), DEFAULT_EFFORT);
    }
  });

  await fs.rm(root, { recursive: true, force: true });
});

test('no-op when settings.json has no models namespace — never invents one', async () => {
  const root = await mkTmp();
  await writeJson(settingsFile(root), { transcribe: { model: 'x.bin' } });
  const before = await fs.readFile(settingsFile(root), 'utf8');

  const res = await m0025.run({ root, log: () => {} });
  assert.equal(res.applied, false);
  assert.equal(await fs.readFile(settingsFile(root), 'utf8'), before, 'file byte-unchanged');

  await fs.rm(root, { recursive: true, force: true });
});

test('no-op when there is no settings.json at all (fresh install)', async () => {
  const root = await mkTmp();
  const res = await m0025.run({ root, log: () => {} });
  assert.equal(res.applied, false);
  assert.equal(await fs.access(settingsFile(root)).then(() => true, () => false), false,
    'no settings file is created');
  await fs.rm(root, { recursive: true, force: true });
});

test('no-op when tierEffort already exists, even partially — never clobbers user values', async () => {
  const root = await mkTmp();
  await writeJson(settingsFile(root), {
    models: { tierEffort: { frontier: 'max' }, roleEffort: { conductor: 'low' } },
  });

  const res = await m0025.run({ root, log: () => {} });
  assert.equal(res.applied, false);
  const after = await readJson(settingsFile(root));
  assert.deepEqual(after.models.tierEffort, { frontier: 'max' }, 'partial map left alone');
  assert.deepEqual(after.models.roleEffort, { conductor: 'low' });

  await fs.rm(root, { recursive: true, force: true });
});
