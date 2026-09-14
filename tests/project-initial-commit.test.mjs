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

// Collect everything cc warned while `fn` ran. Restores the real console.warn
// unconditionally, so a throwing body cannot leave the rest of the file muted.
// The warning TEXT is load-bearing here: refusing the commit and attempting one
// that then fails both end at "created, HEAD unborn", so the end state alone
// cannot say which path was taken.
async function withWarnings(fn) {
  const warnings = [];
  const orig = console.warn;
  console.warn = (...a) => { warnings.push(a.map(String).join(' ')); };
  try {
    return { result: await fn(), warnings };
  } finally {
    console.warn = orig;
  }
}

const REFUSED = /different repository/;
const FAILED = /initial commit failed/;

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

test('a global ignore rule cannot keep any scaffolded file out of the initial commit', async () => {
  // `git add -A` HONOURS core.excludesFile, and keeping agent files out of
  // history is a real habit — so a user whose global ignore names one of these
  // files would get a commit silently missing it. What makes that worth closing
  // rather than waiving is downstream: a worktree branched off that HEAD checks
  // out no CLAUDE.md at all, so the `@CONVENTIONS.md` import chain is missing
  // for every worker in the project.
  //
  // THE IGNORE RULE NAMES **EVERY** SCAFFOLDED FILE, and that is the whole
  // design of this fixture rather than an incidental choice. Ignoring only
  // CLAUDE.md leaves `add -A` covering CONVENTIONS.md, which MASKS any omission
  // in the forced floor for the second file: both a floor hard-coded to
  // `['CLAUDE.md']` and a `scaffolded` array that forgets its
  // `CONVENTIONS.md` push survive such a fixture (measured — they were the two
  // mutation survivors this fixture exists to kill). With both names ignored,
  // `add -A` contributes NOTHING and the floor is the only thing that can put
  // either file in the commit, so the assertion below reads every entry of the
  // floor list rather than just its first.
  const ignore = path.join(home, 'global-gitignore');
  await fs.writeFile(ignore, 'CLAUDE.md\nCONVENTIONS.md\n');
  gitConfig(`${DEV_IDENT}[core]\n\texcludesFile = ${ignore}\n`);

  const { path: p } = await createProject('c8', { conventionsDoc: '# conventions\n' });

  const tracked = (await git(p, 'ls-tree', '-r', '--name-only', 'HEAD')).stdout
    .trim().split('\n').filter(Boolean).sort();
  assert.deepEqual(tracked, ['CLAUDE.md', 'CONVENTIONS.md'],
    'an ignore rule kept a file creation wrote out of the commit');
  // The commit is the only place this can be read: with both names ignored,
  // `git status` in the project stays clean either way.
  assert.equal((await git(p, 'status', '--porcelain')).stdout, '');

  // NON-VACUITY CONTROL, in a hand-built repo under the same config: BOTH
  // patterns have to bite, per file and behaviourally. Without the per-file
  // half, a fixture whose second pattern was a typo would still pass the
  // behavioural half on the strength of the first.
  const control = path.join(home, 'control-repo');
  await fs.mkdir(control, { recursive: true });
  await git(control, 'init', '-q', '-b', 'main');
  const ignored = (await git(control, 'check-ignore', '--no-index', 'CLAUDE.md', 'CONVENTIONS.md'))
    .stdout.trim().split('\n').sort();
  assert.deepEqual(ignored, ['CLAUDE.md', 'CONVENTIONS.md'],
    'core.excludesFile does not hide both names — the fixture cannot fail the way it claims to');
  await fs.writeFile(path.join(control, 'CLAUDE.md'), 'x\n');
  await fs.writeFile(path.join(control, 'CONVENTIONS.md'), 'y\n');
  await git(control, 'add', '-A');
  assert.equal((await git(control, 'ls-files')).stdout, '',
    '`add -A` staged a file the ignore rule should have hidden');
});

test('a failing commit leaves the project created, its files written, and its HEAD unborn', async () => {
  // A pre-commit hook that always fails, via config alone: no template dir, no
  // copy into the repo, and it reaches the git on EITHER side of the provider
  // wire because it rides the same global config file.
  const hooks = path.join(home, 'hooks');
  await fs.mkdir(hooks, { recursive: true });
  await fs.writeFile(path.join(hooks, 'pre-commit'), '#!/bin/sh\nexit 1\n', { mode: 0o755 });
  gitConfig(`${DEV_IDENT}[core]\n\thooksPath = ${hooks}\n`);

  // Creation SUCCEEDS: everything it owns is already on disk and correct, so a
  // 500 here would surface a failure over a project that fully exists.
  const { result, warnings } = await withWarnings(() =>
    createProject('c6', { conventionsDoc: '# conventions\n' }));
  const p = result.path;
  assert.equal(await fs.readFile(path.join(p, 'CLAUDE.md'), 'utf8'), '@CONVENTIONS.md\n');
  assert.equal(await fs.readFile(path.join(p, 'CONVENTIONS.md'), 'utf8'), '# conventions\n');

  // The failure is visible as exactly the state that existed before this card.
  // That the hook ran at all is what pins that cc passes no `--no-verify`.
  await assert.rejects(() => git(p, 'rev-parse', '--verify', 'HEAD'));
  assert.equal(await hasUnbornHead(localSystem(), p), true);

  // Degraded, not silent — and reported as the ATTEMPT that failed, not as the
  // foreign-repo refusal, which is the other route to this same end state.
  assert.ok(warnings.some(w => FAILED.test(w)),
    `expected an "initial commit failed" warning, got: ${JSON.stringify(warnings)}`);
  assert.ok(!warnings.some(w => REFUSED.test(w)),
    `cc blamed a foreign repo for a refusing hook: ${JSON.stringify(warnings)}`);
});

test('a repo whose work tree points away from the project is refused before anything is staged', async () => {
  // THE OTHER HALF OF THE GUARD, ON ITS OWN. The `GIT_DIR` fixture
  // (tests/project-initial-commit-foreign-repo.test.mjs) trips BOTH of the
  // guard's comparisons at once, so it cannot tell which one did the work. This
  // fixture leaves the git dir correct and moves only the work tree, so the
  // top-level comparison is the sole thing that can refuse.
  //
  // FORCED THROUGH CONFIG ALONE, which is why this needs no module-scope
  // environment and no skip: `git init` copies a `config` out of
  // `init.templateDir` into the new repo, so the template installs a
  // REPO-LOCAL `core.worktree` — and repo-local is the scope git honours.
  // Measured on git 2.55 here, which is what picked this route over the
  // env one:
  //   * `core.worktree` in the GLOBAL config is ignored for a normally
  //     discovered repo, so the global route is not a hazard at all.
  //   * `GIT_WORK_TREE` without `GIT_DIR` is refused outright ("not allowed
  //     without specifying GIT_DIR"), which fails `git init` rc 128 and so
  //     never reaches the commit — it is the existing 500, not this guard.
  //   * the reachable env shape is `GIT_DIR=.git` + `GIT_WORK_TREE=<foreign>`,
  //     and it produces EXACTLY the rev-parse answers this fixture produces
  //     (own `.git`, foreign top level), so pinning one pins the clause.
  // And the hazard is live: in this state `git add -A` was measured staging the
  // foreign tree's files into the project's own index (`add 'tracked.txt'`,
  // `add 'untracked.txt'`).
  const foreign = path.join(home, 'someones-tree');
  await fs.mkdir(foreign, { recursive: true });
  await fs.writeFile(path.join(foreign, 'tracked.txt'), 'committed\n');
  await fs.writeFile(path.join(foreign, 'untracked.txt'), 'not ready yet\n');
  const template = path.join(home, 'git-template');
  await fs.mkdir(template, { recursive: true });
  await fs.writeFile(path.join(template, 'config'), `[core]\n\tworktree = ${foreign}\n`);
  gitConfig(`${DEV_IDENT}[init]\n\ttemplateDir = ${template}\n`);

  const { result, warnings } = await withWarnings(() =>
    createProject('c9', { conventionsDoc: '# conventions\n' }));
  const p = result.path;

  // CONTROL, and the whole reason this test isolates the clause: the GIT-DIR
  // half of the guard is SATISFIED here — the repo really is the project's own
  // — so it cannot be what refused. Only the top-level comparison is left.
  const real = await fs.realpath(p);
  const [gitDir, topLevel] = (await git(p, 'rev-parse', '--absolute-git-dir', '--show-toplevel'))
    .stdout.trim().split('\n');
  assert.equal(gitDir, path.join(real, '.git'),
    'the git-dir half must PASS in this fixture, or the test is not isolating the other one');
  assert.equal(topLevel, await fs.realpath(foreign), 'the work-tree redirect is not in effect');
  assert.notEqual(topLevel, real);

  // NOTHING WAS STAGED. This is the invariant the clause exists for: without
  // it, `add -A` runs against the foreign tree and the project's index ends up
  // holding somebody else's files.
  assert.equal((await git(p, 'ls-files')).stdout, '',
    'the project index holds entries — staging ran against the redirected work tree');

  // Creation still succeeded, wrote what it owns, and left HEAD unborn.
  assert.equal(await fs.readFile(path.join(p, 'CLAUDE.md'), 'utf8'), '@CONVENTIONS.md\n');
  assert.equal(await fs.readFile(path.join(p, 'CONVENTIONS.md'), 'utf8'), '# conventions\n');
  await assert.rejects(() => git(p, 'rev-parse', '--verify', 'HEAD'));

  // Reported as the refusal, NOT as an attempt that failed. Without this the
  // assertions above would also hold for a guard that let staging run and then
  // tripped over the forced add (measured: it fails `pathspec 'CLAUDE.md' did
  // not match any files`) — same unborn HEAD, but the index already polluted.
  assert.ok(warnings.some(w => REFUSED.test(w)),
    `expected a work-tree refusal warning, got: ${JSON.stringify(warnings)}`);
  assert.ok(!warnings.some(w => FAILED.test(w)),
    `cc staged first and refused afterwards: ${JSON.stringify(warnings)}`);

  // The foreign tree itself is untouched.
  assert.equal(await fs.readFile(path.join(foreign, 'tracked.txt'), 'utf8'), 'committed\n');
  assert.equal(await fs.readFile(path.join(foreign, 'untracked.txt'), 'utf8'), 'not ready yet\n');
});

test('a freshly created project takes a worktree immediately, branched off the scaffold commit', async () => {
  const { path: p } = await createProject('c7', { conventionsDoc: '# conventions\n' });
  const head = (await git(p, 'rev-parse', 'HEAD')).stdout.trim();

  // The whole point of the card: no human commit in between.
  const meta = await createWorktree('c7');
  assert.equal(meta.baseSha, head);
  assert.equal((await git(meta.worktreePath, 'rev-parse', 'HEAD')).stdout.trim(), head);
});
