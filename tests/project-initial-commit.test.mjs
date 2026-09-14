// The scaffold commit `createProject` makes: that it exists, that it holds
// exactly what creation wrote, whose identity it carries, and that a commit
// which cannot be made degrades instead of failing the creation.
//
// THIS FILE OWNS ITS GLOBAL GIT CONFIG. The run-wide pin (`pinGitConfig` in
// tests/safeStoreRoot.mjs) can express exactly one value, and these tests have
// to VARY one — a configured identity, half a one, none at all, a failing hook.
// So the file points GIT_CONFIG_GLOBAL at a file of its own at MODULE SCOPE,
// and per-test variation rewrites that file rather than re-pointing the
// variable:
//   * module scope, because under `CC_LOCAL_SYSTEM_PROVIDER` the git that runs
//     is the provider child's, and a child inherits the environment it was
//     SPAWNED with — a per-test `process.env` change never reaches one that is
//     already up (the dent tests/projects.test.mjs's GIT_DIR test documents).
//   * rewriting the file, because git re-reads its config per command, on
//     either side of the wire. Top-level node:test tests in one file run
//     sequentially, so no two tests can be reading it at once.
// The body carries `[maintenance] auto = false` + `[gc] auto = 0` copied from
// pinGitConfig's GIT_CONFIG_BODY: replacing the pinned file with one lacking
// them would drop this file out of the run's detached-repack protection (card
// 2026-0290 §3, regression-tested by tests/git-maintenance-isolation.test.mjs).

import { test, before, after, beforeEach, afterEach } from 'node:test';
import assert from 'node:assert/strict';
import { promises as fs, writeFileSync } from 'node:fs';
import path from 'node:path';
import { execFile as execFileCb } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { mkdtemp } from './tmpRegistry.mjs';
import { bootServer, freshProjectsRoot, rmrf } from './helpers.mjs';
import { createProject } from '../src/projects.ts';
import { createWorktree, hasUnbornHead } from '../src/worktrees.ts';
import { localSystem } from '../src/systems/registry.ts';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const SCENARIO = path.join(__dirname, 'fixtures', 'scenario-instance.json');

// Top-level await: ESM evaluates the whole module before node:test runs a
// single test in it, so the environment below is in place before bootServer
// (and therefore before any provider child) starts.
const cfgDir = await mkdtemp('cc-initcommit-');
const CFG_FILE = path.join(cfgDir, 'gitconfig');
const GIT_ISOLATION = '[maintenance]\n\tauto = false\n[gc]\n\tauto = 0\n';
const DEV_NAME = 'Dev Person';
const DEV_EMAIL = 'dev@example.invalid';
const DEV_IDENT = `[user]\n\tname = ${DEV_NAME}\n\temail = ${DEV_EMAIL}\n`;
// cc's own fallback, mirrored from src/projects.ts (SCAFFOLD_AUTHOR_NAME /
// SCAFFOLD_AUTHOR_EMAIL). Deliberately restated rather than imported: these are
// the literals a user reads in `git log`, and a test that imported them would
// pass for any value the constants happened to hold.
const CC_NAME = 'code-conductor';
const CC_EMAIL = 'code-conductor@invalid';
// Makes git REFUSE to synthesise an identity from the username/hostname rather
// than quietly guessing one, so "no identity" in these fixtures is a fact about
// git's view too, not just about the config file.
const NO_GUESSING = '[user]\n\tuseConfigOnly = true\n';

// Replace the whole config with the run's isolation keys plus `extra`. Sync so
// the next git command in the test cannot race it.
function gitConfig(extra = '') {
  writeFileSync(CFG_FILE, GIT_ISOLATION + extra);
}

const prevGlobal = process.env.GIT_CONFIG_GLOBAL;
const prevNoSystem = process.env.GIT_CONFIG_NOSYSTEM;
gitConfig(DEV_IDENT);
process.env.GIT_CONFIG_GLOBAL = CFG_FILE;
// The host's /etc/gitconfig is not this file's to control, and an identity
// there would make every "no identity" fixture silently measure the wrong thing.
process.env.GIT_CONFIG_NOSYSTEM = '1';

const git = (cwd, ...args) => new Promise((resolve, reject) => {
  execFileCb('git', ['-C', cwd, ...args], { encoding: 'utf8' }, (err, stdout, stderr) => {
    if (err) { err.stdout = stdout; err.stderr = stderr; reject(err); } else resolve({ stdout, stderr });
  });
});

// The four idents one commit carries, in one read. Author AND committer,
// because `-c user.name` / `-c user.email` feed both and a fallback that
// reached only the author would leave the other half wrong.
async function idents(repo) {
  const { stdout } = await git(repo, 'log', '-1', '--format=%an%n%ae%n%cn%n%ce');
  const [an, ae, cn, ce] = stdout.trim().split('\n');
  return { an, ae, cn, ce };
}

let ctx, instances, home;

before(async () => { ctx = await bootServer({ scenarioPath: SCENARIO }); ({ instances } = ctx); });
after(async () => {
  await ctx.close();
  if (prevGlobal === undefined) delete process.env.GIT_CONFIG_GLOBAL;
  else process.env.GIT_CONFIG_GLOBAL = prevGlobal;
  if (prevNoSystem === undefined) delete process.env.GIT_CONFIG_NOSYSTEM;
  else process.env.GIT_CONFIG_NOSYSTEM = prevNoSystem;
});
beforeEach(async () => {
  const r = await freshProjectsRoot();
  home = r.home;
  ctx.projectsRoot = r.projectsRoot;
  ctx.claudeProjectsRoot = r.claudeProjectsRoot;
  gitConfig(DEV_IDENT); // every test starts fully configured and opts out explicitly
});
afterEach(async () => {
  await instances.shutdown();
  instances._idleSubscribers?.clear();
  await rmrf(home);
});

test('a created project has a HEAD commit whose tree is exactly what creation scaffolded', async () => {
  const { path: p } = await createProject('c1', { conventionsDoc: '# conventions\n' });

  const head = (await git(p, 'rev-parse', '--verify', 'HEAD')).stdout.trim();
  assert.match(head, /^[0-9a-f]{40}$/);

  // The commit holds the scaffold — not a subset of it, and not an empty tree.
  const tracked = (await git(p, 'ls-tree', '-r', '--name-only', 'HEAD')).stdout
    .trim().split('\n').filter(Boolean).sort();
  assert.deepEqual(tracked, ['CLAUDE.md', 'CONVENTIONS.md']);

  // And nothing creation wrote was left out of it.
  assert.equal((await git(p, 'status', '--porcelain')).stdout, '');
});

test('a created project with no conventions document commits the one file creation wrote', async () => {
  // What creation writes VARIES: CONVENTIONS.md only appears when the caller
  // passed one. The commit has to track what was written, so a hard-coded
  // pathspec (`git add CLAUDE.md CONVENTIONS.md`) fails here on the absent file.
  const { path: p } = await createProject('c2');

  const tracked = (await git(p, 'ls-tree', '-r', '--name-only', 'HEAD')).stdout
    .trim().split('\n').filter(Boolean).sort();
  assert.deepEqual(tracked, ['CLAUDE.md']);
  assert.equal((await git(p, 'status', '--porcelain')).stdout, '');
});

test('the initial commit is authored by the configured git identity', async () => {
  const { path: p } = await createProject('c3', { conventionsDoc: '# conventions\n' });

  // cc does NOT override an identity the user actually configured — this is the
  // direction an unconditional `-c` fallback would break.
  assert.deepEqual(await idents(p), {
    an: DEV_NAME, ae: DEV_EMAIL, cn: DEV_NAME, ce: DEV_EMAIL,
  });
});

test('an unconfigured git identity does not fail creation — the commit lands under cc\'s own identity', async () => {
  gitConfig(NO_GUESSING);

  const { path: p } = await createProject('c4', { conventionsDoc: '# conventions\n' });

  assert.match((await git(p, 'rev-parse', '--verify', 'HEAD')).stdout.trim(), /^[0-9a-f]{40}$/);
  assert.deepEqual(await idents(p), {
    an: CC_NAME, ae: CC_EMAIL, cn: CC_NAME, ce: CC_EMAIL,
  });

  // THE FALLBACK IS PER-COMMAND AND LEAVES NOTHING BEHIND. `--get` consults
  // local then global, so a `git config` write at either scope would answer
  // here; both must still resolve to nothing.
  await assert.rejects(() => git(p, 'config', '--get', 'user.name'),
    'cc persisted its fallback name into a git config');
  await assert.rejects(() => git(p, 'config', '--get', 'user.email'),
    'cc persisted its fallback email into a git config');

  // NON-VACUITY CONTROL, under the very same config: a hand-built repo cannot
  // commit at all here. Without it, the idents above would also be satisfied by
  // a git that had guessed an identity cc never supplied.
  const control = path.join(home, 'control-repo');
  await fs.mkdir(control, { recursive: true });
  await git(control, 'init', '-q', '-b', 'main');
  await assert.rejects(
    () => git(control, 'commit', '--allow-empty', '-m', 'x'),
    (e) => /useConfigOnly|empty ident|Author identity unknown|no name was given/i.test(e.stderr ?? ''),
    'git accepted a commit with no identity — the config that forces the refusal is not in effect',
  );
});

test('the identity fallback is per-field: a configured name keeps its author, an unset email gets cc\'s', async () => {
  // The two fields are probed INDEPENDENTLY. An all-or-nothing fallback — one
  // that injects both whenever either is missing, or neither unless both are —
  // gets one of these two rows wrong.
  for (const [name, extra, expected] of [
    ['c5a', `${NO_GUESSING}\tname = ${DEV_NAME}\n`, { n: DEV_NAME, e: CC_EMAIL }],
    ['c5b', `${NO_GUESSING}\temail = ${DEV_EMAIL}\n`, { n: CC_NAME, e: DEV_EMAIL }],
  ]) {
    gitConfig(extra);
    const { path: p } = await createProject(name, { conventionsDoc: '# conventions\n' });
    assert.deepEqual(await idents(p), {
      an: expected.n, ae: expected.e, cn: expected.n, ce: expected.e,
    }, `${name}: per-field fallback`);
  }
});

test('a failing commit leaves the project created, its files written, and its HEAD unborn', async () => {
  // A pre-commit hook that always fails, via config alone: no template dir, no
  // copy into the repo, and it reaches the git on EITHER side of the provider
  // wire because it rides the same global config file.
  const hooks = path.join(home, 'hooks');
  await fs.mkdir(hooks, { recursive: true });
  await fs.writeFile(path.join(hooks, 'pre-commit'), '#!/bin/sh\nexit 1\n', { mode: 0o755 });
  gitConfig(`${DEV_IDENT}[core]\n\thooksPath = ${hooks}\n`);

  const warnings = [];
  const origWarn = console.warn;
  console.warn = (...a) => { warnings.push(a.map(String).join(' ')); };
  let p;
  try {
    // Creation SUCCEEDS: everything it owns is already on disk and correct, so
    // a 500 here would surface a failure over a project that fully exists.
    ({ path: p } = await createProject('c6', { conventionsDoc: '# conventions\n' }));
  } finally {
    console.warn = origWarn;
  }
  assert.equal(await fs.readFile(path.join(p, 'CLAUDE.md'), 'utf8'), '@CONVENTIONS.md\n');
  assert.equal(await fs.readFile(path.join(p, 'CONVENTIONS.md'), 'utf8'), '# conventions\n');

  // The failure is visible as exactly the state that existed before this card.
  // That the hook ran at all is what pins that cc passes no `--no-verify`.
  await assert.rejects(() => git(p, 'rev-parse', '--verify', 'HEAD'));
  assert.equal(await hasUnbornHead(localSystem(), p), true);

  // Degraded, not silent.
  assert.ok(warnings.some(w => /initial commit failed/.test(w)),
    `expected an "initial commit failed" warning, got: ${JSON.stringify(warnings)}`);
});

test('a freshly created project takes a worktree immediately, branched off the scaffold commit', async () => {
  const { path: p } = await createProject('c7', { conventionsDoc: '# conventions\n' });
  const head = (await git(p, 'rev-parse', 'HEAD')).stdout.trim();

  // The whole point of the card: no human commit in between.
  const meta = await createWorktree('c7');
  assert.equal(meta.baseSha, head);
  assert.equal((await git(meta.worktreePath, 'rev-parse', 'HEAD')).stdout.trim(), head);
});
