// `commitScaffold` must never commit into a repository that is not the one
// creation just made.
//
// THE HAZARD. An ambient `GIT_DIR` in cc's environment already makes
// `createProject`'s `git init` target a foreign repo — a pre-existing dent
// documented at tests/projects.test.mjs's `createProject fails loudly when git
// init fails`, and NOT what this file is about. What the scaffold commit adds is
// blast radius: against a VALID `GIT_DIR`, `git add -A` + `git commit` would
// write a commit titled "Initial commit" into that foreign repo, sweeping up
// whatever its working tree happened to hold — including work the user had not
// committed yet. Misplacing a repo is recoverable; publishing someone's
// in-progress work into a commit is not the same class of thing.
//
// WHY THIS IS ITS OWN FILE, AND WHY IT IS GATE-PROOF. The forcing is an
// environment variable, and `ProviderConnection` spawns the provider child with
// `process.env` (providerConnection.ts), so a variable exported at MODULE SCOPE
// — before `bootServer`, therefore before the child exists — reaches the git
// that actually runs in both `npm run gate:systems` rows. A per-test assignment
// would not: it cannot reach a child that is already up. That same
// all-or-nothing reach is why the variable cannot be confined to one test inside
// a larger file, and why this file holds exactly one.
//
// Every git command the TEST itself runs clears `GIT_DIR` explicitly, so the
// fixtures and the assertions describe the repos they name rather than the
// redirect.

import { test, before, after, beforeEach, afterEach } from 'node:test';
import assert from 'node:assert/strict';
import { promises as fs } from 'node:fs';
import path from 'node:path';
import { execFile as execFileCb } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { mkdtemp } from './tmpRegistry.mjs';
import { bootServer, freshProjectsRoot, rmrf } from './helpers.mjs';
import { createProject } from '../src/projects.ts';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const SCENARIO = path.join(__dirname, 'fixtures', 'scenario-instance.json');

// Runs git with GIT_DIR REMOVED, so a test-side command always addresses the
// repo named by `-C`. The identity comes from `-c` pairs because the run-wide
// pinned gitconfig deliberately configures none.
const git = (cwd, ...args) => new Promise((resolve, reject) => {
  const env = { ...process.env };
  delete env.GIT_DIR;
  const argv = ['-C', cwd, '-c', 'user.name=Fixture', '-c', 'user.email=fixture@example.invalid', ...args];
  execFileCb('git', argv, { encoding: 'utf8', env }, (err, stdout, stderr) => {
    if (err) { err.stdout = stdout; err.stderr = stderr; reject(err); } else resolve({ stdout, stderr });
  });
});

// Top-level await: the module is fully evaluated before node:test runs anything
// in it, so the foreign repo exists and GIT_DIR points at it before bootServer.
const foreignRoot = await mkdtemp('cc-foreignrepo-');
const FOREIGN = path.join(foreignRoot, 'someones-repo');
await fs.mkdir(FOREIGN, { recursive: true });
await git(FOREIGN, 'init', '-q', '-b', 'main');
await fs.writeFile(path.join(FOREIGN, 'tracked.txt'), 'committed\n');
await git(FOREIGN, 'add', '-A');
await git(FOREIGN, 'commit', '-q', '-m', 'the user\'s own history');
// The work that must survive: one modification to a tracked file and one new
// untracked file, both left uncommitted.
await fs.writeFile(path.join(FOREIGN, 'tracked.txt'), 'work in progress\n');
await fs.writeFile(path.join(FOREIGN, 'untracked.txt'), 'not ready yet\n');

const FOREIGN_HEAD = (await git(FOREIGN, 'rev-parse', 'HEAD')).stdout.trim();
const FOREIGN_STATUS = (await git(FOREIGN, 'status', '--porcelain')).stdout;

const prevGitDir = process.env.GIT_DIR;
process.env.GIT_DIR = path.join(FOREIGN, '.git');

let ctx, instances, home;

before(async () => { ctx = await bootServer({ scenarioPath: SCENARIO }); ({ instances } = ctx); });
after(async () => {
  await ctx.close();
  if (prevGitDir === undefined) delete process.env.GIT_DIR;
  else process.env.GIT_DIR = prevGitDir;
});
beforeEach(async () => {
  const r = await freshProjectsRoot();
  home = r.home;
  ctx.projectsRoot = r.projectsRoot;
  ctx.claudeProjectsRoot = r.claudeProjectsRoot;
});
afterEach(async () => {
  await instances.shutdown();
  instances._idleSubscribers?.clear();
  await rmrf(home);
});

test('creation refuses to commit when git resolves the project dir to a foreign repo', async () => {
  // PREMISE GUARD: the redirect is actually in force for cc's own git. Without
  // this, every assertion below would also hold for a run where GIT_DIR never
  // reached the git that ran — which is precisely the shape a provider row
  // would take if the environment did not cross.
  assert.equal(process.env.GIT_DIR, path.join(FOREIGN, '.git'));

  const warnings = [];
  const origWarn = console.warn;
  console.warn = (...a) => { warnings.push(a.map(String).join(' ')); };
  let p;
  try {
    ({ path: p } = await createProject('victim', { conventionsDoc: '# conventions\n' }));
  } finally {
    console.warn = origWarn;
  }

  // Creation still succeeds and still writes what it owns — the guard takes the
  // established non-fatal degrade, it does not turn into a refusal.
  assert.equal(await fs.readFile(path.join(p, 'CLAUDE.md'), 'utf8'), '@CONVENTIONS.md\n');
  assert.equal(await fs.readFile(path.join(p, 'CONVENTIONS.md'), 'utf8'), '# conventions\n');

  // THE INVARIANT: the foreign repo is untouched. Its HEAD did not move, so no
  // "Initial commit" was written into the user's history...
  assert.equal((await git(FOREIGN, 'rev-parse', 'HEAD')).stdout.trim(), FOREIGN_HEAD);
  assert.equal((await git(FOREIGN, 'rev-list', '--count', 'HEAD')).stdout.trim(), '1');
  // ...and its uncommitted work is still uncommitted, so nothing swept it up.
  assert.equal((await git(FOREIGN, 'status', '--porcelain')).stdout, FOREIGN_STATUS);
  assert.match(FOREIGN_STATUS, /^ M tracked\.txt$/m, 'the fixture must really have dirty work');
  assert.match(FOREIGN_STATUS, /^\?\? untracked\.txt$/m);

  // And the project itself is left in the state a caller can already read:
  // no commit of its own. (Its `.git` is the dent's doing — git init went to
  // GIT_DIR — which is exactly why the commit had to be refused.)
  await assert.rejects(() => git(p, 'rev-parse', '--verify', 'HEAD'));

  // Reported, not silent — and reported as the refusal it is, so an operator is
  // not sent looking for a broken hook.
  assert.ok(warnings.some(w => /different repository/.test(w)),
    `expected a foreign-repo refusal warning, got: ${JSON.stringify(warnings)}`);
});
