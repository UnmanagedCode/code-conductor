// Migration 0040: every plugin registry record gains a boolean `autoStart`,
// off unless the record already holds one.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { promises as fs } from 'node:fs';
import path from 'node:path';
import * as m0040 from '../migrations/0040-plugin-autostart-flag.mjs';
import { mkdtemp } from './tmpRegistry.mjs';

async function mkRoot() {
  const root = await mkdtemp('cc-m0040-');
  await fs.mkdir(path.join(root, '.code-conductor', 'plugins'), { recursive: true });
  return root;
}
const registryFile = (root) => path.join(root, '.code-conductor', 'plugins', 'registry.json');
const writeRegistry = (root, text) => fs.writeFile(registryFile(root), text);
const readRegistry = async (root) => JSON.parse(await fs.readFile(registryFile(root), 'utf8'));
const run = (root) => m0040.run({ root, log: () => {} });

test('a record without the flag gains autoStart:false; an existing true and every other key are kept', async () => {
  const root = await mkRoot();
  await writeRegistry(root, JSON.stringify({
    plugins: {
      a: { project: 'pa', enabled: true, activeVersion: { type: 'worktree', name: 'wt' } },
      b: { project: 'pb', enabled: false, activeVersion: { type: 'main' }, autoStart: true },
    },
  }));
  const res = await run(root);
  assert.deepEqual(res, { applied: true, summary: { records: ['a'] } });
  assert.deepEqual(await readRegistry(root), {
    plugins: {
      a: { project: 'pa', enabled: true, activeVersion: { type: 'worktree', name: 'wt' }, autoStart: false },
      b: { project: 'pb', enabled: false, activeVersion: { type: 'main' }, autoStart: true },
    },
  });
});

test('a second run is a no-op that leaves the bytes unchanged', async () => {
  const root = await mkRoot();
  await writeRegistry(root, JSON.stringify({ plugins: { a: { project: 'pa', enabled: true } } }));
  await run(root);
  const after = await fs.readFile(registryFile(root), 'utf8');
  assert.deepEqual(await run(root), { applied: false });
  assert.equal(await fs.readFile(registryFile(root), 'utf8'), after);
});

test('a missing registry.json is a no-op and creates nothing', async () => {
  const root = await mkRoot();
  assert.deepEqual(await run(root), { applied: false });
  assert.equal(await fs.access(registryFile(root)).then(() => true, () => false), false);
});

test('a corrupt registry.json is left byte-for-byte for its loader', async () => {
  const root = await mkRoot();
  await writeRegistry(root, '{ not json');
  assert.deepEqual(await run(root), { applied: false });
  assert.equal(await fs.readFile(registryFile(root), 'utf8'), '{ not json');
});
