// GIT'S DUBIOUS-OWNERSHIP REFUSAL IS NOT "NOT A GIT REPO".
//
// When the uid git runs as does not own the repository, git refuses every
// command in it with exit 128 — the same exit a genuine non-repo gets. Read as
// git's answer, that made a foreign-owned repo list as `! not a git repo`, lose
// its git facts, and get adopted as a plain directory, while the fix
// (`safe.directory`) never reached the user.
//
// HOW THE REFUSAL IS PRODUCED: `GIT_TEST_ASSUME_DIFFERENT_OWNER=1`, git's own
// test knob. It is not a uid change — in git's `setup.c`
// `ensure_valid_ownership` it only forces the owner comparison to "different",
// and the `die()` that follows is the code path a real mismatch takes. It is set
// only after the fixtures are built (see `withForeignOwner`), and nothing here
// sets `safe.directory`: the run-scoped GIT_CONFIG_GLOBAL (`pinGitConfig`,
// tests/safeStoreRoot.mjs) carries none, so nothing masks the refusal.
// `LocalSystem`'s exec inherits `process.env` live (`runGroupedCommand`), so
// the in-process server sees the knob too. Under `gate:systems` the System is a
// `ProviderSystem`, whose provider keeps the env it was spawned with and
// receives none on a frame, so `withForeignOwner` respawns the provider on both
// edges and asserts through the System's own git that the knob arrived and,
// after the test, that it left.

import { test, before, after, beforeEach, afterEach } from 'node:test';
import assert from 'node:assert/strict';
import { promises as fs } from 'node:fs';
import path from 'node:path';
import { execFile as execFileCb } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { bootServer, api, freshProjectsRoot, rmrf, waitFor } from './helpers.mjs';
import { adoptProject, readProjectRecord } from '../src/projects.ts';
import { isSystemRefusal, localSystem } from '../src/systems/registry.ts';
import { ProviderSystem } from '../src/systems/providerSystem.ts';
import { isGitRepo, hasUnbornHead, runGit, createWorktree } from '../src/worktrees.ts';
import { invalidateAll } from '../src/projectsCache.ts';
import { listProjects as mcpListProjects, projectStatus } from '../src/mcp/handlers.ts';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const SCENARIO = path.join(__dirname, 'fixtures', 'scenario-instance.json');

const KNOB = 'GIT_TEST_ASSUME_DIFFERENT_OWNER';
// The refusal code is wire contract (REST error bodies, MCP refusals), so it is
// pinned as a literal rather than imported.
const GIT_DUBIOUS_OWNERSHIP = 'GIT_DUBIOUS_OWNERSHIP';

const execGit = (cwd, args, env = process.env) => new Promise((resolve) => {
  execFileCb('git', ['-C', cwd, ...args], { encoding: 'utf8', env }, (err, stdout, stderr) => {
    resolve({ code: err ? (typeof err.code === 'number' ? err.code : 1) : 0, stdout, stderr });
  });
});
const git = async (cwd, ...args) => {
  const r = await execGit(cwd, args);
  if (r.code !== 0) throw new Error(`git ${args.join(' ')} failed: ${r.stderr}`);
  return r;
};

// A provider's env is the one it was spawned with and no exec frame carries
// one, so a `process.env` change reaches its git only through a respawn: kill
// it from the far side (an exec is the reference provider's direct child, so
// `$PPID` is the provider) and the next operation spawns it with the current
// `process.env`. The exec's own result is the transport failure and is not
// asserted on; the wait is on cc observing the death, never on the pid.
async function respawnProvider() {
  const sys = localSystem();
  if (!(sys instanceof ProviderSystem)) return;   // LocalSystem's exec reads process.env live
  await sys.exec({ argv: ['sh', '-c', 'kill -9 $PPID'] }, { cwd: projectsRoot, stdin: 'ignore' });
  await waitFor(() => sys.handshake === null);
}

// A raw exec, not `runGit`, so the reach-check never passes through the
// classifier under test.
const systemGit = (dir) =>
  localSystem().exec({ argv: ['git', '-C', dir, 'rev-parse', '--git-dir'] }, { cwd: dir });

async function withForeignOwner(fn) {
  const prev = process.env[KNOB];
  process.env[KNOB] = '1';
  try {
    await respawnProvider();
    const r = await systemGit(repo);
    assert.equal(r.code, 128, `the knob must reach the git the System runs: ${r.stderr}`);
    assert.ok(r.stderr.split('\n').some(l => l.trim() === fixLine(repo)), r.stderr);
    return await fn();
  } finally {
    if (prev === undefined) delete process.env[KNOB]; else process.env[KNOB] = prev;
    await respawnProvider();
  }
}

async function makeRepo(dir) {
  await fs.mkdir(dir, { recursive: true });
  await git(dir, 'init', '-q', '-b', 'main');
  await git(dir, 'config', 'user.email', 'test@example.com');
  await git(dir, 'config', 'user.name', 'test');
  await git(dir, 'config', 'commit.gpgsign', 'false');
  await fs.writeFile(path.join(dir, 'README.md'), '# repo\n');
  await git(dir, 'add', '.');
  await git(dir, 'commit', '-q', '-m', 'initial');
  return fs.realpath(dir);
}

const fixLine = (p) => `git config --global --add safe.directory ${p}`;
const text = (r) => r.text;
function projectBlock(listText, name) {
  const block = listText.split(/^▸ /m).find(b => b.startsWith(`${name}  `));
  assert.ok(block, `no list_projects block for ${name}`);
  return block;
}

let ctx, baseUrl, instances, home, projectsRoot, repo, plain;

before(async () => { ctx = await bootServer({ scenarioPath: SCENARIO }); ({ baseUrl, instances } = ctx); });
after(async () => { await ctx.close(); });
beforeEach(async () => {
  const r = await freshProjectsRoot();
  home = r.home;
  projectsRoot = r.projectsRoot;
  ctx.projectsRoot = r.projectsRoot;
  ctx.claudeProjectsRoot = r.claudeProjectsRoot;
  // (a) a committed repo and (b) a plain dir, both registered while trusted.
  repo = await makeRepo(path.join(projectsRoot, 'foreign'));
  await fs.mkdir(path.join(projectsRoot, 'plain'), { recursive: true });
  plain = await fs.realpath(path.join(projectsRoot, 'plain'));
  for (const [name, dir] of [['foreign', repo], ['plain', plain]]) {
    const a = await adoptProject(name, dir);
    assert.equal(a.ok, true, `fixture adopt of ${name}: ${JSON.stringify(a)}`);
  }
});
afterEach(async () => {
  assert.equal(process.env[KNOB], undefined, 'the ownership knob leaked past its test');
  const r = await systemGit(repo);
  assert.equal(r.code, 0, `the ownership knob leaked into the System's git past its test: ${r.stderr}`);
  await instances.shutdown();
  instances._idleSubscribers?.clear();
  await rmrf(home);
});

// PINS: the fixture really triggers git's ownership refusal and nothing masks it.
test('fixture precondition: the knob makes git refuse the repo with the safe.directory hint, and no safe.directory is configured', async () => {
  const trusted = await execGit(repo, ['rev-parse', '--git-dir']);
  assert.equal(trusted.code, 0, trusted.stderr);
  const refused = await withForeignOwner(() => execGit(repo, ['rev-parse', '--git-dir']));
  assert.equal(refused.code, 128);
  assert.match(refused.stderr, /dubious ownership/);
  assert.ok(refused.stderr.split('\n').some(l => l.trim() === fixLine(repo)), refused.stderr);
  const safe = await execGit(repo, ['config', '--global', '--get-all', 'safe.directory']);
  assert.equal(safe.code, 1, `a configured safe.directory would mask the refusal: ${safe.stdout}`);
});

// PINS: an ownership refusal is never answered `false`.
test('isGitRepo on a foreign-owned repo rejects with GIT_DUBIOUS_OWNERSHIP naming the fix', async () => {
  await withForeignOwner(() => assert.rejects(() => isGitRepo(localSystem(), repo), (e) => {
    assert.equal(e.code, GIT_DUBIOUS_OWNERSHIP);
    assert.equal(e.statusCode, 403);
    assert.ok(isSystemRefusal(e), 'tagged a system refusal: git did not answer about the tree');
    assert.match(e.message, /dubious ownership/);
    assert.ok(e.message.includes(fixLine(repo)), e.message);
    return true;
  }));
});

// PINS: a genuine non-repo still reads `false` — the discriminator does not over-match.
test('isGitRepo on a plain directory still resolves false, with and without the knob', async () => {
  assert.equal(await isGitRepo(localSystem(), plain), false);
  assert.equal(await withForeignOwner(() => isGitRepo(localSystem(), plain)), false);
});

// PINS: sibling probes do not read the refusal as "unborn".
test('hasUnbornHead on a committed foreign-owned repo rejects rather than answering "unborn"', async () => {
  assert.equal(await hasUnbornHead(localSystem(), repo), false, 'precondition: the repo has a commit');
  await withForeignOwner(() => assert.rejects(() => hasUnbornHead(localSystem(), repo),
    (e) => e.code === GIT_DUBIOUS_OWNERSHIP));
});

// PINS: the discriminator is locale-independent and gated on exit 128, and the
// message names git's hint path exactly — not the cwd it was run in. The
// stderr is git's German catalog entry (de/LC_MESSAGES/git.mo) with its `%s`
// filled, not an invented string: only the hint command survives translation.
test('runGit classifies the refusal by its hint line in any locale, and only on exit 128', async () => {
  const at = '/srv/fremd';
  const stderr = `fatal: dubiose Besitzverhältnisse im Repository bei '${at}' entdeckt\n`
    + 'Um eine Ausnahme für dieses Verzeichnis hinzuzufügen, rufen Sie auf:\n'
    + '\n'
    + `\tgit config --global --add safe.directory ${at}\n`;
  const stub = (code) => ({
    id: 'stub',
    exec: async () => ({ code, stdout: '', stderr, timedOut: false }),
  });
  await assert.rejects(() => runGit(stub(128), '/srv/fremd/sub', ['status']), (e) => {
    assert.equal(e.code, GIT_DUBIOUS_OWNERSHIP);
    // Boundary-exact: git's path is a prefix of the cwd here, so `includes`
    // would also accept a message naming the cwd.
    assert.ok(e.message.endsWith(fixLine(at)), `names git's path, not the cwd: ${e.message}`);
    assert.ok(!e.message.includes('/srv/fremd/sub'), `the cwd is not the path to trust: ${e.message}`);
    assert.ok(e.message.includes("system 'stub'"), e.message);
    return true;
  });
  const r = await runGit(stub(1), '/srv/fremd', ['status']);
  assert.equal(r.code, 1, 'the same text on a non-fatal exit is git\'s answer, not a refusal');
});

// PINS: the listing names the cause, and calls it neither "not a git repo" nor
// "system unreachable".
test('GET /api/projects reports gitRefusal on a foreign-owned repo and leaves isGitRepo absent', async () => {
  invalidateAll();
  const r = await withForeignOwner(() => api(baseUrl, 'GET', '/api/projects'));
  assert.equal(r.status, 200);
  const a = r.body.find(p => p.name === 'foreign');
  const b = r.body.find(p => p.name === 'plain');
  assert.ok(a && b);
  assert.equal(typeof a.gitRefusal, 'string');
  assert.ok(a.gitRefusal.includes(fixLine(repo)), a.gitRefusal);
  assert.ok(!('isGitRepo' in a), `isGitRepo must be absent, got ${a.isGitRepo}`);
  assert.equal(a.systemUnreachable, null);
  assert.equal(a.unbornHead, false);
  assert.deepEqual(a.mergeStatus, { ahead: null, behind: null, upstream: null });
  assert.equal(b.isGitRepo, false);
  assert.equal(b.gitRefusal, null);
  invalidateAll();
});

// PINS: the same invariant on the MCP surface.
test('MCP list_projects prints `! git refused` with the fix, not `! not a git repo` or `! system unreachable`', async () => {
  const out = text(await withForeignOwner(() => mcpListProjects({}, { instances })));
  const a = projectBlock(out, 'foreign');
  assert.match(a, /! git refused .*safe\.directory/);
  assert.ok(!a.includes('! not a git repo'), a);
  assert.ok(!a.includes('! system unreachable'), a);
  assert.match(projectBlock(out, 'plain'), /! not a git repo/);
});

// PINS: status degrades with the cause instead of claiming non-repo.
test('project_status on a foreign-owned repo prints the refusal and still lists files', async () => {
  const out = text(await withForeignOwner(() => projectStatus({ project: 'foreign' })));
  assert.match(out, /^! git refused .*safe\.directory/m);
  assert.match(out, /^FILES \(\d+\)$/m);
  assert.ok(out.includes('README.md'), out);
  assert.ok(!out.includes('! not a git repo'), out);
});

// PINS: the worktree guard names the real cause.
test('createWorktree on a foreign-owned repo refuses with GIT_DUBIOUS_OWNERSHIP, not "not a git repository"', async () => {
  await withForeignOwner(() => assert.rejects(() => createWorktree('foreign', { name: 'x' }), (e) => {
    assert.equal(e.code, GIT_DUBIOUS_OWNERSHIP);
    assert.equal(e.statusCode, 403);
    assert.ok(!/not a git repository/.test(e.message), e.message);
    return true;
  }));
});

// PINS: a foreign-owned repo is never adopted as a plain directory.
test('adoptProject refuses a foreign-owned repo with TARGET_DUBIOUS_OWNERSHIP and writes nothing', async () => {
  const fresh = await makeRepo(path.join(projectsRoot, 'fresh'));
  const r = await withForeignOwner(() => adoptProject('fresh', fresh));
  assert.equal(r.ok, false, JSON.stringify(r));
  assert.equal(r.code, 'TARGET_DUBIOUS_OWNERSHIP');
  assert.ok(r.reason.includes(fixLine(fresh)), r.reason);
  await assert.rejects(() => fs.stat(path.join(fresh, 'CONVENTIONS.md')), { code: 'ENOENT' });
  assert.equal(await readProjectRecord('fresh'), null);
});
