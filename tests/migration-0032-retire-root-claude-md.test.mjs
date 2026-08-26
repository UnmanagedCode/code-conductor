// Migration 0032: `<root>/CLAUDE.md` and its `<store>/workspace-claudemd/`
// ownership store are retired (workspace conventions now travel inside each
// project's own CONVENTIONS.md), and the dead `@../CLAUDE.md` import is stripped
// from every project's CLAUDE.md. Stages fake pre-migration roots under temp
// dirs.
//
// The REGISTRATION pin is an end-effect test that drives the whole
// `runMigrations({root})` chain rather than asserting `ALL.includes(m0032)`:
// only the end effect kills BOTH an unregistered mutant and a
// registered-but-broken one. M7 additionally pins the 0009 DEregistration — a
// migration whose "already applied?" probe is "does the store dir exist?" would
// otherwise re-seed on every boot the directory 0032 just removed.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { promises as fs } from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import { runMigrations } from '../migrations/index.mjs';
import * as m0032 from '../migrations/0032-retire-root-claude-md.mjs';

async function mkTempRoot() {
  return fs.mkdtemp(path.join(os.tmpdir(), 'orch-m0032-'));
}

async function exists(p) {
  try { await fs.access(p); return true; } catch { return false; }
}

async function withEnv(overrides, fn) {
  const keys = Object.keys(overrides);
  const saved = Object.fromEntries(keys.map(k => [k, process.env[k]]));
  for (const k of keys) {
    if (overrides[k] === undefined) delete process.env[k];
    else process.env[k] = overrides[k];
  }
  try { return await fn(); }
  finally {
    for (const k of keys) {
      if (saved[k] === undefined) delete process.env[k];
      else process.env[k] = saved[k];
    }
  }
}

const ownedDirOf = (root) => path.join(root, '.code-conductor', 'workspace-claudemd');
const sentinelOf = (root) => path.join(ownedDirOf(root), 'owned.json');
const targetOf = (root) => path.join(root, 'CLAUDE.md');

// Any `.bak-…` anywhere in the root — the retired ownership machinery's one
// artefact, which this migration must never reintroduce.
async function baks(root) {
  return (await fs.readdir(root)).filter(n => /^CLAUDE\.md\.bak-/.test(n));
}

async function stageOwned(root, { body = '# Workspace conventions\n\ngenerated\n' } = {}) {
  await fs.mkdir(ownedDirOf(root), { recursive: true });
  await fs.writeFile(sentinelOf(root), JSON.stringify({ ownedSince: 'whenever' }));
  await fs.writeFile(targetOf(root), body);
}

// M1 — the sentinel is the ownership oracle: present ⇒ the file is cc's own
// output by construction ⇒ delete it outright, no backup, no comparison.
test('M1: sentinel present → the root CLAUDE.md is deleted with no backup, store gone', async () => {
  const root = await mkTempRoot();
  try {
    await stageOwned(root);
    const res = await m0032.run({ root, log() {} });
    assert.equal(res.applied, true);
    assert.equal(res.summary.rootClaudeMd, 'deleted');
    assert.equal(await exists(targetOf(root)), false, 'the app-owned file is gone');
    assert.deepEqual(await baks(root), [], 'no .bak may be written');
    assert.equal(await exists(ownedDirOf(root)), false, 'the ownership store is gone');
  } finally { await fs.rm(root, { recursive: true, force: true }); }
});

// M2 — no sentinel ⇒ code-conductor never owned it ⇒ do not touch it, and say
// so. Kills a mutant that deletes unconditionally, and one that backs up.
test('M2: sentinel absent → the root CLAUDE.md is left byte-identical and logged', async () => {
  const root = await mkTempRoot();
  try {
    const body = 'MY OWN WORKSPACE FILE\n';
    await fs.writeFile(targetOf(root), body);
    const lines = [];
    const res = await m0032.run({ root, log: (l) => lines.push(l) });
    assert.notEqual(res.summary?.rootClaudeMd, 'deleted');
    assert.equal(await fs.readFile(targetOf(root), 'utf8'), body, 'byte-identical');
    assert.deepEqual(await baks(root), []);
    assert.ok(lines.some(l => l.includes(targetOf(root))),
      `expected a log line naming the file; got ${JSON.stringify(lines)}`);
  } finally { await fs.rm(root, { recursive: true, force: true }); }
});

// M3 — a post-migration / fresh install is a clean no-op.
test('M3: no sentinel and no root CLAUDE.md → applied:false, nothing created', async () => {
  const root = await mkTempRoot();
  try {
    const res = await m0032.run({ root, log() {} });
    assert.equal(res.applied, false);
    assert.equal(await exists(targetOf(root)), false);
    assert.equal(await exists(ownedDirOf(root)), false);
  } finally { await fs.rm(root, { recursive: true, force: true }); }
});

// M4 — step ordering: ownership must be read BEFORE the store dir is removed. A
// mutant that removes the store first lands in the "left" branch and the delete
// assertion fails.
test('M4: the sentinel is read before the store is removed — both effects in one run', async () => {
  const root = await mkTempRoot();
  try {
    await stageOwned(root);
    const res = await m0032.run({ root, log() {} });
    assert.equal(res.summary.rootClaudeMd, 'deleted');
    assert.equal(res.summary.ownershipStore, true);
    assert.equal(await exists(targetOf(root)), false);
    assert.equal(await exists(ownedDirOf(root)), false);
  } finally { await fs.rm(root, { recursive: true, force: true }); }
});

// M5 — the dead import line, stripped line-level, with every other byte kept.
test('M5: @../CLAUDE.md is stripped from project CLAUDE.md files, others untouched', async () => {
  const root = await mkTempRoot();
  try {
    await fs.mkdir(path.join(root, 'has-import'), { recursive: true });
    await fs.mkdir(path.join(root, 'no-import'), { recursive: true });
    await fs.writeFile(path.join(root, 'has-import', 'CLAUDE.md'), '@../CLAUDE.md\n@CONVENTIONS.md\n\n## Notes\n');
    const untouched = '@CONVENTIONS.md\n\n## Other\n';
    await fs.writeFile(path.join(root, 'no-import', 'CLAUDE.md'), untouched);

    const res = await m0032.run({ root, log() {} });
    assert.equal(res.applied, true);
    assert.equal(res.summary.importsStripped, 1);
    assert.equal(await fs.readFile(path.join(root, 'has-import', 'CLAUDE.md'), 'utf8'),
      '@CONVENTIONS.md\n\n## Notes\n', 'only the dead line goes; the rest is byte-identical');
    assert.equal(await fs.readFile(path.join(root, 'no-import', 'CLAUDE.md'), 'utf8'), untouched);
  } finally { await fs.rm(root, { recursive: true, force: true }); }
});

// M6 — idempotency, in both terminal states.
test('M6: a second run is a clean no-op in both the deleted and the left state', async () => {
  const owned = await mkTempRoot();
  const unowned = await mkTempRoot();
  try {
    await stageOwned(owned);
    assert.equal((await m0032.run({ root: owned, log() {} })).applied, true);
    const second = await m0032.run({ root: owned, log() {} });
    assert.equal(second.applied, false);
    assert.equal(await exists(targetOf(owned)), false, 'nothing is recreated');
    assert.equal(await exists(ownedDirOf(owned)), false);

    const body = 'MY OWN WORKSPACE FILE\n';
    await fs.writeFile(targetOf(unowned), body);
    assert.equal((await m0032.run({ root: unowned, log() {} })).applied, false, 'a left file is never "applied"');
    assert.equal((await m0032.run({ root: unowned, log() {} })).applied, false);
    assert.equal(await fs.readFile(targetOf(unowned), 'utf8'), body);
  } finally {
    await fs.rm(owned, { recursive: true, force: true });
    await fs.rm(unowned, { recursive: true, force: true });
  }
});

// M7 — the chain must converge. With 0009 still registered its "does
// baseline.md exist?" probe re-seeds `workspace-claudemd/` that 0032 has just
// removed, and both report `applied` on every boot, forever.
test('M7: the registered chain retires the store and does not oscillate on a second run', async () => {
  const root = await mkTempRoot();
  const legacyDir = await mkTempRoot();
  const legacy = path.join(legacyDir, 'CLAUDE.md.installed');
  try {
    await fs.writeFile(legacy, 'LEGACY CANONICAL\n');
    await stageOwned(root);
    await fs.mkdir(path.join(root, 'proj'), { recursive: true });
    await fs.writeFile(path.join(root, 'proj', 'CLAUDE.md'), '@../CLAUDE.md\n@CONVENTIONS.md\n');

    await withEnv({ TCC_LEGACY_BASELINE: legacy }, async () => {
      const first = [];
      await runMigrations({ root, log: (l) => first.push(String(l)) });
      assert.equal(await exists(targetOf(root)), false, 'the registered chain deletes the owned root file');
      assert.equal(await exists(ownedDirOf(root)), false, 'and removes the ownership store');
      assert.equal(await fs.readFile(path.join(root, 'proj', 'CLAUDE.md'), 'utf8'), '@CONVENTIONS.md\n');

      const second = [];
      await runMigrations({ root, log: (l) => second.push(String(l)) });
      assert.equal(await exists(ownedDirOf(root)), false, 'nothing re-seeds the retired store');
      const noisy = second.filter(l => /migration 0(009|032)\S*: applied/.test(l));
      assert.deepEqual(noisy, [], `the chain must be quiet on the second run; got ${JSON.stringify(second)}`);
    });
  } finally {
    await fs.rm(root, { recursive: true, force: true });
    await fs.rm(legacyDir, { recursive: true, force: true });
  }
});
