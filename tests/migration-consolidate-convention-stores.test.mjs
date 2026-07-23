// Unit tests for migration 0020 (consolidate the three convention-scope stores
// under <root>/.code-conductor/conventions/). Verifies the move branch, the
// don't-clobber branch, per-scope independence, and idempotency.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { promises as fs } from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import * as m0020 from '../migrations/0020-consolidate-convention-stores.mjs';

async function mkTmp() {
  return fs.mkdtemp(path.join(os.tmpdir(), 'cc-consolidate-conventions-'));
}

async function exists(p) {
  try { await fs.lstat(p); return true; } catch { return false; }
}

async function writeJson(file, obj) {
  await fs.mkdir(path.dirname(file), { recursive: true });
  await fs.writeFile(file, JSON.stringify(obj, null, 2) + '\n');
}

test('moves all three stores into conventions/, preserving contents', async () => {
  const root = await mkTmp();
  const store = path.join(root, '.code-conductor');
  await writeJson(path.join(store, 'conduct-modules.json'), { enabled: ['canonical-workflow'], rules: [{ slug: 'c1' }] });
  await writeJson(path.join(store, 'workspace-modules.json'), { enabled: ['git-hygiene'], rules: [] });
  await writeJson(path.join(store, 'project-conventions.json'), { rules: [{ slug: 'p1' }] });

  const res = await m0020.run({ root, log: () => {} });
  assert.equal(res.applied, true);
  assert.equal(res.summary.renamed.length, 3);

  for (const old of ['conduct-modules.json', 'workspace-modules.json', 'project-conventions.json']) {
    assert.equal(await exists(path.join(store, old)), false, `${old} removed`);
  }
  const conductor = JSON.parse(await fs.readFile(path.join(store, 'conventions', 'conductor.json'), 'utf8'));
  assert.deepEqual(conductor.enabled, ['canonical-workflow']);
  assert.equal(conductor.rules[0].slug, 'c1');
  const workspace = JSON.parse(await fs.readFile(path.join(store, 'conventions', 'workspace.json'), 'utf8'));
  assert.deepEqual(workspace.enabled, ['git-hygiene']);
  const project = JSON.parse(await fs.readFile(path.join(store, 'conventions', 'project.json'), 'utf8'));
  assert.equal(project.rules[0].slug, 'p1');
});

test('per-scope independence: moves only the scopes whose old file exists', async () => {
  const root = await mkTmp();
  const store = path.join(root, '.code-conductor');
  await writeJson(path.join(store, 'conduct-modules.json'), { enabled: [] });

  const res = await m0020.run({ root, log: () => {} });
  assert.equal(res.applied, true);
  assert.deepEqual(res.summary.renamed, ['conduct-modules.json → conventions/conductor.json']);
  assert.equal(await exists(path.join(store, 'conventions', 'conductor.json')), true);
  assert.equal(await exists(path.join(store, 'conventions', 'workspace.json')), false);
});

test('does not clobber an existing destination', async () => {
  const root = await mkTmp();
  const store = path.join(root, '.code-conductor');
  await writeJson(path.join(store, 'conduct-modules.json'), { enabled: ['old'] });
  await writeJson(path.join(store, 'conventions', 'conductor.json'), { enabled: ['new'] });

  const res = await m0020.run({ root, log: () => {} });
  assert.equal(res.applied, false, 'skips when destination exists');
  assert.equal(await exists(path.join(store, 'conduct-modules.json')), true, 'old file left for manual inspection');
  const dest = JSON.parse(await fs.readFile(path.join(store, 'conventions', 'conductor.json'), 'utf8'));
  assert.deepEqual(dest.enabled, ['new'], 'destination untouched');
});

test('idempotent no-op when no legacy files are present', async () => {
  const root = await mkTmp();
  const res = await m0020.run({ root, log: () => {} });
  assert.equal(res.applied, false);
});
