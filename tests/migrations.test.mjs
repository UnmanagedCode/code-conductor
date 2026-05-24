// Unit tests for the migration runner + the 0001 centralization
// migration. Stages a fake pre-migration workspace under a temp dir,
// runs the migration, and asserts the resulting layout.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { promises as fs } from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import { runMigrations } from '../migrations/index.mjs';

async function mkTempRoot() {
  return fs.mkdtemp(path.join(os.tmpdir(), 'orch-migration-'));
}

async function exists(p) {
  try { await fs.access(p); return true; } catch { return false; }
}

async function writeJson(p, obj) {
  await fs.mkdir(path.dirname(p), { recursive: true });
  await fs.writeFile(p, JSON.stringify(obj, null, 2));
}

test('0001 migration: moves project + worktree state into the central store', async () => {
  const root = await mkTempRoot();
  try {
    // Stage a fake pre-migration workspace.
    //   <root>/alpha/                                         ← normal project
    //   <root>/alpha/.code-conductor/project.json
    //   <root>/alpha/.code-conductor/attachments/a.png
    //   <root>/alpha/.code-conductor/debug/inst-1/meta.json
    //   <root>/alpha/.gitignore                                ← carries `.code-conductor/`
    //   <root>/alpha_worktree_abc/                             ← worktree dir
    //   <root>/alpha_worktree_abc/.code-conductor/worktree.json
    //   <root>/alpha_worktree_abc/.code-conductor/attachments/w.png
    //   <root>/alpha_worktree_abc/.git                         ← `gitdir: ./.git-fake`
    //   <root>/alpha_worktree_abc/.git-fake/info/exclude       ← carries `/.code-conductor/`
    //   <root>/beta/                                           ← project with nothing of ours

    await fs.mkdir(path.join(root, 'alpha'), { recursive: true });
    await fs.writeFile(path.join(root, 'alpha', '.gitignore'), 'node_modules/\n.code-conductor/\nserver.log\n');
    await writeJson(path.join(root, 'alpha', '.code-conductor', 'project.json'), { group: 'Work' });
    await fs.mkdir(path.join(root, 'alpha', '.code-conductor', 'attachments'), { recursive: true });
    await fs.writeFile(path.join(root, 'alpha', '.code-conductor', 'attachments', 'a.png'), 'PNG');
    await fs.mkdir(path.join(root, 'alpha', '.code-conductor', 'debug', 'inst-1'), { recursive: true });
    await fs.writeFile(path.join(root, 'alpha', '.code-conductor', 'debug', 'inst-1', 'meta.json'), '{}');

    const wtDir = path.join(root, 'alpha_worktree_abc');
    await fs.mkdir(wtDir, { recursive: true });
    await writeJson(path.join(wtDir, '.code-conductor', 'worktree.json'), {
      parentProject: 'alpha',
      worktreeName: 'alpha_worktree_abc',
      branch: 'code-conductor/abc',
      baseBranch: 'main',
      baseSha: 'deadbeef',
    });
    await fs.mkdir(path.join(wtDir, '.code-conductor', 'attachments'), { recursive: true });
    await fs.writeFile(path.join(wtDir, '.code-conductor', 'attachments', 'w.png'), 'PNGW');

    // Fake linked-worktree git pointer + per-worktree exclude file.
    const fakeGitDir = path.join(wtDir, '.git-fake');
    await fs.mkdir(path.join(fakeGitDir, 'info'), { recursive: true });
    await fs.writeFile(path.join(fakeGitDir, 'info', 'exclude'), '# auto\n/.code-conductor/\n');
    await fs.writeFile(path.join(wtDir, '.git'), `gitdir: ./.git-fake\n`);

    await fs.mkdir(path.join(root, 'beta'), { recursive: true }); // nothing of ours

    const logs = [];
    await runMigrations({ root, log: (...args) => logs.push(args.join(' ')) });

    // Project metadata moved.
    const projectMeta = path.join(root, '.code-conductor', 'projects', 'alpha', 'project.json');
    assert.equal(JSON.parse(await fs.readFile(projectMeta, 'utf8')).group, 'Work');

    // Project attachments + debug moved.
    assert.equal(
      await fs.readFile(path.join(root, '.code-conductor', 'projects', 'alpha', 'attachments', 'a.png'), 'utf8'),
      'PNG',
    );
    assert.ok(await exists(path.join(root, '.code-conductor', 'projects', 'alpha', 'debug', 'inst-1', 'meta.json')));

    // Worktree metadata + attachments moved.
    const wtMeta = path.join(root, '.code-conductor', 'projects', 'alpha', 'worktrees', 'alpha_worktree_abc', 'worktree.json');
    assert.equal(JSON.parse(await fs.readFile(wtMeta, 'utf8')).parentProject, 'alpha');
    assert.equal(
      await fs.readFile(path.join(root, '.code-conductor', 'projects', 'alpha', 'worktrees', 'alpha_worktree_abc', 'attachments', 'w.png'), 'utf8'),
      'PNGW',
    );

    // Old in-tree dotfolders removed.
    assert.equal(await exists(path.join(root, 'alpha', '.code-conductor')), false);
    assert.equal(await exists(path.join(wtDir, '.code-conductor')), false);

    // .gitignore line stripped.
    const gitignore = await fs.readFile(path.join(root, 'alpha', '.gitignore'), 'utf8');
    assert.ok(!gitignore.includes('.code-conductor/'), `.code-conductor line should be stripped, got: ${gitignore}`);

    // .git/info/exclude line stripped (via the linked-worktree pointer).
    const exclude = await fs.readFile(path.join(fakeGitDir, 'info', 'exclude'), 'utf8');
    assert.ok(!exclude.includes('/.code-conductor/'), `exclude line should be stripped, got: ${exclude}`);

    // beta untouched.
    assert.equal(await exists(path.join(root, '.code-conductor', 'projects', 'beta')), false);
  } finally {
    await fs.rm(root, { recursive: true, force: true });
  }
});

test('0001 migration: second run is a fast no-op', async () => {
  const root = await mkTempRoot();
  try {
    // Stage minimal pre-migration state.
    await writeJson(
      path.join(root, 'gamma', '.code-conductor', 'project.json'),
      { group: 'G' },
    );

    const firstLogs = [];
    await runMigrations({ root, log: (...args) => firstLogs.push(args.join(' ')) });

    // The first run logged the "applied" line.
    assert.ok(firstLogs.some(l => l.includes('migration 0001')), 'first run logs migration line');

    // Second run: should detect already-applied and log nothing.
    const secondLogs = [];
    await runMigrations({ root, log: (...args) => secondLogs.push(args.join(' ')) });
    assert.deepEqual(secondLogs, [], 'second run produces no log lines');

    // State unchanged.
    const projectMeta = path.join(root, '.code-conductor', 'projects', 'gamma', 'project.json');
    assert.equal(JSON.parse(await fs.readFile(projectMeta, 'utf8')).group, 'G');
  } finally {
    await fs.rm(root, { recursive: true, force: true });
  }
});

test('0001 migration: refuses to clobber a pre-existing non-empty destination', async () => {
  const root = await mkTempRoot();
  try {
    // Stage source state.
    await writeJson(path.join(root, 'delta', '.code-conductor', 'project.json'), { group: 'D' });

    // And a pre-existing destination with conflicting content.
    const destDir = path.join(root, '.code-conductor', 'projects', 'delta');
    await fs.mkdir(destDir, { recursive: true });
    await fs.writeFile(path.join(destDir, 'project.json'), '{"group":"PRE-EXISTING"}');

    const logs = [];
    await runMigrations({ root, log: (...args) => logs.push(args.join(' ')) });

    // Source is preserved (we didn't move over the pre-existing file).
    const src = path.join(root, 'delta', '.code-conductor', 'project.json');
    assert.ok(await exists(src), 'source file should remain in place when destination is non-empty');

    // Destination is unchanged.
    const destFile = path.join(destDir, 'project.json');
    assert.equal((await fs.readFile(destFile, 'utf8')).trim(), '{"group":"PRE-EXISTING"}');

    // A warning was logged.
    assert.ok(logs.some(l => l.includes('skipping')), `expected a "skipping" warning; got: ${logs.join('\n')}`);
  } finally {
    await fs.rm(root, { recursive: true, force: true });
  }
});

test('0001 migration: no candidates → applied:false, no log output', async () => {
  const root = await mkTempRoot();
  try {
    // Just an empty project dir, nothing of ours.
    await fs.mkdir(path.join(root, 'epsilon'), { recursive: true });

    const logs = [];
    await runMigrations({ root, log: (...args) => logs.push(args.join(' ')) });

    assert.deepEqual(logs, []);
  } finally {
    await fs.rm(root, { recursive: true, force: true });
  }
});
