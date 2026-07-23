// Unit tests for migration 0021 (strip plugin conductor-convention slugs out of
// the seed/custom `enabled` array in conventions/conductor.json). Verifies the
// strip branch, that pluginOff is NOT populated, and idempotency.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { promises as fs } from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import * as m0020 from '../migrations/0020-consolidate-convention-stores.mjs';
import * as m0021 from '../migrations/0021-strip-plugin-slugs-from-conductor-conventions.mjs';

async function mkTmp() {
  return fs.mkdtemp(path.join(os.tmpdir(), 'cc-mig-strip-slugs-'));
}

async function writeStore(root, store) {
  const file = path.join(root, '.code-conductor', 'conventions', 'conductor.json');
  await fs.mkdir(path.dirname(file), { recursive: true });
  await fs.writeFile(file, JSON.stringify(store, null, 2) + '\n');
  return file;
}

async function readStore(file) {
  return JSON.parse(await fs.readFile(file, 'utf8'));
}

test('strips plugin slugs from enabled, keeping seed/custom slugs', async () => {
  const root = await mkTmp();
  const file = await writeStore(root, {
    enabled: ['canonical-workflow', 'my-plugin/rule-a', 'worker-lifecycle'],
    rules: [],
  });

  const res = await m0021.run({ root, log: () => {} });
  assert.equal(res.applied, true);
  assert.deepEqual(res.summary, { stripped: ['my-plugin/rule-a'] });

  const store = await readStore(file);
  assert.deepEqual(store.enabled, ['canonical-workflow', 'worker-lifecycle'], 'seed slugs retained, plugin slug removed');
  assert.ok(!('pluginOff' in store), 'pluginOff is NOT populated (stripped slugs stay on by default)');
});

test('0020 then 0021 compose on a real old-format store: relocate, then strip', async () => {
  const root = await mkTmp();
  // Legacy flat store (pre-0020), with a manually-enabled plugin slug in enabled.
  const oldFile = path.join(root, '.code-conductor', 'conduct-modules.json');
  await fs.mkdir(path.dirname(oldFile), { recursive: true });
  await fs.writeFile(oldFile, JSON.stringify({ enabled: ['canonical-workflow', 'my-plugin/rule-a'], rules: [] }, null, 2) + '\n');

  // 0020 relocates conduct-modules.json → conventions/conductor.json (same shape).
  assert.equal((await m0020.run({ root, log: () => {} })).applied, true);
  const newFile = path.join(root, '.code-conductor', 'conventions', 'conductor.json');
  assert.deepEqual((await readStore(newFile)).enabled, ['canonical-workflow', 'my-plugin/rule-a'], 'relocated, enabled carried over verbatim');
  await assert.rejects(fs.stat(oldFile), 'old flat file gone');

  // 0021 then strips the plugin slug from the relocated store.
  assert.equal((await m0021.run({ root, log: () => {} })).applied, true);
  assert.deepEqual((await readStore(newFile)).enabled, ['canonical-workflow'], 'plugin slug stripped from relocated store');

  // Re-running the pair is a no-op.
  assert.equal((await m0020.run({ root, log: () => {} })).applied, false);
  assert.equal((await m0021.run({ root, log: () => {} })).applied, false);
});

test('idempotent: no-op when enabled holds no plugin slug or file is absent', async () => {
  const root = await mkTmp();

  // Absent file → no-op.
  assert.equal((await m0021.run({ root, log: () => {} })).applied, false);

  // A file already in the new shape → no-op, byte-for-byte untouched.
  const file = await writeStore(root, { enabled: ['canonical-workflow'], pluginOff: ['p/a'], rules: [] });
  const before = await fs.readFile(file, 'utf8');
  assert.equal((await m0021.run({ root, log: () => {} })).applied, false);
  assert.equal(await fs.readFile(file, 'utf8'), before, 'clean file left untouched');

  // Re-running right after a real strip is also a no-op.
  await writeStore(root, { enabled: ['canonical-workflow', 'p/a'], rules: [] });
  assert.equal((await m0021.run({ root, log: () => {} })).applied, true);
  assert.equal((await m0021.run({ root, log: () => {} })).applied, false, 'second run is a no-op');
});
