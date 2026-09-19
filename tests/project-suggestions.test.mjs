// WHAT THE SUGGEST SCAN OFFERS, AND WHAT IT MUST NEVER OFFER.
//
// `suggestAdoptableDirs` walks the projects root looking for directories that
// are NOT registered, so a user can adopt one without typing a path. Its whole
// correctness condition is agreement with `adoptProject`: a row the backend
// would refuse is a broken suggestion, and the last test in this file is the
// end-to-end form of that claim.
//
// Every assertion about a path compares against `await fs.realpath(...)`, never
// the literal string — mkdtemp can hand back a path containing symlinks, and a
// literal comparison would then pass or fail for reasons unrelated to the code
// under test.

import { test, before, after, beforeEach, afterEach } from 'node:test';
import assert from 'node:assert/strict';
import { promises as fs } from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import { execFile as execFileCb } from 'node:child_process';
import { bootServer, api, freshProjectsRoot, rmrf, registerLocalProject } from './helpers.mjs';
import { suggestAdoptableDirs, suggestedNameFor, SUGGEST_MAX_DEPTH } from '../src/projectSuggestions.ts';
import {
  adoptProject, listProjects, projectStoreDir, registerProject,
  getProjectForDelete, removeProjectStoreDir,
} from '../src/projects.ts';

const git = (cwd, ...args) => new Promise((resolve, reject) => {
  execFileCb('git', ['-C', cwd, ...args], { encoding: 'utf8' }, (err, stdout, stderr) => {
    if (err) { err.stdout = stdout; err.stderr = stderr; reject(err); } else resolve({ stdout, stderr });
  });
});

let ctx, baseUrl, instances, home, projectsRoot;

before(async () => { ctx = await bootServer(); ({ baseUrl, instances } = ctx); });
after(async () => { await ctx.close(); });
beforeEach(async () => {
  const r = await freshProjectsRoot();
  home = r.home;
  projectsRoot = r.projectsRoot;
  ctx.projectsRoot = r.projectsRoot;
  ctx.claudeProjectsRoot = r.claudeProjectsRoot;
});
afterEach(async () => {
  await instances.shutdown();
  instances._idleSubscribers?.clear();
  await rmrf(home);
});

const mk = async (...parts) => {
  const p = path.join(projectsRoot, ...parts);
  await fs.mkdir(p, { recursive: true });
  return p;
};

async function makeRepoAt(dir) {
  await fs.mkdir(dir, { recursive: true });
  await git(dir, 'init', '-q', '-b', 'main');
  await git(dir, 'config', 'user.email', 'test@example.com');
  await git(dir, 'config', 'user.name', 'test');
  await git(dir, 'config', 'commit.gpgsign', 'false');
  await fs.writeFile(path.join(dir, 'README.md'), '# repo\n');
  await git(dir, 'add', '.');
  await git(dir, 'commit', '-q', '-m', 'initial');
  return dir;
}

// The shared fixture root: one git repo with a subdirectory, one plain
// container three levels deep plus a fourth the depth cap must cut, a
// registered project with a subdirectory, every dot-prefixed area cc owns, and
// a symlink pointing back inside.
async function buildFixture() {
  await makeRepoAt(path.join(projectsRoot, 'repo'));
  await mk('repo', 'src');
  await mk('plain', 'nested', 'deep', 'toofar');
  await mk('registered', 'inside');
  await registerLocalProject('registered', path.join(projectsRoot, 'registered'));
  await mk('.hidden', 'proj');
  await mk('.worktrees', 'registered');
  await mk('.plugins', 'some-plugin');
  await mk('.conduct');
  await fs.symlink(path.join(projectsRoot, 'plain'), path.join(projectsRoot, 'link-to-plain'));
}

const relPaths = s => s.candidates.map(c => c.relPath);

// PINS: the depth cap is enforced at SUGGEST_MAX_DEPTH and is not off by one —
// a directory AT the cap is offered, the one below it is not.
test('a directory at the depth cap appears and one past it does not', async () => {
  await buildFixture();
  const s = await suggestAdoptableDirs();
  assert.equal(SUGGEST_MAX_DEPTH, 3, 'the fixture is built for a cap of 3');
  const deep = s.candidates.find(c => c.relPath === path.join('plain', 'nested', 'deep'));
  assert.ok(deep, 'the depth-3 directory is offered');
  assert.equal(deep.depth, 3);
  assert.ok(!relPaths(s).some(r => r.includes('toofar')), 'the depth-4 directory is not offered');
  assert.equal(s.maxDepth, SUGGEST_MAX_DEPTH, 'the cap actually applied is reported');
});

// PINS: cc's own state never surfaces, and it falls out of the DOT RULE alone —
// no second exclusion list naming `.code-conductor`/`.worktrees`/`.plugins`
// exists to drift out of step with the functions that own those paths.
test("every dot-prefixed directory is skipped, which is what keeps cc's own state out", async () => {
  await buildFixture();
  const s = await suggestAdoptableDirs();
  for (const r of relPaths(s)) {
    assert.ok(!r.split(path.sep).some(seg => seg.startsWith('.')),
      `no candidate may sit under a dot-prefixed directory, got '${r}'`);
  }
  for (const forbidden of ['.hidden', '.code-conductor', '.worktrees', '.plugins', '.conduct']) {
    assert.ok(!relPaths(s).includes(forbidden), `${forbidden} is not a candidate`);
  }
});

// PINS: BOTH halves of the registered-path rule. A naive filter satisfies the
// first (the project itself is absent) and fails the second, offering
// `<registered-project>/inside` — which adoptProject always refuses
// TARGET_INSIDE_REPO or leaves as a nested duplicate.
test('a registered project is skipped AND not descended into', async () => {
  await buildFixture();
  const s = await suggestAdoptableDirs();
  assert.ok(!relPaths(s).includes('registered'), 'the registered project itself is absent');
  assert.ok(!relPaths(s).includes(path.join('registered', 'inside')),
    'a directory nested inside a registered project is absent too');
});

// PINS: the skip set is keyed on LOCAL placement, not on a bare path string. A
// remote record's `path` names a directory on another machine, so a local
// directory that happens to spell the same string is a different tree and must
// still be offered.
test('a remote project whose path spells a local directory does not suppress it', async () => {
  await mk('plain');
  const localTwin = await fs.realpath(path.join(projectsRoot, 'plain'));
  await registerProject('onbox', { kind: 'remote', system: 'box', remoteId: null, path: localTwin });
  const s = await suggestAdoptableDirs();
  assert.ok(relPaths(s).includes('plain'),
    'the local directory is still offered — the remote record describes another machine');
});

// PINS: the one record shape listProjects cannot parse (it emits `path: ''`)
// neither throws the scan nor suppresses anything — an empty path names no
// directory, so it can contribute nothing to the skip set.
test('an unparseable project record neither throws the scan nor suppresses a directory', async () => {
  await mk('plain');
  const store = projectStoreDir('ghost');
  await fs.mkdir(store, { recursive: true });
  await fs.writeFile(path.join(store, 'project.json'), '{ this is not json');
  const listed = await listProjects();
  assert.ok(listed.find(p => p.name === 'ghost')?.degraded, 'the fixture really is a degraded row');
  const s = await suggestAdoptableDirs();
  assert.ok(relPaths(s).includes('plain'));
  assert.equal(s.unreadable, 0, 'a corrupt RECORD is not an unreadable DIRECTORY');
});

// PINS: what follows from the test above, which is a forced consequence rather
// than a choice — the scan cannot suppress a path it cannot read, and
// `registeredPlaces` skips a degraded row for the same reason. So a corrupt
// record's own directory is OFFERED, and adopting it is the recovery: it
// succeeds under a new name, the degraded row stays listed and stays
// deletable, and re-using the corrupt name is refused with the repair named.
// The state is exited, not entered.
test("a corrupt record's directory is offered, and adopting it under a new name is the recovery", async () => {
  const tree = await mk('ghost');
  const real = await fs.realpath(tree);
  const store = projectStoreDir('ghost');
  await fs.mkdir(store, { recursive: true });
  await fs.writeFile(path.join(store, 'project.json'), '{ this is not json');

  const s = await suggestAdoptableDirs();
  assert.ok(relPaths(s).includes('ghost'), "the corrupt record's own directory is offered");

  const adopted = await adoptProject('rescued', real);
  assert.equal(adopted.ok, true, 'adopting it under a free name succeeds');
  assert.equal(adopted.path, real);

  const after = await listProjects();
  assert.ok(after.find(p => p.name === 'ghost')?.degraded, 'the degraded row is still listed');
  assert.ok(after.find(p => p.name === 'rescued'), 'and the rescued project is listed beside it');

  // The corrupt NAME is not silently re-usable — and the refusal names the way out.
  const sameName = await adoptProject('ghost', await fs.realpath(await mk('elsewhere')));
  assert.equal(sameName.ok, false);
  assert.equal(sameName.code, 'PROJECT_EXISTS');
  assert.match(sameName.reason, /delete it to unregister the name/);

  // And that way out works: the degraded row deletes without being parseable.
  assert.deepEqual(await getProjectForDelete('ghost'), { name: 'ghost', location: null });
  await removeProjectStoreDir('ghost');
  assert.ok(!(await listProjects()).some(p => p.name === 'ghost'));
});

// PINS: the ranking is TOTAL and deterministic — `.git`-bearing rows first,
// then relPath ascending — so the dialog's first row is the most likely answer
// and a test may name positions.
test('git-bearing candidates rank first, then relPath ascending', async () => {
  await makeRepoAt(path.join(projectsRoot, 'zeta-repo'));
  await makeRepoAt(path.join(projectsRoot, 'alpha-repo'));
  await mk('beta-plain');
  await mk('alpha-plain');
  const s = await suggestAdoptableDirs();
  assert.deepEqual(relPaths(s), ['alpha-repo', 'zeta-repo', 'alpha-plain', 'beta-plain']);
  assert.deepEqual(s.candidates.map(c => c.isGitRepo), [true, true, false, false]);
});

// PINS: the stop-descend-at-a-repo rule. Every descendant of a repo toplevel is
// TARGET_INSIDE_REPO, so descending would produce only rows the backend
// refuses.
test("a git repo's subdirectory is not offered", async () => {
  await buildFixture();
  const s = await suggestAdoptableDirs();
  assert.ok(relPaths(s).includes('repo'), 'the repo toplevel itself is offered');
  assert.ok(!relPaths(s).includes(path.join('repo', 'src')), 'its subdirectory is not');
});

// PINS: the walk cannot escape the root or cycle — a symlinked entry is neither
// offered nor followed, so nothing outside the root can reach the list through
// one.
test('a symlinked directory is neither offered nor followed', async () => {
  await buildFixture();
  const outside = path.join(home, 'outside-tree', 'inner');
  await fs.mkdir(outside, { recursive: true });
  await fs.symlink(path.join(home, 'outside-tree'), path.join(projectsRoot, 'link-out'));
  const s = await suggestAdoptableDirs();
  assert.ok(!relPaths(s).includes('link-to-plain'), 'a symlink inside the root is not offered');
  assert.ok(!relPaths(s).includes('link-out'), 'a symlink out of the root is not offered');
  assert.ok(!s.candidates.some(c => c.path.includes('outside-tree')), 'and nothing behind it is reached');
});

// PINS: the breadth cap bounds the work AND is REPORTED — a truncated list that
// claimed to be the whole answer would make "the directory is not offered" an
// unreliable signal.
test('the visited-directory cap truncates and says so', async () => {
  await buildFixture();
  const capped = await suggestAdoptableDirs({ maxDirs: 1 });
  assert.equal(capped.truncated, true, 'the cap tripped and is reported');
  assert.ok(capped.candidates.length > 0, 'the prefix is still a well-formed list');
  for (const c of capped.candidates) {
    assert.equal(c.depth, 1, 'reading only the root can only yield depth-1 rows');
    assert.equal(typeof c.path, 'string');
    assert.equal(typeof c.isGitRepo, 'boolean');
  }
  const full = await suggestAdoptableDirs();
  assert.equal(full.truncated, false, 'an uncapped walk of the same root is not truncated');
});

// PINS: a permission-denied subtree degrades ONE row, not the endpoint. A root
// with an unreadable directory in it is routine, and failing the whole scan
// over one would take the affordance away entirely.
test('an unreadable directory is counted and the scan continues', async (t) => {
  // As root, chmod 000 is still readable — the test would assert nothing.
  const probe = await fs.mkdtemp(path.join(os.tmpdir(), 'cc-perm-probe-'));
  await fs.chmod(probe, 0o000);
  let enforced = false;
  try { await fs.readdir(probe); } catch { enforced = true; }
  await fs.chmod(probe, 0o700);
  await fs.rm(probe, { recursive: true, force: true });
  if (!enforced) return t.skip('this user can read a 0o000 directory (running as root)');

  await mk('plain', 'nested');
  const locked = await mk('locked', 'hidden-child');
  await fs.chmod(path.join(projectsRoot, 'locked'), 0o000);
  try {
    const s = await suggestAdoptableDirs();
    assert.equal(s.unreadable, 1, 'the one unreadable directory is counted');
    assert.ok(relPaths(s).includes('locked'), 'the directory itself is still offered');
    assert.ok(!relPaths(s).some(r => r.includes('hidden-child')), 'nothing behind it is');
    assert.ok(relPaths(s).includes(path.join('plain', 'nested')), 'the rest of the walk still ran');
  } finally {
    await fs.chmod(path.join(projectsRoot, 'locked'), 0o700);
    void locked;
  }
});

// PINS: the endpoint never suggests a name registerProject would refuse — both
// of that function's rules (the NAME_RE charset, and the dot-leading refusal)
// are encoded here, and a basename that sanitises to nothing yields no
// suggestion at all rather than an unusable one.
test('suggestedNameFor sanitises to a name the server would accept, or to null', async () => {
  const NAME_RE = /^[a-zA-Z0-9._-]+$/;
  assert.equal(suggestedNameFor('my api'), 'my-api');
  assert.equal(suggestedNameFor('a/b'), 'a-b');
  assert.equal(suggestedNameFor('ok.name_1-2'), 'ok.name_1-2');
  assert.equal(suggestedNameFor('.hidden'), 'hidden');
  assert.equal(suggestedNameFor('..twice'), 'twice');
  assert.equal(suggestedNameFor('..'), null, 'a basename that sanitises to nothing yields no name');
  assert.equal(suggestedNameFor(''), null);
  for (const raw of ['my api', 'a/b', '.hidden', '..twice', 'çafé']) {
    const got = suggestedNameFor(raw);
    if (got === null) continue;
    assert.match(got, NAME_RE, `'${raw}' → '${got}' must match the server's charset`);
    assert.ok(!got.startsWith('.'), `'${raw}' → '${got}' must not be dot-leading`);
  }
});

// PINS: the wire contract of GET /api/projects/suggestions — all five
// top-level fields, and the per-candidate shape the dialog reads.
test('GET /api/projects/suggestions answers 200 with the whole shape', async () => {
  await buildFixture();
  const { status, body } = await api(baseUrl, 'GET', '/api/projects/suggestions');
  assert.equal(status, 200);
  assert.equal(body.root, await fs.realpath(projectsRoot));
  assert.equal(body.maxDepth, SUGGEST_MAX_DEPTH);
  assert.equal(body.truncated, false);
  assert.equal(body.unreadable, 0);
  assert.ok(Array.isArray(body.candidates));
  const repo = body.candidates.find(c => c.relPath === 'repo');
  assert.deepEqual(repo, {
    path: await fs.realpath(path.join(projectsRoot, 'repo')),
    relPath: 'repo', depth: 1, isGitRepo: true, suggestedName: 'repo',
  });
});

// PINS: a missing projects root is an EMPTY answer, not an error — cc is
// usable before its root exists, and a 500 from the dialog's first fetch would
// make it look broken.
test('a projects root that does not exist yields an empty, untruncated answer', async () => {
  await rmrf(projectsRoot);
  const s = await suggestAdoptableDirs();
  assert.deepEqual(s.candidates, []);
  assert.equal(s.truncated, false);
  assert.equal(s.unreadable, 0);
  assert.equal(s.root, projectsRoot, 'the unresolved value is echoed back');
});

// PINS: THE AGREEMENT BETWEEN THE SCAN AND THE REFUSALS. A candidate the
// backend would reject is a broken suggestion, and this is the only test that
// would catch the scan's rules and adoptProject's drifting apart end to end —
// a missing stop-descend rule, a dot rule that stopped covering the store, a
// depth cap that reached into a repo.
test('every candidate the scan offers is actually adoptable', async () => {
  await buildFixture();
  const s = await suggestAdoptableDirs();
  assert.ok(s.candidates.length >= 4, 'the fixture yields a meaningful set');
  let i = 0;
  for (const c of s.candidates) {
    const result = await adoptProject(`adopted-${i++}`, c.path);
    assert.equal(result.ok, true,
      `candidate '${c.relPath}' was refused: ${result.ok ? '' : `${result.code} — ${result.reason}`}`);
  }
});
