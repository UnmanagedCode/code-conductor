// Migration 0030: backfill `midTurnSteering` onto every stored custom model.
//
// The decision this migration encodes: every pre-existing row predates the flag
// and WAS being steered mid-turn, so the backfill is `true` (behaviour
// unchanged). Backfilling `false` — or leaving the field absent for the reader
// to default — would divert live steers onto the block-edge-stop path for models
// nobody has declared anything about.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { promises as fs } from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import * as m0030 from '../migrations/0030-backfill-mid-turn-steering.mjs';
import { ALL } from '../migrations/index.mjs';

const mkTmp = () => fs.mkdtemp(path.join(os.tmpdir(), 'cc-mig30-'));
const settingsFile = (root) => path.join(root, '.code-conductor', 'settings.json');

async function writeJson(file, obj) {
  await fs.mkdir(path.dirname(file), { recursive: true });
  await fs.writeFile(file, JSON.stringify(obj, null, 2) + '\n');
}
const readJson = async (file) => JSON.parse(await fs.readFile(file, 'utf8'));

async function withRoot(fn) {
  const root = await mkTmp();
  try { await fn(root); } finally { await fs.rm(root, { recursive: true, force: true }); }
}

test('every pre-existing custom model is backfilled with midTurnSteering:true', async () => {
  await withRoot(async (root) => {
    await writeJson(settingsFile(root), {
      models: {
        customModels: [
          { label: 'A', model: 'a:cloud', backend: 'ollama', contextWindow: 128000 },
          { label: 'B', model: 'b:cloud', backend: 'proxy', contextWindow: 256000 },
        ],
        tierBackend: { fast: { backend: 'claude', model: 'claude-haiku-4-5' } },
      },
    });
    const r = await m0030.run({ root });
    assert.equal(r.applied, true);
    assert.deepEqual(r.summary, { backfilled: 2 });
    const store = await readJson(settingsFile(root));
    assert.deepEqual(store.models.customModels, [
      { label: 'A', model: 'a:cloud', backend: 'ollama', contextWindow: 128000, midTurnSteering: true },
      { label: 'B', model: 'b:cloud', backend: 'proxy', contextWindow: 256000, midTurnSteering: true },
    ]);
    assert.deepEqual(store.models.tierBackend, { fast: { backend: 'claude', model: 'claude-haiku-4-5' } },
      'sibling keys untouched');
  });
});

test('an existing declaration is never overwritten — including an explicit false', async () => {
  await withRoot(async (root) => {
    await writeJson(settingsFile(root), {
      models: {
        customModels: [
          { label: 'A', model: 'a:cloud', backend: 'ollama', contextWindow: 1, midTurnSteering: false },
          { label: 'B', model: 'b:cloud', backend: 'ollama', contextWindow: 2 },
        ],
      },
    });
    assert.equal((await m0030.run({ root })).summary.backfilled, 1, 'only the unflagged row');
    const list = (await readJson(settingsFile(root))).models.customModels;
    assert.equal(list[0].midTurnSteering, false, 'a declared opt-out survives the backfill');
    assert.equal(list[1].midTurnSteering, true);
  });
});

test('idempotent: the second run is applied:false and byte-identical', async () => {
  await withRoot(async (root) => {
    await writeJson(settingsFile(root), {
      models: { customModels: [{ label: 'A', model: 'a:cloud', backend: 'ollama', contextWindow: 1 }] },
    });
    assert.equal((await m0030.run({ root })).applied, true);
    const after = await fs.readFile(settingsFile(root), 'utf8');
    assert.equal((await m0030.run({ root })).applied, false, 'the self-check must stop the second run');
    assert.equal(await fs.readFile(settingsFile(root), 'utf8'), after, 'byte-identical');
  });
});

test('a store with no custom models (or no store at all) is a silent no-op', async () => {
  await withRoot(async (root) => {
    assert.equal((await m0030.run({ root })).applied, false, 'no settings.json');
  });
  await withRoot(async (root) => {
    await writeJson(settingsFile(root), { models: { backends: [] } });
    assert.equal((await m0030.run({ root })).applied, false);
    assert.equal(Object.hasOwn((await readJson(settingsFile(root))).models, 'customModels'), false,
      'the key must not be created');
  });
});

test('0030 is registered, last in the chain', () => {
  assert.equal(ALL.at(-1), m0030);
});
