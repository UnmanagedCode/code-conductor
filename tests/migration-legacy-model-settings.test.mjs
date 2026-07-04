// Unit tests for migration 0007 (rewrite legacy `models.autoStopOnOverage`
// / `models.fable5Enabled` keys in settings.json to their current
// equivalents, then delete the legacy keys). Verifies both migration
// branches, the no-op probes, and idempotency.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { promises as fs } from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import * as m0007 from '../migrations/0007-migrate-legacy-model-settings.mjs';

async function mkTmp() {
  return fs.mkdtemp(path.join(os.tmpdir(), 'cc-legacy-settings-'));
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
  const res = await m0007.run({ root, log: () => {} });
  assert.equal(res.applied, false);
});

test('no-op when neither legacy key is present', async () => {
  const root = await mkTmp();
  await writeSettings(root, { models: { onOverage: 'stop' } });
  const res = await m0007.run({ root, log: () => {} });
  assert.equal(res.applied, false);
});

test('autoStopOnOverage:true + onOverage unset → onOverage:"stop", legacy key removed', async () => {
  const root = await mkTmp();
  await writeSettings(root, { models: { autoStopOnOverage: true } });
  const res = await m0007.run({ root, log: () => {} });
  assert.equal(res.applied, true);
  assert.equal(res.summary.onOverageMigrated, true);
  const settings = await readSettings(root);
  assert.equal(settings.models.onOverage, 'stop');
  assert.ok(!('autoStopOnOverage' in settings.models));
});

test('autoStopOnOverage:false + onOverage unset → legacy key removed, onOverage left unset', async () => {
  const root = await mkTmp();
  await writeSettings(root, { models: { autoStopOnOverage: false } });
  const res = await m0007.run({ root, log: () => {} });
  assert.equal(res.applied, true);
  assert.equal(res.summary.onOverageMigrated, false);
  const settings = await readSettings(root);
  assert.ok(!('autoStopOnOverage' in settings.models));
  assert.equal(settings.models.onOverage, undefined);
});

test('onOverage already set + legacy present → onOverage preserved, legacy key removed', async () => {
  const root = await mkTmp();
  await writeSettings(root, { models: { onOverage: 'none', autoStopOnOverage: true } });
  const res = await m0007.run({ root, log: () => {} });
  assert.equal(res.applied, true);
  assert.equal(res.summary.onOverageMigrated, false);
  const settings = await readSettings(root);
  assert.equal(settings.models.onOverage, 'none');
  assert.ok(!('autoStopOnOverage' in settings.models));
});

test('fable5Enabled:false + enabledFamilies unset → full map written, legacy key removed', async () => {
  const root = await mkTmp();
  await writeSettings(root, { models: { fable5Enabled: false } });
  const res = await m0007.run({ root, log: () => {} });
  assert.equal(res.applied, true);
  assert.equal(res.summary.enabledFamiliesMigrated, true);
  const settings = await readSettings(root);
  assert.deepEqual(settings.models.enabledFamilies, { fable: false, opus: true, sonnet: true, haiku: true });
  assert.ok(!('fable5Enabled' in settings.models));
});

test('fable5Enabled:true + enabledFamilies unset → legacy key removed, no enabledFamilies written', async () => {
  const root = await mkTmp();
  await writeSettings(root, { models: { fable5Enabled: true } });
  const res = await m0007.run({ root, log: () => {} });
  assert.equal(res.applied, true);
  assert.equal(res.summary.enabledFamiliesMigrated, false);
  const settings = await readSettings(root);
  assert.ok(!('fable5Enabled' in settings.models));
  assert.equal(settings.models.enabledFamilies, undefined);
});

test('enabledFamilies already set + legacy present → enabledFamilies preserved, legacy key removed', async () => {
  const root = await mkTmp();
  await writeSettings(root, { models: { enabledFamilies: { fable: true, opus: false, sonnet: true, haiku: true }, fable5Enabled: false } });
  const res = await m0007.run({ root, log: () => {} });
  assert.equal(res.applied, true);
  assert.equal(res.summary.enabledFamiliesMigrated, false);
  const settings = await readSettings(root);
  assert.deepEqual(settings.models.enabledFamilies, { fable: true, opus: false, sonnet: true, haiku: true });
  assert.ok(!('fable5Enabled' in settings.models));
});

test('idempotent: second run is a no-op', async () => {
  const root = await mkTmp();
  await writeSettings(root, { models: { autoStopOnOverage: true, fable5Enabled: false } });
  const res1 = await m0007.run({ root, log: () => {} });
  assert.equal(res1.applied, true);
  const res2 = await m0007.run({ root, log: () => {} });
  assert.equal(res2.applied, false);
});
