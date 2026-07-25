// Tests for the .conduct project lifecycle: lazy-create, idempotency,
// dot-prefix guards on the regular project routes, and spawn-against-
// .conduct happy path.

import { test, before, after, beforeEach, afterEach } from 'node:test';
import assert from 'node:assert/strict';
import { promises as fs } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { bootServer, api, waitFor, freshProjectsRoot, rmrf } from './helpers.mjs';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const SCENARIO_WS = path.join(__dirname, 'fixtures', 'scenario-ws.json');

let ctx, baseUrl, instances, home, projectsRoot;
before(async () => { ctx = await bootServer({ scenarioPath: SCENARIO_WS }); ({ baseUrl, instances } = ctx); });
after(async () => { await ctx.close(); });
beforeEach(async () => { ({ home, projectsRoot } = await freshProjectsRoot()); });
afterEach(async () => { await instances.shutdown(); await rmrf(home); });

test('ensureConductProject creates a bare .conduct/ dir — no CONDUCT.md, no seeded CLAUDE.md', async () => {
  const r = await api(baseUrl, 'POST', '/api/projects/.conduct/ensure');
  assert.equal(r.status, 200);
  assert.equal(r.body.ok, true);
  assert.equal(r.body.created, true);
  assert.equal(r.body.path, path.join(projectsRoot, '.conduct'));

  const conductDir = path.join(projectsRoot, '.conduct');
  const stat = await fs.stat(conductDir);
  assert.ok(stat.isDirectory());

  // The role prompt is injected at spawn via --append-system-prompt, so no
  // on-disk CONDUCT.md and no seeded CLAUDE.md are written. Workspace
  // conventions still reach the conductor via the ancestor walk-up to the
  // projects-root CLAUDE.md.
  await assert.rejects(fs.stat(path.join(conductDir, 'CONDUCT.md')), 'no CONDUCT.md written');
  await assert.rejects(fs.stat(path.join(conductDir, 'CLAUDE.md')), 'no CLAUDE.md seeded');
});

test('ensureConductProject is idempotent — second call reports created:false and leaves a user CLAUDE.md alone', async () => {
  const r1 = await api(baseUrl, 'POST', '/api/projects/.conduct/ensure');
  assert.equal(r1.body.created, true);

  // A user may drop their own CLAUDE.md into .conduct — ensure never touches it.
  const customContent = '# custom\n\nuser edits should survive\n';
  const claudeMdPath = path.join(projectsRoot, '.conduct', 'CLAUDE.md');
  await fs.writeFile(claudeMdPath, customContent);

  const r2 = await api(baseUrl, 'POST', '/api/projects/.conduct/ensure');
  assert.equal(r2.status, 200);
  assert.equal(r2.body.created, false);

  const after = await fs.readFile(claudeMdPath, 'utf8');
  assert.equal(after, customContent, 'user CLAUDE.md preserved');
});

test('listProjects() excludes .conduct from /api/projects', async () => {
  await api(baseUrl, 'POST', '/api/projects', { name: 'visible' });
  await api(baseUrl, 'POST', '/api/projects/.conduct/ensure');

  const r = await api(baseUrl, 'GET', '/api/projects');
  assert.equal(r.status, 200);
  const names = r.body.map(p => p.name);
  assert.ok(names.includes('visible'));
  assert.ok(!names.includes('.conduct'), `.conduct must not appear in sidebar list; got ${names.join(',')}`);
});

test('POST /api/projects rejects dot-prefixed names', async () => {
  const r1 = await api(baseUrl, 'POST', '/api/projects', { name: '.conduct' });
  assert.equal(r1.status, 400);
  assert.match(r1.body.error, /cannot start with/i);

  const r2 = await api(baseUrl, 'POST', '/api/projects', { name: '.hidden' });
  assert.equal(r2.status, 400);

  // No project was actually created on disk.
  await assert.rejects(fs.stat(path.join(projectsRoot, '.conduct')));
});

test('DELETE /api/projects/.conduct is refused', async () => {
  await api(baseUrl, 'POST', '/api/projects/.conduct/ensure');
  const r = await api(baseUrl, 'DELETE', '/api/projects/.conduct');
  assert.equal(r.status, 400);
  assert.match(r.body.error, /managed by the orchestrator/i);

  // Still on disk.
  const stat = await fs.stat(path.join(projectsRoot, '.conduct'));
  assert.ok(stat.isDirectory());
});

test('PUT /api/projects/.conduct/workspace is refused', async () => {
  await api(baseUrl, 'POST', '/api/projects/.conduct/ensure');
  const r = await api(baseUrl, 'PUT', '/api/projects/.conduct/workspace', { workspace: 'Stuff' });
  assert.equal(r.status, 400);
  assert.match(r.body.error, /cannot be assigned/i);
});

test('POST /api/instances with project=.conduct spawns successfully', async () => {
  await api(baseUrl, 'POST', '/api/projects/.conduct/ensure');
  const r = await api(baseUrl, 'POST', '/api/instances', {
    project: '.conduct',
    model: 'claude-haiku-4-5',
    temp: true,
    mode: 'bypassPermissions',
  });
  assert.equal(r.status, 201);
  const id = r.body.id;
  assert.equal(r.body.project, '.conduct');
  assert.equal(r.body.temp, true);

  await waitFor(() => instances.get(id)?.status === 'idle');

  const list = await api(baseUrl, 'GET', '/api/instances');
  assert.equal(list.status, 200);
  assert.ok(list.body.some(i => i.id === id && i.project === '.conduct'));
});
