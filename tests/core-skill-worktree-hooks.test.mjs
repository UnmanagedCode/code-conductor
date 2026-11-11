// The core skill code-conductor:worktree-hooks (claude-plugin/skills/
// worktree-hooks/SKILL.md) teaches agents where to put a worktree hook and
// gives runnable recipes. Every ```bash <label> sample in it is run here,
// unchanged: the placement samples install a hook the way the skill says, and
// cc's real create / merge paths then run the recipe samples as hooks.
import { test, before, after, beforeEach, afterEach } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync, promises as fs } from 'node:fs';
import path from 'node:path';
import { execFile } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { bootServer, freshProjectsRoot, rmrf, registerLocalProject } from './helpers.mjs';
import { createWorktree, mergeWorktreeIntoParent, runWorktreeHook } from '../src/worktrees.ts';
import { projectStoreDir } from '../src/projects.ts';
import { LocalSystem } from '../src/systems/localSystem.ts';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const SCENARIO = path.join(__dirname, 'fixtures', 'scenario-instance.json');
const SKILL = path.join(__dirname, '..', 'claude-plugin', 'skills', 'worktree-hooks', 'SKILL.md');
const CREATE = 'post-worktree-create.sh';
const MERGE = 'post-worktree-merge.sh';

function samples() {
  const out = {};
  for (const m of readFileSync(SKILL, 'utf8').matchAll(/^```bash ([\w-]+)\n([\s\S]*?)\n```$/gm)) {
    assert.equal(out[m[1]], undefined, `duplicate sample label ${m[1]}`);
    out[m[1]] = m[2];
  }
  return out;
}

let ctx, instances, home, projectsRoot, S;
before(async () => { ctx = await bootServer({ scenarioPath: SCENARIO }); ({ instances } = ctx); S = samples(); });
after(async () => { await ctx.close(); });
beforeEach(async () => { ({ home, projectsRoot } = await freshProjectsRoot()); });
afterEach(async () => { await instances.shutdown(); await rmrf(home); });

function run(cmd, args, opts) {
  return new Promise((resolve, reject) => {
    execFile(cmd, args, { encoding: 'utf8', ...opts }, (err, stdout, stderr) => {
      if (err) { err.message += `\n${stdout}${stderr}`; reject(err); } else resolve(stdout);
    });
  });
}
const git = (cwd, ...args) => run('git', ['-C', cwd, ...args]);
const porcelain = (cwd) => git(cwd, 'status', '--porcelain');

// Write a sample to a file outside every tree, so it can be SRC or run as-is.
async function sampleFile(label) {
  assert.ok(S[label], `SKILL.md has no \`\`\`bash ${label} sample`);
  const file = path.join(home, `${label}.sh`);
  await fs.writeFile(file, S[label] + '\n');
  return file;
}

// Run a placement sample with cwd in `cwd`, as an agent would.
async function place(label, cwd, env) {
  await run('bash', [await sampleFile(label)], { cwd, env: { ...process.env, ...env } });
}

// A project whose .gitignore uses the SLASH form for node_modules on purpose:
// that pattern does not match a symlink, so only the sample's exclude entry can
// keep a linked node_modules out of `git status`. The parent has both sources.
async function makeRepo(name = 'demo') {
  const repo = path.join(projectsRoot, name);
  await fs.mkdir(path.join(repo, 'node_modules', 'pkg'), { recursive: true });
  await registerLocalProject(name, repo);
  await git(repo, 'init', '-q', '-b', 'main');
  await git(repo, 'config', 'user.email', 'test@example.com');
  await git(repo, 'config', 'user.name', 'test');
  await git(repo, 'config', 'commit.gpgsign', 'false');
  await fs.writeFile(path.join(repo, '.gitignore'), '.env\nnode_modules/\n');
  await fs.writeFile(path.join(repo, 'package.json'), '{"name":"demo"}\n');
  await fs.writeFile(path.join(repo, 'package-lock.json'), '{"lockfileVersion":3}\n');
  await fs.writeFile(path.join(repo, 'README.md'), '# demo\n');
  await git(repo, 'add', '.');
  await git(repo, 'commit', '-q', '-m', 'initial');
  await fs.writeFile(path.join(repo, '.env'), 'SECRET=1\n');
  await fs.writeFile(path.join(repo, 'node_modules', 'pkg', 'index.js'), '\n');
  return repo;
}

async function excludeLines(repo) {
  const file = path.join(repo, '.git', 'info', 'exclude');
  return (await fs.readFile(file, 'utf8')).split('\n');
}

// Each name is a symlink to the same name in the worktree's parent checkout.
async function assertLinked(wt) {
  for (const name of ['node_modules', '.env']) {
    const p = path.join(wt.worktreePath, name);
    assert.ok((await fs.lstat(p)).isSymbolicLink(), `${name} is a symlink`);
    assert.equal(await fs.readlink(p), path.join(wt.parentPath, name));
  }
}

// ── Labels ─────────────────────────────────────────────────────────────────

test('SKILL.md carries exactly the labelled samples this file runs', () => {
  assert.deepEqual(Object.keys(S).sort(), [
    'create-link-from-parent', 'merge-install-deps', 'place-store', 'place-tracked', 'place-untracked',
  ]);
});

// ── Create recipe, by placement ────────────────────────────────────────────

test('A (tracked) + create-link-from-parent: links both names, the worktree stays clean, one exclude entry each', async () => {
  const repo = await makeRepo();
  await place('place-tracked', repo, { SRC: await sampleFile('create-link-from-parent'), HOOK: CREATE });
  assert.equal(await porcelain(repo), '', 'the tracked hook is committed');
  const wt = await createWorktree('demo');
  const h = wt.postWorktreeCreate;
  assert.equal(h.source, 'in-tree', JSON.stringify(h));
  assert.equal(h.exitCode, 0, JSON.stringify(h));
  await assertLinked(wt);
  assert.equal(await porcelain(wt.worktreePath), '', 'the /<name> exclude entries hide the symlinks');
  const lines = await excludeLines(repo);
  for (const e of ['/node_modules', '/.env']) assert.equal(lines.filter((l) => l === e).length, 1, e);
});

test('create-link-from-parent re-run on the same worktree: exit 0, no duplicate entries, links unchanged', async () => {
  const repo = await makeRepo();
  await place('place-tracked', repo, { SRC: await sampleFile('create-link-from-parent'), HOOK: CREATE });
  const wt = await createWorktree('demo');
  assert.equal(wt.postWorktreeCreate.exitCode, 0, JSON.stringify(wt.postWorktreeCreate));
  const again = await runWorktreeHook(new LocalSystem(), 'create', wt, { cwd: wt.worktreePath });
  assert.equal(again.exitCode, 0, JSON.stringify(again));
  await assertLinked(wt);
  const lines = await excludeLines(repo);
  for (const e of ['/node_modules', '/.env']) assert.equal(lines.filter((l) => l === e).length, 1, e);
  assert.equal(await porcelain(wt.worktreePath), '');
});

test('create-link-from-parent with a source missing in the parent: warns, links the rest, exit 0', async () => {
  const repo = await makeRepo();
  await place('place-tracked', repo, { SRC: await sampleFile('create-link-from-parent'), HOOK: CREATE });
  await fs.rm(path.join(repo, '.env'));
  const wt = await createWorktree('demo');
  const h = wt.postWorktreeCreate;
  assert.equal(h.exitCode, 0, JSON.stringify(h));
  assert.match(h.output, /WARNING.*\.env/);
  assert.ok((await fs.lstat(path.join(wt.worktreePath, 'node_modules'))).isSymbolicLink());
  await assert.rejects(fs.lstat(path.join(wt.worktreePath, '.env')), { code: 'ENOENT' });
});

test('create-link-from-parent leaves a dangling link in place rather than failing on it', async () => {
  const repo = await makeRepo();
  await place('place-tracked', repo, { SRC: await sampleFile('create-link-from-parent'), HOOK: CREATE });
  const wt = await createWorktree('demo');
  const env = path.join(wt.worktreePath, '.env');
  const dangling = path.join(home, 'no-such-env');
  await fs.rm(env);
  await fs.symlink(dangling, env);
  const again = await runWorktreeHook(new LocalSystem(), 'create', wt, { cwd: wt.worktreePath });
  assert.equal(again.exitCode, 0, JSON.stringify(again));
  assert.equal(await fs.readlink(env), dangling);
});

test('control: a node_modules/ pattern alone does not hide a symlinked node_modules', async () => {
  const repo = await makeRepo();
  const wt = await createWorktree('demo');
  assert.equal(wt.postWorktreeCreate.ran, false, 'premise: no hook');
  await fs.symlink(path.join(repo, 'node_modules'), path.join(wt.worktreePath, 'node_modules'));
  assert.match(await porcelain(wt.worktreePath), /^\?\? node_modules$/m);
});

test('C (store) + create-link-from-parent: runs from the store with the same outcome', async () => {
  const repo = await makeRepo();
  await place('place-store', home, {
    SRC: await sampleFile('create-link-from-parent'), HOOK: CREATE, PROJECT: 'demo', CC_PROJECTS_ROOT: projectsRoot,
  });
  await fs.access(path.join(projectStoreDir('demo'), CREATE));
  assert.equal(await porcelain(repo), '', 'the store is outside the tree');
  const wt = await createWorktree('demo');
  const h = wt.postWorktreeCreate;
  assert.equal(h.source, 'store', JSON.stringify(h));
  assert.equal(h.exitCode, 0, JSON.stringify(h));
  await assertLinked(wt);
  assert.equal(await porcelain(wt.worktreePath), '');
});

test('B (untracked): without the exclude line the root reads dirty; place-untracked keeps it clean and the hook runs in-tree', async () => {
  const repo = await makeRepo();
  const src = await sampleFile('create-link-from-parent');
  await fs.mkdir(path.join(repo, '.code-conductor'));
  await fs.copyFile(src, path.join(repo, '.code-conductor', CREATE));
  assert.notEqual(await porcelain(repo), '', 'an unexcluded untracked hook dirties the merge target');
  await fs.rm(path.join(repo, '.code-conductor'), { recursive: true });

  await place('place-untracked', repo, { SRC: src, HOOK: CREATE });
  assert.equal(await porcelain(repo), '');
  const wt = await createWorktree('demo');
  assert.equal(wt.postWorktreeCreate.source, 'in-tree', JSON.stringify(wt.postWorktreeCreate));
  assert.equal(wt.postWorktreeCreate.exitCode, 0);
  await assertLinked(wt);
});

test('B (untracked): a derived worktree runs no in-tree hook; a store copy then runs instead', async () => {
  const repo = await makeRepo();
  const src = await sampleFile('create-link-from-parent');
  await place('place-untracked', repo, { SRC: src, HOOK: CREATE });
  const feature = await createWorktree('demo', { name: 'feat' });
  assert.equal(feature.postWorktreeCreate.source, 'in-tree', 'premise: the root-based worktree ran it');
  const task = await createWorktree('demo', { name: 'task', baseWorktree: feature.worktreeName });
  assert.deepEqual(task.postWorktreeCreate, { ran: false });

  await place('place-store', home, { SRC: src, HOOK: CREATE, PROJECT: 'demo', CC_PROJECTS_ROOT: projectsRoot });
  const task2 = await createWorktree('demo', { name: 'task2', baseWorktree: feature.worktreeName });
  assert.equal(task2.postWorktreeCreate.source, 'store', JSON.stringify(task2.postWorktreeCreate));
  assert.equal(task2.postWorktreeCreate.exitCode, 0);
});

// ── Merge recipe ───────────────────────────────────────────────────────────

// A fake `npm` first on PATH: logs "<cwd> <argv>" outside every tree and writes
// into node_modules/ in its cwd, as a real install would.
async function withFakeNpm(body) {
  const bin = path.join(home, 'bin');
  const log = path.join(home, 'npm.log');
  await fs.mkdir(bin, { recursive: true });
  await fs.writeFile(path.join(bin, 'npm'),
    `#!/bin/sh\necho "$(pwd -P) $*" >> ${JSON.stringify(log)}\nmkdir -p node_modules && touch node_modules/.fake\n`,
    { mode: 0o755 });
  const prev = process.env.PATH;
  process.env.PATH = `${bin}${path.delimiter}${prev}`;
  try { await body(); } finally { process.env.PATH = prev; }
  return fs.readFile(log, 'utf8').catch((e) => { if (e.code === 'ENOENT') return ''; throw e; });
}

async function commitIn(dir, file, content) {
  await fs.writeFile(path.join(dir, file), content);
  await git(dir, 'add', '-A');
  await git(dir, 'commit', '-q', '-m', `change ${file}`);
}

async function repoWithMergeHook() {
  const repo = await makeRepo();
  await place('place-tracked', repo, { SRC: await sampleFile('merge-install-deps'), HOOK: MERGE });
  return repo;
}

test('merge-install-deps, dependencies unchanged: no install', async () => {
  await repoWithMergeHook();
  const wt = await createWorktree('demo');
  await commitIn(wt.worktreePath, 'feature.txt', 'x\n');
  let r;
  const log = await withFakeNpm(async () => { r = await mergeWorktreeIntoParent('demo', wt.worktreeName); });
  assert.equal(r.ok, true, JSON.stringify(r));
  assert.equal(r.postWorktreeMerge.exitCode, 0, JSON.stringify(r.postWorktreeMerge));
  assert.equal(log, '');
});

test('merge-install-deps, lockfile changed: one `npm ci` in the root, and the root stays clean', async () => {
  const repo = await repoWithMergeHook();
  const wt = await createWorktree('demo');
  await commitIn(wt.worktreePath, 'package-lock.json', '{"lockfileVersion":3,"packages":{}}\n');
  let r;
  const log = await withFakeNpm(async () => { r = await mergeWorktreeIntoParent('demo', wt.worktreeName); });
  assert.equal(r.ok, true, JSON.stringify(r));
  assert.equal(r.postWorktreeMerge.exitCode, 0, JSON.stringify(r.postWorktreeMerge));
  assert.equal(log, `${await fs.realpath(repo)} ci\n`);
  assert.equal(await porcelain(repo), '', 'the next merge is not refused PARENT_DIRTY');
});

test('merge-install-deps, a task merged into its feature worktree: skipped, no install', async () => {
  await repoWithMergeHook();
  const feature = await createWorktree('demo', { name: 'feat' });
  const task = await createWorktree('demo', { name: 'task', baseWorktree: feature.worktreeName });
  await commitIn(task.worktreePath, 'package-lock.json', '{"lockfileVersion":3,"packages":{}}\n');
  let r;
  const log = await withFakeNpm(async () => { r = await mergeWorktreeIntoParent('demo', task.worktreeName); });
  assert.equal(r.ok, true, JSON.stringify(r));
  assert.equal(r.postWorktreeMerge.source, 'in-tree', 'premise: the feature checkout has the tracked hook');
  assert.equal(r.postWorktreeMerge.exitCode, 0, JSON.stringify(r.postWorktreeMerge));
  assert.equal(log, '');
});
