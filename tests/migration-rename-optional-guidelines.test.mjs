// Unit tests for migration 0011 (rename the custom-convention store
// optional-guidelines.json → project-conventions.json). Verifies the rename
// branch, the don't-clobber branch (destination present), and idempotency.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { promises as fs } from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import * as m0011 from '../migrations/0011-rename-optional-guidelines-store.mjs';

async function mkTmp() {
  return fs.mkdtemp(path.join(os.tmpdir(), 'cc-rename-conventions-'));
}

async function exists(p) {
  try { await fs.lstat(p); return true; } catch { return false; }
}

async function writeStore(file, rules) {
  await fs.mkdir(path.dirname(file), { recursive: true });
  await fs.writeFile(file, JSON.stringify({ rules }, null, 2) + '\n');
}

test('renames optional-guidelines.json → project-conventions.json, preserving rules', async () => {
  const root = await mkTmp();
  const store = path.join(root, '.code-conductor');
  const oldFile = path.join(store, 'optional-guidelines.json');
  const newFile = path.join(store, 'project-conventions.json');
  await writeStore(oldFile, [{ slug: 'my-rule', name: 'My', description: 'd', body: '## My' }]);

  const res = await m0011.run({ root, log: () => {} });
  assert.equal(res.applied, true);
  assert.equal(await exists(oldFile), false, 'old file removed');
  const migrated = JSON.parse(await fs.readFile(newFile, 'utf8'));
  assert.equal(migrated.rules[0].slug, 'my-rule', 'custom rules survive the rename');
});

test('does not clobber an existing destination', async () => {
  const root = await mkTmp();
  const store = path.join(root, '.code-conductor');
  const oldFile = path.join(store, 'optional-guidelines.json');
  const newFile = path.join(store, 'project-conventions.json');
  await writeStore(oldFile, [{ slug: 'old' }]);
  await writeStore(newFile, [{ slug: 'new' }]);

  const res = await m0011.run({ root, log: () => {} });
  assert.equal(res.applied, false, 'skips when destination exists');
  assert.equal(await exists(oldFile), true, 'old file left for manual inspection');
  const dest = JSON.parse(await fs.readFile(newFile, 'utf8'));
  assert.equal(dest.rules[0].slug, 'new', 'destination untouched');
});

test('idempotent no-op when the legacy file is absent', async () => {
  const root = await mkTmp();
  const res = await m0011.run({ root, log: () => {} });
  assert.equal(res.applied, false);
});
