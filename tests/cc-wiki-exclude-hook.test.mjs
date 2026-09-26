// cc's own .code-conductor/post-worktree-create.sh keeps the out-of-tree .wiki
// out of `git status`. Drives the real script with bash against a temp repo +
// worktree — never this checkout, whose common info/exclude it would append to.

import { test, afterEach } from 'node:test';
import assert from 'node:assert/strict';
import { promises as fs } from 'node:fs';
import path from 'node:path';
import { execFile } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { mkdtemp } from './tmpRegistry.mjs';
import { rmrf } from './rmrf.mjs';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const HOOK = path.join(__dirname, '..', '.code-conductor', 'post-worktree-create.sh');

let dir;
afterEach(async () => { if (dir) await rmrf(dir); dir = undefined; });

function run(cmd, args, opts = {}) {
  return new Promise((resolve) => {
    execFile(cmd, args, { encoding: 'utf8', ...opts }, (err, stdout, stderr) => {
      resolve({ code: err ? (err.code ?? 1) : 0, stdout, stderr });
    });
  });
}

async function git(cwd, ...args) {
  const r = await run('git', ['-C', cwd, ...args]);
  if (r.code !== 0) throw new Error(`git ${args.join(' ')} failed (${r.code}): ${r.stderr}`);
  return r.stdout;
}

// A main checkout with one commit and a linked worktree at <dir>/wt.
async function makeRepo() {
  dir = await mkdtemp('cc-wiki-');
  const main = path.join(dir, 'main');
  await fs.mkdir(main);
  await git(main, 'init', '-q', '-b', 'main');
  await git(main, 'config', 'user.email', 'test@example.com');
  await git(main, 'config', 'user.name', 'test');
  await git(main, 'config', 'commit.gpgsign', 'false');
  await fs.writeFile(path.join(main, 'README.md'), 'x\n');
  await git(main, 'add', 'README.md');
  await git(main, 'commit', '-q', '-m', 'init');
  await git(main, 'worktree', 'add', '-q', '../wt', '-b', 't');
  return { main, wt: path.join(dir, 'wt') };
}

function runHook(cwd, parent) {
  return run('bash', [HOOK], { cwd, env: { ...process.env, CC_PARENT_PATH: parent } });
}

async function wikiLines(cwd) {
  const out = await git(cwd, 'status', '--porcelain', '--untracked-files=all');
  return out.split('\n').filter((l) => /\.wiki/.test(l));
}

async function commonExclude(main) {
  return path.resolve(main, (await git(main, 'rev-parse', '--git-path', 'info/exclude')).trim());
}

async function addWiki(main) {
  await fs.mkdir(path.join(main, '.wiki'));
  await fs.writeFile(path.join(main, '.wiki', 'page.md'), '# page\n');
}

test('main checkout with .wiki: worktree and main both show no .wiki in status', async () => {
  const { main, wt } = await makeRepo();
  await addWiki(main);
  const r = await runHook(wt, main);
  assert.equal(r.code, 0, r.stderr);
  assert.ok((await fs.lstat(path.join(wt, '.wiki'))).isSymbolicLink());
  assert.deepEqual(await wikiLines(wt), []);
  assert.deepEqual(await wikiLines(main), []);
  const ci = await git(wt, 'check-ignore', '-v', '.wiki');
  assert.match(ci, /info\/exclude/);
  assert.match(ci, /\/\.wiki/);
});

test('hook is idempotent: re-running adds /.wiki once', async () => {
  const { main, wt } = await makeRepo();
  await addWiki(main);
  await git(main, 'worktree', 'add', '-q', '../wt2', '-b', 't2');
  const wt2 = path.join(dir, 'wt2');
  assert.equal((await runHook(wt, main)).code, 0);
  assert.equal((await runHook(wt2, main)).code, 0);
  const lines = (await fs.readFile(await commonExclude(main), 'utf8')).split('\n');
  assert.equal(lines.filter((l) => l === '/.wiki').length, 1);
});

test('main checkout without .wiki: exclude still added, a later main .wiki stays clean', async () => {
  const { main, wt } = await makeRepo();
  const r = await runHook(wt, main);
  assert.equal(r.code, 0, r.stderr);
  assert.match(r.stderr, /not found; skipping \.wiki symlink/);
  await assert.rejects(fs.lstat(path.join(wt, '.wiki')), { code: 'ENOENT' });
  await addWiki(main);
  assert.deepEqual(await wikiLines(main), []);
});

test('exclude without trailing newline: entry lands on its own line', async () => {
  const { main, wt } = await makeRepo();
  const exclude = await commonExclude(main);
  await fs.writeFile(exclude, 'foo');
  const r = await runHook(wt, main);
  assert.equal(r.code, 0, r.stderr);
  assert.equal(await fs.readFile(exclude, 'utf8'), 'foo\n/.wiki\n');
});

test('near-miss /.wiki/ entry: hook still appends its own /.wiki line', async () => {
  const { main, wt } = await makeRepo();
  await addWiki(main);
  const exclude = await commonExclude(main);
  await fs.writeFile(exclude, '/.wiki/\n');
  const r = await runHook(wt, main);
  assert.equal(r.code, 0, r.stderr);
  const lines = (await fs.readFile(exclude, 'utf8')).split('\n');
  assert.equal(lines.filter((l) => l === '/.wiki').length, 1);
  assert.deepEqual(await wikiLines(wt), []);
});
