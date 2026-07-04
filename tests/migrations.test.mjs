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

    // Project metadata moved. 0002 also runs and renames group → workspace.
    const projectMeta = path.join(root, '.code-conductor', 'projects', 'alpha', 'project.json');
    assert.equal(JSON.parse(await fs.readFile(projectMeta, 'utf8')).workspace, 'Work');

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

    // State unchanged. 0002 ran on the first pass and converted to workspace.
    const projectMeta = path.join(root, '.code-conductor', 'projects', 'gamma', 'project.json');
    assert.equal(JSON.parse(await fs.readFile(projectMeta, 'utf8')).workspace, 'G');
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

    // Destination preserved by 0001; 0002 then renames its `group` key to
    // `workspace` (its job is to upgrade any project.json in the central
    // store, including those 0001 left in place).
    const destFile = path.join(destDir, 'project.json');
    const destBody = JSON.parse(await fs.readFile(destFile, 'utf8'));
    assert.equal(destBody.workspace, 'PRE-EXISTING');
    assert.ok(!('group' in destBody), 'group key removed by 0002');

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
    // Pin 0009's legacy-baseline lookup off the real machine's home dir —
    // this test wants a truly empty workspace with no migration output.
    await withEnv({ TCC_LEGACY_BASELINE: path.join(root, 'no-legacy') }, async () => {
      await runMigrations({ root, log: (...args) => logs.push(args.join(' ')) });
    });

    assert.deepEqual(logs, []);
  } finally {
    await fs.rm(root, { recursive: true, force: true });
  }
});

test('0002 migration: renames group → workspace and seeds workspaces.json', async () => {
  const root = await mkTempRoot();
  try {
    // Stage post-0001 state directly in the central store: two projects
    // each with a `group` field, one project with neither field.
    await writeJson(
      path.join(root, '.code-conductor', 'projects', 'a', 'project.json'),
      { group: 'Work' },
    );
    await writeJson(
      path.join(root, '.code-conductor', 'projects', 'b', 'project.json'),
      { group: 'Side' },
    );
    await writeJson(
      path.join(root, '.code-conductor', 'projects', 'c', 'project.json'),
      { somethingElse: 'x' },
    );

    const logs = [];
    await runMigrations({ root, log: (...args) => logs.push(args.join(' ')) });

    // group → workspace on every affected file.
    const a = JSON.parse(await fs.readFile(path.join(root, '.code-conductor', 'projects', 'a', 'project.json'), 'utf8'));
    assert.equal(a.workspace, 'Work');
    assert.ok(!('group' in a));
    const b = JSON.parse(await fs.readFile(path.join(root, '.code-conductor', 'projects', 'b', 'project.json'), 'utf8'));
    assert.equal(b.workspace, 'Side');
    // The unrelated project is untouched.
    const c = JSON.parse(await fs.readFile(path.join(root, '.code-conductor', 'projects', 'c', 'project.json'), 'utf8'));
    assert.equal(c.somethingElse, 'x');

    // Registry seeded with the union of observed values.
    const reg = JSON.parse(await fs.readFile(path.join(root, '.code-conductor', 'workspaces.json'), 'utf8'));
    assert.deepEqual(reg.workspaces, ['Side', 'Work']);
    assert.ok(logs.some(l => l.includes('migration 0002')), 'first run logs 0002');

    // Second run is a fast no-op (no groups remain + registry exists).
    const logs2 = [];
    await runMigrations({ root, log: (...args) => logs2.push(args.join(' ')) });
    assert.ok(!logs2.some(l => l.includes('migration 0002')), 'second run does not log 0002');
  } finally {
    await fs.rm(root, { recursive: true, force: true });
  }
});

test('0002 migration: prefers existing workspace field if both keys are present', async () => {
  const root = await mkTempRoot();
  try {
    const file = path.join(root, '.code-conductor', 'projects', 'dual', 'project.json');
    await writeJson(file, { group: 'Old', workspace: 'New' });
    await runMigrations({ root, log: () => {} });
    const body = JSON.parse(await fs.readFile(file, 'utf8'));
    assert.equal(body.workspace, 'New');
    assert.ok(!('group' in body));
    // The newer (workspace) value is what gets seeded into the registry.
    const reg = JSON.parse(await fs.readFile(path.join(root, '.code-conductor', 'workspaces.json'), 'utf8'));
    assert.deepEqual(reg.workspaces, ['New']);
  } finally {
    await fs.rm(root, { recursive: true, force: true });
  }
});
