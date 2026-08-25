// Migration 0031: the conductor role doc moved onto the messages stream, so an
// existing install needs `.conduct/CLAUDE.md` to carry an `@CONVENTIONS.md`
// import, and the retired `<root>/.code-conductor/conductor-prompt.md` orphan
// gone. Stages a fake pre-migration root under a temp dir.
//
// The REGISTRATION pin is an end-effect test that drives the whole
// `runMigrations({root})` chain rather than asserting `ALL.includes(m0031)`:
// only the end effect kills BOTH an unregistered mutant and a
// registered-but-broken one.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { promises as fs } from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import { runMigrations } from '../migrations/index.mjs';
import * as m0031 from '../migrations/0031-conduct-conventions-import.mjs';

async function mkTempRoot() {
  return fs.mkdtemp(path.join(os.tmpdir(), 'orch-m0031-'));
}

async function exists(p) {
  try { await fs.access(p); return true; } catch { return false; }
}

const IMPORTED = (text) => text.split('\n').some(l => l.trim() === '@CONVENTIONS.md');

test('a legacy install is repaired end-to-end by the registered chain', async () => {
  const root = await mkTempRoot();
  const claudeMd = path.join(root, '.conduct', 'CLAUDE.md');
  const promptMd = path.join(root, '.code-conductor', 'conductor-prompt.md');
  await fs.mkdir(path.join(root, '.conduct'), { recursive: true });
  await fs.mkdir(path.join(root, '.code-conductor'), { recursive: true });
  const userContent = '# custom\n\n## Shorthand\n- keep me\n';
  await fs.writeFile(claudeMd, userContent);
  await fs.writeFile(promptMd, '# stale\n');

  await runMigrations({ root, log() {} });

  const after = await fs.readFile(claudeMd, 'utf8');
  assert.ok(IMPORTED(after), 'the import line is present');
  assert.match(after, /## Shorthand/, 'user content survives');
  assert.match(after, /- keep me/);
  assert.equal(await exists(promptMd), false, 'the store orphan is removed');
});

test('the 0022 → 0031 hand-off: a lone @CONDUCT.md seed becomes a fresh @CONVENTIONS.md file', async () => {
  // Only correct in CHAIN order: 0022 unlinks a CLAUDE.md whose sole line is the
  // old `@CONDUCT.md` seed, and 0031 must then create a fresh one carrying the
  // new import. A direct m0031.run() cannot observe this — it would see the
  // seed file still there and merely prepend to it.
  const root = await mkTempRoot();
  const claudeMd = path.join(root, '.conduct', 'CLAUDE.md');
  await fs.mkdir(path.join(root, '.conduct'), { recursive: true });
  await fs.writeFile(claudeMd, '@CONDUCT.md\n');

  await runMigrations({ root, log() {} });

  const after = await fs.readFile(claudeMd, 'utf8');
  assert.equal(after, '@CONVENTIONS.md\n', 'the dead seed is gone, the live import is there');
});

test('no .conduct dir: the store orphan is still removed, and CLAUDE.md is left alone', async () => {
  const root = await mkTempRoot();
  const promptMd = path.join(root, '.code-conductor', 'conductor-prompt.md');
  await fs.mkdir(path.join(root, '.code-conductor'), { recursive: true });
  await fs.writeFile(promptMd, '# stale\n');

  // The two halves are independent: a missing .conduct must not skip half 1.
  const r = await m0031.run({ root, log() {} });
  assert.equal(r.applied, true);
  assert.equal(r.summary.promptRemoved, true);
  assert.equal(r.summary.claudeMd, false, 'nothing to do on a fresh install with no .conduct');
  assert.equal(await exists(promptMd), false);
  assert.equal(await exists(path.join(root, '.conduct')), false, 'the dir is not created here');
});

test('a fresh install with neither artefact reports applied:false', async () => {
  const root = await mkTempRoot();
  const r = await m0031.run({ root, log() {} });
  assert.equal(r.applied, false);
});

test('an already-imported CLAUDE.md gains no duplicate line and is not rewritten', async () => {
  const root = await mkTempRoot();
  const claudeMd = path.join(root, '.conduct', 'CLAUDE.md');
  await fs.mkdir(path.join(root, '.conduct'), { recursive: true });
  const content = '@CONVENTIONS.md\n\n# mine\n';
  await fs.writeFile(claudeMd, content);

  const r = await m0031.run({ root, log() {} });
  assert.equal(r.applied, false, 'nothing to do');
  const after = await fs.readFile(claudeMd, 'utf8');
  assert.equal(after, content, 'byte-identical — no write');
  assert.equal(after.split('\n').filter(l => l.trim() === '@CONVENTIONS.md').length, 1);
});

test('import detection is LINE-level: prose mentioning @CONVENTIONS.md still gains a standalone import', async () => {
  // Same invariant as src/conduct.ts's ensureConductClaudeMd, pinned again here
  // because the migration DUPLICATES that logic (built-ins only — it cannot
  // import the TS), so it carries the same exposure independently. A substring
  // check would read the prose as already-imported and leave a migrated install
  // with no import line at all.
  const root = await mkTempRoot();
  const claudeMd = path.join(root, '.conduct', 'CLAUDE.md');
  await fs.mkdir(path.join(root, '.conduct'), { recursive: true });
  const prose = 'see @CONVENTIONS.md notes';
  const userContent = `# custom\n\n${prose}\n`;
  await fs.writeFile(claudeMd, userContent);
  assert.ok(userContent.includes('@CONVENTIONS.md'), 'fixture: a substring check matches');
  assert.ok(!IMPORTED(userContent), 'fixture: no standalone import line yet');

  const r = await m0031.run({ root, log() {} });
  assert.equal(r.applied, true);
  assert.equal(r.summary.claudeMd, 'prepended');

  const after = await fs.readFile(claudeMd, 'utf8');
  assert.ok(IMPORTED(after), 'a standalone import line was added despite the prose mention');
  assert.ok(after.endsWith(userContent), 'the prose survives byte-for-byte');
});

test('idempotent: a second run is applied:false and leaves both files byte-identical', async () => {
  const root = await mkTempRoot();
  const claudeMd = path.join(root, '.conduct', 'CLAUDE.md');
  const promptMd = path.join(root, '.code-conductor', 'conductor-prompt.md');
  await fs.mkdir(path.join(root, '.conduct'), { recursive: true });
  await fs.mkdir(path.join(root, '.code-conductor'), { recursive: true });
  await fs.writeFile(claudeMd, '# custom\n');
  await fs.writeFile(promptMd, '# stale\n');

  const first = await m0031.run({ root, log() {} });
  assert.equal(first.applied, true);
  assert.equal(first.summary.claudeMd, 'prepended');
  const afterFirst = await fs.readFile(claudeMd, 'utf8');

  const second = await m0031.run({ root, log() {} });
  assert.equal(second.applied, false);
  assert.equal(await fs.readFile(claudeMd, 'utf8'), afterFirst);
  assert.equal(await exists(promptMd), false);
});
