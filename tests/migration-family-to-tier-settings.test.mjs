// Unit tests for migration 0016 (rewrite family-scoped `models.enabledFamilies`
// / `models.defaultFamily` keys in settings.json to the tier-scoped
// `models.enabledTiers` / `models.defaultTier` shape, seed `models.tierBackend`
// to the default binding, then delete the legacy keys). Verifies both
// migration branches, the tierBackend seed, the no-op probes, and idempotency.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { promises as fs } from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import * as m0016 from '../migrations/0016-migrate-family-settings-to-tiers.mjs';

async function mkTmp() {
  return fs.mkdtemp(path.join(os.tmpdir(), 'cc-family-tier-settings-'));
}

async function writeSettings(root, obj) {
  const file = path.join(root, '.code-conductor', 'settings.json');
  await fs.mkdir(path.dirname(file), { recursive: true });
  await fs.writeFile(file, JSON.stringify(obj, null, 2) + '\n');
  return file;
}

async function readSettings(root) {
  const file = path.join(root, '.code-conductor', 'settings.json');
  return JSON.parse(await fs.readFile(file, 'utf8'));
}

test('no-op when settings.json does not exist', async () => {
  const root = await mkTmp();
  const res = await m0016.run({ root, log: () => {} });
  assert.equal(res.applied, false);
});

test('no-op when neither legacy key is present', async () => {
  const root = await mkTmp();
  await writeSettings(root, { models: { onOverage: 'stop' } });
  const res = await m0016.run({ root, log: () => {} });
  assert.equal(res.applied, false);
});

test('enabledFamilies present → mapped to enabledTiers via haiku:fast/sonnet:balanced/opus:powerful/fable:frontier, legacy key removed', async () => {
  const root = await mkTmp();
  await writeSettings(root, { models: { enabledFamilies: { fable: false, opus: true, sonnet: true, haiku: true } } });
  const res = await m0016.run({ root, log: () => {} });
  assert.equal(res.applied, true);
  assert.equal(res.summary.migratedEnabled, true);
  const settings = await readSettings(root);
  assert.deepEqual(settings.models.enabledTiers, { fast: true, balanced: true, powerful: true, frontier: false });
  assert.ok(!('enabledFamilies' in settings.models));
});

test('defaultFamily present → mapped to defaultTier via the same table, legacy key removed', async () => {
  const root = await mkTmp();
  await writeSettings(root, { models: { defaultFamily: 'fable' } });
  const res = await m0016.run({ root, log: () => {} });
  assert.equal(res.applied, true);
  assert.equal(res.summary.migratedDefault, true);
  const settings = await readSettings(root);
  assert.equal(settings.models.defaultTier, 'frontier');
  assert.ok(!('defaultFamily' in settings.models));
});

test('an invalid legacy defaultFamily falls back to "powerful"', async () => {
  const root = await mkTmp();
  await writeSettings(root, { models: { defaultFamily: 'not-a-family' } });
  const res = await m0016.run({ root, log: () => {} });
  assert.equal(res.applied, true);
  const settings = await readSettings(root);
  assert.equal(settings.models.defaultTier, 'powerful');
});

test('tierBackend is seeded to the default binding when absent', async () => {
  const root = await mkTmp();
  await writeSettings(root, { models: { defaultFamily: 'opus' } });
  const res = await m0016.run({ root, log: () => {} });
  assert.equal(res.applied, true);
  const settings = await readSettings(root);
  assert.deepEqual(settings.models.tierBackend, { fast: 'haiku', balanced: 'sonnet', powerful: 'opus', frontier: 'fable' });
});

test('per-backend model versions and unrelated model prefs are untouched', async () => {
  const root = await mkTmp();
  await writeSettings(root, {
    models: {
      sonnet: 'claude-sonnet-4-5', onOverage: 'stop', sonnetContextWindow: '200k',
      enabledFamilies: { fable: true, opus: true, sonnet: true, haiku: true },
      defaultFamily: 'sonnet',
    },
  });
  const res = await m0016.run({ root, log: () => {} });
  assert.equal(res.applied, true);
  const settings = await readSettings(root);
  assert.equal(settings.models.sonnet, 'claude-sonnet-4-5');
  assert.equal(settings.models.onOverage, 'stop');
  assert.equal(settings.models.sonnetContextWindow, '200k');
  assert.equal(settings.models.defaultTier, 'balanced');
});

test('idempotent: second run is a no-op', async () => {
  const root = await mkTmp();
  await writeSettings(root, {
    models: {
      enabledFamilies: { fable: false, opus: true, sonnet: true, haiku: true },
      defaultFamily: 'opus',
    },
  });
  const res1 = await m0016.run({ root, log: () => {} });
  assert.equal(res1.applied, true);
  const res2 = await m0016.run({ root, log: () => {} });
  assert.equal(res2.applied, false);
});
