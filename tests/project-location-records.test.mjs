// ONE STORED FIELD SAYS WHERE A PROJECT LIVES, and nothing else does. The
// record in `<store>/projects/<name>/project.json` IS the registration: a
// directory under the projects root is not a project, and a project's kind is
// not inferable from where its tree sits.

import { test, before, after, beforeEach, afterEach } from 'node:test';
import assert from 'node:assert/strict';
import { promises as fs } from 'node:fs';
import path from 'node:path';
import { execFile as execFileCb } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { bootServer, api, freshProjectsRoot, rmrf, registerLocalProject } from './helpers.mjs';
import {
  listProjects, resolveProjectDir, getProject, adoptProject, createProject,
  readProjectRecord, projectStoreDir, projectsRoot as projectsRootFn,
  localWorktreesRoot, pluginsRoot,
} from '../src/projects.ts';
import { createWorktree } from '../src/worktrees.ts';
import * as mcp from '../src/mcp/handlers.ts';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const SCENARIO = path.join(__dirname, 'fixtures', 'scenario-instance.json');

const git = (cwd, ...args) => new Promise((resolve, reject) => {
  execFileCb('git', ['-C', cwd, ...args], { encoding: 'utf8' }, (err, stdout, stderr) => {
    if (err) { err.stdout = stdout; err.stderr = stderr; reject(err); } else resolve({ stdout, stderr });
  });
});

let ctx, baseUrl, instances, home, projectsRoot;

before(async () => { ctx = await bootServer({ scenarioPath: SCENARIO }); ({ baseUrl, instances } = ctx); });
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

async function makeRepo(dir) {
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

// ── AC4: one record read, no probing ───────────────────────────────────────

// PINS: AC4. The DECOY is what gives this teeth — a surviving in-root probe
// would resolve the same-named directory and pass a record-only assertion that
// had nothing to disagree with.
test("resolveProjectDir returns the record's path even when a same-named directory sits in the root", async () => {
  const real = await makeRepo(path.join(home, 'elsewhere', 'app'));
  assert.equal((await adoptProject('app', real)).ok, true);
  const decoy = path.join(projectsRoot, 'app');
  await fs.mkdir(decoy, { recursive: true });
  await fs.writeFile(path.join(decoy, 'DECOY'), 'this is not the project\n');

  const resolved = await resolveProjectDir('app');
  assert.equal(resolved.path, await fs.realpath(real));
  assert.notEqual(resolved.path, decoy);
  assert.equal((await getProject('app')).path, await fs.realpath(real));
});

// PINS: AC2's first half, at the resolver.
test('a directory under the projects root with no record is not a project', async () => {
  await makeRepo(path.join(projectsRoot, 'squatter'));
  assert.equal(await resolveProjectDir('squatter'), null);
  assert.deepEqual((await listProjects()).map(p => p.name), []);
  await assert.rejects(() => getProject('squatter'), /not found/);
});

// PINS: AC6's first clause, structurally. `listProjects` reads the STORE — a
// readdir of the projects root would make every directory in it a candidate
// again, which is what AC2 exists to end.
test('listProjects does not read the projects root', async () => {
  await registerLocalProject('a', path.join(projectsRoot, 'a'));
  const origReaddir = fs.readdir;
  const seen = [];
  try {
    fs.readdir = function (p, ...rest) { seen.push(String(p)); return origReaddir.call(this, p, ...rest); };
    await listProjects();
  } finally { fs.readdir = origReaddir; }
  assert.ok(!seen.includes(projectsRootFn()), `listProjects read the projects root: ${seen.join(', ')}`);
});

// ── AC5 / AC1: the path is the only thing that differs ─────────────────────

// PINS: AC5. Two directories sharing a basename are two records under two
// names; nothing derives a name from a path any more.
test('two projects whose directories share a basename both register and resolve', async () => {
  const one = await makeRepo(path.join(home, 'one', 'app'));
  const two = await makeRepo(path.join(home, 'two', 'app'));
  assert.equal((await adoptProject('app-one', one)).ok, true);
  assert.equal((await adoptProject('app-two', two)).ok, true);
  assert.equal((await getProject('app-one')).path, await fs.realpath(one));
  assert.equal((await getProject('app-two')).path, await fs.realpath(two));
  assert.deepEqual((await listProjects()).map(p => p.name), ['app-one', 'app-two']);
});

// PINS: AC1 — an inside-root and an outside-root project are indistinguishable
// to the listing except for `path`. Deep-equal with name/path masked, so a new
// kind flag on either row fails this.
test("an inside-root and an outside-root project's list_projects rows are equal but for path", async () => {
  const inside = await makeRepo(path.join(projectsRoot, 'inside'));
  await registerLocalProject('inside', inside);
  const outside = await makeRepo(path.join(home, 'outside'));
  assert.equal((await adoptProject('outside', outside)).ok, true);

  const rows = await listProjects();
  const mask = r => ({ ...r, name: '<name>', path: '<path>' });
  assert.equal(rows.length, 2);
  assert.deepEqual(mask(rows[0]), mask(rows[1]));
});

// PINS: AC2, DRIVEN rather than merely listed — a container directory holds a
// project three deep, and that project takes a worktree like any other.
test('a project nested three deep registers, reports status, and takes a worktree', async () => {
  const deep = await makeRepo(path.join(projectsRoot, 'clients', 'acme', 'web'));
  assert.equal((await adoptProject('web', deep)).ok, true);

  const row = (await api(baseUrl, 'GET', '/api/projects')).body.find(p => p.name === 'web');
  assert.ok(row, 'the nested project lists');
  assert.equal(row.isGitRepo, true, 'and its git facts are measured, not skipped');
  assert.equal(row.systemUnreachable, null);

  const wt = await createWorktree('web');
  assert.equal(wt.worktreePath, path.join(localWorktreesRoot(), 'web', wt.worktreeName));
  assert.ok((await fs.stat(wt.worktreePath)).isDirectory());
  assert.deepEqual((await listProjects()).map(p => p.name), ['web'],
    'the container directories are not projects');
});

// ── a malformed record ─────────────────────────────────────────────────────

// PINS: the reader THROWS. With the record as the sole registration, degrading
// to an empty one would silently UNREGISTER a live project — so the refusal is
// a 500 that names the file, never a 404 that says the project never existed.
test('a malformed project.json surfaces as a 500 naming the file, never a 404', async () => {
  const file = path.join(projectStoreDir('broken'), 'project.json');
  await fs.mkdir(path.dirname(file), { recursive: true });
  await fs.writeFile(file, '{ this is not json');

  await assert.rejects(() => resolveProjectDir('broken'), (e) => {
    assert.equal(e.statusCode, 500, `expected 500, got ${e.statusCode}`);
    assert.ok(e.message.includes(file), `the refusal must name the file: ${e.message}`);
    return true;
  });
  const r = await api(baseUrl, 'GET', '/api/projects/broken/sessions');
  assert.equal(r.status, 500, JSON.stringify(r.body));
});

// PINS: the LISTING half. A silently skipped row is the disappearing row the
// degraded-listing contract exists to prevent: invisible AND undeletable.
test('a malformed record still LISTS, with a degraded marker and an empty path', async () => {
  const file = path.join(projectStoreDir('broken'), 'project.json');
  await fs.mkdir(path.dirname(file), { recursive: true });
  await fs.writeFile(file, '{ "location": { "kind": "sideways" } }');
  await registerLocalProject('healthy', path.join(projectsRoot, 'healthy'));

  const rows = await listProjects();
  assert.deepEqual(rows.map(p => p.name), ['broken', 'healthy']);
  const broken = rows.find(p => p.name === 'broken');
  assert.equal(broken.path, '');
  assert.ok(typeof broken.degraded === 'string' && broken.degraded.length > 0);
  assert.equal(rows.find(p => p.name === 'healthy').degraded, undefined);
});

// ── creation ordering ──────────────────────────────────────────────────────

// PINS: the ordering pin. The mkdir is what proves the path was not already
// someone else's tree, so a record written ahead of it would ADOPT whatever was
// there when the create refuses.
test('createProject registers only after the mkdir succeeds', async () => {
  const squatted = path.join(projectsRoot, 'taken');
  await fs.mkdir(squatted, { recursive: true });
  await fs.writeFile(path.join(squatted, 'someone-elses.txt'), 'not cc\'s\n');

  await assert.rejects(() => createProject('taken'), /already exists/);
  assert.equal(await readProjectRecord('taken'), null,
    'a refused create left NO record behind');
  assert.ok((await fs.stat(path.join(squatted, 'someone-elses.txt'))).isFile());
});

// ── the reserved-name guard, AT THE CHOKEPOINT ─────────────────────────────

// PINS: the reserved-name refusal lives in `registerProject`, the one guarded
// writer. It goes through the MCP handler deliberately: the REST route has its
// own dot-leading check, so a route-level test passes while the chokepoint
// stays open — and `create_project({name:'.worktrees'})` over MCP would then
// mint a project occupying the worktree root, putting every future worktree of
// every project inside that one project's tree.
test('create_project over MCP refuses a reserved dot-leading name', async () => {
  for (const name of ['.worktrees', '.plugins', '.hidden', '.code-conductor']) {
    await assert.rejects(() => mcp.createProject({ name }), /cannot start with/, name);
    assert.equal(await readProjectRecord(name), null, `${name}: nothing was registered`);
  }
  // The reserved area itself is untouched by the refusals above.
  await assert.rejects(() => fs.stat(path.join(localWorktreesRoot(), 'CLAUDE.md')));
  await assert.rejects(() => fs.stat(path.join(pluginsRoot(), 'CLAUDE.md')));
});

// PINS: `.conduct` is the ONE dot-leading name the chokepoint admits — a blanket
// refusal would stop the conductor bootstrap registering its own project.
test('.conduct is still registrable, and stays out of the default listing', async () => {
  const { ensureConductProject } = await import('../src/conduct.ts');
  await ensureConductProject();
  assert.deepEqual((await readProjectRecord('.conduct')).location,
    { kind: 'local', path: path.join(projectsRoot, '.conduct') });
  assert.deepEqual((await listProjects()).map(p => p.name), []);
  assert.deepEqual((await listProjects({ includeConduct: true })).map(p => p.name), ['.conduct']);
  // Idempotent — a second ensure must not hit registerProject's held-name 409.
  await ensureConductProject();
});
