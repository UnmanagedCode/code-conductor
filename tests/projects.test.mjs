import { test } from 'node:test';
import assert from 'node:assert/strict';
import { promises as fs } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { bootServer, api } from './helpers.mjs';
import { encodeCwd } from '../src/projects.js';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const FIXTURE_JSONL = path.join(__dirname, 'fixtures', 'session-sample.jsonl');

test('GET /api/projects returns empty list initially', async () => {
  const { baseUrl, close } = await bootServer();
  try {
    const r = await api(baseUrl, 'GET', '/api/projects');
    assert.equal(r.status, 200);
    assert.deepEqual(r.body, []);
  } finally { await close(); }
});

test('POST /api/projects creates a directory and lists it', async () => {
  const { baseUrl, projectsRoot, close } = await bootServer();
  try {
    const created = await api(baseUrl, 'POST', '/api/projects', { name: 'demo' });
    assert.equal(created.status, 201);
    assert.equal(created.body.name, 'demo');
    assert.equal(created.body.path, path.join(projectsRoot, 'demo'));

    const stat = await fs.stat(path.join(projectsRoot, 'demo'));
    assert.ok(stat.isDirectory());

    const list = await api(baseUrl, 'GET', '/api/projects');
    assert.equal(list.status, 200);
    assert.equal(list.body.length, 1);
    assert.equal(list.body[0].name, 'demo');
    assert.deepEqual(list.body[0].instanceIds, []);
  } finally { await close(); }
});

test('POST /api/projects seeds CLAUDE.md that imports the workspace-wide one', async () => {
  const { baseUrl, projectsRoot, close } = await bootServer();
  try {
    await api(baseUrl, 'POST', '/api/projects', { name: 'with-md' });
    const mdPath = path.join(projectsRoot, 'with-md', 'CLAUDE.md');
    const text = await fs.readFile(mdPath, 'utf8');
    assert.match(text, /@\.\.\/CLAUDE\.md/, 'imports the parent workspace CLAUDE.md');
  } finally { await close(); }
});

test('POST /api/projects rejects bad names', async () => {
  const { baseUrl, close } = await bootServer();
  try {
    for (const bad of ['', '../escape', 'has space', 'slash/inside', null]) {
      const r = await api(baseUrl, 'POST', '/api/projects', { name: bad });
      assert.equal(r.status, 400, `expected 400 for ${JSON.stringify(bad)}`);
      assert.match(r.body.error, /invalid project name/);
    }
  } finally { await close(); }
});

test('POST /api/projects conflict on duplicate', async () => {
  const { baseUrl, close } = await bootServer();
  try {
    await api(baseUrl, 'POST', '/api/projects', { name: 'dup' });
    const second = await api(baseUrl, 'POST', '/api/projects', { name: 'dup' });
    assert.equal(second.status, 409);
  } finally { await close(); }
});

test('encodeCwd replaces every non-alphanumeric char (including dots) with `-`', () => {
  // Regression: real claude writes session jsonls under
  //   ~/.claude/projects/<encoded-cwd>/<sid>.jsonl
  // where every char outside [A-Za-z0-9_-] is replaced with `-`. Previously
  // we only replaced `/`, so cwds like `/data/data/com.termux/...` looked
  // up `…com.termux…` while real claude wrote to `…com-termux…`, and
  // loadHistory/listSessions silently returned empty.
  assert.equal(
    encodeCwd('/data/data/com.termux/files/home/project/Testapp'),
    '-data-data-com-termux-files-home-project-Testapp',
  );
  assert.equal(encodeCwd('/foo bar/baz'), '-foo-bar-baz');
  assert.equal(encodeCwd('/a/b_c-d/e.f'), '-a-b_c-d-e-f');
});

test('GET /api/projects/:name/sessions reads jsonl headers', async () => {
  const { baseUrl, projectsRoot, claudeProjectsRoot, close } = await bootServer();
  try {
    await api(baseUrl, 'POST', '/api/projects', { name: 'sess' });
    const sessDir = path.join(claudeProjectsRoot, encodeCwd(path.join(projectsRoot, 'sess')));
    await fs.mkdir(sessDir, { recursive: true });
    const sid = 'abcdef01-2345-6789-abcd-ef0123456789';
    await fs.copyFile(FIXTURE_JSONL, path.join(sessDir, `${sid}.jsonl`));

    const r = await api(baseUrl, 'GET', '/api/projects/sess/sessions');
    assert.equal(r.status, 200);
    assert.equal(r.body.length, 1);
    assert.equal(r.body[0].sessionId, sid);
    assert.match(r.body[0].firstPrompt, /hello from fixture/);
    assert.ok(r.body[0].mtime > 0);
    assert.ok(r.body[0].size > 0);
  } finally { await close(); }
});

test('GET /api/projects/:name/sessions returns [] when no session dir', async () => {
  const { baseUrl, close } = await bootServer();
  try {
    await api(baseUrl, 'POST', '/api/projects', { name: 'empty' });
    const r = await api(baseUrl, 'GET', '/api/projects/empty/sessions');
    assert.equal(r.status, 200);
    assert.deepEqual(r.body, []);
  } finally { await close(); }
});

test('GET /api/projects/:name/sessions 404s unknown project', async () => {
  const { baseUrl, close } = await bootServer();
  try {
    const r = await api(baseUrl, 'GET', '/api/projects/nope/sessions');
    assert.equal(r.status, 404);
  } finally { await close(); }
});

test('DELETE /api/projects/:name removes the directory + drops from the list', async () => {
  const { baseUrl, projectsRoot, close } = await bootServer();
  try {
    await api(baseUrl, 'POST', '/api/projects', { name: 'goner' });
    const dir = path.join(projectsRoot, 'goner');
    await fs.stat(dir);

    const r = await api(baseUrl, 'DELETE', '/api/projects/goner');
    assert.equal(r.status, 200);
    assert.equal(r.body.ok, true);
    assert.equal(r.body.killedInstances, 0);

    await assert.rejects(fs.stat(dir), { code: 'ENOENT' });
    const list = await api(baseUrl, 'GET', '/api/projects');
    assert.deepEqual(list.body, []);
  } finally { await close(); }
});

test('DELETE /api/projects/:name cascades through running instances + worktrees', async () => {
  // Real git repo so we can stand up a worktree, and a fake-claude
  // scenario for the running instance.
  const SCENARIO = path.join(__dirname, 'fixtures', 'scenario-instance.json');
  const { execFile } = await import('node:child_process');
  const git = (cwd, ...args) => new Promise((resolve, reject) => {
    execFile('git', ['-C', cwd, ...args], { encoding: 'utf8' }, (err, stdout, stderr) => {
      if (err) { err.stdout = stdout; err.stderr = stderr; reject(err); } else resolve({ stdout, stderr });
    });
  });
  const { baseUrl, projectsRoot, instances, close } = await bootServer({ scenarioPath: SCENARIO });
  try {
    // Init a real repo at projectsRoot/demo so worktree creation works.
    const repoPath = path.join(projectsRoot, 'demo');
    await fs.mkdir(repoPath, { recursive: true });
    await git(repoPath, 'init', '-q', '-b', 'main');
    await git(repoPath, 'config', 'user.email', 't@t');
    await git(repoPath, 'config', 'user.name', 't');
    await git(repoPath, 'config', 'commit.gpgsign', 'false');
    await fs.writeFile(path.join(repoPath, 'r.md'), 'x');
    await git(repoPath, 'add', '.');
    await git(repoPath, 'commit', '-q', '-m', 'i');

    // Spawn one direct instance + one worktree-attached instance.
    const direct = await api(baseUrl, 'POST', '/api/instances', { project: 'demo', mode: 'bypassPermissions' });
    const wtSpawn = await api(baseUrl, 'POST', '/api/instances', { project: 'demo', mode: 'bypassPermissions', worktree: true });
    const wtName = wtSpawn.body.worktree.worktreeName;
    const wtPath = path.join(projectsRoot, wtName);
    await fs.stat(wtPath);
    assert.equal(instances.list().length, 2);

    const r = await api(baseUrl, 'DELETE', '/api/projects/demo');
    assert.equal(r.status, 200);
    assert.equal(r.body.killedInstances, 2);

    // Project dir, worktree dir, and both instances are gone.
    await assert.rejects(fs.stat(repoPath), { code: 'ENOENT' });
    await assert.rejects(fs.stat(wtPath), { code: 'ENOENT' });
    assert.equal(instances.list().length, 0);
    assert.equal(instances.get(direct.body.id), undefined);
    assert.equal(instances.get(wtSpawn.body.id), undefined);
  } finally { await close(); }
});

test('DELETE /api/projects/:name 404s unknown project', async () => {
  const { baseUrl, close } = await bootServer();
  try {
    const r = await api(baseUrl, 'DELETE', '/api/projects/nope');
    assert.equal(r.status, 404);
  } finally { await close(); }
});

test('GET /api/projects exposes a per-project sessions summary (count + lastMtime)', async () => {
  const { baseUrl, claudeProjectsRoot, projectsRoot, close } = await bootServer();
  try {
    await api(baseUrl, 'POST', '/api/projects', { name: 'sess' });
    // Pre-populate two fake session jsonls under the encoded cwd.
    const encoded = path.join(projectsRoot, 'sess').replace(/[^A-Za-z0-9_-]/g, '-');
    const dir = path.join(claudeProjectsRoot, encoded);
    await fs.mkdir(dir, { recursive: true });
    await fs.copyFile(FIXTURE_JSONL, path.join(dir, '00000000-0000-0000-0000-000000000001.jsonl'));
    await fs.copyFile(FIXTURE_JSONL, path.join(dir, '00000000-0000-0000-0000-000000000002.jsonl'));

    const list = await api(baseUrl, 'GET', '/api/projects');
    assert.equal(list.status, 200);
    const proj = list.body.find(p => p.name === 'sess');
    assert.ok(proj.sessions, 'sessions summary present');
    assert.equal(proj.sessions.count, 2, `expected 2 sessions, got ${proj.sessions.count}`);
    assert.ok(proj.sessions.lastMtime > 0, 'lastMtime should be the newer of the two file mtimes');
  } finally { await close(); }
});

test('GET /api/projects exposes a sessions summary on each worktree too', async () => {
  const SCENARIO = path.join(__dirname, 'fixtures', 'scenario-instance.json');
  const { execFile } = await import('node:child_process');
  const git = (cwd, ...args) => new Promise((resolve, reject) => {
    execFile('git', ['-C', cwd, ...args], { encoding: 'utf8' }, (err, stdout, stderr) => {
      if (err) { err.stdout = stdout; err.stderr = stderr; reject(err); } else resolve({ stdout, stderr });
    });
  });
  const { baseUrl, projectsRoot, claudeProjectsRoot, close } = await bootServer({ scenarioPath: SCENARIO });
  try {
    // Real git repo so worktree creation works.
    const repoPath = path.join(projectsRoot, 'demo');
    await fs.mkdir(repoPath, { recursive: true });
    await git(repoPath, 'init', '-q', '-b', 'main');
    await git(repoPath, 'config', 'user.email', 't@t');
    await git(repoPath, 'config', 'user.name', 't');
    await git(repoPath, 'config', 'commit.gpgsign', 'false');
    await fs.writeFile(path.join(repoPath, 'r.md'), 'x');
    await git(repoPath, 'add', '.');
    await git(repoPath, 'commit', '-q', '-m', 'i');

    const r = await api(baseUrl, 'POST', '/api/instances', { project: 'demo', worktree: true });
    const wtPath = r.body.cwd;
    await api(baseUrl, 'DELETE', `/api/instances/${r.body.id}`);

    // Drop a session jsonl into the worktree's own encoded dir.
    const wtEncoded = wtPath.replace(/[^A-Za-z0-9_-]/g, '-');
    const wtDir = path.join(claudeProjectsRoot, wtEncoded);
    await fs.mkdir(wtDir, { recursive: true });
    await fs.copyFile(FIXTURE_JSONL, path.join(wtDir, '00000000-0000-0000-0000-000000000001.jsonl'));

    const list = await api(baseUrl, 'GET', '/api/projects');
    const proj = list.body.find(p => p.name === 'demo');
    assert.equal(proj.worktrees.length, 1);
    assert.equal(proj.worktrees[0].sessions.count, 1);
    assert.ok(proj.worktrees[0].sessions.lastMtime > 0);
  } finally { await close(); }
});

test('POST /api/instances refuses to resume a session already attached to a live instance', async () => {
  const SCENARIO = path.join(__dirname, 'fixtures', 'scenario-instance.json');
  const { baseUrl, instances, close } = await bootServer({ scenarioPath: SCENARIO });
  try {
    await api(baseUrl, 'POST', '/api/projects', { name: 'dup' });
    // Spawn fresh — gets a fresh sessionId.
    const first = await api(baseUrl, 'POST', '/api/instances', { project: 'dup', mode: 'bypassPermissions' });
    assert.equal(first.status, 201);
    const sid = first.body.sessionId;
    // Wait until the orchestrator is past spawn so the resume check has
    // a `proc`-attached instance to detect.
    const { waitFor } = await import('./helpers.mjs');
    await waitFor(() => instances.get(first.body.id)?.proc);

    // Resuming the same session into a second instance must 409.
    const second = await api(baseUrl, 'POST', '/api/instances', { project: 'dup', mode: 'bypassPermissions', resume: sid });
    assert.equal(second.status, 409);
    assert.match(second.body.error, /already attached/i);
  } finally { await close(); }
});
