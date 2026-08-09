// Migration 0027: remap the persisted `defaultPlaybook` selection onto the
// renamed built-in playbook ids (classic → solo, split → relay, research →
// cleared).
//
// The failure mode this exists to prevent is silent: an unmapped selection no
// longer resolves, so defaultPlaybookConvention() drops the entire
// default-playbook section out of the conductor's system prompt with nothing but
// a server-side console.warn. The conductor simply stops being told its graph.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { promises as fs } from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import * as m0027 from '../migrations/0027-rename-default-playbook-ids.mjs';

const mkTmp = () => fs.mkdtemp(path.join(os.tmpdir(), 'cc-mig27-'));
const conductorFile = (root) => path.join(root, '.code-conductor', 'conventions', 'conductor.json');

async function writeJson(file, obj) {
  await fs.mkdir(path.dirname(file), { recursive: true });
  await fs.writeFile(file, JSON.stringify(obj, null, 2) + '\n');
}
const readJson = async (file) => JSON.parse(await fs.readFile(file, 'utf8'));

test('each retired id is remapped, and `research` is cleared rather than substituted', async () => {
  for (const [from, to] of [['classic', 'solo'], ['split', 'relay'], ['research', null]]) {
    const root = await mkTmp();
    try {
      await writeJson(conductorFile(root), { enabled: ['playbooks'], defaultPlaybook: from });
      const res = await m0027.run({ root });
      assert.equal(res.applied, true, `${from} must be remapped`);
      const store = await readJson(conductorFile(root));
      assert.equal(store.defaultPlaybook, to);
      // The sibling keys in the same store are not this migration's business.
      assert.deepEqual(store.enabled, ['playbooks'], 'the convention selection is untouched');
    } finally {
      await fs.rm(root, { recursive: true, force: true });
    }
  }
});

test('a current id, a user-overlay id, null and an absent key are all left alone', async () => {
  // The remap must be keyed on the RETIRED ids, not "anything unrecognised".
  // A mutant that rewrites unconditionally — or clears whatever does not resolve
  // — destroys a user's own playbook selection, which nothing would restore.
  //
  // 'toString' is in the list for the lookup, not the id: `from in REMAP` walks
  // the prototype chain and would match it, assign a function, and lose the key
  // when JSON.stringify drops it. Only Object.hasOwn refuses it, so without this
  // value nothing here can tell the two apart.
  for (const value of ['solo', 'relay', 'freeform', 'my-own-playbook', 'toString', null]) {
    const root = await mkTmp();
    try {
      await writeJson(conductorFile(root), { defaultPlaybook: value });
      assert.equal((await m0027.run({ root })).applied, false, `${value} must be left alone`);
      assert.equal((await readJson(conductorFile(root))).defaultPlaybook, value);
    } finally {
      await fs.rm(root, { recursive: true, force: true });
    }
  }
  const bare = await mkTmp();
  try {
    await writeJson(conductorFile(bare), { enabled: [] });
    assert.equal((await m0027.run({ root: bare })).applied, false);
    assert.equal('defaultPlaybook' in (await readJson(conductorFile(bare))), false,
      'an absent key must not be created');
  } finally {
    await fs.rm(bare, { recursive: true, force: true });
  }
});

test('a missing store is a no-op, and a second run changes nothing', async () => {
  const empty = await mkTmp();
  try {
    assert.equal((await m0027.run({ root: empty })).applied, false);
  } finally {
    await fs.rm(empty, { recursive: true, force: true });
  }

  const root = await mkTmp();
  try {
    await writeJson(conductorFile(root), { defaultPlaybook: 'classic' });
    assert.equal((await m0027.run({ root })).applied, true);
    // Idempotence: the second run must report NOT-applied, not merely leave the
    // same value. A migration that re-fires every boot is the 0017 failure.
    assert.equal((await m0027.run({ root })).applied, false, 'the self-check must stop the second run');
    assert.equal((await readJson(conductorFile(root))).defaultPlaybook, 'solo');
  } finally {
    await fs.rm(root, { recursive: true, force: true });
  }
});
