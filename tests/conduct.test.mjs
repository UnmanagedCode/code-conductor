// Tests for the .conduct project lifecycle: lazy-create, idempotency,
// dot-prefix guards on the regular project routes, and spawn-against-
// .conduct happy path.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { promises as fs } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { bootServer, api, waitFor } from './helpers.mjs';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const SCENARIO_WS = path.join(__dirname, 'fixtures', 'scenario-ws.json');

test('ensureConductProject creates .conduct/ + seeds CLAUDE.md with @CONDUCT.md import and CONDUCT.md symlink', async () => {
  const ctx = await bootServer({ scenarioPath: SCENARIO_WS });
  try {
    const r = await api(ctx.baseUrl, 'POST', '/api/projects/.conduct/ensure');
    assert.equal(r.status, 200);
    assert.equal(r.body.ok, true);
    assert.equal(r.body.created, true);
    assert.equal(r.body.claudeMdSeeded, true);
    assert.equal(r.body.path, path.join(ctx.projectsRoot, '.conduct'));

    const conductDir = path.join(ctx.projectsRoot, '.conduct');
    const stat = await fs.stat(conductDir);
    assert.ok(stat.isDirectory());

    // CLAUDE.md must be exactly the single in-project @CONDUCT.md import.
    // External imports (e.g. `@../CLAUDE.md`, `@/abs/path/CONDUCT.md`)
    // silently no-op in headless / `-p` mode, which is how every
    // conductor session is spawned.
    const claudeMd = await fs.readFile(path.join(conductDir, 'CLAUDE.md'), 'utf8');
    assert.equal(claudeMd, '@CONDUCT.md\n');

    // CONDUCT.md must be a symlink resolving to the repo's CONDUCT.md.
    const symlinkPath = path.join(conductDir, 'CONDUCT.md');
    const lstat = await fs.lstat(symlinkPath);
    assert.ok(lstat.isSymbolicLink(), 'CONDUCT.md must be a symlink');
    const real = await fs.realpath(symlinkPath);
    const realStat = await fs.stat(real);
    assert.ok(realStat.isFile(), `symlink target must exist: ${real}`);
    assert.equal(path.basename(real), 'CONDUCT.md');
  } finally { await ctx.close(); }
});

test('ensureConductProject is idempotent — second call leaves an existing CLAUDE.md alone', async () => {
  const ctx = await bootServer({ scenarioPath: SCENARIO_WS });
  try {
    const r1 = await api(ctx.baseUrl, 'POST', '/api/projects/.conduct/ensure');
    assert.equal(r1.body.created, true);

    // User customises CLAUDE.md.
    const customContent = '# custom\n\nuser edits should survive\n';
    const claudeMdPath = path.join(ctx.projectsRoot, '.conduct', 'CLAUDE.md');
    await fs.writeFile(claudeMdPath, customContent);

    const r2 = await api(ctx.baseUrl, 'POST', '/api/projects/.conduct/ensure');
    assert.equal(r2.status, 200);
    assert.equal(r2.body.created, false);
    assert.equal(r2.body.claudeMdSeeded, false);

    const after = await fs.readFile(claudeMdPath, 'utf8');
    assert.equal(after, customContent, 'user edits preserved');

    // Symlink survives the second ensure call.
    const symlinkPath = path.join(ctx.projectsRoot, '.conduct', 'CONDUCT.md');
    const lstat = await fs.lstat(symlinkPath);
    assert.ok(lstat.isSymbolicLink(), 'CONDUCT.md symlink still present');
  } finally { await ctx.close(); }
});

test('listProjects() excludes .conduct from /api/projects', async () => {
  const ctx = await bootServer({ scenarioPath: SCENARIO_WS });
  try {
    await api(ctx.baseUrl, 'POST', '/api/projects', { name: 'visible' });
    await api(ctx.baseUrl, 'POST', '/api/projects/.conduct/ensure');

    const r = await api(ctx.baseUrl, 'GET', '/api/projects');
    assert.equal(r.status, 200);
    const names = r.body.map(p => p.name);
    assert.ok(names.includes('visible'));
    assert.ok(!names.includes('.conduct'), `.conduct must not appear in sidebar list; got ${names.join(',')}`);
  } finally { await ctx.close(); }
});

test('POST /api/projects rejects dot-prefixed names', async () => {
  const ctx = await bootServer({ scenarioPath: SCENARIO_WS });
  try {
    const r1 = await api(ctx.baseUrl, 'POST', '/api/projects', { name: '.conduct' });
    assert.equal(r1.status, 400);
    assert.match(r1.body.error, /cannot start with/i);

    const r2 = await api(ctx.baseUrl, 'POST', '/api/projects', { name: '.hidden' });
    assert.equal(r2.status, 400);

    // No project was actually created on disk.
    await assert.rejects(fs.stat(path.join(ctx.projectsRoot, '.conduct')));
  } finally { await ctx.close(); }
});

test('DELETE /api/projects/.conduct is refused', async () => {
  const ctx = await bootServer({ scenarioPath: SCENARIO_WS });
  try {
    await api(ctx.baseUrl, 'POST', '/api/projects/.conduct/ensure');
    const r = await api(ctx.baseUrl, 'DELETE', '/api/projects/.conduct');
    assert.equal(r.status, 400);
    assert.match(r.body.error, /managed by the orchestrator/i);

    // Still on disk.
    const stat = await fs.stat(path.join(ctx.projectsRoot, '.conduct'));
    assert.ok(stat.isDirectory());
  } finally { await ctx.close(); }
});

test('PUT /api/projects/.conduct/workspace is refused', async () => {
  const ctx = await bootServer({ scenarioPath: SCENARIO_WS });
  try {
    await api(ctx.baseUrl, 'POST', '/api/projects/.conduct/ensure');
    const r = await api(ctx.baseUrl, 'PUT', '/api/projects/.conduct/workspace', { workspace: 'Stuff' });
    assert.equal(r.status, 400);
    assert.match(r.body.error, /cannot be assigned/i);
  } finally { await ctx.close(); }
});

test('POST /api/instances with project=.conduct spawns successfully', async () => {
  const ctx = await bootServer({ scenarioPath: SCENARIO_WS });
  try {
    await api(ctx.baseUrl, 'POST', '/api/projects/.conduct/ensure');
    const r = await api(ctx.baseUrl, 'POST', '/api/instances', {
      project: '.conduct',
      model: 'claude-haiku-4-5',
      temp: true,
      mode: 'bypassPermissions',
    });
    assert.equal(r.status, 201);
    const id = r.body.id;
    assert.equal(r.body.project, '.conduct');
    assert.equal(r.body.temp, true);

    await waitFor(() => ctx.instances.get(id)?.status === 'idle');

    const list = await api(ctx.baseUrl, 'GET', '/api/instances');
    assert.equal(list.status, 200);
    assert.ok(list.body.some(i => i.id === id && i.project === '.conduct'));
  } finally { await ctx.close(); }
});
