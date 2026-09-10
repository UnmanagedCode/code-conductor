// Unit tests for migration 0033 (retire the convention-selection `enabled`
// allow-list in favour of a `disabled` deny-list, and subsume `pluginOff` into
// it). See migrations/0033-drop-convention-enabled-allow-list.mjs for the bug
// class this closes.
//
// The migration is a BREAKING RESET: the old allow-list is discarded and
// NOTHING is derived from it, so the discriminating fixtures are about what is
// removed, what is carried over, and what is left strictly alone — not about a
// translation.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { promises as fs } from 'node:fs';
import path from 'node:path';
import { mkdtemp } from './tmpRegistry.mjs';
import * as m0033 from '../migrations/0033-drop-convention-enabled-allow-list.mjs';
import { runMigrations } from '../migrations/index.mjs';

async function mkTmp() {
  return mkdtemp('cc-drop-allow-list-');
}

function storeFile(root, scope) {
  return path.join(root, '.code-conductor', 'conventions', `${scope}.json`);
}

async function writeJson(file, obj) {
  await fs.mkdir(path.dirname(file), { recursive: true });
  await fs.writeFile(file, JSON.stringify(obj, null, 2) + '\n');
}

async function readJson(file) {
  return JSON.parse(await fs.readFile(file, 'utf8'));
}

async function exists(p) {
  try { await fs.lstat(p); return true; } catch { return false; }
}

const SEEDS = [
  'intent-disambiguation', 'canonical-workflow', 'worker-lifecycle', 'operational-tasks',
  'worker-prompts', 'capturing-learnings', 'context-renewal', 'system-prompt-gate', 'playbooks',
];

// M1 — the shape this install actually carries: a complete `enabled` array and
// an empty `pluginOff`. The key must be GONE (a store that keeps it keeps the
// freeze), and every sibling key must survive the read-modify-write: a mutation
// that rewrote the file from scratch would pass a looser assertion while
// destroying the user's custom bodies and playbook selection.
test('M1 conductor, full allow-list: `enabled` removed, siblings byte-preserved, discard reported', async () => {
  const root = await mkTmp();
  const file = storeFile(root, 'conductor');
  const before = {
    enabled: [...SEEDS],
    pluginOff: [],
    defaultPlaybook: { mode: 'playbook', id: 'relay' },
    defaultPlaybookEnforcement: 'enforce',
    rules: [{ slug: 'custom-rule', name: 'C', description: 'd', body: 'x' }],
  };
  await writeJson(file, before);

  const res = await m0033.run({ root, log: () => {} });
  assert.equal(res.applied, true);
  assert.deepEqual(res.summary, {
    conductor: { discardedEnabled: [...SEEDS], carriedPluginOff: [] },
  }, 'the discarded allow-list is reported, not silently dropped');

  const after = await readJson(file);
  assert.ok(!('enabled' in after), '`enabled` is gone');
  assert.ok(!('pluginOff' in after), '`pluginOff` is gone');
  assert.ok(!('disabled' in after), 'nothing was switched off — no empty key written');
  assert.deepEqual(after.defaultPlaybook, before.defaultPlaybook);
  assert.equal(after.defaultPlaybookEnforcement, before.defaultPlaybookEnforcement);
  assert.deepEqual(after.rules, before.rules);
});

// M2 — the STALE partial allow-list, which is the whole point of the card: two
// of four seeds. It must NOT be translated into off-switches for the other two.
// Kills the tempting "preserving conversion" mutant, which would need a seed
// snapshot and would re-create the very trap being retired.
test('M2 workspace, stale partial allow-list: discarded, NOT translated into off-switches', async () => {
  const root = await mkTmp();
  const file = storeFile(root, 'workspace');
  await writeJson(file, { enabled: ['git-hygiene', 'readme-maintenance'], rules: [] });

  const res = await m0033.run({ root, log: () => {} });
  assert.equal(res.applied, true);
  assert.deepEqual(res.summary, {
    workspace: { discardedEnabled: ['git-hygiene', 'readme-maintenance'], carriedPluginOff: [] },
  });

  const after = await readJson(file);
  assert.ok(!('enabled' in after), '`enabled` is gone');
  assert.ok(!('disabled' in after), 'the two absent seeds did NOT become off-switches');
  assert.deepEqual(after.rules, []);
});

// M3 — a fresh install has no file at all. Creating one here would be the
// original sin in a new polarity: an empty `disabled` is harmless, but writing
// a file where none existed is a behaviour the deny-list model never needs.
test('M3 fresh install (no file): no-op, and neither store file is created', async () => {
  const root = await mkTmp();

  const res = await m0033.run({ root, log: () => {} });
  assert.equal(res.applied, false);
  assert.equal(await exists(storeFile(root, 'conductor')), false);
  assert.equal(await exists(storeFile(root, 'workspace')), false);
});

// M4 — a store that only ever held custom bodies (never saved a selection).
// Kills a mutation that rewrites unconditionally: `applied:false` AND the file
// must be byte-identical, not merely equal after a re-serialise.
test('M4 store with `rules` only: no-op, file byte-identical', async () => {
  const root = await mkTmp();
  const file = storeFile(root, 'conductor');
  await writeJson(file, { rules: [{ slug: 'r', name: 'R', description: 'd', body: 'b' }] });
  const before = await fs.readFile(file, 'utf8');

  const res = await m0033.run({ root, log: () => {} });
  assert.equal(res.applied, false);
  assert.equal(await fs.readFile(file, 'utf8'), before, 'file untouched');
});

// M5 — idempotency, from the migration's own output rather than a hand-written
// "already migrated" fixture: whatever M1's shape is, a second run must see
// nothing to do and leave the bytes alone.
test('M5 idempotent: a second run over an already-migrated root is a byte-level no-op', async () => {
  const root = await mkTmp();
  const file = storeFile(root, 'conductor');
  await writeJson(file, { enabled: [...SEEDS], pluginOff: ['acme/x'], rules: [] });

  assert.equal((await m0033.run({ root, log: () => {} })).applied, true);
  const afterFirst = await fs.readFile(file, 'utf8');

  assert.equal((await m0033.run({ root, log: () => {} })).applied, false);
  assert.equal(await fs.readFile(file, 'utf8'), afterFirst, 'file byte-identical after the no-op run');
});

// M6 — the subsumption pin, and the one place a value CROSSES from the old
// shape into the new one. `pluginOff` is already "slugs the user switched off",
// so it is renamed rather than converted; dropping it would silently re-enable
// plugin conventions someone had unchecked. `disabled` is also unioned with any
// value already there, so the two sources cannot clobber each other.
test('M6 `pluginOff` is carried into `disabled` verbatim, unioned with an existing one', async () => {
  const root = await mkTmp();
  const file = storeFile(root, 'conductor');
  await writeJson(file, { pluginOff: ['acme/x', 'acme/y'], disabled: ['acme/x', 'worker-prompts'], rules: [] });

  const res = await m0033.run({ root, log: () => {} });
  assert.equal(res.applied, true);
  assert.deepEqual(res.summary, {
    conductor: { discardedEnabled: [], carriedPluginOff: ['acme/x', 'acme/y'] },
  }, 'no `enabled` key ⇒ nothing discarded, but the rename still applied');

  const after = await readJson(file);
  assert.deepEqual(after.disabled, ['acme/x', 'worker-prompts', 'acme/y'], 'unioned, no duplicate');
  assert.ok(!('pluginOff' in after), '`pluginOff` is gone');
});

// M7 — both scopes in ONE root, as two independent steps. Kills a mutation
// that returns after the first scope it repairs (the conductor store is the
// one this install has, so a first-match return would leave every workspace
// store frozen forever and still report `applied`).
test('M7 both scopes in one root are repaired independently', async () => {
  const root = await mkTmp();
  await writeJson(storeFile(root, 'workspace'), { enabled: ['git-hygiene'], rules: [] });
  await writeJson(storeFile(root, 'conductor'), { enabled: [...SEEDS], rules: [] });

  const res = await m0033.run({ root, log: () => {} });
  assert.equal(res.applied, true);
  assert.deepEqual(Object.keys(res.summary).sort(), ['conductor', 'workspace']);
  for (const scope of ['workspace', 'conductor']) {
    assert.ok(!('enabled' in await readJson(storeFile(root, scope))), `${scope}: repaired`);
  }
});

// M8 — the PRODUCTION BOOT PATH, not just the module's logic: server.ts calls
// runMigrations({root}), which iterates migrations/index.mjs's `ALL`. A correct
// 0033 that is never registered would fix nothing in production while every
// direct m0033.run() test above still passes. Asserted on the end state on
// disk rather than on `ALL.includes(...)`, so a registered-but-broken 0033
// fails it too.
test('M8 runMigrations (the real boot entrypoint) removes the allow-list', async () => {
  const root = await mkTmp();
  const file = storeFile(root, 'conductor');
  // A partial allow-list, so an earlier chain member that APPENDS to `enabled`
  // (0015, 0029) cannot be what makes this pass.
  await writeJson(file, { enabled: ['canonical-workflow'], rules: [] });

  await runMigrations({ root, log: () => {} });

  const after = await readJson(file);
  assert.ok(!('enabled' in after), '0033 ran as part of the registered chain, not just standalone');
  assert.ok(!('pluginOff' in after));
});
