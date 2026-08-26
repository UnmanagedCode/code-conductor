// Tests for the .conduct project lifecycle: lazy-create, idempotency,
// dot-prefix guards on the regular project routes, and spawn-against-
// .conduct happy path.

import { test, before, after, beforeEach, afterEach } from 'node:test';
import assert from 'node:assert/strict';
import { promises as fs } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { bootServer, api, waitFor, freshProjectsRoot, rmrf } from './helpers.mjs';
import { materializeCurrentConduct, conductConventionsPath } from '../src/conduct.ts';
import { composeCurrentConduct } from '../src/conductorConventions.ts';
import { composeCurrentWorkspace } from '../src/workspaceConventions.ts';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const SCENARIO_WS = path.join(__dirname, 'fixtures', 'scenario-ws.json');

let ctx, baseUrl, instances, home, projectsRoot;
before(async () => { ctx = await bootServer({ scenarioPath: SCENARIO_WS }); ({ baseUrl, instances } = ctx); });
after(async () => { await ctx.close(); });
beforeEach(async () => { ({ home, projectsRoot } = await freshProjectsRoot()); });
afterEach(async () => { await instances.shutdown(); await rmrf(home); });

test('ensureConductProject creates .conduct/ with a CLAUDE.md importing the role doc — but does NOT write the doc', async () => {
  const r = await api(baseUrl, 'POST', '/api/projects/.conduct/ensure');
  assert.equal(r.status, 200);
  assert.equal(r.body.ok, true);
  assert.equal(r.body.created, true);
  assert.equal(r.body.path, path.join(projectsRoot, '.conduct'));

  const conductDir = path.join(projectsRoot, '.conduct');
  const stat = await fs.stat(conductDir);
  assert.ok(stat.isDirectory());

  // The import line is what carries the composed role doc into the session.
  const claudeMd = await fs.readFile(path.join(conductDir, 'CLAUDE.md'), 'utf8');
  assert.ok(claudeMd.split('\n').some(l => l.trim() === '@CONVENTIONS.md'),
    'CLAUDE.md carries the @CONVENTIONS.md import line');

  // The pre-spawn materializer is the SOLE writer of CONVENTIONS.md. This
  // assertion kills a mutant that moves materialization into
  // ensureConductProject() — which would re-land migration 0022's drift bug,
  // an ensure-time copy going stale against the live convention selection.
  await assert.rejects(fs.stat(path.join(conductDir, 'CONVENTIONS.md')),
    'ensure must not write the role doc');
  // The 0003 → 0010 → 0022 lineage stays dead.
  await assert.rejects(fs.stat(path.join(conductDir, 'CONDUCT.md')), 'no CONDUCT.md written');
});

// T13 — the conductor is a destination of the WORKSPACE conventions too: the
// materialized doc is workspace text first, role doc second, one blank line
// apart. Whole-document equality kills an ordering / separator mutant.
test('materializeCurrentConduct writes the workspace conventions above the role doc', async () => {
  await materializeCurrentConduct();
  const onDisk = await fs.readFile(conductConventionsPath(), 'utf8');
  const [workspace, role] = [await composeCurrentWorkspace(), await composeCurrentConduct()];
  assert.equal(onDisk, `${workspace}\n${role}`);
  assert.ok(onDisk.startsWith('# Workspace conventions'), 'workspace block opens the doc');
  assert.ok(onDisk.endsWith(role), 'the role doc — generated footer and all — stays last');
  assert.ok(onDisk.indexOf('# Workspace conventions') < onDisk.indexOf('# Conductor role'));
});

test('import detection is LINE-level: prose merely mentioning @CONVENTIONS.md still gains a standalone import', async () => {
  // The bug this pins is the exact failure the card exists to fix. With a
  // substring check, a user line that only MENTIONS the filename reads as
  // already-imported, the real import line is never prepended, and the
  // conductor boots with NO role doc — while typecheck, health and the whole
  // suite stay green. The fixture line therefore has to be one a substring
  // check WOULD match (it contains `@CONVENTIONS.md`) while no line's trim()
  // equals it; anything else never reaches the disagreement state.
  const conductDir = path.join(projectsRoot, '.conduct');
  await fs.mkdir(conductDir, { recursive: true });
  const claudeMdPath = path.join(conductDir, 'CLAUDE.md');
  const prose = 'see @CONVENTIONS.md notes';
  const userContent = `# custom\n\n${prose}\n`;
  await fs.writeFile(claudeMdPath, userContent);
  // Fixture guard: the two checks must actually disagree here, else this test
  // would pass for a reason unrelated to the invariant.
  assert.ok(userContent.includes('@CONVENTIONS.md'), 'fixture: a substring check matches');
  assert.ok(!userContent.split('\n').some(l => l.trim() === '@CONVENTIONS.md'),
    'fixture: no standalone import line exists yet');

  const r = await api(baseUrl, 'POST', '/api/projects/.conduct/ensure');
  assert.equal(r.status, 200);

  const after = await fs.readFile(claudeMdPath, 'utf8');
  assert.ok(after.split('\n').some(l => l.trim() === '@CONVENTIONS.md'),
    'a standalone import line was added despite the prose mention');
  // And the prose survives byte-for-byte, in place.
  assert.ok(after.endsWith(userContent), 'every user byte survives below the import');
  assert.equal(after.split('\n').filter(l => l === prose).length, 1,
    'the prose line is kept verbatim and not rewritten');
});

test('ensureConductProject preserves a user CLAUDE.md verbatim, and a second call is byte-identical', async () => {
  // A user may own .conduct/CLAUDE.md before the app ever ensures. Every line
  // must survive, in order, with only the import gained.
  const conductDir = path.join(projectsRoot, '.conduct');
  await fs.mkdir(conductDir, { recursive: true });
  const claudeMdPath = path.join(conductDir, 'CLAUDE.md');
  const userContent = '# custom\n\n## Shorthand\n- keep me\n';
  await fs.writeFile(claudeMdPath, userContent);

  const r1 = await api(baseUrl, 'POST', '/api/projects/.conduct/ensure');
  assert.equal(r1.status, 200);

  const afterFirst = await fs.readFile(claudeMdPath, 'utf8');
  assert.ok(afterFirst.endsWith(userContent), 'every user byte survives, in order, below the import');
  assert.ok(afterFirst.split('\n').some(l => l.trim() === '@CONVENTIONS.md'), 'import added');

  // Second ensure: no duplicate import line AND no write at all (the same
  // bytes back). One assertion covers both the already-imported branch and the
  // no-mtime-churn requirement that makes ensure safe on boot, on the Conduct
  // tap, and on resume-restart.
  const r2 = await api(baseUrl, 'POST', '/api/projects/.conduct/ensure');
  assert.equal(r2.status, 200);
  assert.equal(r2.body.created, false);

  const afterSecond = await fs.readFile(claudeMdPath, 'utf8');
  assert.equal(afterSecond, afterFirst, 'second ensure is byte-identical — no duplicate import, no rewrite');
  assert.equal(afterSecond.split('\n').filter(l => l.trim() === '@CONVENTIONS.md').length, 1);
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
