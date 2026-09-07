// Unit tests for migration 0029 (retroactively enable the `playbooks`
// conductor-convention slug for installs whose `enabled` selection predates
// it). See migrations/0029-enable-playbooks-conductor-convention.mjs for the
// bug this repairs.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { promises as fs } from 'node:fs';
import path from 'node:path';
import { mkdtemp } from './tmpRegistry.mjs';
import * as m0029 from '../migrations/0029-enable-playbooks-conductor-convention.mjs';
import { ALL } from '../migrations/index.mjs';

// Replay the real registered chain up to and including `lastName`, in order —
// the same shape tests/migration-0018b.test.mjs uses. Deliberately a PREFIX and
// not the whole chain: 0033 later retires the `enabled` key altogether (the
// deny-list inversion, card 2026-0123), so a full-chain end-state assertion
// would report `enabled` absent and stop testing 0029's own subject. This test
// pins 0029's registration; a later migration is entitled to remove the key it
// wrote.
async function runChainThrough(lastName, { root }) {
  const end = ALL.findIndex(m => m.name === lastName);
  assert.ok(end >= 0, `no migration named ${lastName} is registered`);
  for (const m of ALL.slice(0, end + 1)) await m.run({ root, log: () => {} });
}

async function mkTmp() {
  return mkdtemp('cc-enable-playbooks-');
}

function storeFile(root) {
  return path.join(root, '.code-conductor', 'conventions', 'conductor.json');
}

async function writeJson(file, obj) {
  await fs.mkdir(path.dirname(file), { recursive: true });
  await fs.writeFile(file, JSON.stringify(obj, null, 2) + '\n');
}

async function exists(p) {
  try { await fs.lstat(p); return true; } catch { return false; }
}

const PRE_PLAYBOOKS_SLUGS = [
  'intent-disambiguation', 'canonical-workflow', 'worker-lifecycle', 'operational-tasks',
  'worker-prompts', 'capturing-learnings', 'context-renewal', 'system-prompt-gate',
];

// Pins the observed bug: a pre-existing `enabled` selection (from before
// `playbooks` was seeded) omits the new slug and does NOT gain it for free,
// while sibling keys (`defaultPlaybook`, `defaultPlaybookEnforcement`,
// `rules`) must survive untouched — a mutation that also touched those
// would pass a looser assertion but corrupt unrelated state.
test('the observed bug: playbooks is appended to a pre-existing selection, siblings byte-identical', async () => {
  const root = await mkTmp();
  const file = storeFile(root);
  const before = {
    enabled: [...PRE_PLAYBOOKS_SLUGS],
    defaultPlaybook: { mode: 'playbook', id: 'relay' },
    defaultPlaybookEnforcement: 'enforce',
    rules: [{ slug: 'custom-rule', body: 'x' }],
  };
  await writeJson(file, before);

  const res = await m0029.run({ root, log: () => {} });
  assert.equal(res.applied, true);
  assert.deepEqual(res.summary, { addedSlug: 'playbooks' });

  const after = JSON.parse(await fs.readFile(file, 'utf8'));
  assert.deepEqual(after.enabled, [...PRE_PLAYBOOKS_SLUGS, 'playbooks'], 'playbooks appended at the end');
  assert.deepEqual(after.defaultPlaybook, before.defaultPlaybook, 'defaultPlaybook survives byte-identical');
  assert.equal(after.defaultPlaybookEnforcement, before.defaultPlaybookEnforcement,
    'defaultPlaybookEnforcement survives byte-identical');
  assert.deepEqual(after.rules, before.rules, 'rules survive byte-identical');
});

// Catches a mutation that re-runs the append unconditionally, or one that
// drops the guard: a second run must be a true no-op, not a duplicate slug
// or a rewritten (even if equal) file.
test('idempotent: a second run is a no-op, no duplicate slug', async () => {
  const root = await mkTmp();
  const file = storeFile(root);
  await writeJson(file, { enabled: [...PRE_PLAYBOOKS_SLUGS] });

  const first = await m0029.run({ root, log: () => {} });
  assert.equal(first.applied, true);
  const afterFirst = await fs.readFile(file, 'utf8');

  const second = await m0029.run({ root, log: () => {} });
  assert.equal(second.applied, false);
  const afterSecond = await fs.readFile(file, 'utf8');
  assert.equal(afterSecond, afterFirst, 'file byte-identical after the no-op run');

  const store = JSON.parse(afterSecond);
  assert.deepEqual(store.enabled, [...PRE_PLAYBOOKS_SLUGS, 'playbooks'], 'no duplicate slug');
});

// Catches a mutation that creates a store file where none existed: a fresh
// install has no file at all, and getSelection() already yields every seed
// including `playbooks` from a store with no off-switches in it — writing a
// file here would have frozen the seed set for real under the allow-list this
// migration predates.
test('fresh install (no file): no-op, and no file is created', async () => {
  const root = await mkTmp();
  const file = storeFile(root);

  const res = await m0029.run({ root, log: () => {} });
  assert.equal(res.applied, false);
  assert.equal(await exists(file), false, 'no store file was created');
});

// Catches a mutation that treats a present-but-shapeless store (missing or
// non-array `enabled`) as if it had an `enabled` array to append to, which
// would throw or write a bogus shape instead of correctly deferring to the
// same fallback fresh installs get.
test('store present but `enabled` absent: no-op, file left untouched', async () => {
  const root = await mkTmp();
  const file = storeFile(root);
  await writeJson(file, { defaultPlaybook: { mode: 'none' } });
  const before = await fs.readFile(file, 'utf8');

  const res = await m0029.run({ root, log: () => {} });
  assert.equal(res.applied, false);
  const after = await fs.readFile(file, 'utf8');
  assert.equal(after, before, 'file untouched');
});

// Pins the PRODUCTION BOOT PATH, not just the module's own logic: server.ts
// calls runMigrations({root}) — which iterates migrations/index.mjs's `ALL`
// — before the listener binds. A correct 0029 module that is never added to
// `ALL` would fix nothing in production while every direct m0029.run() test
// above still passes, since none of them go through the registered chain.
test('the registered chain through 0029 enables playbooks for a pre-existing selection', async () => {
  const root = await mkTmp();
  const file = storeFile(root);
  await writeJson(file, { enabled: [...PRE_PLAYBOOKS_SLUGS] });

  await runChainThrough(m0029.name, { root });

  const store = JSON.parse(await fs.readFile(file, 'utf8'));
  assert.ok(store.enabled.includes('playbooks'), '0029 ran as part of the registered chain, not just standalone');
  assert.equal(store.enabled[store.enabled.length - 1], 'playbooks', 'appended at the end');
});
