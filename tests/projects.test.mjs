import { test, before, after, beforeEach, afterEach } from 'node:test';
import assert from 'node:assert/strict';
import { promises as fs } from 'node:fs';
import path from 'node:path';
import { execFile as execFileCb } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { bootServer, api, waitFor, freshProjectsRoot, rmrf } from './helpers.mjs';
import {
  encodeCwd, findSessionLocation,
  readProjectMeta, writeProjectMeta,
} from '../src/projects.js';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const FIXTURE_JSONL = path.join(__dirname, 'fixtures', 'session-sample.jsonl');
const SCENARIO = path.join(__dirname, 'fixtures', 'scenario-instance.json');

// Helper reused by every test that needs a real git repo for worktree creation.
const git = (cwd, ...args) => new Promise((resolve, reject) => {
  execFileCb('git', ['-C', cwd, ...args], { encoding: 'utf8' }, (err, stdout, stderr) => {
    if (err) { err.stdout = stdout; err.stderr = stderr; reject(err); } else resolve({ stdout, stderr });
  });
});

let ctx, baseUrl, wsUrl, instances, projectsRoot, claudeProjectsRoot, home;

before(async () => {
  ctx = await bootServer({ scenarioPath: SCENARIO });
  ({ baseUrl, wsUrl, instances } = ctx);
});
after(async () => { await ctx.close(); });
beforeEach(async () => {
  const r = await freshProjectsRoot();
  home = r.home;
  projectsRoot = r.projectsRoot;
  claudeProjectsRoot = r.claudeProjectsRoot;
  ctx.projectsRoot = r.projectsRoot;
  ctx.claudeProjectsRoot = r.claudeProjectsRoot;
});
afterEach(async () => {
  await instances.shutdown();
  instances._idleSubscribers?.clear();
  await rmrf(home);
});

test('GET /api/projects returns empty list initially', async () => {
  const r = await api(baseUrl, 'GET', '/api/projects');
  assert.equal(r.status, 200);
  assert.deepEqual(r.body, []);
});

test('POST /api/projects creates a directory and lists it', async () => {
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
  assert.deepEqual(list.body[0].sessionIds, []);
});

test('POST /api/projects seeds CLAUDE.md that imports the workspace-wide one', async () => {
  await api(baseUrl, 'POST', '/api/projects', { name: 'with-md' });
  const mdPath = path.join(projectsRoot, 'with-md', 'CLAUDE.md');
  const text = await fs.readFile(mdPath, 'utf8');
  assert.match(text, /@\.\.\/CLAUDE\.md/, 'imports the parent workspace CLAUDE.md');
});

test('POST /api/projects rejects bad names', async () => {
  for (const bad of ['', '../escape', 'has space', 'slash/inside', null]) {
    const r = await api(baseUrl, 'POST', '/api/projects', { name: bad });
    assert.equal(r.status, 400, `expected 400 for ${JSON.stringify(bad)}`);
    assert.match(r.body.error, /invalid project name/);
  }
});

test('POST /api/projects conflict on duplicate', async () => {
  await api(baseUrl, 'POST', '/api/projects', { name: 'dup' });
  const second = await api(baseUrl, 'POST', '/api/projects', { name: 'dup' });
  assert.equal(second.status, 409);
});

test('encodeCwd replaces every non-alphanumeric char (including dots AND underscores) with `-`', () => {
  // Regression: real claude writes session jsonls under
  //   ~/.claude/projects/<encoded-cwd>/<sid>.jsonl
  // where every char outside [A-Za-z0-9-] is replaced with `-`.
  // Notably this INCLUDES underscores — observed directly against the
  // installed claude CLI: a cwd of `~/project/Test5_worktree_1f5dd7`
  // produced a session dir named `…-Test5-worktree-1f5dd7`, NOT
  // `…-Test5_worktree_1f5dd7`. An earlier version of this helper kept
  // underscores, which silently broke any project path with a `_` —
  // the orchestrator's metadata appends ended up at one dir while
  // claude's actual session was at another, and history-replay /
  // resume both ran against an empty file.
  assert.equal(
    encodeCwd('/data/data/com.termux/files/home/project/Testapp'),
    '-data-data-com-termux-files-home-project-Testapp',
  );
  assert.equal(encodeCwd('/foo bar/baz'), '-foo-bar-baz');
  // Underscores get rewritten too — this is the worktree bug.
  assert.equal(encodeCwd('/a/b_c-d/e.f'), '-a-b-c-d-e-f');
  assert.equal(
    encodeCwd('/data/data/com.termux/files/home/project/Test5_worktree_1f5dd7'),
    '-data-data-com-termux-files-home-project-Test5-worktree-1f5dd7',
  );
});

test('GET /api/projects/:name/sessions reads jsonl headers', async () => {
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
});

test('GET /api/projects/:name/sessions returns [] when no session dir', async () => {
  await api(baseUrl, 'POST', '/api/projects', { name: 'empty' });
  const r = await api(baseUrl, 'GET', '/api/projects/empty/sessions');
  assert.equal(r.status, 200);
  assert.deepEqual(r.body, []);
});

test('GET /api/projects/:name/sessions 404s unknown project', async () => {
  const r = await api(baseUrl, 'GET', '/api/projects/nope/sessions');
  assert.equal(r.status, 404);
});

test('DELETE /api/projects/:name removes the directory + drops from the list', async () => {
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
});

test('DELETE /api/projects/:name cascades through running instances + worktrees', async () => {
  // Real git repo so we can stand up a worktree, and a fake-claude
  // scenario for the running instance.
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
});

test('DELETE /api/projects/:name 404s unknown project', async () => {
  const r = await api(baseUrl, 'DELETE', '/api/projects/nope');
  assert.equal(r.status, 404);
});

test('GET /api/projects exposes a per-project sessions summary (count + lastMtime)', async () => {
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
});

test('GET /api/projects exposes a sessions summary on each worktree too', async () => {
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
  const wtDir = path.join(claudeProjectsRoot, encodeCwd(wtPath));
  await fs.mkdir(wtDir, { recursive: true });
  await fs.copyFile(FIXTURE_JSONL, path.join(wtDir, '00000000-0000-0000-0000-000000000001.jsonl'));

  const list = await api(baseUrl, 'GET', '/api/projects');
  const proj = list.body.find(p => p.name === 'demo');
  assert.equal(proj.worktrees.length, 1);
  assert.equal(proj.worktrees[0].sessions.count, 1);
  assert.ok(proj.worktrees[0].sessions.lastMtime > 0);
});

test('DELETE /api/projects/:name/sessions/:sid removes the jsonl', async () => {
  await api(baseUrl, 'POST', '/api/projects', { name: 'sess' });
  const dir = path.join(claudeProjectsRoot, encodeCwd(path.join(projectsRoot, 'sess')));
  await fs.mkdir(dir, { recursive: true });
  const sid = 'deadbeef-0000-1111-2222-333333333333';
  const file = path.join(dir, `${sid}.jsonl`);
  await fs.copyFile(FIXTURE_JSONL, file);
  await fs.stat(file);

  const r = await api(baseUrl, 'DELETE', `/api/projects/sess/sessions/${sid}`);
  assert.equal(r.status, 200);
  assert.equal(r.body.ok, true);
  await assert.rejects(fs.stat(file), { code: 'ENOENT' });
});

test('DELETE session 404s when the jsonl is missing', async () => {
  await api(baseUrl, 'POST', '/api/projects', { name: 'sess' });
  const r = await api(baseUrl, 'DELETE', '/api/projects/sess/sessions/00000000-0000-0000-0000-000000000000');
  assert.equal(r.status, 404);
});

test('DELETE session refuses (409) when a running instance is attached; force=1 kills + deletes', async () => {
  await api(baseUrl, 'POST', '/api/projects', { name: 'sess' });
  const r = await api(baseUrl, 'POST', '/api/instances', { project: 'sess', mode: 'bypassPermissions' });
  const id = r.body.id;
  const sid = r.body.sessionId;
  await waitFor(() => instances.get(id)?.proc);

  // Pre-create the on-disk jsonl so the route's `removed` check passes.
  const dir = path.join(claudeProjectsRoot, encodeCwd(path.join(projectsRoot, 'sess')));
  await fs.mkdir(dir, { recursive: true });
  await fs.copyFile(FIXTURE_JSONL, path.join(dir, `${sid}.jsonl`));

  const blocked = await api(baseUrl, 'DELETE', `/api/projects/sess/sessions/${sid}`);
  assert.equal(blocked.status, 409);
  assert.match(blocked.body.error, /running instance/i);
  assert.ok(instances.get(id), 'instance untouched by the refused delete');

  const forced = await api(baseUrl, 'DELETE', `/api/projects/sess/sessions/${sid}?force=1`);
  assert.equal(forced.status, 200);
  // Instance killed; jsonl gone.
  await waitFor(() => instances.get(id) === undefined);
  await assert.rejects(fs.stat(path.join(dir, `${sid}.jsonl`)), { code: 'ENOENT' });
});

test('DELETE session also drops the stale Instance record when the proc was already killed', async () => {
  await api(baseUrl, 'POST', '/api/projects', { name: 'sess' });
  const r = await api(baseUrl, 'POST', '/api/instances', { project: 'sess', mode: 'bypassPermissions' });
  const id = r.body.id;
  const sid = r.body.sessionId;
  await waitFor(() => instances.get(id)?.proc);

  // Kill the subprocess but keep the Instance in byId — mirrors the
  // header "Kill" button flow (so Resume stays available).
  await instances.get(id).kill({ graceMs: 100 });
  await waitFor(() => instances.get(id) && !instances.get(id).proc);

  const dir = path.join(claudeProjectsRoot, encodeCwd(path.join(projectsRoot, 'sess')));
  await fs.mkdir(dir, { recursive: true });
  await fs.copyFile(FIXTURE_JSONL, path.join(dir, `${sid}.jsonl`));

  // No 409 — the instance has no live proc — and the stale record
  // should be cleaned up so the sidebar doesn't render a ghost row.
  const del = await api(baseUrl, 'DELETE', `/api/projects/sess/sessions/${sid}`);
  assert.equal(del.status, 200);
  assert.equal(instances.get(id), undefined, 'stale exited instance removed alongside the session');
  await assert.rejects(fs.stat(path.join(dir, `${sid}.jsonl`)), { code: 'ENOENT' });
});

test('DELETE worktree session removes from the worktree-encoded dir (not the parent project)', async () => {
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
  const wtName = r.body.worktree.worktreeName;
  const wtPath = r.body.cwd;
  await api(baseUrl, 'DELETE', `/api/instances/${r.body.id}`);

  const wtDir = path.join(claudeProjectsRoot, encodeCwd(wtPath));
  await fs.mkdir(wtDir, { recursive: true });
  const sid = 'aaaa1111-bbbb-2222-cccc-333333333333';
  const file = path.join(wtDir, `${sid}.jsonl`);
  await fs.copyFile(FIXTURE_JSONL, file);

  const del = await api(baseUrl, 'DELETE',
    `/api/projects/demo/worktrees/${encodeURIComponent(wtName)}/sessions/${sid}`);
  assert.equal(del.status, 200);
  await assert.rejects(fs.stat(file), { code: 'ENOENT' });
});

test('DELETE session 400s for a sessionId containing path traversal', async () => {
  await api(baseUrl, 'POST', '/api/projects', { name: 'sess' });
  const r = await api(baseUrl, 'DELETE', '/api/projects/sess/sessions/..%2F..%2Fetc%2Fpasswd');
  assert.equal(r.status, 400);
});

test('DELETE worktree session 400s for a sessionId containing path traversal', async () => {
  await api(baseUrl, 'POST', '/api/projects', { name: 'sess' });
  const r = await api(baseUrl, 'DELETE', '/api/projects/sess/worktrees/wt/sessions/..%2F..%2Fetc%2Fpasswd');
  assert.equal(r.status, 400);
});

test('findSessionLocation returns {project, worktreeName:null} for project-root sessions', async () => {
  await api(baseUrl, 'POST', '/api/projects', { name: 'host' });
  const dir = path.join(claudeProjectsRoot, encodeCwd(path.join(projectsRoot, 'host')));
  await fs.mkdir(dir, { recursive: true });
  const sid = '11111111-2222-3333-4444-555555555555';
  await fs.copyFile(FIXTURE_JSONL, path.join(dir, `${sid}.jsonl`));
  const hit = await findSessionLocation(sid);
  assert.deepEqual(hit, { project: 'host', worktreeName: null });
});

test('findSessionLocation finds sessions inside a worktree', async () => {
  const repoPath = path.join(projectsRoot, 'wtproj');
  await fs.mkdir(repoPath, { recursive: true });
  await git(repoPath, 'init', '-q', '-b', 'main');
  await git(repoPath, 'config', 'user.email', 't@t');
  await git(repoPath, 'config', 'user.name', 't');
  await git(repoPath, 'config', 'commit.gpgsign', 'false');
  await fs.writeFile(path.join(repoPath, 'r.md'), 'x');
  await git(repoPath, 'add', '.');
  await git(repoPath, 'commit', '-q', '-m', 'i');

  const r = await api(baseUrl, 'POST', '/api/instances', { project: 'wtproj', worktree: true });
  const wtName = r.body.worktree.worktreeName;
  const wtPath = r.body.cwd;
  await api(baseUrl, 'DELETE', `/api/instances/${r.body.id}`);

  const wtDir = path.join(claudeProjectsRoot, encodeCwd(wtPath));
  await fs.mkdir(wtDir, { recursive: true });
  const sid = 'aaaa1111-bbbb-2222-cccc-dddddddddddd';
  await fs.copyFile(FIXTURE_JSONL, path.join(wtDir, `${sid}.jsonl`));

  const hit = await findSessionLocation(sid);
  assert.deepEqual(hit, { project: 'wtproj', worktreeName: wtName });
});

test('findSessionLocation returns null for unknown sessionId', async () => {
  await api(baseUrl, 'POST', '/api/projects', { name: 'host' });
  const hit = await findSessionLocation('99999999-0000-0000-0000-000000000000');
  assert.equal(hit, null);
});

test('findSessionLocation rejects path-traversal-shaped ids without touching the filesystem', async () => {
  // No bootServer needed — input validation happens before any FS access.
  for (const bad of ['../etc/passwd', 'foo/bar', '', null, undefined, 'has space', '..']) {
    const hit = await findSessionLocation(bad);
    assert.equal(hit, null, `expected null for ${JSON.stringify(bad)}`);
  }
});

test('GET /api/sessions/:sid/locate returns the owning project (project-root)', async () => {
  await api(baseUrl, 'POST', '/api/projects', { name: 'host' });
  const dir = path.join(claudeProjectsRoot, encodeCwd(path.join(projectsRoot, 'host')));
  await fs.mkdir(dir, { recursive: true });
  const sid = '22222222-3333-4444-5555-666666666666';
  await fs.copyFile(FIXTURE_JSONL, path.join(dir, `${sid}.jsonl`));
  const r = await api(baseUrl, 'GET', `/api/sessions/${sid}/locate`);
  assert.equal(r.status, 200);
  assert.deepEqual(r.body, { project: 'host', worktreeName: null });
});

test('GET /api/sessions/:sid/locate 404s when nothing matches', async () => {
  await api(baseUrl, 'POST', '/api/projects', { name: 'host' });
  const r = await api(baseUrl, 'GET', '/api/sessions/00000000-1111-2222-3333-444444444444/locate');
  assert.equal(r.status, 404);
  assert.match(r.body.error, /session not found/);
});

test('GET /api/sessions/:sid/locate 400s on malformed id', async () => {
  // Express normalizes %2F → /, so a literal slash 404s at the router
  // layer before our handler runs. Use a chars-only payload that *our*
  // validator rejects (`.` is disallowed) to exercise the 400 branch.
  const r = await api(baseUrl, 'GET', '/api/sessions/has.dots/locate');
  assert.equal(r.status, 400);
  assert.match(r.body.error, /invalid sessionId/);
});

test('readProjectMeta returns {workspace:null} when the dotfile is absent', async () => {
  await api(baseUrl, 'POST', '/api/projects', { name: 'fresh' });
  const meta = await readProjectMeta('fresh');
  assert.deepEqual(meta, { workspace: null });
});

test('writeProjectMeta({workspace}) round-trips through listProjects/GET /api/projects', async () => {
  await api(baseUrl, 'POST', '/api/projects', { name: 'work' });
  await writeProjectMeta('work', { workspace: 'Side projects' });
  const meta = await readProjectMeta('work');
  assert.equal(meta.workspace, 'Side projects');
  // The on-disk file lives in the workspace-wide central store.
  const file = path.join(projectsRoot, '.code-conductor', 'projects', 'work', 'project.json');
  const raw = await fs.readFile(file, 'utf8');
  assert.match(raw, /"workspace": "Side projects"/);
  // And it surfaces in the REST listing.
  const r = await api(baseUrl, 'GET', '/api/projects');
  const proj = r.body.find(p => p.name === 'work');
  assert.equal(proj.workspace, 'Side projects');
});

test('writeProjectMeta({workspace:null}) clears the field and removes the now-empty file', async () => {
  await api(baseUrl, 'POST', '/api/projects', { name: 'clearme' });
  await writeProjectMeta('clearme', { workspace: 'Temp' });
  const file = path.join(projectsRoot, '.code-conductor', 'projects', 'clearme', 'project.json');
  await fs.stat(file); // exists
  await writeProjectMeta('clearme', { workspace: null });
  await assert.rejects(fs.stat(file), { code: 'ENOENT' });
  const meta = await readProjectMeta('clearme');
  assert.deepEqual(meta, { workspace: null });
});

test('writeProjectMeta rejects invalid workspace strings', async () => {
  await api(baseUrl, 'POST', '/api/projects', { name: 'bad' });
  // Disallowed characters and over-long names are rejected.
  // Leading/trailing whitespace is trimmed; empty / whitespace-only
  // map to null (clear), not an error.
  for (const bad of ['x'.repeat(60), 'has:colon', 'has!bang', 'with\ttab']) {
    await assert.rejects(
      writeProjectMeta('bad', { workspace: bad }),
      /invalid workspace name/,
      `expected reject for ${JSON.stringify(bad)}`,
    );
  }
  await assert.rejects(writeProjectMeta('bad', { workspace: 123 }), /must be a string/);
  // Whitespace-only treated as null — no throw.
  await writeProjectMeta('bad', { workspace: '   ' });
});

test('PUT /api/projects/:name/workspace assigns and clears the field; broadcasts the projects WS hint', async () => {
  await api(baseUrl, 'POST', '/api/projects', { name: 'wsp' });

  // Subscribe to the WS so we can assert the broadcast lands. The
  // server pushes {t:'projects'} on every successful workspace change.
  const { WebSocket } = await import('ws');
  const ws = new WebSocket(wsUrl);
  const seen = [];
  await new Promise(resolve => { ws.once('open', resolve); });
  ws.on('message', (raw) => {
    try { const m = JSON.parse(raw.toString()); seen.push(m); } catch { /* ignore */ }
  });

  const assign = await api(baseUrl, 'PUT', '/api/projects/wsp/workspace', { workspace: 'Work' });
  assert.equal(assign.status, 200);
  assert.equal(assign.body.workspace, 'Work');
  await waitFor(() => seen.some(m => m.t === 'projects'));

  // Clearing: explicit null.
  seen.length = 0;
  const clr = await api(baseUrl, 'PUT', '/api/projects/wsp/workspace', { workspace: null });
  assert.equal(clr.status, 200);
  assert.equal(clr.body.workspace, null);
  await waitFor(() => seen.some(m => m.t === 'projects'));

  ws.close();
});

test('PUT /api/projects/:name/workspace: 400 on invalid workspace, 404 on unknown project', async () => {
  await api(baseUrl, 'POST', '/api/projects', { name: 'val' });
  const bad = await api(baseUrl, 'PUT', '/api/projects/val/workspace', { workspace: 'x'.repeat(60) });
  assert.equal(bad.status, 400);
  assert.match(bad.body.error, /invalid workspace name/);
  const missing = await api(baseUrl, 'PUT', '/api/projects/nope/workspace', { workspace: 'X' });
  assert.equal(missing.status, 404);
});

test('Workspace registry endpoints: GET/POST/PUT/DELETE /api/workspaces', async () => {
  await api(baseUrl, 'POST', '/api/projects', { name: 'p1' });
  await api(baseUrl, 'POST', '/api/projects', { name: 'p2' });

  // Empty list at boot.
  let r = await api(baseUrl, 'GET', '/api/workspaces');
  assert.equal(r.status, 200);
  assert.deepEqual(r.body, []);

  // POST creates an empty workspace.
  r = await api(baseUrl, 'POST', '/api/workspaces', { name: 'Solo' });
  assert.equal(r.status, 201);
  assert.equal(r.body.name, 'Solo');
  assert.equal(r.body.added, true);

  // Idempotent: a second POST with the same name reports added:false
  // but still 200.
  r = await api(baseUrl, 'POST', '/api/workspaces', { name: 'Solo' });
  assert.equal(r.status, 200);
  assert.equal(r.body.added, false);

  // GET surfaces it with projectCount 0.
  r = await api(baseUrl, 'GET', '/api/workspaces');
  assert.deepEqual(r.body, [{ name: 'Solo', projectCount: 0 }]);

  // Assigning a project auto-registers a NEW workspace name.
  await api(baseUrl, 'PUT', '/api/projects/p1/workspace', { workspace: 'Auto' });
  r = await api(baseUrl, 'GET', '/api/workspaces');
  const byName = Object.fromEntries(r.body.map(w => [w.name, w.projectCount]));
  assert.equal(byName.Auto, 1);
  assert.equal(byName.Solo, 0);

  // PUT renames a workspace and rewrites every member.
  await api(baseUrl, 'PUT', '/api/projects/p2/workspace', { workspace: 'Auto' });
  r = await api(baseUrl, 'PUT', '/api/workspaces/Auto', { name: 'Renamed' });
  assert.equal(r.status, 200);
  assert.equal(r.body.renamed, true);
  assert.equal(r.body.movedProjects.length, 2);
  const projs = (await api(baseUrl, 'GET', '/api/projects')).body;
  assert.equal(projs.find(p => p.name === 'p1').workspace, 'Renamed');
  assert.equal(projs.find(p => p.name === 'p2').workspace, 'Renamed');

  // DELETE clears the field on every member and drops the registry entry.
  r = await api(baseUrl, 'DELETE', '/api/workspaces/Renamed');
  assert.equal(r.status, 200);
  assert.equal(r.body.removed, true);
  assert.equal(r.body.clearedProjects.length, 2);
  const after = (await api(baseUrl, 'GET', '/api/projects')).body;
  assert.equal(after.find(p => p.name === 'p1').workspace, null);
  assert.equal(after.find(p => p.name === 'p2').workspace, null);
  r = await api(baseUrl, 'GET', '/api/workspaces');
  assert.deepEqual(r.body.map(w => w.name), ['Solo']);

  // The registry file is removed once empty.
  await api(baseUrl, 'DELETE', '/api/workspaces/Solo');
  const regFile = path.join(projectsRoot, '.code-conductor', 'workspaces.json');
  await assert.rejects(fs.stat(regFile), { code: 'ENOENT' });
});

test('POST /api/instances refuses to resume a session already attached to a live instance', async () => {
  await api(baseUrl, 'POST', '/api/projects', { name: 'dup' });
  // Spawn fresh — gets a fresh sessionId.
  const first = await api(baseUrl, 'POST', '/api/instances', { project: 'dup', mode: 'bypassPermissions' });
  assert.equal(first.status, 201);
  const sid = first.body.sessionId;
  // Wait until the orchestrator is past spawn so the resume check has
  // a `proc`-attached instance to detect.
  await waitFor(() => instances.get(first.body.id)?.proc);

  // Resuming the same session into a second instance must 409.
  const second = await api(baseUrl, 'POST', '/api/instances', { project: 'dup', mode: 'bypassPermissions', resume: sid });
  assert.equal(second.status, 409);
  assert.match(second.body.error, /already attached/i);
});
