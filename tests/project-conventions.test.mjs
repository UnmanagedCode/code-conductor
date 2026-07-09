// Tests for project convention modules (formerly "optional guidelines"):
// catalog, custom CRUD, compose, per-project snapshot at creation, the REST
// surface (/api/settings/project-conventions), and the MCP tools
// (list_project_conventions + create_project's `conventions` param).

import { test, before, after, beforeEach, afterEach } from 'node:test';
import assert from 'node:assert/strict';
import { promises as fs } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { bootServer, api, freshProjectsRoot, rmrf } from './helpers.mjs';
import {
  getCatalog, addCustomConvention, deleteCustomConvention,
  composeProjectConventionsBlock, SEED_PROJECT_CONVENTIONS,
} from '../src/projectConventions.js';
import { createProject } from '../src/projects.js';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const SCENARIO = path.join(__dirname, 'fixtures', 'scenario-instance.json');

let ctx, baseUrl, instances, home, projectsRoot;

before(async () => {
  ctx = await bootServer({ scenarioPath: SCENARIO });
  ({ baseUrl, instances } = ctx);
});
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

// ── Catalog (unit) ─────────────────────────────────────────────────────────

test('SEED_PROJECT_CONVENTIONS has 4 entries with expected slugs', () => {
  assert.equal(SEED_PROJECT_CONVENTIONS.length, 4);
  const slugs = SEED_PROJECT_CONVENTIONS.map(r => r.slug);
  assert.ok(slugs.includes('design-guidelines'));
  assert.ok(slugs.includes('testing-guidelines'));
  assert.ok(slugs.includes('documentation-guidelines'));
  assert.ok(slugs.includes('migrations-over-compat'));
  for (const r of SEED_PROJECT_CONVENTIONS) {
    assert.ok(r.name, 'seed convention has name');
    assert.ok(r.description, 'seed convention has description');
  }
});

test('SEED_PROJECT_CONVENTIONS order is design → testing → documentation → migrations-over-compat', () => {
  assert.equal(SEED_PROJECT_CONVENTIONS[0].slug, 'design-guidelines');
  assert.equal(SEED_PROJECT_CONVENTIONS[1].slug, 'testing-guidelines');
  assert.equal(SEED_PROJECT_CONVENTIONS[2].slug, 'documentation-guidelines');
  assert.equal(SEED_PROJECT_CONVENTIONS[3].slug, 'migrations-over-compat');
});

test('getCatalog seed bodies (loaded from .md fragments) have correct ## headings', async () => {
  const catalog = await getCatalog();
  const byslug = Object.fromEntries(catalog.map(r => [r.slug, r]));
  for (const r of catalog) assert.ok(r.body, 'catalog entry has body');
  assert.ok(byslug['design-guidelines'].body.startsWith('## Design guidelines'));
  assert.ok(byslug['testing-guidelines'].body.startsWith('## Testing guidelines'));
  assert.ok(byslug['documentation-guidelines'].body.startsWith('## Documentation guidelines'));
  assert.ok(byslug['migrations-over-compat'].body.startsWith('## Migration guidelines'));
});

test('design-guidelines body includes a YAGNI bullet', async () => {
  const catalog = await getCatalog();
  const design = catalog.find(r => r.slug === 'design-guidelines');
  assert.match(design.body, /YAGNI/);
});

test('getCatalog returns seeds only when no custom conventions', async () => {
  const catalog = await getCatalog();
  assert.equal(catalog.length, SEED_PROJECT_CONVENTIONS.length);
  for (const r of catalog) assert.equal(r.builtin, true);
});

test('getCatalog merges custom conventions with builtin:false', async () => {
  await addCustomConvention({ slug: 'my-convention', name: 'My Convention', description: 'desc', body: '## My Convention\n- item' });
  const catalog = await getCatalog();
  assert.equal(catalog.length, SEED_PROJECT_CONVENTIONS.length + 1);
  const custom = catalog.find(r => r.slug === 'my-convention');
  assert.ok(custom);
  assert.equal(custom.builtin, false);
});

// ── Custom convention CRUD (unit) ────────────────────────────────────────────

test('addCustomConvention persists and returns the new convention', async () => {
  const rule = await addCustomConvention({ slug: 'test-convention', name: 'Test Convention', description: 'A test', body: '## Test\n- x' });
  assert.equal(rule.slug, 'test-convention');
  assert.equal(rule.name, 'Test Convention');
  assert.equal(rule.builtin, false);
  const catalog = await getCatalog();
  assert.ok(catalog.find(r => r.slug === 'test-convention'));
});

test('addCustomConvention rejects duplicate slug', async () => {
  await addCustomConvention({ slug: 'dupe', name: 'A', description: 'b', body: 'c' });
  await assert.rejects(
    () => addCustomConvention({ slug: 'dupe', name: 'A2', description: 'b2', body: 'c2' }),
    { message: /already exists/ },
  );
});

test('addCustomConvention rejects a builtin slug', async () => {
  await assert.rejects(
    () => addCustomConvention({ slug: 'testing-guidelines', name: 'X', description: 'y', body: 'z' }),
    { message: /already exists/ },
  );
});

test('addCustomConvention rejects invalid slug', async () => {
  await assert.rejects(
    () => addCustomConvention({ slug: 'UPPER', name: 'X', description: 'y', body: 'z' }),
    { message: /invalid slug/ },
  );
});

test('deleteCustomConvention removes the convention', async () => {
  await addCustomConvention({ slug: 'to-delete', name: 'A', description: 'b', body: 'c' });
  await deleteCustomConvention('to-delete');
  const catalog = await getCatalog();
  assert.ok(!catalog.find(r => r.slug === 'to-delete'));
});

test('deleteCustomConvention rejects builtin', async () => {
  await assert.rejects(
    () => deleteCustomConvention('testing-guidelines'),
    { message: /cannot delete built-in/ },
  );
});

// ── composeProjectConventionsBlock (unit) ─────────────────────────────────────

test('composeProjectConventionsBlock returns empty string for empty array', async () => {
  const block = await composeProjectConventionsBlock([]);
  assert.equal(block, '');
});

test('composeProjectConventionsBlock inserts a blank line + body for one seed convention', async () => {
  const block = await composeProjectConventionsBlock(['documentation-guidelines']);
  assert.ok(block.startsWith('\n'));
  assert.ok(block.includes('## Documentation guidelines'));
});

test('composeProjectConventionsBlock joins multiple conventions with blank line separator', async () => {
  const block = await composeProjectConventionsBlock(['documentation-guidelines', 'design-guidelines']);
  assert.ok(block.includes('## Documentation guidelines'));
  assert.ok(block.includes('## Design guidelines'));
  assert.ok(block.includes('\n\n'));
});

test('composeProjectConventionsBlock throws 400 on unknown slug', async () => {
  const err = await composeProjectConventionsBlock(['nonexistent-slug']).catch(e => e);
  assert.equal(err.statusCode, 400);
  assert.match(err.message, /unknown convention slug/);
});

// ── createProject with conventions (unit) ─────────────────────────────────────

test('createProject with no conventions seeds only @../CLAUDE.md', async () => {
  const { path: projPath } = await createProject('plain-proj');
  const content = await fs.readFile(path.join(projPath, 'CLAUDE.md'), 'utf8');
  assert.equal(content, '@../CLAUDE.md\n');
});

test('createProject with conventions appends convention bodies', async () => {
  const appendToCLAUDEmd = await composeProjectConventionsBlock(['documentation-guidelines']);
  const { path: projPath } = await createProject('convention-proj', { appendToCLAUDEmd });
  const content = await fs.readFile(path.join(projPath, 'CLAUDE.md'), 'utf8');
  assert.ok(content.startsWith('@../CLAUDE.md\n'));
  assert.ok(content.includes('## Documentation guidelines'));
});

// ── REST API ───────────────────────────────────────────────────────────────

test('GET /api/settings/project-conventions returns 4 seed conventions', async () => {
  const r = await api(baseUrl, 'GET', '/api/settings/project-conventions');
  assert.equal(r.status, 200);
  assert.ok(Array.isArray(r.body.rules));
  assert.equal(r.body.rules.length, SEED_PROJECT_CONVENTIONS.length);
  for (const rule of r.body.rules) assert.equal(rule.builtin, true);
});

test('POST /api/settings/project-conventions creates a custom convention', async () => {
  const r = await api(baseUrl, 'POST', '/api/settings/project-conventions', {
    slug: 'rest-convention', name: 'REST Convention', description: 'via REST', body: '## REST\n- item',
  });
  assert.equal(r.status, 201);
  assert.equal(r.body.rule.slug, 'rest-convention');
  assert.equal(r.body.rule.builtin, false);

  const list = await api(baseUrl, 'GET', '/api/settings/project-conventions');
  assert.equal(list.body.rules.length, SEED_PROJECT_CONVENTIONS.length + 1);
});

test('POST /api/settings/project-conventions rejects duplicate slug', async () => {
  await api(baseUrl, 'POST', '/api/settings/project-conventions', {
    slug: 'dup', name: 'A', description: 'b', body: 'c',
  });
  const r = await api(baseUrl, 'POST', '/api/settings/project-conventions', {
    slug: 'dup', name: 'A2', description: 'b2', body: 'c2',
  });
  assert.equal(r.status, 409);
});

test('PUT /api/settings/project-conventions/:slug updates name/description', async () => {
  await api(baseUrl, 'POST', '/api/settings/project-conventions', {
    slug: 'upd-convention', name: 'Old', description: 'old desc', body: '## Old',
  });
  const r = await api(baseUrl, 'PUT', '/api/settings/project-conventions/upd-convention', {
    name: 'New', description: 'new desc',
  });
  assert.equal(r.status, 200);
  assert.equal(r.body.rule.name, 'New');
  assert.equal(r.body.rule.description, 'new desc');
});

test('PUT /api/settings/project-conventions/:slug rejects builtin', async () => {
  const r = await api(baseUrl, 'PUT', '/api/settings/project-conventions/documentation-guidelines', {
    name: 'Hacked',
  });
  assert.equal(r.status, 400);
});

test('DELETE /api/settings/project-conventions/:slug removes custom convention', async () => {
  await api(baseUrl, 'POST', '/api/settings/project-conventions', {
    slug: 'del-convention', name: 'A', description: 'b', body: 'c',
  });
  const del = await api(baseUrl, 'DELETE', '/api/settings/project-conventions/del-convention');
  assert.equal(del.status, 200);
  const list = await api(baseUrl, 'GET', '/api/settings/project-conventions');
  assert.ok(!list.body.rules.find(r => r.slug === 'del-convention'));
});

test('DELETE /api/settings/project-conventions/:slug rejects builtin', async () => {
  const r = await api(baseUrl, 'DELETE', '/api/settings/project-conventions/testing-guidelines');
  assert.equal(r.status, 400);
});

test('POST /api/projects with conventions appends bodies to CLAUDE.md', async () => {
  const r = await api(baseUrl, 'POST', '/api/projects', {
    name: 'proj-with-conventions',
    conventions: ['documentation-guidelines', 'design-guidelines'],
  });
  assert.equal(r.status, 201);
  const content = await fs.readFile(path.join(projectsRoot, 'proj-with-conventions', 'CLAUDE.md'), 'utf8');
  assert.ok(content.startsWith('@../CLAUDE.md\n'));
  assert.ok(content.includes('## Documentation guidelines'));
  assert.ok(content.includes('## Design guidelines'));
});

test('POST /api/projects with unknown convention slug returns 400', async () => {
  const r = await api(baseUrl, 'POST', '/api/projects', {
    name: 'bad-proj', conventions: ['nonexistent-convention'],
  });
  assert.equal(r.status, 400);
  assert.match(r.body.error, /unknown convention slug/);
});

test('POST /api/projects with no conventions seeds only @../CLAUDE.md', async () => {
  const r = await api(baseUrl, 'POST', '/api/projects', { name: 'bare-proj' });
  assert.equal(r.status, 201);
  const content = await fs.readFile(path.join(projectsRoot, 'bare-proj', 'CLAUDE.md'), 'utf8');
  assert.equal(content, '@../CLAUDE.md\n');
});

// ── MCP tools ─────────────────────────────────────────────────────────────

test('list_project_conventions MCP tool returns seeds (no body field)', async () => {
  const { buildTools } = await import('../src/mcp/tools.js');
  const tools = buildTools();
  const tool = tools.find(t => t.name === 'list_project_conventions');
  assert.ok(tool, 'list_project_conventions tool registered');
  const result = await tool.handler({}, { instances });
  assert.ok(Array.isArray(result));
  assert.equal(result.length, SEED_PROJECT_CONVENTIONS.length);
  for (const r of result) {
    assert.ok(r.slug);
    assert.ok(r.name);
    assert.ok(r.description);
    assert.equal(r.builtin, true);
    assert.equal(r.body, undefined);
  }
});

test('list_project_conventions reflects a newly added custom convention', async () => {
  await addCustomConvention({ slug: 'mcp-custom', name: 'MCP Custom', description: 'test', body: '## MCP\n- x' });
  const { buildTools } = await import('../src/mcp/tools.js');
  const tools = buildTools();
  const tool = tools.find(t => t.name === 'list_project_conventions');
  const result = await tool.handler({}, { instances });
  assert.ok(Array.isArray(result));
  const custom = result.find(r => r.slug === 'mcp-custom');
  assert.ok(custom);
  assert.equal(custom.builtin, false);
});

test('create_project MCP tool with conventions appends bodies to CLAUDE.md', async () => {
  const { buildTools } = await import('../src/mcp/tools.js');
  const tools = buildTools();
  const tool = tools.find(t => t.name === 'create_project');
  assert.ok(tool);
  const result = await tool.handler({ name: 'mcp-guided', conventions: ['documentation-guidelines'] }, { instances });
  assert.equal(result.name, 'mcp-guided');
  const content = await fs.readFile(path.join(projectsRoot, 'mcp-guided', 'CLAUDE.md'), 'utf8');
  assert.ok(content.startsWith('@../CLAUDE.md\n'));
  assert.ok(content.includes('## Documentation guidelines'));
});
