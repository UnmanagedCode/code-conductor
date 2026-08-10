// Migration 0028: convert the persisted `defaultPlaybook` selection to its
// tri-state shape (see DefaultPlaybookSelection in src/conductorConventions.ts).
//
// The decision this migration encodes: a pre-change store maps to UNSET, never
// to the explicit `{mode:'none'}` opt-out. Nobody who predates the change ever
// chose "none", so reading their `null` as a deliberate opt-out would silently
// deny them the new built-in default — the same class of silent prompt loss that
// 0027 exists to prevent.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { promises as fs } from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import * as m0028 from '../migrations/0028-tri-state-default-playbook.mjs';
import * as m0027 from '../migrations/0027-rename-default-playbook-ids.mjs';
import { ALL } from '../migrations/index.mjs';

const mkTmp = () => fs.mkdtemp(path.join(os.tmpdir(), 'cc-mig28-'));
const conductorFile = (root) => path.join(root, '.code-conductor', 'conventions', 'conductor.json');

async function writeJson(file, obj) {
  await fs.mkdir(path.dirname(file), { recursive: true });
  await fs.writeFile(file, JSON.stringify(obj, null, 2) + '\n');
}
const readJson = async (file) => JSON.parse(await fs.readFile(file, 'utf8'));

async function withRoot(fn) {
  const root = await mkTmp();
  try { await fn(root); } finally { await fs.rm(root, { recursive: true, force: true }); }
}

// THE load-bearing case. deepEqual on the whole store, not a key probe: it fails
// alike on a leftover `null`, on a `{mode:'none'}` mutant, and on a `{mode:
// 'unset'}` one — every way of representing this state other than absence.
test('a legacy `null` becomes UNSET (the key is deleted), never the explicit opt-out', async () => {
  await withRoot(async (root) => {
    await writeJson(conductorFile(root), { enabled: ['playbooks'], defaultPlaybook: null });
    assert.equal((await m0028.run({ root })).applied, true);
    const store = await readJson(conductorFile(root));
    assert.deepEqual(store, { enabled: ['playbooks'] },
      'the key is gone entirely and the sibling selection survives');
  });
});

test('a legacy id is tagged, preserving the id', async () => {
  for (const id of ['solo', 'relay', 'freeform', 'my-own-playbook']) {
    await withRoot(async (root) => {
      await writeJson(conductorFile(root), { rules: [], defaultPlaybook: id });
      assert.equal((await m0028.run({ root })).applied, true);
      const store = await readJson(conductorFile(root));
      assert.deepEqual(store.defaultPlaybook, { mode: 'playbook', id });
      assert.deepEqual(store.rules, [], 'sibling keys untouched');
    });
  }
});

test('an absent key is left absent — unset is not something to write', async () => {
  await withRoot(async (root) => {
    await writeJson(conductorFile(root), { enabled: [] });
    assert.equal((await m0028.run({ root })).applied, false);
    assert.equal(Object.hasOwn(await readJson(conductorFile(root)), 'defaultPlaybook'), false,
      'an absent key must not be created');
  });
});

test('a missing store is a no-op, and already-tagged values are left alone', async () => {
  await withRoot(async (root) => {
    assert.equal((await m0028.run({ root })).applied, false, 'no store at all');
  });
  for (const value of [{ mode: 'none' }, { mode: 'playbook', id: 'solo' }]) {
    await withRoot(async (root) => {
      await writeJson(conductorFile(root), { defaultPlaybook: value });
      // Idempotence: NOT-applied, not merely "same value" — a migration that
      // re-fires every boot is its own bug. And a second pass that re-read
      // {mode:'none'} as legacy would clobber a deliberate opt-out.
      assert.equal((await m0028.run({ root })).applied, false);
      assert.deepEqual((await readJson(conductorFile(root))).defaultPlaybook, value);
    });
  }
});

test('a migrated store survives a second run unchanged', async () => {
  await withRoot(async (root) => {
    await writeJson(conductorFile(root), { defaultPlaybook: 'solo' });
    assert.equal((await m0028.run({ root })).applied, true);
    const after = await fs.readFile(conductorFile(root), 'utf8');
    assert.equal((await m0028.run({ root })).applied, false, 'the self-check must stop the second run');
    assert.equal(await fs.readFile(conductorFile(root), 'utf8'), after, 'byte-identical');
  });
});

// Ordering, exercised rather than assumed: 0027 can clear a selection to `null`
// (its `research` case), which 0028 must then turn into UNSET — so a user who
// had `research` selected lands on the built-in default. Replayed in ALL's own
// registered order, so a reordering of the two is what fails this test.
test('0027 → 0028: a `research` selection ends up unset, via the registered order', async () => {
  const chain = ALL.filter(m => m === m0027 || m === m0028);
  assert.deepEqual(chain, [m0027, m0028], '0027 must be registered before 0028');
  await withRoot(async (root) => {
    await writeJson(conductorFile(root), { enabled: ['playbooks'], defaultPlaybook: 'research' });
    for (const m of chain) await m.run({ root });
    assert.deepEqual(await readJson(conductorFile(root)), { enabled: ['playbooks'] },
      'cleared by 0027, then dropped to unset by 0028');
  });
});
